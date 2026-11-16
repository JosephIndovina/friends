import { Eye, EyeOff, LayoutGrid, PanelLeftClose, PanelLeftOpen, Play, SlidersHorizontal, Square, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { GoLive } from "./GoLive";

/** Anything that can be on the stage: the shared player, and each person's cast stream. */
export interface StageSource {
  id: string;
  label: string;
  detail: string;
  thumbnail?: string | null;
  /** a cast stream (shows the live dot) */
  live?: boolean;
  /** your own stream: Stop in place of the X */
  local?: boolean;
  /** no sound control: the tab that's streaming never plays itself back (defaults to `local`) */
  silent?: boolean;
  audible: boolean;
  setAudible: (v: boolean) => void;
  /** shown for this viewer: loaded, received and heard. Hidden uses no bandwidth. Only affects you, for this visit. */
  on: boolean;
  setOn: (on: boolean) => void;
  /** a cast stream from someone else: while off it shows on the stage as a card to watch */
  stream?: boolean;
  /** a live picture in place of the thumbnail: your own stream, so you can tell your streams apart */
  preview?: ReactNode;
  /** end it for everyone, when this viewer is allowed to: e.g. "Close for everyone". `confirm` asks first. No X without it. */
  end?: { label: string; run: () => void; confirm?: string };
  /** your own stream: its X is a Stop button instead */
  onStop?: () => void;
}

/**
 * The stage's source list: a column the full height of the stage, beside it rather than over it.
 * Expanded it has names, sound, show/hide and, where you're allowed, end for everyone (Stop for your own streams); collapsed it is thumbnails.
 * Clicking a source shows it large, and "All" shows every visible source as a grid. Going live sits at the foot.
 */
/** True while the media query matches (e.g. the phone layout). */
function useMedia(query: string) {
  const [match, setMatch] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setMatch(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [query]);
  return match;
}

export function StageRail({ sources, current, onShow, open: railOpen, setOpen, full }: {
  sources: StageSource[];
  /** the source shown large, or "all" for the grid */
  current: string | "all" | null;
  /** show one source large (turning it on), or null for the grid */
  onShow: (id: string | null) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** full screen: the rail is pinned down the left of the window, beside the stage */
  full?: boolean;
}) {
  const shown = sources.filter((s) => s.on).length;
  // Phones show the sources as a row of chips. Edit turns the row into a list with each source's
  // sound, show/hide and end controls (the desktop rail's expanded rows); Done goes back to chips.
  const phone = useMedia("(max-width: 860px)");
  const [managing, setManaging] = useState(false);
  const open = phone ? managing : railOpen;
  return (
    <nav className={`rail${open ? " is-open" : ""}${phone && managing ? " is-managing" : ""}${full ? " is-full" : ""}`} aria-label="Sources">
      <div className="rail-panel">
        <div className="rail-head">
          <button className="icon-btn rail-toggle" aria-expanded={open} aria-label={open ? "Collapse sources" : "Expand sources"} data-tip={open ? undefined : "Expand"}
            onClick={() => setOpen(!open)}>{open ? <PanelLeftClose aria-hidden /> : <PanelLeftOpen aria-hidden />}</button>
          {open && <span className="rail-title">Sources <span className="quiet">{shown}/{sources.length}</span></span>}
        </div>

        <ul className="rail-list">
          {sources.length > 1 && (
            <li className="rail-row">
              <button className="rail-item" aria-current={current === "all" || undefined} data-tip={open ? undefined : "All sources"} onClick={() => onShow(null)}>
                <span className="rail-thumb rail-thumb-icon"><LayoutGrid aria-hidden /></span>
                <span className="rail-text"><span className="rail-label">All</span><span className="rail-detail">Grid</span></span>
              </button>
            </li>
          )}
          {sources.map((s) => (
            <li key={s.id} className={`rail-row${s.on ? "" : " is-off"}`}>
              <button className="rail-item" aria-current={current === s.id || undefined} data-tip={open ? undefined : s.on ? s.label : `${s.label} (hidden)`}
                aria-label={s.on ? `Show ${s.label} large` : `Show ${s.label}`}
                onClick={() => onShow(s.id)}>
                <span className={`rail-thumb${s.live ? " is-live" : ""}${s.preview ? " has-preview" : ""}`}>
                  {s.preview && s.on ? s.preview : s.thumbnail ? <img src={s.thumbnail} alt="" /> : <span className="rail-initial">{s.label.slice(0, 1)}</span>}
                  {!s.on ? <span className="rail-badge"><EyeOff aria-hidden /></span> : !s.audible && !(s.silent ?? s.local) && <span className="rail-badge"><VolumeX aria-hidden /></span>}
                </span>
                <span className="rail-text">
                  <span className="rail-label">{s.label}</span>
                  <span className="rail-detail">{s.live && <span className="live-dot" aria-hidden />}{s.on ? s.detail : "Hidden"}</span>
                </span>
              </button>
              {s.onStop && (
                <button className="icon-btn rail-stop-mini" aria-label={`Stop ${s.label}`} data-tip={`Stop ${s.label.toLowerCase()}`} onClick={s.onStop}><Square aria-hidden /></button>
              )}
              {open && (
                <span className="rail-actions">
                  {!(s.silent ?? s.local) && s.on && (
                    <button className="icon-btn" aria-label={s.audible ? `Mute ${s.label}` : `Unmute ${s.label}`} title={s.audible ? "Mute" : "Unmute"}
                      onClick={() => s.setAudible(!s.audible)}>{s.audible ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}</button>
                  )}
                  {!(s.silent ?? s.local) && s.on && <span className="rail-sep" aria-hidden />}
                  <button className="icon-btn" aria-pressed={!s.on} aria-label={s.on ? `Hide ${s.label}` : `Show ${s.label}`} title={s.on ? "Hide for you" : "Show"}
                    onClick={() => s.setOn(!s.on)}>{s.on ? <Eye aria-hidden /> : <EyeOff aria-hidden />}</button>
                  {(s.onStop || s.end) && <span className="rail-sep" aria-hidden />}
                  <EndButton source={s} />
                </span>
              )}
            </li>
          ))}
        </ul>

        {phone && sources.length > 0 && (
          <button className="btn btn-quiet btn-s rail-edit" aria-expanded={managing} onClick={() => setManaging(!managing)}>
            {managing ? "Done" : <><SlidersHorizontal aria-hidden />Edit</>}
          </button>
        )}

        <div className="rail-foot">
          <GoLive icon={!open} />
        </div>
      </div>
    </nav>
  );
}

/**
 * The X on a source: ends it for everyone, and only shows when you're allowed to. Your own stream
 * gets Stop instead. Ending someone else's asks first, in a small popover fixed to the window so the
 * rail's scrolling list can't clip it.
 */
function EndButton({ source, className }: { source: StageSource; className?: string }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        btn.current?.focus();
      } else if (e.type === "mousedown" && (menu.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node))) return;
      setAt(null);
    };
    menu.current?.querySelector("button")?.focus();
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [at]);

  if (source.onStop) {
    return <button className={`btn btn-danger btn-s rail-stop${className ? ` ${className}` : ""}`} aria-label={`Stop ${source.label}`} onClick={source.onStop}><Square aria-hidden />Stop</button>;
  }
  const end = source.end;
  if (!end) return null;
  const click = () => {
    if (!end.confirm) return end.run();
    if (at) return setAt(null);
    const r = btn.current!.getBoundingClientRect();
    const w = 224;
    setAt({ top: r.bottom + 6, left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) });
  };
  return (
    <>
      <button ref={btn} className={`icon-btn${className ? ` ${className}` : ""}${at ? " is-open" : ""}`} aria-label={`${end.label}: ${source.label}`} title={end.label}
        aria-haspopup={end.confirm ? "menu" : undefined} aria-expanded={end.confirm ? Boolean(at) : undefined} onClick={click}><X aria-hidden /></button>
      {at && end.confirm && (
        <div ref={menu} className="remove-menu" role="menu" aria-label={end.label} style={{ top: at.top, left: at.left }}>
          <p className="remove-ask">{end.confirm}</p>
          <button role="menuitem" className="is-danger" onClick={() => { setAt(null); end.run(); }}>{end.label}</button>
          <button role="menuitem" onClick={() => setAt(null)}>Cancel</button>
        </div>
      )}
    </>
  );
}

/**
 * One source on the stage grid or the strip under a focused source. The whole tile shows it large.
 * The hit area stacks above the shared player, which can't take clicks here.
 */
export function StageTile({ source, onFocus, style, children }: {
  source: StageSource;
  onFocus: (id: string) => void;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  // An off stream: a card with the streamer's picture, to start watching.
  if (!source.on) {
    return (
      <li className="tile tile-offer" style={style}>
        <div className="tile-media">
          {source.thumbnail ? <img className="tile-art" src={source.thumbnail} alt="" /> : null}
          <span className="tile-offer-body">
            {source.thumbnail ? <img className="tile-offer-avatar" src={source.thumbnail} alt="" /> : <span className="tile-offer-avatar rail-initial">{source.label.slice(0, 1)}</span>}
            <span className="btn btn-primary btn-s" aria-hidden><Play aria-hidden />Watch</span>
          </span>
        </div>
        <button className="tile-hit" aria-label={`Watch ${source.label}`} onClick={() => onFocus(source.id)} />
        <span className="tile-name">
          <span className="live-dot" aria-hidden />
          <span className="tile-label">{source.label}</span>
        </span>
        <EndButton source={source} className="tile-remove" />
      </li>
    );
  }
  return (
    <li className="tile" style={style}>
      <div className="tile-media">{children}</div>
      <button className="tile-hit" aria-label={`Show ${source.label} large`} title="Show large" onClick={() => onFocus(source.id)} />
      <span className="tile-name">
        {source.live && <span className="live-dot" aria-hidden />}
        <span className="tile-label">{source.label}</span>
        {!source.audible && !(source.silent ?? source.local) && <VolumeX aria-label="Muted" />}
      </span>
    </li>
  );
}

/** Best fit for n 16:9 tiles in a W×H box: the column count that makes each tile largest. */
export function fitGrid(n: number, W: number, H: number, gap: number): { cols: number; w: number; h: number } {
  if (n <= 0 || W <= 0) return { cols: 1, w: 0, h: 0 };
  if (W < 600) return { cols: 1, w: Math.floor(W), h: Math.floor((W * 9) / 16) }; // phones: stack
  let best = { cols: 1, w: 0, h: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.floor(Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * (16 / 9)));
    if (w > best.w) best = { cols, w, h: Math.floor((w * 9) / 16) };
  }
  return best;
}
