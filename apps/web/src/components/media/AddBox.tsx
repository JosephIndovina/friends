import { useState } from "react";
import { ListPlus, Plus, Search, X } from "lucide-react";
import type { YouTubeResult } from "@friends/shared";
import { api, ApiError } from "../../lib/api";
import { fmtTime, MEDIA_ERRORS } from "../../lib/media";

const looksLikeUrl = (s: string) => /^https?:\/\//i.test(s) || /^(www\.|m\.)?(youtube\.com|youtu\.be|twitch\.tv|clips\.twitch\.tv)\//i.test(s);
function playlistChoice(s: string) {
  try {
    const u = new URL(/^https?:/i.test(s) ? s : `https://${s}`);
    return /youtube\.com$/.test(u.hostname) && u.searchParams.get("v") && u.searchParams.get("list");
  } catch {
    return false;
  }
}

export function AddBox({ onAdd, canPlayNext }: {
  onAdd: (input: { url: string; playNext?: boolean; whole?: boolean }) => Promise<boolean>;
  canPlayNext: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<YouTubeResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choose, setChoose] = useState<{ url: string; playNext: boolean } | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  async function add(url: string, playNext: boolean, whole?: boolean) {
    setBusy(true);
    const ok = await onAdd({ url, playNext, whole });
    setBusy(false);
    return ok;
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
      setError(e instanceof ApiError ? (MEDIA_ERRORS[e.code] ?? (e.status === 429 ? MEDIA_ERRORS.search_limit : MEDIA_ERRORS.youtube_error)) : MEDIA_ERRORS.youtube_error!);
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
          <input id="add-input" className="input" placeholder="Search YouTube or paste a link" value={text} autoComplete="off"
            onChange={(e) => { setText(e.target.value); setChoose(null); }} />
          {(text || results) && (
            <button type="button" className="icon-btn" aria-label="Clear" onClick={() => { setText(""); setResults(null); setChoose(null); setError(null); }}><X aria-hidden /></button>
          )}
        </div>
        {looksLikeUrl(text.trim()) && !choose && (
          <div className="add-actions">
            <button className="btn btn-primary btn-s" disabled={busy}><Plus aria-hidden />Add to queue</button>
            {canPlayNext && <button type="button" className="btn btn-quiet btn-s" disabled={busy} onClick={() => submit(true)}><ListPlus aria-hidden />Play next</button>}
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
            {results.map((r) => (
              <li key={r.id} className="result">
                {r.thumbnail ? <img className="thumb" src={r.thumbnail} alt="" loading="lazy" /> : <span className="thumb" />}
                <span className="queue-text">
                  <span className="queue-title" title={r.title}>{r.title}</span>
                  <span className="queue-meta">{r.author} · {r.live ? "Live" : fmtTime(r.duration)}</span>
                </span>
                <span className="result-actions">
                  {added.has(r.id) ? <span className="queue-meta">Added</span> : (
                    <>
                      {canPlayNext && (
                        <button className="icon-btn" title="Play next" aria-label={`Play ${r.title} next`} disabled={busy}
                          onClick={async () => { if (await add(`https://youtu.be/${r.id}`, true)) setAdded(new Set(added).add(r.id)); }}><ListPlus aria-hidden /></button>
                      )}
                      <button className="icon-btn" title="Add to queue" aria-label={`Add ${r.title} to queue`} disabled={busy}
                        onClick={async () => { if (await add(`https://youtu.be/${r.id}`, false)) setAdded(new Set(added).add(r.id)); }}><Plus aria-hidden /></button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
