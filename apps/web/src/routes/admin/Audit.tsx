import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Download, X } from "lucide-react";
import { AUDIT_RETENTION_DAYS, type AdminUser, type AuditEntry, type Session } from "@friends/shared";
import { LoadError, Loading, PageHead } from "../../components/settings/ui";
import { api, can } from "../../lib/api";
import { actionLabel, dayLabel, errorText, time } from "../../lib/format";

export interface AuditSearch { actor?: string; target?: string; name?: string; action?: string; from?: string; to?: string }

const CATEGORIES = [
  { value: "", label: "Everything" },
  { value: "auth.", label: "Sign-ins" },
  { value: "access.", label: "Access and blocks" },
  { value: "user.", label: "People" },
  { value: "role.", label: "Roles" },
  { value: "site.", label: "Lockdown" },
  { value: "settings.", label: "Settings" },
  { value: "media.", label: "Player" },
  { value: "playlist.", label: "Playlists" },
  { value: "post.", label: "Posts" },
  { value: "sound.", label: "Soundboard" },
  { value: "cast.", label: "Cast" },
];
const ALERTS = new Set(["access.forbidden", "auth.denied", "access.denied", "user.banned", "user.suspended", "site.lockdown_on"]);

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function details(e: AuditEntry): string {
  if (!e.details) return "";
  const d = e.details as Record<string, unknown>;
  if (e.action === "user.role_changed") return `${d.from ?? "No role"} → ${d.to}`;
  if (e.action === "access.forbidden") return `${d.reason} · ${d.method} ${d.url}`;
  if (e.action === "role.reordered" && Array.isArray(d.order)) return d.order.join(" › ");
  if (e.action === "role.updated") {
    const parts = [];
    if (Array.isArray(d.added) && d.added.length) parts.push(`+ ${d.added.join(", ")}`);
    if (Array.isArray(d.removed) && d.removed.length) parts.push(`− ${d.removed.join(", ")}`);
    if (Array.isArray(d.renamed)) parts.push(`renamed ${d.renamed.join(" → ")}`);
    return parts.join(" · ");
  }
  if (d.changes) return Object.entries(d.changes as Record<string, [unknown, unknown]>).map(([k, [a, b]]) => `${k}: ${String(a)} → ${String(b)}`).join(" · ");
  return Object.entries(d).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ");
}

export function Audit({ session }: { session: Session }) {
  const search = useSearch({ strict: false }) as AuditSearch;
  const navigate = useNavigate();
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [people, setPeople] = useState<AdminUser[]>([]);
  const f = { actor: search.actor ?? "", target: search.target ?? "", action: search.action ?? "", from: search.from ?? "", to: search.to ?? "" };

  const setFilter = (patch: Partial<AuditSearch>) =>
    void navigate({ to: "/admin/audit", search: (prev: AuditSearch) => Object.fromEntries(Object.entries({ ...prev, ...patch }).filter(([, v]) => v)) as AuditSearch, replace: true });

  useEffect(() => {
    if (can(session, "admin.people")) api<AdminUser[]>("GET", "/api/admin/users").then(setPeople).catch(() => {});
  }, [session]);

  const qs = (before?: number) => {
    const p = new URLSearchParams();
    if (f.actor) p.set("actor", f.actor);
    if (f.target) p.set("target", f.target);
    if (f.action) p.set("action", f.action);
    if (f.from) p.set("from", String(new Date(`${f.from}T00:00`).getTime()));
    if (f.to) p.set("to", String(new Date(`${f.to}T00:00`).getTime() + 864e5 - 1));
    if (before) p.set("before", String(before));
    p.set("limit", "100");
    return p.toString();
  };

  async function load(more = false) {
    try {
      const next = await api<AuditEntry[]>("GET", `/api/admin/audit?${qs(more ? rows?.at(-1)?.id : undefined)}`);
      setRows(more ? [...(rows ?? []), ...next] : next);
      setDone(next.length < 100);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }

  const key = qs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setRows(null); void load(); }, [key]);

  const groups: { day: string; items: AuditEntry[] }[] = [];
  for (const e of rows ?? []) {
    const day = dayLabel(e.at);
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1)!.items.push(e);
  }
  const targetName = search.name ?? people.find((p) => p.id === f.target)?.name ?? f.target;
  const anyFilter = Object.values(f).some(Boolean);

  return (
    <div className="pane pane-wide">
      <PageHead title="Audit log" note={`Entries are kept for ${AUDIT_RETENTION_DAYS} days and can’t be edited or deleted.`}
        actions={<a className="btn btn-quiet btn-s" href={`/api/admin/audit.csv?${qs()}`} download><Download aria-hidden />Export CSV</a>} />

      <div className="filters">
        {people.length > 0 && (
          <label className="field"><span>Who</span>
            <select className="select" value={f.actor} onChange={(e) => setFilter({ actor: e.target.value })}>
              <option value="">Anyone</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <label className="field"><span>What</span>
          <select className="select" value={f.action} onChange={(e) => setFilter({ action: e.target.value })}>
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            {f.action && !CATEGORIES.some((c) => c.value === f.action) && <option value={f.action}>{actionLabel(f.action)}</option>}
          </select>
        </label>
        <label className="field"><span>From</span><input type="date" className="input" value={f.from} onChange={(e) => setFilter({ from: e.target.value })} /></label>
        <label className="field"><span>To</span><input type="date" className="input" value={f.to} onChange={(e) => setFilter({ to: e.target.value })} /></label>
        {anyFilter && <button className="btn btn-quiet btn-s filters-clear" onClick={() => void navigate({ to: "/admin/audit", search: {}, replace: true })}>Clear filters</button>}
      </div>
      {f.target && (
        <div className="chips">
          <span className="chip is-on">About {targetName}<button className="chip-x" aria-label="Remove filter" onClick={() => setFilter({ target: "", name: "" })}><X aria-hidden /></button></span>
        </div>
      )}

      {error ? <LoadError text={error} onRetry={() => void load()} />
        : !rows ? <Loading rows={6} />
        : rows.length === 0 ? <p className="empty-line">Nothing matches these filters.</p>
        : (
          <div className="audit-days">
            {groups.map((g) => (
              <section key={g.day} aria-label={g.day}>
                <h2 className="day-head">{g.day}</h2>
                <ul className="audit-list">
                  {g.items.map((e) => (
                    <li key={e.id} className={ALERTS.has(e.action) ? "is-alert" : undefined}>
                      <time className="audit-time" dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>{time(e.at)}</time>
                      <span className="audit-line">
                        {e.actor ? <button className="name-link" onClick={() => setFilter({ actor: e.actor!.id })}>{e.actor.name}</button> : <span className="quiet">System</span>}
                        {" "}<span className="audit-what" title={e.action}>{lowerFirst(actionLabel(e.action))}</span>
                        {(e.targetName || e.targetId) && e.targetId !== e.actor?.id && (
                          <>
                            {" · "}
                            {e.targetType === "user" && e.targetId
                              ? <button className="name-link" onClick={() => setFilter({ target: e.targetId!, name: e.targetName ?? "" })}>{e.targetName ?? e.targetId}</button>
                              : <span>{e.targetName ?? e.targetId}</span>}
                          </>
                        )}
                      </span>
                      {details(e) && <span className="audit-details">{details(e)}</span>}
                      {e.ip && <span className="audit-ip mono-num">{e.ip}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {!done && <button className="btn btn-quiet" onClick={() => void load(true)}>Load older entries</button>}
          </div>
        )}
    </div>
  );
}
