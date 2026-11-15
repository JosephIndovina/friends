import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { env, isProd } from "./env.js";
import "./db.js";
import { accessControl } from "./access.js";
import { adminRoutes } from "./admin.js";
import { pruneAudit } from "./audit.js";
import { authRoutes } from "./auth.js";
import { createRealtime } from "./realtime.js";
import { ensureOwner, pruneSessions } from "./sessions.js";
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

app.get("/healthz", async () => ({ ok: true }));
await app.register(authRoutes);
await app.register(adminRoutes);

// In production the server also serves the built web app (single container).
const webDist = resolve(env.WEB_DIST ?? "../web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== "GET" || req.url.startsWith("/api/") || req.url.startsWith("/auth/")) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.sendFile("index.html");
  });
}

createRealtime(app.server);
ensureOwner();
pruneSessions();
pruneAudit();
setInterval(() => (pruneSessions(), pruneAudit()), 60 * 60 * 1000).unref();

await app.listen({ host: "0.0.0.0", port: env.PORT });

startBot(app.log).catch((err) => app.log.error({ err }, "discord bot failed to start; the site keeps running"));
