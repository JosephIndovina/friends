import { tlog } from "../../lib/twitchDebug";
import { useEffect, useRef, useState } from "react";
import { SEEKABLE, type MediaKind, type Playback } from "@friends/shared";
import { expectedPosition } from "../../lib/media";
import { getSocket } from "../../lib/socket";
import { clipEngine, twitchEngine, youtubeEngine, type Engine } from "./engines";

type Family = "youtube" | "twitch" | "clip";
const familyOf = (k: MediaKind): Family => (k === "youtube" ? "youtube" : k === "twitch-clip" ? "clip" : "twitch");

const HARD_DRIFT_S = 0.5;
const SEEK_COOLDOWN_MS = 2500;
/** a self-paused embed that didn't say so gets one try to resume it after this long */
const RESUME_AFTER_S = 8;
/** a self-paused Twitch player is resumed at once, but no more often than this, so it never fights in a loop */
const SELF_PAUSE_GAP_MS = 3000;

/**
 * Drives an embedded player so it matches the room's playback: same item, same play/pause,
 * same position (within HARD_DRIFT_S). The room is the source of truth; local controls go through the server.
 */
export function SyncedPlayer({ playback, audible, volume, onDrift, onBlocked }: {
  playback: Playback;
  /** the viewer has opted in to sound (a user gesture unlocks unmuted playback) */
  audible: boolean;
  volume: number;
  onDrift?: (syncing: boolean) => void;
  /** unmuted playback was refused by the browser; the caller should fall back to muted */
  onBlocked?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<{ family: Family; e: Engine; itemId: string } | null>(null);
  const latest = useRef(playback);
  latest.current = playback;
  const lastSeek = useRef(0);
  const stalls = useRef(0);
  const lastResume = useRef(0);
  const [ready, setReady] = useState(0);

  const family = familyOf(playback.item.kind);

  // (Re)create the engine when the player family changes.
  useEffect(() => {
    let cancelled = false;
    const el = host.current!;
    const p = latest.current;
    const events = {
      onEnded: () => getSocket().emit("media:ended", { itemId: latest.current.item.id }),
      onDuration: (d: number) => getSocket().emit("media:duration", { itemId: latest.current.item.id, duration: d }),
      // Twitch pauses itself when its player is moved or resized (shown large): play on straight away while the room is.
      onSelfPause: () => {
        const e = engine.current?.e;
        const { playing, item } = latest.current;
        if (!e || !playing || Date.now() - lastResume.current < SELF_PAUSE_GAP_MS) return;
        if (item.duration && e.time() >= item.duration - 2) return; // a video that reached its end

        lastResume.current = Date.now();
        tlog("paused by itself while the room plays: resuming");
        e.play();
      },
    };
    const init = { item: p.item, at: expectedPosition(p), play: p.playing };
    const make = family === "youtube" ? youtubeEngine(el, events, init) : family === "twitch" ? twitchEngine(el, events, init) : Promise.resolve(clipEngine(el));
    void make.then((e) => {
      if (cancelled) return e.destroy();
      if (family === "clip") e.load(p.item, 0, p.playing);
      engine.current = { family, e, itemId: p.item.id };
      if (import.meta.env.DEV) (window as unknown as { __engine: Engine }).__engine = e;
      setReady((n) => n + 1);
    });
    return () => {
      cancelled = true;
      engine.current?.e.destroy();
      engine.current = null;
    };
  }, [family]);

  // Load a new item into the existing engine.
  useEffect(() => {
    const cur = engine.current;
    if (!cur || cur.itemId === playback.item.id) return;
    cur.itemId = playback.item.id;
    cur.e.load(playback.item, expectedPosition(playback), playback.playing);
    lastSeek.current = Date.now();
  }, [playback, ready]);

  useEffect(() => {
    const e = engine.current?.e;
    if (!e) return;
    e.setMuted(!audible);
    if (audible) e.setVolume(volume);
  }, [audible, volume, ready]);

  // Play and pause when the room does (or a new item loads), once: never on a timer, so a playing video is left alone.
  // Browsers refuse unmuted playback before any interaction: if it hasn't started a few seconds later with sound on,
  // ask the caller to drop to muted (always allowed), which plays it again.
  useEffect(() => {
    const cur = engine.current;
    if (!cur || cur.family === "clip" || cur.itemId !== playback.item.id) return;
    const { e } = cur;
    if (!playback.playing) {
      if (e.playing()) e.pause();
      return;
    }
    if (!e.playing()) e.play();
    if (!audible) return;
    const t = setTimeout(() => {
      if (latest.current.playing && !e.playing()) onBlocked?.();
    }, 4000);
    return () => clearTimeout(t);
  }, [playback.playing, playback.item.id, audible, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile loop: keep the position with the room. It doesn't press play: an embed that paused itself
  // (Twitch pauses whenever anything covers it, even for a moment) gets one resume after it's been stopped a while.
  useEffect(() => {
    const tick = () => {
      const cur = engine.current;
      const p = latest.current;
      if (!cur || cur.itemId !== p.item.id || cur.family === "clip") return;
      const { e } = cur;
      if (p.playing && !e.playing()) {
        if (++stalls.current % RESUME_AFTER_S === 0) e.play();
        return;
      }
      stalls.current = 0;
      if (!SEEKABLE[p.item.kind] || Date.now() - lastSeek.current < SEEK_COOLDOWN_MS) return;
      const drift = expectedPosition(p) - e.time();
      const off = Math.abs(drift) > (p.playing ? HARD_DRIFT_S : 0.4);
      onDrift?.(off);
      if (off) {
        e.seek(expectedPosition(p));
        lastSeek.current = Date.now();
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [playback, ready, onDrift]);

  return <div ref={host} className="player-host" />;
}
