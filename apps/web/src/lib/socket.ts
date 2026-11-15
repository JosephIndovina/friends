import { io, type Socket } from "socket.io-client";
import type { ClientToServer, ServerToClient } from "@friends/shared";

let socket: Socket<ServerToClient, ClientToServer> | null = null;

export function getSocket() {
  socket ??= io({ withCredentials: true, transports: ["websocket"], autoConnect: false });
  return socket;
}
