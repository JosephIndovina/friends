import { useEffect, useRef, useState } from "react";
import { Download, MonitorUp, Radio } from "lucide-react";
import { api } from "../../lib/api";
import { STREAM_MODES, useCast, type StreamMode } from "../../lib/cast";

/** Desktops the Friends Live app runs on. Everyone else streams from the browser. */
const APP_OS: "windows" | "linux" | null =
  typeof navigator === "undefined" || /Android|CrOS/i.test(navigator.userAgent) ? null
  : /Windows/i.test(navigator.userAgent) ? "windows"
  : /Linux/i.test(navigator.userAgent) ? "linux"
  : null;

type AppLinks = { linux: string | null; windows: string | null };
type Launch = "idle" | "opening" | "opened" | "missing" | "error";

/** Opens friends:// without leaving the page. A hidden frame fails quietly when nothing handles the link. */
function openLink(url: string) {
  const f = document.createElement("iframe");
  f.style.display = "none";
  f.src = url;
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 3000);
}

/** The Go live panel's app section: Start streaming hands a one-time code to Friends Live (running in the tray or
 * not), which then asks what to stream; Download gets the app. */
function AppLaunch({ links, onDone }: { links: AppLinks; onDone: () => void }) {
  const [state, setState] = useState<Launch>("idle");
  const timer = useRef<number | null>(null);

  useEffect(() => () => void (timer.current && clearInterval(timer.current)), []);

  const launch = async () => {
    if (timer.current) clearInterval(timer.current);
    setState("opening");
    let code: string;
    try {
      ({ code } = await api<{ code: string }>("POST", "/api/cast/launch"));
    } catch {
      setState("error");
      return;
    }
    openLink(`friends://live?code=${encodeURIComponent(code)}&server=${encodeURIComponent(location.origin)}`);
    const started = Date.now();
    timer.current = window.setInterval(async () => {
      const r = await api<{ opened: boolean }>("GET", `/api/cast/launch/${encodeURIComponent(code)}`).catch(() => null);
      if (r?.opened) {
        clearInterval(timer.current!);
        setState("opened");
        setTimeout(onDone, 2500);
      } else if (Date.now() - started > 6000) {
        clearInterval(timer.current!);
        setState("missing");
      }
    }, 750);
  };

  // Only the installer for this computer's system.
  const download = APP_OS ? links[APP_OS] : null;

  return (
    <div className="app-launch">
      <button className="btn btn-primary" disabled={state === "opening" || state === "opened"} onClick={launch}>
        <MonitorUp aria-hidden />{state === "opening" ? "Starting…" : "Start streaming"}
      </button>
      {state === "opened" && <p className="block-note" role="status">Choose a window in Friends Live.</p>}
      {state === "error" && <p className="field-error" role="alert">Couldn't start. Try again.</p>}
      {state === "missing" && <p className="field-error" role="alert">Friends Live didn't open. Install it, then try again.</p>}
      {download && (
        <a className="btn btn-quiet" href={download} download>
          <Download aria-hidden />Download Friends Live
        </a>
      )}
    </div>
  );
}

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
  const [inBrowser, setInBrowser] = useState(APP_OS === null);
  // The app is offered only where this server has an installer for this OS; everywhere else Go live is the browser's.
  const [links, setLinks] = useState<AppLinks | null>(null);
  const appReady = Boolean(APP_OS && links?.[APP_OS]);
  // Known before the click, so the button can say what it'll do.
  useEffect(() => {
    if (!APP_OS || !cast.canStream) return;
    api<AppLinks>("GET", "/api/cast/app").then(setLinks, () => setLinks({ linux: null, windows: null }));
  }, [cast.canStream]);

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

  // Go live always opens the panel: Start streaming (the app), Download Friends Live, or stream from this browser.
  const label = mine ? "Share another screen" : "Go live";
  const toggle = () => setOpen(!open);

  return (
    <div className="sources go-live" ref={root}>
      {icon ? (
        <button className={`icon-btn${mine ? " is-live" : ""}`} aria-expanded={open} disabled={!cast.available} onClick={toggle}
          aria-label={label} data-tip={cast.available ? label : "Connecting to the stage…"}>
          <Radio aria-hidden />
        </button>
      ) : (
        <button className={`btn btn-s ${mine ? "btn-quiet" : "btn-primary"}`} aria-expanded={open} disabled={!cast.available} onClick={toggle}
          title={cast.available ? undefined : "Connecting to the stage…"}>
          <Radio aria-hidden />{label}
        </button>
      )}
      {open && (
        <div className={`stack-panel golive-panel${appReady && !inBrowser ? " is-compact" : ""}`} role="dialog" aria-label="Go live">
          {appReady && (
            <>
              <h2>Go live</h2>
              <AppLaunch links={links!} onDone={() => setOpen(false)} />
              <button className="btn btn-quiet browser-toggle" aria-expanded={inBrowser} onClick={() => setInBrowser(!inBrowser)}>
                {inBrowser ? "Hide browser streaming" : "Stream from this browser"}
              </button>
            </>
          )}
          {(inBrowser || !appReady) && (
            <>
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
