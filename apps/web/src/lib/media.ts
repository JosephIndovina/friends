import { useEffect, useState } from "react";
import { SEEKABLE, type ClientToServer, type MediaState, type Playback } from "@friends/shared";
import { serverNow } from "./clock";
import { getSocket } from "./socket";

let last: MediaState | null = null;

export function useMediaState(): MediaState | null {
  const [state, setState] = useState<MediaState | null>(last);
  useEffect(() => {
    const s = getSocket();
    const on = (st: MediaState) => {
      last = st;
      setState(st);
    };
    s.on("media:state", on);
    const sub = () => s.emit("media:subscribe");
    if (s.connected) sub();
    s.on("connect", sub);
    return () => {
      s.off("media:state", on);
      s.off("connect", sub);
    };
  }, []);
  return state;
}

/** Where everyone should be right now, in seconds. */
export function expectedPosition(p: Playback): number {
  if (!p.playing || !SEEKABLE[p.item.kind]) return p.position;
  const pos = p.position + (serverNow() - p.updatedAt) / 1000;
  return p.item.duration ? Math.min(pos, p.item.duration) : pos;
}

type Events = ClientToServer;
type AckArgs<E extends keyof Events> = Parameters<Events[E]> extends [...infer A, infer _Ack] ? A : never;

/** Emit a media action and resolve with the server's verdict. */
export function mediaAction<E extends keyof Events>(event: E, ...args: AckArgs<E>): Promise<void> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (getSocket().emit as any)(event, ...args, (res: { ok: boolean; error?: string }) => (res.ok ? resolve() : reject(new Error(res.error))));
  });
}

export const MEDIA_ERRORS: Record<string, string> = {
  unsupported_link: "That link isn’t supported. Paste a YouTube or Twitch link.",
  video_unavailable: "That video is private, removed, or can’t be embedded.",
  queue_full: "The queue is full (200 items).",
  nothing_queued: "The queue is empty.",
  nothing_playing: "Nothing is playing.",
  not_seekable: "Live streams and clips can’t be seeked.",
  missing_permission: "You don’t have permission to do that.",
  section_disabled: "Media is turned off.",
  slow_down: "Too many actions. Wait a moment.",
  not_found: "That item is no longer in the queue.",
};
export const mediaError = (e: unknown) => MEDIA_ERRORS[(e as Error)?.message] ?? "Something went wrong. Try again.";

export function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "--:--";
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export const KIND_LABEL = { youtube: "YouTube", "twitch-vod": "Twitch video", "twitch-clip": "Twitch clip", "twitch-live": "Twitch live" } as const;
