import { EventEmitter } from "node:events";
import type { Me } from "@friends/shared";

/** In-process bus so routes don't import the bot or socket layer directly. */
interface Events {
  "access:requested": [Me];
  /** role/status/permissions changed for one user (null = everyone, e.g. a role edit) */
  "session:changed": [string | null];
  /** user must be disconnected now (suspended, banned, signed out, left) */
  "user:kick": [string];
  "settings:changed": [];
  /** pending access requests changed */
  "admin:attention": [];
  /** someone else ended this user's stream: tell them who */
  "cast:ended": [{ userId: string; by: string; app: boolean }];
  "posts:changed": [{ id: string; deleted?: boolean }];
  "post:created": [string];
  /** post to the Discord notification channel; `url` is a site path */
  /** post a test message to a channel; `done` gets the error, if any */
  "notify:test": [string, (err: Error | null) => void];
  notify: [{ title: string; description?: string; url: string; buttonLabel?: string; thumbnail?: string }];
}

export const events = new EventEmitter<Events>();
