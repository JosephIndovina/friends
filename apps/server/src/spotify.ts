import type { MediaItem } from "@friends/shared";
import { db } from "./db.js";
import { env } from "./env.js";
import { search, YouTubeError } from "./youtube.js";

/**
 * Spotify links give us track details only: Spotify can't stream to a group. Each track is matched to a
 * YouTube video just before it plays, and the match is remembered forever, so a track costs one
 * YouTube search the first time it's ever played.
 */

export class SpotifyError extends Error {}
export const spotifyEnabled = () => Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET);

export function parseSpotify(input: string): { type: "track" | "album" | "playlist"; id: string } | null {
  const s = input.trim();
  const uri = /^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/.exec(s);
  if (uri) return { type: uri[1] as "track", id: uri[2]! };
  try {
    const url = new URL(s.startsWith("http") ? s : `https://${s}`);
    if (url.hostname !== "open.spotify.com") return null;
    const parts = url.pathname.split("/").filter(Boolean).filter((p) => !p.startsWith("intl-"));
    if (["track", "album", "playlist"].includes(parts[0] ?? "") && /^[A-Za-z0-9]{22}$/.test(parts[1] ?? "")) {
      return { type: parts[0] as "track", id: parts[1]! };
    }
  } catch {
    /* not a URL */
  }
  return null;
}

let token: { value: string; expires: number } | null = null;

async function api<T>(path: string): Promise<T> {
  if (!spotifyEnabled()) throw new SpotifyError("spotify_not_configured");
  if (!token || token.expires < Date.now() + 60_000) {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new SpotifyError("spotify_error");
    const j = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  }
  const res = await fetch(`https://api.spotify.com/v1/${path}`, { headers: { Authorization: `Bearer ${token.value}` } });
  // Spotify no longer lets new apps read its own editorial/algorithmic playlists: they 404.
  if (res.status === 404) throw new SpotifyError("spotify_unavailable");
  if (!res.ok) throw new SpotifyError("spotify_error");
  return (await res.json()) as T;
}

interface Track {
  id: string;
  name: string;
  duration_ms: number;
  is_local?: boolean;
  artists: Array<{ name: string }>;
  album?: { name: string; images: Array<{ url: string; width: number }> };
}

type Draft = Omit<MediaItem, "id" | "addedBy" | "addedAt">;

const cover = (images: Array<{ url: string; width: number }> | undefined) =>
  images?.slice().sort((a, b) => Math.abs(a.width - 300) - Math.abs(b.width - 300))[0]?.url ?? null;

const toDraft = (t: Track, albumImages?: Array<{ url: string; width: number }>): Draft => ({
  kind: "spotify",
  mode: "music",
  ref: t.id,
  startAt: 0,
  title: t.name,
  author: t.artists.map((a) => a.name).join(", "),
  thumbnail: cover(t.album?.images ?? albumImages),
  duration: Math.round(t.duration_ms / 1000),
  spotifyId: t.id,
});

/** Tracks for a Spotify link, up to `limit`, in order. */
export async function spotifyTracks(link: { type: "track" | "album" | "playlist"; id: string }, limit: number): Promise<{ title: string; items: Draft[] }> {
  if (link.type === "track") {
    const t = await api<Track>(`tracks/${link.id}`);
    return { title: t.name, items: [toDraft(t)] };
  }
  if (link.type === "album") {
    const a = await api<{ name: string; images: Array<{ url: string; width: number }>; tracks: { items: Track[]; next: string | null } }>(`albums/${link.id}`);
    const items = a.tracks.items.map((t) => toDraft(t, a.images));
    let next = a.tracks.next;
    while (next && items.length < limit) {
      const page = await api<{ items: Track[]; next: string | null }>(next.replace("https://api.spotify.com/v1/", ""));
      items.push(...page.items.map((t) => toDraft(t, a.images)));
      next = page.next;
    }
    return { title: a.name, items: items.slice(0, limit) };
  }
  const meta = await api<{ name: string }>(`playlists/${link.id}?fields=name`);
  const items: Draft[] = [];
  let path: string | null = `playlists/${link.id}/tracks?limit=100&fields=next,items(track(id,name,duration_ms,is_local,artists(name),album(name,images)))`;
  while (path && items.length < limit) {
    const page: { items: Array<{ track: Track | null }>; next: string | null } = await api(path);
    for (const row of page.items) if (row.track?.id && !row.track.is_local) items.push(toDraft(row.track));
    path = page.next ? page.next.replace("https://api.spotify.com/v1/", "") : null;
  }
  return { title: meta.name, items: items.slice(0, limit) };
}

const WORDS = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);

/** YouTube video id for a Spotify item: cached, else one YouTube search scored on duration, channel and title. */
export async function matchYouTube(item: MediaItem): Promise<string | null> {
  const id = item.spotifyId ?? item.ref;
  const hit = db.prepare("SELECT youtube_id FROM spotify_map WHERE spotify_id = ?").get(id) as { youtube_id: string | null } | undefined;
  if (hit) return hit.youtube_id;

  const artist = (item.author ?? "").split(",")[0]!.trim();
  let results;
  try {
    results = (await search(`${artist} ${item.title}`)).results;
  } catch (err) {
    if (err instanceof YouTubeError) throw new SpotifyError(err.message);
    throw err;
  }
  const want = new Set(WORDS(item.title));
  const extra = (t: string) => ["live", "cover", "remix", "karaoke", "instrumental", "sped", "slowed", "8d", "nightcore"].some((w) => WORDS(t).includes(w) && !want.has(w));
  const scored = results
    .filter((r) => !r.live && r.duration)
    .map((r) => {
      const diff = Math.abs((r.duration ?? 0) - (item.duration ?? 0));
      const overlap = WORDS(r.title).filter((w) => want.has(w)).length / Math.max(1, want.size);
      let score = overlap * 40 - diff * 2;
      if (r.author.endsWith(" - Topic")) score += 25;
      if (r.author.toLowerCase().includes(artist.toLowerCase())) score += 15;
      if (extra(r.title)) score -= 40;
      return { r, score, diff };
    })
    .filter((x) => x.diff <= 20)
    .sort((a, b) => b.score - a.score);
  const best = scored[0]?.r.id ?? null;
  db.prepare("INSERT INTO spotify_map (spotify_id, youtube_id, resolved_at) VALUES (?, ?, ?) ON CONFLICT(spotify_id) DO UPDATE SET youtube_id = excluded.youtube_id, resolved_at = excluded.resolved_at").run(
    id,
    best,
    Date.now(),
  );
  return best;
}
