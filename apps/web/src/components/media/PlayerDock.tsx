import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Maximize2, Pause, Play, X } from "lucide-react";
import type { Session } from "@friends/shared";
import { can } from "../../lib/api";
import { mediaAction, useMediaState } from "../../lib/media";
import { usePlayer } from "../../lib/player";
import { SyncedPlayer } from "./SyncedPlayer";

/**
 * The one player instance. It never unmounts while something is playing, so navigating doesn't
 * reload the video. On Home it sits exactly over the slot Home registers; elsewhere it docks to a corner.
 * The YouTube player stays at least 200px tall wherever it is shown.
 */
export function PlayerDock({ session }: { session: Session }) {
  const state = useMediaState();
  const now = state?.now ?? null;
  const p = usePlayer();
  const box = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);

  // Track the slot every frame: images loading and layout shifts move it without resizing it.
  useLayoutEffect(() => {
    const slot = p.slot;
    if (!slot) return setRect(null);
    const shell = slot.closest(".shell") as HTMLElement;
    let raf = 0;
    let last = "";
    const measure = () => {
      const a = slot.getBoundingClientRect();
      const b = shell.getBoundingClientRect();
      const next = { top: a.top - b.top, left: a.left - b.left, width: a.width, height: a.height };
      // The slot's classes (inset, hidden, passive) change without moving it; re-render on those too.
      const key = `${next.top}|${next.left}|${next.width}|${next.height}|${slot.className}`;
      if (key !== last) {
        last = key;
        setRect({ ...next });
      }
      raf = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(raf);
  }, [p.slot]);

  if (!now || p.hidden.has("player")) return null;
  const docked = !p.slot;
  const mini = p.slot?.classList.contains("player-slot-mini");
  const hidden = p.slot?.classList.contains("player-slot-hidden");
  // In a stage tile, clicks belong to the tile (show large), not the embedded player.
  const passive = p.slot?.classList.contains("player-slot-passive");
  if (docked && p.dismissedFor === now.item.id) return null;

  return (
    <div ref={box} className={`${docked ? "dock dock-mini" : hidden ? "dock dock-hidden" : mini ? "dock dock-inset" : "dock"}${passive ? " dock-passive" : ""}`}
      aria-hidden={hidden || undefined} style={rect && !docked ? rect : undefined}>
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
