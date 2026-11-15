import type { YouTubeResult } from "@friends/shared";
import { db } from "./db.js";
import { env } from "./env.js";

/** YouTube Data API v3: search, video details and playlists. Every call is metered against the daily quota. */

export const DAILY_QUOTA = 10_000;
const API = "https://www.googleapis.com/youtube/v3";
const QUOTA_KEY = "yt_quota";
const SEARCH_TTL_MS = 6 * 60 * 60 * 1000;

export class YouTubeError extends Error {}

export const youtubeEnabled = () => Boolean(env.YOUTUBE_API_KEY);

/** Quota resets at midnight Pacific time. */
const quotaDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());

export function quotaUsed(): { day: string; used: number; limit: number } {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(QUOTA_KEY) as { value: string } | undefined;
  const saved = row ? (JSON.parse(row.value) as { day: string; used: number }) : null;
  const day = quotaDay();
  return { day, used: saved?.day === day ? saved.used : 0, limit: DAILY_QUOTA };
}

function spend(units: number) {
  const q = quotaUsed();
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    QUOTA_KEY,
    JSON.stringify({ day: q.day, used: q.used + units }),
  );
}

async function call<T>(path: string, params: Record<string, string>, cost: number): Promise<T> {
  if (!env.YOUTUBE_API_KEY) throw new YouTubeError("youtube_not_configured");
  if (quotaUsed().used + cost > DAILY_QUOTA) throw new YouTubeError("youtube_quota");
  const url = new URL(`${API}/${path}`);
  url.search = new URLSearchParams({ ...params, key: env.YOUTUBE_API_KEY }).toString();
  const res = await fetch(url);
  spend(cost);
  if (res.status === 403) throw new YouTubeError("youtube_quota");
  if (!res.ok) throw new YouTubeError("youtube_error");
  return (await res.json()) as T;
}

/** "PT1H2M3S" → 3723 */
function isoDuration(iso: string | undefined): number | null {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!m) return null;
  const s = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return s || null;
}

interface VideoResource {
  id: string;
  snippet: { title: string; channelTitle: string; liveBroadcastContent: string; categoryId?: string; thumbnails: Record<string, { url: string }> };
  contentDetails: { duration: string };
  status: { embeddable: boolean; privacyStatus: string };
}

const thumb = (t: VideoResource["snippet"]["thumbnails"]) => (t.medium ?? t.high ?? t.default)?.url ?? null;

/** Details for up to any number of ids (batched by 50, 1 unit per batch). Drops private and non-embeddable videos. */
export async function videoDetails(ids: string[]): Promise<YouTubeResult[]> {
  const out: YouTubeResult[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const r = await call<{ items: VideoResource[] }>("videos", { part: "snippet,contentDetails,status", id: batch.join(","), maxResults: "50" }, 1);
    const byId = new Map(r.items.map((v) => [v.id, v]));
    for (const id of batch) {
      const v = byId.get(id);
      if (!v || !v.status.embeddable || v.status.privacyStatus === "private" || v.snippet.liveBroadcastContent === "upcoming") continue;
      out.push({
        id: v.id,
        title: v.snippet.title,
        author: v.snippet.channelTitle,
        thumbnail: thumb(v.snippet.thumbnails),
        duration: v.snippet.liveBroadcastContent === "live" ? null : isoDuration(v.contentDetails.duration),
        live: v.snippet.liveBroadcastContent === "live",
        // Category 10 is Music; auto-generated "- Topic" channels are album tracks.
        music: v.snippet.categoryId === "10" || v.snippet.channelTitle.endsWith(" - Topic"),
      });
    }
  }
  return out;
}

const searchCache = new Map<string, { at: number; results: YouTubeResult[] }>();

/** 100 units for the search plus 1 for details. Cached for 6 hours per normalised query. */
export async function search(q: string): Promise<{ results: YouTubeResult[]; cached: boolean }> {
  const key = q.trim().toLowerCase().replace(/\s+/g, " ");
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return { results: hit.results, cached: true };
  const r = await call<{ items: Array<{ id: { videoId: string } }> }>(
    "search",
    { part: "snippet", q: key, type: "video", videoEmbeddable: "true", maxResults: "12", safeSearch: "none" },
    100,
  );
  const results = await videoDetails(r.items.map((i) => i.id.videoId));
  searchCache.set(key, { at: Date.now(), results });
  if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value!);
  return { results, cached: false };
}

/** A playlist's videos in order, up to `limit`. Mixes (RD…) are generated per viewer and can't be read. */
export async function playlist(listId: string, limit: number): Promise<{ title: string; items: YouTubeResult[]; skipped: number }> {
  if (listId.startsWith("RD")) throw new YouTubeError("youtube_mix");
  const meta = await call<{ items: Array<{ snippet: { title: string } }> }>("playlists", { part: "snippet", id: listId }, 1);
  if (!meta.items.length) throw new YouTubeError("playlist_unavailable");
  const ids: string[] = [];
  let pageToken = "";
  while (ids.length < limit) {
    const page = await call<{ items: Array<{ contentDetails: { videoId: string } }>; nextPageToken?: string }>(
      "playlistItems",
      { part: "contentDetails", playlistId: listId, maxResults: "50", ...(pageToken ? { pageToken } : {}) },
      1,
    );
    ids.push(...page.items.map((i) => i.contentDetails.videoId));
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  const wanted = ids.slice(0, limit);
  const items = await videoDetails(wanted);
  return { title: meta.items[0]!.snippet.title, items, skipped: wanted.length - items.length };
}

/** The `list` id from a YouTube URL, if any. */
export function youtubeListId(input: string): string | null {
  try {
    const url = new URL(input.trim().startsWith("http") ? input.trim() : `https://${input.trim()}`);
    if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;
    const list = url.searchParams.get("list");
    return list && /^[A-Za-z0-9_-]{10,64}$/.test(list) ? list : null;
  } catch {
    return null;
  }
}
