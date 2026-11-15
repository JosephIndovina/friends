import { useCallback, useEffect, useRef, useState } from "react";
import { GripVertical, ListPlus, Maximize, Pause, Play, Plus, RotateCcw, SkipForward, Trash2, Volume2, VolumeX } from "lucide-react";
import { SEEKABLE, type MediaItem, type Session } from "@friends/shared";
import { SyncedPlayer } from "../components/media/SyncedPlayer";
import { can } from "../lib/api";
import { ago } from "../lib/format";
import { useArtworkGlow } from "../lib/glow";
import { expectedPosition, fmtTime, KIND_LABEL, mediaAction, mediaError, useMediaState } from "../lib/media";

function readVolume() {
  try {
    const v = Number(localStorage.getItem("volume"));
    return Number.isFinite(v) && v > 0 ? Math.min(v, 100) : 80;
  } catch {
    return 80;
  }
}

export function Media({ session }: { session: Session }) {
  const state = useMediaState();
  const now = state?.now ?? null;
  useArtworkGlow(now?.item.thumbnail);

  const [audible, setAudible] = useState(false);
  const [volume, setVolume] = useState(readVolume);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const control = can(session, "media.control");

  useEffect(() => {
    try {
      localStorage.setItem("volume", String(volume));
    } catch {
      /* per-visit only */
    }
  }, [volume]);

  const act = useCallback(async (p: Promise<void>) => {
    setError(null);
    try {
      await p;
    } catch (e) {
      setError(mediaError(e));
    }
  }, []);

  // Clock for the progress readout.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!now?.playing) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [now?.playing]);

  const pos = now ? expectedPosition(now) : 0;
  const seekable = now ? SEEKABLE[now.item.kind] : false;

  return (
    <div className="room media-room">
      <section className="stage" aria-label="Player">
        <div className="stage-screen player-screen" ref={stageRef}>
          {now ? (
            <>
              <SyncedPlayer playback={now} audible={audible} volume={volume} onDrift={setSyncing} />
            </>
          ) : (
            <div className="stage-idle">
              <h1>Nothing playing</h1>
              <p>Add a YouTube or Twitch link to start.</p>
            </div>
          )}
        </div>

        {now && (
          <>
            <div className="transport">
              <button className="icon-btn transport-main" disabled={!control}
                aria-label={now.playing ? "Pause for everyone" : "Play for everyone"}
                onClick={() => {
                  setAudible(true);
                  void act(now.playing ? mediaAction("media:pause", { position: pos }) : mediaAction("media:play"));
                }}>
                {now.playing ? <Pause aria-hidden /> : <Play aria-hidden />}
              </button>
              <button className="icon-btn" disabled={!control} aria-label="Skip" title="Skip" onClick={() => act(mediaAction("media:skip"))}><SkipForward aria-hidden /></button>
              {seekable ? (
                <Seek position={pos} duration={now.item.duration} disabled={!control} onSeek={(s) => act(mediaAction("media:seek", { position: s }))} />
              ) : (
                <span className="live-badge">{now.item.kind === "twitch-live" ? "Live" : "Clip"}</span>
              )}
              {audible
                ? <Volume volume={volume} muted={false} onChange={setVolume} onToggle={() => setAudible(false)} />
                : <button className="btn btn-primary btn-s sound-on" onClick={() => setAudible(true)}><Volume2 aria-hidden />Turn on sound</button>}
              <button className="icon-btn" aria-label="Full screen" title="Full screen" onClick={() => stageRef.current?.requestFullscreen?.()}><Maximize aria-hidden /></button>
            </div>
            <div className="stage-info">
              <div className="now-meta">
                <strong className="now-title">{now.item.title}</strong>
                <span>
                  {[now.item.author, KIND_LABEL[now.item.kind], `started by ${now.startedBy.name}`].filter(Boolean).join(" · ")}
                  {syncing && <span className="syncing"> · Syncing</span>}
                </span>
              </div>
            </div>
          </>
        )}
      </section>

      <aside className="side">
        {error && <p className="flash flash-error" role="alert">{error}</p>}
        {can(session, "media.queue") && <AddLink onAdd={(url, playNext) => act(mediaAction("media:add", { url, playNext }))} canPlayNext={control} />}
        <Queue session={session} items={state?.queue ?? []} act={act} />
        <History items={state?.history ?? []} canReplay={can(session, "media.queue")} onReplay={(id) => act(mediaAction("media:replay", { id }))} />
      </aside>
    </div>
  );
}

function Seek({ position, duration, disabled, onSeek }: { position: number; duration: number | null; disabled: boolean; onSeek: (s: number) => void }) {
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

function Volume({ volume, muted, onChange, onToggle }: { volume: number; muted: boolean; onChange: (v: number) => void; onToggle: () => void }) {
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

function AddLink({ onAdd, canPlayNext }: { onAdd: (url: string, playNext: boolean) => Promise<void>; canPlayNext: boolean }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (playNext: boolean) => {
    if (!url.trim()) return;
    setBusy(true);
    await onAdd(url.trim(), playNext);
    setBusy(false);
    setUrl("");
  };
  return (
    <form className="add-link" onSubmit={(e) => { e.preventDefault(); void submit(false); }}>
      <label className="visually-hidden" htmlFor="add-url">YouTube or Twitch link</label>
      <input id="add-url" className="input" placeholder="Paste a YouTube or Twitch link" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" />
      <div className="add-actions">
        <button className="btn btn-primary btn-s" disabled={busy || !url.trim()}><Plus aria-hidden />Add to queue</button>
        {canPlayNext && <button type="button" className="btn btn-quiet btn-s" disabled={busy || !url.trim()} onClick={() => submit(true)}><ListPlus aria-hidden />Play next</button>}
      </div>
    </form>
  );
}

function Queue({ session, items, act }: { session: Session; items: MediaItem[]; act: (p: Promise<void>) => Promise<void> }) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const control = can(session, "media.control");
  const canRemove = (i: MediaItem) => i.addedBy.id === session.user.id ? can(session, "media.queue") : can(session, "playback.moderate");

  return (
    <div className="block">
      <div className="block-head">
        <h2>Up next {items.length > 0 && <span className="quiet">{items.length}</span>}</h2>
        {items.length > 0 && can(session, "playback.moderate") && (
          <button className="btn btn-quiet btn-s" onClick={() => window.confirm("Clear the whole queue?") && act(mediaAction("media:clear"))}>Clear</button>
        )}
      </div>
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
                <span className="queue-title" title={item.title}>{item.title}</span>
                <span className="queue-meta">{[item.duration ? fmtTime(item.duration) : KIND_LABEL[item.kind], item.addedBy.name].join(" · ")}</span>
              </span>
              <span className="queue-actions">
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

function History({ items, canReplay, onReplay }: { items: Array<MediaItem & { playedAt: number }>; canReplay: boolean; onReplay: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="block">
      <h2>Recently played</h2>
      <ol className="queue history">
        {items.slice(0, 10).map((item) => (
          <li key={item.id} className="queue-item">
            <Thumb item={item} />
            <span className="queue-text">
              <span className="queue-title" title={item.title}>{item.title}</span>
              <span className="queue-meta">{ago(item.playedAt)}</span>
            </span>
            {canReplay && <span className="queue-actions"><button className="icon-btn" aria-label={`Queue ${item.title} again`} title="Queue again" onClick={() => onReplay(item.id)}><RotateCcw aria-hidden /></button></span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Thumb({ item }: { item: MediaItem }) {
  return item.thumbnail ? <img className="thumb" src={item.thumbnail} alt="" loading="lazy" /> : <span className="thumb thumb-empty" aria-hidden>{KIND_LABEL[item.kind].slice(0, 2)}</span>;
}
