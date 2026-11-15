import { Eye, EyeOff, LayoutGrid, PanelLeftClose, PanelLeftOpen, Square, Volume2, VolumeX } from "lucide-react";
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
}

/** One of your own streams, listed with its Stop button at the foot of the rail. */
export interface OwnStream {
  id: string;
  label: string;
  detail: string;
}

/**
 * The stage's source list, down the left of the stage. Collapsed it is a column of thumbnails;
 * expanded it floats over the stage with names, sound and hide. Clicking a source shows it large,
 * and "All" shows every visible source as a grid. Going live and stopping live at the foot.
 */
export function StageRail({ sources, hidden, setHidden, current, onShow, open, setOpen, own, onStop, floating }: {
  sources: StageSource[];
  hidden: ReadonlySet<string>;
  setHidden: (id: string, hide: boolean) => void;
  /** the source shown large, or "all" for the grid */
  current: string | "all" | null;
  /** show one source large, or null for the grid */
  onShow: (id: string | null) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  own: OwnStream[];
  onStop: (id: string) => void;
  /** full screen: the rail floats over the left edge and shows on hover */
  floating?: boolean;
}) {
  const shown = sources.filter((s) => !hidden.has(s.id)).length;
  return (
    <nav className={`rail${open ? " is-open" : ""}${floating ? " is-floating" : ""}`} aria-label="Sources">
      <div className="rail-panel">
        <div className="rail-head">
          <button className="icon-btn rail-toggle" aria-expanded={open} aria-label={open ? "Collapse sources" : "Expand sources"} data-tip={open ? undefined : "Expand"}
            onClick={() => setOpen(!open)}>{open ? <PanelLeftClose aria-hidden /> : <PanelLeftOpen aria-hidden />}</button>
          {open && <span className="rail-title">Sources <span className="quiet">{shown}/{sources.length}</span></span>}
        </div>

        <ul className="rail-list">
          {shown > 1 && (
            <li className="rail-row">
              <button className="rail-item" aria-current={current === "all" || undefined} data-tip={open ? undefined : "All sources"} onClick={() => onShow(null)}>
                <span className="rail-thumb rail-thumb-icon"><LayoutGrid aria-hidden /></span>
                <span className="rail-text"><span className="rail-label">All</span><span className="rail-detail">{shown} sources</span></span>
              </button>
            </li>
          )}
          {sources.map((s) => {
            const isHidden = hidden.has(s.id);
            return (
              <li key={s.id} className={`rail-row${isHidden ? " is-hidden" : ""}`}>
                <button className="rail-item" aria-current={current === s.id || undefined} data-tip={open ? undefined : isHidden ? `${s.label} (hidden)` : s.label}
                  aria-label={isHidden ? `Show ${s.label}` : `Show ${s.label} large`}
                  onClick={() => {
                    if (isHidden) setHidden(s.id, false);
                    onShow(s.id);
                  }}>
                  <span className={`rail-thumb${s.live ? " is-live" : ""}`}>
                    {s.thumbnail ? <img src={s.thumbnail} alt="" /> : <span className="rail-initial">{s.label.slice(0, 1)}</span>}
                    {isHidden ? <span className="rail-badge"><EyeOff aria-hidden /></span> : !s.audible && !s.local && <span className="rail-badge"><VolumeX aria-hidden /></span>}
                  </span>
                  <span className="rail-text">
                    <span className="rail-label">{s.label}</span>
                    <span className="rail-detail">{s.live && <span className="live-dot" aria-hidden />}{isHidden ? "Hidden" : s.detail}</span>
                  </span>
                </button>
                {open && (
                  <span className="rail-actions">
                    {!s.local && (
                      <button className="icon-btn" disabled={isHidden} aria-label={s.audible ? `Mute ${s.label}` : `Unmute ${s.label}`} title={s.audible ? "Mute" : "Unmute"}
                        onClick={() => s.setAudible(!s.audible)}>{s.audible ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}</button>
                    )}
                    <button className="icon-btn" aria-label={isHidden ? `Show ${s.label}` : `Hide ${s.label}`} title={isHidden ? "Show" : "Hide"}
                      onClick={() => setHidden(s.id, !isHidden)}>{isHidden ? <EyeOff aria-hidden /> : <Eye aria-hidden />}</button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        <div className="rail-foot">
          {own.map((s) => (
            <div key={s.id} className="rail-own">
              {open && (
                <span className="rail-text">
                  <span className="rail-label"><span className="live-dot" aria-hidden />You're live</span>
                  <span className="rail-detail">{s.detail}</span>
                </span>
              )}
              {open ? (
                <button className="btn btn-danger btn-s" onClick={() => onStop(s.id)}><Square aria-hidden />Stop</button>
              ) : (
                <button className="icon-btn rail-stop" aria-label={`Stop ${s.label}`} data-tip="Stop sharing" onClick={() => onStop(s.id)}><Square aria-hidden /></button>
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
  children: ReactNode;
}) {
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
