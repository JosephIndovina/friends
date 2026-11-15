import { useCallback, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, RotateCcw } from "lucide-react";

/** Page title for a settings pane. On phones it carries the way back to the settings list. */
export function PageHead({ title, note, back = { to: "/settings", label: "Settings" }, actions }: {
  title: string;
  note?: React.ReactNode;
  back?: { to: string; label: string; always?: boolean };
  actions?: React.ReactNode;
}) {
  return (
    <header className="pane-head">
      <Link to={back.to} className={`pane-back${back.always ? " is-always" : ""}`}><ChevronLeft aria-hidden />{back.label}</Link>
      <div className="pane-title">
        <h1>{title}</h1>
        {actions && <div className="pane-actions">{actions}</div>}
      </div>
      {note && <p className="pane-note">{note}</p>}
    </header>
  );
}

export function Toggle({ label, hint, checked, disabled, onChange }: { label: string; hint?: React.ReactNode; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`toggle${disabled ? " is-disabled" : ""}`}>
      <span className="toggle-text"><span>{label}</span>{hint && <span className="quiet">{hint}</span>}</span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden />
    </label>
  );
}

/** Placeholder rows while a pane loads. */
export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" />)}
    </div>
  );
}

export function LoadError({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="load-error" role="alert">
      <p>{text}</p>
      {onRetry && <button className="btn btn-quiet btn-s" onClick={onRetry}><RotateCcw aria-hidden />Try again</button>}
    </div>
  );
}

interface ConfirmOpts {
  title: string;
  body?: React.ReactNode;
  confirm: string;
  danger?: boolean;
  /** ask for an optional reason; the promise resolves with it */
  reason?: string;
}

/** A confirm dialog driven by a promise: `if (await ask({...}) !== null) doIt()`. */
export function useConfirm() {
  const ref = useRef<HTMLDialogElement>(null);
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  const [reason, setReason] = useState("");
  const resolver = useRef<((v: string | null) => void) | null>(null);

  const ask = useCallback((o: ConfirmOpts) => {
    setOpts(o);
    setReason("");
    // Open after React renders the content.
    requestAnimationFrame(() => ref.current?.showModal());
    return new Promise<string | null>((resolve) => (resolver.current = resolve));
  }, []);

  const finish = (v: string | null) => {
    resolver.current?.(v);
    resolver.current = null;
    ref.current?.close();
  };

  const dialog = (
    <dialog ref={ref} className="dialog" onClose={() => finish(null)}>
      {opts && (
        <form method="dialog" onSubmit={(e) => { e.preventDefault(); finish(reason.trim()); }}>
          <h2>{opts.title}</h2>
          {opts.body && <p className="quiet">{opts.body}</p>}
          {opts.reason && (
            <label className="field">
              <span>{opts.reason}</span>
              <input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} autoFocus />
            </label>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn btn-quiet" onClick={() => finish(null)} autoFocus={!opts.reason}>Cancel</button>
            <button type="submit" className={`btn ${opts.danger ? "btn-danger" : "btn-primary"}`}>{opts.confirm}</button>
          </div>
        </form>
      )}
    </dialog>
  );
  return [ask, dialog] as const;
}
