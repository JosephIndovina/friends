import { useState } from "react";
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

export function Volume({ volume, muted, onChange, onToggle }: { volume: number; muted: boolean; onChange: (v: number) => void; onToggle: () => void }) {
  return (
    <div className="volume">
      <button className="icon-btn" aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"} onClick={onToggle}>
        {muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
      </button>
      <input type="range" className="range" min={0} max={100} value={muted ? 0 : volume} aria-label="Volume"
        style={{ "--fill": `${muted ? 0 : volume}%` } as React.CSSProperties} onChange={(e) => onChange(Number(e.target.value))} />
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
