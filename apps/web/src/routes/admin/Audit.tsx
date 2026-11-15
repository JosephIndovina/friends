import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import type { AdminUser, AuditEntry, Session } from "@friends/shared";
import { api } from "../../lib/api";
import { actionLabel, dateTime, errorText } from "../../lib/format";

const CATEGORIES = [
  { value: "", label: "Everything" },
  { value: "auth.", label: "Sign-ins" },
  { value: "access.", label: "Access & blocks" },
  { value: "user.", label: "People" },
  { value: "role.", label: "Roles" },
  { value: "site.", label: "Lockdown" },
  { value: "settings.", label: "Settings" },
  ...["music.", "media.", "cast.", "posts."].map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1, -1) })),
];

function details(e: AuditEntry): string {
  if (!e.details) return "";
  const d = e.details as Record<string, unknown>;
  if (e.action === "user.role_changed") return `${d.from ?? "No role"} → ${d.to}`;
  if (e.action === "access.forbidden") return `${d.reason} · ${d.method} ${d.url}`;
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
  const [filters, setFilters] = useState({ actor: "", action: "", from: "", to: "" });
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [people, setPeople] = useState<AdminUser[]>([]);

  useEffect(() => {
    if (session.permissions.includes("admin.people")) api<AdminUser[]>("GET", "/api/admin/users").then(setPeople).catch(() => {});
  }, [session]);

  const qs = (before?: number) => {
    const p = new URLSearchParams();
    if (filters.actor) p.set("actor", filters.actor);
    if (filters.action) p.set("action", filters.action);
    if (filters.from) p.set("from", String(new Date(filters.from).getTime()));
    if (filters.to) p.set("to", String(new Date(filters.to).getTime() + 864e5 - 1));
    if (before) p.set("before", String(before));
    p.set("limit", "100");
    return p.toString();
  };

  async function load(more = false) {
    try {
      const next = await api<AuditEntry[]>("GET", `/api/admin/audit?${qs(more ? rows.at(-1)?.id : undefined)}`);
      setRows(more ? [...rows, ...next] : next);
      setDone(next.length < 100);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [filters]);

  return (
    <div className="admin-stack">
      <div className="filters">
        {people.length > 0 && (
          <label className="field"><span>Who</span>
            <select className="select" value={filters.actor} onChange={(e) => setFilters({ ...filters, actor: e.target.value })}>
              <option value="">Anyone</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <label className="field"><span>What</span>
          <select className="select" value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })}>
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label className="field"><span>From</span><input type="date" className="input" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></label>
        <label className="field"><span>To</span><input type="date" className="input" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></label>
        <a className="btn btn-quiet filters-end" href={`/api/admin/audit.csv?${qs()}`} download><Download aria-hidden />Export CSV</a>
      </div>

      {error && <p className="flash flash-error" role="alert">{error}</p>}
      {!error && rows.length === 0 && <p className="quiet">Nothing matches these filters.</p>}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table audit">
            <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Target</th><th scope="col">Details</th><th scope="col">IP</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={e.action === "access.forbidden" || e.action === "auth.denied" ? "is-alert" : undefined}>
                  <td className="nowrap"><time dateTime={new Date(e.at).toISOString()}>{dateTime(e.at)}</time></td>
                  <td>{e.actor?.name ?? <span className="quiet">System</span>}</td>
                  <td className="nowrap" title={e.action}>{actionLabel(e.action)}</td>
                  <td>{e.targetName ?? (e.targetId ? <span className="person-id">{e.targetId}</span> : "")}</td>
                  <td className="details">{details(e)}</td>
                  <td className="person-id nowrap">{e.ip ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!done && rows.length > 0 && <button className="btn btn-quiet" onClick={() => load(true)}>Load older entries</button>}
      <p className="quiet">Entries are kept for 365 days and can’t be edited or deleted.</p>
    </div>
  );
}
