import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize, Minimize, RectangleHorizontal, Pause, Play, Square, SkipForward, Volume2, VolumeX, X } from "lucide-react";
import { SCREENS_MAX, SEEKABLE, type Playback, type Session } from "@friends/shared";
import { AddBox } from "../components/media/AddBox";
import { Feed } from "../components/posts/Feed";
import { fitGrid, StageRail, StageTile, type StageSource } from "../components/stage/Sources";
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
const GRID_PAD = 12;
const GRID_GAP = 12;
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
  const [theatrePref, setTheatrePref] = usePref<"on" | "off">("theatre", "off");
  const [railOpen, setRailOpen] = usePref<"on" | "off">("railOpen2", "on");
  const [tab, setTab] = usePref<"queue" | "recent" | "playlists">("sideTab", "queue");
  const state = useMediaState();
  const now = state?.now ?? null;
  const p = usePlayer();
  useArtworkGlow(now?.item.thumbnail);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<HTMLDivElement | null>(null);
  const [full, setFull] = useState(false);
  const control = can(session, "player.control");
  const music = now ? viewModeOf(now.item, p.viewOverrides) === "music" : false;
  const site = useSite();
  const hideVideo = music && Boolean(site?.hideVideoInMusic);

  // The shared player lives in the shell (so it never reloads), not inside the stage. Full screen
  // therefore takes the whole shell and pins the stage over it; the player follows its slot there.
  useEffect(() => {
    const sync = () => setFull(Boolean(document.fullscreenElement) && document.fullscreenElement === screen?.closest(".shell"));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [screen]);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void (screen?.closest(".shell") as HTMLElement | null)?.requestFullscreen?.().catch(() => {});
  };

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
  // Screens only load while the stage is on screen.
  useEffect(() => {
    p.setStageOpen(true);
    return () => p.setStageOpen(false);
  }, [p.setStageOpen]);
  // One stable ref callback per screen, so re-renders don't detach and re-attach its slot.
  const screenRefs = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const screenRef = (id: string) => {
    let fn = screenRefs.current.get(id);
    if (!fn) {
      fn = (el) => p.setScreenSlot(id, el);
      screenRefs.current.set(id, fn);
    }
    return fn;
  };
  useEffect(() => {
    if (now) p.setDismissedFor(null);
  }, [now?.item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = now ? expectedPosition(now) : 0;

  // Stage sources: the shared player plus everyone's live streams.
  const cast = useCast();
  // Your own shares get one name everywhere (source row, tile, Stop), numbered when there are several.
  const mineIds = cast.streams.filter((st) => st.mine).map((st) => st.id);
  const ownName = (id: string) => (mineIds.length > 1 ? `Your screen ${mineIds.indexOf(id) + 1}` : "Your screen");
  const screens = state?.screens ?? [];
  const canClose = (sc: Playback) => sc.startedBy.id === session.user.id || control;
  const closeScreen = (sc: Playback) => void act(mediaAction("media:screen:close", { id: sc.item.id }));
  const sources: StageSource[] = [
    ...(now ? [{ id: "player", label: "Player", detail: now.item.title, thumbnail: now.item.thumbnail, audible: p.audible, setAudible: p.setAudible }] : []),
    ...screens.map((sc) => ({
      id: sc.item.id,
      live: sc.item.kind === "twitch-live",
      label: sc.item.author ?? sc.item.title,
      detail: sc.item.kind === "twitch-live" ? `Live · ${sc.item.title}` : sc.item.title,
      thumbnail: sc.item.thumbnail,
      audible: p.screenSound.has(sc.item.id),
      setAudible: (v: boolean) => p.setScreenSound(sc.item.id, v),
      onClose: canClose(sc) ? () => closeScreen(sc) : undefined,
    })),
    ...cast.streams.map((st) => ({
      id: st.id,
      live: true,
      local: st.mine,
      label: st.mine ? ownName(st.id) : st.label,
      detail: st.mode ? `Live · ${st.mode}` : "Live",
      thumbnail: st.avatarUrl,
      audible: st.mine ? false : !cast.muted.has(st.id),
      setAudible: (v: boolean) => cast.setMuted(st.id, !v),
    })),
  ];
  const visible = sources.filter((x) => !p.hidden.has(x.id));
  // One visible source shows on its own. Two or more show as a grid, unless you picked one to show large.
  const picked = visible.length > 1 && visible.some((x) => x.id === p.focused) ? p.focused : null;
  const layout: "idle" | "single" | "focus" | "grid" = visible.length === 0 ? "idle" : visible.length === 1 ? "single" : picked ? "focus" : "grid";
  const focusId = layout === "single" ? visible[0]!.id : picked;
  const playerFocused = focusId === "player";
  const playerOnStage = layout === "grid" ? visible.some((x) => x.id === "player") : playerFocused;
  const focusedStream = cast.streams.find((st) => st.id === focusId) ?? null;
  const focusedScreen = screens.find((sc) => sc.item.id === focusId) ?? null;
  const canStopOthers = can(session, "playback.moderate");
  const hide = (id: string) => {
    p.setHidden(id, true);
    if (p.focused === id) p.setFocused(null);
  };

  // Theatre turns itself on while someone else is streaming to your stage, and back off when they stop.
  // Toggling it during a stream only lasts until the streams end; otherwise it's your saved setting.
  const othersLive = cast.streams.some((st) => !st.mine && !p.hidden.has(st.id));
  const [theatreOverride, setTheatreOverride] = useState<"on" | "off" | null>(null);
  useEffect(() => {
    if (!othersLive) setTheatreOverride(null);
  }, [othersLive]);
  const theatre = othersLive ? theatreOverride ?? "on" : theatrePref;
  const toggleTheatre = () => {
    const next = theatre === "on" ? "off" : "on";
    if (othersLive) setTheatreOverride(next);
    else setTheatrePref(next);
  };
  const own = cast.streams.filter((st) => st.mine).map((st) => ({ id: st.id, label: ownName(st.id), detail: st.mode ?? "Live", preview: <StreamVideo stream={st} className="rail-preview-video" /> }));
  const showRail = sources.length > 0 || (cast.canStream && cast.supported);

  // Grid sizing: tiles as large as the stage allows (the window height in theatre and full screen).
  const [box, setBox] = useState({ w: 0, h: typeof window === "undefined" ? 800 : window.innerHeight });
  useEffect(() => {
    if (!screen) return;
    const measure = () => setBox({ w: screen.clientWidth - 2 * GRID_PAD, h: window.innerHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(screen);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [screen]);
  const gridH = full ? box.h - 2 * GRID_PAD : theatre === "on" ? Math.max(320, box.h - 250) : (box.w * 9) / 16;
  let grid = fitGrid(visible.length, box.w, gridH, GRID_GAP);
  // YouTube's player must stay at least 200px tall wherever it's visible.
  const youtubeInGrid = (playerOnStage && !hideVideo && now?.item.kind === "youtube") || screens.some((sc) => sc.item.kind === "youtube" && !p.hidden.has(sc.item.id));
  if (layout === "grid" && youtubeInGrid && grid.h < 200 && box.w >= 600) {
    const cols = Math.max(1, Math.floor((box.w + GRID_GAP) / (356 + GRID_GAP)));
    const w = Math.floor((box.w - GRID_GAP * (cols - 1)) / cols);
    grid = { cols, w, h: Math.floor((w * 9) / 16) };
  }

  const tileMedia = (x: StageSource) => {
    if (x.id === "player" && now) {
      return (
        <>
          {music && now.item.thumbnail && <img className="tile-art" src={now.item.thumbnail} alt="" />}
          {music && <span className="tile-music"><strong>{now.item.title}</strong>{now.item.author && <span>{now.item.author.replace(/ - Topic$/, "")}</span>}</span>}
          <div ref={slotRef} className={`player-slot player-slot-passive${hideVideo ? " player-slot-hidden" : ""}`} />
        </>
      );
    }
    if (screens.some((sc) => sc.item.id === x.id)) return <div ref={screenRef(x.id)} className="player-slot player-slot-passive" />;
    const st = cast.streams.find((c) => c.id === x.id);
    return st ? <StreamVideo stream={st} className="stream-tile" /> : null;
  };

  return (
    <>
      <div className={`room media-room${theatre === "on" ? " is-theatre" : ""}`}>
          <section className={`stage${showRail ? " has-rail" : ""}`} aria-label="Stage">
            {showRail && (
              <StageRail sources={sources} hidden={p.hidden} setHidden={(id, h) => (h ? hide(id) : p.setHidden(id, false))}
                current={layout === "grid" ? "all" : focusId} onShow={p.setFocused}
                open={railOpen === "on"} setOpen={(o) => setRailOpen(o ? "on" : "off")}
                own={own} onStop={(id) => void cast.stop(id)} full={full} />
            )}
            <div className="stage-main">
            <div ref={setScreen} className={`stage-screen player-screen${music && playerFocused ? " is-music" : ""}${layout === "grid" ? " is-grid" : ""}${full ? " is-full" : ""}`}>
              {layout === "idle" && sources.length === 0 && (
                <div className="stage-idle">
                  <h1>Nothing playing</h1>
                  <p>Search YouTube, or paste a YouTube, Spotify or Twitch link. Use Watch alongside to play several at once. Or go live and share your screen.</p>
                </div>
              )}
              {layout === "idle" && sources.length > 0 && (
                <div className="stage-idle">
                  <h1>All sources hidden</h1>
                  <p>Pick one from Sources to show it again.</p>
                </div>
              )}
              {layout === "grid" && (
                <ul className="stage-grid" aria-label="Sources" style={{ width: grid.cols * grid.w + (grid.cols - 1) * GRID_GAP }}>
                  {visible.map((x) => <StageTile key={x.id} source={x} onFocus={p.setFocused} style={{ width: grid.w, height: grid.h }}>{tileMedia(x)}</StageTile>)}
                </ul>
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
              {focusedScreen && <div key={focusedScreen.item.id} ref={screenRef(focusedScreen.item.id)} className="player-slot" />}
              {now && playerFocused && <div ref={slotRef} className={hideVideo ? "player-slot player-slot-mini player-slot-hidden" : music ? "player-slot player-slot-mini" : "player-slot"} />}
            </div>

            {/* Outside the stage screen so it stacks above the shared player. */}
            {full && <button className="icon-btn exit-full" aria-label="Exit full screen" title="Exit full screen" onClick={toggleFull}><Minimize aria-hidden /></button>}
            {now && playerOnStage && (
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
              </div>
            )}

            {focusedScreen && (
              <div className="transport">
                {focusedScreen.item.kind !== "twitch-live" && focusedScreen.item.kind !== "twitch-clip" && (
                  <button className="icon-btn transport-main" disabled={!control}
                    aria-label={focusedScreen.playing ? "Pause for everyone" : "Play for everyone"}
                    onClick={() => void act(mediaAction(focusedScreen.playing ? "media:screen:pause" : "media:screen:play", { id: focusedScreen.item.id }))}>
                    {focusedScreen.playing ? <Pause aria-hidden /> : <Play aria-hidden />}
                  </button>
                )}
                {SEEKABLE[focusedScreen.item.kind] ? (
                  <Seek position={expectedPosition(focusedScreen)} duration={focusedScreen.item.duration} disabled={!control}
                    onSeek={(sec) => act(mediaAction("media:screen:seek", { id: focusedScreen.item.id, position: sec }))} />
                ) : (
                  <span className="live-badge">{focusedScreen.item.kind === "twitch-live" ? "Live" : "Clip"}</span>
                )}
                {p.blocked && p.screenSound.has(focusedScreen.item.id)
                  ? <button className="btn btn-primary btn-s sound-on" onClick={() => p.setBlocked(false)}><Volume2 aria-hidden /><span className="sound-label">Click anywhere for sound</span></button>
                  : <Volume volume={p.volume} muted={!p.screenSound.has(focusedScreen.item.id)}
                      onChange={(v) => { p.setVolume(v); p.setScreenSound(focusedScreen.item.id, v > 0); }}
                      onToggle={() => p.setScreenSound(focusedScreen.item.id, !p.screenSound.has(focusedScreen.item.id))} />}
              </div>
            )}

            {/* One bar for what's showing and for the stage itself. */}
            <div className="stage-info stage-bar">
              {focusedStream ? (
                <div className="now-meta">
                  <strong className="now-title">{focusedStream.mine ? ownName(focusedStream.id) : focusedStream.label}</strong>
                  <span><span className="live-dot" aria-hidden />Live{focusedStream.mode ? ` · ${focusedStream.mode}` : ""}</span>
                </div>
              ) : focusedScreen ? (
                <div className="now-meta">
                  <strong className="now-title">{focusedScreen.item.title}</strong>
                  <span>
                    {focusedScreen.item.kind === "twitch-live" && <span className="live-dot" aria-hidden />}
                    {[focusedScreen.item.author, KIND_LABEL[focusedScreen.item.kind], `opened by ${focusedScreen.startedBy.name}`].filter(Boolean).join(" · ")}
                  </span>
                </div>
              ) : now && playerOnStage ? (
                <div className="now-meta">
                  {!music && <strong className="now-title">{now.item.title}</strong>}
                  <span>
                    {[now.item.author, KIND_LABEL[now.item.kind], `started by ${now.startedBy.name}`].filter(Boolean).join(" · ")}
                    {p.syncing && <span className="syncing"> · Syncing</span>}
                  </span>
                </div>
              ) : (
                <div className="now-meta">{layout === "grid" && <span>{visible.length} sources</span>}</div>
              )}
              <div className="info-actions">
                {focusedStream ? (
                  <>
                    {!focusedStream.mine && (
                      <>
                        <button className="icon-btn" aria-label={cast.muted.has(focusedStream.id) ? "Unmute stream" : "Mute stream"} onClick={() => cast.setMuted(focusedStream.id, !cast.muted.has(focusedStream.id))}>
                          {cast.muted.has(focusedStream.id) ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
                        </button>
                        <input type="range" className="range stream-volume" min={0} max={100} aria-label="Stream volume" value={cast.volume[focusedStream.id] ?? 100}
                          style={{ "--fill": `${cast.volume[focusedStream.id] ?? 100}%` } as React.CSSProperties}
                          onChange={(e) => cast.setVolume(focusedStream.id, Number(e.target.value))} />
                      </>
                    )}
                    {!focusedStream.mine && canStopOthers && (
                      <button className="btn btn-quiet btn-s" onClick={() => { if (window.confirm(`End ${focusedStream.label}'s stream?`)) void cast.stop(focusedStream.id); }}>
                        <Square aria-hidden />End stream
                      </button>
                    )}
                  </>
                ) : focusedScreen ? (
                  canClose(focusedScreen) && (
                    <button className="btn btn-quiet btn-s" onClick={() => closeScreen(focusedScreen)}><X aria-hidden />Close for everyone</button>
                  )
                ) : now && playerOnStage ? (
                  <>
                    {now.item.kind === "youtube" && <ModeToggle item={now.item} mode={music ? "music" : "video"} onChange={p.setViewOverride} />}
                    {can(session, "player.queue") && <SaveToPlaylist itemId={now.item.id} label={now.item.title} />}
                  </>
                ) : null}
                <div className="stage-buttons">
                  <button className="icon-btn theatre-btn" aria-label="Theatre mode" aria-pressed={theatre === "on"} data-tip={theatre === "on" ? "Exit theatre mode" : "Theatre mode"}
                    onClick={toggleTheatre}><RectangleHorizontal aria-hidden /></button>
                  {sources.length > 0 && <button className="icon-btn" aria-label="Full screen" data-tip="Full screen" onClick={toggleFull}><Maximize aria-hidden /></button>}
                </div>
              </div>
            </div>

            {layout === "focus" && (
              <ul className="source-strip" aria-label="Other sources">
                {visible.filter((x) => x.id !== focusId).map((x) => (
                  <StageTile key={x.id} source={x} onFocus={p.setFocused}>{tileMedia(x)}</StageTile>
                ))}
              </ul>
            )}
            </div>
          </section>

        <aside className="side">
          {error && <p className="flash flash-error" role="alert">{error}</p>}
          {can(session, "player.queue") && (
            <AddBox canPlayNext={control} canAlongside={screens.length < SCREENS_MAX} onAdd={async ({ alongside, ...input }) => {
              setError(null);
              try {
                await (alongside ? mediaAction("media:screen:add", { url: input.url }) : mediaAction("media:add", input));
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
          <div className="side-panel" role="tabpanel">
          {tab === "queue" && <Queue session={session} items={state?.queue ?? []} act={act} />}
          {tab === "recent" && <History items={state?.history ?? []} canReplay={can(session, "player.queue")} onReplay={(id) => act(mediaAction("media:replay", { id }))} />}
          {tab === "playlists" && <PlaylistsPanel session={session} queueCount={(state?.queue.length ?? 0) + (now ? 1 : 0)} />}
          </div>
        </aside>
      </div>

      <Feed session={session} />
    </>
  );
}
