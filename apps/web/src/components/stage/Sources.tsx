import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Layers, Volume2, VolumeX } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

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

/** Per-viewer list of stage sources: show or hide each one, and turn its sound on or off. */
export function SourcesMenu({ sources, hidden, setHidden }: {
  sources: StageSource[];
  hidden: ReadonlySet<string>;
  setHidden: (id: string, hide: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
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

  const shown = sources.filter((s) => !hidden.has(s.id)).length;
  return (
    <div className="sources" ref={root}>
      <button className="btn btn-quiet btn-s" aria-expanded={open} aria-label={`Sources, ${shown} of ${sources.length} shown`} onClick={() => setOpen(!open)}>
        <Layers aria-hidden /><span className="sources-word">Sources </span><span className="quiet">{shown}/{sources.length}</span>
      </button>
      {open && (
        <div className="stack-panel sources-panel" role="dialog" aria-label="Sources">
          <h2>Sources</h2>
          {sources.length === 0 ? <p className="block-note">Nothing to show.</p> : (
            <ul>
              {sources.map((s) => {
                const isHidden = hidden.has(s.id);
                return (
                  <li key={s.id} className={isHidden ? "is-hidden" : undefined}>
                    {s.thumbnail ? <img className="thumb" src={s.thumbnail} alt="" /> : <span className="thumb" />}
                    <span className="who"><span>{s.label}</span><span className="where">{isHidden ? "Hidden" : s.detail}</span></span>
                    <button className="icon-btn" disabled={isHidden || s.local} aria-label={s.audible ? `Mute ${s.label}` : `Unmute ${s.label}`} title={s.audible ? "Mute" : "Unmute"}
                      onClick={() => s.setAudible(!s.audible)}>{s.audible ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}</button>
                    <button className="icon-btn" aria-label={isHidden ? `Show ${s.label}` : `Hide ${s.label}`} title={isHidden ? "Show" : "Hide"}
                      onClick={() => setHidden(s.id, !isHidden)}>{isHidden ? <EyeOff aria-hidden /> : <Eye aria-hidden />}</button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One source on the stage grid or the strip under a focused source. The whole tile focuses it;
 * sound and hide sit in the corner. The hit area stacks above the shared player, which can't take clicks here.
 */
export function StageTile({ source, onFocus, onHide, style, children }: {
  source: StageSource;
  onFocus: (id: string) => void;
  onHide: (id: string) => void;
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
      <span className="tile-actions">
        {!source.local && (
          <button className="tile-btn" aria-label={source.audible ? `Mute ${source.label}` : `Unmute ${source.label}`} title={source.audible ? "Mute" : "Unmute"}
            onClick={() => source.setAudible(!source.audible)}>{source.audible ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}</button>
        )}
        <button className="tile-btn" aria-label={`Hide ${source.label}`} title="Hide" onClick={() => onHide(source.id)}><EyeOff aria-hidden /></button>
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
