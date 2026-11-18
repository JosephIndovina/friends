import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Move, VideoOff } from "lucide-react";
import {
  ConnectionState, createLocalScreenTracks, createLocalVideoTrack, LocalTrack, Room, RoomEvent, Track, VideoPresets,
  type LocalTrackPublication, type LocalVideoTrack, type Participant, type RemoteTrackPublication, type TrackPublication,
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

/** One live stream: a screen-share video track plus its optional audio, from one person. Or, for someone with a
 * camera on who isn't streaming, their camera on its own. */
export interface Stream {
  id: string; // stage source id
  kind: "screen" | "camera";
  /** the person (one person can be connected from several tabs, devices and Friends Live) */
  userId: string;
  identity: string;
  name: string;
  avatarUrl: string | null;
  label: string;
  /** published from this tab */
  local: boolean;
  /** published by you, from this tab or another of your tabs or devices */
  mine: boolean;
  /** streamed by the Friends Live app, which can be asked to change window */
  fromApp: boolean;
  /** the publisher's chosen mode, e.g. "1080p · 60 fps" */
  mode: string | null;
  video: TrackPublication;
  audio: TrackPublication | null;
  /** the streamer's camera, shown over their (first) screen stream */
  camera: TrackPublication | null;
  /** that camera is this tab's own */
  cameraLocal: boolean;
  /** the connection sending the camera */
  cameraIdentity: string | null;
  /** where the camera sits and how big, as its owner set it (everyone sees the same) */
  cameraLayout: CameraLayout;
}

/** Where a camera sits over its owner's stream, and its width as a share of the stream's width. */
export type Corner = "br" | "bl" | "tl" | "tr";
export interface CameraLayout {
  corner: Corner;
  size: number;
}
const CORNERS: Corner[] = ["br", "bl", "tl", "tr"];
const SIZE_MIN = 0.1;
const SIZE_MAX = 0.5;
const DEFAULT_LAYOUT: CameraLayout = { corner: "br", size: 0.22 };
const clampSize = (v: number) => Math.min(SIZE_MAX, Math.max(SIZE_MIN, v));
const sameLayout = (a: CameraLayout, b: CameraLayout) => a.corner === b.corner && Math.abs(a.size - b.size) < 0.001;

/** The layout the server set on the camera's connection ("br:0.220"). */
function layoutOf(p: Participant): CameraLayout {
  const [corner, size] = (p.attributes?.camera ?? "").split(":");
  const n = Number(size);
  return CORNERS.includes(corner as Corner) && Number.isFinite(n) ? { corner: corner as Corner, size: clampSize(n) } : DEFAULT_LAYOUT;
}

/** Your last layout, sent with your camera each time you turn it on. */
const LAYOUT_KEY = "cameraLayout";
function savedLayout(): CameraLayout {
  try {
    const l = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null") as CameraLayout | null;
    if (l && CORNERS.includes(l.corner) && Number.isFinite(l.size)) return { corner: l.corner, size: clampSize(l.size) };
  } catch {
    /* default */
  }
  return DEFAULT_LAYOUT;
}

/** Set where your camera sits, for everyone. Only works for your own camera (the server checks). */
export async function setCameraLayout(identity: string, layout: CameraLayout): Promise<boolean> {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* this visit only */
  }
  try {
    await api("POST", "/api/cast/camera/layout", { identity, corner: layout.corner, size: layout.size });
    return true;
  } catch {
    return false;
  }
}

/** Your camera, from this tab. */
export interface CameraCtl {
  /** you can stream and the admin allows cameras */
  allowed: boolean;
  on: boolean;
  busy: boolean;
  error: string | null;
  set: (on: boolean) => Promise<void>;
  devices: MediaDeviceInfo[];
  deviceId: string | null;
  setDevice: (id: string) => void;
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
  camera: CameraCtl;
  /** people whose camera this viewer has hidden (by user id), for this visit */
  hiddenCameras: ReadonlySet<string>;
  setCameraHidden: (userId: string, hidden: boolean) => void;
}

const Ctx = createContext<CastCtx | null>(null);
const SUPPORTED = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia) && !/Android|iPhone|iPad/i.test(navigator.userAgent);

/** Streamed by the Friends Live app (its token marks it). */
function fromApp(p: Participant): boolean {
  try {
    return (JSON.parse(p.metadata ?? "{}") as { app?: boolean }).app === true;
  } catch {
    return false;
  }
}

function avatarOf(p: Participant): string | null {
  try {
    return (JSON.parse(p.metadata ?? "{}") as { avatarUrl?: string }).avatarUrl ?? null;
  } catch {
    return null;
  }
}

const userOf = (identity: string) => identity.split("#")[0]!;
const CAN_CAMERA = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
const CAMERA_KEY = "cameraDevice";

/** Pair screen-share videos with their audio by track name ("screen-2" ↔ "screen-2-audio"). */
function streamsOf(p: Participant, local: boolean, selfId: string): Stream[] {
  const pubs = [...p.trackPublications.values()];
  const videos = pubs.filter((t) => t.source === Track.Source.ScreenShare);
  return videos.map((v, i) => {
    const audio = pubs.find((t) => t.source === Track.Source.ScreenShareAudio && t.trackName === `${v.trackName}-audio`) ?? null;
    return {
      id: `cast:${p.identity}:${v.trackSid}`,
      kind: "screen",
      userId: userOf(p.identity),
      identity: p.identity,
      name: p.name || p.identity,
      avatarUrl: avatarOf(p),
      fromApp: fromApp(p),
      label: videos.length > 1 ? `${p.name} (${i + 1})` : p.name || p.identity,
      local,
      mine: local || userOf(p.identity) === selfId,
      mode: /~(.+)$/.exec(v.trackName)?.[1]?.replace(/_/g, " ") ?? null,
      video: v,
      audio,
      camera: null,
      cameraLocal: false,
      cameraIdentity: null,
      cameraLayout: DEFAULT_LAYOUT,
    };
  });
}

/** Everyone's streams. A camera rides on its owner's first screen stream, from whichever tab or app that is (the
 * camera comes from the site, the screen often from Friends Live); with no screen stream it's a source of its own. */
function allStreams(room: Room, selfId: string): Stream[] {
  const people: [Participant, boolean][] = [[room.localParticipant, true], ...[...room.remoteParticipants.values()].map((p) => [p, false] as [Participant, boolean])];
  const screens = people.flatMap(([p, local]) => streamsOf(p, local, selfId));
  const out = [...screens];
  for (const [p, local] of people) {
    const cam = [...p.trackPublications.values()].find((t) => t.source === Track.Source.Camera);
    if (!cam) continue;
    const userId = userOf(p.identity);
    const host = screens.find((s) => s.userId === userId);
    if (host) {
      if (!host.camera) Object.assign(host, { camera: cam, cameraLocal: local, cameraIdentity: p.identity, cameraLayout: layoutOf(p) });
      continue;
    }
    out.push({
      id: `cam:${p.identity}:${cam.trackSid}`,
      kind: "camera",
      userId,
      identity: p.identity,
      name: p.name || p.identity,
      avatarUrl: avatarOf(p),
      fromApp: false,
      label: p.name || p.identity,
      local,
      mine: local || userId === selfId,
      mode: null,
      video: cam,
      audio: null,
      camera: null,
      cameraLocal: false,
      cameraIdentity: null,
      cameraLayout: DEFAULT_LAYOUT,
    });
  }
  return out;
}

export function CastProvider({ session, children }: { session: Session; children: React.ReactNode }) {
  const site = useSite();
  const allowed = can(session, "cast.watch") && site?.sections.cast !== false;
  const [room, setRoom] = useState<Room | null>(null);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [canStream, setCanStream] = useState(false);
  const [muted, setMutedSet] = useState<ReadonlySet<string>>(new Set());
  const [volume, setVolumes] = useState<Record<string, number>>({});
  const [watching, setWatchingSet] = useState<ReadonlySet<string>>(new Set());
  const [hiddenCameras, setHiddenCameras] = useState<ReadonlySet<string>>(new Set());
  const counter = useRef(0);
  const camerasAllowed = site?.cameras !== false;
  // This tab's camera track, while it's on.
  const camTrack = useRef<LocalVideoTrack | null>(null);
  const [camOn, setCamOn] = useState(false);
  const [camBusy, setCamBusy] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [camDevices, setCamDevices] = useState<MediaDeviceInfo[]>([]);
  const [camDevice, setCamDevice] = useState<string | null>(() => {
    try {
      return localStorage.getItem(CAMERA_KEY);
    } catch {
      return null;
    }
  });

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
        r = new Room({ adaptiveStream: false, dynacast: true }) // one copy per stream, so nothing to adapt; adaptive stream would also pause it when off screen
        const room = r;
        current = room;
        const refresh = () => setStreams(allStreams(room, session.user.id));
        room.on(RoomEvent.TrackPublished, refresh)
          .on(RoomEvent.TrackUnpublished, refresh)
          .on(RoomEvent.LocalTrackPublished, refresh)
          .on(RoomEvent.LocalTrackUnpublished, refresh)
          .on(RoomEvent.ParticipantConnected, refresh)
          .on(RoomEvent.ParticipantDisconnected, refresh)
          .on(RoomEvent.TrackSubscribed, refresh)
          .on(RoomEvent.TrackUnsubscribed, refresh)
          .on(RoomEvent.ParticipantAttributesChanged, refresh) // a camera moved
          .on(RoomEvent.Disconnected, () => {
            if (current !== room) return;
            current = null;
            setStreams([]);
            setRoom(null);
            camTrack.current?.stop();
            camTrack.current = null;
            setCamOn(false);
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
      camTrack.current?.stop();
      camTrack.current = null;
      setCamOn(false);
      setRoom(null);
      setStreams([]);
    };
  }, [allowed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Your own stream from this tab starts watched (it costs nothing). Ended streams drop out of the set.
  // Your own stream from elsewhere (the app, another tab or device) starts muted: on the computer that's
  // streaming it would echo, but on your phone you'll want it, so it's one tap to turn on.
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const ids = new Set(streams.map((s) => s.id));
    const fresh = streams.filter((s) => s.local && !seen.current.has(s.id)).map((s) => s.id);
    const ownElsewhere = streams.filter((s) => s.mine && !s.local && !seen.current.has(s.id)).map((s) => s.id);
    if (ownElsewhere.length) setMutedSet((prev) => new Set([...prev, ...ownElsewhere]));
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
      const on = watching.has(s.id);
      // The camera over a stream comes with it, unless this viewer hid it (or the admin turned cameras off).
      if (s.camera && !s.cameraLocal) (s.camera as RemoteTrackPublication).setSubscribed(on && camerasAllowed && !hiddenCameras.has(s.userId));
      if (s.local) continue;
      (s.video as RemoteTrackPublication).setSubscribed(on && (s.kind === "screen" || camerasAllowed));
      (s.audio as RemoteTrackPublication | null)?.setSubscribed(on);
    }
  }, [streams, watching, hiddenCameras, camerasAllowed]);

  const loadCamDevices = useCallback(async () => {
    const all = await Room.getLocalDevices("videoinput", false).catch(() => [] as MediaDeviceInfo[]);
    setCamDevices(all.filter((d) => d.deviceId));
  }, []);
  useEffect(() => {
    if (!CAN_CAMERA) return;
    void loadCamDevices();
    navigator.mediaDevices.addEventListener?.("devicechange", loadCamDevices);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", loadCamDevices);
  }, [loadCamDevices]);

  const stopCamera = useCallback(async () => {
    const t = camTrack.current;
    camTrack.current = null;
    setCamOn(false);
    if (!t) return;
    if (room) await room.localParticipant.unpublishTrack(t).catch(() => {});
    t.stop();
  }, [room]);

  const setCamera = useCallback(async (on: boolean) => {
    setCamError(null);
    if (!on) return stopCamera();
    if (camTrack.current) return;
    if (!room) return setCamError("Not connected to the stage yet. Try again in a moment.");
    setCamBusy(true);
    let t: LocalVideoTrack;
    try {
      t = await createLocalVideoTrack({ deviceId: camDevice ?? undefined, resolution: VideoPresets.h720.resolution });
    } catch (e) {
      setCamBusy(false);
      const blocked = e instanceof Error && /NotAllowed|Permission/i.test(e.name + e.message);
      return setCamError(blocked ? "The browser blocked the camera. Allow it in this site's settings, then try again." : "Couldn’t start the camera. Check that it isn’t in use by another app.");
    }
    try {
      await room.localParticipant.publishTrack(t, {
        name: "camera",
        source: Track.Source.Camera,
        simulcast: false,
        videoCodec: "vp8",
        videoEncoding: { maxBitrate: 1_500_000, maxFramerate: 30 },
      });
    } catch {
      t.stop();
      setCamBusy(false);
      return setCamError("Couldn’t turn on the camera. Check that you’re allowed to stream and try again.");
    }
    camTrack.current = t;
    setCamOn(true);
    setCamBusy(false);
    void setCameraLayout(room.localParticipant.identity, savedLayout()); // where you left it last time
    // Unplugged, or taken by another app.
    t.mediaStreamTrack.addEventListener("ended", () => {
      if (camTrack.current === t) void stopCamera();
    });
    void loadCamDevices(); // names show once the browser has asked
  }, [room, camDevice, stopCamera, loadCamDevices]);

  const setDevice = useCallback((id: string) => {
    setCamDevice(id);
    try {
      localStorage.setItem(CAMERA_KEY, id);
    } catch {
      /* this visit only */
    }
    void camTrack.current?.setDeviceId(id);
  }, []);

  // The admin turned cameras off, or you can no longer stream: turn this tab's off.
  useEffect(() => {
    if (camOn && (!camerasAllowed || !canStream)) void stopCamera();
  }, [camOn, camerasAllowed, canStream, stopCamera]);


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
            // One copy at the streamer's chosen quality, like Discord's Go Live: no lower copies for the
            // browser to juggle, so it never shrinks the picture to keep them all going. VP8 encodes well in
            // software in every browser; H.264 falls back to a slow software encoder wherever there's no hardware one.
            simulcast: false,
            videoCodec: "vp8",
            // Screen shares read screenShareEncoding, not videoEncoding; left unset, LiveKit caps them at 1080p 15 fps.
            screenShareEncoding: isVideo ? { maxBitrate: mode.kbps * 1000, maxFramerate: mode.fps, priority: "high" } : undefined,
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
      if (s.kind === "camera" && s.local) await stopCamera();
      else if (s.local && room) {
        for (const pub of [s.video, s.audio]) {
          const t = (pub as LocalTrackPublication | null)?.track;
          if (t) await room.localParticipant.unpublishTrack(t).catch(() => {});
        }
      } else {
        await api("POST", `/api/cast/${encodeURIComponent(s.identity)}/stop`).catch(() => {});
      }
    },
    [streams, room, stopCamera],
  );

  const setMuted = useCallback((id: string, m: boolean) => setMutedSet((prev) => {
    const next = new Set(prev);
    if (m) next.add(id);
    else next.delete(id);
    return next;
  }), []);
  const setCameraHidden = useCallback((userId: string, hidden: boolean) => setHiddenCameras((prev) => {
    if (prev.has(userId) === hidden) return prev;
    const next = new Set(prev);
    if (hidden) next.add(userId);
    else next.delete(userId);
    return next;
  }), []);
  const setVolume = useCallback((id: string, v: number) => setVolumes((prev) => ({ ...prev, [id]: v })), []);
  const setWatching = useCallback((id: string, on: boolean) => setWatchingSet((prev) => {
    if (prev.has(id) === on) return prev;
    const next = new Set(prev);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  }), []);

  // With cameras turned off, any camera still arriving is left out.
  const shown = useMemo(
    () => camerasAllowed ? streams : streams.filter((s) => s.kind === "screen").map((s) => (s.camera ? { ...s, camera: null, cameraLocal: false, cameraIdentity: null } : s)),
    [streams, camerasAllowed],
  );
  const camera = useMemo<CameraCtl>(
    () => ({ allowed: canStream && camerasAllowed && CAN_CAMERA, on: camOn, busy: camBusy, error: camError, set: setCamera, devices: camDevices, deviceId: camDevice, setDevice }),
    [canStream, camerasAllowed, camOn, camBusy, camError, setCamera, camDevices, camDevice, setDevice],
  );
  const value = useMemo<CastCtx>(
    () => ({ available: room?.state === ConnectionState.Connected, streams: shown, canStream, supported: SUPPORTED, goLive, stop, watching, setWatching, muted, setMuted, volume, setVolume, camera, hiddenCameras, setCameraHidden }),
    [room, shown, canStream, goLive, stop, watching, setWatching, muted, setMuted, volume, setVolume, camera, hiddenCameras, setCameraHidden],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCast() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCast outside CastProvider");
  return c;
}

/** A stream's picture, at the quality the streamer chose, with the streamer's camera over it. `camera` is "full"
 * where the overlay has its own controls (shown large), "small" in a grid tile, and "none" for previews. */
export function StreamVideo({ stream, className, stats, camera = "none" }: {
  stream: Stream;
  className?: string;
  stats?: "full" | "compact";
  camera?: "full" | "small" | "none";
}) {
  const el = useRef<HTMLVideoElement>(null);
  const track = stream.video.track;
  useEffect(() => {
    if (!track || !el.current) return;
    track.attach(el.current);
    const v = el.current;
    return () => void track.detach(v);
  }, [track]);
  const picture = usePicture(el, Boolean(track) && camera !== "none" && Boolean(stream.camera));
  if (!track) return <div className={`${className ?? ""} stream-waiting`}>Connecting…</div>;
  // Your own camera reads like a mirror, as in every video call; everyone else sees it the right way round.
  const mirrored = stream.kind === "camera" && stream.local;
  return (
    <>
      <video ref={el} className={`${className ?? ""}${mirrored ? " is-mirrored" : ""}`} autoPlay playsInline muted />
      {stats && <StreamStats stream={stream} compact={stats === "compact"} />}
      {camera !== "none" && stream.camera && (
        // The camera sits inside the picture itself, not in the black bars around a stream of another shape.
        <div className="cam-frame" style={picture ?? undefined}>
          <CameraOverlay stream={stream} controls={camera === "full"} />
        </div>
      )}
    </>
  );
}

type Box = { top: number; left: number; width: number; height: number };

/** Where the picture is drawn inside a letterboxed (object-fit: contain) video, relative to the video's positioned parent. */
function usePicture(video: React.RefObject<HTMLVideoElement | null>, on: boolean): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    const v = video.current;
    if (!on || !v) return setBox(null);
    let last = "";
    const measure = () => {
      const cw = v.clientWidth;
      const ch = v.clientHeight;
      const scale = v.videoWidth && v.videoHeight ? Math.min(cw / v.videoWidth, ch / v.videoHeight) : 0;
      const width = scale ? v.videoWidth * scale : cw;
      const height = scale ? v.videoHeight * scale : ch;
      const next = { top: v.offsetTop + (ch - height) / 2, left: v.offsetLeft + (cw - width) / 2, width, height };
      const key = `${next.top}|${next.left}|${next.width}|${next.height}`;
      if (key !== last) {
        last = key;
        setBox(next);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(v);
    // The stream's own shape arrives with its first frame and changes if they share another window.
    v.addEventListener("resize", measure);
    v.addEventListener("loadedmetadata", measure);
    return () => {
      ro.disconnect();
      v.removeEventListener("resize", measure);
      v.removeEventListener("loadedmetadata", measure);
    };
  }, [video, on]);
  return box;
}

/** The streamer's camera over their stream, where they put it: everyone sees the same layout. The owner, shown it
 * large, can resize it (drag the inner corner, or arrow keys on it) and move it to the next corner. Anyone can hide
 * it for themselves (the camera button in Sources brings it back). */
function CameraOverlay({ stream, controls }: { stream: Stream; controls: boolean }) {
  const cast = useCast();
  const box = useRef<HTMLDivElement>(null);
  const el = useRef<HTMLVideoElement>(null);
  const keyTimer = useRef<number | null>(null);
  // While you move or resize yours, the change shows at once; it's dropped once everyone's copy matches.
  const [draft, setDraft] = useState<CameraLayout | null>(null);
  const pub = stream.camera;
  const track = pub?.track;
  useEffect(() => {
    if (!track || !el.current) return;
    track.attach(el.current);
    const v = el.current;
    return () => void track.detach(v);
  }, [track]);
  useEffect(() => {
    if (draft && sameLayout(draft, stream.cameraLayout)) setDraft(null);
  }, [draft, stream.cameraLayout]);
  // In case the update never comes back (the camera went off), don't hold the draft for ever.
  useEffect(() => {
    if (!draft) return;
    const t = setTimeout(() => setDraft(null), 4000);
    return () => clearTimeout(t);
  }, [draft]);
  if (!pub || cast.hiddenCameras.has(stream.userId)) return null;
  const layout = draft ?? stream.cameraLayout;
  const { corner: at, size } = layout;
  const own = stream.mine && Boolean(stream.cameraIdentity);
  const who = stream.mine ? "your camera" : `${stream.name}'s camera`;
  const commit = (next: CameraLayout) => {
    setDraft(next);
    void setCameraLayout(stream.cameraIdentity!, next);
  };
  // The handle is on the corner facing into the stream: dragging it away from the anchored corner makes it bigger.
  const fromRight = at === "br" || at === "tr";
  const resize = (e: React.PointerEvent<HTMLDivElement>) => {
    const parent = box.current?.offsetParent as HTMLElement | null;
    if (!parent || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = box.current!.getBoundingClientRect().width;
    const full = parent.getBoundingClientRect().width;
    let next = layout;
    // While dragging, the size goes straight onto the element (no re-render per move), and into state at the end.
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * (fromRight ? -1 : 1);
      next = { corner: at, size: clampSize((startW + dx) / full) };
      box.current?.style.setProperty("--cam-size", `${next.size * 100}%`);
    };
    const done = () => {
      handle.removeEventListener("pointermove", move);
      commit(next); // sent once, at the end
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done, { once: true });
    handle.addEventListener("pointercancel", done, { once: true });
  };
  // Drag your camera anywhere over the stream and it settles in the nearest corner. It's above the tile's and the
  // stage's click-to-focus layers, so pressing on it never focuses or unfocuses the stream.
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const b = box.current;
    const frame = b?.offsetParent as HTMLElement | null;
    if (!own || !b || !frame || e.button !== 0 || (e.target as HTMLElement).closest(".cam-overlay-resize, .cam-overlay-actions")) return;
    e.preventDefault();
    e.stopPropagation();
    b.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    let dx = 0;
    let dy = 0;
    const move = (ev: PointerEvent) => {
      dx = ev.clientX - startX;
      dy = ev.clientY - startY;
      b.style.translate = `${dx}px ${dy}px`;
      b.classList.add("is-dragging");
    };
    const done = () => {
      b.removeEventListener("pointermove", move);
      b.removeEventListener("pointerup", done);
      b.removeEventListener("pointercancel", done);
      const r = b.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      b.style.translate = "";
      b.classList.remove("is-dragging");
      if (Math.hypot(dx, dy) < 4) return; // a press, not a drag
      const cx = r.left + r.width / 2 - f.left;
      const cy = r.top + r.height / 2 - f.top;
      const corner = `${cy < f.height / 2 ? "t" : "b"}${cx < f.width / 2 ? "l" : "r"}` as Corner;
      if (corner !== at) commit({ corner, size });
    };
    b.addEventListener("pointermove", move);
    b.addEventListener("pointerup", done);
    b.addEventListener("pointercancel", done);
  };
  // Keys apply at once and are sent once they settle.
  const keys = (e: React.KeyboardEvent) => {
    const step = ({ ArrowUp: 0.02, ArrowRight: 0.02, ArrowDown: -0.02, ArrowLeft: -0.02, PageUp: 0.1, PageDown: -0.1 } as Record<string, number>)[e.key];
    const to = e.key === "Home" ? SIZE_MIN : e.key === "End" ? SIZE_MAX : step ? clampSize(size + step) : null;
    if (to === null) return;
    e.preventDefault();
    const next = { corner: at, size: to };
    setDraft(next);
    if (keyTimer.current) clearTimeout(keyTimer.current);
    keyTimer.current = window.setTimeout(() => commit(next), 300);
  };
  return (
    <div ref={box} className={`cam-overlay at-${at}${controls || own ? " has-controls" : ""}${own ? " is-own" : ""}`} style={{ "--cam-size": `${size * 100}%` } as React.CSSProperties}
      onPointerDown={own ? drag : undefined} title={own ? "Drag to move" : undefined}>
      {track ? <video ref={el} className={stream.cameraLocal ? "is-mirrored" : undefined} autoPlay playsInline muted /> : <span className="cam-overlay-wait" />}
      {(controls || own) && (
        <>
          {own && (
            <div className="cam-overlay-resize" role="slider" tabIndex={0} aria-label="Size of your camera, for everyone" data-tip="Drag to resize"
              aria-valuemin={SIZE_MIN * 100} aria-valuemax={SIZE_MAX * 100} aria-valuenow={Math.round(size * 100)} aria-valuetext={`${Math.round(size * 100)}% of the stream's width`}
              onPointerDown={resize} onKeyDown={keys} onDoubleClick={() => commit({ corner: at, size: DEFAULT_LAYOUT.size })} />
          )}
          <div className="cam-overlay-actions">
            {own && (
              <button className="icon-btn" aria-label="Move your camera to the next corner, for everyone" data-tip="Move"
                onClick={() => commit({ corner: CORNERS[(CORNERS.indexOf(at) + 1) % CORNERS.length]!, size })}><Move aria-hidden /></button>
            )}
            <button className="icon-btn" aria-label={`Hide ${who}`} data-tip={own ? "Hide camera for you" : "Hide camera"}
              onClick={() => cast.setCameraHidden(stream.userId, true)}><VideoOff aria-hidden /></button>
          </div>
        </>
      )}
    </div>
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
  const audio = stream.audio?.track ?? null;
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
        // Sending: one line per encoded copy, biggest first (one copy unless simulcast comes back).
        const layers = [...v.values()].filter((s) => s.type === "outbound-rtp" && s.kind === "video")
          .sort((x, y) => (num(y.frameWidth) ?? 0) - (num(x.frameWidth) ?? 0));
        for (const l of layers) {
          if (!num(l.frameWidth)) continue;
          out.push([layers.length > 1 ? `Layer ${l.rid ?? ""}`.trim() : "Sending", `${l.frameWidth}×${l.frameHeight} · ${Math.round(num(l.framesPerSecond) ?? 0)} fps · ${rate(kbps(l.id, l.bytesSent, l.timestamp))}`]);
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

const COMPACT = new Set(["Sending", "Resolution", "Frame rate", "Video", "Packet loss", "Audio"]);

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
  const track = stream.local ? null : stream.audio?.track; // the tab that's streaming never plays itself back
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
