import { useLayoutEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Maximize2, Pause, Play, X } from "lucide-react";
import type { MediaKind, Playback, Session } from "@friends/shared";
import { can } from "../../lib/api";
import { mediaAction, useMediaState } from "../../lib/media";
import { usePlayer } from "../../lib/player";
import { SyncedPlayer } from "./SyncedPlayer";

type Rect = { top: number; left: number; width: number; height: number };

/** Where `slot` sits inside the shell, tracked every frame: images loading and layout shifts move it without resizing it. */
function useSlotRect(slot: HTMLElement | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    if (!slot) return setRect(null);
    let raf = 0;
    let last = "";
    const measure = () => {
      raf = requestAnimationFrame(measure);
      // A slot that has just left the page (it's about to be replaced) has nothing to follow.
      const shell = slot.closest(".shell");
      if (!shell) return;
      const a = slot.getBoundingClientRect();
      const b = shell.getBoundingClientRect();
      const next = { top: a.top - b.top, left: a.left - b.left, width: a.width, height: a.height };
      // The slot's classes (inset, hidden, passive) change without moving it; re-render on those too.
      const key = `${next.top}|${next.left}|${next.width}|${next.height}|${slot.className}`;
      if (key !== last) {
        last = key;
        setRect({ ...next });
      }
    };
    measure();
    return () => cancelAnimationFrame(raf);
  }, [slot]);
  return rect;
}

const slotClass = (slot: HTMLElement | null, docked: string, kind: MediaKind) => {
  if (!slot) return docked;
  const c = slot.classList;
  // In a stage tile, clicks belong to the tile (show large), not the embedded player.
  const base = c.contains("player-slot-hidden") ? "dock dock-hidden" : c.contains("player-slot-mini") ? "dock dock-inset" : "dock";
  // Twitch pauses its player whenever anything is drawn over it, even a transparent click layer or a name label:
  // its players sit above everything on the stage and let clicks through to the tile underneath.
  return `${base}${c.contains("player-slot-passive") ? " dock-passive" : ""}${kind.startsWith("twitch") ? " dock-uncovered" : ""}`;
};

/**
 * The player instances. They never unmount while something is playing, so navigating or changing the
 * stage layout doesn't reload a video. Each sits exactly over the slot Home registers for it.
 * Away from Home the shared player docks to a corner; screens are unloaded until you come back.
 * The YouTube player stays at least 200px tall wherever it is shown.
 */
export function PlayerDock({ session }: { session: Session }) {
  const state = useMediaState();
  const p = usePlayer();
  return (
    <>
      <MainPlayer session={session} />
      {p.stageOpen && state?.screens.filter((sc) => !p.hidden.has(sc.item.id)).map((sc) => (
        <ScreenPlayer key={sc.item.id} playback={sc} slot={p.screenSlots[sc.item.id] ?? null} />
      ))}
    </>
  );
}

function ScreenPlayer({ playback, slot }: { playback: Playback; slot: HTMLElement | null }) {
  const p = usePlayer();
  const rect = useSlotRect(slot);
  // Between layouts the slot is briefly gone: keep the player loaded, out of sight.
  return (
    <div className={slotClass(slot, "dock dock-hidden", playback.item.kind)} aria-hidden={!slot || undefined} style={rect ?? undefined}>
      <div className="dock-video">
        <SyncedPlayer playback={playback} audible={Boolean(slot) && p.screenSound.has(playback.item.id) && !p.blocked} volume={p.screenVolume[playback.item.id] ?? p.volume}
          onBlocked={() => p.setBlocked(true)} />
      </div>
    </div>
  );
}

function MainPlayer({ session }: { session: Session }) {
  const state = useMediaState();
  const now = state?.now ?? null;
  const p = usePlayer();
  const rect = useSlotRect(p.slot);

  if (!now || p.hidden.has("player")) return null;
  const docked = !p.slot;
  const hidden = p.slot?.classList.contains("player-slot-hidden");
  if (docked && p.dismissedFor === now.item.id) return null;

  return (
    <div className={slotClass(p.slot, "dock dock-mini", now.item.kind)} aria-hidden={hidden || undefined} style={rect && !docked ? rect : undefined}>
      <div className="dock-video">
        <SyncedPlayer playback={now} audible={p.audible && !p.blocked} volume={p.volume} onDrift={p.setSyncing} onBlocked={() => p.setBlocked(true)} />
      </div>
      {docked && (
        <div className="dock-bar">
          <span className="dock-title" title={now.item.title}>{now.item.title}</span>
          {can(session, "player.control") && (
            <button className="icon-btn" aria-label={now.playing ? "Pause for everyone" : "Play for everyone"}
              onClick={() => void (now.playing ? mediaAction("media:pause", { position: 0 }) : mediaAction("media:play")).catch(() => {})}>
              {now.playing ? <Pause aria-hidden /> : <Play aria-hidden />}
            </button>
          )}
          <Link to="/" className="icon-btn" aria-label="Open player" title="Open player"><Maximize2 aria-hidden /></Link>
          <button className="icon-btn" aria-label="Close player" title="Close (mutes for you)"
            onClick={() => { p.setAudible(false); p.setDismissedFor(now.item.id); }}><X aria-hidden /></button>
        </div>
      )}
    </div>
  );
}
