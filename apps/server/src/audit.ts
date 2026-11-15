import type { FastifyRequest } from "fastify";
import type { AuditEntry } from "@friends/shared";
import { db } from "./db.js";

export const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

interface AuditInput {
  actorId: string | null;
  action: string;
  target?: { type: string; id: string; name?: string | null };
  details?: Record<string, unknown>;
  req?: Pick<FastifyRequest, "ip" | "headers">;
}

const insert = db.prepare(
  `INSERT INTO audit_log (at, actor_id, action, target_type, target_id, target_name, details, ip, user_agent)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

/** Append-only. Nothing in the app updates or deletes rows except retention pruning. */
export function audit({ actorId, action, target, details, req }: AuditInput) {
  insert.run(
    Date.now(),
    actorId,
    action,
    target?.type ?? null,
    target?.id ?? null,
    target?.name ?? null,
    details ? JSON.stringify(details) : null,
    req ? clientIp(req) : null,
    req ? String(req.headers["user-agent"] ?? "").slice(0, 300) || null : null,
  );
}

export function clientIp(req: Pick<FastifyRequest, "ip" | "headers">): string {
  // Behind the Cloudflare tunnel the real client is in cf-connecting-ip.
  const cf = req.headers["cf-connecting-ip"];
  return (Array.isArray(cf) ? cf[0] : cf) ?? req.ip;
}

export interface AuditQuery {
  actorId?: string;
  action?: string;
  targetId?: string;
  from?: number;
  to?: number;
  before?: number;
  limit?: number;
}

export function queryAudit(q: AuditQuery): AuditEntry[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.actorId) (where.push("a.actor_id = ?"), args.push(q.actorId));
  if (q.action) (where.push("a.action LIKE ?"), args.push(`${q.action}%`));
  if (q.targetId) (where.push("a.target_id = ?"), args.push(q.targetId));
  if (q.from) (where.push("a.at >= ?"), args.push(q.from));
  if (q.to) (where.push("a.at <= ?"), args.push(q.to));
  if (q.before) (where.push("a.id < ?"), args.push(q.before));
  const rows = db
    .prepare(
      `SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.id DESC LIMIT ?`,
    )
    .all(...args, Math.min(q.limit ?? 100, 5000)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    at: r.at as number,
    actor: r.actor_id ? { id: r.actor_id as string, name: (r.actor_name as string) ?? (r.actor_id as string) } : null,
    action: r.action as string,
    targetType: (r.target_type as string) ?? null,
    targetId: (r.target_id as string) ?? null,
    targetName: (r.target_name as string) ?? null,
    details: r.details ? (JSON.parse(r.details as string) as Record<string, unknown>) : null,
    ip: (r.ip as string) ?? null,
  }));
}

export function pruneAudit() {
  db.prepare("DELETE FROM audit_log WHERE at < ?").run(Date.now() - AUDIT_RETENTION_MS);
}
