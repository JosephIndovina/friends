import { createHash } from "node:crypto";
import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { env as hf } from "@huggingface/transformers";
import type { KokoroTTS } from "kokoro-js";
import { z } from "zod";
import { TTS_DEFAULT_VOICE, TTS_LIMITS, TTS_VOICES } from "@friends/shared";
import { audit } from "./audit.js";
import { SESSION_COOKIE } from "./sessions.js";
import { env } from "./env.js";
import { events } from "./events.js";

/**
 * Text to speech with Kokoro-82M, run on the server's CPU: no GPU, no API key, nothing billed.
 * The model (~90 MB) downloads from Hugging Face on first start into DATA_DIR/models and stays there.
 * Clips are cached by voice + text, so the same line said again plays at once.
 */
export const TTS_DIR = join(env.DATA_DIR, "tts");
const MODEL_DIR = join(env.DATA_DIR, "models");
const KEEP = 300; // newest clips kept on disk
const MAX_WAITING = 4; // clips being made or queued before new ones are turned away

hf.cacheDir = MODEL_DIR;

const VOICES = new Set(TTS_VOICES.map((v) => v.id));

type Voice = NonNullable<NonNullable<Parameters<KokoroTTS["generate"]>[1]>["voice"]>;

let loading: Promise<KokoroTTS> | null = null;
function model() {
  loading ??= import("kokoro-js")
    .then(async ({ KokoroTTS }) => {
      const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
      // kokoro-js ships the other languages' voices but only accepts its English ones. Its check returns which
      // English to read the text as; for the rest, US English, so they say it in their own accent.
      const t = tts as unknown as { _validate_voice: (v: string) => string };
      const english = t._validate_voice.bind(tts);
      t._validate_voice = (v) => (v in tts.voices ? english(v) : VOICES.has(v) ? "a" : english(v));
      return tts;
    })
    .catch((e) => {
      loading = null; // try again on the next request
      throw e;
    });
  return loading;
}

/** What gets read out: links, Discord mentions and emoji would be read as noise. */
export function clean(raw: string): string {
  return raw
    .replace(/<a?:(\w+):\d+>/g, "$1") // custom emoji → its name
    .replace(/<(@[!&]?|#)\d+>/g, "") // user, role and channel mentions
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, "link")
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}‍️\u{1f3fb}-\u{1f3ff}]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/ ([,.!?;:])/g, "$1")
    .trim();
}

/** 16-bit mono WAV: a quarter the size of the float32 Kokoro returns, and every browser decodes it. */
function wav(samples: Float32Array, rate: number): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), 44 + i * 2);
  return out;
}

// One clip at a time: each already uses every core, so running two at once only makes both late.
let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;
const making = new Map<string, Promise<void>>();

function make(id: string, text: string, voice: string): Promise<void> {
  const existing = making.get(id);
  if (existing) return existing;
  const job = queue.then(async () => {
    const tts = await model();
    const audio = await tts.generate(text, { voice: voice as Voice });
    const file = join(TTS_DIR, `${id}.wav`);
    await writeFile(`${file}.part`, wav(audio.audio, audio.sampling_rate));
    await rename(`${file}.part`, file);
  });
  queue = job.catch(() => {});
  making.set(id, job);
  waiting++;
  void job.finally(() => {
    making.delete(id);
    waiting--;
  }).catch(() => {});
  return job;
}

async function prune() {
  const names = (await readdir(TTS_DIR)).filter((n) => n.endsWith(".wav"));
  if (names.length <= KEEP) return;
  const aged = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(TTS_DIR, n)).catch(() => null))?.mtimeMs ?? 0 })));
  aged.sort((a, b) => b.t - a.t);
  await Promise.all(aged.slice(KEEP).map(({ n }) => unlink(join(TTS_DIR, n)).catch(() => {})));
}

const Body = z.object({ text: z.string().max(TTS_LIMITS.chars * 2), voice: z.string().optional() });

export async function ttsRoutes(app: FastifyInstance) {
  await mkdir(TTS_DIR, { recursive: true });
  await mkdir(MODEL_DIR, { recursive: true });
  // Load in the background so the first message isn't the slow one. A failure here is retried on first use.
  void model().then(() => app.log.info("tts model ready"), (e) => app.log.error({ err: e }, "tts model failed to load"));

  app.post("/api/tts", {
    config: {
      permission: "tts.speak",
      rateLimit: { max: 15, timeWindow: "1 minute", keyGenerator: (req) => `tts:${req.cookies[SESSION_COOKIE] ?? req.ip}` },
    },
  }, async (req, reply) => {
    const s = req.session!;
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_text" });
    const voice = body.data.voice ?? TTS_DEFAULT_VOICE;
    if (!VOICES.has(voice)) return reply.code(400).send({ error: "invalid_voice" });
    const text = clean(body.data.text);
    if (!text) return reply.code(400).send({ error: "invalid_text" });
    if ([...text].length > TTS_LIMITS.chars) return reply.code(400).send({ error: "too_long" });

    const id = createHash("sha256").update(`${voice}\0${text}`).digest("hex").slice(0, 32);
    const cached = await stat(join(TTS_DIR, `${id}.wav`)).then(() => true, () => false);
    if (!cached) {
      if (waiting >= MAX_WAITING && !making.has(id)) return reply.code(503).send({ error: "busy" });
      try {
        await make(id, text, voice);
      } catch (e) {
        req.log.error({ err: e }, "tts failed");
        return reply.code(500).send({ error: "tts_failed" });
      }
      void prune().catch(() => {});
    }
    audit({ actorId: s.user.id, action: "tts.spoken", details: { text, voice }, req });
    const url = `/api/tts/${id}/file`;
    events.emit("tts:spoken", { url, text, voice, by: { id: s.user.id, name: s.user.name, avatarUrl: s.user.avatarUrl } });
    return { url };
  });

  app.get<{ Params: { id: string } }>("/api/tts/:id/file", { config: { permission: "sounds.play" } }, async (req, reply) => {
    if (!/^[0-9a-f]{32}$/.test(req.params.id)) return reply.code(404).send({ error: "not_found" });
    const name = `${req.params.id}.wav`;
    if (!(await stat(join(TTS_DIR, name)).then(() => true, () => false))) return reply.code(404).send({ error: "not_found" });
    // A clip's id is a hash of what's in it: it never changes.
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
    return reply.type("audio/wav").sendFile(name, TTS_DIR);
  });
}
