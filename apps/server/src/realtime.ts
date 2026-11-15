import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import type { ClientToServer, Me, PresenceEntry, Section, ServerToClient } from "@friends/shared";
import { SESSION_COOKIE, userForSession } from "./sessions.js";

const SECTIONS = new Set<Section>(["home", "music", "media", "cast", "settings"]);

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function createRealtime(http: HttpServer) {
  const io = new Server<ClientToServer, ServerToClient, Record<string, never>, { me: Me }>(http, {
    serveClient: false,
  });

  // One entry per user, however many tabs they have open.
  const presence = new Map<string, PresenceEntry & { sockets: Set<string> }>();
  const broadcast = () =>
    io.emit(
      "presence:list",
      [...presence.values()].map(({ sockets: _s, ...entry }) => entry),
    );

  io.use((socket, next) => {
    const me = userForSession(readCookie(socket.request.headers.cookie, SESSION_COOKIE));
    if (!me) return next(new Error("unauthenticated"));
    socket.data.me = me;
    next();
  });

  io.on("connection", (socket) => {
    const { me } = socket.data;
    const entry = presence.get(me.id) ?? { ...me, section: "home" as Section, since: Date.now(), sockets: new Set<string>() };
    entry.sockets.add(socket.id);
    presence.set(me.id, entry);
    broadcast();

    socket.on("presence:section", (section) => {
      if (!SECTIONS.has(section) || entry.section === section) return;
      entry.section = section;
      entry.since = Date.now();
      broadcast();
    });

    socket.on("disconnect", () => {
      entry.sockets.delete(socket.id);
      if (entry.sockets.size === 0) presence.delete(me.id);
      broadcast();
    });
  });

  return io;
}
