import { createHash, randomBytes } from "node:crypto";
import { ALL_PERMISSIONS, type Me, type Permission, type Session, type UserStatus } from "@friends/shared";
import { db } from "./db.js";
import { env } from "./env.js";

export const SESSION_COOKIE = "sid";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export interface UserRow {
  id: string;
  name: string;
  avatar_url: string;
  role_id: string | null;
  status: UserStatus;
  status_reason: string | null;
}

export const isOwner = (id: string) => id === env.OWNER_DISCORD_ID;

export function getUser(id: string): UserRow | undefined {
  return db.prepare("SELECT id, name, avatar_url, role_id, status, status_reason FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

/** Inserts new users as pending. Never touches role or status of existing users (except the owner). */
export function upsertUser(user: Me): UserRow {
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, name, avatar_url, created_at, updated_at, status) VALUES (@id, @name, @avatarUrl, @now, @now, 'pending')
     ON CONFLICT(id) DO UPDATE SET name = @name, avatar_url = @avatarUrl, updated_at = @now`,
  ).run({ ...user, now });
  if (isOwner(user.id)) ensureOwner();
  return getUser(user.id)!;
}

export function ensureOwner() {
  db.prepare("UPDATE users SET role_id = 'owner', status = 'active', status_reason = NULL WHERE id = ?").run(env.OWNER_DISCORD_ID);
  // Nobody else may hold the owner role.
  db.prepare("UPDATE users SET role_id = 'admin' WHERE role_id = 'owner' AND id != ?").run(env.OWNER_DISCORD_ID);
}

export function rolePermissions(roleId: string | null): Permission[] {
  if (!roleId) return [];
  if (roleId === "owner") return [...ALL_PERMISSIONS];
  const row = db.prepare("SELECT permissions FROM roles WHERE id = ?").get(roleId) as { permissions: string } | undefined;
  return row ? (JSON.parse(row.permissions) as Permission[]).filter((p) => ALL_PERMISSIONS.includes(p)) : [];
}

export function sessionFor(row: UserRow): Session {
  const owner = isOwner(row.id);
  const role = row.role_id
    ? ((db.prepare("SELECT id, name FROM roles WHERE id = ?").get(row.role_id) as { id: string; name: string } | undefined) ?? null)
    : null;
  return {
    user: { id: row.id, name: row.name, avatarUrl: row.avatar_url },
    status: row.status,
    role,
    permissions: owner ? [...ALL_PERMISSIONS] : row.status === "active" ? rolePermissions(row.role_id) : [],
    isOwner: owner,
  };
}

export function createSession(userId: string, meta: { ip: string; userAgent: string }): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)").run(
    hash(token),
    userId,
    now + SESSION_TTL_MS,
    now,
    meta.ip,
    meta.userAgent.slice(0, 300),
  );
  return token;
}

const touch = db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)");

/** Resolves a cookie token to a fresh session (role and status read from the DB on every call). */
export function sessionForToken(token: string | undefined): Session | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.avatar_url, u.role_id, u.status, u.status_reason FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hash(token), Date.now()) as UserRow | undefined;
  if (!row) return null;
  const now = Date.now();
  touch.run(now, row.id, now - 60_000);
  return sessionFor(row);
}

export function deleteSession(token: string | undefined) {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
}

export function deleteUserSessions(userId: string): number {
  return db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes;
}

export function pruneSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
}
