import { useCallback, useEffect, useState } from "react";
import { Maximize, Pause, Play, Square, SkipForward, Volume2, VolumeX } from "lucide-react";
import { SEEKABLE, type Session } from "@friends/shared";
import { AddBox } from "../components/media/AddBox";
import { Feed } from "../components/posts/Feed";
import { SourceStrip, SourcesMenu, type StageSource } from "../components/stage/Sources";
import { GoLive } from "../components/stage/GoLive";
import { StreamVideo, useCast } from "../lib/cast";
import { LyricsView } from "../components/music/LyricsView";
import { PlaylistsPanel, SaveToPlaylist } from "../components/music/Playlists";
import { PRESETS, Visualizer, type Preset } from "../components/music/Visualizer";
import { History, ModeToggle, Queue, Seek, Volume } from "../components/media/parts";
import { can } from "../lib/api";
import { useArtworkGlow } from "../lib/glow";
import { expectedPosition, KIND_LABEL, mediaAction, mediaError, useMediaState } from "../lib/media";
import { usePlayer, viewModeOf } from "../lib/player";
import { useSite } from "../lib/site";

type MusicView = "art" | "viz" | "lyrics";
function usePref<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) || fallback;
    } catch {
      return fallback;
    }
  });
  return [v, (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      /* this visit only */
    }
  }];
}

export function Home({ session }: { session: Session }) {
  const [musicView, setMusicView] = usePref<MusicView>("musicView", "viz");
  const [preset, setPreset] = usePref<Preset>("vizPreset2", "alchemy");
  const [tab, setTab] = usePref<"queue" | "recent" | "playlists">("sideTab", "queue");
  const state = useMediaState();
  const now = state?.now ?? null;
  const p = usePlayer();
  useArtworkGlow(now?.item.thumbnail);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<HTMLDivElement | null>(null);
  const control = can(session, "player.control");
  const music = now ? viewModeOf(now.item, p.viewOverrides) === "music" : false;
  const site = useSite();
  const hideVideo = music && Boolean(site?.hideVideoInMusic);

  const act = useCallback(async (pr: Promise<void>) => {
    setError(null);
    try {
      await pr;
    } catch (e) {
      setError(mediaError(e));
    }
  }, []);

  // Progress readout ticks while playing.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!now?.playing) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [now?.playing]);

  // Hand the persistent player our slot while we're mounted.
  const slotRef = useCallback((el: HTMLDivElement | null) => p.setSlot(el), [p.setSlot]);
  useEffect(() => () => p.setSlot(null), [p.setSlot]);
  useEffect(() => {
    if (now) p.setDismissedFor(null);
  }, [now?.item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = now ? expectedPosition(now) : 0;

  // Stage sources: the shared player plus everyone's live streams.
  const cast = useCast();
  const sources: StageSource[] = [
    ...(now ? [{ id: "player", label: "Player", detail: now.item.title, thumbnail: now.item.thumbnail, audible: p.audible, setAudible: p.setAudible }] : []),
    ...cast.streams.map((st) => ({
      id: st.id,
      label: st.local ? `${st.label} (you)` : st.label,
      detail: st.mode ? `Live · ${st.mode}` : "Live",
      thumbnail: st.avatarUrl,
      audible: st.local ? false : !cast.muted.has(st.id),
      setAudible: (v: boolean) => cast.setMuted(st.id, !v),
    })),
  ];
  const visible = sources.filter((x) => !p.hidden.has(x.id));
  const focusId = visible.some((x) => x.id === p.focused) ? p.focused : (visible[0]?.id ?? null);
  const playerFocused = focusId === "player";
  const focusedStream = cast.streams.find((st) => st.id === focusId) ?? null;
  const canStopOthers = can(session, "playback.moderate");

  return (
    <>
      <div className="room media-room">
        <section className="stage" aria-label="Stage">
          <div className="stage-tools">
            {cast.streams.length > 0 && <span className="live-count"><span className="live-dot" aria-hidden />{cast.streams.length} live</span>}
            <GoLive />
            <SourcesMenu sources={sources} hidden={p.hidden} setHidden={p.setHidden} />
          </div>
          <div ref={setScreen} className={`stage-screen player-screen${music && playerFocused ? " is-music" : ""}`}>
            {sources.length === 0 && (
              <div className="stage-idle">
                <h1>Nothing playing</h1>
                <p>Search YouTube, or paste a YouTube, Spotify or Twitch link. Or go live and share your screen.</p>
              </div>
            )}
            {sources.length > 0 && !focusId && (
              <div className="stage-idle">
                <h1>All sources hidden</h1>
                <SourcesMenu sources={sources} hidden={p.hidden} setHidden={p.setHidden} />
              </div>
            )}
            {now && playerFocused && music && (
              <div className={`music-view mv-${musicView}`}>
                {now.item.thumbnail && <img className="music-backdrop" src={now.item.thumbnail} alt="" />}
                {musicView === "viz" && <Visualizer playback={now} preset={preset} />}
                {musicView !== "viz" && now.item.thumbnail && <img className="music-art" src={now.item.thumbnail} alt="" />}
                <div className="music-text">
                  <h1 className="music-title">{now.item.title}</h1>
                  {now.item.author && <p className="music-artist">{now.item.author.replace(/ - Topic$/, "")}</p>}
                </div>
                {musicView === "lyrics" && <div className="lyrics-col"><LyricsView playback={now} /></div>}
                <div className="music-controls">
                  {musicView === "viz" && (
                    <select className="select select-s" aria-label="Visualizer preset" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
                      {PRESETS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                    </select>
                  )}
                  <div className="segmented segmented-s" role="radiogroup" aria-label="Music view">
                    {([["viz", "Visualizer"], ["lyrics", "Lyrics"], ["art", "Artwork"]] as const).map(([v, label]) => (
                      <label key={v}>
                        <input type="radio" name="music-view" checked={musicView === v} onChange={() => setMusicView(v)} />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {focusedStream && <StreamVideo stream={focusedStream} className="stream-main" />}
            {now && playerFocused && <div ref={slotRef} className={hideVideo ? "player-slot player-slot-mini player-slot-hidden" : music ? "player-slot player-slot-mini" : "player-slot"} />}
          </div>

          {now && playerFocused && (
            <>
              <div className="transport">
                <button className="icon-btn transport-main" disabled={!control}
                  aria-label={now.playing ? "Pause for everyone" : "Play for everyone"}
                  onClick={() => {
                    void act(now.playing ? mediaAction("media:pause", { position: pos }) : mediaAction("media:play"));
                  }}>
                  {now.playing ? <Pause aria-hidden /> : <Play aria-hidden />}
                </button>
                <button className="icon-btn" disabled={!control} aria-label="Skip" title="Skip" onClick={() => act(mediaAction("media:skip"))}><SkipForward aria-hidden /></button>
                {SEEKABLE[now.item.kind] ? (
                  <Seek position={pos} duration={now.item.duration} disabled={!control} onSeek={(s) => act(mediaAction("media:seek", { position: s }))} />
                ) : (
                  <span className="live-badge">{now.item.kind === "twitch-live" ? "Live" : "Clip"}</span>
                )}
                {p.blocked && p.audible
                  ? <button className="btn btn-primary btn-s sound-on" onClick={() => p.setBlocked(false)}><Volume2 aria-hidden /><span className="sound-label">Click anywhere for sound</span></button>
                  : <Volume volume={p.volume} muted={!p.audible} onChange={(v) => { p.setVolume(v); p.setAudible(v > 0); }} onToggle={() => p.setAudible(!p.audible)} />}
                <button className="icon-btn" aria-label="Full screen" title="Full screen" onClick={() => screen?.requestFullscreen?.()}><Maximize aria-hidden /></button>
              </div>
              <div className="stage-info">
                <div className="now-meta">
                  {!music && <strong className="now-title">{now.item.title}</strong>}
                  <span>
                    {[now.item.author, KIND_LABEL[now.item.kind], `started by ${now.startedBy.name}`].filter(Boolean).join(" · ")}
                    {p.syncing && <span className="syncing"> · Syncing</span>}
                  </span>
                </div>
                <div className="info-actions">
                  {now.item.kind === "youtube" && <ModeToggle item={now.item} mode={music ? "music" : "video"} onChange={p.setViewOverride} />}
                  {can(session, "player.queue") && <SaveToPlaylist itemId={now.item.id} label={now.item.title} />}
                </div>
              </div>
            </>
          )}
          {focusedStream && (
            <div className="stage-info stream-info">
              <div className="now-meta">
                <strong className="now-title">{focusedStream.local ? `${focusedStream.label} (you)` : focusedStream.label}</strong>
                <span><span className="live-dot" aria-hidden />Live{focusedStream.mode ? ` · ${focusedStream.mode}` : ""}</span>
              </div>
              <div className="info-actions">
                {!focusedStream.local && (
                  <>
                    <button className="icon-btn" aria-label={cast.muted.has(focusedStream.id) ? "Unmute stream" : "Mute stream"} onClick={() => cast.setMuted(focusedStream.id, !cast.muted.has(focusedStream.id))}>
                      {cast.muted.has(focusedStream.id) ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
                    </button>
                    <input type="range" className="range stream-volume" min={0} max={100} aria-label="Stream volume" value={cast.volume[focusedStream.id] ?? 100}
                      style={{ "--fill": `${cast.volume[focusedStream.id] ?? 100}%` } as React.CSSProperties}
                      onChange={(e) => cast.setVolume(focusedStream.id, Number(e.target.value))} />
                  </>
                )}
                <button className="icon-btn" aria-label="Full screen" title="Full screen" onClick={() => screen?.requestFullscreen?.()}><Maximize aria-hidden /></button>
                {(focusedStream.local || canStopOthers) && (
                  <button className="btn btn-quiet btn-s" onClick={() => { if (focusedStream.local || window.confirm(`End ${focusedStream.label}'s stream?`)) void cast.stop(focusedStream.id); }}>
                    <Square aria-hidden />{focusedStream.local ? "Stop" : "End stream"}
                  </button>
                )}
              </div>
            </div>
          )}

          <SourceStrip
            sources={visible.filter((x) => x.id !== focusId)}
            onFocus={p.setFocused}
            renderTile={(x) => {
              if (x.id === "player") return <div ref={slotRef} className="player-slot" />;
              const st = cast.streams.find((c) => c.id === x.id);
              return st ? <StreamVideo stream={st} className="stream-thumb" /> : null;
            }}
          />
        </section>

        <aside className="side">
          {error && <p className="flash flash-error" role="alert">{error}</p>}
          {can(session, "player.queue") && (
            <AddBox canPlayNext={control} onAdd={async (input) => {
              setError(null);
              try {
                await mediaAction("media:add", input);
                return true;
              } catch (e) {
                setError(mediaError(e));
                return false;
              }
            }} />
          )}
          <div className="side-tabs" role="tablist" aria-label="Queue, recent and playlists">
            {([["queue", `Up next${state?.queue.length ? ` ${state.queue.length}` : ""}`], ["recent", "Recent"], ["playlists", "Playlists"]] as const).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className="side-tab" onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
          {tab === "queue" && <Queue session={session} items={state?.queue ?? []} act={act} />}
          {tab === "recent" && <History items={state?.history ?? []} canReplay={can(session, "player.queue")} onReplay={(id) => act(mediaAction("media:replay", { id }))} />}
          {tab === "playlists" && <PlaylistsPanel session={session} queueCount={(state?.queue.length ?? 0) + (now ? 1 : 0)} />}
        </aside>
      </div>

      <Feed session={session} />
    </>
  );
}
