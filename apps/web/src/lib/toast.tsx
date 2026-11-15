import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

interface Toast {
  id: number;
  kind: "ok" | "error";
  text: string;
  action?: { label: string; run: () => void };
}
type Show = (text: string, opts?: { kind?: Toast["kind"]; action?: Toast["action"] }) => void;

const Ctx = createContext<Show | null>(null);

/** Short confirmations and errors, shown at the bottom of the screen. Errors stay until dismissed. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback<Show>((text, opts = {}) => {
    const id = next.current++;
    const kind = opts.kind ?? "ok";
    setToasts((t) => [...t.slice(-2), { id, kind, text, action: opts.action }]);
    if (kind === "ok") setTimeout(() => dismiss(id), opts.action ? 8000 : 4000);
  }, [dismiss]);
  const value = useMemo(() => show, [show]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span>{t.text}</span>
            {t.action && (
              <button className="toast-action" onClick={() => { dismiss(t.id); t.action!.run(); }}>{t.action.label}</button>
            )}
            <button className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}><X aria-hidden /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useToast outside ToastProvider");
  return c;
}
