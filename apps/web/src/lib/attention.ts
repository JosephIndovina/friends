import { useEffect, useState } from "react";
import type { AdminUser, Session } from "@friends/shared";
import { api, can } from "./api";
import { getSocket } from "./socket";

let cached = 0;
const listeners = new Set<(n: number) => void>();

async function refresh() {
  try {
    const users = await api<AdminUser[]>("GET", "/api/admin/users");
    cached = users.filter((u) => u.status === "pending").length;
    for (const l of listeners) l(cached);
  } catch {
    /* keep the last count */
  }
}

const onPing = () => void refresh();

/** Pending access requests, for people who can approve them. Live: the server pings admins when it changes. */
export function usePendingCount(session: Session): number {
  const allowed = can(session, "admin.people");
  const [count, setCount] = useState(cached);
  useEffect(() => {
    if (!allowed) return;
    listeners.add(setCount);
    if (listeners.size === 1) {
      getSocket().on("admin:attention", onPing);
      void refresh();
    } else setCount(cached);
    return () => {
      listeners.delete(setCount);
      if (!listeners.size) getSocket().off("admin:attention", onPing);
    };
  }, [allowed]);
  return allowed ? count : 0;
}

/** Call after approving or denying from this tab so badges update without waiting for the server. */
export const refreshPendingCount = () => void refresh();
