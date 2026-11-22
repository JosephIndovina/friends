import { Eye, EyeOff, FlipHorizontal2, LayoutGrid, PanelLeftClose, PanelLeftOpen, Play, SlidersHorizontal, Square, Video, VideoOff, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useCast } from "../../lib/cast";
import { VolumeHover } from "../media/parts";
import { GoLive } from "./GoLive";

/** Anything that can be on the stage: the shared player, and each person's cast stream. */
export interface StageSource {
  id: string;
  label: string;
  detail: string;
  thumbnail?: string | null;
  /** a cast stream (shows the live dot) */
  live?: boolean;
  /** your own stream */
  local?: boolean;
  /** no sound control: the tab that's streaming never plays itself back (defaults to `local`) */
  silent?: boolean;
  audible: boolean;
  setAudible: (v: boolean) => void;
  /** this viewer's volume for it, 0–100 (the volume panel) */
  volume?: number;
  setVolume?: (v: number) => void;
  /** shown for this viewer: loaded, received and heard. Hidden uses no bandwidth. Only affects you, for this visit. */
  on: boolean;
  setOn: (on: boolean) => void;
  /** a cast stream from someone else: while off it shows on the stage as a card to watch */
  stream?: boolean;
  /** the streamer's camera over their stream: shown or hidden for this viewer */
  camera?: { shown: boolean; set: (shown: boolean) => void };
  /** a live picture in place of the thumbnail: your own stream, so you can tell your streams apart */
  preview?: ReactNode;
  /** end it for everyone, when this viewer is allowed to: e.g. "Close for everyone". `confirm` asks first. No X without it.
   * Streams show Stop (a square) instead of an X: yours, and anyone's for moderators. */
  end?: { label: string; run: () => void; confirm?: string; stop?: boolean };
}

/**
 * The stage's source list: a column the full height of the stage, beside it rather than over it.
 * Expanded it has names, sound, show/hide and, where you're allowed, end for everyone; collapsed it is thumbnails.
 * Clicking a source focuses it, or unfocuses it if it was focused, like Discord: focused sources share the stage
 * and the rest sit in the strip below. "All" clears focus, back to the grid. Going live sits at the foot.
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

export function StageRail({ sources, focused, all, onToggle, onAll, open: railOpen, setOpen, full, theatre }: {
  sources: StageSource[];
  /** the focused sources */
  focused: ReadonlySet<string>;
  /** the grid is showing: nothing focused */
  all: boolean;
  /** focus a source (turning it on), or unfocus it */
  onToggle: (id: string) => void;
  /** clear focus: every source as a grid */
  onAll: () => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** full screen: the rail is pinned down the left of the window, beside the stage */
  full?: boolean;
  /** theatre mode hides the top bar, so the open rail's header carries the wordmark instead of "Sources" */
  theatre?: boolean;
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
        {/* Open, the title comes first and the collapse button sits at the right; collapsed, the button is all there is. */}
        <div className="rail-head">
          {open && (theatre
            ? <Link to="/" className="wordmark rail-wordmark">friends</Link>
            : <span className="rail-title">Sources <span className="quiet">{shown}/{sources.length}</span></span>)}
          <button className="icon-btn rail-toggle" aria-expanded={open} aria-label={open ? "Collapse sources" : "Expand sources"} data-tip={open ? undefined : "Expand"}
            onClick={() => setOpen(!open)}>{open ? <PanelLeftClose aria-hidden /> : <PanelLeftOpen aria-hidden />}</button>
        </div>

        <ul className="rail-list">
          {sources.length > 1 && (
            <li className="rail-row">
              <button className="rail-item" aria-pressed={all} data-tip={open ? undefined : "All sources"} onClick={onAll}>
                <span className="rail-thumb rail-thumb-icon"><LayoutGrid aria-hidden /></span>
                <span className="rail-text"><span className="rail-label">All</span><span className="rail-detail">Grid</span></span>
              </button>
            </li>
          )}
          {sources.map((s) => (
            <li key={s.id} className={`rail-row${s.on ? "" : " is-off"}`}>
              <button className="rail-item" aria-pressed={s.on && focused.has(s.id)} data-tip={open ? undefined : s.on ? s.label : `${s.label} (hidden)`}
                aria-label={!s.on ? `Show ${s.label}` : focused.has(s.id) ? `Unfocus ${s.label}` : `Focus ${s.label}`}
                onClick={() => onToggle(s.id)}>
                <span className={`rail-thumb${s.live ? " is-live" : ""}${s.preview ? " has-preview" : ""}`}>
                  {s.preview && s.on ? s.preview : s.thumbnail ? <img src={s.thumbnail} alt="" /> : <span className="rail-initial">{s.label.slice(0, 1)}</span>}
                  {!s.on ? <span className="rail-badge"><EyeOff aria-hidden /></span> : !s.audible && !(s.silent ?? s.local) && <span className="rail-badge"><VolumeX aria-hidden /></span>}
                </span>
                <span className="rail-text">
                  <span className="rail-label">{s.label}</span>
                  <span className="rail-detail">{s.live && <span className="live-dot" aria-hidden />}{s.on ? s.detail : "Hidden"}</span>
                </span>
              </button>
              {open && (
                <span className="rail-actions">
                  {!(s.silent ?? s.local) && s.on && (s.setVolume ? (
                    <VolumeHover label={s.label} volume={s.volume ?? 100} muted={!s.audible} setVolume={s.setVolume} setMuted={(m) => s.setAudible(!m)} align="end" />
                  ) : (
                    <button className="icon-btn" aria-label={s.audible ? `Mute ${s.label}` : `Unmute ${s.label}`} title={s.audible ? "Mute" : "Unmute"}
                      onClick={() => s.setAudible(!s.audible)}>{s.audible ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}</button>
                  ))}
                  {s.camera && s.on && (
                    <button className="icon-btn" aria-pressed={s.camera.shown} aria-label={s.camera.shown ? `Hide ${s.label}'s camera` : `Show ${s.label}'s camera`}
                      title={s.camera.shown ? "Hide camera" : "Show camera"} onClick={() => s.camera!.set(!s.camera!.shown)}>
                      {s.camera.shown ? <Video aria-hidden /> : <VideoOff aria-hidden />}
                    </button>
                  )}
                  {(!(s.silent ?? s.local) || s.camera) && s.on && <span className="rail-sep" aria-hidden />}
                  <button className="icon-btn" aria-pressed={!s.on} aria-label={s.on ? `Hide ${s.label}` : `Show ${s.label}`} title={s.on ? "Hide for you" : "Show"}
                    onClick={() => s.setOn(!s.on)}>{s.on ? <Eye aria-hidden /> : <EyeOff aria-hidden />}</button>
                  {s.end && <span className="rail-sep" aria-hidden />}
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
          <CameraButton icon={!open} />
          <GoLive icon={!open} />
        </div>
      </div>
    </nav>
  );
}

/**
 * Your camera on or off, beside Go live. It shows over your stream, or on its own when you aren't streaming.
 * Expanded, a camera picker shows while it's on, when there's more than one.
 */
function CameraButton({ icon }: { icon: boolean }) {
  const { camera, available } = useCast();
  if (!camera.allowed) return null;
  const label = camera.on ? "Turn off camera" : "Turn on camera";
  const tip = !available ? "Connecting to the stage…" : camera.busy ? "Starting camera…" : camera.error ?? label;
  const toggle = () => void camera.set(!camera.on);
  return (
    <div className="camera-ctl">
      {icon ? (
        <button className={`icon-btn${camera.on ? " is-live" : ""}`} aria-pressed={camera.on} aria-label="Camera" data-tip={tip}
          disabled={!available || camera.busy} onClick={toggle}>{camera.on ? <Video aria-hidden /> : <VideoOff aria-hidden />}</button>
      ) : (
        <button className="btn btn-s btn-quiet" aria-pressed={camera.on} disabled={!available || camera.busy} onClick={toggle}>
          {camera.on ? <VideoOff aria-hidden /> : <Video aria-hidden />}{camera.busy ? "Starting camera…" : label}
        </button>
      )}
      {!icon && camera.on && (
        <button className="btn btn-s btn-quiet" aria-pressed={camera.flipped} onClick={() => camera.setFlipped(!camera.flipped)}>
          <FlipHorizontal2 aria-hidden />Flip camera
        </button>
      )}
      {!icon && camera.on && camera.devices.length > 1 && (
        <select className="select select-s" aria-label="Camera" value={camera.deviceId ?? camera.devices[0]!.deviceId}
          onChange={(e) => camera.setDevice(e.target.value)}>
          {camera.devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
        </select>
      )}
      {camera.error && !icon && <p className="field-error" role="alert">{camera.error}</p>}
    </div>
  );
}

/**
 * The X (Stop, for a stream) on a source: ends it for everyone, and only shows when you're allowed to. Your own stream
 * stops straight away. Ending someone else's asks first, in a small popover fixed to the window so the
 * rail's scrolling list can't clip it.
 */
export function EndButton({ source, className }: { source: StageSource; className?: string }) {
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

  const end = source.end;
  if (!end) return null;
  const click = () => {
    if (!end.confirm) return end.run();
    if (at) return setAt(null);
    const r = btn.current!.getBoundingClientRect();
    const w = 224;
    // Under the button, or above it when it sits low (the stage bar).
    const h = 140;
    setAt({ top: r.bottom + 6 + h > window.innerHeight ? r.top - 6 - h : r.bottom + 6, left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) });
  };
  return (
    <>
      <button ref={btn} className={`icon-btn${className ? ` ${className}` : ""}${at ? " is-open" : ""}`} aria-label={`${end.label}: ${source.label}`} title={end.label}
        aria-haspopup={end.confirm ? "menu" : undefined} aria-expanded={end.confirm ? Boolean(at) : undefined} onClick={click}>{end.stop ? <Square aria-hidden /> : <X aria-hidden />}</button>
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
 * One source on the stage grid or the strip under the focused ones. Clicking the tile focuses it, or unfocuses it when it's focused.
 * The hit area stacks above the shared player, which never takes clicks.
 */
export function StageTile({ source, focused, onFocus, controls, style, children }: {
  source: StageSource;
  /** its own play, skip and seek, over the bottom of the tile on hover */
  controls?: ReactNode;
  /** focused: clicking unfocuses it */
  focused?: boolean;
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
    <li className={`tile${controls ? " has-controls" : ""}`} style={style}>
      <div className="tile-media">{children}</div>
      <button className={`tile-hit${focused ? " is-focused" : ""}`} aria-label={focused ? `Unfocus ${source.label}` : `Focus ${source.label}`}
        title={focused ? "Unfocus" : "Focus"} onClick={() => onFocus(source.id)} />
      <span className="tile-name">
        {source.live && <span className="live-dot" aria-hidden />}
        <span className="tile-label">{source.label}</span>
        {!source.audible && !(source.silent ?? source.local) && <VolumeX aria-label="Muted" />}
      </span>
      {controls && <div className="tile-controls">{controls}</div>}
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
