import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Me } from "@friends/shared";
import { env, isProd, redirectUri } from "./env.js";
import { createSession, deleteSession, SESSION_COOKIE, SESSION_TTL_MS, upsertUser, userForSession } from "./sessions.js";

const DISCORD_API = "https://discord.com/api/v10";
const STATE_COOKIE = "oauth_state";

interface DiscordUser { id: string; username: string; global_name: string | null; avatar: string | null }
interface DiscordMember { nick: string | null; avatar: string | null; user?: DiscordUser }

function avatarUrl(user: DiscordUser, member: DiscordMember): string {
  if (member.avatar) return `https://cdn.discordapp.com/guilds/${env.DISCORD_GUILD_ID}/users/${user.id}/avatars/${member.avatar}.png?size=128`;
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

export async function authRoutes(app: FastifyInstance) {
  const cookieBase = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: isProd };

  app.get("/auth/discord/login", async (_req, reply) => {
    const state = randomBytes(16).toString("base64url");
    reply.setCookie(STATE_COOKIE, state, { ...cookieBase, maxAge: 600, signed: true });
    const url = new URL("https://discord.com/oauth2/authorize");
    url.search = new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "identify guilds.members.read",
      state,
      prompt: "none",
    }).toString();
    return reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/auth/discord/callback", async (req, reply) => {
    const fail = (reason: string) => reply.clearCookie(STATE_COOKIE, { path: "/" }).redirect(`/?auth_error=${reason}`);
    const { code, state, error } = req.query;
    if (error) return fail("cancelled");
    const saved = req.unsignCookie(req.cookies[STATE_COOKIE] ?? "");
    if (!code || !state || !saved.valid || saved.value !== state) return fail("expired");

    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
      }),
    });
    if (!tokenRes.ok) {
      req.log.warn({ status: tokenRes.status }, "discord token exchange failed");
      return fail("discord");
    }
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const auth = { Authorization: `Bearer ${access_token}` };

    const memberRes = await fetch(`${DISCORD_API}/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`, { headers: auth });
    if (memberRes.status === 404) return fail("not_member");
    if (!memberRes.ok) return fail("discord");
    const member = (await memberRes.json()) as DiscordMember;
    const user = member.user ?? ((await (await fetch(`${DISCORD_API}/users/@me`, { headers: auth })).json()) as DiscordUser);

    const me: Me = { id: user.id, name: member.nick ?? user.global_name ?? user.username, avatarUrl: avatarUrl(user, member) };
    upsertUser(me);
    const token = createSession(me.id);
    return reply
      .clearCookie(STATE_COOKIE, { path: "/" })
      .setCookie(SESSION_COOKIE, token, { ...cookieBase, maxAge: SESSION_TTL_MS / 1000 })
      .redirect("/");
  });

  app.post("/auth/logout", async (req, reply) => {
    deleteSession(req.cookies[SESSION_COOKIE]);
    return reply.clearCookie(SESSION_COOKIE, { path: "/" }).send({ ok: true });
  });

  app.get("/api/me", async (req, reply) => {
    const me = userForSession(req.cookies[SESSION_COOKIE]);
    if (!me) return reply.code(401).send({ error: "unauthenticated" });
    return me;
  });
}
