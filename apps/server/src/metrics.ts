import { readFile, readdir, stat, statfs } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import type { Server } from "socket.io";
import { z } from "zod";
import type { MetricKey, MetricPoint, MetricRange, MetricsResponse } from "@friends/shared";
import { db } from "./db.js";
import { discordPing } from "./discord.js";
import { env } from "./env.js";
import { SOUND_DIR } from "./sounds.js";
import { UPLOAD_DIR } from "./posts.js";

/**
 * System metrics for the admin System page. A sample every 10 seconds; the last hour stays in memory,
 * one-minute rollups are kept for 8 days and hourly ones for 400 days.
 */

const SAMPLE_MS = 10_000;
const LIVE_KEEP = 360; // one hour of samples
const MINUTE_KEEP_MS = 8 * 864e5;
const HOUR_KEEP_MS = 400 * 864e5;
const cores = availableParallelism();

type Values = Partial<Record<MetricKey, number>>;

// ---------- counters fed by the HTTP hook ----------

type Kind = "webB" | "apiB" | "uploadsB" | "soundsB" | "downloadsB";
const http = { req: 0, err: 0, ms: 0, bytes: { webB: 0, apiB: 0, uploadsB: 0, soundsB: 0, downloadsB: 0 } as Record<Kind, number> };

function kindOf(url: string): Kind | null {
  if (url.startsWith("/livekit/")) return null; // the signalling WebSocket; counted only in network totals
  if (url.startsWith("/api/uploads/")) return "uploadsB";
  if (url.startsWith("/api/sounds/") && url.split("?")[0]!.endsWith("/file")) return "soundsB";
  if (url.startsWith("/download/")) return "downloadsB";
  if (url.startsWith("/api/") || url.startsWith("/auth/")) return "apiB";
  return "webB";
}

/** Count every response. Registered on the root instance so it covers every route. */
export function countResponses(app: FastifyInstance) {
  app.addHook("onResponse", async (req, reply) => {
    const kind = kindOf(req.url);
    if (!kind) return;
    http.req++;
    if (reply.statusCode >= 500) http.err++;
    http.ms += reply.elapsedTime;
    http.bytes[kind] += Number(reply.getHeader("content-length")) || 0;
  });
}

// ---------- readers ----------

/** Bytes in and out of every interface but loopback. Inside the container that is the app's own traffic. */
async function netBytes(): Promise<{ rx: number; tx: number } | null> {
  try {
    const text = await readFile("/proc/net/dev", "utf8");
    let rx = 0, tx = 0;
    for (const line of text.split("\n").slice(2)) {
      const [iface, rest] = line.split(":");
      if (!rest || iface!.trim() === "lo") continue;
      const f = rest.trim().split(/\s+/).map(Number);
      rx += f[0]!;
      tx += f[8]!;
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

async function memLimit(): Promise<number | null> {
  const raw = await readFile("/sys/fs/cgroup/memory.max", "utf8").catch(() => "max");
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface PromLine { name: string; labels: Record<string, string>; value: number }

function parseProm(text: string): PromLine[] {
  const out: PromLine[] = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const l of m[2]?.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g) ?? []) labels[l[1]!] = l[2]!;
    out.push({ name: m[1]!, labels, value: Number(m[3]) });
  }
  return out;
}

const sum = (lines: PromLine[], name: string, where: Record<string, string> = {}) =>
  lines.filter((l) => l.name === name && Object.entries(where).every(([k, v]) => l.labels[k] === v)).reduce((s, l) => s + l.value, 0);

/** LIVEKIT_METRICS_URL may carry the Prometheus basic-auth credentials (http://user:pass@host:port/metrics). */
const lkTarget = (() => {
  if (!env.LIVEKIT_METRICS_URL) return null;
  const u = new URL(env.LIVEKIT_METRICS_URL);
  const auth = u.username ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}` : null;
  u.username = "";
  u.password = "";
  return { url: u.toString(), auth };
})();
let lkError: string | null = null;

/** Counters from LiveKit; the rates come from the difference between two reads. */
interface LkRead { rx: number; tx: number; retx: number; loss: [number, number]; rtt: [number, number]; jitter: [number, number]; cpu: number; people: number; mem: number }

async function readLiveKit(): Promise<LkRead | null> {
  if (!lkTarget) return null;
  try {
    const res = await fetch(lkTarget.url, { headers: lkTarget.auth ? { authorization: lkTarget.auth } : {}, signal: AbortSignal.timeout(3000) });
    if (res.status === 401) throw new Error("LiveKit refused the metrics username or password.");
    if (!res.ok) throw new Error(`LiveKit answered ${res.status}.`);
    const p = parseProm(await res.text());
    lkError = null;
    return {
      rx: sum(p, "livekit_packet_bytes", { direction: "incoming" }),
      tx: sum(p, "livekit_packet_bytes", { direction: "outgoing" }),
      retx: sum(p, "livekit_packet_bytes", { direction: "outgoing", transmission: "retransmit" }),
      loss: [sum(p, "livekit_packet_loss_percent_sum"), sum(p, "livekit_packet_loss_percent_count")],
      rtt: [sum(p, "livekit_rtt_ms_sum"), sum(p, "livekit_rtt_ms_count")],
      jitter: [sum(p, "livekit_jitter_us_sum"), sum(p, "livekit_jitter_us_count")],
      cpu: sum(p, "process_cpu_seconds_total"),
      people: sum(p, "livekit_participant_total"),
      mem: sum(p, "process_resident_memory_bytes"),
    };
  } catch (e) {
    lkError = e instanceof Error && e.name !== "TimeoutError" && e.message.startsWith("LiveKit") ? e.message : "LiveKit's metrics endpoint isn't reachable.";
    return null;
  }
}

// ---------- sampling ----------

const live: MetricPoint[] = [];
let io: Server | null = null;

function aggregate(points: MetricPoint[], t: number): MetricPoint {
  const sums: Values = {}, counts: Values = {}, a: Values = {}, m: Values = {};
  for (const p of points) {
    for (const [k, v] of Object.entries(p.a) as [MetricKey, number][]) {
      sums[k] = (sums[k] ?? 0) + v;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    for (const [k, v] of Object.entries(p.m) as [MetricKey, number][]) m[k] = Math.max(m[k] ?? -Infinity, v);
  }
  for (const k of Object.keys(sums) as MetricKey[]) a[k] = sums[k]! / counts[k]!;
  return { t, a, m };
}

const insert = db.prepare("INSERT OR REPLACE INTO metrics (res, at, data) VALUES (?, ?, ?)");
const pack = (p: MetricPoint) => JSON.stringify({ a: round(p.a), m: round(p.m) });
const round = (v: Values) => Object.fromEntries(Object.entries(v).map(([k, n]) => [k, Math.round(n * 1000) / 1000]));

function rows(res: number, from: number, to = Number.MAX_SAFE_INTEGER): MetricPoint[] {
  return (db.prepare("SELECT at, data FROM metrics WHERE res = ? AND at >= ? AND at < ? ORDER BY at").all(res, from, to) as Array<{ at: number; data: string }>)
    .map((r) => ({ t: r.at, ...(JSON.parse(r.data) as Omit<MetricPoint, "t">) }));
}

let minuteBucket: MetricPoint[] = [];
let minuteKey = 0;

function rollUp(p: MetricPoint) {
  const key = Math.floor(p.t / 60_000) * 60_000;
  if (minuteKey && key !== minuteKey && minuteBucket.length) {
    insert.run(60, minuteKey, pack(aggregate(minuteBucket, minuteKey)));
    const hour = Math.floor(minuteKey / 36e5) * 36e5;
    if (Math.floor(key / 36e5) * 36e5 !== hour) {
      const mins = rows(60, hour, hour + 36e5);
      if (mins.length) insert.run(3600, hour, pack(aggregate(mins, hour)));
    }
    minuteBucket = [];
  }
  minuteKey = key;
  minuteBucket.push(p);
}

export function pruneMetrics() {
  db.prepare("DELETE FROM metrics WHERE (res = 60 AND at < ?) OR (res = 3600 AND at < ?)").run(Date.now() - MINUTE_KEEP_MS, Date.now() - HOUR_KEEP_MS);
}

export function startMetrics(server: Server) {
  io = server;
  const LOOP_RES = 10;
  const loop = monitorEventLoopDelay({ resolution: LOOP_RES });
  loop.enable();
  let at = performance.now();
  let cpu = process.cpuUsage();
  let prevNet: Awaited<ReturnType<typeof netBytes>> = null;
  let prevLk: LkRead | null = null;

  async function sample() {
    const now = performance.now();
    const secs = (now - at) / 1000;
    at = now;
    const cpuNow = process.cpuUsage();
    const used = (cpuNow.user - cpu.user + cpuNow.system - cpu.system) / 1e6;
    cpu = cpuNow;
    const [netNow, lkNow] = await Promise.all([netBytes(), readLiveKit()]);

    const v: Values = {
      cpu: (used / secs / cores) * 100,
      mem: process.memoryUsage.rss(),
      // The histogram measures the timer's whole interval; what matters is how late it fired.
      lag: Math.max(0, loop.percentile(99) / 1e6 - LOOP_RES),
      req: http.req / secs,
      err: http.err / secs,
      sockets: io?.engine.clientsCount ?? 0,
      online: new Set([...(io?.sockets.sockets.values() ?? [])].map((s) => (s.data as { session?: { user: { id: string } } }).session?.user.id)).size,
    };
    if (http.req) v.ms = http.ms / http.req;
    for (const k of Object.keys(http.bytes) as Kind[]) (v[k] = http.bytes[k] / secs), (http.bytes[k] = 0);
    http.req = http.err = http.ms = 0;
    loop.reset();
    const ping = discordPing();
    if (ping !== null) v.ping = ping;
    // A counter that went backwards means a restart (or an interface reset); skip that interval.
    const rate = (a: number, b: number) => (a >= b ? (a - b) / secs : undefined);
    const mean = (now: [number, number], before: [number, number]) => (now[1] > before[1] ? (now[0] - before[0]) / (now[1] - before[1]) : undefined);
    if (netNow && prevNet) Object.assign(v, { rx: rate(netNow.rx, prevNet.rx), tx: rate(netNow.tx, prevNet.tx) });
    if (lkNow && prevLk) {
      Object.assign(v, {
        lkRx: rate(lkNow.rx, prevLk.rx),
        lkTx: rate(lkNow.tx, prevLk.tx),
        lkRetx: rate(lkNow.retx, prevLk.retx),
        lkLoss: mean(lkNow.loss, prevLk.loss) ?? 0,
        lkRtt: mean(lkNow.rtt, prevLk.rtt),
        lkJitter: (() => { const j = mean(lkNow.jitter, prevLk.jitter); return j === undefined ? undefined : j / 1000; })(),
        lkCpu: (() => { const c = rate(lkNow.cpu, prevLk.cpu); return c === undefined ? undefined : (c / cores) * 100; })(),
        lkPeople: lkNow.people,
        lkMem: lkNow.mem,
      });
    }
    prevNet = netNow;
    prevLk = lkNow;
    for (const k of Object.keys(v) as MetricKey[]) if (v[k] === undefined || !Number.isFinite(v[k])) delete v[k];

    const p: MetricPoint = { t: Date.now(), a: v, m: v };
    live.push(p);
    if (live.length > LIVE_KEEP) live.shift();
    rollUp(p);
  }

  setInterval(() => void sample().catch(() => {}), SAMPLE_MS).unref();
}

// ---------- storage sizes (cached; walking the folders isn't free) ----------

let sizes: { at: number; v: MetricsResponse["storage"] } | null = null;

async function dirBytes(dir: string): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[]);
  let n = 0;
  for (const name of names) n += (await stat(join(dir, name)).catch(() => null))?.size ?? 0;
  return n;
}

async function storage(): Promise<MetricsResponse["storage"]> {
  if (sizes && Date.now() - sizes.at < 5 * 60_000) return sizes.v;
  const dbPath = join(env.DATA_DIR, "friends.db");
  const size = async (p: string) => (await stat(p).catch(() => null))?.size ?? 0;
  const fs = await statfs(env.DATA_DIR).catch(() => null);
  const v = {
    db: (await size(dbPath)) + (await size(`${dbPath}-wal`)),
    uploads: await dirBytes(UPLOAD_DIR),
    sounds: await dirBytes(SOUND_DIR),
    free: fs ? fs.bavail * fs.bsize : null,
    total: fs ? fs.blocks * fs.bsize : null,
  };
  sizes = { at: Date.now(), v };
  return v;
}

// ---------- route ----------

const RANGES: Record<MetricRange, { span: number; res: number; step: number }> = {
  "1h": { span: 36e5, res: 0, step: 10 },
  "24h": { span: 864e5, res: 60, step: 60 },
  "7d": { span: 7 * 864e5, res: 60, step: 600 },
  "30d": { span: 30 * 864e5, res: 3600, step: 3600 },
};

function bucketed(points: MetricPoint[], stepMs: number): MetricPoint[] {
  const out: MetricPoint[] = [];
  let bucket: MetricPoint[] = [];
  let key = -1;
  for (const p of points) {
    const k = Math.floor(p.t / stepMs) * stepMs;
    if (k !== key && bucket.length) out.push(aggregate(bucket, key)), (bucket = []);
    key = k;
    bucket.push(p);
  }
  if (bucket.length) out.push(aggregate(bucket, key));
  return out;
}

export async function metricsRoutes(app: FastifyInstance) {
  app.get("/api/admin/metrics", { config: { permission: "admin.settings" } }, async (req): Promise<MetricsResponse> => {
    const { range } = z.object({ range: z.enum(["1h", "24h", "7d", "30d"]).default("1h") }).parse(req.query);
    const r = RANGES[range];
    const from = Date.now() - r.span;
    let points: MetricPoint[];
    if (r.res === 0) points = live.filter((p) => p.t >= from);
    else {
      const stored = rows(r.res, Math.floor(from / (r.res * 1000)) * r.res * 1000);
      // The bucket still being collected isn't stored yet: fill it from finer rows and memory.
      const next = stored.length ? stored.at(-1)!.t + r.res * 1000 : from;
      const mins = r.res === 3600 ? rows(60, next) : [];
      const after = mins.length ? mins.at(-1)!.t + 60_000 : next;
      const tail = [...mins, ...live.filter((p) => p.t >= after)];
      points = bucketed([...stored, ...bucketed(tail, r.res * 1000)], r.step * 1000);
    }
    return {
      range,
      step: r.step,
      points,
      now: live.at(-1) ?? null,
      cores,
      memLimit: await memLimit(),
      livekit: { configured: Boolean(lkTarget), error: lkTarget ? lkError : null },
      storage: await storage(),
    };
  });
}
