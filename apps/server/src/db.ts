import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env.js";

mkdirSync(env.DATA_DIR, { recursive: true });
export const db = new Database(join(env.DATA_DIR, "friends.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Append-only migrations. Never edit a shipped entry; add a new one.
const migrations: string[] = [
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
];

const version = db.pragma("user_version", { simple: true }) as number;
for (let i = version; i < migrations.length; i++) {
  db.transaction(() => {
    db.exec(migrations[i]!);
    db.pragma(`user_version = ${i + 1}`);
  })();
}
