import { useEffect, useRef, useState } from "react";
import type { Lyrics, Playback } from "@friends/shared";
import { api } from "../../lib/api";
import { expectedPosition } from "../../lib/media";

const cache = new Map<string, Lyrics | "error">();

/** Lyrics for the current item, with the current line highlighted from the synced clock. */
export function LyricsView({ playback }: { playback: Playback }) {
  const id = playback.item.id;
  const [lyrics, setLyrics] = useState<Lyrics | "error" | null>(cache.get(id) ?? null);
  const [index, setIndex] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef(playback);
  latest.current = playback;

  useEffect(() => {
    if (cache.has(id)) return setLyrics(cache.get(id)!);
    setLyrics(null);
    let live = true;
    api<Lyrics>("GET", `/api/player/lyrics?id=${encodeURIComponent(id)}`)
      .then((l) => (cache.set(id, l), live && setLyrics(l)))
      .catch(() => (cache.set(id, "error"), live && setLyrics("error")));
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => {
    if (!lyrics || lyrics === "error" || !lyrics.lines) return;
    const lines = lyrics.lines;
    const tick = () => {
      const pos = expectedPosition(latest.current) + 0.25;
      let i = -1;
      for (let k = 0; k < lines.length && lines[k]!.t <= pos; k++) i = k;
      setIndex(i);
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [lyrics]);

  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-i="${index}"]`);
    if (el && box.current) box.current.scrollTo({ top: el.offsetTop - box.current.clientHeight / 2 + el.clientHeight / 2, behavior: "smooth" });
  }, [index]);

  if (lyrics === null) return <div className="lyrics"><p className="lyrics-note">Loading lyrics…</p></div>;
  if (lyrics === "error") return <div className="lyrics"><p className="lyrics-note">Lyrics couldn’t be loaded.</p></div>;
  if (lyrics.instrumental) return <div className="lyrics"><p className="lyrics-note">Instrumental</p></div>;
  if (!lyrics.lines && !lyrics.plain) return <div className="lyrics"><p className="lyrics-note">No lyrics found for “{lyrics.track}”.</p></div>;

  return (
    <div className="lyrics" ref={box}>
      {lyrics.lines ? (
        lyrics.lines.map((l, i) => (
          <p key={i} data-i={i} className={i === index ? "is-now" : i < index ? "is-past" : undefined}>{l.text || "♪"}</p>
        ))
      ) : (
        <p className="lyrics-plain">{lyrics.plain}</p>
      )}
      <p className="lyrics-credit">Lyrics from LRCLIB</p>
    </div>
  );
}
