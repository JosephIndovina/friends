import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, BookmarkPlus, ListPlus, Pencil, Play, Plus, Shuffle, Trash2, X } from "lucide-react";
import type { Playlist, PlaylistSummary, Session } from "@friends/shared";
import { api, ApiError, can } from "../../lib/api";
import { ago } from "../../lib/format";
import { fmtTime } from "../../lib/media";

const ERRORS: Record<string, string> = {
  already_in_playlist: "That’s already in the playlist.",
  playlist_full: "That playlist is full (500 items).",
  not_yours: "Only the playlist’s owner or a moderator can do that.",
  queue_full: "The queue is full (200 items).",
  missing_permission: "You don’t have permission to do that.",
  item_not_found: "That item is no longer available.",
};
const msg = (e: unknown) => (e instanceof ApiError ? (ERRORS[e.code] ?? "Something went wrong. Try again.") : "Something went wrong. Try again.");

export function usePlaylists() {
  const [list, setList] = useState<PlaylistSummary[] | null>(null);
  const reload = useCallback(() => api<PlaylistSummary[]>("GET", "/api/playlists").then(setList).catch(() => setList([])), []);
  useEffect(() => void reload(), [reload]);
  return { list, reload };
}

/** "Save to playlist" for one item: pick a playlist or make a new one. */
export function SaveToPlaylist({ itemId, label }: { itemId: string; label: string }) {
  const [open, setOpen] = useState(false);
  const { list, reload } = usePlaylists();
  const [name, setName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    void reload();
    setNote(null);
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open, reload]);

  const add = async (id: string, pname: string) => {
    try {
      await api("POST", `/api/playlists/${id}/items`, { itemId });
      setNote(`Saved to ${pname}.`);
      void reload();
    } catch (e) {
      setNote(msg(e));
    }
  };

  return (
    <div className="sources" ref={root}>
      <button className="icon-btn" aria-label={`Save ${label} to a playlist`} title="Save to playlist" aria-expanded={open} onClick={() => setOpen(!open)}><BookmarkPlus aria-hidden /></button>
      {open && (
        <div className="stack-panel save-panel" role="dialog" aria-label="Save to playlist">
          <h2>Save to playlist</h2>
          {note && <p className="block-note" role="status">{note}</p>}
          <ul>
            {(list ?? []).map((p) => (
              <li key={p.id}><button className="save-row" onClick={() => add(p.id, p.name)}><span>{p.name}</span><span className="quiet">{p.count}</span></button></li>
            ))}
          </ul>
          <form className="inline-form" onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            try {
              const { id } = await api<{ id: string }>("POST", "/api/playlists", { name: name.trim() });
              await add(id, name.trim());
              setName("");
            } catch (err) {
              setNote(msg(err));
            }
          }}>
            <input className="input grow" placeholder="New playlist" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="New playlist name" />
            <button className="btn btn-quiet btn-s" disabled={!name.trim()}><Plus aria-hidden />Create</button>
          </form>
        </div>
      )}
    </div>
  );
}

/** The Playlists tab: browse, open, queue, shuffle, rename, delete. */
export function PlaylistsPanel({ session, queueCount }: { session: Session; queueCount: number }) {
  const { list, reload } = usePlaylists();
  const [open, setOpen] = useState<Playlist | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  /** the open playlist's footer: its actions, the rename field, or the delete question */
  const [edit, setEdit] = useState<{ kind: "rename"; name: string } | { kind: "delete" } | null>(null);
  const queue = can(session, "player.queue");
  const control = can(session, "player.control");

  const openList = async (id: string) => {
    try {
      const pl = await api<Playlist>("GET", `/api/playlists/${id}`);
      setOpen((cur) => {
        if (cur?.id !== pl.id) setEdit(null);
        return pl;
      });
    } catch (e) {
      setNote({ kind: "error", text: msg(e) });
    }
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setNote({ kind: "ok", text: ok });
    } catch (e) {
      setNote({ kind: "error", text: msg(e) });
    }
  };

  if (open) {
    const editable = open.owner.id === session.user.id || can(session, "playback.moderate");
    return (
      <div className="block">
        <div className="block-head">
          <button className="btn btn-quiet btn-s" onClick={() => { setOpen(null); setNote(null); setEdit(null); void reload(); }}><ArrowLeft aria-hidden />Playlists</button>
        </div>
        <h2 className="playlist-name">{open.name}</h2>
        <p className="block-note">{open.items.length} items · by {open.owner.name}</p>
        {note && <p className={`flash flash-${note.kind}`} role="status">{note.text}</p>}
        {queue && open.items.length > 0 && (
          <div className="add-actions">
            <button className="btn btn-primary btn-s" onClick={() => run(() => api("POST", `/api/playlists/${open.id}/play`, {}), `Queued ${open.name}.`)}><Play aria-hidden />Queue all</button>
            <button className="btn btn-quiet btn-s" onClick={() => run(() => api("POST", `/api/playlists/${open.id}/play`, { shuffle: true }), `Queued ${open.name}, shuffled.`)}><Shuffle aria-hidden />Shuffle</button>
            {control && <button className="btn btn-quiet btn-s" onClick={() => run(() => api("POST", `/api/playlists/${open.id}/play`, { playNext: true }), `${open.name} plays next.`)}><ListPlus aria-hidden />Play next</button>}
          </div>
        )}
        <ol className="queue">
          {open.items.map((item, i) => (
            <li key={`${item.ref}-${i}`} className="queue-item">
              {item.thumbnail ? <img className="thumb" src={item.thumbnail} alt="" loading="lazy" /> : <span className="thumb" />}
              <span className="queue-text">
                <span className="queue-title" title={item.title}>{item.title}</span>
                <span className="queue-meta">{[item.duration ? fmtTime(item.duration) : null, item.addedBy.name].filter(Boolean).join(" · ")}</span>
              </span>
              {(editable || item.addedBy.id === session.user.id) && (
                <span className="queue-actions">
                  <button className="icon-btn danger" aria-label={`Remove ${item.title}`} title="Remove"
                    onClick={() => run(async () => { await api("DELETE", `/api/playlists/${open.id}/items/${i}`); await openList(open.id); }, "Removed.")}><X aria-hidden /></button>
                </span>
              )}
            </li>
          ))}
        </ol>
        {editable && !edit && (
          <div className="add-actions">
            <button className="btn btn-quiet btn-s" onClick={() => setEdit({ kind: "rename", name: open.name })}><Pencil aria-hidden />Rename</button>
            <button className="btn btn-quiet btn-s" onClick={() => setEdit({ kind: "delete" })}><Trash2 aria-hidden />Delete</button>
          </div>
        )}
        {editable && edit?.kind === "rename" && (
          <form className="inline-form" onSubmit={async (e) => {
            e.preventDefault();
            const name = edit.name.trim();
            if (!name) return;
            await run(async () => { await api("PATCH", `/api/playlists/${open.id}`, { name }); await openList(open.id); }, "Renamed.");
            setEdit(null);
          }}>
            <input className="input grow" value={edit.name} maxLength={60} autoFocus aria-label="Playlist name"
              onChange={(e) => setEdit({ kind: "rename", name: e.target.value })} onKeyDown={(e) => e.key === "Escape" && setEdit(null)} />
            <button className="btn btn-primary btn-s" disabled={!edit.name.trim()}>Save</button>
            <button type="button" className="btn btn-quiet btn-s" onClick={() => setEdit(null)}>Cancel</button>
          </form>
        )}
        {editable && edit?.kind === "delete" && (
          <div className="choice" role="group" aria-label={`Delete ${open.name}`}>
            <span>Delete {open.name}? This can’t be undone.</span>
            <div className="add-actions">
              <button className="btn btn-danger btn-s" autoFocus onClick={async () => {
                await run(async () => { await api("DELETE", `/api/playlists/${open.id}`); setOpen(null); await reload(); }, "Deleted.");
                setEdit(null);
              }}><Trash2 aria-hidden />Delete</button>
              <button className="btn btn-quiet btn-s" onClick={() => setEdit(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="block">
      {note && <p className={`flash flash-${note.kind}`} role="status">{note.text}</p>}
      {list === null ? null : list.length === 0 ? <p className="block-note">No playlists yet.</p> : (
        <ul className="queue">
          {list.map((p) => (
            <li key={p.id} className="queue-item playlist-row" onClick={() => openList(p.id)}>
              {p.cover ? <img className="thumb" src={p.cover} alt="" loading="lazy" /> : <span className="thumb" />}
              <span className="queue-text">
                <button className="queue-title playlist-open" onClick={(e) => { e.stopPropagation(); void openList(p.id); }}>{p.name}</button>
                <span className="queue-meta">{p.count} items · {p.owner.name} · {ago(p.updatedAt)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {queue && (saving ? (
        <form className="inline-form" onSubmit={async (e) => {
          e.preventDefault();
          if (!newName.trim()) return;
          await run(() => api("POST", "/api/playlists", { name: newName.trim(), fromQueue: true }), `Saved the queue as ${newName.trim()}.`);
          setNewName("");
          setSaving(false);
          void reload();
        }}>
          <input className="input grow" placeholder="Playlist name" value={newName} maxLength={60} autoFocus onChange={(e) => setNewName(e.target.value)} aria-label="Playlist name"
            onKeyDown={(e) => e.key === "Escape" && setSaving(false)} />
          <button className="btn btn-primary btn-s" disabled={!newName.trim()}>Save</button>
          <button type="button" className="btn btn-quiet btn-s" onClick={() => setSaving(false)}>Cancel</button>
        </form>
      ) : (
        <div className="add-actions">
          <button className="btn btn-quiet btn-s" disabled={queueCount === 0} title={queueCount === 0 ? "The queue is empty" : undefined} onClick={() => setSaving(true)}>
            <Plus aria-hidden />Save queue as playlist
          </button>
        </div>
      ))}
    </div>
  );
}
