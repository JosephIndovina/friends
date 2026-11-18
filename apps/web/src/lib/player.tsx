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
  setSlot: React.Dispatch<React.SetStateAction<HTMLElement | null>>;
  /** Home's stage is on screen: screens only load while it is */
  stageOpen: boolean;
  setStageOpen: (v: boolean) => void;
  /** element each screen should cover, by screen (item) id */
  screenSlots: Readonly<Record<string, HTMLElement>>;
  setScreenSlot: (id: string, el: HTMLElement | null, gone?: HTMLElement) => void;
  /** screens this viewer turned the sound on for; screens start muted */
  screenSound: ReadonlySet<string>;
  setScreenSound: (id: string, on: boolean) => void;
  /** each screen's own volume for this viewer; a screen without one uses the player's */
  screenVolume: Readonly<Record<string, number>>;
  setScreenVolume: (id: string, v: number) => void;
  /** viewer closed the docked mini player for this item */
  dismissedFor: string | null;
  setDismissedFor: (id: string | null) => void;
  /** shared media this viewer hid (not loaded, not heard): "player" or a screen id; this visit only. Streams use the cast's watching set. */
  hidden: ReadonlySet<string>;
  setHidden: (id: string, hide: boolean) => void;
  /** sources this viewer focused: shown large, with the rest in the strip below; empty = the grid */
  focused: ReadonlySet<string>;
  setFocused: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  /** this viewer's music/video view choice per track (keyed by source ref); overrides the room's default */
  viewOverrides: Readonly<Record<string, MediaMode>>;
  setViewOverride: (item: MediaItem, mode: MediaMode) => void;
  clearViewOverrides: () => void;
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
  const [stageOpen, setStageOpen] = useState(false);
  const [screenSlots, setScreenSlots] = useState<Record<string, HTMLElement>>({});
  // `gone`: that element left the page. Only it is cleared, so a slot that moved (the old element leaving after the
  // new one arrived) isn't lost, and a removed element is never kept.
  const setScreenSlot = useCallback((id: string, el: HTMLElement | null, gone?: HTMLElement) => {
    setScreenSlots((prev) => {
      if (gone) {
        if (prev[id] !== gone) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      if ((prev[id] ?? null) === el) return prev;
      const next = { ...prev };
      if (el) next[id] = el;
      else delete next[id];
      return next;
    });
  }, []);
  const [screenSound, setScreenSoundSet] = useState<ReadonlySet<string>>(new Set());
  const setScreenSound = useCallback((id: string, on: boolean) => {
    setScreenSoundSet((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const [screenVolume, setScreenVolumes] = useState<Record<string, number>>({});
  const setScreenVolume = useCallback((id: string, v: number) => setScreenVolumes((prev) => ({ ...prev, [id]: v })), []);
  const [hidden, setHiddenSet] = useState<ReadonlySet<string>>(new Set());
  // The sources shown large. Not saved: each visit starts on the grid when there's more than one.
  const [focused, setFocused] = useState<ReadonlySet<string>>(new Set());
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
  const clearViewOverrides = useCallback(() => {
    setViewOverrides({});
    try {
      localStorage.removeItem("viewModes");
    } catch {
      /* this visit only */
    }
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
    // Earlier versions saved hidden and removed sources; hiding now lasts for the visit, like Discord's Stop Watching.
    try {
      localStorage.removeItem("stage.hidden");
      localStorage.removeItem("stage.removed");
    } catch {
      /* nothing saved */
    }
  }, []);
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
    () => ({
      audible, setAudible, blocked, setBlocked, volume, setVolume, syncing, setSyncing, slot, setSlot, stageOpen, setStageOpen, screenSlots, setScreenSlot,
      screenSound, setScreenSound, screenVolume, setScreenVolume, dismissedFor, setDismissedFor, hidden, setHidden, focused, setFocused, viewOverrides, setViewOverride, clearViewOverrides,
    }),
    [audible, blocked, volume, syncing, slot, stageOpen, screenSlots, setScreenSlot, screenSound, setScreenSound, screenVolume, setScreenVolume, dismissedFor, hidden, setHidden, focused, viewOverrides, setViewOverride, clearViewOverrides],
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
