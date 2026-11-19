import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { fileTypeFromFile } from "file-type";
import { parseFile } from "music-metadata";
import type { Socket } from "socket.io";
import { SOUND_LIMITS, type Ack, type ClientToServer, type ServerToClient, type Session, type Sound } from "@friends/shared";
import { audit } from "./audit.js";
import { db } from "./db.js";
import { env } from "./env.js";
import { events } from "./events.js";

export const SOUND_DIR = join(env.DATA_DIR, "sounds");

/** By the extension file-type finds in the bytes; the browser decodes them with Web Audio. */
const ALLOWED: Record<string, string> = {
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  webm: "audio/webm",
};

interface SoundRow { id: string; name: string; emoji: string | null; owner_id: string; ext: string; mime: string; duration: number; created_at: number; owner_name: string }

const SELECT = `SELECT s.id, s.name, s.emoji, s.owner_id, s.ext, s.mime, s.duration, s.created_at, u.name AS owner_name FROM sounds s JOIN users u ON u.id = s.owner_id`;

const toSound = (r: SoundRow): Sound => ({
  id: r.id,
  name: r.name,
  emoji: r.emoji,
  url: `/api/sounds/${r.id}/file`,
  duration: r.duration,
  addedBy: { id: r.owner_id, name: r.owner_name },
  createdAt: r.created_at,
});

/** One emoji (with any modifiers or joiners), or null for none. undefined = not a single emoji. */
function cleanEmoji(raw: string | undefined): string | null | undefined {
  const v = raw?.trim();
  if (!v) return null;
  const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(v)];
  if (parts.length !== 1 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(v)) return undefined;
  return v;
}

export async function soundRoutes(app: FastifyInstance) {
  await mkdir(SOUND_DIR, { recursive: true });
  // Name and emoji come as fields before the file.
  await app.register(import("@fastify/multipart"), { limits: { fileSize: SOUND_LIMITS.bytes, files: 1, fields: 2, fieldSize: 200 } });
  const me = (req: FastifyRequest) => req.session!;
  const err = (status: number, code: string) => Object.assign(new Error(code), { statusCode: status });

  app.setErrorHandler((e: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (e.code === "FST_REQ_FILE_TOO_LARGE") return reply.code(413).send({ error: "file_too_large" });
    const status = e.statusCode ?? 500;
    if (status >= 500) req.log.error({ err: e }, "sounds request failed");
    return reply.code(status).send({ error: status >= 500 ? "server_error" : e.message });
  });

  app.get("/api/sounds", { config: { permission: "sounds.play" } }, async () => {
    const rows = db.prepare(`${SELECT} ORDER BY s.created_at`).all() as SoundRow[];
    return rows.map(toSound);
  });

  app.post("/api/sounds", { config: { permission: "sounds.add", rateLimit: { max: 20, timeWindow: "10 minutes" } } }, async (req) => {
    const s = me(req);
    const total = (db.prepare("SELECT COUNT(*) AS n FROM sounds").get() as { n: number }).n;
    if (total >= SOUND_LIMITS.total) throw err(409, "board_full");
    const mine = (db.prepare("SELECT COUNT(*) AS n FROM sounds WHERE owner_id = ?").get(s.user.id) as { n: number }).n;
    if (mine >= SOUND_LIMITS.perPerson) throw err(409, "too_many_yours");

    const file = await req.file();
    if (!file) throw err(400, "no_file");
    const field = (k: string) => {
      const f = file.fields[k];
      return f && !Array.isArray(f) && f.type === "field" ? String(f.value) : undefined;
    };
    const name = field("name")?.trim().replace(/\s+/g, " ") ?? "";
    if (!name || [...name].length > SOUND_LIMITS.name) {
      file.file.resume();
      throw err(400, "invalid_name");
    }
    const emoji = cleanEmoji(field("emoji"));
    if (emoji === undefined) {
      file.file.resume();
      throw err(400, "invalid_emoji");
    }

    const id = randomUUID();
    const tmp = join(SOUND_DIR, `${id}.part`);
    try {
      await pipeline(file.file, createWriteStream(tmp));
      if (file.file.truncated) throw err(413, "file_too_large");
      // Trust the bytes, not the browser's claimed type.
      const type = await fileTypeFromFile(tmp);
      const mime = type && ALLOWED[type.ext];
      if (!mime) throw err(415, "unsupported_type");
      const meta = await parseFile(tmp, { duration: true }).catch(() => null);
      const duration = meta?.format.duration;
      if (!meta || !duration || !meta.format.numberOfChannels) throw err(415, "unreadable_audio");
      if (duration > SOUND_LIMITS.seconds + 0.05) throw err(413, "too_long");
      await rename(tmp, join(SOUND_DIR, `${id}.${type.ext}`));
      db.prepare("INSERT INTO sounds (id, name, emoji, owner_id, mime, ext, bytes, duration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id, name, emoji, s.user.id, mime, type.ext, file.file.bytesRead, Math.round(duration * 100) / 100, Date.now(),
      );
      audit({ actorId: s.user.id, action: "sound.added", target: { type: "sound", id, name }, req });
      events.emit("sounds:changed");
      return toSound(db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as SoundRow);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  });

  app.get<{ Params: { id: string } }>("/api/sounds/:id/file", { config: { permission: "sounds.play" } }, async (req, reply) => {
    const r = db.prepare("SELECT id, ext, mime FROM sounds WHERE id = ?").get(req.params.id) as { id: string; ext: string; mime: string } | undefined;
    if (!r) throw err(404, "not_found");
    // A sound's file never changes: a new upload gets a new id.
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
    return reply.type(r.mime).sendFile(`${r.id}.${r.ext}`, SOUND_DIR);
  });

  app.delete<{ Params: { id: string } }>("/api/sounds/:id", { config: { anyActive: true } }, async (req) => {
    const s = me(req);
    const r = db.prepare(`${SELECT} WHERE s.id = ?`).get(req.params.id) as SoundRow | undefined;
    if (!r) throw err(404, "not_found");
    const own = r.owner_id === s.user.id;
    if (!(own && s.permissions.includes("sounds.add")) && !s.permissions.includes("playback.moderate")) {
      audit({ actorId: s.user.id, action: "access.forbidden", details: { method: req.method, url: req.url, reason: "not_yours" }, req });
      throw err(403, "not_yours");
    }
    db.prepare("DELETE FROM sounds WHERE id = ?").run(r.id);
    await unlink(join(SOUND_DIR, `${r.id}.${r.ext}`)).catch(() => {});
    audit({ actorId: s.user.id, action: "sound.deleted", target: { type: "sound", id: r.id, name: r.name }, details: { owner: r.owner_name, moderated: !own }, req });
    events.emit("sounds:changed");
    return { ok: true };
  });
}

type Sock = Socket<ClientToServer, ServerToClient, Record<string, never>, { session: Session }>;

const exists = db.prepare("SELECT 1 FROM sounds WHERE id = ?");

/** Plays are just a broadcast: nothing is stored, so the only cost is the hop through the server. No limit on how fast: spamming is the point. */
export function attachSounds(socket: Sock) {
  socket.on("sound:play", (input: { id: string }, ack: Ack) => {
    if (typeof ack !== "function") return;
    const s = socket.data.session;
    if (!s.permissions.includes("sounds.play")) return ack({ ok: false, error: "missing_permission" });
    if (typeof input?.id !== "string" || !exists.get(input.id)) return ack({ ok: false, error: "not_found" });
    socket.broadcast.emit("sound:played", { id: input.id, by: { id: s.user.id, name: s.user.name } });
    ack({ ok: true });
  });
}
