import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { MediaItem, MediaMode } from "@friends/shared";

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
  /** stage sources this viewer has hidden (not loaded, not heard); saved on this device */
  hidden: ReadonlySet<string>;
  setHidden: (id: string, hide: boolean) => void;
  /** source this viewer picked to show large; null = the grid (or the only source) */
  focused: string | null;
  setFocused: (id: string | null) => void;
  /** this viewer's music/video view choice per track (keyed by source ref); overrides the room's default */
  viewOverrides: Readonly<Record<string, MediaMode>>;
  setViewOverride: (item: MediaItem, mode: MediaMode) => void;
}

const Ctx = createContext<PlayerCtx | null>(null);

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

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
  const [hidden, setHiddenSet] = useState<ReadonlySet<string>>(() => new Set(readJson<string[]>("stage.hidden", [])));
  // The source shown large. Not saved: each visit starts on the grid when there's more than one.
  const [focused, setFocused] = useState<string | null>(null);
  const [viewOverrides, setViewOverrides] = useState<Record<string, MediaMode>>(() => readJson<Record<string, MediaMode>>("viewModes", {}));
  const setViewOverride = useCallback((item: MediaItem, mode: MediaMode) => {
    setViewOverrides((prev) => {
      const key = `${item.kind}:${item.ref}`;
      const next = { ...prev };
      if (mode === item.mode) delete next[key];
      else next[key] = mode;
      // Keep the most recent 300 choices.
      const keys = Object.keys(next);
      for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete next[k];
      try {
        localStorage.setItem("viewModes", JSON.stringify(next));
      } catch {
        /* this visit only */
      }
      return next;
    });
  }, []);
  const setHidden = useCallback((id: string, hide: boolean) => {
    setHiddenSet((prev) => {
      const next = new Set(prev);
      if (hide) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("stage.hidden", JSON.stringify([...hidden]));
    } catch {
      /* this visit only */
    }
  }, [hidden]);
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
    () => ({ audible, setAudible, blocked, setBlocked, volume, setVolume, syncing, setSyncing, slot, setSlot, dismissedFor, setDismissedFor, hidden, setHidden, focused, setFocused, viewOverrides, setViewOverride }),
    [audible, blocked, volume, syncing, slot, dismissedFor, hidden, setHidden, focused, viewOverrides, setViewOverride],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlayer() {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePlayer outside PlayerProvider");
  return c;
}

/** The view this viewer sees for an item: their own choice if they made one, else the room's default. */
export function viewModeOf(item: MediaItem, overrides: Readonly<Record<string, MediaMode>>): MediaMode {
  return overrides[`${item.kind}:${item.ref}`] ?? item.mode;
}
