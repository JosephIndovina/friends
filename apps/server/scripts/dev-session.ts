// Dev only: sign in as the owner without Discord and print a session cookie value.
// Usage: tsx --conditions=development scripts/dev-session.ts
import { env, isProd } from "../src/env.js";
import { createSession, upsertUser } from "../src/sessions.js";

if (isProd) throw new Error("dev-session is for development only");
upsertUser({ id: env.OWNER_DISCORD_ID, name: "Dev Owner", avatarUrl: "" } as Parameters<typeof upsertUser>[0]);
console.log(createSession(env.OWNER_DISCORD_ID, { ip: "127.0.0.1", userAgent: "dev-session" }));
