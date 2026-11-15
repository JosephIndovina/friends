import type { FastifyInstance } from "fastify";
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

async function remove(identity: string, reason: string) {
  try {
    await rooms().removeParticipant(ROOM, identity);
    audit({ actorId: null, action: "cast.removed", target: { type: "user", id: identity, name: getUser(identity)?.name ?? null }, details: { reason } });
  } catch {
    /* not in the room */
  }
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
  });

  app.post("/api/cast/token", { config: { permission: "cast.watch", rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!getSettings().sections.cast) return reply.code(403).send({ error: "section_disabled" });
    const s = req.session!;
    const canStream = s.permissions.includes("cast.stream");
    const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      identity: s.user.id,
      name: s.user.name,
      metadata: JSON.stringify({ avatarUrl: s.user.avatarUrl }),
      ttl: "6h",
    });
    at.addGrant({
      room: ROOM,
      roomJoin: true,
      canSubscribe: true,
      canPublish: canStream,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      canPublishSources: canStream ? [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : [],
    });
    return { token: await at.toJwt(), canStream };
  });

  // Moderators can end someone's stream (they're removed from the room and can rejoin without it).
  app.post<{ Params: { id: string } }>("/api/cast/:id/stop", { config: { permission: "playback.moderate" } }, async (req) => {
    const target = getUser(req.params.id);
    await rooms().removeParticipant(ROOM, req.params.id).catch(() => {});
    audit({ actorId: req.session!.user.id, action: "cast.stopped", target: { type: "user", id: req.params.id, name: target?.name ?? null }, req });
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
    for (const p of participants) {
      if (only && p.identity !== only) continue;
      const row = getUser(p.identity);
      const s = row ? sessionFor(row) : null;
      if (!castOn) await remove(p.identity, "section_disabled");
      else if (gate(s) || !s!.permissions.includes("cast.watch")) await remove(p.identity, "access_revoked");
      else if (screens(p).length && !s!.permissions.includes("cast.stream")) await remove(p.identity, "stream_permission_revoked");
    }
  };
  events.on("session:changed", (id) => void recheck(id));
  events.on("settings:changed", () => void recheck(null));

  // Watch who is live, for the audit log and "went live" posts. Polling keeps LiveKit unreachable from outside.
  const live = new Map<string, { identity: string; name: string; since: number }>();
  const lastNotified = new Map<string, number>();
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
        live.set(key, { identity: p.identity, name: p.name, since: Date.now() });
        audit({ actorId: p.identity, action: "cast.started", details: { track: t.name, width: t.width, height: t.height } });
        const last = lastNotified.get(p.identity) ?? 0;
        if (getSettings().notify.goLive && Date.now() - last > GO_LIVE_NOTIFY_GAP_MS) {
          lastNotified.set(p.identity, Date.now());
          events.emit("notify", { title: `${p.name} is live`, description: "Watch on the stage.", url: "/", buttonLabel: "Watch" });
        }
      }
    }
    for (const [key, v] of live) {
      if (seen.has(key)) continue;
      live.delete(key);
      audit({ actorId: v.identity, action: "cast.ended", details: { minutes: Math.round((Date.now() - v.since) / 60000) } });
    }
  }, WATCH_MS).unref();

}
