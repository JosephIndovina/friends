import { createContext, useContext, useEffect, useMemo, useState } from "react";

/** Viewer-local player preferences shared by the dock, Home and the transport. */
interface PlayerCtx {
  audible: boolean;
  setAudible: (v: boolean) => void;
  volume: number;
  setVolume: (v: number) => void;
  syncing: boolean;
  setSyncing: (v: boolean) => void;
  /** element the player should cover; null = dock it */
  slot: HTMLElement | null;
  setSlot: (el: HTMLElement | null) => void;
  /** viewer closed the docked mini player for this item */
  dismissedFor: string | null;
  setDismissedFor: (id: string | null) => void;
}

const Ctx = createContext<PlayerCtx | null>(null);

function readVolume() {
  try {
    const v = Number(localStorage.getItem("volume"));
    return Number.isFinite(v) && v > 0 ? Math.min(v, 100) : 80;
  } catch {
    return 80;
  }
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [audible, setAudible] = useState(false);
  const [volume, setVolume] = useState(readVolume);
  const [syncing, setSyncing] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem("volume", String(volume));
    } catch {
      /* this visit only */
    }
  }, [volume]);
  const value = useMemo(
    () => ({ audible, setAudible, volume, setVolume, syncing, setSyncing, slot, setSlot, dismissedFor, setDismissedFor }),
    [audible, volume, syncing, slot, dismissedFor],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlayer() {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePlayer outside PlayerProvider");
  return c;
}
