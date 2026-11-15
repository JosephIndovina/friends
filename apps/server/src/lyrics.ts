import type { Lyrics } from "@friends/shared";
import { db } from "./db.js";

/** Synced lyrics from LRCLIB (free, no key). Results are cached, including misses, for 30 days. */

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UA = "friends-companion/1.0";

/** Best guess at artist and track from YouTube-style metadata. */
export function splitTitle(title: string, author: string | null): { artist: string; track: string } {
  const clean = (s: string) =>
    s
      .replace(/\s*[([](?:official|lyric|lyrics|audio|video|music video|visualizer|hd|4k|remaster(?:ed)?|mv|explicit)[^)\]]*[)\]]/gi, "")
      .replace(/\s*\|.*$/, "")
      .replace(/\s+(?:ft\.?|feat\.?)\s.*$/i, "")
      .replace(/["“”]/g, "")
      .trim();
  if (author?.endsWith(" - Topic")) return { artist: author.slice(0, -" - Topic".length), track: clean(title) };
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title);
  if (m) return { artist: clean(m[1]!), track: clean(m[2]!) };
  return { artist: (author ?? "").replace(/VEVO$/i, "").trim(), track: clean(title) };
}

function parseLrc(lrc: string): Lyrics["lines"] {
  const lines: Array<{ t: number; text: string }> = [];
  for (const raw of lrc.split("\n")) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    // Strip line stamps and enhanced-LRC word stamps like <00:18.89>.
    const text = raw.replace(/\[[^\]]*\]/g, "").replace(/<\d+:\d+(?:\.\d+)?>/g, "").replace(/\s+/g, " ").trim();
    for (const s of stamps) lines.push({ t: Number(s[1]) * 60 + Number(s[2]), text });
  }
  return lines.sort((a, b) => a.t - b.t);
}

interface LrcRecord { trackName: string; artistName: string; duration: number; instrumental: boolean; plainLyrics: string | null; syncedLyrics: string | null }

async function lrclib(path: string): Promise<unknown> {
  const res = await fetch(`https://lrclib.net/api/${path}`, { headers: { "User-Agent": UA } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lrclib ${res.status}`);
  return res.json();
}

export async function getLyrics(title: string, author: string | null, duration: number | null): Promise<Lyrics> {
  const { artist, track } = splitTitle(title, author);
  const key = `${artist.toLowerCase()}|${track.toLowerCase()}|${duration ? Math.round(duration) : ""}`;
  const hit = db.prepare("SELECT data, fetched_at FROM lyrics_cache WHERE key = ?").get(key) as { data: string; fetched_at: number } | undefined;
  if (hit && Date.now() - hit.fetched_at < TTL_MS) return JSON.parse(hit.data) as Lyrics;

  const q = new URLSearchParams({ artist_name: artist, track_name: track });
  let rec: LrcRecord | null = null;
  if (duration) rec = (await lrclib(`get?${q}&duration=${Math.round(duration)}`)) as LrcRecord | null;
  if (!rec) {
    const found = ((await lrclib(`search?${q}`)) as LrcRecord[] | null) ?? [];
    // Prefer synced lyrics, then the closest duration.
    const score = (r: LrcRecord) => (r.syncedLyrics ? 0 : 1000) + (duration ? Math.abs(r.duration - duration) : 0);
    rec = found.filter((r) => !duration || Math.abs(r.duration - duration) < 15).sort((a, b) => score(a) - score(b))[0] ?? null;
  }
  const out: Lyrics = {
    lines: rec?.syncedLyrics ? parseLrc(rec.syncedLyrics) : null,
    plain: rec?.plainLyrics ?? null,
    instrumental: Boolean(rec?.instrumental),
    artist,
    track,
  };
  db.prepare("INSERT INTO lyrics_cache (key, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at").run(
    key,
    JSON.stringify(out),
    Date.now(),
  );
  return out;
}
