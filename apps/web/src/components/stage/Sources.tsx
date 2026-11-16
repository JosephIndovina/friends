import { LayoutGrid, PanelLeftClose, PanelLeftOpen, Play, PowerOff, RotateCcw, Square, Volume2, VolumeX, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { GoLive } from "./GoLive";

/** Anything that can be on the stage: the shared player, and each person's cast stream. */
export interface StageSource {
  id: string;
  label: string;
  detail: string;
  thumbnail?: string | null;
  /** a cast stream (shows the live dot) */
  live?: boolean;
  /** your own stream: never played back to you, so it has no sound control */
  local?: boolean;
  audible: boolean;
  setAudible: (v: boolean) => void;
  /** on for this viewer: loaded, received and heard. Off uses no bandwidth. Only affects you. */
  on: boolean;
  setOn: (on: boolean) => void;
  /** a cast stream from someone else: while off it shows on the stage as a card to watch */
  stream?: boolean;
  /** take it out of this viewer's list (and turn it off) */
  onRemove: () => void;
}

/** One of your own streams, listed with its Stop button at the foot of the rail. */
export interface OwnStream {
  id: string;
  /** the same name its source row and tile use, e.g. "Your screen 2" */
  label: string;
  detail: string;
  /** a live thumbnail of what you're sharing, so you can tell your streams apart */
  preview: ReactNode;
}

/**
 * The stage's source list: a column the full height of the stage, beside it rather than over it.
 * Expanded it has names, sound and hide; collapsed it is thumbnails. Clicking a source shows it large,
 * and "All" shows every visible source as a grid. Going live and stopping sit at the foot.
 */
export function StageRail({ sources, current, onShow, removedCount, onRestore, open, setOpen, own, onStop, full }: {
  sources: StageSource[];
  /** the source shown large, or "all" for the grid */
  current: string | "all" | null;
  /** show one source large (turning it on), or null for the grid */
  onShow: (id: string | null) => void;
  /** sources removed from this list that are still around */
  removedCount: number;
  onRestore: () => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  own: OwnStream[];
  onStop: (id: string) => void;
  /** full screen: the rail is pinned down the left of the window, beside the stage */
  full?: boolean;
}) {
  const shown = sources.filter((s) => s.on).length;
  return (
    <nav className={`rail${open ? " is-open" : ""}${full ? " is-full" : ""}`} aria-label="Sources">
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
                <span className="rail-text"><span className="rail-label">All</span><span className="rail-detail">{shown} on</span></span>
              </button>
            </li>
          )}
          {sources.map((s) => (
            <li key={s.id} className={`rail-row${s.on ? "" : " is-off"}`}>
              <button className="rail-item" aria-current={current === s.id || undefined} data-tip={open ? undefined : s.on ? s.label : `${s.label} (off)`}
                aria-label={s.on ? `Show ${s.label} large` : `Turn on ${s.label}`}
                onClick={() => onShow(s.id)}>
                <span className={`rail-thumb${s.live ? " is-live" : ""}`}>
                  {s.thumbnail ? <img src={s.thumbnail} alt="" /> : <span className="rail-initial">{s.label.slice(0, 1)}</span>}
                  {!s.on ? <span className="rail-badge"><PowerOff aria-hidden /></span> : !s.audible && !s.local && <span className="rail-badge"><VolumeX aria-hidden /></span>}
                </span>
                <span className="rail-text">
                  <span className="rail-label">{s.label}</span>
                  <span className="rail-detail">{s.live && <span className="live-dot" aria-hidden />}{s.on ? s.detail : "Off"}</span>
                </span>
              </button>
              {open && (
                <span className="rail-actions">
                  {!s.local && s.on && (
                    <button className="icon-btn" aria-label={s.audible ? `Mute ${s.label}` : `Unmute ${s.label}`} title={s.audible ? "Mute" : "Unmute"}
                      onClick={() => s.setAudible(!s.audible)}>{s.audible ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}</button>
                  )}
                  {!s.local && s.on && <span className="rail-sep" aria-hidden />}
                  <label className="rail-switch" title={s.on ? "Turn off for you" : "Turn on"}>
                    <input type="checkbox" role="switch" checked={s.on} aria-label={`${s.label} on`} onChange={(e) => s.setOn(e.target.checked)} />
                    <span className="switch" aria-hidden />
                  </label>
                  <span className="rail-sep" aria-hidden />
                  <button className="icon-btn" aria-label={`Remove ${s.label} from your list`} title="Remove from your list" onClick={s.onRemove}><X aria-hidden /></button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {open && removedCount > 0 && (
          <button className="btn btn-quiet btn-s rail-restore" onClick={onRestore}><RotateCcw aria-hidden />Bring back {removedCount} removed</button>
        )}

        <div className="rail-foot">
          {open && own.length > 0 && <span className="rail-foot-title"><span className="live-dot" aria-hidden />You're live</span>}
          {own.map((s, i) => (
            <div key={s.id} className="rail-own">
              {open ? (
                <>
                  <button className="rail-preview" aria-label={`Show ${s.label} large`} onClick={() => onShow(s.id)}>{s.preview}</button>
                  <span className="rail-text">
                    <span className="rail-label">{s.label}</span>
                    <span className="rail-detail">{s.detail}</span>
                  </span>
                  <button className="btn btn-danger btn-s" aria-label={`Stop ${s.label}`} onClick={() => onStop(s.id)}><Square aria-hidden />Stop</button>
                </>
              ) : (
                <button className="icon-btn rail-stop" aria-label={`Stop ${s.label}`} data-tip={`Stop ${s.label.toLowerCase()}`} onClick={() => onStop(s.id)}>
                  <Square aria-hidden />{own.length > 1 && <span className="rail-stop-n">{i + 1}</span>}
                </button>
              )}
            </div>
          ))}
          <GoLive icon={!open} />
        </div>
      </div>
    </nav>
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
        <button className="icon-btn tile-remove" aria-label={`Remove ${source.label} from your list`} title="Remove from your list" onClick={source.onRemove}><X aria-hidden /></button>
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
        {!source.audible && !source.local && <VolumeX aria-label="Muted" />}
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
