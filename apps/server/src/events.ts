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
}

export const events = new EventEmitter<Events>();
