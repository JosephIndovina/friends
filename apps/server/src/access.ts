import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Permission, Session } from "@friends/shared";
import { audit } from "./audit.js";
import { isProd, publicOrigin } from "./env.js";
import { SESSION_COOKIE, sessionForToken } from "./sessions.js";
import { getSettings } from "./settings.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** reachable without signing in */
    public?: boolean;
    /** reachable by signed-in users who are still pending approval */
    allowPending?: boolean;
    /** required permission; omit only for routes every active user may call */
    permission?: Permission;
    /** callable from outside the browser (the desktop app): skips the same-origin check, so the route must authorize by something other than the cookie */
    anyOrigin?: boolean;
  }
  interface FastifyRequest {
    session: Session | null;
  }
}

const ADMIN_PERMS: Permission[] = ["admin.people", "admin.roles", "admin.audit", "admin.settings"];
export const isAdminish = (s: Session) => s.isOwner || s.permissions.some((p) => ADMIN_PERMS.includes(p));

/** Can this session use the site at all right now? Returns a reason code when not. */
export function gate(s: Session | null): "unauthenticated" | "pending" | "inactive" | "lockdown" | null {
  if (!s) return "unauthenticated";
  if (s.isOwner) return null;
  if (s.status === "pending") return "pending";
  if (s.status !== "active") return "inactive";
  if (getSettings().lockdown && !isAdminish(s)) return "lockdown";
  return null;
}

function deny(req: FastifyRequest, reply: FastifyReply, code: number, error: string) {
  if (code === 403 && req.session) {
    audit({ actorId: req.session.user.id, action: "access.forbidden", details: { method: req.method, url: req.url, reason: error }, req });
  }
  return reply.code(code).send({ error });
}

/**
 * Deny-by-default guard for every route. A route must opt out explicitly (`public`) or name the
 * permission it needs. State-changing requests must also come from our own origin.
 */
export async function accessControl(app: FastifyInstance) {
  app.decorateRequest("session", null);

  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && !req.routeOptions.config.anyOrigin) {
      const origin = req.headers.origin;
      const sameSite = req.headers["sec-fetch-site"];
      const ok = origin ? origin === publicOrigin || (!isProd && origin.startsWith("http://localhost")) : sameSite === "same-origin";
      if (!ok) return reply.code(403).send({ error: "bad_origin" });
    }

    const config = req.routeOptions.config;
    // Static files and the SPA fallback are not API surface.
    if (!req.url.startsWith("/api/") && !req.url.startsWith("/auth/")) return;
    if (config.public) return;

    req.session = sessionForToken(req.cookies[SESSION_COOKIE]);
    const blocked = gate(req.session);
    if (blocked === "unauthenticated") return deny(req, reply, 401, blocked);
    if (blocked === "pending" && config.allowPending) return;
    if (blocked) return deny(req, reply, 403, blocked);
    if (config.permission && !req.session!.permissions.includes(config.permission)) {
      return deny(req, reply, 403, "missing_permission");
    }
  });

  // Every API route must be classified, so a forgotten guard fails loudly at startup instead of shipping open.
  app.addHook("onRoute", (route) => {
    const url = route.url;
    if (!url.startsWith("/api/") && !url.startsWith("/auth/")) return;
    const c = (route.config ?? {}) as { public?: boolean; permission?: string; allowPending?: boolean; anyActive?: boolean };
    if (!c.public && !c.permission && !c.allowPending && !c.anyActive) {
      throw new Error(`Route ${route.method} ${url} has no access rule (set public, permission, allowPending or anyActive)`);
    }
  });
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** explicitly open to every active user */
    anyActive?: boolean;
  }
}
