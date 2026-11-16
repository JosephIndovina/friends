import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GripVertical, Music2, Play, RotateCcw, Trash2, Volume2, VolumeX } from "lucide-react";
import type { MediaItem, Session } from "@friends/shared";
import { can } from "../../lib/api";
import { ago } from "../../lib/format";
import { fmtTime, KIND_LABEL, mediaAction } from "../../lib/media";
import { SaveToPlaylist } from "../music/Playlists";

export function Seek({ position, duration, disabled, onSeek }: { position: number; duration: number | null; disabled: boolean; onSeek: (s: number) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const value = drag ?? position;
  return (
    <div className="seek">
      <span className="time">{fmtTime(value)}</span>
      <input type="range" className="range" min={0} max={duration ?? Math.max(position, 1)} step={1} value={value}
        disabled={disabled || !duration} aria-label="Seek" aria-valuetext={`${fmtTime(value)} of ${fmtTime(duration)}`}
        style={{ "--fill": `${duration ? (value / duration) * 100 : 0}%` } as React.CSSProperties}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => { if (drag != null) { onSeek(drag); setDrag(null); } }}
        onKeyUp={(e) => { if (drag != null && e.key.startsWith("Arrow")) { onSeek(drag); setDrag(null); } }} />
      <span className="time">{fmtTime(duration)}</span>
    </div>
  );
}

/**
 * One source's sound: the speaker mutes it, and hovering it (or focusing it, or tapping it on touch) shows its volume slider.
 * The slider sits in a small popover fixed to the window (in the shell, so it shows in full screen too), so the rail's
 * scrolling list and a tile's edges can't clip it.
 * `align` lines its edge up with the button's: "end" keeps it over the rail rather than the stage, "center" suits a tile.
 */
export function VolumeHover({ label, volume, muted, setVolume, setMuted, align = "center", className }: {
  label: string;
  volume: number;
  muted: boolean;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  align?: "center" | "end";
  className?: string;
}) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touch = useRef(false);
  const W = 200;
  const H = 44;
  const open = () => {
    if (closing.current) clearTimeout(closing.current);
    closing.current = null;
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const left = align === "end" ? r.right - W : r.left + r.width / 2 - W / 2;
    const above = r.top - H - 6 >= 8;
    setAt({ top: above ? r.top - H - 6 : r.bottom + 6, left: Math.max(8, Math.min(left, window.innerWidth - W - 8)) });
  };
  const close = (soon = true) => {
    if (closing.current) clearTimeout(closing.current);
    if (!soon) return setAt(null);
    closing.current = setTimeout(() => setAt(null), 200);
  };
  useEffect(() => () => void (closing.current && clearTimeout(closing.current)), []);
  // Opened by a tap: a tap anywhere else, scrolling or Escape closes it.
  useEffect(() => {
    if (!at) return;
    const away = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        btn.current?.focus();
      } else if (e.type === "pointerdown" && (wrap.current?.contains(e.target as Node) || pop.current?.contains(e.target as Node))) return;
      close(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", away);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", away);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, [at]); // eslint-disable-line react-hooks/exhaustive-deps

  const v = muted ? 0 : volume;
  const mute = (
    <>{muted || volume === 0 ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}</>
  );
  return (
    <span ref={wrap} className={`vol${className ? ` ${className}` : ""}`}
      onPointerEnter={(e) => e.pointerType === "mouse" && open()}
      onPointerLeave={(e) => e.pointerType === "mouse" && close()}
      onBlur={(e) => !wrap.current?.contains(e.relatedTarget as Node) && !pop.current?.contains(e.relatedTarget as Node) && close(false)}>
      <button ref={btn} className="icon-btn" aria-label={muted ? `Unmute ${label}` : `Mute ${label}`} aria-expanded={Boolean(at)}
        onPointerDown={(e) => (touch.current = e.pointerType !== "mouse")}
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && open()}
        onClick={() => {
          // Touch has no hover: a tap opens the slider, which has its own mute.
          if (touch.current) return at ? close(false) : open();
          setMuted(!muted);
        }}>{mute}</button>
      {at && createPortal(
        <span ref={pop} className="vol-pop" role="group" aria-label={`${label} volume`} style={{ top: at.top, left: at.left, width: W, height: H }}
          onPointerEnter={() => closing.current && clearTimeout(closing.current)}
          onPointerLeave={(e) => e.pointerType === "mouse" && close()}
          onBlur={(e) => !wrap.current?.contains(e.relatedTarget as Node) && !pop.current?.contains(e.relatedTarget as Node) && close(false)}>
          <button className="icon-btn" aria-label={muted ? `Unmute ${label}` : `Mute ${label}`} onClick={() => setMuted(!muted)}>{mute}</button>
          <input type="range" className="range" min={0} max={100} value={v} aria-label={`${label} volume`}
            style={{ "--fill": `${v}%` } as React.CSSProperties} onChange={(e) => setVolume(Number(e.target.value))} />
          <span className="vol-value">{v}</span>
        </span>,
        btn.current?.closest(".shell") ?? document.body,
      )}
    </span>
  );
}

/** One source's sound in the volume panel. */
export interface MixerChannel {
  id: string;
  label: string;
  volume: number;
  muted: boolean;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
}

/**
 * The stage's volume: one button, and a slider for each source you can hear in a panel above it.
 * Hovering opens the panel; clicking keeps it open (and is how touch screens open it) until you click away or press Escape.
 */
export function Mixer({ channels }: { channels: MixerChannel[] }) {
  const [pinned, setPinned] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pinned) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key !== "Escape" : box.current?.contains(e.target as Node)) return;
      setPinned(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [pinned]);
  if (!channels.length) return null;
  const allMuted = channels.every((c) => c.muted || c.volume === 0);
  return (
    <div ref={box} className={`mixer${pinned ? " is-open" : ""}`}>
      <button className="icon-btn" aria-label="Volume" aria-expanded={pinned} onClick={() => setPinned(!pinned)}>
        {allMuted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
      </button>
      <div className="mixer-panel" role="group" aria-label="Volume">
        <ul className="mixer-list">
          {channels.map((c) => {
            const v = c.muted ? 0 : c.volume;
            return (
              <li key={c.id} className="mixer-row">
                <button className="icon-btn" aria-label={c.muted ? `Unmute ${c.label}` : `Mute ${c.label}`} title={c.muted ? "Unmute" : "Mute"}
                  onClick={() => c.setMuted(!c.muted)}>{c.muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}</button>
                <span className="mixer-label" title={c.label}>{c.label}</span>
                <input type="range" className="range" min={0} max={100} value={v} aria-label={`${c.label} volume`}
                  style={{ "--fill": `${v}%` } as React.CSSProperties} onChange={(e) => c.setVolume(Number(e.target.value))} />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export function Queue({ session, items, act }: { session: Session; items: MediaItem[]; act: (p: Promise<void>) => Promise<void> }) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const control = can(session, "player.control");
  const canRemove = (i: MediaItem) => i.addedBy.id === session.user.id ? can(session, "player.queue") : can(session, "playback.moderate");

  return (
    <div className="block">
      {items.length > 0 && can(session, "playback.moderate") && (
        <div className="block-head">
          {clearing ? (
            <>
              <span>Clear the whole queue?</span>
              <span className="add-actions">
                <button className="btn btn-danger btn-s" autoFocus onClick={() => { setClearing(false); void act(mediaAction("media:clear")); }}>Clear</button>
                <button className="btn btn-quiet btn-s" onClick={() => setClearing(false)}>Cancel</button>
              </span>
            </>
          ) : (
            <>
              <span />
              <button className="btn btn-quiet btn-s" onClick={() => setClearing(true)}>Clear</button>
            </>
          )}
        </div>
      )}
      {items.length === 0 ? <p className="block-note">The queue is empty.</p> : (
        <ol className="queue">
          {items.map((item, i) => (
            <li key={item.id} className={`queue-item${dragId === item.id ? " is-dragging" : ""}${overIndex === i && dragId !== item.id ? " is-over" : ""}`}
              draggable={control}
              onDragStart={(e) => { setDragId(item.id); e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverIndex(i); } }}
              onDragEnd={() => { setDragId(null); setOverIndex(null); }}
              onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== item.id) void act(mediaAction("media:move", { id: dragId, to: i })); setDragId(null); setOverIndex(null); }}>
              {control && (
                <button className="grip" aria-label={`Move ${item.title}. Use arrow keys.`}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp" && i > 0) { e.preventDefault(); void act(mediaAction("media:move", { id: item.id, to: i - 1 })); }
                    if (e.key === "ArrowDown" && i < items.length - 1) { e.preventDefault(); void act(mediaAction("media:move", { id: item.id, to: i + 1 })); }
                  }}><GripVertical aria-hidden /></button>
              )}
              <Thumb item={item} />
              <span className="queue-text">
                <span className="queue-title" title={item.title}>{item.mode === "music" && <Music2 className="mode-icon" aria-label="Music" />}{item.title}</span>
                <span className="queue-meta">{[item.duration ? fmtTime(item.duration) : KIND_LABEL[item.kind], item.addedBy.name].join(" · ")}</span>
              </span>
              <span className="queue-actions">
                {can(session, "player.queue") && <SaveToPlaylist itemId={item.id} label={item.title} />}
                {control && <button className="icon-btn" aria-label={`Play ${item.title} now`} title="Play now" onClick={() => act(mediaAction("media:playNow", { id: item.id }))}><Play aria-hidden /></button>}
                {canRemove(item) && <button className="icon-btn danger" aria-label={`Remove ${item.title}`} title="Remove" onClick={() => act(mediaAction("media:remove", { id: item.id }))}><Trash2 aria-hidden /></button>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function History({ items, canReplay, onReplay }: { items: Array<MediaItem & { playedAt: number }>; canReplay: boolean; onReplay: (id: string) => void }) {
  if (!items.length) return <p className="block-note">Nothing played yet.</p>;
  return (
    <div className="block">
      <ol className="queue history">
        {items.map((item) => (
          <li key={item.id} className="queue-item">
            <Thumb item={item} />
            <span className="queue-text">
              <span className="queue-title" title={item.title}>{item.title}</span>
              <span className="queue-meta">{ago(item.playedAt)}</span>
            </span>
            {canReplay && (
              <span className="queue-actions">
                <SaveToPlaylist itemId={item.id} label={item.title} />
                <button className="icon-btn" aria-label={`Queue ${item.title} again`} title="Queue again" onClick={() => onReplay(item.id)}><RotateCcw aria-hidden /></button>
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Thumb({ item }: { item: MediaItem }) {
  return item.thumbnail ? <img className="thumb" src={item.thumbnail} alt="" loading="lazy" /> : <span className="thumb thumb-empty" aria-hidden>{KIND_LABEL[item.kind].slice(0, 2)}</span>;
}
