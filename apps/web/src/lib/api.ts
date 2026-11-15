import { useCallback, useEffect, useState } from "react";
import type { Permission, Session } from "@friends/shared";
import { getSocket } from "./socket";

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? "server_error");
  return data as T;
}

export type SessionState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "blocked"; reason: string }
  | { status: "ready"; session: Session };

/** The signed-in session; refetches when the server says our role, status or the site lock changed. */
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const load = useCallback(async () => {
    try {
      const session = await api<Session>("GET", "/api/me");
      setState({ status: "ready", session });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setState({ status: "signed-out" });
      else if (err instanceof ApiError && err.status === 403) setState({ status: "blocked", reason: err.code });
      else setState({ status: "signed-out" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (state.status !== "ready" || state.session.status !== "active") return;
    const s = getSocket();
    const refresh = () => void load();
    s.on("session:changed", refresh);
    // The server drops our socket when we're suspended, signed out or locked out: find out why.
    const onDisconnect = (reason: string) => reason === "io server disconnect" && refresh();
    const onError = () => refresh();
    s.on("disconnect", onDisconnect);
    s.on("connect_error", onError);
    if (s.disconnected) s.connect();
    return () => {
      s.off("session:changed", refresh);
      s.off("disconnect", onDisconnect);
      s.off("connect_error", onError);
    };
  }, [state, load]);

  // Pending users poll gently so approval lets them straight in.
  useEffect(() => {
    if (state.status !== "ready" || state.session.status !== "pending") return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [state, load]);

  return state;
}

export const can = (s: Session, p: Permission) => s.permissions.includes(p);
export const ADMIN_TABS = [
  { to: "/admin/people", label: "People", perm: "admin.people" },
  { to: "/admin/roles", label: "Roles", perm: "admin.roles" },
  { to: "/admin/audit", label: "Audit log", perm: "admin.audit" },
  { to: "/admin/settings", label: "Settings", perm: "admin.settings" },
  { to: "/admin/system", label: "System", perm: "admin.settings" },
] as const satisfies ReadonlyArray<{ to: string; label: string; perm: Permission }>;
export const isAdminish = (s: Session) => ADMIN_TABS.some((t) => can(s, t.perm));

export async function signOut() {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  window.location.assign("/");
}
