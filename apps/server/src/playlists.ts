import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { MediaItem, Playlist, PlaylistSummary, Session } from "@friends/shared";
import { audit } from "./audit.js";
import { db } from "./db.js";
import { getLyrics } from "./lyrics.js";
import { MediaActionError, mediaRoom } from "./media.js";
import { getSettings } from "./settings.js";

const MAX_ITEMS = 500;

interface Row { id: string; name: string; owner_id: string; owner_name: string; updated_at: number; count: number; cover: string | null }

function summaries(where = "", ...args: unknown[]): PlaylistSummary[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.owner_id, u.name AS owner_name, p.updated_at,
         (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS count,
         (SELECT json_extract(i.data, '$.thumbnail') FROM playlist_items i WHERE i.playlist_id = p.id ORDER BY pos LIMIT 1) AS cover
       FROM playlists p JOIN users u ON u.id = p.owner_id ${where} ORDER BY p.updated_at DESC`,
    )
    .all(...args) as Row[];
  return rows.map((r) => ({ id: r.id, name: r.name, owner: { id: r.owner_id, name: r.owner_name }, count: r.count, updatedAt: r.updated_at, cover: r.cover }));
}

function load(id: string): Playlist | null {
  const [s] = summaries("WHERE p.id = ?", id);
  if (!s) return null;
  const items = (db.prepare("SELECT data FROM playlist_items WHERE playlist_id = ? ORDER BY pos").all(id) as Array<{ data: string }>).map((r) => JSON.parse(r.data) as MediaItem);
  return { ...s, items };
}

function writeItems(id: string, items: MediaItem[]) {
  db.transaction(() => {
    db.prepare("DELETE FROM playlist_items WHERE playlist_id = ?").run(id);
    const ins = db.prepare("INSERT INTO playlist_items (playlist_id, pos, data) VALUES (?, ?, ?)");
    items.slice(0, MAX_ITEMS).forEach((item, i) => ins.run(id, i, JSON.stringify(item)));
    db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  })();
}

const canEdit = (s: Session, p: PlaylistSummary) => p.owner.id === s.user.id || s.permissions.includes("playback.moderate");

export async function playlistRoutes(app: FastifyInstance) {
  const me = (req: FastifyRequest) => req.session!;
  const get = (id: string) => {
    const p = load(id);
    if (!p) throw Object.assign(new Error("not_found"), { statusCode: 404 });
    return p;
  };
  const deny = (code: string, status = 403) => Object.assign(new Error(code), { statusCode: status });

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid_body" });
    if (err instanceof MediaActionError) return reply.code(409).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status === 403 && req.session) audit({ actorId: req.session.user.id, action: "access.forbidden", details: { method: req.method, url: req.url, reason: err.message }, req });
    if (status >= 500) req.log.error({ err }, "playlist request failed");
    return reply.code(status).send({ error: status >= 500 ? "server_error" : err.message });
  });

  // ---------- lyrics for anything the room knows about ----------
  app.get<{ Querystring: { id?: string } }>("/api/player/lyrics", { config: { anyActive: true } }, async (req, reply) => {
    const item = req.query.id ? mediaRoom().findItem(req.query.id) : null;
    if (!item) return reply.code(404).send({ error: "not_found" });
    if (item.kind !== "youtube") return { lines: null, plain: null, instrumental: false, artist: "", track: item.title };
    try {
      return await getLyrics(item.title, item.author, item.duration);
    } catch {
      return reply.code(502).send({ error: "lyrics_unavailable" });
    }
  });

  // ---------- saved playlists ----------
  app.get("/api/playlists", { config: { anyActive: true } }, async () => summaries());
  app.get<{ Params: { id: string } }>("/api/playlists/:id", { config: { anyActive: true } }, async (req) => get(req.params.id));

  app.post("/api/playlists", { config: { permission: "player.queue" } }, async (req) => {
    const body = z.object({ name: z.string().trim().min(1).max(60), fromQueue: z.boolean().default(false) }).parse(req.body);
    const id = randomUUID();
    const now = Date.now();
    db.prepare("INSERT INTO playlists (id, name, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, body.name, me(req).user.id, now, now);
    let count = 0;
    if (body.fromQueue) {
      const state = mediaRoom().snapshot();
      const items = [...(state.now ? [state.now.item] : []), ...state.queue];
      writeItems(id, items);
      count = items.length;
    }
    audit({ actorId: me(req).user.id, action: "playlist.created", target: { type: "playlist", id, name: body.name }, details: { items: count } });
    return { id };
  });

  app.patch<{ Params: { id: string } }>("/api/playlists/:id", { config: { permission: "player.queue" } }, async (req) => {
    const p = get(req.params.id);
    if (!canEdit(me(req), p)) throw deny("not_yours");
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    db.prepare("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?").run(name, Date.now(), p.id);
    audit({ actorId: me(req).user.id, action: "playlist.renamed", target: { type: "playlist", id: p.id, name }, details: { from: p.name } });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/playlists/:id", { config: { permission: "player.queue" } }, async (req) => {
    const p = get(req.params.id);
    if (!canEdit(me(req), p)) throw deny("not_yours");
    db.prepare("DELETE FROM playlists WHERE id = ?").run(p.id);
    audit({ actorId: me(req).user.id, action: "playlist.deleted", target: { type: "playlist", id: p.id, name: p.name }, details: { items: p.count, owner: p.owner.name } });
    return { ok: true };
  });

  // Anyone who can queue can add to any playlist: they're the group's playlists.
  app.post<{ Params: { id: string } }>("/api/playlists/:id/items", { config: { permission: "player.queue" } }, async (req) => {
    const p = get(req.params.id);
    const { itemId } = z.object({ itemId: z.string() }).parse(req.body);
    const item = mediaRoom().findItem(itemId);
    if (!item) throw deny("item_not_found", 404);
    if (p.items.length >= MAX_ITEMS) throw deny("playlist_full", 409);
    if (p.items.some((i) => i.kind === item.kind && i.ref === item.ref)) throw deny("already_in_playlist", 409);
    writeItems(p.id, [...p.items, { ...item, addedBy: { id: me(req).user.id, name: me(req).user.name } }]);
    audit({ actorId: me(req).user.id, action: "playlist.item_added", target: { type: "playlist", id: p.id, name: p.name }, details: { title: item.title } });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; pos: string } }>("/api/playlists/:id/items/:pos", { config: { permission: "player.queue" } }, async (req) => {
    const p = get(req.params.id);
    const pos = Number(req.params.pos);
    const item = p.items[pos];
    if (!item) throw deny("item_not_found", 404);
    if (!canEdit(me(req), p) && item.addedBy.id !== me(req).user.id) throw deny("not_yours");
    writeItems(p.id, p.items.filter((_, i) => i !== pos));
    audit({ actorId: me(req).user.id, action: "playlist.item_removed", target: { type: "playlist", id: p.id, name: p.name }, details: { title: item.title } });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/playlists/:id/play", { config: { permission: "player.queue" } }, async (req) => {
    if (!getSettings().sections.player) throw deny("section_disabled");
    const p = get(req.params.id);
    const { shuffle, playNext } = z.object({ shuffle: z.boolean().default(false), playNext: z.boolean().default(false) }).parse(req.body ?? {});
    if (playNext && !me(req).permissions.includes("player.control")) throw deny("missing_permission");
    const items = [...p.items];
    if (shuffle) for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    const n = await mediaRoom().enqueue(items, { id: me(req).user.id, name: me(req).user.name }, { playNext });
    audit({ actorId: me(req).user.id, action: "playlist.queued", target: { type: "playlist", id: p.id, name: p.name }, details: { items: n, shuffle, playNext } });
    return { ok: true, queued: n };
  });
}
