import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PUBLIC_URL: z.url().default("http://localhost:5173"),
  PORT: z.coerce.number().default(3000),
  DATA_DIR: z.string().default("./data"),
  WEB_DIST: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_NOTIFY_CHANNEL_ID: z.string().optional(),
  OWNER_DISCORD_ID: z.string().regex(/^\d{15,22}$/, "must be a Discord user id"),
  APP_VERSION: z.string().default("dev"),
  YOUTUBE_API_KEY: z.string().optional(),
  SPOTIFY_CLIENT_ID: z.string().optional(),
  SPOTIFY_CLIENT_SECRET: z.string().optional(),
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  /** LiveKit's Prometheus endpoint for the admin System page, e.g. http://user:pass@host.docker.internal:6789/metrics */
  LIVEKIT_METRICS_URL: z.union([z.url(), z.literal("")]).optional(),
  /** Where the desktop app installers live (served at /download/...). */
  DOWNLOADS_DIR: z.string().optional(),
  TWITCH_CLIENT_ID: z.string().optional(),
  TWITCH_CLIENT_SECRET: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment. Copy .env.example to .env and fill it in.");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
export const publicOrigin = new URL(env.PUBLIC_URL).origin;
export const redirectUri = new URL("/auth/discord/callback", env.PUBLIC_URL).toString();
