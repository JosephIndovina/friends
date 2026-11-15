import { createHash, randomBytes } from "node:crypto";
import type { Me } from "@friends/shared";
import { db } from "./db.js";

export const SESSION_COOKIE = "sid";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export function upsertUser(user: Me) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, name, avatar_url, created_at, updated_at) VALUES (@id, @name, @avatarUrl, @now, @now)
     ON CONFLICT(id) DO UPDATE SET name = @name, avatar_url = @avatarUrl, updated_at = @now`,
  ).run({ ...user, now });
}

export function createSession(userId: string): string {
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
    hash(token),
    userId,
    Date.now() + SESSION_TTL_MS,
  );
  return token;
}

export function userForSession(token: string | undefined): Me | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.avatar_url AS avatarUrl FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hash(token), Date.now()) as Me | undefined;
  return row ?? null;
}

export function deleteSession(token: string | undefined) {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
}

export function pruneSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
}
