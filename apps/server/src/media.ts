import { randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import { SEEKABLE, type Ack, type ClientToServer, type MediaItem, type MediaMode, type MediaState, type Permission, type Playback, type ServerToClient, type Session } from "@friends/shared";
import { audit } from "./audit.js";
import { db } from "./db.js";
import { events } from "./events.js";
import { fetchMeta, parseLink } from "./links.js";
import { playlist, youtubeEnabled, YouTubeError, youtubeListId } from "./youtube.js";
import { matchYouTube, parseSpotify, SpotifyError, spotifyEnabled, spotifyTracks } from "./spotify.js";
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

const withMode = <T extends MediaItem>(i: T): T => ({ ...i, mode: i.mode ?? "video" });

function loadQueue(): MediaItem[] {
  return (db.prepare("SELECT data FROM media_queue ORDER BY sort").all() as Array<{ data: string }>).map((r) => withMode(JSON.parse(r.data) as MediaItem));
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
    (r) => withMode({ ...(JSON.parse(r.data) as MediaItem), playedAt: r.played_at }),
  );
}
function loadNow(): Playback | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(NOW_KEY) as { value: string } | undefined;
  const p = row ? (JSON.parse(row.value) as Playback | null) : null;
  return p ? { ...p, item: withMode(p.item) } : null;
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
    prefetch();
  }

  /** A playable version of an item: Spotify tracks become their matched YouTube video. Null = no match. */
  async function playable(item: MediaItem): Promise<MediaItem | null> {
    if (item.kind !== "spotify") return item;
    try {
      const yt = await matchYouTube(item);
      return yt ? { ...item, kind: "youtube", ref: yt } : null;
    } catch (err) {
      if (err instanceof SpotifyError) return null;
      throw err;
    }
  }

  /** Match the next Spotify track ahead of time so the switch is instant. */
  const prefetching = new Set<string>();
  function prefetch() {
    const next = queue[0];
    if (next?.kind !== "spotify" || prefetching.has(next.id)) return;
    prefetching.add(next.id);
    void playable(next)
      .then((p) => {
        const i = queue.findIndex((q) => q.id === next.id);
        if (p && i >= 0) {
          queue[i] = p;
          commit();
        }
      })
      .catch(() => {})
      .finally(() => prefetching.delete(next.id));
  }

  /** Start an item, matching it first if needed. False when it can't be played (logged and skipped). */
  async function begin(item: MediaItem, by: { id: string; name: string }): Promise<boolean> {
    const p = await playable(item);
    if (!p) {
      audit({ actorId: null, action: "media.unmatched", target: { type: "media", id: item.ref, name: item.title }, details: { author: item.author } });
      return false;
    }
    start(p, by);
    return true;
  }

  /** Server-side auto-advance, so the room keeps moving even when nobody has the page open. */
  function scheduleEnd() {
    if (endTimer) clearTimeout(endTimer);
    endTimer = null;
    if (!now?.playing || !now.item.duration || now.item.kind === "twitch-live") return;
    const remaining = now.item.duration - position(now) + 3;
    const id = now.item.id;
    endTimer = setTimeout(() => {
      if (now?.item.id === id) void advance(null);
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

  /**
   * Move to the next playable queued item. `by` is null when the room advances on its own.
   * Serialised: two clients reporting "ended" at once must not skip two items.
   */
  let advancing: Promise<void> = Promise.resolve();
  function advance(by: Session["user"] | null): Promise<void> {
    const from = now?.item.id ?? null;
    const run = async () => {
      if ((now?.item.id ?? null) !== from) return; // someone else already moved on
      if (now) toHistory(now.item);
      now = null;
      while (queue.length) {
        const next = queue.shift()!;
        if (await begin(next, by ? { id: by.id, name: by.name } : next.addedBy)) break;
      }
      commit();
    };
    advancing = advancing.then(run, run);
    return advancing;
  }

  events.on("settings:changed", () => {
    if (!getSettings().sections.player && now) {
      toHistory(now.item);
      now = null;
      commit();
    }
  });

  const who = (s: Session) => ({ id: s.user.id, name: s.user.name });
  const ref = (item: MediaItem) => ({ type: "media", id: item.ref, name: item.title });

  /** Queue a link (YouTube video/playlist, Twitch, Spotify). Used by the site and by Discord's /play. */
  async function add(s: Session, input: { url: string; playNext?: boolean; whole?: boolean }): Promise<void> {
      if (typeof input?.url !== "string" || input.url.length > 500) fail("invalid");
      if (queue.length >= QUEUE_MAX) fail("queue_full");
      const sp = parseSpotify(input.url);
      if (sp) {
        if (!spotifyEnabled()) fail("spotify_not_configured");
        let res: Awaited<ReturnType<typeof spotifyTracks>>;
        try {
          res = await spotifyTracks(sp, QUEUE_MAX - queue.length);
        } catch (err) {
          throw err instanceof SpotifyError ? new ActionError(err.message) : err;
        }
        if (!res.items.length) fail("playlist_unavailable");
        const items: MediaItem[] = res.items.map((d) => ({ ...d, id: randomUUID(), addedBy: who(s), addedAt: Date.now() }));
        audit({
          actorId: s.user.id,
          action: sp.type === "track" ? "media.added" : "media.added_playlist",
          target: { type: `spotify-${sp.type}`, id: sp.id, name: res.title },
          details: { source: "spotify", ...(sp.type === "track" ? {} : { tracks: items.length }) },
        });
        if (input.playNext) queue.unshift(...items);
        else queue.push(...items);
        if (!now) {
          await advance(s.user);
          if (!now) fail("no_match");
        } else commit();
        return;
      }

      const link = parseLink(input.url);
      const list = youtubeListId(input.url);

      if (list && (input.whole || !link)) {
        if (!youtubeEnabled()) fail("youtube_not_configured");
        const room = QUEUE_MAX - queue.length;
        let pl: Awaited<ReturnType<typeof playlist>>;
        try {
          pl = await playlist(list, room);
        } catch (err) {
          throw err instanceof YouTubeError ? new ActionError(err.message) : err;
        }
        if (!pl.items.length) fail("playlist_unavailable");
        const items: MediaItem[] = pl.items.map((v) => ({
          id: randomUUID(), kind: "youtube", mode: v.music ? "music" : "video", ref: v.id, startAt: 0, title: v.title, author: v.author,
          thumbnail: v.thumbnail, duration: v.duration, addedBy: who(s), addedAt: Date.now(),
        }));
        audit({ actorId: s.user.id, action: "media.added_playlist", target: { type: "playlist", id: list, name: pl.title }, details: { videos: items.length, skipped: pl.skipped } });
        if (!now) start(items.shift()!, who(s));
        if (input.playNext) queue.unshift(...items);
        else queue.push(...items);
        commit();
        return;
      }

      if (!link) fail("unsupported_link");
      const meta = await fetchMeta(link!);
      if (!meta) fail("video_unavailable");
      const item: MediaItem = { id: randomUUID(), ...link!, ...meta!, addedBy: who(s), addedAt: Date.now() };
      audit({ actorId: s.user.id, action: "media.added", target: ref(item), details: { kind: item.kind, playNext: Boolean(input.playNext) } });
      if (!now) start(item, who(s));
      else if (input.playNext) queue.unshift(item);
      else queue.push(item);
      commit();
    }

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
          if (!getSettings().sections.player) fail("section_disabled");
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

    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : fail("invalid"));

    socket.on("media:subscribe", () => socket.emit("media:state", snapshot()));

    socket.on("media:add", handle("player.queue", (s, input: { url: string; playNext?: boolean; whole?: boolean }) => add(s, input)));

    socket.on("media:play", handle("player.control", async (s) => {
      if (!now) {
        if (!queue.length) fail("nothing_queued");
        await advance(s.user);
      } else if (!now.playing) {
        now = { ...now, playing: true, updatedAt: Date.now() };
        lastActiveAt = Date.now();
        commit();
      } else return;
      audit({ actorId: s.user.id, action: "media.played", target: ref(now!.item) });
    }));

    socket.on("media:pause", handle("player.control", (s, _input: { position: number }) => {
      if (!now?.playing) return;
      now = { ...now, playing: false, position: position(now), updatedAt: Date.now() };
      lastActiveAt = Date.now();
      audit({ actorId: s.user.id, action: "media.paused", target: ref(now.item), details: { at: Math.round(now.position) } });
      commit();
    }));

    socket.on("media:seek", handle("player.control", (s, input: { position: number }) => {
      if (!now) fail("nothing_playing");
      if (!SEEKABLE[now!.item.kind]) fail("not_seekable");
      const max = now!.item.duration ?? Number.MAX_SAFE_INTEGER;
      const to = Math.max(0, Math.min(num(input?.position), max));
      const from = position(now!);
      now = { ...now!, position: to, updatedAt: Date.now() };
      audit({ actorId: s.user.id, action: "media.seeked", target: ref(now.item), details: { from: Math.round(from), to: Math.round(to) } });
      commit();
    }));

    socket.on("media:skip", handle("player.control", async (s) => {
      if (!now) fail("nothing_playing");
      audit({ actorId: s.user.id, action: "media.skipped", target: ref(now!.item) });
      await advance(s.user);
    }));

    socket.on("media:playNow", handle("player.control", async (s, input: { id: string }) => {
      const i = queue.findIndex((q) => q.id === input?.id);
      if (i < 0) fail("not_found");
      const p = await playable(queue[i]!);
      if (!p) fail("no_match");
      const j = queue.findIndex((q) => q.id === input.id);
      if (j < 0) fail("not_found");
      const [item] = queue.splice(j, 1);
      if (now) toHistory(now.item);
      start({ ...p!, id: item!.id }, who(s));
      audit({ actorId: s.user.id, action: "media.play_now", target: ref(item!) });
      commit();
    }));

    socket.on("media:replay", handle("player.queue", (s, input: { id: string }) => {
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

    socket.on("media:remove", handle("player.queue", (s, input: { id: string }) => {
      const item = queue.find((q) => q.id === input?.id);
      if (!item) fail("not_found");
      if (item!.addedBy.id !== s.user.id && !s.permissions.includes("playback.moderate")) fail("missing_permission");
      queue = queue.filter((q) => q.id !== item!.id);
      audit({ actorId: s.user.id, action: "media.removed", target: ref(item!), details: { addedBy: item!.addedBy.name } });
      commit();
    }));

    socket.on("media:move", handle("player.control", (s, input: { id: string; to: number }) => {
      const from = queue.findIndex((q) => q.id === input?.id);
      if (from < 0) fail("not_found");
      const to = Math.max(0, Math.min(Math.trunc(num(input.to)), queue.length - 1));
      const [item] = queue.splice(from, 1);
      queue.splice(to, 0, item!);
      audit({ actorId: s.user.id, action: "media.moved", target: ref(item!), details: { from: from + 1, to: to + 1 } });
      commit();
    }));

    socket.on("media:setMode", handle("player.control", (s, input: { id: string; mode: MediaMode }) => {
      if (input?.mode !== "video" && input?.mode !== "music") fail("invalid");
      if (now?.item.id === input.id) now = { ...now, item: { ...now.item, mode: input.mode } };
      else {
        const i = queue.findIndex((q) => q.id === input.id);
        if (i < 0) fail("not_found");
        queue[i] = { ...queue[i]!, mode: input.mode };
      }
      audit({ actorId: s.user.id, action: "media.mode_changed", details: { id: input.id, mode: input.mode } });
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
      void advance(null);
    });

    socket.on("media:duration", (input) => {
      if (!now || now.item.id !== input?.itemId || now.item.duration) return;
      const d = Number(input.duration);
      if (!Number.isFinite(d) || d <= 0 || d > 24 * 3600) return;
      now = { ...now, item: { ...now.item, duration: d } };
      commit();
    });
  }

  /** Queue items from outside a socket (saved playlists). Fresh ids; the first starts if the room is idle. */
  async function enqueue(items: MediaItem[], by: { id: string; name: string }, opts: { playNext?: boolean } = {}) {
    const fresh = items
      .slice(0, QUEUE_MAX - queue.length)
      .map((i) => ({ ...withMode(i), id: randomUUID(), addedBy: by, addedAt: Date.now(), startAt: 0 }));
    if (!fresh.length) throw new ActionError("queue_full");
    const count = fresh.length;
    if (opts.playNext) queue.unshift(...fresh);
    else queue.push(...fresh);
    if (!now) await advance(by as Session["user"]);
    else commit();
    return count;
  }

  /** Find an item anywhere the room knows about it. */
  function findItem(id: string): MediaItem | null {
    if (now?.item.id === id) return now.item;
    return queue.find((q) => q.id === id) ?? history.find((h) => h.id === id) ?? null;
  }

  scheduleEnd();
  /** Skip on behalf of someone (Discord /skip). */
  async function skip(s: Session) {
    if (!now) throw new ActionError("nothing_playing");
    audit({ actorId: s.user.id, action: "media.skipped", target: ref(now.item), details: { via: "discord" } });
    await advance(s.user);
  }

  const room = { attach, snapshot, enqueue, findItem, add, skip };
  current = room;
  return room;
}

export { ActionError as MediaActionError };
let current: {
  enqueue: (items: MediaItem[], by: { id: string; name: string }, opts?: { playNext?: boolean }) => Promise<number>;
  findItem: (id: string) => MediaItem | null;
  snapshot: () => MediaState;
  add: (s: Session, input: { url: string; playNext?: boolean; whole?: boolean }) => Promise<void>;
  skip: (s: Session) => Promise<void>;
} | null = null;
export const mediaRoom = () => {
  if (!current) throw new Error("media room not started");
  return current;
};
