import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "./audit.js";
import { SESSION_COOKIE } from "./sessions.js";
import { getSettings } from "./settings.js";
import { quotaUsed, search, YouTubeError, youtubeEnabled } from "./youtube.js";

export async function mediaRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>(
    "/api/media/search",
    {
      config: {
        permission: "media.queue",
        // Per person, not per IP: the quota is shared by everyone.
        rateLimit: { max: 30, timeWindow: "1 hour", keyGenerator: (req) => `yt:${req.cookies[SESSION_COOKIE] ?? req.ip}` },
      },
    },
    async (req, reply) => {
      if (!getSettings().sections.media) return reply.code(403).send({ error: "section_disabled" });
      if (!youtubeEnabled()) return reply.code(503).send({ error: "youtube_not_configured" });
      const q = z.string().trim().min(1).max(120).safeParse(req.query.q);
      if (!q.success) return reply.code(400).send({ error: "invalid_query" });
      try {
        const { results, cached } = await search(q.data);
        audit({ actorId: req.session!.user.id, action: "media.searched", details: { q: q.data, results: results.length, cached }, req });
        return { results, quota: quotaUsed() };
      } catch (err) {
        if (err instanceof YouTubeError) return reply.code(err.message === "youtube_quota" ? 429 : 502).send({ error: err.message });
        throw err;
      }
    },
  );
}
