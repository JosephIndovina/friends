import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AccessToken, RoomServiceClient, TrackSource, type ParticipantInfo } from "livekit-server-sdk";
import { audit } from "./audit.js";
import { env } from "./env.js";
import { events } from "./events.js";
import { getUser, sessionFor } from "./sessions.js";
import { getSettings } from "./settings.js";
import { gate } from "./access.js";

/**
 * Cast: screen and game streams through a self-hosted LiveKit server. The browser negotiates through
 * our own origin (/livekit/rtc is proxied to LiveKit's signalling port, so it rides the Cloudflare
 * tunnel); the media itself goes straight to the NAS over the forwarded UDP/TCP ports.
 */

export const ROOM = "stage";
const WATCH_MS = 5000;
const GO_LIVE_NOTIFY_GAP_MS = 10 * 60 * 1000;

export const castEnabled = () => Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
const rooms = () => new RoomServiceClient(env.LIVEKIT_URL!, env.LIVEKIT_API_KEY!, env.LIVEKIT_API_SECRET!);

const screens = (p: ParticipantInfo) => p.tracks.filter((t) => t.source === TrackSource.SCREEN_SHARE);
const cameras = (p: ParticipantInfo) => p.tracks.filter((t) => t.source === TrackSource.CAMERA);

/** What a connection may publish: the site's own connection may also send a camera, while the admin allows it. */
const publishSources = (canStream: boolean, site: boolean) =>
  !canStream ? [] : [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO, ...(site && getSettings().cameras ? [TrackSource.CAMERA] : [])];

/** Each tab or device joins as "<user id>#<random>", so one person can have the site open in several places. */
const userOf = (identity: string) => identity.split("#")[0]!;

/** Take every connection of one user out of the room. */
async function remove(userId: string, reason: string) {
  let participants: ParticipantInfo[];
  try {
    participants = await rooms().listParticipants(ROOM);
  } catch {
    return;
  }
  const mine = participants.filter((p) => userOf(p.identity) === userId);
  for (const p of mine) await rooms().removeParticipant(ROOM, p.identity).catch(() => {});
  if (mine.length) audit({ actorId: null, action: "cast.removed", target: { type: "user", id: userId, name: getUser(userId)?.name ?? null }, details: { reason } });
}

/** One-time codes handed to the desktop app; see /api/cast/launch. */
const LAUNCH_TTL_MS = 2 * 60 * 1000;
const launches = new Map<string, { userId: string; expires: number; opened: boolean }>();
/** Older desktop apps are told to update before they can go live. */
const APP_MIN_VERSION = "0.1.0";
const older = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
};

export const DOWNLOADS = { linux: "friends-live_amd64.deb", arch: "friends-live-x86_64.pkg.tar.zst", windows: "friends-live_x64-setup.exe" } as const;
export const downloadsDir = resolve(env.DOWNLOADS_DIR ?? "./downloads");

/** A token for the stage. The site's own connection watches and may publish; the desktop app only publishes. */
async function stageToken(user: { id: string; name: string; avatarUrl: string | null }, canStream: boolean, canSubscribe: boolean) {
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: `${user.id}#${randomBytes(4).toString("hex")}`,
    name: user.name,
    // The desktop app's connection (publish only) is marked, so the site can offer "Change window" for its stream.
    metadata: JSON.stringify({ avatarUrl: user.avatarUrl, ...(canSubscribe ? {} : { app: true }) }),
    ttl: "6h",
  });
  at.addGrant({
    room: ROOM,
    roomJoin: true,
    canSubscribe,
    canPublish: canStream,
    canPublishData: false,
    canUpdateOwnMetadata: false,
    canPublishSources: publishSources(canStream, canSubscribe),
  });
  return at.toJwt();
}

export async function castRoutes(app: FastifyInstance) {
  if (!castEnabled()) {
    app.post("/api/cast/token", { config: { anyActive: true } }, async (_req, reply) => reply.code(503).send({ error: "cast_not_configured" }));
    return;
  }

  // Signalling (WebSocket + /rtc/validate) through our origin. LiveKit checks the token itself.
  await app.register(import("@fastify/http-proxy"), {
    upstream: env.LIVEKIT_URL!,
    prefix: "/livekit/rtc",
    rewritePrefix: "/rtc",
    websocket: true,
    // Browsers put the token in the URL; the desktop app sends it as "Authorization: Bearer". The proxy only
    // passes cookies along by default. (rewriteRequestHeaders is supported but missing from the plugin's types.)
    wsClientOptions: {
      rewriteRequestHeaders: (headers: Record<string, string>, req: FastifyRequest) => {
        const out = req.headers.cookie ? { ...headers, cookie: req.headers.cookie } : { ...headers };
        return req.headers.authorization ? { ...out, authorization: req.headers.authorization } : out;
      },
    } as object,
  });

  app.post("/api/cast/token", { config: { permission: "cast.watch", rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!getSettings().sections.cast) return reply.code(403).send({ error: "section_disabled" });
    const s = req.session!;
    const canStream = s.permissions.includes("cast.stream");
    return { token: await stageToken(s.user, canStream, true), canStream };
  });

  // Go live from the desktop app. The site makes a one-time code and opens friends://live?code=…; the app
  // trades the code for a publish-only token. The code is the only credential the app ever holds.
  app.post("/api/cast/launch", { config: { permission: "cast.stream", rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!getSettings().sections.cast) return reply.code(403).send({ error: "section_disabled" });
    const now = Date.now();
    for (const [k, v] of launches) if (v.expires < now) launches.delete(k);
    const code = randomBytes(24).toString("base64url");
    launches.set(code, { userId: req.session!.user.id, expires: now + LAUNCH_TTL_MS, opened: false });
    return { code, expiresIn: LAUNCH_TTL_MS };
  });

  // The site polls this to tell "the app opened" apart from "nothing is installed".
  app.get<{ Params: { code: string } }>("/api/cast/launch/:code", { config: { permission: "cast.stream" } }, async (req, reply) => {
    const l = launches.get(req.params.code);
    if (!l || l.userId !== req.session!.user.id) return reply.code(404).send({ error: "not_found" });
    return { opened: l.opened };
  });

  app.post<{ Body: { code?: unknown; version?: unknown; os?: unknown } }>(
    "/api/cast/launch/redeem",
    { config: { public: true, anyOrigin: true, rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const code = typeof req.body?.code === "string" ? req.body.code : "";
      const l = launches.get(code);
      if (!l || l.opened || l.expires < Date.now()) return reply.code(404).send({ error: "expired" });
      const version = typeof req.body?.version === "string" ? req.body.version : "0";
      if (older(version, APP_MIN_VERSION)) return reply.code(426).send({ error: "update_required", minVersion: APP_MIN_VERSION });
      l.opened = true;
      // Re-check access now, not when the code was made.
      const row = getUser(l.userId);
      const s = row ? sessionFor(row) : null;
      if (!getSettings().sections.cast) return reply.code(403).send({ error: "section_disabled" });
      if (gate(s) || !s!.permissions.includes("cast.stream")) return reply.code(403).send({ error: "missing_permission" });
      const os = req.body?.os === "linux" || req.body?.os === "windows" ? req.body.os : null;
      audit({ actorId: s!.user.id, action: "cast.app_opened", details: { version, os }, req });
      return { token: await stageToken(s!.user, true, false), name: s!.user.name, livekitPath: "/livekit" };
    },
  );

  // Installers for the desktop app, if this server has them (see DOWNLOADS_DIR).
  app.get("/api/cast/app", { config: { permission: "cast.stream" } }, async () => {
    const have = (f: string) => existsSync(join(downloadsDir, f));
    return {
      minVersion: APP_MIN_VERSION,
      linux: have(DOWNLOADS.linux) ? `/download/${DOWNLOADS.linux}` : null,
      arch: have(DOWNLOADS.arch) ? `/download/${DOWNLOADS.arch}` : null,
      windows: have(DOWNLOADS.windows) ? `/download/${DOWNLOADS.windows}` : null,
    };
  });

  // Where your camera sits over your stream, for everyone watching: only you can move or resize it. The server sets it
  // as a participant attribute (connections can't change their own), on the connection that sends the camera.
  app.post<{ Body: { identity?: unknown; x?: unknown; y?: unknown; corner?: unknown; size?: unknown } }>(
    "/api/cast/camera/layout",
    { config: { permission: "cast.stream", rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { identity, size } = req.body ?? {};
      let { x, y } = req.body ?? {};
      // A page from before free placement sends a corner.
      const corner = ({ tl: [0, 0], tr: [1, 0], bl: [0, 1], br: [1, 1] } as Record<string, [number, number]>)[String(req.body?.corner)];
      if (corner) [x, y] = corner;
      const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
      if (typeof identity !== "string" || !num(x) || !num(y) || !num(size)) return reply.code(400).send({ error: "invalid_body" });
      if (userOf(identity) !== req.session!.user.id) return reply.code(403).send({ error: "not_yours" });
      const unit = (v: number) => Math.min(1, Math.max(0, v)).toFixed(3);
      const share = Math.min(0.5, Math.max(0.1, size));
      try {
        await rooms().updateParticipant(ROOM, identity, { attributes: { camera: `${unit(x)}:${unit(y)}:${share.toFixed(3)}` } });
      } catch {
        return reply.code(404).send({ error: "not_found" });
      }
      return { ok: true };
    },
  );

  // Moderators can end someone's stream: that connection leaves the room and can rejoin without it.
  // Anyone can also end their own stream from another of their tabs or devices.
  app.post<{ Params: { id: string } }>("/api/cast/:id/stop", { config: { permission: "cast.watch" } }, async (req, reply) => {
    const userId = userOf(req.params.id);
    const own = userId === req.session!.user.id;
    if (!own && !req.session!.permissions.includes("playback.moderate")) {
      audit({ actorId: req.session!.user.id, action: "access.forbidden", details: { method: req.method, url: req.url, reason: "missing_permission" }, req });
      return reply.code(403).send({ error: "missing_permission" });
    }
    const target = getUser(userId);
    // A bare user id ends every connection of theirs; "<user id>#<conn>" ends just that one.
    const all = await rooms().listParticipants(ROOM).catch(() => [] as ParticipantInfo[]);
    const ending = all.filter((x) => (req.params.id.includes("#") ? x.identity === req.params.id : userOf(x.identity) === userId));
    for (const p of ending) await rooms().removeParticipant(ROOM, p.identity).catch(() => {});
    // Tell the streamer who ended it, on every tab they have open (the app shows its own note).
    if (!own && ending.length) {
      const app = ending.some((p) => p.metadata.includes('"app":true'));
      events.emit("cast:ended", { userId, by: req.session!.user.name, app });
    }
    audit({ actorId: req.session!.user.id, action: "cast.stopped", target: { type: "user", id: userId, name: target?.name ?? null }, details: { own }, req });
    return { ok: true };
  });

  // Enforcement: losing access (or the section) takes you out of the room immediately.
  events.on("user:kick", (id) => void remove(id, "access_revoked"));
  const recheck = async (only: string | null) => {
    let participants: ParticipantInfo[];
    try {
      participants = await rooms().listParticipants(ROOM);
    } catch {
      return;
    }
    const castOn = getSettings().sections.cast;
    const out = async (p: ParticipantInfo, reason: string) => {
      await rooms().removeParticipant(ROOM, p.identity).catch(() => {});
      audit({ actorId: null, action: "cast.removed", target: { type: "user", id: userOf(p.identity), name: p.name }, details: { reason } });
    };
    for (const p of participants) {
      const userId = userOf(p.identity);
      if (only && userId !== only) continue;
      const row = getUser(userId);
      const s = row ? sessionFor(row) : null;
      if (!castOn) await out(p, "section_disabled");
      else if (gate(s) || !s!.permissions.includes("cast.watch")) await out(p, "access_revoked");
      else if ((screens(p).length || cameras(p).length) && !s!.permissions.includes("cast.stream")) await out(p, "stream_permission_revoked");
      else if (p.permission?.canSubscribe && s!.permissions.includes("cast.stream")) await syncCamera(p);
    }
  };
  // Cameras turned off or back on: already-connected site tabs get the new publish rights without reconnecting,
  // and any camera still on is muted (the site also turns its own off when it hears the setting changed).
  const syncCamera = async (p: ParticipantInfo) => {
    const want = publishSources(true, true);
    const have = p.permission?.canPublishSources ?? [];
    if (want.length !== have.length || want.some((x) => !have.includes(x))) {
      await rooms()
        .updateParticipant(ROOM, p.identity, undefined, { canSubscribe: true, canPublish: true, canPublishData: false, canUpdateMetadata: false, canPublishSources: want })
        .catch(() => {});
    }
    if (!getSettings().cameras) for (const t of cameras(p)) await rooms().mutePublishedTrack(ROOM, p.identity, t.sid, true).catch(() => {});
  };
  events.on("session:changed", (id) => void recheck(id));
  events.on("settings:changed", () => void recheck(null));

  // Watch who is live, for the audit log and "went live" posts. Polling keeps LiveKit unreachable from outside.
  const live = new Map<string, { identity: string; name: string; since: number }>();
  const lastNotified = new Map<string, number>();
  // The first look after a restart only learns who is already live; nobody is told they just started.
  let primed = false;
  setInterval(async () => {
    let participants: ParticipantInfo[];
    try {
      participants = await rooms().listParticipants(ROOM);
    } catch {
      return;
    }
    const seen = new Set<string>();
    for (const p of participants) {
      for (const t of screens(p)) {
        const key = `${p.identity}:${t.sid}`;
        seen.add(key);
        if (live.has(key)) continue;
        const userId = userOf(p.identity);
        live.set(key, { identity: userId, name: p.name, since: Date.now() });
        audit({ actorId: userId, action: "cast.started", details: { track: t.name, width: t.width, height: t.height } });
        if (primed) events.emit("notice", { by: userId, text: `${p.name} went live` });
        const last = lastNotified.get(userId) ?? 0;
        if (getSettings().notify.goLive && Date.now() - last > GO_LIVE_NOTIFY_GAP_MS) {
          lastNotified.set(userId, Date.now());
          events.emit("notify", { title: `${p.name} is live`, description: "Watch on the stage.", url: "/", buttonLabel: "Watch" });
        }
      }
    }
    for (const [key, v] of live) {
      if (seen.has(key)) continue;
      live.delete(key);
      audit({ actorId: v.identity, action: "cast.ended", details: { minutes: Math.round((Date.now() - v.since) / 60000) } });
      events.emit("notice", { by: v.identity, text: `${v.name} stopped streaming` });
    }
    primed = true;
  }, WATCH_MS).unref();

}
