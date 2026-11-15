import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ALL_PERMISSIONS, type AdminUser, type Permission, type Role, type Session, type SiteSettings } from "@friends/shared";
import { audit, queryAudit, type AuditQuery } from "./audit.js";
import { db } from "./db.js";
import { env } from "./env.js";
import { events } from "./events.js";
import { deleteUserSessions, getUser, isOwner, type UserRow } from "./sessions.js";
import { getSettings, saveSettings } from "./settings.js";
import { quotaUsed, youtubeEnabled } from "./youtube.js";

const UNRANKED = 1000;
const startedAt = Date.now();

function rolePosition(roleId: string | null): number {
  if (!roleId) return UNRANKED;
  const r = db.prepare("SELECT position FROM roles WHERE id = ?").get(roleId) as { position: number } | undefined;
  return r?.position ?? UNRANKED;
}
const actorRank = (s: Session) => (s.isOwner ? -1 : rolePosition(s.role?.id ?? null));
const userRank = (u: UserRow) => (isOwner(u.id) ? -1 : rolePosition(u.role_id));

class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

/** Actors may only act on people ranked strictly below them, never themselves, never the owner. */
function managedTarget(actor: Session, id: string): UserRow {
  const target = getUser(id);
  if (!target) throw new HttpError(404, "user_not_found");
  if (target.id === actor.user.id) throw new HttpError(403, "cannot_manage_self");
  if (isOwner(target.id)) throw new HttpError(403, "cannot_manage_owner");
  if (!actor.isOwner && actorRank(actor) >= userRank(target)) throw new HttpError(403, "target_outranks_you");
  return target;
}

function assignableRole(actor: Session, roleId: string) {
  if (roleId === "owner") throw new HttpError(403, "owner_not_assignable");
  const role = db.prepare("SELECT id, name, position FROM roles WHERE id = ?").get(roleId) as { id: string; name: string; position: number } | undefined;
  if (!role) throw new HttpError(404, "role_not_found");
  if (!actor.isOwner && role.position <= actorRank(actor)) throw new HttpError(403, "role_outranks_you");
  return role;
}

const ref = (u: UserRow) => ({ type: "user", id: u.id, name: u.name });

function listRoles(): Role[] {
  const rows = db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.status != 'banned') AS member_count
       FROM roles r ORDER BY r.position, r.name`,
    )
    .all() as Array<{ id: string; name: string; permissions: string; builtin: number; position: number; member_count: number }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    permissions: r.id === "owner" ? [...ALL_PERMISSIONS] : (JSON.parse(r.permissions) as Permission[]),
    builtin: r.builtin === 1,
    position: r.position,
    memberCount: r.member_count,
  }));
}

function slug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "role";
}

const permissionList = z.array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]])).max(ALL_PERMISSIONS.length);

const settingsSchema = z.object({
  lockdown: z.boolean(),
  hideVideoInMusic: z.boolean(),
  sections: z.object({ player: z.boolean(), cast: z.boolean() }),
  notify: z.object({
    channelId: z.string().regex(/^\d{15,22}$/).nullable(),
    accessRequests: z.boolean(),
    nowPlaying: z.boolean(),
    goLive: z.boolean(),
    posts: z.boolean(),
  }),
}) satisfies z.ZodType<SiteSettings>;

function diff(a: unknown, b: unknown, path = ""): Record<string, [unknown, unknown]> {
  if (typeof a === "object" && a && typeof b === "object" && b) {
    return Object.keys({ ...a, ...b }).reduce(
      (acc, k) => ({ ...acc, ...diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k) }),
      {},
    );
  }
  return a === b ? {} : { [path]: [a, b] };
}

function auditQueryFrom(q: Record<string, string | undefined>): AuditQuery {
  const num = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  return { actorId: q.actor || undefined, action: q.action || undefined, targetId: q.target || undefined, from: num(q.from), to: num(q.to), before: num(q.before), limit: num(q.limit) };
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  // Neutralise spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export async function adminRoutes(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      if (err.status === 403 && req.session) {
        audit({ actorId: req.session.user.id, action: "access.forbidden", details: { method: req.method, url: req.url, reason: err.code }, req });
      }
      return reply.code(err.status).send({ error: err.code });
    }
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid_body", issues: err.issues });
    req.log.error({ err }, "request failed");
    return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: "server_error" });
  });

  const me = (req: FastifyRequest) => req.session!;

  // ---------- site info for every active user ----------
  app.get("/api/site", { config: { anyActive: true } }, async () => {
    const s = getSettings();
    return { sections: s.sections, lockdown: s.lockdown, hideVideoInMusic: s.hideVideoInMusic };
  });

  // ---------- people ----------
  app.get("/api/admin/users", { config: { permission: "admin.people" } }, async (): Promise<AdminUser[]> => {
    const rows = db
      .prepare(
        `SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions
         FROM users u ORDER BY CASE u.status WHEN 'pending' THEN 0 ELSE 1 END, u.last_seen_at DESC NULLS LAST, u.name`,
      )
      .all(Date.now()) as Array<UserRow & { created_at: number; last_seen_at: number | null; active_sessions: number }>;
    return rows.map((u) => ({
      id: u.id, name: u.name, avatarUrl: u.avatar_url, status: u.status, statusReason: u.status_reason, roleId: u.role_id,
      createdAt: u.created_at, lastSeenAt: u.last_seen_at, activeSessions: u.active_sessions, isOwner: isOwner(u.id),
    }));
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/approve", { config: { permission: "admin.people" } }, async (req) => {
    const target = managedTarget(me(req), req.params.id);
    if (target.status !== "pending") throw new HttpError(409, "not_pending");
    const { roleId } = z.object({ roleId: z.string().default("member") }).parse(req.body ?? {});
    const role = assignableRole(me(req), roleId);
    db.prepare("UPDATE users SET status = 'active', status_reason = NULL, role_id = ? WHERE id = ?").run(role.id, target.id);
    audit({ actorId: me(req).user.id, action: "access.approved", target: ref(target), details: { role: role.name }, req });
    events.emit("session:changed", target.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/deny", { config: { permission: "admin.people" } }, async (req) => {
    const target = managedTarget(me(req), req.params.id);
    if (target.status !== "pending") throw new HttpError(409, "not_pending");
    const { reason } = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    db.prepare("UPDATE users SET status = 'banned', status_reason = ? WHERE id = ?").run(reason || "Access request denied", target.id);
    deleteUserSessions(target.id);
    audit({ actorId: me(req).user.id, action: "access.denied", target: ref(target), details: reason ? { reason } : undefined, req });
    events.emit("user:kick", target.id);
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>("/api/admin/users/:id/role", { config: { permission: "admin.people" } }, async (req) => {
    const target = managedTarget(me(req), req.params.id);
    const { roleId } = z.object({ roleId: z.string() }).parse(req.body);
    const role = assignableRole(me(req), roleId);
    if (target.role_id === role.id) return { ok: true };
    const from = target.role_id ? (db.prepare("SELECT name FROM roles WHERE id = ?").get(target.role_id) as { name: string } | undefined)?.name : null;
    db.prepare("UPDATE users SET role_id = ? WHERE id = ?").run(role.id, target.id);
    audit({ actorId: me(req).user.id, action: "user.role_changed", target: ref(target), details: { from, to: role.name }, req });
    events.emit("session:changed", target.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/status", { config: { permission: "admin.people" } }, async (req) => {
    const target = managedTarget(me(req), req.params.id);
    const { status, reason } = z
      .object({ status: z.enum(["active", "suspended", "banned"]), reason: z.string().trim().max(300).optional() })
      .parse(req.body);
    if (target.status === "pending") throw new HttpError(409, "use_approve_or_deny");
    if (target.status === status) return { ok: true };
    db.prepare("UPDATE users SET status = ?, status_reason = ?, role_id = COALESCE(role_id, 'member') WHERE id = ?").run(
      status, status === "active" ? null : reason || null, target.id,
    );
    const action = status === "active" ? "user.reinstated" : `user.${status}`;
    audit({ actorId: me(req).user.id, action, target: ref(target), details: { from: target.status, ...(reason ? { reason } : {}) }, req });
    if (status === "active") events.emit("session:changed", target.id);
    else {
      deleteUserSessions(target.id);
      events.emit("user:kick", target.id);
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/signout", { config: { permission: "admin.people" } }, async (req) => {
    const target = managedTarget(me(req), req.params.id);
    const count = deleteUserSessions(target.id);
    audit({ actorId: me(req).user.id, action: "user.signed_out", target: ref(target), details: { sessions: count }, req });
    events.emit("user:kick", target.id);
    return { ok: true, sessions: count };
  });

  app.post("/api/admin/preapprove", { config: { permission: "admin.people" } }, async (req) => {
    const { discordId, roleId } = z
      .object({ discordId: z.string().trim().regex(/^\d{15,22}$/, "Discord user ids are 15–22 digits"), roleId: z.string().default("member") })
      .parse(req.body);
    const role = assignableRole(me(req), roleId);
    const existing = getUser(discordId);
    if (existing && existing.status !== "pending") throw new HttpError(409, "already_known");
    if (existing) {
      managedTarget(me(req), discordId);
      db.prepare("UPDATE users SET status = 'active', role_id = ? WHERE id = ?").run(role.id, discordId);
      events.emit("session:changed", discordId);
    } else {
      const now = Date.now();
      db.prepare(
        `INSERT INTO users (id, name, avatar_url, created_at, updated_at, status, role_id)
         VALUES (?, ?, 'https://cdn.discordapp.com/embed/avatars/0.png', ?, ?, 'active', ?)`,
      ).run(discordId, `Discord user ${discordId}`, now, now, role.id);
    }
    audit({ actorId: me(req).user.id, action: "user.preapproved", target: { type: "user", id: discordId, name: existing?.name ?? null }, details: { role: role.name }, req });
    return { ok: true };
  });

  // ---------- roles ----------
  const canSeeRoles = (s: Session) => s.permissions.includes("admin.roles") || s.permissions.includes("admin.people");

  app.get("/api/admin/roles", { config: { anyActive: true } }, async (req) => {
    if (!canSeeRoles(me(req))) throw new HttpError(403, "missing_permission");
    return listRoles();
  });

  app.post("/api/admin/roles", { config: { permission: "admin.roles" } }, async (req) => {
    const actor = me(req);
    const body = z
      .object({ name: z.string().trim().min(1).max(32), permissions: permissionList, position: z.number().int().min(1).max(999).default(25) })
      .parse(req.body);
    if (!actor.isOwner && body.position <= actorRank(actor)) throw new HttpError(403, "role_outranks_you");
    const extra = body.permissions.filter((p) => !actor.permissions.includes(p));
    if (extra.length) throw new HttpError(403, "cannot_grant_permissions_you_lack");
    let id = slug(body.name);
    while (db.prepare("SELECT 1 FROM roles WHERE id = ?").get(id)) id = `${slug(body.name)}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      db.prepare("INSERT INTO roles (id, name, permissions, builtin, position) VALUES (?, ?, ?, 0, ?)").run(id, body.name, JSON.stringify(body.permissions), body.position);
    } catch {
      throw new HttpError(409, "role_name_taken");
    }
    audit({ actorId: actor.user.id, action: "role.created", target: { type: "role", id, name: body.name }, details: { permissions: body.permissions, position: body.position }, req });
    return { id };
  });

  app.patch<{ Params: { id: string } }>("/api/admin/roles/:id", { config: { permission: "admin.roles" } }, async (req) => {
    const actor = me(req);
    if (req.params.id === "owner") throw new HttpError(403, "owner_role_locked");
    const role = listRoles().find((r) => r.id === req.params.id);
    if (!role) throw new HttpError(404, "role_not_found");
    if (!actor.isOwner && role.position <= actorRank(actor)) throw new HttpError(403, "role_outranks_you");
    const body = z
      .object({ name: z.string().trim().min(1).max(32).optional(), permissions: permissionList.optional(), position: z.number().int().min(1).max(999).optional() })
      .parse(req.body);
    if (body.position !== undefined && !actor.isOwner && body.position <= actorRank(actor)) throw new HttpError(403, "role_outranks_you");
    const added = (body.permissions ?? []).filter((p) => !role.permissions.includes(p));
    const removed = body.permissions ? role.permissions.filter((p) => !body.permissions!.includes(p)) : [];
    if (!actor.isOwner && added.some((p) => !actor.permissions.includes(p))) throw new HttpError(403, "cannot_grant_permissions_you_lack");
    try {
      db.prepare("UPDATE roles SET name = COALESCE(?, name), permissions = COALESCE(?, permissions), position = COALESCE(?, position) WHERE id = ?").run(
        body.name ?? null, body.permissions ? JSON.stringify(body.permissions) : null, body.position ?? null, role.id,
      );
    } catch {
      throw new HttpError(409, "role_name_taken");
    }
    audit({
      actorId: actor.user.id, action: "role.updated", target: { type: "role", id: role.id, name: body.name ?? role.name },
      details: { ...(body.name && body.name !== role.name ? { renamed: [role.name, body.name] } : {}), ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}), ...(body.position !== undefined && body.position !== role.position ? { position: [role.position, body.position] } : {}) },
      req,
    });
    events.emit("session:changed", null);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/roles/:id", { config: { permission: "admin.roles" } }, async (req) => {
    const actor = me(req);
    const role = listRoles().find((r) => r.id === req.params.id);
    if (!role) throw new HttpError(404, "role_not_found");
    if (role.builtin) throw new HttpError(403, "builtin_role");
    if (!actor.isOwner && role.position <= actorRank(actor)) throw new HttpError(403, "role_outranks_you");
    db.transaction(() => {
      db.prepare("UPDATE users SET role_id = 'member' WHERE role_id = ?").run(role.id);
      db.prepare("DELETE FROM roles WHERE id = ?").run(role.id);
    })();
    audit({ actorId: actor.user.id, action: "role.deleted", target: { type: "role", id: role.id, name: role.name }, details: { reassigned: role.memberCount }, req });
    events.emit("session:changed", null);
    return { ok: true };
  });

  // ---------- audit ----------
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/admin/audit", { config: { permission: "admin.audit" } }, async (req) =>
    queryAudit({ ...auditQueryFrom(req.query), limit: Math.min(auditQueryFrom(req.query).limit ?? 100, 200) }),
  );

  app.get<{ Querystring: Record<string, string | undefined> }>("/api/admin/audit.csv", { config: { permission: "admin.audit" } }, async (req, reply) => {
    const q = { ...auditQueryFrom(req.query), limit: 5000 };
    const rows = queryAudit(q);
    audit({ actorId: me(req).user.id, action: "audit.exported", details: { rows: rows.length, filters: req.query }, req });
    const header = ["id", "time_utc", "actor_id", "actor", "action", "target_type", "target_id", "target", "details", "ip"];
    const lines = rows.map((r) =>
      [r.id, new Date(r.at).toISOString(), r.actor?.id, r.actor?.name, r.action, r.targetType, r.targetId, r.targetName, r.details, r.ip].map(csvCell).join(","),
    );
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="friends-audit-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send([header.join(","), ...lines].join("\n"));
  });

  // ---------- settings ----------
  app.get("/api/admin/settings", { config: { permission: "admin.settings" } }, async () => getSettings());

  app.put("/api/admin/settings", { config: { permission: "admin.settings" } }, async (req) => {
    const next = settingsSchema.parse(req.body);
    const prev = getSettings();
    const changes = diff(prev, next);
    if (!Object.keys(changes).length) return next;
    saveSettings(next);
    audit({ actorId: me(req).user.id, action: next.lockdown !== prev.lockdown ? (next.lockdown ? "site.lockdown_on" : "site.lockdown_off") : "settings.updated", details: { changes }, req });
    events.emit("settings:changed");
    return next;
  });

  // ---------- system ----------
  app.get("/api/admin/system", { config: { permission: "admin.settings" } }, async () => {
    const dbPath = join(env.DATA_DIR, "friends.db");
    const size = async (p: string) => (await stat(p).catch(() => null))?.size ?? 0;
    const counts = Object.fromEntries(
      (db.prepare("SELECT status, COUNT(*) AS n FROM users GROUP BY status").all() as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]),
    );
    return {
      version: env.APP_VERSION,
      node: process.version,
      startedAt,
      dbBytes: (await size(dbPath)) + (await size(`${dbPath}-wal`)),
      users: counts,
      activeSessions: (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?").get(Date.now()) as { n: number }).n,
      auditEntries: (db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n,
      auditRetentionDays: 365,
      youtube: youtubeEnabled() ? quotaUsed() : null,
    };
  });

  app.get("/api/admin/backup", { config: { permission: "admin.settings", rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const file = join(tmpdir(), `friends-backup-${Date.now()}.db`);
    await db.backup(file);
    audit({ actorId: me(req).user.id, action: "backup.downloaded", req });
    const stream = createReadStream(file);
    stream.on("close", () => void unlink(file).catch(() => {}));
    return reply
      .header("Content-Type", "application/vnd.sqlite3")
      .header("Content-Disposition", `attachment; filename="friends-${new Date().toISOString().slice(0, 10)}.db"`)
      .send(stream);
  });
}
