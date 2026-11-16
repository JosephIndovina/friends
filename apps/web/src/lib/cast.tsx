import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectionState, createLocalScreenTracks, LocalTrack, Room, RoomEvent, Track, VideoPreset, VideoQuality,
  type LocalTrackPublication, type Participant, type RemoteTrackPublication, type TrackPublication,
} from "livekit-client";
import type { Session } from "@friends/shared";
import { api, ApiError, can } from "./api";
import { usePlayer } from "./player";
import { useSite } from "./site";

/** Go-live quality modes. Bitrate is the top layer; viewers on weaker connections get the lower layers. */
export interface StreamMode {
  id: string;
  label: string;
  detail: string;
  width: number;
  height: number;
  fps: number;
  /** max bitrate in kbps */
  kbps: number;
  /** "motion" favours frame rate (games, video); "detail" favours sharpness (text, code) */
  hint: "motion" | "detail";
}

export const STREAM_MODES: StreamMode[] = [
  { id: "game-smooth", label: "Game: smooth", detail: "1080p · 60 fps · 6 Mbps", width: 1920, height: 1080, fps: 60, kbps: 6000, hint: "motion" },
  { id: "game-light", label: "Game: light", detail: "720p · 60 fps · 3.5 Mbps", width: 1280, height: 720, fps: 60, kbps: 3500, hint: "motion" },
  { id: "balanced", label: "Balanced", detail: "1080p · 30 fps · 3 Mbps", width: 1920, height: 1080, fps: 30, kbps: 3000, hint: "motion" },
  { id: "sharp", label: "Sharp", detail: "1440p · 60 fps · 10 Mbps", width: 2560, height: 1440, fps: 60, kbps: 10000, hint: "motion" },
  { id: "text", label: "Text and code", detail: "1080p · 15 fps · 1.5 Mbps", width: 1920, height: 1080, fps: 15, kbps: 1500, hint: "detail" },
  { id: "low", label: "Low bandwidth", detail: "720p · 30 fps · 1.2 Mbps", width: 1280, height: 720, fps: 30, kbps: 1200, hint: "motion" },
];

/** Which copy of a stream this viewer receives. The server still drops lower if their connection can't keep up. */
export type StreamQuality = "high" | "medium" | "low";
export const STREAM_QUALITIES: { id: StreamQuality; label: string }[] = [
  { id: "high", label: "Best" },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Low" },
];
const LK_QUALITY = { high: VideoQuality.HIGH, medium: VideoQuality.MEDIUM, low: VideoQuality.LOW } as const;

/** One live stream: a screen-share video track plus its optional audio, from one person. */
export interface Stream {
  id: string; // stage source id
  identity: string;
  name: string;
  avatarUrl: string | null;
  label: string;
  /** published from this tab */
  local: boolean;
  /** published by you, from this tab or another of your tabs or devices */
  mine: boolean;
  /** the publisher's chosen mode, e.g. "1080p · 60 fps" */
  mode: string | null;
  video: TrackPublication;
  audio: TrackPublication | null;
}

interface CastCtx {
  available: boolean;
  streams: Stream[];
  canStream: boolean;
  /** browser can share a screen at all (not on phones) */
  supported: boolean;
  goLive: (mode: StreamMode) => Promise<string | null>;
  stop: (streamId: string) => Promise<void>;
  /** streams this viewer is watching: only these are received. Others' streams start unwatched; your own from this tab start watched. */
  watching: ReadonlySet<string>;
  setWatching: (id: string, on: boolean) => void;
  /** per-viewer stream sound */
  muted: ReadonlySet<string>;
  setMuted: (id: string, m: boolean) => void;
  volume: Readonly<Record<string, number>>;
  setVolume: (id: string, v: number) => void;
  /** per-viewer picture quality */
  quality: Readonly<Record<string, StreamQuality>>;
  setQuality: (id: string, q: StreamQuality) => void;
}

const Ctx = createContext<CastCtx | null>(null);
const SUPPORTED = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia) && !/Android|iPhone|iPad/i.test(navigator.userAgent);

function avatarOf(p: Participant): string | null {
  try {
    return (JSON.parse(p.metadata ?? "{}") as { avatarUrl?: string }).avatarUrl ?? null;
  } catch {
    return null;
  }
}

/** Pair screen-share videos with their audio by track name ("screen-2" ↔ "screen-2-audio"). */
function streamsOf(p: Participant, local: boolean, selfId: string): Stream[] {
  const pubs = [...p.trackPublications.values()];
  const videos = pubs.filter((t) => t.source === Track.Source.ScreenShare);
  return videos.map((v, i) => {
    const audio = pubs.find((t) => t.source === Track.Source.ScreenShareAudio && t.trackName === `${v.trackName}-audio`) ?? null;
    return {
      id: `cast:${p.identity}:${v.trackSid}`,
      identity: p.identity,
      name: p.name || p.identity,
      avatarUrl: avatarOf(p),
      label: videos.length > 1 ? `${p.name} (${i + 1})` : p.name || p.identity,
      local,
      mine: local || p.identity.split("#")[0] === selfId,
      mode: /~(.+)$/.exec(v.trackName)?.[1]?.replace(/_/g, " ") ?? null,
      video: v,
      audio,
    };
  });
}

export function CastProvider({ session, children }: { session: Session; children: React.ReactNode }) {
  const site = useSite();
  const allowed = can(session, "cast.watch") && site?.sections.cast !== false;
  const [room, setRoom] = useState<Room | null>(null);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [canStream, setCanStream] = useState(false);
  const [muted, setMutedSet] = useState<ReadonlySet<string>>(new Set());
  const [volume, setVolumes] = useState<Record<string, number>>({});
  const [quality, setQualities] = useState<Record<string, StreamQuality>>({});
  const [watching, setWatchingSet] = useState<ReadonlySet<string>>(new Set());
  const counter = useRef(0);

  // Connect while allowed; reconnect if the server drops us (e.g. after a role change).
  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    let current: Room | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    // One pending retry at most, backing off to 30s: a failed connect also fires Disconnected.
    const schedule = () => {
      if (cancelled || retry) return;
      const delay = Math.min(30_000, 2_000 * 2 ** attempt++);
      retry = setTimeout(() => {
        retry = null;
        void connect();
      }, delay);
    };
    const connect = async () => {
      let r: Room | null = null;
      try {
        const { token, canStream } = await api<{ token: string; canStream: boolean }>("POST", "/api/cast/token");
        if (cancelled) return;
        r = new Room({ adaptiveStream: false, dynacast: true }) // viewers pick quality themselves; adaptive stream would cap it by tile size;
        const room = r;
        current = room;
        const refresh = () => {
          const all = [...room.remoteParticipants.values()].flatMap((p) => streamsOf(p, false, session.user.id));
          setStreams([...streamsOf(room.localParticipant, true, session.user.id), ...all]);
        };
        room.on(RoomEvent.TrackPublished, refresh)
          .on(RoomEvent.TrackUnpublished, refresh)
          .on(RoomEvent.LocalTrackPublished, refresh)
          .on(RoomEvent.LocalTrackUnpublished, refresh)
          .on(RoomEvent.ParticipantConnected, refresh)
          .on(RoomEvent.ParticipantDisconnected, refresh)
          .on(RoomEvent.TrackSubscribed, refresh)
          .on(RoomEvent.TrackUnsubscribed, refresh)
          .on(RoomEvent.Disconnected, () => {
            if (current !== room) return;
            current = null;
            setStreams([]);
            setRoom(null);
            schedule();
          });
        await room.connect(`${location.origin.replace(/^http/, "ws")}/livekit`, token, { autoSubscribe: false });
        if (cancelled) return void room.disconnect();
        attempt = 0;
        setCanStream(canStream);
        setRoom(room);
        if (import.meta.env.DEV) (window as unknown as { __castRoom: Room }).__castRoom = room;
        refresh();
      } catch (e) {
        if (current === r) current = null;
        void r?.disconnect();
        if (!(e instanceof ApiError && e.status === 403)) schedule();
      }
    };
    void connect();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      void current?.disconnect();
      setRoom(null);
      setStreams([]);
    };
  }, [allowed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Your own stream from this tab starts watched (it costs nothing). Ended streams drop out of the set.
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const ids = new Set(streams.map((s) => s.id));
    const fresh = streams.filter((s) => s.local && !seen.current.has(s.id)).map((s) => s.id);
    for (const s of streams) seen.current.add(s.id);
    for (const id of seen.current) if (!ids.has(id)) seen.current.delete(id);
    setWatchingSet((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      for (const id of fresh) next.add(id);
      return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
    });
  }, [streams]);

  // Receive only the streams this viewer is watching: the rest use no bandwidth. Watched streams stay
  // received while they're off screen, so switching what's shown large doesn't reconnect.
  useEffect(() => {
    for (const s of streams) {
      if (s.local) continue;
      const on = watching.has(s.id);
      (s.video as RemoteTrackPublication).setSubscribed(on);
      if (on) (s.video as RemoteTrackPublication).setVideoQuality(LK_QUALITY[quality[s.id] ?? "high"]);
      // Your own stream from another tab is never played back, so don't fetch its sound.
      (s.audio as RemoteTrackPublication | null)?.setSubscribed(on && !s.mine);
    }
  }, [streams, watching, quality]);

  const goLive = useCallback(async (mode: StreamMode): Promise<string | null> => {
    if (!room) return "Not connected to the stage yet. Try again in a moment.";
    let tracks: LocalTrack[];
    try {
      tracks = await createLocalScreenTracks({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        resolution: { width: mode.width, height: mode.height, frameRate: mode.fps },
        contentHint: mode.hint,
        systemAudio: "include",
        selfBrowserSurface: "exclude",
      });
    } catch {
      return null; // picker cancelled
    }
    // The mode rides in the track name so viewers can see it: "screen-…~1080p_·_60_fps".
    const name = `screen-${Date.now().toString(36)}-${counter.current++}~${mode.detail.split(" · ").slice(0, 2).join(" · ").replace(/ /g, "_")}`;
    const pubs: LocalTrackPublication[] = [];
    try {
      for (const t of tracks) {
        const isVideo = t.kind === Track.Kind.Video;
        pubs.push(
          await room.localParticipant.publishTrack(t, {
            name: isVideo ? name : `${name}-audio`,
            source: isVideo ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio,
            simulcast: isVideo,
            // H.264 is hardware-encoded on most machines, so high frame rates don't pin the CPU.
            videoCodec: "h264",
            // Screen shares read screenShareEncoding, not videoEncoding; left unset, LiveKit caps them at 1080p 15 fps.
            screenShareEncoding: isVideo ? { maxBitrate: mode.kbps * 1000, maxFramerate: mode.fps, priority: "high" } : undefined,
            // Lower copies viewers can pick, or fall back to on weaker connections. Same frame rate as the top, up to 60 / 30.
            screenShareSimulcastLayers: isVideo ? [
              new VideoPreset(640, 360, Math.min(800_000, mode.kbps * 250), Math.min(mode.fps, 30)),
              new VideoPreset(1280, 720, Math.min(2_500_000, mode.kbps * 500), mode.fps),
            ] : undefined,
            degradationPreference: mode.hint === "detail" ? "maintain-resolution" : "maintain-framerate",
            dtx: false,
            red: false,
          }),
        );
        // The browser's own "Stop sharing" button ends the track: unpublish with it.
        t.mediaStreamTrack.addEventListener("ended", () => {
          for (const tt of tracks) void room.localParticipant.unpublishTrack(tt).catch(() => {});
        });
      }
      return null;
    } catch {
      tracks.forEach((t) => t.stop());
      return "Couldn’t go live. Check that you’re allowed to stream and try again.";
    }
  }, [room]);

  const stop = useCallback(
    async (id: string) => {
      const s = streams.find((x) => x.id === id);
      if (!s) return;
      if (s.local && room) {
        for (const pub of [s.video, s.audio]) {
          const t = (pub as LocalTrackPublication | null)?.track;
          if (t) await room.localParticipant.unpublishTrack(t).catch(() => {});
        }
      } else {
        await api("POST", `/api/cast/${encodeURIComponent(s.identity)}/stop`).catch(() => {});
      }
    },
    [streams, room],
  );

  const setMuted = useCallback((id: string, m: boolean) => setMutedSet((prev) => {
    const next = new Set(prev);
    if (m) next.add(id);
    else next.delete(id);
    return next;
  }), []);
  const setVolume = useCallback((id: string, v: number) => setVolumes((prev) => ({ ...prev, [id]: v })), []);
  const setQuality = useCallback((id: string, q: StreamQuality) => setQualities((prev) => ({ ...prev, [id]: q })), []);
  const setWatching = useCallback((id: string, on: boolean) => setWatchingSet((prev) => {
    if (prev.has(id) === on) return prev;
    const next = new Set(prev);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  }), []);

  const value = useMemo<CastCtx>(
    () => ({ available: room?.state === ConnectionState.Connected, streams, canStream, supported: SUPPORTED, goLive, stop, watching, setWatching, muted, setMuted, volume, setVolume, quality, setQuality }),
    [room, streams, canStream, goLive, stop, watching, setWatching, muted, setMuted, volume, setVolume, quality, setQuality],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCast() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCast outside CastProvider");
  return c;
}

/** A stream's picture. Which copy arrives is the viewer's quality choice (see setQuality). */
export function StreamVideo({ stream, className, stats }: { stream: Stream; className?: string; stats?: "full" | "compact" }) {
  const el = useRef<HTMLVideoElement>(null);
  const track = stream.video.track;
  useEffect(() => {
    if (!track || !el.current) return;
    track.attach(el.current);
    const v = el.current;
    return () => void track.detach(v);
  }, [track]);
  if (!track) return <div className={`${className ?? ""} stream-waiting`}>Connecting…</div>;
  return (
    <>
      <video ref={el} className={className} autoPlay playsInline muted />
      {stats && <StreamStats stream={stream} compact={stats === "compact"} />}
    </>
  );
}

type Stat = Record<string, unknown> & { id: string; type: string; timestamp: number };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rate = (kbps: number | null) => (kbps == null ? "–" : kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`);
const codecOf = (report: Map<string, Stat>, s: Stat | undefined) => {
  const c = s && report.get(s.codecId as string);
  return c ? String(c.mimeType).split("/")[1] ?? "" : "";
};
/** The connection's active candidate pair (round trip and the bandwidth estimate live there). */
function pairOf(report: Map<string, Stat>): Stat | undefined {
  const all = [...report.values()];
  const transport = all.find((s) => s.type === "transport" && s.selectedCandidatePairId);
  return (transport && report.get(transport.selectedCandidatePairId as string))
    ?? all.find((s) => s.type === "candidate-pair" && s.nominated && s.state === "succeeded");
}

/** Live connection numbers for one stream, read from WebRTC stats once a second. */
function useStreamStats(stream: Stream): [string, string][] {
  const [rows, setRows] = useState<[string, string][]>([]);
  const video = stream.video.track;
  const audio = stream.mine && !stream.local ? null : stream.audio?.track ?? null;
  useEffect(() => {
    if (!video) return;
    const prev = new Map<string, { bytes: number; t: number }>();
    // kbps from the change in a byte counter since the last read.
    const kbps = (key: string, bytes: unknown, t: number) => {
      const b = num(bytes);
      if (b == null) return null;
      const p = prev.get(key);
      prev.set(key, { bytes: b, t });
      return p && t > p.t ? ((b - p.bytes) * 8) / (t - p.t) : null;
    };
    let alive = true;
    const read = async () => {
      const [vr, ar] = await Promise.all([video.getRTCStatsReport(), audio?.getRTCStatsReport()]).catch(() => [undefined, undefined]);
      if (!alive || !vr) return;
      const v = vr as unknown as Map<string, Stat>;
      const a = ar as unknown as Map<string, Stat> | undefined;
      const out: [string, string][] = [];
      const pair = pairOf(v);
      const rtt = num(pair?.currentRoundTripTime);
      if (stream.local) {
        // Sending: one line per simulcast layer, biggest first.
        const layers = [...v.values()].filter((s) => s.type === "outbound-rtp" && s.kind === "video")
          .sort((x, y) => (num(y.frameWidth) ?? 0) - (num(x.frameWidth) ?? 0));
        for (const l of layers) {
          if (!num(l.frameWidth)) continue;
          out.push([`Layer ${l.rid ?? ""}`.trim(), `${l.frameWidth}×${l.frameHeight} · ${Math.round(num(l.framesPerSecond) ?? 0)} fps · ${rate(kbps(l.id, l.bytesSent, l.timestamp))}`]);
        }
        const top = layers[0];
        if (top) {
          out.push(["Codec", [codecOf(v, top), top.encoderImplementation].filter(Boolean).join(" · ") || "–"]);
          const why = top.qualityLimitationReason as string | undefined;
          out.push(["Limited by", !why || why === "none" ? "Nothing" : why === "cpu" ? "CPU" : why === "bandwidth" ? "Upload speed" : why]);
        }
        const up = num(pair?.availableOutgoingBitrate);
        if (up != null) out.push(["Upload estimate", rate(up / 1000)]);
      } else {
        const s = [...v.values()].find((x) => x.type === "inbound-rtp" && x.kind === "video");
        if (s) {
          out.push(["Resolution", num(s.frameWidth) ? `${s.frameWidth}×${s.frameHeight}` : "–"]);
          out.push(["Frame rate", `${Math.round(num(s.framesPerSecond) ?? 0)} fps`]);
          out.push(["Video", [rate(kbps(s.id, s.bytesReceived, s.timestamp)), codecOf(v, s)].filter(Boolean).join(" · ")]);
          const got = num(s.packetsReceived) ?? 0;
          const lost = num(s.packetsLost) ?? 0;
          out.push(["Packet loss", got + lost ? `${((lost / (got + lost)) * 100).toFixed(2)}%` : "–"]);
          out.push(["Dropped frames", `${num(s.framesDropped) ?? 0} of ${num(s.framesReceived) ?? num(s.framesDecoded) ?? 0}`]);
          const jitter = num(s.jitter);
          if (jitter != null) out.push(["Jitter", `${Math.round(jitter * 1000)} ms`]);
          if (s.decoderImplementation) out.push(["Decoder", String(s.decoderImplementation)]);
        }
      }
      if (rtt != null) out.push(["Round trip", `${Math.round(rtt * 1000)} ms`]);
      // Sound: whether it exists, arrives, and carries any signal.
      if (!stream.audio) out.push(["Audio", "None shared"]);
      else if (!a) out.push(["Audio", stream.local ? "Sending" : "Not received"]);
      else {
        const s = [...a.values()].find((x) => (x.type === "inbound-rtp" || x.type === "outbound-rtp") && x.kind === "audio");
        const level = num(s?.audioLevel) ?? num([...a.values()].find((x) => x.type === "media-source" && x.kind === "audio")?.audioLevel);
        out.push(["Audio", s ? [rate(kbps(s.id, s.bytesReceived ?? s.bytesSent, s.timestamp)), codecOf(a, s), level != null ? `level ${Math.round(level * 100)}%` : ""].filter(Boolean).join(" · ") : "Connecting"]);
      }
      if (stream.mode) out.push(["Sent as", stream.mode]);
      setRows(out);
    };
    void read();
    const t = setInterval(read, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [video, audio, stream.local, stream.audio, stream.mode]);
  return rows;
}

const COMPACT = new Set(["Resolution", "Frame rate", "Video", "Packet loss", "Audio"]);

/** Stats overlay for a stream: resolution, frame rate, bitrate, loss and sound. */
function StreamStats({ stream, compact }: { stream: Stream; compact: boolean }) {
  const rows = useStreamStats(stream);
  const shown = compact ? rows.filter(([k]) => COMPACT.has(k) || k.startsWith("Layer")) : rows;
  if (!shown.length) return null;
  return (
    <dl className={`stream-stats${compact ? " is-compact" : ""}`} aria-label="Stream stats">
      {shown.map(([k, val]) => (
        <div key={k}><dt>{k}</dt><dd>{val}</dd></div>
      ))}
    </dl>
  );
}

/** A stream's sound, with this viewer's own volume and mute. */
export function StreamAudio({ stream }: { stream: Stream }) {
  const cast = useCast();
  const player = usePlayer();
  const el = useRef<HTMLAudioElement>(null);
  const track = stream.mine ? null : stream.audio?.track; // never play your own stream back to yourself
  useEffect(() => {
    if (!track || !el.current) return;
    track.attach(el.current);
    const a = el.current;
    return () => void track.detach(a);
  }, [track]);
  useEffect(() => {
    if (!el.current) return;
    el.current.muted = cast.muted.has(stream.id) || player.blocked;
    el.current.volume = (cast.volume[stream.id] ?? 100) / 100;
  });
  // Browsers refuse sound until the viewer has clicked the page. If that happens, say so, and play
  // again once the first click unblocks it (otherwise the element stays paused and silent).
  const { blocked, setBlocked } = player;
  useEffect(() => {
    const a = el.current;
    if (!a || !track || blocked || !a.paused) return;
    void a.play().catch((e: unknown) => {
      if (e instanceof DOMException && e.name === "NotAllowedError") setBlocked(true);
    });
  }, [track, blocked, setBlocked]);
  return track ? <audio ref={el} autoPlay /> : null;
}
