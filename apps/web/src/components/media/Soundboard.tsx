import { useEffect, useRef, useState } from "react";
import { AudioLines, Plus, X } from "lucide-react";
import { SOUND_LIMITS, type Session, type Sound } from "@friends/shared";
import { ApiError, can } from "../../lib/api";
import { soundError, useSounds } from "../../lib/sounds";
import { useToast } from "../../lib/toast";
import { EmojiPicker } from "../EmojiPicker";

async function upload(file: File, name: string, emoji: string): Promise<Sound> {
  const form = new FormData();
  // Fields before the file: the server reads them as it reaches the file.
  form.append("name", name);
  form.append("emoji", emoji);
  form.append("file", file);
  const res = await fetch("/api/sounds", { method: "POST", credentials: "same-origin", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? (res.status === 413 ? "file_too_large" : "server_error"));
  return data as Sound;
}

/** Length in seconds, read in the browser so a too-long file is caught before it uploads. null = can't decode it here (the server decides). */
async function lengthOf(file: File): Promise<number | null> {
  try {
    const ctx = new OfflineAudioContext(1, 1, 48000);
    return (await ctx.decodeAudioData(await file.arrayBuffer())).duration;
  } catch {
    return null;
  }
}

const nameFrom = (file: File) => file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, SOUND_LIMITS.name);

function AddSound({ onDone }: { onDone: () => void }) {
  const { reload } = useSounds();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (f: File | undefined) => {
    setError(null);
    setFile(null);
    if (!f) return;
    if (f.size > SOUND_LIMITS.bytes) return setError(soundError(new Error("file_too_large")));
    const secs = await lengthOf(f);
    if (secs !== null && secs > SOUND_LIMITS.seconds + 0.05) return setError(soundError(new Error("too_long")));
    setFile(f);
    if (!name.trim()) setName(nameFrom(f));
  };

  return (
    <form className="sound-add" onSubmit={async (e) => {
      e.preventDefault();
      if (!file || !name.trim()) return;
      setBusy(true);
      setError(null);
      try {
        await upload(file, name.trim(), emoji);
        await reload();
        onDone();
      } catch (err) {
        setError(soundError(err));
      } finally {
        setBusy(false);
      }
    }}>
      <label className="field">
        <span>File</span>
        <input className="input sound-file" type="file" accept="audio/*,.mp3,.ogg,.opus,.wav,.m4a,.flac,.webm" onChange={(e) => void pick(e.target.files?.[0])} />
      </label>
      <div className="sound-add-row">
        <div className="field sound-emoji-field">
          <span id="sound-emoji-label">Emoji</span>
          <button type="button" className={`input sound-emoji-btn${emoji ? "" : " is-empty"}`} aria-labelledby="sound-emoji-label sound-emoji-value"
            aria-expanded={picking} onClick={() => setPicking(!picking)}>
            <span id="sound-emoji-value">{emoji || "None"}</span>
          </button>
        </div>
        <label className="field grow">
          <span>Name</span>
          <input className="input" value={name} maxLength={SOUND_LIMITS.name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      {picking && (
        <div className="sound-emoji-pick">
          <EmojiPicker onPick={(e) => { setEmoji(e); setPicking(false); }} onClose={() => setPicking(false)} />
          {emoji && <button type="button" className="btn btn-quiet btn-s" onClick={() => { setEmoji(""); setPicking(false); }}>No emoji</button>}
        </div>
      )}
      <p className="quiet sound-limits">Up to {SOUND_LIMITS.seconds} seconds and 1 MB.</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="add-actions">
        <button className="btn btn-primary btn-s" disabled={!file || !name.trim() || busy}>{busy ? "Adding…" : "Add"}</button>
        <button type="button" className="btn btn-quiet btn-s" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

/** The soundboard: a button in the stage bar. Pressing a sound plays it for everyone on the site. */
export function Soundboard({ session }: { session: Session }) {
  const sounds = useSounds();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Sound | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setAdding(false);
      setDeleting(null);
      return;
    }
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!sounds.enabled) return null;
  const me = session.user.id;
  const canAdd = can(session, "sounds.add");
  const canDelete = (s: Sound) => (s.addedBy.id === me && canAdd) || can(session, "playback.moderate");
  const list = sounds.list ?? [];

  const remove = async (s: Sound) => {
    setDeleting(null);
    try {
      const res = await fetch(`/api/sounds/${s.id}`, { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "server_error");
      await sounds.reload();
    } catch (err) {
      toast(soundError(err), { kind: "error" });
    }
  };

  return (
    <div className="soundboard" ref={root}>
      <button className="icon-btn" aria-label="Soundboard" aria-expanded={open} data-tip={open ? undefined : "Soundboard"} onClick={() => setOpen(!open)}>
        <AudioLines aria-hidden />
      </button>
      {open && (
        <div className="stack-panel sound-panel" role="dialog" aria-label="Soundboard">
          <div className="sound-head">
            <h2>Soundboard</h2>
            {canAdd && !adding && (
              <button className="btn btn-quiet btn-s" onClick={() => { setAdding(true); setDeleting(null); }}><Plus aria-hidden />Add sound</button>
            )}
          </div>
          {adding ? <AddSound onDone={() => setAdding(false)} /> : (
            <>
              {sounds.list && list.length === 0 && <p className="block-note">No sounds yet.</p>}
              {list.length > 0 && (
                <ul className="sound-grid">
                  {list.map((s) => (
                    <li key={s.id} className="sound-cell">
                      <button className="sound-btn" title={`${s.name}, added by ${s.addedBy.name}`}
                        onClick={() => sounds.play(s).catch((err) => toast(soundError(err), { kind: "error" }))}>
                        {s.emoji && <span className="sound-emoji" aria-hidden>{s.emoji}</span>}
                        <span className="sound-name">{s.name}</span>
                      </button>
                      {canDelete(s) && (
                        <button className="sound-del" aria-label={`Delete ${s.name}`} title="Delete" onClick={() => setDeleting(s)}><X aria-hidden /></button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {deleting && (
                <div className="sound-confirm" role="alert">
                  <span>Delete “{deleting.name}” for everyone?</span>
                  <span className="add-actions">
                    <button className="btn btn-danger btn-s" autoFocus onClick={() => void remove(deleting)}>Delete</button>
                    <button className="btn btn-quiet btn-s" onClick={() => setDeleting(null)}>Cancel</button>
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
