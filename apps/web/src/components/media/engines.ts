import type { MediaItem } from "@friends/shared";

/** The minimal surface the sync loop needs from any embedded player. */
export interface Engine {
  load(item: MediaItem, at: number, play: boolean): void;
  play(): void;
  pause(): void;
  seek(sec: number): void;
  time(): number;
  playing(): boolean;
  setVolume(v: number): void;
  setMuted(m: boolean): void;
  destroy(): void;
}

export interface EngineEvents {
  onEnded: () => void;
  onDuration: (sec: number) => void;
}

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string, ready?: (done: () => void) => void): Promise<void> {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.async = true;
      el.onerror = () => reject(new Error(`failed to load ${src}`));
      if (ready) ready(resolve);
      else el.onload = () => resolve();
      document.head.append(el);
    });
    scripts.set(src, p);
  }
  return p;
}

// ---------- YouTube ----------

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window { YT?: any; onYouTubeIframeAPIReady?: () => void; Twitch?: any }
}

export async function youtubeEngine(host: HTMLElement, ev: EngineEvents, initial: { item: MediaItem; at: number; play: boolean }): Promise<Engine> {
  await loadScript("https://www.youtube.com/iframe_api", (done) => {
    window.onYouTubeIframeAPIReady = done;
  });
  const YT = window.YT;
  const mount = document.createElement("div");
  host.replaceChildren(mount);
  let currentId = initial.item.ref;
  let reportedFor = "";
  // Where a loaded-but-never-started video will begin. YouTube reports 0 until it plays, and seekTo
  // on an unstarted or cued video starts playback, so a paused room would play for a moment.
  let cuedAt: number | null = initial.play ? null : initial.at;

  const player: any = await new Promise((resolve) => {
    const p = new YT.Player(mount, {
      width: "100%",
      height: "100%",
      videoId: initial.item.ref,
      playerVars: { autoplay: initial.play ? 1 : 0, controls: 0, disablekb: 1, playsinline: 1, rel: 0, start: Math.floor(initial.at) },
      events: {
        onReady: () => resolve(p),
        onStateChange: (e: { data: number }) => {
          if (e.data === YT.PlayerState.PLAYING) cuedAt = null;
          if (e.data === YT.PlayerState.ENDED) ev.onEnded();
          if (e.data === YT.PlayerState.PLAYING && reportedFor !== currentId) {
            const d = p.getDuration();
            if (d > 0) {
              reportedFor = currentId;
              ev.onDuration(d);
            }
          }
        },
      },
    });
  });

  return {
    load(item, at, play) {
      currentId = item.ref;
      cuedAt = play ? null : at;
      if (play) player.loadVideoById({ videoId: item.ref, startSeconds: at });
      else player.cueVideoById({ videoId: item.ref, startSeconds: at });
    },
    play: () => player.playVideo(),
    pause: () => player.pauseVideo(),
    seek(s) {
      if (cuedAt === null) return player.seekTo(s, true);
      cuedAt = s;
      player.cueVideoById({ videoId: currentId, startSeconds: s });
    },
    time: () => cuedAt ?? player.getCurrentTime?.() ?? 0,
    playing: () => player.getPlayerState?.() === YT.PlayerState.PLAYING || player.getPlayerState?.() === YT.PlayerState.BUFFERING,
    setVolume: (v) => player.setVolume(v),
    setMuted: (m) => (m ? player.mute() : player.unMute()),
    destroy: () => player.destroy(),
  };
}

// ---------- Twitch (VODs and live channels) ----------

const twitchTime = (s: number) => `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${Math.floor(s % 60)}s`;

export async function twitchEngine(host: HTMLElement, ev: EngineEvents, initial: { item: MediaItem; at: number; play: boolean }): Promise<Engine> {
  await loadScript("https://player.twitch.tv/js/embed/v1.js");
  const Twitch = window.Twitch;
  const id = `twitch-${Math.random().toString(36).slice(2)}`;
  const mount = document.createElement("div");
  mount.id = id;
  mount.style.cssText = "width:100%;height:100%";
  host.replaceChildren(mount);
  const target = (item: MediaItem) => (item.kind === "twitch-live" ? { channel: item.ref } : { video: `v${item.ref}` });
  const player: any = new Twitch.Player(id, {
    width: "100%",
    height: "100%",
    parent: [window.location.hostname],
    autoplay: initial.play,
    muted: true,
    time: twitchTime(initial.at),
    ...target(initial.item),
  });
  let isPlaying = false;
  let reported = false;
  player.addEventListener(Twitch.Player.PLAYING, () => {
    isPlaying = true;
    const d = player.getDuration?.();
    if (!reported && d > 0) {
      reported = true;
      ev.onDuration(d);
    }
  });
  player.addEventListener(Twitch.Player.PAUSE, () => (isPlaying = false));
  player.addEventListener(Twitch.Player.ENDED, () => {
    isPlaying = false;
    ev.onEnded();
  });
  await new Promise<void>((resolve) => player.addEventListener(Twitch.Player.READY, () => resolve()));

  return {
    load(item, at) {
      reported = false;
      if (item.kind === "twitch-live") player.setChannel(item.ref);
      else player.setVideo(`v${item.ref}`, at);
    },
    play: () => player.play(),
    pause: () => player.pause(),
    seek: (s) => player.seek(s),
    time: () => player.getCurrentTime?.() ?? 0,
    playing: () => isPlaying,
    setVolume: (v) => player.setVolume(v / 100),
    setMuted: (m) => player.setMuted(m),
    destroy: () => host.replaceChildren(),
  };
}

// ---------- Twitch clips: a plain iframe, no API, so no sync beyond "start together" ----------

export function clipEngine(host: HTMLElement): Engine {
  const show = (item: MediaItem, play: boolean, muted: boolean) => {
    const f = document.createElement("iframe");
    f.src = `https://clips.twitch.tv/embed?clip=${encodeURIComponent(item.ref)}&parent=${window.location.hostname}&autoplay=${play}&muted=${muted}`;
    f.allow = "autoplay; fullscreen";
    f.style.cssText = "width:100%;height:100%;border:0";
    f.title = item.title;
    host.replaceChildren(f);
  };
  let current: MediaItem | null = null;
  let muted = true;
  return {
    load(item, _at, play) {
      current = item;
      show(item, play, muted);
    },
    play() {},
    pause() {},
    seek() {},
    time: () => 0,
    playing: () => true,
    setVolume() {},
    setMuted(m) {
      if (m !== muted && current) {
        muted = m;
        show(current, true, m);
      }
    },
    destroy: () => host.replaceChildren(),
  };
}
