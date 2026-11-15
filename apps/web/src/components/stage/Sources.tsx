import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Layers, Volume2, VolumeX } from "lucide-react";

/** Anything that can be on the stage: the shared player, and (later) each person's cast stream. */
export interface StageSource {
  id: string;
  label: string;
  detail: string;
  thumbnail?: string | null;
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
      <button className="btn btn-quiet btn-s" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Layers aria-hidden />Sources <span className="quiet">{shown}/{sources.length}</span>
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
                    <button className="icon-btn" disabled={isHidden} aria-label={s.audible ? `Mute ${s.label}` : `Unmute ${s.label}`} title={s.audible ? "Mute" : "Unmute"}
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

/** Thumbnails of visible, unfocused sources. Clicking one focuses it. */
export function SourceStrip({ sources, onFocus, renderTile }: {
  sources: StageSource[];
  onFocus: (id: string) => void;
  renderTile: (s: StageSource) => React.ReactNode;
}) {
  if (!sources.length) return null;
  return (
    <ul className="source-strip" aria-label="Other sources">
      {sources.map((s) => (
        <li key={s.id} className="source-tile">
          <div className="source-media">{renderTile(s)}</div>
          <div className="source-bar">
            <button className="source-name" onClick={() => onFocus(s.id)} title="Focus">{s.label}</button>
            <button className="icon-btn" aria-label={s.audible ? `Mute ${s.label}` : `Unmute ${s.label}`} onClick={() => s.setAudible(!s.audible)}>
              {s.audible ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
