import { createContext, useContext, useEffect, useMemo, useState } from "react";

/** Viewer-local player preferences shared by the dock, Home and the transport. */
interface PlayerCtx {
  /** sound on for this viewer (their choice; remembered on this device) */
  audible: boolean;
  setAudible: (v: boolean) => void;
  /** the browser refused unmuted playback until the viewer interacts with the page */
  blocked: boolean;
  setBlocked: (v: boolean) => void;
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

function readMuted() {
  try {
    return localStorage.getItem("muted") === "1";
  } catch {
    return false;
  }
}

function readVolume() {
  try {
    const v = Number(localStorage.getItem("volume"));
    return Number.isFinite(v) && v > 0 ? Math.min(v, 100) : 80;
  } catch {
    return 80;
  }
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [audible, setAudible] = useState(() => !readMuted());
  const [blocked, setBlocked] = useState(false);
  const [volume, setVolume] = useState(readVolume);
  const [syncing, setSyncing] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem("volume", String(volume));
      localStorage.setItem("muted", audible ? "0" : "1");
    } catch {
      /* this visit only */
    }
  }, [volume, audible]);

  // After an autoplay block, the first click or key press anywhere unlocks sound.
  useEffect(() => {
    if (!blocked) return;
    const unlock = () => setBlocked(false);
    document.addEventListener("pointerdown", unlock, { once: true, capture: true });
    document.addEventListener("keydown", unlock, { once: true, capture: true });
    return () => {
      document.removeEventListener("pointerdown", unlock, { capture: true });
      document.removeEventListener("keydown", unlock, { capture: true });
    };
  }, [blocked]);
  const value = useMemo(
    () => ({ audible, setAudible, blocked, setBlocked, volume, setVolume, syncing, setSyncing, slot, setSlot, dismissedFor, setDismissedFor }),
    [audible, blocked, volume, syncing, slot, dismissedFor],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlayer() {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePlayer outside PlayerProvider");
  return c;
}
