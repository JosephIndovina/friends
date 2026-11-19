import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env.js";

mkdirSync(env.DATA_DIR, { recursive: true });
export const db = new Database(join(env.DATA_DIR, "friends.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Append-only migrations. Never edit a shipped entry; add a new one.
const migrations: Array<string | (() => void)> = [
  `CREATE TABLE users (
     id          TEXT PRIMARY KEY,          -- Discord user id
     name        TEXT NOT NULL,             -- guild nick, else global name, else username
     avatar_url  TEXT NOT NULL,
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token_hash  TEXT PRIMARY KEY,          -- sha256 of the cookie token
     user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at  INTEGER NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);`,

  `CREATE TABLE roles (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
     permissions TEXT NOT NULL,             -- JSON array of Permission
     builtin     INTEGER NOT NULL DEFAULT 0,
     position    INTEGER NOT NULL           -- lower = more senior; owner = 0
   );
   INSERT INTO roles (id, name, permissions, builtin, position) VALUES
     ('owner', 'Owner', '[]', 1, 0),
     ('admin', 'Admin', '["music.queue","music.control","media.queue","media.control","cast.watch","cast.stream","posts.create","posts.moderate","playback.moderate","admin.people","admin.roles","admin.audit","admin.settings"]', 1, 10),
     ('moderator', 'Moderator', '["music.queue","music.control","media.queue","media.control","cast.watch","cast.stream","posts.create","posts.moderate","playback.moderate","admin.audit"]', 1, 20),
     ('member', 'Member', '["music.queue","music.control","media.queue","media.control","cast.watch","cast.stream","posts.create"]', 1, 30);

   ALTER TABLE users ADD COLUMN role_id TEXT REFERENCES roles(id) ON DELETE SET NULL;
   ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
   ALTER TABLE users ADD COLUMN status_reason TEXT;
   ALTER TABLE users ADD COLUMN last_seen_at INTEGER;

   ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE sessions ADD COLUMN ip TEXT;
   ALTER TABLE sessions ADD COLUMN user_agent TEXT;

   CREATE TABLE audit_log (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     at          INTEGER NOT NULL,
     actor_id    TEXT,                      -- null = the system
     action      TEXT NOT NULL,
     target_type TEXT,
     target_id   TEXT,
     target_name TEXT,
     details     TEXT,                      -- JSON
     ip          TEXT,
     user_agent  TEXT
   );
   CREATE INDEX audit_at ON audit_log(at);
   CREATE INDEX audit_actor ON audit_log(actor_id, at);
   CREATE INDEX audit_action ON audit_log(action, at);

   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,

  `CREATE TABLE media_queue (
     id    TEXT PRIMARY KEY,
     sort  INTEGER NOT NULL,
     data  TEXT NOT NULL                    -- JSON MediaItem
   );
   CREATE TABLE media_history (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     played_at  INTEGER NOT NULL,
     data       TEXT NOT NULL               -- JSON MediaItem
   );
   CREATE INDEX media_history_played ON media_history(played_at);`,

  // Music and Media merged into one player: media.* -> player.*, music.* dropped.
  () => {
    const rename: Record<string, string | null> = { "media.queue": "player.queue", "media.control": "player.control", "music.queue": null, "music.control": null };
    for (const r of db.prepare("SELECT id, permissions FROM roles").all() as Array<{ id: string; permissions: string }>) {
      const perms = (JSON.parse(r.permissions) as string[]).flatMap((p) => (p in rename ? (rename[p] ? [rename[p]!] : []) : [p]));
      db.prepare("UPDATE roles SET permissions = ? WHERE id = ?").run(JSON.stringify([...new Set(perms)]), r.id);
    }
  },

  `CREATE TABLE lyrics_cache (key TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at INTEGER NOT NULL);
   CREATE TABLE playlists (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL
   );
   CREATE TABLE playlist_items (
     playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
     pos         INTEGER NOT NULL,
     data        TEXT NOT NULL,             -- JSON MediaItem (id, addedBy and startAt are reset when queued)
     PRIMARY KEY (playlist_id, pos)
   );`,

  `CREATE TABLE spotify_map (
     spotify_id  TEXT PRIMARY KEY,
     youtube_id  TEXT,                      -- null = no acceptable match found
     resolved_at INTEGER NOT NULL
   );`,

  `CREATE TABLE uploads (
     id          TEXT PRIMARY KEY,
     owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     post_id     TEXT,                      -- null until attached; unattached uploads are pruned after a day
     kind        TEXT NOT NULL,             -- image | video
     mime        TEXT NOT NULL,
     ext         TEXT NOT NULL,
     bytes       INTEGER NOT NULL,
     name        TEXT,
     created_at  INTEGER NOT NULL
   );
   CREATE INDEX uploads_post ON uploads(post_id);
   CREATE TABLE posts (
     id          TEXT PRIMARY KEY,
     author_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     text        TEXT NOT NULL,
     preview     TEXT,                      -- JSON link preview for the first link
     created_at  INTEGER NOT NULL,
     deleted_at  INTEGER,
     deleted_by  TEXT
   );
   CREATE INDEX posts_created ON posts(created_at);
   CREATE TABLE post_reactions (
     post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
     user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     emoji       TEXT NOT NULL,
     PRIMARY KEY (post_id, user_id, emoji)
   );`,

  `CREATE TABLE sounds (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     emoji       TEXT,
     owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     mime        TEXT NOT NULL,
     ext         TEXT NOT NULL,
     bytes       INTEGER NOT NULL,
     duration    REAL NOT NULL,             -- seconds
     created_at  INTEGER NOT NULL
   );
   CREATE INDEX sounds_owner ON sounds(owner_id);`,

  // The soundboard: every role that can queue can also play and add sounds.
  () => {
    for (const r of db.prepare("SELECT id, permissions FROM roles WHERE id != 'owner'").all() as Array<{ id: string; permissions: string }>) {
      const perms = JSON.parse(r.permissions) as string[];
      if (!perms.includes("player.queue")) continue;
      db.prepare("UPDATE roles SET permissions = ? WHERE id = ?").run(JSON.stringify([...new Set([...perms, "sounds.play", "sounds.add"])]), r.id);
    }
  },
];

const version = db.pragma("user_version", { simple: true }) as number;
for (let i = version; i < migrations.length; i++) {
  db.transaction(() => {
    const m = migrations[i]!;
    if (typeof m === "string") db.exec(m);
    else m();
    db.pragma(`user_version = ${i + 1}`);
  })();
}
