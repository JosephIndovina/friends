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
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment. Copy .env.example to .env and fill it in.");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
export const redirectUri = new URL("/auth/discord/callback", env.PUBLIC_URL).toString();
