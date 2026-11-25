import { tlog } from "../lib/twitchDebug";
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Maximize, Minimize, RectangleHorizontal, Pause, Play, SkipForward, Video, VideoOff, Volume2 } from "lucide-react";
import { SCREENS_MAX, SEEKABLE, type Playback, type Session } from "@friends/shared";
import { AddBox } from "../components/media/AddBox";
import { Feed } from "../components/posts/Feed";
import { PresenceStack } from "../components/PresenceStack";
import { MeLink } from "../components/Shell";
import { EndButton, fitGrid, StageRail, StageTile, type StageSource } from "../components/stage/Sources";
import { StreamVideo, useCast, useStreamHandoff } from "../lib/cast";
import { LyricsView } from "../components/music/LyricsView";
import { PlaylistsPanel, SaveToPlaylist } from "../components/music/Playlists";
import { PRESETS, Visualizer, type Preset } from "../components/music/Visualizer";
import { History, Mixer, Queue, Seek, VolumeHover } from "../components/media/parts";
import { Soundboard } from "../components/media/Soundboard";
import { Speak } from "../components/media/Speak";
import { useSounds } from "../lib/sounds";
import { can } from "../lib/api";
import { useArtworkGlow } from "../lib/glow";
import { expectedPosition, KIND_LABEL, mediaAction, mediaError, useMediaState } from "../lib/media";
import { usePlayer, viewModeOf } from "../lib/player";
import { useSite } from "../lib/site";
import { useToast } from "../lib/toast";
import { nativeControls } from "../lib/touch";

type MusicView = "art" | "viz" | "lyrics";
const GRID_PAD = 12;
/** Height above and below the stage screen: the top bar, page padding and stage bars. Matches app.css. Theatre measures its bars instead (--stage-bars). */
const PAGE_CHROME = 250;
const THEATRE_CHROME = 150;
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
  const [statsPref, setStatsPref] = usePref<"on" | "off">("streamStats", "off");
  const [tab, setTab] = usePref<"queue" | "recent" | "playlists" | "posts">("sideTab", "queue");
  const state = useMediaState();
  const now = state?.now ?? null;
  const p = usePlayer();
  useArtworkGlow(now?.item.thumbnail);
  const toast = useToast();
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

  // Stage and queue actions report failures as a toast, wherever on the page they were clicked.
  const act = useCallback(async (pr: Promise<void>) => {
    try {
      await pr;
    } catch (e) {
      toast(mediaError(e), { kind: "error" });
    }
  }, [toast]);

  // Progress readout ticks while playing.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!now?.playing) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [now?.playing]);

  // Hand the persistent player our slot while we're mounted.
  // The cleanup clears only the element that left, so moving the slot (tile to shown large) never loses it.
  const slotRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    p.setSlot(el);
    return () => p.setSlot((cur) => (cur === el ? null : cur));
  }, [p.setSlot]);
  useEffect(() => () => p.setSlot(null), [p.setSlot]);
  // Screens only load while the stage is on screen.
  useEffect(() => {
    p.setStageOpen(true);
    return () => p.setStageOpen(false);
  }, [p.setStageOpen]);
  // One stable ref callback per screen, so re-renders don't detach and re-attach its slot.
  const screenRefs = useRef(new Map<string, (el: HTMLDivElement | null) => (() => void) | undefined>());
  const screenRef = (id: string) => {
    let fn = screenRefs.current.get(id);
    if (!fn) {
      fn = (el) => {
        if (!el) return;
        p.setScreenSlot(id, el);
        return () => p.setScreenSlot(id, null, el);
      };
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
  const sounds = useSounds();
  // Your own shares get one name everywhere (source row, tile, Stop), numbered when there are several.
  const mineIds = cast.streams.filter((st) => st.mine && st.kind === "screen").map((st) => st.id);
  const ownName = (id: string) => (!mineIds.includes(id) ? "Your camera" : mineIds.length > 1 ? `Your screen ${mineIds.indexOf(id) + 1}` : "Your screen");
  const streamDetail = (st: (typeof cast.streams)[number], own: boolean) =>
    st.kind === "camera" ? "Camera" : ["Live", st.mode, own && !st.audio && "No sound"].filter(Boolean).join(" · ");
  const screens = state?.screens ?? [];
  const canClose = (sc: Playback) => sc.startedBy.id === session.user.id || control;
  const closeScreen = (sc: Playback) => void act(mediaAction("media:screen:close", { id: sc.item.id }));
  const setMediaOn = (id: string) => (on: boolean) => p.setHidden(id, !on);
  const canStopOthers = can(session, "playback.moderate");
  // Every source is listed for everyone. The eye hides one just for you; the X ends it for everyone,
  // and only shows when you're allowed to. Ending someone else's asks first. Closing the player keeps the queue for Play.
  const sources: StageSource[] = [
    ...(now ? [{ id: "player", label: "Player", detail: now.item.title, thumbnail: now.item.thumbnail, audible: p.audible, setAudible: p.setAudible,
      silent: nativeControls(now.item.kind) || undefined, // Twitch on a phone: its own controls handle sound
      volume: p.volume, setVolume: (v: number) => { p.setVolume(v); p.setAudible(v > 0); },
      on: !p.hidden.has("player"), setOn: setMediaOn("player"),
      end: canClose(now) ? { label: "Close for everyone", run: () => void act(mediaAction("media:stop", { id: now.item.id })),
        confirm: now.startedBy.id === session.user.id ? undefined : `Close ${now.item.title} for everyone?` } : undefined }] : []),
    ...screens.map((sc) => ({
      id: sc.item.id,
      live: sc.item.kind === "twitch-live",
      label: sc.item.author ?? sc.item.title,
      detail: sc.item.kind === "twitch-live" ? `Live · ${sc.item.title}` : sc.item.title,
      thumbnail: sc.item.thumbnail,
      audible: p.screenSound.has(sc.item.id),
      silent: nativeControls(sc.item.kind) || undefined,
      setAudible: (v: boolean) => p.setScreenSound(sc.item.id, v),
      volume: p.screenVolume[sc.item.id] ?? p.volume,
      setVolume: (v: number) => { p.setScreenVolume(sc.item.id, v); p.setScreenSound(sc.item.id, v > 0); },
      on: !p.hidden.has(sc.item.id),
      setOn: setMediaOn(sc.item.id),
      end: canClose(sc) ? { label: "Close for everyone", run: () => closeScreen(sc),
        confirm: sc.startedBy.id === session.user.id ? undefined : `Close ${sc.item.title} for everyone?` } : undefined,
    })),
    ...cast.streams.map((st) => ({
      id: st.id,
      live: true,
      local: st.mine,
      label: st.mine ? ownName(st.id) : st.label,
      detail: streamDetail(st, st.mine),
      thumbnail: st.avatarUrl,
      // Your own stream: a live preview, and Stop beside it. Change window is in the Go live panel.
      preview: st.mine ? <StreamVideo stream={st} className="rail-preview-video" /> : undefined,
      audible: st.local ? false : !cast.muted.has(st.id),
      silent: st.local || st.kind === "camera", // a camera has no sound
      setAudible: (v: boolean) => cast.setMuted(st.id, !v),
      volume: cast.volume[st.id] ?? 100,
      setVolume: (v: number) => { cast.setVolume(st.id, v); cast.setMuted(st.id, v === 0); },
      on: cast.watching.has(st.id),
      setOn: (on: boolean) => cast.setWatching(st.id, on),
      stream: !st.local,
      camera: st.camera ? { shown: !cast.hiddenCameras.has(st.userId), set: (v: boolean) => cast.setCameraHidden(st.userId, !v) } : undefined,
      // Stop beside every stream you may end: your own straight away, someone else's (moderators) after asking.
      end: st.mine ? { label: st.kind === "camera" ? "Turn off camera" : "Stop streaming", run: (): void => void cast.stop(st.id), stop: true }
        : canStopOthers ? { label: "Stop for everyone", run: (): void => void cast.stop(st.id), confirm: `Stop ${st.label}'s stream for everyone?`, stop: true } : undefined,
    })),
  ];
  // What's on is loaded and playing; off is unloaded for you only. Others' streams that are off
  // still show on the stage, as a card to start watching.
  const visible = sources.filter((x) => x.on);
  const onStage = sources.filter((x) => x.on || x.stream);
  // Focus works like Discord's: clicking a source focuses it, clicking it again unfocuses it. Focused
  // sources share the stage and the rest sit in the strip below; none focused is the grid.
  const picked = onStage.length > 1 ? onStage.filter((x) => x.on && p.focused.has(x.id)) : [];
  // Focusing a hidden source turns it on; moving sources in and out of focus doesn't reload them.
  const toggleFocus = (id: string) => {
    const x = sources.find((y) => y.id === id);
    if (!x) return;
    const next = new Set(picked.map((y) => y.id));
    if (!x.on) x.setOn(true);
    if (x.on && next.has(id)) next.delete(id);
    else next.add(id);
    // Focusing everything is the grid.
    const stage = new Set([...onStage.map((y) => y.id), id]);
    p.setFocused([...stage].every((s) => next.has(s)) ? new Set() : next);
  };
  const clearFocus = () => p.setFocused(new Set());
  useEffect(() => tlog("stage focus", [...p.focused]), [p.focused]);
  // Stopping your stream with the camera on leaves the camera where the stream was (shown large if it was), and
  // going live with the camera on puts the stream where the camera was.
  useStreamHandoff((from, to) => p.setFocused((prev) => (prev.has(from) ? new Set([...[...prev].filter((x) => x !== from), to]) : prev)));
  const layout: "idle" | "single" | "focus" | "grid" = onStage.length === 0 ? "idle" : onStage.length === 1 ? "single" : picked.length ? "focus" : "grid";
  const single = layout === "single" ? onStage[0]! : null;
  const offer = single && !single.on ? single : null;
  // Shown large on its own: the only source, or the one focused source.
  const focusId = single ? (single.on ? single.id : null) : picked.length === 1 ? picked[0]!.id : null;
  // Tiles on the stage: every source in the grid, or the focused ones when there are several. The rest go in the strip.
  const tiles = layout === "grid" ? onStage : picked.length > 1 ? picked : [];
  const strip = layout === "focus" ? onStage.filter((x) => !picked.includes(x)) : [];
  const tiled = tiles.length > 0;
  const playerFocused = focusId === "player";
  const playerOnStage = tiled ? tiles.some((x) => x.id === "player" && x.on) : playerFocused;
  const focusedStream = cast.streams.find((st) => st.id === focusId) ?? null;
  const focusedScreen = screens.find((sc) => sc.item.id === focusId) ?? null;
  // Theatre turns itself on while you're watching someone else's stream, and back off when you stop.
  // Toggling it then only lasts until you stop watching; otherwise it's your saved setting.
  const othersLive = cast.streams.some((st) => !st.mine && cast.watching.has(st.id));
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
  const streamsOnStage = cast.streams.some((st) => visible.some((x) => x.id === st.id));
  const showStats = statsPref === "on" && streamsOnStage;
  const showRail = sources.length > 0 || (cast.canStream && cast.supported);

  // Grid sizing: tiles as large as the stage allows (the window height, or the screen in full screen).
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
  // Theatre fits the stage and every bar under it (transport, info, source strip) into the window, so measure the bars rather than guess.
  const [bars, setBars] = useState(THEATRE_CHROME);
  // The rail's foot matches the stage bar's height so their top edges line up.
  const [barH, setBarH] = useState(0);
  useEffect(() => {
    const main = screen?.parentElement;
    if (!main) return;
    const measure = () => {
      let h = 0;
      for (const el of Array.from(main.children) as HTMLElement[]) {
        if (el !== screen && !["fixed", "absolute"].includes(getComputedStyle(el).position)) h += el.offsetHeight;
      }
      setBars(h);
      setBarH((main.querySelector(":scope > .stage-bar") as HTMLElement | null)?.offsetHeight ?? 0);
    };
    const ro = new ResizeObserver(measure);
    const watch = () => {
      ro.disconnect();
      for (const el of Array.from(main.children)) if (el !== screen) ro.observe(el);
      measure();
    };
    const mo = new MutationObserver(watch);
    mo.observe(main, { childList: true });
    watch();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [screen]);
  const theatreFit = theatre === "on" && window.innerWidth > 860;
  const gridH = full ? box.h - 2 * GRID_PAD : Math.max(320, theatreFit ? box.h - bars - 2 * GRID_PAD : box.h - PAGE_CHROME);
  let grid = fitGrid(tiled ? tiles.length : 1, box.w, gridH, GRID_GAP);
  // YouTube's player must stay at least 200px tall wherever it's visible.
  const youtubeInGrid = (playerOnStage && !hideVideo && now?.item.kind === "youtube") || screens.some((sc) => sc.item.kind === "youtube" && tiles.some((x) => x.on && x.id === sc.item.id));
  if (tiled && youtubeInGrid && grid.h < 200 && box.w >= 600) {
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
    return st ? <StreamVideo stream={st} className="stream-tile" stats={showStats ? "compact" : undefined} camera="small" /> : null;
  };

  // With several sources tiled, each video controls itself: play, skip and seek sit on its tile, shown on hover.
  // The bar under the stage only drives a source shown large on its own.
  // Each tile's volume sits with its controls. Twitch's player is drawn over its whole tile (it stops whenever anything
  // covers it), so a Twitch tile has nothing over it: its sound is in Sources and the volume button below the stage.
  const tileControls = (x: StageSource) => {
    const btn = (label: string, icon: React.ReactNode, run: () => void) => (
      <button className="icon-btn" disabled={!control} aria-label={label} title={label} onClick={run}>{icon}</button>
    );
    const sc = screens.find((y) => y.item.id === x.id);
    const kind = x.id === "player" ? now?.item.kind : sc?.item.kind;
    if (kind?.startsWith("twitch")) return undefined;
    const vol = !(x.silent ?? x.local) && x.setVolume
      ? <VolumeHover label={x.label} volume={x.volume ?? 100} muted={!x.audible} setVolume={x.setVolume} setMuted={(m) => x.setAudible(!m)} />
      : null;
    if (x.id === "player" && now) {
      return (
        <>
          {btn(now.playing ? "Pause for everyone" : "Play for everyone", now.playing ? <Pause aria-hidden /> : <Play aria-hidden />,
            () => void act(now.playing ? mediaAction("media:pause", { position: pos }) : mediaAction("media:play")))}
          {btn("Skip for everyone", <SkipForward aria-hidden />, () => void act(mediaAction("media:skip")))}
          {SEEKABLE[now.item.kind] && <Seek position={pos} duration={now.item.duration} disabled={!control} onSeek={(s) => act(mediaAction("media:seek", { position: s }))} />}
          {vol}
        </>
      );
    }
    if (!sc) return vol ?? undefined; // a cast stream: just its sound
    const id = sc.item.id;
    return (
      <>
        {btn(sc.playing ? "Pause for everyone" : "Play for everyone", sc.playing ? <Pause aria-hidden /> : <Play aria-hidden />,
          () => void act(mediaAction(sc.playing ? "media:screen:pause" : "media:screen:play", { id })))}
        {SEEKABLE[sc.item.kind] && <Seek position={expectedPosition(sc)} duration={sc.item.duration} disabled={!control}
          onSeek={(s) => act(mediaAction("media:screen:seek", { id, position: s }))} />}
        {vol}
      </>
    );
  };

  // What the bar under the stage is about: the stream, screen or player shown large.
  const bar = focusedStream ? "stream" : focusedScreen ? "screen" : now && playerFocused ? "player" : null;
  // The browser blocked sound: one notice over the stage; the first click or key press anywhere clears it.
  const soundBlocked = p.blocked && visible.some((x) => x.audible && !x.local);
  // Video, or one of the music views, in one control. Video is only for YouTube.
  const views = now ? [...(now.item.kind === "youtube" ? [["video", "Video"]] : []), ["viz", "Visualizer"], ["lyrics", "Lyrics"], ["art", "Artwork"]] as const : [];
  const setView = (v: "video" | MusicView) => {
    if (!now) return;
    if (v === "video") return p.setViewOverride(now.item, "video");
    if (!music) p.setViewOverride(now.item, "music");
    setMusicView(v);
  };
  const theatreTip = theatre === "on"
    ? othersLive ? "Exit theatre mode for this stream" : "Exit theatre mode"
    : othersLive ? "Theatre mode for this stream" : "Theatre mode";
  const playPause = (playing: boolean, run: () => void) => (
    <button className="icon-btn transport-main" disabled={!control} aria-label={playing ? "Pause for everyone" : "Play for everyone"} onClick={run}>
      {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
    </button>
  );

  return (
    <>
      <div className={`room media-room${theatre === "on" ? " is-theatre" : ""}`} style={{ "--stage-bars": `${bars}px`, "--stage-bar-h": `${barH}px` } as React.CSSProperties}>
          <section className={`stage${showRail ? " has-rail" : ""}`} aria-label="Stage">
            {showRail && (
              <StageRail sources={sources} focused={new Set(picked.map((x) => x.id))} all={layout === "grid"} onToggle={toggleFocus} onAll={clearFocus}
                open={railOpen === "on"} setOpen={(o) => setRailOpen(o ? "on" : "off")} full={full} theatre={theatre === "on"} />
            )}
            <div className="stage-main">
            <div ref={setScreen} className={`stage-screen player-screen${music && playerFocused ? " is-music" : ""}${tiled ? " is-grid" : ""}${full ? " is-full" : ""}`}>
              {layout === "idle" && sources.length === 0 && (
                <div className="stage-idle"><h1>Nothing playing</h1></div>
              )}
              {layout === "idle" && sources.length > 0 && (
                <div className="stage-idle">
                  <h1>Everything is hidden</h1>
                  <p>Show a source from Sources.</p>
                </div>
              )}
              {offer && (
                <ul className="stage-grid stage-offer" aria-label="Sources" style={{ width: grid.w }}>
                  <StageTile source={offer} onFocus={toggleFocus} style={{ width: grid.w, height: grid.h }} />
                </ul>
              )}
              {tiled && (
                <ul className="stage-grid" aria-label={layout === "focus" ? "Focused sources" : "Sources"} style={{ width: grid.cols * grid.w + (grid.cols - 1) * GRID_GAP }}>
                  {tiles.map((x) => (
                    <StageTile key={x.id} source={x} focused={layout === "focus"} onFocus={toggleFocus} controls={x.on ? tileControls(x) : undefined} style={{ width: grid.w, height: grid.h }}>{x.on && tileMedia(x)}</StageTile>
                  ))}
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
                </div>
              )}
              {focusedStream && <StreamVideo stream={focusedStream} className="stream-main" stats={showStats ? "full" : undefined} camera="full" />}
              {focusedScreen && <div key={focusedScreen.item.id} ref={screenRef(focusedScreen.item.id)} className="player-slot" />}
              {now && playerFocused && <div ref={slotRef} className={hideVideo ? "player-slot player-slot-mini player-slot-hidden" : music ? "player-slot player-slot-mini" : "player-slot"} />}
              {/* The one focused source: clicking it unfocuses it. Music view keeps its own clicks (lyrics scroll). */}
              {layout === "focus" && focusId && !(playerFocused && music) && (() => {
                const x = sources.find((y) => y.id === focusId)!;
                return <button className="stage-hit" aria-label={`Unfocus ${x.label}`} title="Unfocus" onClick={() => toggleFocus(focusId)} />;
              })()}
            </div>

            {/* Outside the stage screen so they stack above the shared player. */}
            {full && <button className="icon-btn exit-full" aria-label="Exit full screen" title="Exit full screen" onClick={toggleFull}><Minimize aria-hidden /></button>}
            {soundBlocked && <div className={`sound-notice${full ? " is-full" : ""}`} role="status"><Volume2 aria-hidden />Click anywhere for sound</div>}

            {/* One bar under the stage: seek on top, then play, what's showing, and its controls and the stage's. */}
            <div className="stage-bar">
              {bar === "player" && now && SEEKABLE[now.item.kind] && (
                <Seek position={pos} duration={now.item.duration} disabled={!control} onSeek={(s) => act(mediaAction("media:seek", { position: s }))} />
              )}
              {bar === "screen" && focusedScreen && SEEKABLE[focusedScreen.item.kind] && (
                <Seek position={expectedPosition(focusedScreen)} duration={focusedScreen.item.duration} disabled={!control}
                  onSeek={(sec) => act(mediaAction("media:screen:seek", { id: focusedScreen.item.id, position: sec }))} />
              )}
              <div className="stage-bar-row">
                {bar === "player" && now && (
                  <div className="bar-transport">
                    {playPause(now.playing, () => void act(now.playing ? mediaAction("media:pause", { position: pos }) : mediaAction("media:play")))}
                    <button className="icon-btn" disabled={!control} aria-label="Skip for everyone" data-tip="Skip" onClick={() => act(mediaAction("media:skip"))}><SkipForward aria-hidden /></button>
                  </div>
                )}
                {bar === "screen" && focusedScreen && focusedScreen.item.kind !== "twitch-live" && focusedScreen.item.kind !== "twitch-clip" && (
                  <div className="bar-transport">
                    {playPause(focusedScreen.playing, () => void act(mediaAction(focusedScreen.playing ? "media:screen:pause" : "media:screen:play", { id: focusedScreen.item.id })))}
                  </div>
                )}

                <div className="now-meta">
                  {bar === "stream" && focusedStream ? (
                    <>
                      <strong className="now-title">{focusedStream.mine ? ownName(focusedStream.id) : focusedStream.label}</strong>
                      <span><span className="live-dot" aria-hidden />{streamDetail(focusedStream, true)}</span>
                    </>
                  ) : bar === "screen" && focusedScreen ? (
                    <>
                      <strong className="now-title">{focusedScreen.item.title}</strong>
                      <span>
                        {focusedScreen.item.kind === "twitch-live" && <span className="live-dot" aria-hidden />}
                        {[focusedScreen.item.author, KIND_LABEL[focusedScreen.item.kind], `opened by ${focusedScreen.startedBy.name}`].filter(Boolean).join(" · ")}
                      </span>
                    </>
                  ) : bar === "player" && now ? (
                    <>
                      {!(music && playerFocused) && <strong className="now-title">{now.item.title}</strong>}
                      <span>
                        {now.item.kind === "twitch-live" && <span className="live-dot" aria-hidden />}
                        {[now.item.author, KIND_LABEL[now.item.kind], `started by ${now.startedBy.name}`].filter(Boolean).join(" · ")}
                        {p.syncing && <span className="syncing"> · Syncing</span>}
                      </span>
                    </>
                  ) : null}
                </div>

                <div className="info-actions">
                  {bar === "player" && now && (
                    <>
                      {(now.item.kind === "youtube" || music) && (
                        <select className="select select-s" aria-label="View (just for you)" title="View (just for you)" value={music ? musicView : "video"}
                          onChange={(e) => setView(e.target.value as "video" | MusicView)}>
                          {views.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                        </select>
                      )}
                      {music && musicView === "viz" && playerFocused && (
                        <select className="select select-s" aria-label="Visualizer preset" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
                          {PRESETS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                        </select>
                      )}
                      {can(session, "player.queue") && <SaveToPlaylist itemId={now.item.id} label={now.item.title} />}
                    </>
                  )}
                  <div className="stage-buttons">
                    {/* Stop the stream you're watching: yours, or anyone's for moderators (asks first). */}
                    {bar === "stream" && (() => {
                      const x = sources.find((y) => y.id === focusId);
                      return x?.end ? <EndButton source={x} /> : null;
                    })()}
                    {bar === "stream" && focusedStream?.camera && (() => {
                      const shown = !cast.hiddenCameras.has(focusedStream.userId);
                      return (
                        <button className="icon-btn" aria-label="Camera" aria-pressed={shown} data-tip={shown ? "Hide camera" : "Show camera"}
                          onClick={() => cast.setCameraHidden(focusedStream.userId, shown)}>{shown ? <Video aria-hidden /> : <VideoOff aria-hidden />}</button>
                      );
                    })()}
                    <Soundboard session={session} />
                    <Speak />
                    <Mixer channels={[...visible.filter((x) => !(x.silent ?? x.local) && x.setVolume).map((x) => ({
                      id: x.id, label: x.label, volume: x.volume ?? 100, muted: !x.audible, setMuted: (m: boolean) => x.setAudible(!m), setVolume: x.setVolume!,
                    })), ...(sounds.enabled ? [
                      { id: "sounds", label: "Soundboard", volume: sounds.volume, muted: sounds.muted, setMuted: sounds.setMuted, setVolume: sounds.setVolume },
                      { id: "tts", label: "Text to speech", volume: sounds.ttsVolume, muted: sounds.ttsMuted, setMuted: sounds.setTtsMuted, setVolume: sounds.setTtsVolume },
                    ] : [])]} />
                    {streamsOnStage && (
                      <button className="icon-btn" aria-label="Stream stats" aria-pressed={showStats} data-tip={showStats ? "Hide stream stats" : "Stream stats"}
                        onClick={() => setStatsPref(showStats ? "off" : "on")}><Activity aria-hidden /></button>
                    )}
                    <button className="icon-btn theatre-btn" aria-label="Theatre mode" aria-pressed={theatre === "on"} data-tip={theatreTip}
                      onClick={toggleTheatre}><RectangleHorizontal aria-hidden /></button>
                    {sources.length > 0 && <button className="icon-btn" aria-label="Full screen" data-tip="Full screen" onClick={toggleFull}><Maximize aria-hidden /></button>}
                  </div>
                  {/* Theatre hides the top bar, so who's here and your avatar move down here. */}
                  {theatre === "on" && (
                    <div className="theatre-me">
                      <PresenceStack me={session.user} />
                      <MeLink session={session} size={30} />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {strip.length > 0 && (
              <ul className="source-strip" aria-label="Other sources">
                {strip.map((x) => (
                  <StageTile key={x.id} source={x} onFocus={toggleFocus} controls={x.on ? tileControls(x) : undefined}>{x.on && tileMedia(x)}</StageTile>
                ))}
              </ul>
            )}
            </div>
          </section>

        <aside className="side">
          {can(session, "player.queue") && (
            <AddBox canPlayNext={control} canAlongside={screens.length < SCREENS_MAX} onAdd={async ({ alongside, ...input }) => {
              try {
                await (alongside ? mediaAction("media:screen:add", { url: input.url }) : mediaAction("media:add", input));
                return null;
              } catch (e) {
                return mediaError(e);
              }
            }} />
          )}
          <div className="side-tabs" role="tablist" aria-label="Queue, recent, playlists and posts">
            {([["queue", `Up next${state?.queue.length ? ` ${state.queue.length}` : ""}`], ["recent", "Recent"], ["playlists", "Playlists"], ["posts", "Posts"]] as const).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className="side-tab" onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
          <div className="side-panel" role="tabpanel">
          {tab === "queue" && <Queue session={session} items={state?.queue ?? []} act={act} />}
          {tab === "recent" && <History items={state?.history ?? []} canReplay={can(session, "player.queue")} onReplay={(id) => act(mediaAction("media:replay", { id }))} />}
          {tab === "playlists" && <PlaylistsPanel session={session} queueCount={(state?.queue.length ?? 0) + (now ? 1 : 0)} />}
          {tab === "posts" && <Feed session={session} inTab />}
          </div>
        </aside>
      </div>
    </>
  );
}
