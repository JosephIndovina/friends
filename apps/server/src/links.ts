import type { MediaKind } from "@friends/shared";
import { env } from "./env.js";

export interface ParsedLink {
  kind: MediaKind;
  ref: string;
  startAt: number;
}

export interface LinkMeta {
  title: string;
  author: string | null;
  thumbnail: string | null;
  duration: number | null;
}

/** "90", "90s", "1m30s", "1h2m3s" → seconds */
export function parseTime(t: string | null): number {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m || !m[0]) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const TWITCH_LOGIN = /^[A-Za-z0-9_]{3,25}$/;
const TWITCH_RESERVED = new Set(["directory", "videos", "settings", "subscriptions", "inventory", "wallet", "drops", "search", "p", "downloads", "jobs", "turbo", "login", "signup"]);

export function parseLink(input: string): ParsedLink | null {
  let url: URL;
  try {
    url = new URL(input.trim().startsWith("http") ? input.trim() : `https://${input.trim()}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  const t = parseTime(url.searchParams.get("t") ?? url.searchParams.get("start"));

  if (host === "youtu.be" && parts[0] && YT_ID.test(parts[0])) return { kind: "youtube", ref: parts[0], startAt: t };
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const v = url.searchParams.get("v");
    if (parts[0] === "watch" && v && YT_ID.test(v)) return { kind: "youtube", ref: v, startAt: t };
    if (["shorts", "live", "embed", "v"].includes(parts[0] ?? "") && parts[1] && YT_ID.test(parts[1])) return { kind: "youtube", ref: parts[1], startAt: t };
    return null;
  }

  if (host === "clips.twitch.tv" && parts[0]) return { kind: "twitch-clip", ref: parts[0], startAt: 0 };
  if (host === "twitch.tv") {
    if (parts[0] === "videos" && parts[1] && /^\d+$/.test(parts[1])) return { kind: "twitch-vod", ref: parts[1], startAt: t };
    if (parts[1] === "clip" && parts[2]) return { kind: "twitch-clip", ref: parts[2], startAt: 0 };
    if (parts.length === 1 && parts[0] && TWITCH_LOGIN.test(parts[0]) && !TWITCH_RESERVED.has(parts[0].toLowerCase())) {
      return { kind: "twitch-live", ref: parts[0].toLowerCase(), startAt: 0 };
    }
  }
  return null;
}

// ---------- metadata ----------

async function youtubeMeta(id: string): Promise<LinkMeta | null> {
  const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
  // 401/403 = embedding disabled, 404 = private or removed.
  if (!res.ok) return null;
  const j = (await res.json()) as { title: string; author_name?: string };
  return { title: j.title, author: j.author_name ?? null, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, duration: null };
}

let twitchToken: { value: string; expires: number } | null = null;
const twitchEnabled = () => Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);

async function helix<T>(path: string): Promise<T[] | null> {
  if (!twitchEnabled()) return null;
  if (!twitchToken || twitchToken.expires < Date.now() + 60_000) {
    const res = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({ client_id: env.TWITCH_CLIENT_ID!, client_secret: env.TWITCH_CLIENT_SECRET!, grant_type: "client_credentials" }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { access_token: string; expires_in: number };
    twitchToken = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  }
  const res = await fetch(`https://api.twitch.tv/helix/${path}`, {
    headers: { "Client-Id": env.TWITCH_CLIENT_ID!, Authorization: `Bearer ${twitchToken.value}` },
  });
  if (!res.ok) return null;
  return ((await res.json()) as { data: T[] }).data;
}

const sized = (url: string | undefined) => url?.replace("%{width}", "640").replace("%{height}", "360").replace("{width}", "640").replace("{height}", "360") ?? null;

async function twitchMeta(kind: MediaKind, ref: string): Promise<LinkMeta> {
  try {
    if (kind === "twitch-vod") {
      const v = (await helix<{ title: string; user_name: string; thumbnail_url: string; duration: string }>(`videos?id=${ref}`))?.[0];
      if (v) return { title: v.title, author: v.user_name, thumbnail: sized(v.thumbnail_url), duration: parseTime(v.duration) || null };
      return { title: `Twitch video ${ref}`, author: null, thumbnail: null, duration: null };
    }
    if (kind === "twitch-clip") {
      const c = (await helix<{ title: string; broadcaster_name: string; thumbnail_url: string; duration: number }>(`clips?id=${encodeURIComponent(ref)}`))?.[0];
      if (c) return { title: c.title, author: c.broadcaster_name, thumbnail: c.thumbnail_url, duration: c.duration };
      return { title: `Twitch clip`, author: null, thumbnail: null, duration: null };
    }
    const s = (await helix<{ title: string; user_name: string }>(`streams?user_login=${ref}`))?.[0];
    return {
      title: s?.title ?? `${ref} on Twitch`,
      author: s?.user_name ?? ref,
      thumbnail: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${ref}-640x360.jpg`,
      duration: null,
    };
  } catch {
    return { title: kind === "twitch-live" ? `${ref} on Twitch` : "Twitch", author: null, thumbnail: null, duration: null };
  }
}

export async function fetchMeta(link: ParsedLink): Promise<LinkMeta | null> {
  if (link.kind === "youtube") return youtubeMeta(link.ref);
  return twitchMeta(link.kind, link.ref);
}
