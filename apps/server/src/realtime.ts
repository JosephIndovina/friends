import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type { Activity, ClientToServer, PresenceEntry, Section, ServerToClient, Session } from "@friends/shared";
import { gate } from "./access.js";
import { events } from "./events.js";
import { createMediaRoom } from "./media.js";
import { SESSION_COOKIE, sessionForToken } from "./sessions.js";

const SECTIONS = new Set<Section>(["home", "cast", "settings", "admin"]);
const ACTIVITIES = new Set<Activity>(["watching", "listening", "casting", "idle"]);

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

type Data = { session: Session; token: string };
type IO = Server<ClientToServer, ServerToClient, Record<string, never>, Data>;

export function createRealtime(http: HttpServer) {
  const io: IO = new Server(http, { serveClient: false });

  // One entry per user, however many tabs they have open.
  const presence = new Map<string, PresenceEntry & { sockets: Set<string>; tabs?: Map<string, Activity> }>();
  const broadcast = () =>
    io.emit("presence:list", [...presence.values()].map(({ sockets: _s, tabs: _t, ...entry }) => entry));

  io.use((socket, next) => {
    const token = readCookie(socket.request.headers.cookie, SESSION_COOKIE) ?? "";
    const session = sessionForToken(token);
    const blocked = gate(session);
    if (blocked) return next(new Error(blocked));
    socket.data = { session: session!, token };
    next();
  });

  /** Re-resolve a socket's session from the DB; disconnect it if it may no longer be here. */
  function recheck(socket: Socket<ClientToServer, ServerToClient, Record<string, never>, Data>) {
    const fresh = sessionForToken(socket.data.token);
    if (gate(fresh)) {
      socket.disconnect(true);
      return;
    }
    socket.data.session = fresh!;
  }

  events.on("user:kick", (userId) => {
    io.in(`user:${userId}`).disconnectSockets(true);
  });
  events.on("session:changed", async (userId) => {
    const sockets = userId ? await io.in(`user:${userId}`).fetchSockets() : await io.fetchSockets();
    for (const remote of sockets) {
      const socket = io.sockets.sockets.get(remote.id);
      if (!socket) continue;
      recheck(socket);
      if (socket.connected) socket.emit("session:changed");
    }
  });
  events.on("settings:changed", async () => {
    for (const socket of io.sockets.sockets.values()) recheck(socket);
  });

  const media = createMediaRoom(io);

  io.on("connection", (socket) => {
    const me = socket.data.session.user;
    socket.on("time:ping", (ack) => typeof ack === "function" && ack(Date.now()));
    media.attach(socket);
    void socket.join(`user:${me.id}`);
    const entry = presence.get(me.id) ?? { ...me, section: "home" as Section, activity: "idle" as Activity, since: Date.now(), sockets: new Set<string>() };
    // Activity is per tab; the person shows the "loudest" one across their tabs.
    const tabActivity = new Map<string, Activity>();
    entry.sockets.add(socket.id);
    presence.set(me.id, entry);
    broadcast();

    socket.on("presence:section", (section) => {
      if (!SECTIONS.has(section) || entry.section === section) return;
      entry.section = section;
      entry.since = Date.now();
      broadcast();
    });

    socket.on("presence:activity", (activity) => {
      if (!ACTIVITIES.has(activity)) return;
      (entry as typeof entry & { tabs?: Map<string, Activity> }).tabs ??= tabActivity;
      const tabs = (entry as typeof entry & { tabs: Map<string, Activity> }).tabs;
      tabs.set(socket.id, activity);
      const rank: Activity[] = ["casting", "watching", "listening", "idle"];
      const top = rank.find((a) => [...tabs.values()].includes(a)) ?? "idle";
      if (top !== entry.activity) {
        entry.activity = top;
        broadcast();
      }
    });

    socket.on("disconnect", () => {
      (entry as typeof entry & { tabs?: Map<string, Activity> }).tabs?.delete(socket.id);
      entry.sockets.delete(socket.id);
      if (entry.sockets.size === 0) presence.delete(me.id);
      broadcast();
    });
  });

  return io;
}
