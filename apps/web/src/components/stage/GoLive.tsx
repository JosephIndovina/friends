import { useEffect, useRef, useState } from "react";
import { Radio } from "lucide-react";
import { STREAM_MODES, useCast, type StreamMode } from "../../lib/cast";

function readMode(): StreamMode {
  try {
    const saved = JSON.parse(localStorage.getItem("streamMode") ?? "null") as StreamMode | null;
    if (saved && saved.width && saved.fps && saved.kbps) return saved;
  } catch {
    /* default */
  }
  return STREAM_MODES[0]!;
}

const RES = [
  { label: "720p", width: 1280, height: 720 },
  { label: "1080p", width: 1920, height: 1080 },
  { label: "1440p", width: 2560, height: 1440 },
] as const;

/** Go live with a chosen quality mode. Each extra click adds another screen. */
export function GoLive({ icon }: { icon?: boolean } = {}) {
  const cast = useCast();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<StreamMode>(readMode);
  const [custom, setCustom] = useState(() => ({ res: 1, fps: 60, mbps: 6 }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const mine = cast.streams.filter((s) => s.local).length;

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

  if (!cast.canStream) return null;
  if (!cast.supported) return icon ? null : <span className="quiet go-live-note">Going live works from a desktop browser.</span>;

  const customMode = (): StreamMode => {
    const r = RES[custom.res]!;
    return { id: "custom", label: "Custom", detail: `${r.label} · ${custom.fps} fps · ${custom.mbps} Mbps`, width: r.width, height: r.height, fps: custom.fps, kbps: custom.mbps * 1000, hint: custom.fps <= 15 ? "detail" : "motion" };
  };

  const start = async () => {
    const m = mode.id === "custom" ? customMode() : mode;
    try {
      localStorage.setItem("streamMode", JSON.stringify(m));
    } catch {
      /* this visit only */
    }
    setBusy(true);
    setError(null);
    const err = await cast.goLive(m);
    setBusy(false);
    if (err) setError(err);
    else setOpen(false);
  };

  return (
    <div className="sources go-live" ref={root}>
      {icon ? (
        <button className={`icon-btn${mine ? " is-live" : ""}`} aria-expanded={open} disabled={!cast.available} onClick={() => setOpen(!open)}
          aria-label={mine ? "Share another screen" : "Go live"} data-tip={cast.available ? (mine ? "Share another screen" : "Go live") : "Connecting to the stage…"}>
          <Radio aria-hidden />
        </button>
      ) : (
        <button className={`btn btn-s ${mine ? "btn-quiet" : "btn-primary"}`} aria-expanded={open} disabled={!cast.available} onClick={() => setOpen(!open)}
          title={cast.available ? undefined : "Connecting to the stage…"}>
          <Radio aria-hidden />{mine ? "Share another screen" : "Go live"}
        </button>
      )}
      {open && (
        <div className="stack-panel golive-panel" role="dialog" aria-label="Go live">
          <h2>Streaming mode</h2>
          <div className="modes" role="radiogroup" aria-label="Streaming mode">
            {[...STREAM_MODES, { id: "custom", label: "Custom", detail: customMode().detail } as StreamMode].map((m) => (
              <label key={m.id} className={`mode${mode.id === m.id ? " is-on" : ""}`}>
                <input type="radio" name="stream-mode" checked={mode.id === m.id} onChange={() => setMode(m.id === "custom" ? customMode() : m)} />
                <span className="mode-label">{m.label}</span>
                <span className="quiet">{m.detail}</span>
              </label>
            ))}
          </div>
          {mode.id === "custom" && (
            <div className="custom-mode">
              <label className="field"><span>Resolution</span>
                <select className="select" value={custom.res} onChange={(e) => setCustom({ ...custom, res: Number(e.target.value) })}>
                  {RES.map((r, i) => <option key={r.label} value={i}>{r.label}</option>)}
                </select>
              </label>
              <label className="field"><span>Frame rate</span>
                <select className="select" value={custom.fps} onChange={(e) => setCustom({ ...custom, fps: Number(e.target.value) })}>
                  {[15, 24, 30, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}
                </select>
              </label>
              <label className="field grow"><span>Bitrate: {custom.mbps} Mbps <span className="quiet">· your upload speed needs to be higher</span></span>
                <input type="range" className="range" min={1} max={15} step={0.5} value={custom.mbps}
                  style={{ "--fill": `${((custom.mbps - 1) / 14) * 100}%` } as React.CSSProperties}
                  onChange={(e) => setCustom({ ...custom, mbps: Number(e.target.value) })} />
              </label>
            </div>
          )}
          <p className="block-note">For sound, share a screen or tab and turn on audio in the picker. A single window, Firefox and Safari share no sound. Everyone watching gets the quality you pick.</p>
          {error && <p className="field-error" role="alert">{error}</p>}
          <button className="btn btn-primary" disabled={busy} onClick={start}><Radio aria-hidden />{busy ? "Choose what to share…" : "Choose screen and go live"}</button>
        </div>
      )}
    </div>
  );
}
