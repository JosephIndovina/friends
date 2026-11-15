import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { fileTypeFromFile } from "file-type";
import { z } from "zod";
import { REACTIONS, type LinkPreview, type Post, type PostMedia } from "@friends/shared";
import { audit } from "./audit.js";
import { db } from "./db.js";
import { env } from "./env.js";
import { events } from "./events.js";
import { firstUrl, preview } from "./linkpreview.js";

export const UPLOAD_DIR = join(env.DATA_DIR, "uploads");
const MAX_IMAGE = 15 * 1024 * 1024;
const MAX_VIDEO = 200 * 1024 * 1024;
const MAX_ATTACH = 6;
const MAX_TEXT = 2000;
const PAGE = 30;
const UNATTACHED_TTL_MS = 24 * 60 * 60 * 1000;

const ALLOWED: Record<string, { kind: "image" | "video"; ext: string }> = {
  "image/jpeg": { kind: "image", ext: "jpg" },
  "image/png": { kind: "image", ext: "png" },
  "image/gif": { kind: "image", ext: "gif" },
  "image/webp": { kind: "image", ext: "webp" },
  "image/avif": { kind: "image", ext: "avif" },
  "video/mp4": { kind: "video", ext: "mp4" },
  "video/webm": { kind: "video", ext: "webm" },
  "video/quicktime": { kind: "video", ext: "mov" },
};

interface PostRow { id: string; author_id: string; text: string; preview: string | null; created_at: number; name: string; avatar_url: string }

/** Full post objects for rows, with media and reactions, as seen by `viewerId`. */
function hydrate(rows: PostRow[], viewerId: string): Post[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const media = db.prepare(`SELECT id, post_id, kind, mime FROM uploads WHERE post_id IN (${marks}) ORDER BY created_at`).all(...ids) as Array<{ id: string; post_id: string; kind: "image" | "video"; mime: string }>;
  const reacts = db
    .prepare(`SELECT r.post_id, r.emoji, r.user_id, u.name FROM post_reactions r JOIN users u ON u.id = r.user_id WHERE r.post_id IN (${marks})`)
    .all(...ids) as Array<{ post_id: string; emoji: string; user_id: string; name: string }>;
  return rows.map((r) => {
    const byEmoji = new Map<string, { count: number; mine: boolean; names: string[] }>();
    for (const x of reacts.filter((x) => x.post_id === r.id)) {
      const e = byEmoji.get(x.emoji) ?? { count: 0, mine: false, names: [] };
      e.count++;
      e.mine ||= x.user_id === viewerId;
      e.names.push(x.name);
      byEmoji.set(x.emoji, e);
    }
    return {
      id: r.id,
      author: { id: r.author_id, name: r.name, avatarUrl: r.avatar_url },
      text: r.text,
      media: media.filter((m) => m.post_id === r.id).map((m): PostMedia => ({ id: m.id, kind: m.kind, mime: m.mime, url: `/api/uploads/${m.id}` })),
      preview: r.preview ? (JSON.parse(r.preview) as LinkPreview) : null,
      reactions: REACTIONS.filter((e) => byEmoji.has(e)).map((emoji) => ({ emoji, ...byEmoji.get(emoji)! })),
      createdAt: r.created_at,
    };
  });
}

const SELECT = `SELECT p.id, p.author_id, p.text, p.preview, p.created_at, u.name, u.avatar_url FROM posts p JOIN users u ON u.id = p.author_id`;

export function getPost(id: string, viewerId: string): Post | null {
  const row = db.prepare(`${SELECT} WHERE p.id = ? AND p.deleted_at IS NULL`).get(id) as PostRow | undefined;
  return row ? hydrate([row], viewerId)[0]! : null;
}

export async function pruneUploads() {
  const stale = db.prepare("SELECT id, ext FROM uploads WHERE post_id IS NULL AND created_at < ?").all(Date.now() - UNATTACHED_TTL_MS) as Array<{ id: string; ext: string }>;
  for (const u of stale) {
    await unlink(join(UPLOAD_DIR, `${u.id}.${u.ext}`)).catch(() => {});
    db.prepare("DELETE FROM uploads WHERE id = ?").run(u.id);
  }
}

export async function postRoutes(app: FastifyInstance) {
  await mkdir(UPLOAD_DIR, { recursive: true });
  await app.register(import("@fastify/multipart"), { limits: { fileSize: MAX_VIDEO, files: 1, fields: 0 } });
  const me = (req: FastifyRequest) => req.session!;
  const err = (status: number, code: string) => Object.assign(new Error(code), { statusCode: status });

  app.setErrorHandler((e: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (e instanceof z.ZodError) return reply.code(400).send({ error: "invalid_body" });
    if (e.code === "FST_REQ_FILE_TOO_LARGE") return reply.code(413).send({ error: "file_too_large" });
    const status = e.statusCode ?? 500;
    if (status === 403 && req.session) audit({ actorId: req.session.user.id, action: "access.forbidden", details: { method: req.method, url: req.url, reason: e.message }, req });
    if (status >= 500) req.log.error({ err: e }, "posts request failed");
    return reply.code(status).send({ error: status >= 500 ? "server_error" : e.message });
  });

  // ---------- uploads ----------
  app.post("/api/uploads", { config: { permission: "posts.create", rateLimit: { max: 30, timeWindow: "10 minutes" } } }, async (req) => {
    const file = await req.file();
    if (!file) throw err(400, "no_file");
    const id = randomUUID();
    const tmp = join(UPLOAD_DIR, `${id}.part`);
    try {
      await pipeline(file.file, createWriteStream(tmp));
      if (file.file.truncated) throw err(413, "file_too_large");
      // Trust the bytes, not the browser's claimed type.
      const type = await fileTypeFromFile(tmp);
      const allowed = type && ALLOWED[type.mime];
      if (!allowed) throw err(415, "unsupported_type");
      const bytes = file.file.bytesRead;
      if (allowed.kind === "image" && bytes > MAX_IMAGE) throw err(413, "file_too_large");
      await rename(tmp, join(UPLOAD_DIR, `${id}.${allowed.ext}`));
      db.prepare("INSERT INTO uploads (id, owner_id, post_id, kind, mime, ext, bytes, name, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)").run(
        id, me(req).user.id, allowed.kind, type.mime, allowed.ext, bytes, file.filename.slice(0, 200), Date.now(),
      );
      return { id, kind: allowed.kind, url: `/api/uploads/${id}` };
    } finally {
      await unlink(tmp).catch(() => {});
    }
  });

  app.get<{ Params: { id: string } }>("/api/uploads/:id", { config: { anyActive: true } }, async (req, reply) => {
    const u = db.prepare("SELECT id, ext, mime, owner_id, post_id FROM uploads WHERE id = ?").get(req.params.id) as { id: string; ext: string; mime: string; owner_id: string; post_id: string | null } | undefined;
    // Unattached uploads are only visible to their owner (the composer preview).
    if (!u || (!u.post_id && u.owner_id !== me(req).user.id)) throw err(404, "not_found");
    if (u.post_id) {
      const live = db.prepare("SELECT 1 FROM posts WHERE id = ? AND deleted_at IS NULL").get(u.post_id);
      if (!live) throw err(404, "not_found");
    }
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
    return reply.type(u.mime).sendFile(`${u.id}.${u.ext}`, UPLOAD_DIR);
  });

  // ---------- posts ----------
  app.get<{ Querystring: { before?: string } }>("/api/posts", { config: { anyActive: true } }, async (req) => {
    const before = Number(req.query.before) || Date.now() + 1;
    const rows = db.prepare(`${SELECT} WHERE p.deleted_at IS NULL AND p.created_at < ? ORDER BY p.created_at DESC LIMIT ?`).all(before, PAGE) as PostRow[];
    return { posts: hydrate(rows, me(req).user.id), more: rows.length === PAGE };
  });

  app.get<{ Params: { id: string } }>("/api/posts/:id", { config: { anyActive: true } }, async (req) => {
    const p = getPost(req.params.id, me(req).user.id);
    if (!p) throw err(404, "not_found");
    return p;
  });

  app.post("/api/posts", { config: { permission: "posts.create", rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const body = z.object({ text: z.string().max(MAX_TEXT).default(""), uploadIds: z.array(z.string().uuid()).max(MAX_ATTACH).default([]) }).parse(req.body);
    const text = body.text.trim();
    if (!text && !body.uploadIds.length) throw err(400, "empty_post");
    const uid = me(req).user.id;
    for (const id of body.uploadIds) {
      const u = db.prepare("SELECT owner_id, post_id FROM uploads WHERE id = ?").get(id) as { owner_id: string; post_id: string | null } | undefined;
      if (!u || u.owner_id !== uid || u.post_id) throw err(400, "invalid_upload");
    }
    const id = randomUUID();
    db.transaction(() => {
      db.prepare("INSERT INTO posts (id, author_id, text, created_at) VALUES (?, ?, ?, ?)").run(id, uid, text, Date.now());
      for (const u of body.uploadIds) db.prepare("UPDATE uploads SET post_id = ? WHERE id = ?").run(id, u);
    })();
    audit({ actorId: uid, action: "post.created", target: { type: "post", id, name: text.slice(0, 80) || null }, details: { attachments: body.uploadIds.length }, req });
    events.emit("posts:changed", { id });
    events.emit("post:created", id);
    // The preview arrives a moment later; clients refetch the post when it does.
    const url = firstUrl(text);
    if (url) {
      void preview(url).then((pv) => {
        if (!pv) return;
        db.prepare("UPDATE posts SET preview = ? WHERE id = ?").run(JSON.stringify(pv), id);
        events.emit("posts:changed", { id });
      });
    }
    return getPost(id, uid);
  });

  app.delete<{ Params: { id: string } }>("/api/posts/:id", { config: { permission: "posts.create" } }, async (req) => {
    const s = me(req);
    const p = db.prepare("SELECT author_id, text FROM posts WHERE id = ? AND deleted_at IS NULL").get(req.params.id) as { author_id: string; text: string } | undefined;
    if (!p) throw err(404, "not_found");
    if (p.author_id !== s.user.id && !s.permissions.includes("posts.moderate")) throw err(403, "not_yours");
    db.prepare("UPDATE posts SET deleted_at = ?, deleted_by = ? WHERE id = ?").run(Date.now(), s.user.id, req.params.id);
    // Files go; the row stays (soft delete) so the audit trail still makes sense.
    const files = db.prepare("SELECT id, ext FROM uploads WHERE post_id = ?").all(req.params.id) as Array<{ id: string; ext: string }>;
    for (const f of files) await unlink(join(UPLOAD_DIR, `${f.id}.${f.ext}`)).catch(() => {});
    db.prepare("DELETE FROM uploads WHERE post_id = ?").run(req.params.id);
    const author = (db.prepare("SELECT name FROM users WHERE id = ?").get(p.author_id) as { name: string } | undefined)?.name;
    audit({ actorId: s.user.id, action: "post.deleted", target: { type: "post", id: req.params.id, name: p.text.slice(0, 80) || null }, details: { author, moderated: p.author_id !== s.user.id }, req });
    events.emit("posts:changed", { id: req.params.id, deleted: true });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/posts/:id/react", { config: { permission: "posts.create", rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const { emoji } = z.object({ emoji: z.enum(REACTIONS) }).parse(req.body);
    const uid = me(req).user.id;
    if (!db.prepare("SELECT 1 FROM posts WHERE id = ? AND deleted_at IS NULL").get(req.params.id)) throw err(404, "not_found");
    const had = db.prepare("DELETE FROM post_reactions WHERE post_id = ? AND user_id = ? AND emoji = ?").run(req.params.id, uid, emoji).changes;
    if (!had) db.prepare("INSERT INTO post_reactions (post_id, user_id, emoji) VALUES (?, ?, ?)").run(req.params.id, uid, emoji);
    events.emit("posts:changed", { id: req.params.id });
    return getPost(req.params.id, uid);
  });
}
