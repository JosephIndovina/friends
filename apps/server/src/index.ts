import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { env, isProd } from "./env.js";
import "./db.js";
import { accessControl } from "./access.js";
import { adminRoutes } from "./admin.js";
import { pruneAudit } from "./audit.js";
import { authRoutes } from "./auth.js";
import { mediaRoutes } from "./mediaRoutes.js";
import { playlistRoutes } from "./playlists.js";
import { postRoutes, pruneUploads, UPLOAD_DIR } from "./posts.js";
import { soundRoutes } from "./sounds.js";
import { ttsRoutes } from "./tts.js";
import { castRoutes, DOWNLOADS, downloadOffered, downloadsDir } from "./cast.js";
import { createRealtime } from "./realtime.js";
import { ensureOwner, pruneSessions } from "./sessions.js";
import { countResponses, metricsRoutes, pruneMetrics, startMetrics } from "./metrics.js";
import { startBot } from "./bot.js";

const app = Fastify({ logger: { level: isProd ? "info" : "debug" }, trustProxy: true });

await app.register(cookie, { secret: env.DISCORD_CLIENT_SECRET });
await app.register(rateLimit, {
  max: 300,
  timeWindow: "1 minute",
  keyGenerator: (req) => String(req.headers["cf-connecting-ip"] ?? req.ip),
});
// Not wrapped in register(): its hooks must cover every route in the app.
await accessControl(app);
countResponses(app);

app.get("/healthz", async () => ({ ok: true }));
await app.register(authRoutes);
await app.register(adminRoutes);
await app.register(metricsRoutes);
await app.register(mediaRoutes);
await app.register(playlistRoutes);
await app.register(postRoutes);
await app.register(soundRoutes);
await app.register(ttsRoutes);
await app.register(castRoutes);

// In production the server also serves the built web app (single container).
const webDist = resolve(env.WEB_DIST ?? "../web/dist");
const hasWeb = existsSync(webDist);
// Always registered: uploads are sent with reply.sendFile even when there's no built web app (dev).
await app.register(fastifyStatic, { root: hasWeb ? webDist : resolve(UPLOAD_DIR), serve: hasWeb, wildcard: false });
// Desktop app installers. Named files only; anyone may download them (the app itself still needs a launch code).
app.get<{ Params: { file: string } }>("/download/:file", { config: { public: true } }, async (req, reply) => {
  const os = (Object.keys(DOWNLOADS) as Array<keyof typeof DOWNLOADS>).find((k) => DOWNLOADS[k] === req.params.file);
  if (!os || !downloadOffered(os)) return reply.code(404).send({ error: "not_found" });
  return reply.header("Content-Disposition", `attachment; filename="${req.params.file}"`).sendFile(req.params.file, downloadsDir);
});
if (hasWeb) {
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== "GET" || req.url.startsWith("/api/") || req.url.startsWith("/auth/")) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.sendFile("index.html");
  });
}

startMetrics(createRealtime(app.server));
ensureOwner();
pruneSessions();
pruneAudit();
pruneMetrics();
void pruneUploads();
setInterval(() => (pruneSessions(), pruneAudit(), pruneMetrics(), void pruneUploads()), 60 * 60 * 1000).unref();

await app.listen({ host: "0.0.0.0", port: env.PORT });

startBot(app.log).catch((err) => app.log.error({ err }, "discord bot failed to start; the site keeps running"));
