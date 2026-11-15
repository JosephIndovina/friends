import { randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import { SEEKABLE, type Ack, type ClientToServer, type MediaItem, type MediaState, type Permission, type Playback, type ServerToClient, type Session } from "@friends/shared";
import { audit } from "./audit.js";
import { db } from "./db.js";
import { events } from "./events.js";
import { fetchMeta, parseLink } from "./links.js";
import { getSettings } from "./settings.js";

type Data = { session: Session; token: string };
type IO = Server<ClientToServer, ServerToClient, Record<string, never>, Data>;
type Sock = Socket<ClientToServer, ServerToClient, Record<string, never>, Data>;

const QUEUE_MAX = 200;
const HISTORY_SHOWN = 30;
const END_SLACK_S = 5;
const IDLE_NOTIFY_MS = 30 * 60 * 1000;
const NOW_KEY = "media_now";

class ActionError extends Error {}
const fail = (code: string): never => {
  throw new ActionError(code);
};

// ---------- persistence ----------

function loadQueue(): MediaItem[] {
  return (db.prepare("SELECT data FROM media_queue ORDER BY sort").all() as Array<{ data: string }>).map((r) => JSON.parse(r.data) as MediaItem);
}
function saveQueue(queue: MediaItem[]) {
  db.transaction(() => {
    db.prepare("DELETE FROM media_queue").run();
    const ins = db.prepare("INSERT INTO media_queue (id, sort, data) VALUES (?, ?, ?)");
    queue.forEach((item, i) => ins.run(item.id, i, JSON.stringify(item)));
  })();
}
function loadHistory(): MediaState["history"] {
  return (db.prepare("SELECT data, played_at FROM media_history ORDER BY id DESC LIMIT ?").all(HISTORY_SHOWN) as Array<{ data: string; played_at: number }>).map(
    (r) => ({ ...(JSON.parse(r.data) as MediaItem), playedAt: r.played_at }),
  );
}
function loadNow(): Playback | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(NOW_KEY) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as Playback | null) : null;
}
function saveNow(now: Playback | null) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(NOW_KEY, JSON.stringify(now));
}

// ---------- room ----------

export function createMediaRoom(io: IO) {
  let now = loadNow();
  let queue = loadQueue();
  let history = loadHistory();
  let lastActiveAt = now?.playing ? Date.now() : 0;
  let endTimer: NodeJS.Timeout | null = null;

  const position = (p: Playback, at = Date.now()) => {
    if (!p.playing || !SEEKABLE[p.item.kind]) return p.position;
    const pos = p.position + (at - p.updatedAt) / 1000;
    return p.item.duration ? Math.min(pos, p.item.duration) : pos;
  };

  const snapshot = (): MediaState => ({ now, queue, history });

  function commit() {
    saveNow(now);
    saveQueue(queue);
    io.emit("media:state", snapshot());
    scheduleEnd();
  }

  /** Server-side auto-advance, so the room keeps moving even when nobody has the page open. */
  function scheduleEnd() {
    if (endTimer) clearTimeout(endTimer);
    endTimer = null;
    if (!now?.playing || !now.item.duration || now.item.kind === "twitch-live") return;
    const remaining = now.item.duration - position(now) + 3;
    const id = now.item.id;
    endTimer = setTimeout(() => {
      if (now?.item.id === id) advance(null);
    }, Math.max(0, remaining * 1000));
    endTimer.unref();
  }

  function toHistory(item: MediaItem) {
    const playedAt = Date.now();
    db.prepare("INSERT INTO media_history (played_at, data) VALUES (?, ?)").run(playedAt, JSON.stringify(item));
    history = [{ ...item, playedAt }, ...history].slice(0, HISTORY_SHOWN);
  }

  function start(item: MediaItem, by: { id: string; name: string }) {
    const wasIdle = !now?.playing && Date.now() - lastActiveAt > IDLE_NOTIFY_MS;
    now = { item, playing: true, position: item.startAt, updatedAt: Date.now(), startedBy: by };
    lastActiveAt = Date.now();
    if (wasIdle && getSettings().notify.nowPlaying) {
      events.emit("notify", {
        title: item.title,
        description: `${by.name} started watching${item.author ? ` · ${item.author}` : ""}`,
        url: "/media",
        buttonLabel: "Watch",
        thumbnail: item.thumbnail ?? undefined,
      });
    }
  }

  /** Move to the next queued item. `by` is null when the room advances on its own. */
  function advance(by: Session["user"] | null) {
    if (now) toHistory(now.item);
    const next = queue.shift();
    if (next) start(next, by ? { id: by.id, name: by.name } : next.addedBy);
    else now = null;
    commit();
  }

  events.on("settings:changed", () => {
    if (!getSettings().sections.media && now) {
      toHistory(now.item);
      now = null;
      commit();
    }
  });

  // ---------- socket actions ----------

  function attach(socket: Sock) {
    let tokens = 20;
    const refill = setInterval(() => (tokens = Math.min(20, tokens + 2)), 1000);
    socket.on("disconnect", () => clearInterval(refill));

    const handle = <A extends unknown[]>(perm: Permission | null, fn: (session: Session, ...args: A) => Promise<void> | void) =>
      async (...args: [...A, Ack]) => {
        const ack = args.pop() as Ack;
        const session = socket.data.session;
        try {
          if (typeof ack !== "function") return;
          if (tokens-- <= 0) fail("slow_down");
          if (!getSettings().sections.media) fail("section_disabled");
          if (perm && !session.permissions.includes(perm)) {
            audit({ actorId: session.user.id, action: "access.forbidden", details: { socket: true, perm } });
            fail("missing_permission");
          }
          await fn(session, ...(args as unknown as A));
          ack({ ok: true });
        } catch (err) {
          ack({ ok: false, error: err instanceof ActionError ? err.message : "server_error" });
          if (!(err instanceof ActionError)) console.error(err);
        }
      };

    const who = (s: Session) => ({ id: s.user.id, name: s.user.name });
    const ref = (item: MediaItem) => ({ type: "media", id: item.ref, name: item.title });
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : fail("invalid"));

    socket.on("media:subscribe", () => socket.emit("media:state", snapshot()));

    socket.on("media:add", handle("media.queue", async (s, input: { url: string; playNext?: boolean }) => {
      if (typeof input?.url !== "string" || input.url.length > 500) fail("invalid");
      if (queue.length >= QUEUE_MAX) fail("queue_full");
      const link = parseLink(input.url);
      if (!link) fail("unsupported_link");
      const meta = await fetchMeta(link!);
      if (!meta) fail("video_unavailable");
      const item: MediaItem = { id: randomUUID(), ...link!, ...meta!, addedBy: who(s), addedAt: Date.now() };
      audit({ actorId: s.user.id, action: "media.added", target: ref(item), details: { kind: item.kind, playNext: Boolean(input.playNext) } });
      if (!now) start(item, who(s));
      else if (input.playNext) queue.unshift(item);
      else queue.push(item);
      commit();
    }));

    socket.on("media:play", handle("media.control", (s) => {
      if (!now) {
        if (!queue.length) fail("nothing_queued");
        advance(s.user);
      } else if (!now.playing) {
        now = { ...now, playing: true, updatedAt: Date.now() };
        lastActiveAt = Date.now();
        commit();
      } else return;
      audit({ actorId: s.user.id, action: "media.played", target: ref(now!.item) });
    }));

    socket.on("media:pause", handle("media.control", (s, _input: { position: number }) => {
      if (!now?.playing) return;
      now = { ...now, playing: false, position: position(now), updatedAt: Date.now() };
      lastActiveAt = Date.now();
      audit({ actorId: s.user.id, action: "media.paused", target: ref(now.item), details: { at: Math.round(now.position) } });
      commit();
    }));

    socket.on("media:seek", handle("media.control", (s, input: { position: number }) => {
      if (!now) fail("nothing_playing");
      if (!SEEKABLE[now!.item.kind]) fail("not_seekable");
      const max = now!.item.duration ?? Number.MAX_SAFE_INTEGER;
      const to = Math.max(0, Math.min(num(input?.position), max));
      const from = position(now!);
      now = { ...now!, position: to, updatedAt: Date.now() };
      audit({ actorId: s.user.id, action: "media.seeked", target: ref(now.item), details: { from: Math.round(from), to: Math.round(to) } });
      commit();
    }));

    socket.on("media:skip", handle("media.control", (s) => {
      if (!now) fail("nothing_playing");
      audit({ actorId: s.user.id, action: "media.skipped", target: ref(now!.item) });
      advance(s.user);
    }));

    socket.on("media:playNow", handle("media.control", (s, input: { id: string }) => {
      const i = queue.findIndex((q) => q.id === input?.id);
      if (i < 0) fail("not_found");
      const [item] = queue.splice(i, 1);
      if (now) toHistory(now.item);
      start(item!, who(s));
      audit({ actorId: s.user.id, action: "media.play_now", target: ref(item!) });
      commit();
    }));

    socket.on("media:replay", handle("media.queue", (s, input: { id: string }) => {
      const old = history.find((h) => h.id === input?.id);
      if (!old) fail("not_found");
      if (queue.length >= QUEUE_MAX) fail("queue_full");
      const { playedAt: _p, ...rest } = old!;
      const item: MediaItem = { ...rest, id: randomUUID(), addedBy: who(s), addedAt: Date.now(), startAt: 0 };
      audit({ actorId: s.user.id, action: "media.added", target: ref(item), details: { kind: item.kind, replay: true } });
      if (!now) start(item, who(s));
      else queue.push(item);
      commit();
    }));

    socket.on("media:remove", handle("media.queue", (s, input: { id: string }) => {
      const item = queue.find((q) => q.id === input?.id);
      if (!item) fail("not_found");
      if (item!.addedBy.id !== s.user.id && !s.permissions.includes("playback.moderate")) fail("missing_permission");
      queue = queue.filter((q) => q.id !== item!.id);
      audit({ actorId: s.user.id, action: "media.removed", target: ref(item!), details: { addedBy: item!.addedBy.name } });
      commit();
    }));

    socket.on("media:move", handle("media.control", (s, input: { id: string; to: number }) => {
      const from = queue.findIndex((q) => q.id === input?.id);
      if (from < 0) fail("not_found");
      const to = Math.max(0, Math.min(Math.trunc(num(input.to)), queue.length - 1));
      const [item] = queue.splice(from, 1);
      queue.splice(to, 0, item!);
      audit({ actorId: s.user.id, action: "media.moved", target: ref(item!), details: { from: from + 1, to: to + 1 } });
      commit();
    }));

    socket.on("media:clear", handle("playback.moderate", (s) => {
      if (!queue.length) return;
      audit({ actorId: s.user.id, action: "media.cleared", details: { items: queue.length } });
      queue = [];
      commit();
    }));

    socket.on("media:ended", (input) => {
      if (!now || now.item.id !== input?.itemId) return;
      // Ignore a client that finished early because it drifted or skipped locally.
      if (now.item.duration && position(now) < now.item.duration - END_SLACK_S) return;
      advance(null);
    });

    socket.on("media:duration", (input) => {
      if (!now || now.item.id !== input?.itemId || now.item.duration) return;
      const d = Number(input.duration);
      if (!Number.isFinite(d) || d <= 0 || d > 24 * 3600) return;
      now = { ...now, item: { ...now.item, duration: d } };
      commit();
    });
  }

  scheduleEnd();
  return { attach, snapshot };
}
