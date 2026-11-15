import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, ListPlus, SmilePlus, Trash2, X } from "lucide-react";
import { REACTIONS, type Post, type Session } from "@friends/shared";
import { api, ApiError, can } from "../../lib/api";
import { ago } from "../../lib/format";
import { mediaAction, mediaError } from "../../lib/media";
import { getSocket } from "../../lib/socket";
import { Avatar } from "../Avatar";

const UPLOAD_ERRORS: Record<string, string> = {
  file_too_large: "That file is too big (images up to 15 MB, videos up to 200 MB).",
  unsupported_type: "Only images (JPEG, PNG, GIF, WebP, AVIF) and videos (MP4, WebM, MOV) can be attached.",
};
const POST_ERRORS: Record<string, string> = {
  empty_post: "Write something or attach a file.",
  invalid_upload: "An attachment is no longer available. Remove it and try again.",
  not_yours: "You can only delete your own posts.",
  missing_permission: "You don’t have permission to do that.",
};
const msg = (e: unknown, table: Record<string, string>) => (e instanceof ApiError ? (table[e.code] ?? "Something went wrong. Try again.") : "Something went wrong. Try again.");

interface Pending {
  key: string;
  file: File;
  preview: string;
  progress: number;
  id?: string;
  error?: string;
}

/** Upload with progress (fetch has no upload progress). */
function upload(file: File, onProgress: (p: number) => void): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const data = (() => {
        try {
          return JSON.parse(xhr.responseText);
        } catch {
          return {};
        }
      })();
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data.error ?? (xhr.status === 413 ? "file_too_large" : "server_error")));
    };
    xhr.onerror = () => reject(new ApiError(0, "network"));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

function Composer({ me, onPosted }: { me: Session["user"]; onPosted: (p: Post) => void }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | File[]) => {
    const picked = [...list].filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/")).slice(0, 6 - files.length);
    for (const file of picked) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      setFiles((fs) => [...fs, { key, file, preview: URL.createObjectURL(file), progress: 0 }]);
      upload(file, (progress) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, progress } : f))))
        .then(({ id }) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, id, progress: 1 } : f))))
        .catch((e) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, error: msg(e, UPLOAD_ERRORS) } : f))));
    }
  };
  const remove = (key: string) =>
    setFiles((fs) => {
      const f = fs.find((x) => x.key === key);
      if (f) URL.revokeObjectURL(f.preview);
      return fs.filter((x) => x.key !== key);
    });

  const uploading = files.some((f) => !f.id && !f.error);
  const ready = (text.trim() || files.some((f) => f.id)) && !uploading && !files.some((f) => f.error);

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const post = await api<Post>("POST", "/api/posts", { text, uploadIds: files.filter((f) => f.id).map((f) => f.id) });
      files.forEach((f) => URL.revokeObjectURL(f.preview));
      setFiles([]);
      setText("");
      onPosted(post);
    } catch (e) {
      setError(msg(e, POST_ERRORS));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={`composer${dragging ? " is-dragging" : ""}`}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
    >
      <Avatar src={me.avatarUrl} name={me.name} size={36} />
      <div className="composer-body">
        <label className="visually-hidden" htmlFor="composer-text">Write a post</label>
        <textarea id="composer-text" className="input composer-text" placeholder="Write something, paste a link or drop an image" value={text} maxLength={2000} rows={2}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(); }} />
        {files.length > 0 && (
          <ul className="attachments">
            {files.map((f) => (
              <li key={f.key} className={f.error ? "has-error" : undefined}>
                {f.file.type.startsWith("video/") ? <video src={f.preview} muted /> : <img src={f.preview} alt="" />}
                {!f.id && !f.error && <span className="progress" style={{ "--p": `${Math.round(f.progress * 100)}%` } as React.CSSProperties} />}
                <button type="button" className="icon-btn attach-remove" aria-label={`Remove ${f.file.name}`} onClick={() => remove(f.key)}><X aria-hidden /></button>
                {f.error && <span className="attach-error">{f.error}</span>}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="composer-actions">
          <input ref={input} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
          <button type="button" className="btn btn-quiet btn-s" disabled={files.length >= 6} onClick={() => input.current?.click()}><ImagePlus aria-hidden />Attach</button>
          <span className="quiet composer-hint">{uploading ? "Uploading…" : text.length > 1800 ? `${2000 - text.length} characters left` : ""}</span>
          <button className="btn btn-primary btn-s" disabled={!ready || busy}>{busy ? "Posting…" : "Post"}</button>
        </div>
      </div>
    </form>
  );
}

/** Text with links made clickable. Rendered as text nodes and anchors only, never as HTML. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/gi);
  return (
    <p className="post-text">
      {parts.map((part, i) =>
        /^https?:\/\//i.test(part) ? <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow">{part}</a> : part,
      )}
    </p>
  );
}

function PostCard({ post, session, onChange, onOpenImage }: { post: Post; session: Session; onChange: (p: Post | null) => void; onOpenImage: (src: string) => void }) {
  const [picker, setPicker] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const mine = post.author.id === session.user.id;
  const canDelete = mine || can(session, "posts.moderate");
  const canReact = can(session, "posts.create");

  const react = async (emoji: string) => {
    setPicker(false);
    try {
      onChange(await api<Post>("POST", `/api/posts/${post.id}/react`, { emoji }));
    } catch (e) {
      setNote(msg(e, POST_ERRORS));
    }
  };

  return (
    <article className="post" aria-labelledby={`post-${post.id}`}>
      <Avatar src={post.author.avatarUrl} name={post.author.name} size={36} />
      <div className="post-body">
        <header className="post-head">
          <span id={`post-${post.id}`} className="post-author">{post.author.name}</span>
          <time className="quiet" dateTime={new Date(post.createdAt).toISOString()} title={new Date(post.createdAt).toLocaleString()}>{ago(post.createdAt)}</time>
          {canDelete && (
            <button className="icon-btn post-delete" aria-label="Delete post" title={mine ? "Delete" : "Delete (moderator)"}
              onClick={async () => {
                if (!window.confirm("Delete this post?")) return;
                try {
                  await api("DELETE", `/api/posts/${post.id}`);
                  onChange(null);
                } catch (e) {
                  setNote(msg(e, POST_ERRORS));
                }
              }}><Trash2 aria-hidden /></button>
          )}
        </header>
        {post.text && <Linkified text={post.text} />}
        {post.media.length > 0 && (
          <div className={`post-media count-${Math.min(post.media.length, 4)}`}>
            {post.media.map((m) =>
              m.kind === "video" ? (
                <video key={m.id} src={m.url} controls preload="metadata" playsInline />
              ) : (
                <button key={m.id} className="post-image" onClick={() => onOpenImage(m.url)} aria-label="Open image">
                  <img src={m.url} alt="" loading="lazy" />
                </button>
              ),
            )}
          </div>
        )}
        {post.preview && (
          <div className="link-card">
            {post.preview.image && <img src={post.preview.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
            <div className="link-text">
              <span className="quiet">{post.preview.site}</span>
              <a href={post.preview.url} target="_blank" rel="noopener noreferrer nofollow" className="link-title">{post.preview.title}</a>
              {post.preview.description && <span className="link-desc">{post.preview.description}</span>}
              {post.preview.playable && can(session, "player.queue") && (
                <button className="btn btn-quiet btn-s link-queue" onClick={() => mediaAction("media:add", { url: post.preview!.url }).then(() => setNote("Added to the queue.")).catch((e) => setNote(mediaError(e)))}>
                  <ListPlus aria-hidden />Add to queue
                </button>
              )}
            </div>
          </div>
        )}
        <div className="reactions">
          {post.reactions.map((r) => (
            <button key={r.emoji} className={`reaction${r.mine ? " is-mine" : ""}`} title={r.names.join(", ")} disabled={!canReact} onClick={() => react(r.emoji)}
              aria-label={`${r.emoji} ${r.count}${r.mine ? ", including you" : ""}`} aria-pressed={r.mine}>
              <span aria-hidden>{r.emoji}</span> {r.count}
            </button>
          ))}
          {canReact && (
            <span className="react-add">
              <button className="icon-btn" aria-label="Add reaction" aria-expanded={picker} onClick={() => setPicker(!picker)}><SmilePlus aria-hidden /></button>
              {picker && (
                <span className="react-picker" role="menu">
                  {REACTIONS.map((e) => <button key={e} role="menuitem" onClick={() => react(e)} aria-label={`React ${e}`}>{e}</button>)}
                </span>
              )}
            </span>
          )}
        </div>
        {note && <p className="block-note" role="status">{note}</p>}
      </div>
    </article>
  );
}

export function Feed({ session }: { session: Session }) {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [more, setMore] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    api<{ posts: Post[]; more: boolean }>("GET", "/api/posts").then((r) => (setPosts(r.posts), setMore(r.more))).catch(() => setPosts([]));
  }, []);

  const upsert = useCallback((p: Post) => {
    setPosts((cur) => {
      if (!cur) return cur;
      const i = cur.findIndex((x) => x.id === p.id);
      if (i >= 0) return cur.map((x) => (x.id === p.id ? p : x));
      return [p, ...cur].sort((a, b) => b.createdAt - a.createdAt);
    });
  }, []);

  useEffect(() => {
    const s = getSocket();
    const on = ({ id, deleted }: { id: string; deleted?: boolean }) => {
      if (deleted) return setPosts((cur) => cur?.filter((p) => p.id !== id) ?? cur);
      api<Post>("GET", `/api/posts/${id}`).then(upsert).catch(() => setPosts((cur) => cur?.filter((p) => p.id !== id) ?? cur));
    };
    s.on("posts:changed", on);
    return () => {
      s.off("posts:changed", on);
    };
  }, [upsert]);

  useEffect(() => {
    if (lightbox) dialog.current?.showModal();
  }, [lightbox]);

  return (
    <section className="stream" aria-labelledby="stream-title">
      <h2 id="stream-title">Posts</h2>
      {can(session, "posts.create") && <Composer me={session.user} onPosted={upsert} />}
      {posts && posts.length === 0 && <p className="empty">No posts yet.</p>}
      <div className="posts">
        {posts?.map((p) => (
          <PostCard key={p.id} post={p} session={session} onOpenImage={setLightbox}
            onChange={(next) => (next ? upsert(next) : setPosts((cur) => cur?.filter((x) => x.id !== p.id) ?? cur))} />
        ))}
      </div>
      {more && posts && (
        <button className="btn btn-quiet" onClick={async () => {
          const r = await api<{ posts: Post[]; more: boolean }>("GET", `/api/posts?before=${posts.at(-1)!.createdAt}`);
          setPosts([...posts, ...r.posts]);
          setMore(r.more);
        }}>Load older posts</button>
      )}
      <dialog ref={dialog} className="lightbox" onClose={() => setLightbox(null)} onClick={(e) => e.target === dialog.current && dialog.current?.close()}>
        {lightbox && <img src={lightbox} alt="" />}
        <button className="icon-btn lightbox-close" aria-label="Close" onClick={() => dialog.current?.close()}><X aria-hidden /></button>
      </dialog>
    </section>
  );
}
