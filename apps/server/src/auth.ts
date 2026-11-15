import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Me } from "@friends/shared";
import { isAdminish } from "./access.js";
import { audit, clientIp } from "./audit.js";
import { env, isProd, redirectUri } from "./env.js";
import { events } from "./events.js";
import {
  createSession, deleteSession, getUser, SESSION_COOKIE, SESSION_TTL_MS, sessionFor, sessionForToken, upsertUser,
} from "./sessions.js";
import { db } from "./db.js";
import { getSettings } from "./settings.js";

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
  const strict = { config: { public: true, rateLimit: { max: 20, timeWindow: "1 minute" } } };

  app.get("/auth/discord/login", strict, async (_req, reply) => {
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

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/auth/discord/callback", strict, async (req, reply) => {
    const fail = (reason: string, who?: Me) => {
      audit({ actorId: who?.id ?? null, action: "auth.denied", target: who ? { type: "user", id: who.id, name: who.name } : undefined, details: { reason }, req });
      return reply.clearCookie(STATE_COOKIE, { path: "/" }).redirect(`/?auth_error=${reason}`);
    };
    const { code, state, error } = req.query;
    if (error) return reply.clearCookie(STATE_COOKIE, { path: "/" }).redirect("/?auth_error=cancelled");
    const saved = req.unsignCookie(req.cookies[STATE_COOKIE] ?? "");
    if (!code || !state || !saved.valid || saved.value !== state) return fail("expired");

    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: redirectUri,
        client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
      }),
    });
    if (!tokenRes.ok) {
      req.log.warn({ status: tokenRes.status }, "discord token exchange failed");
      return fail("discord");
    }
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const auth = { Authorization: `Bearer ${access_token}` };

    const memberRes = await fetch(`${DISCORD_API}/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`, { headers: auth });
    if (memberRes.status === 404) {
      const u = (await (await fetch(`${DISCORD_API}/users/@me`, { headers: auth })).json()) as DiscordUser;
      return fail("not_member", { id: u.id, name: u.global_name ?? u.username, avatarUrl: "" });
    }
    if (!memberRes.ok) return fail("discord");
    const member = (await memberRes.json()) as DiscordMember;
    const user = member.user ?? ((await (await fetch(`${DISCORD_API}/users/@me`, { headers: auth })).json()) as DiscordUser);
    const me: Me = { id: user.id, name: member.nick ?? user.global_name ?? user.username, avatarUrl: avatarUrl(user, member) };

    const isNew = !getUser(me.id);
    let row = upsertUser(me);
    if (row.status === "banned") return fail("banned", me);
    if (row.status === "suspended") return fail("suspended", me);
    if (row.status === "left") {
      // They were approved before, left the Discord server, and are back: restore.
      db.prepare("UPDATE users SET status = 'active', status_reason = NULL WHERE id = ?").run(me.id);
      audit({ actorId: null, action: "user.rejoined", target: { type: "user", id: me.id, name: me.name }, req });
      row = getUser(me.id)!;
    }
    const session = sessionFor(row);
    if (getSettings().lockdown && row.status === "active" && !isAdminish(session)) return fail("lockdown", me);

    const token = createSession(me.id, { ip: clientIp(req), userAgent: String(req.headers["user-agent"] ?? "") });
    audit({ actorId: me.id, action: "auth.login", details: { status: row.status }, req });
    if (isNew && row.status === "pending") {
      audit({ actorId: me.id, action: "access.requested", target: { type: "user", id: me.id, name: me.name }, req });
      events.emit("access:requested", me);
    }
    return reply
      .clearCookie(STATE_COOKIE, { path: "/" })
      .setCookie(SESSION_COOKIE, token, { ...cookieBase, maxAge: SESSION_TTL_MS / 1000 })
      .redirect("/");
  });

  app.post("/auth/logout", { config: { public: true } }, async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    const s = sessionForToken(token);
    deleteSession(token);
    if (s) audit({ actorId: s.user.id, action: "auth.logout", req });
    return reply.clearCookie(SESSION_COOKIE, { path: "/" }).send({ ok: true });
  });

  app.get("/api/me", { config: { allowPending: true } }, async (req) => req.session);
}
