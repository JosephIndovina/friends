import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { TTS_DEFAULT_VOICE, TTS_VOICES, type Session, type Sound, type TtsSpoken } from "@friends/shared";
import { api, ApiError, can } from "./api";
import { getSocket } from "./socket";

/**
 * The soundboard's audio. Every sound is fetched and decoded ahead of time, so a press (yours or anyone's)
 * starts within a few milliseconds of the event arriving: the network hop is the only real delay.
 */
const engine = (() => {
  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  // Decoding needs a context, but a live one created before any click only logs autoplay warnings.
  let decoder: OfflineAudioContext | null = null;
  const buffers = new Map<string, Promise<AudioBuffer | null>>();
  const voices: AudioBufferSourceNode[] = [];
  let level = 1;

  function live() {
    if (!ctx) {
      ctx = new AudioContext({ latencyHint: "interactive" });
      gain = ctx.createGain();
      gain.gain.value = level;
      // A limiter after the volume: one sound passes untouched, a stack of them gets loud without clipping into noise.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.15;
      gain.connect(limiter).connect(ctx.destination);
    }
    return ctx;
  }

  return {
    /** Called from any click or key press: browsers only start audio after one. */
    unlock() {
      const c = live();
      if (c.state !== "running") void c.resume().catch(() => {});
    },
    load(sound: Sound) {
      if (buffers.has(sound.id)) return;
      decoder ??= new OfflineAudioContext(2, 1, 48000);
      const d = decoder;
      buffers.set(sound.id, fetch(sound.url, { credentials: "same-origin" })
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((b) => d.decodeAudioData(b))
        .catch(() => {
          buffers.delete(sound.id); // try again next time it's played
          return null;
        }));
    },
    forget(keep: Set<string>) {
      for (const id of buffers.keys()) if (!keep.has(id)) buffers.delete(id);
    },
    setLevel(v: number) {
      level = v;
      if (gain && ctx) gain.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
    },
    /** `fromClick`: our own press, which also unlocks audio. Someone else's sound is skipped while audio is locked: it would only play late. */
    play(id: string, fromClick: boolean) {
      if (fromClick) this.unlock();
      return this.start(buffers.get(id), fromClick);
    },
    /** A text-to-speech clip: fetched when it's said, not ahead of time. Not kept: each line is usually said once. */
    playUrl(url: string) {
      if (ctx?.state !== "running") return;
      decoder ??= new OfflineAudioContext(2, 1, 48000);
      const d = decoder;
      return this.start(fetch(url, { credentials: "same-origin" })
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((b) => d.decodeAudioData(b))
        .catch(() => null), false);
    },
    async start(pending: Promise<AudioBuffer | null> | undefined, fromClick: boolean) {
      const c = ctx;
      if (!c || (!fromClick && c.state !== "running")) return;
      const buf = await pending;
      if (!buf) return;
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(gain!);
      src.onended = () => {
        const i = voices.indexOf(src);
        if (i >= 0) voices.splice(i, 1);
      };
      // Sounds stack freely. Only a truly huge pile-up drops the oldest, to keep the browser responsive.
      while (voices.length >= 64) voices.shift()!.stop();
      voices.push(src);
      src.start();
    },
  };
})();

/** What someone just did on the soundboard, shown over their avatar for a moment. */
export interface Played { emoji: string | null; title: string; key: number }

interface SoundsCtx {
  enabled: boolean;
  list: Sound[] | null;
  reload: () => Promise<void>;
  /** play for everyone; rejects with an error code */
  play: (sound: Sound) => Promise<void>;
  volume: number;
  setVolume: (v: number) => void;
  muted: boolean;
  setMuted: (m: boolean) => void;
  /** the sound each person last played, for a moment, by user id */
  recent: ReadonlyMap<string, Played>;
  /** may use text to speech */
  canSpeak: boolean;
  /** say `text` for everyone in your voice; rejects with an error code */
  speak: (text: string) => Promise<void>;
  voice: string;
  setVoice: (v: string) => void;
}

const Ctx = createContext<SoundsCtx | null>(null);

function read(key: string, fallback: number) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : Number(v);
  } catch {
    return fallback;
  }
}

const SHOW_MS = 2500;

export function SoundsProvider({ session, children }: { session: Session; children: React.ReactNode }) {
  const enabled = can(session, "sounds.play");
  const [list, setList] = useState<Sound[] | null>(null);
  const [volume, setVolume] = useState(() => {
    const v = read("sounds.volume", 70);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 70;
  });
  const [muted, setMuted] = useState(() => read("sounds.muted", 0) === 1);
  const [recent, setRecent] = useState<ReadonlyMap<string, Played>>(new Map());
  const canSpeak = enabled && can(session, "tts.speak");
  const [voice, setVoice] = useState(() => {
    try {
      const v = localStorage.getItem("tts.voice");
      if (v && TTS_VOICES.some((x) => x.id === v)) return v;
    } catch {
      /* default */
    }
    return TTS_DEFAULT_VOICE;
  });
  const listRef = useRef<Sound[]>([]);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const nextKey = useRef(1);

  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      const sounds = await api<Sound[]>("GET", "/api/sounds");
      listRef.current = sounds;
      setList(sounds);
      for (const s of sounds) engine.load(s);
      engine.forget(new Set(sounds.map((s) => s.id)));
    } catch {
      setList((l) => l ?? []);
    }
  }, [enabled]);

  const show = useCallback((userId: string, what: Omit<Played, "key">) => {
    const key = nextKey.current++;
    setRecent((m) => new Map(m).set(userId, { ...what, key }));
    setTimeout(() => setRecent((m) => {
      if (m.get(userId)?.key !== key) return m;
      const next = new Map(m);
      next.delete(userId);
      return next;
    }), SHOW_MS);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    const s = getSocket();
    const changed = () => void reload();
    const played = ({ id, by }: { id: string; by: { id: string } }) => {
      const sound = listRef.current.find((x) => x.id === id);
      if (!sound) return void reload();
      show(by.id, { emoji: sound.emoji, title: `played ${sound.name}` });
      if (!mutedRef.current) void engine.play(id, false);
    };
    // Sent to everyone, the speaker included, once the clip is ready.
    const spoken = ({ url, text, by }: TtsSpoken) => {
      show(by.id, { emoji: "💬", title: `said “${text}”` });
      if (!mutedRef.current) void engine.playUrl(url);
    };
    s.on("sounds:changed", changed);
    s.on("connect", changed);
    s.on("sound:played", played);
    s.on("tts:spoken", spoken);
    const unlock = () => engine.unlock();
    document.addEventListener("pointerdown", unlock, { capture: true });
    document.addEventListener("keydown", unlock, { capture: true });
    return () => {
      s.off("sounds:changed", changed);
      s.off("connect", changed);
      s.off("sound:played", played);
      s.off("tts:spoken", spoken);
      document.removeEventListener("pointerdown", unlock, { capture: true });
      document.removeEventListener("keydown", unlock, { capture: true });
    };
  }, [enabled, reload, show]);

  useEffect(() => {
    engine.setLevel(muted ? 0 : volume / 100);
    try {
      localStorage.setItem("sounds.volume", String(volume));
      localStorage.setItem("sounds.muted", muted ? "1" : "0");
    } catch {
      /* this visit only */
    }
  }, [volume, muted]);

  useEffect(() => {
    try {
      localStorage.setItem("tts.voice", voice);
    } catch {
      /* this visit only */
    }
  }, [voice]);

  const speak = useCallback(async (text: string) => {
    // The press unlocks audio, so the clip can play when it comes back.
    engine.unlock();
    if (!getSocket().connected) throw new Error("offline");
    await api("POST", "/api/tts", { text, voice });
  }, [voice]);

  const me = session.user.id;
  const play = useCallback(async (sound: Sound) => {
    const s = getSocket();
    // Never queue a press while offline: it would go off whenever the connection came back.
    if (!s.connected) throw new Error("offline");
    // Heard here at once; everyone else hears it when the broadcast reaches them.
    void engine.play(sound.id, true);
    show(me, { emoji: sound.emoji, title: `played ${sound.name}` });
    await new Promise<void>((resolve, reject) =>
      s.emit("sound:play", { id: sound.id }, (res) => (res.ok ? resolve() : reject(new Error(res.error)))));
  }, [me, show]);

  const value = useMemo(
    () => ({ enabled, list, reload, play, volume, setVolume, muted, setMuted, recent, canSpeak, speak, voice, setVoice }),
    [enabled, list, reload, play, volume, muted, recent, canSpeak, speak, voice],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSounds() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSounds outside SoundsProvider");
  return c;
}

export const SOUND_ERRORS: Record<string, string> = {
  offline: "Not connected. Wait a moment and try again.",
  not_found: "That sound was deleted.",
  missing_permission: "You don’t have permission to do that.",
  board_full: "The soundboard is full. Delete a sound first.",
  too_many_yours: "You’ve added the most sounds one person can. Delete one of yours first.",
  file_too_large: "That file is too big. Sounds can be up to 50 MB.",
  too_long: "That sound is too long. Sounds can be up to 1 minute.",
  unsupported_type: "That file type isn’t supported. Use MP3, OGG, WAV, M4A or FLAC.",
  unreadable_audio: "That file has no audio that can be read.",
  invalid_name: "Give the sound a name, up to 32 characters.",
  invalid_emoji: "Use a single emoji, or leave it empty.",
  not_yours: "You can only delete your own sounds.",
  invalid_text: "Type something to say. Links and emoji aren’t read out.",
  invalid_voice: "That voice isn’t available. Pick another.",
  busy: "Text to speech is busy. Try again in a moment.",
  tts_failed: "Text to speech didn’t work. Try again.",
  rate_limited: "You’re sending messages too fast. Wait a moment.",
};

export const soundError = (e: unknown) =>
  (e instanceof ApiError && e.status === 429 ? SOUND_ERRORS.rate_limited : SOUND_ERRORS[(e as Error)?.message]) ?? "Something went wrong. Try again.";
