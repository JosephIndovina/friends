import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectionState, createLocalScreenTracks, LocalTrack, Room, RoomEvent, ScreenSharePresets, Track,
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
  /** per-viewer stream sound */
  muted: ReadonlySet<string>;
  setMuted: (id: string, m: boolean) => void;
  volume: Readonly<Record<string, number>>;
  setVolume: (id: string, v: number) => void;
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
  const player = usePlayer();
  const allowed = can(session, "cast.watch") && site?.sections.cast !== false;
  const [room, setRoom] = useState<Room | null>(null);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [canStream, setCanStream] = useState(false);
  const [muted, setMutedSet] = useState<ReadonlySet<string>>(new Set());
  const [volume, setVolumes] = useState<Record<string, number>>({});
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
        r = new Room({ adaptiveStream: true, dynacast: true });
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

  // Receive only what this viewer shows on their stage: hidden streams use no bandwidth.
  useEffect(() => {
    for (const s of streams) {
      if (s.local) continue;
      const show = !player.hidden.has(s.id);
      (s.video as RemoteTrackPublication).setSubscribed(show);
      // Your own stream from another tab is never played back, so don't fetch its sound.
      (s.audio as RemoteTrackPublication | null)?.setSubscribed(show && !s.mine);
    }
  }, [streams, player.hidden]);

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
            videoEncoding: isVideo ? { maxBitrate: mode.kbps * 1000, maxFramerate: mode.fps, priority: "high" } : undefined,
            // Lower layers for thumbnails and weaker connections.
            screenShareSimulcastLayers: isVideo ? [ScreenSharePresets.h360fps15, ScreenSharePresets.h720fps30] : undefined,
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

  const value = useMemo<CastCtx>(
    () => ({ available: room?.state === ConnectionState.Connected, streams, canStream, supported: SUPPORTED, goLive, stop, muted, setMuted, volume, setVolume }),
    [room, streams, canStream, goLive, stop, muted, setMuted, volume, setVolume],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCast() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCast outside CastProvider");
  return c;
}

/** A stream's picture. Attaching sizes the element, which tells LiveKit which quality layer to send. */
export function StreamVideo({ stream, className }: { stream: Stream; className?: string }) {
  const el = useRef<HTMLVideoElement>(null);
  const track = stream.video.track;
  useEffect(() => {
    if (!track || !el.current) return;
    track.attach(el.current);
    const v = el.current;
    return () => void track.detach(v);
  }, [track]);
  return track ? <video ref={el} className={className} autoPlay playsInline muted /> : <div className={`${className ?? ""} stream-waiting`}>Connecting…</div>;
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
  return track ? <audio ref={el} autoPlay /> : null;
}
