import { useEffect, useRef, useState } from "react";
import { Check, Columns2, ListPlus, MoreHorizontal, Plus, Search, X } from "lucide-react";
import type { YouTubeResult } from "@friends/shared";
import { api, ApiError } from "../../lib/api";
import { fmtTime, MEDIA_ERRORS } from "../../lib/media";

const looksLikeUrl = (s: string) =>
  /^https?:\/\//i.test(s) || /^spotify:/i.test(s) || /^(www\.|m\.)?(youtube\.com|youtu\.be|twitch\.tv|clips\.twitch\.tv|open\.spotify\.com)\//i.test(s);
function playlistChoice(s: string) {
  try {
    const u = new URL(/^https?:/i.test(s) ? s : `https://${s}`);
    return /youtube\.com$/.test(u.hostname) && u.searchParams.get("v") && u.searchParams.get("list");
  } catch {
    return false;
  }
}

/** Twitch and single YouTube videos can also play alongside the player, as their own screen. */
const alongsideOk = (s: string) => !/spotify/i.test(s);

export function AddBox({ onAdd, canPlayNext, canAlongside }: {
  /** `alongside`: open it as its own screen beside the player instead of queueing it. Resolves to an error message, or null. */
  onAdd: (input: { url: string; playNext?: boolean; whole?: boolean; alongside?: boolean }) => Promise<string | null>;
  canPlayNext: boolean;
  /** fewer than the maximum screens are open */
  canAlongside: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<YouTubeResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choose, setChoose] = useState<{ url: string; playNext: boolean } | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  async function add(url: string, playNext: boolean, whole?: boolean, alongside?: boolean) {
    setBusy(true);
    setError(null);
    const err = await onAdd({ url, playNext, whole, alongside });
    setBusy(false);
    if (err) setError(err);
    return !err;
  }

  async function submit(playNext: boolean) {
    const q = text.trim();
    if (!q) return;
    setError(null);
    if (looksLikeUrl(q)) {
      if (playlistChoice(q)) return setChoose({ url: q, playNext });
      if (await add(q, playNext)) setText("");
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ results: YouTubeResult[] }>("GET", `/api/media/search?q=${encodeURIComponent(q)}`);
      setResults(r.results);
      setAdded(new Set());
    } catch (e) {
      setResults(null);
      setError((e instanceof ApiError ? (MEDIA_ERRORS[e.code] ?? (e.status === 429 ? MEDIA_ERRORS.search_limit : MEDIA_ERRORS.youtube_error)) : MEDIA_ERRORS.youtube_error!) ?? "YouTube search failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="add-box">
      <form className="add-link" onSubmit={(e) => { e.preventDefault(); void submit(false); }}>
        <label className="visually-hidden" htmlFor="add-input">Search YouTube or paste a link</label>
        <div className="search-field">
          <Search aria-hidden />
          <input id="add-input" className="input" placeholder="Search YouTube, or paste a YouTube, Spotify or Twitch link" value={text} autoComplete="off"
            onChange={(e) => { setText(e.target.value); setChoose(null); }} />
          {(text || results) && (
            <button type="button" className="icon-btn" aria-label="Clear" onClick={() => { setText(""); setResults(null); setChoose(null); setError(null); }}><X aria-hidden /></button>
          )}
        </div>
        {looksLikeUrl(text.trim()) && !choose && (
          <div className="add-actions">
            <button className="btn btn-primary btn-s" disabled={busy}><Plus aria-hidden />Add to queue</button>
            {canPlayNext && <button type="button" className="btn btn-quiet btn-s" disabled={busy} onClick={() => submit(true)}><ListPlus aria-hidden />Play next</button>}
            {canAlongside && alongsideOk(text) && (
              <button type="button" className="btn btn-quiet btn-s" disabled={busy}
                onClick={async () => { if (await add(text.trim(), false, false, true)) setText(""); }}><Columns2 aria-hidden />Watch alongside</button>
            )}
          </div>
        )}
      </form>

      {choose && (
        <div className="choice" role="group" aria-label="This link is part of a playlist">
          <span>This video is part of a playlist.</span>
          <div className="add-actions">
            <button className="btn btn-primary btn-s" disabled={busy} onClick={async () => { if (await add(choose.url, choose.playNext)) { setText(""); setChoose(null); } }}>Add video</button>
            <button className="btn btn-quiet btn-s" disabled={busy} onClick={async () => { if (await add(choose.url, choose.playNext, true)) { setText(""); setChoose(null); } }}>Add whole playlist</button>
          </div>
        </div>
      )}

      {error && <p className="field-error" role="alert">{error}</p>}

      {results && (
        results.length === 0 ? <p className="block-note">No results.</p> : (
          <ul className="results" aria-label="Search results">
            {results.map((r) => {
              const url = `https://youtu.be/${r.id}`;
              const done = added.has(r.id);
              const addAs = async (playNext: boolean, alongside?: boolean) => {
                if (await add(url, playNext, false, alongside)) setAdded(new Set(added).add(r.id));
              };
              return (
                <li key={r.id} className={`result${done ? " is-added" : ""}`}>
                  <button className="result-main" disabled={busy || done} aria-label={done ? `${r.title}, added` : `Add ${r.title} to the queue`}
                    title={done ? undefined : "Add to queue"} onClick={() => addAs(false)}>
                    {r.thumbnail ? <img className="thumb" src={r.thumbnail} alt="" loading="lazy" /> : <span className="thumb" />}
                    <span className="queue-text">
                      <span className="queue-title" title={r.title}>{r.title}</span>
                      <span className="queue-meta">{r.author} · {r.live ? "Live" : fmtTime(r.duration)}</span>
                    </span>
                    <span className="result-state" aria-hidden>{done ? <><Check />Added</> : <Plus />}</span>
                  </button>
                  {!done && (canPlayNext || canAlongside) && (
                    <MoreMenu label={r.title} disabled={busy} items={[
                      ...(canPlayNext ? [{ label: "Play next", Icon: ListPlus, run: () => addAs(true) }] : []),
                      ...(canAlongside ? [{ label: "Watch alongside", Icon: Columns2, run: () => addAs(false, true) }] : []),
                    ]} />
                  )}
                </li>
              );
            })}
          </ul>
        )
      )}
    </div>
  );
}

/** The "…" on a search result: the less common ways to add it. Fixed to the window so the results' scrolling can't clip it. */
function MoreMenu({ label, disabled, items }: { label: string; disabled: boolean; items: { label: string; Icon: typeof Plus; run: () => void }[] }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const open = Boolean(at);
  const setOpen = (o: boolean) => {
    const r = root.current?.getBoundingClientRect();
    setAt(o && r ? { top: r.bottom + 6, left: Math.max(8, Math.min(r.right - 224, window.innerWidth - 232)) } : null);
  };
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = () => setAt(null);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    root.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setAt(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className="sources result-more" ref={root}>
      <button className="icon-btn" aria-label={`More ways to add ${label}`} title="More" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>
        <MoreHorizontal aria-hidden />
      </button>
      {at && (
        <div className="remove-menu result-menu" role="menu" aria-label={`Add ${label}`} style={at}>
          {items.map(({ label: l, Icon, run }) => (
            <button key={l} role="menuitem" onClick={() => { setAt(null); run(); }}><Icon aria-hidden />{l}</button>
          ))}
        </div>
      )}
    </div>
  );
}
