import { useEffect, useState } from "react";
import type { Me } from "@friends/shared";

export type MeState = { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; me: Me };

export function useMe(): MeState {
  const [state, setState] = useState<MeState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/me", { credentials: "same-origin" })
      .then(async (res) => {
        if (cancelled) return;
        setState(res.ok ? { status: "signed-in", me: (await res.json()) as Me } : { status: "signed-out" });
      })
      .catch(() => !cancelled && setState({ status: "signed-out" }));
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export async function signOut() {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  window.location.assign("/");
}
