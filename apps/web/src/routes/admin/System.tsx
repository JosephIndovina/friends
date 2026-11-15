import { Download } from "lucide-react";
import { api } from "../../lib/api";
import { ago, bytes } from "../../lib/format";
import { useLoad } from "./useLoad";

interface SystemInfo {
  version: string; node: string; startedAt: number; dbBytes: number;
  users: Record<string, number>; activeSessions: number; auditEntries: number; auditRetentionDays: number;
}

export function System() {
  const info = useLoad(() => api<SystemInfo>("GET", "/api/admin/system"));
  const d = info.data;
  if (!d) return info.error ? <p className="flash flash-error">{info.error}</p> : null;
  const facts: [string, string][] = [
    ["Version", d.version.slice(0, 7)],
    ["Running since", ago(d.startedAt)],
    ["Database", bytes(d.dbBytes)],
    ["People", Object.entries(d.users).map(([k, v]) => `${v} ${k}`).join(" · ") || "None"],
    ["Signed-in sessions", String(d.activeSessions)],
    ["Audit entries", `${d.auditEntries.toLocaleString()} (kept ${d.auditRetentionDays} days)`],
    ["Node", d.node],
  ];
  return (
    <div className="admin-stack settings-narrow">
      <dl className="facts">
        {facts.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
      </dl>
      <section className="panel" aria-labelledby="backup-title">
        <h2 id="backup-title">Backup</h2>
        <p className="quiet">Download a consistent copy of the database: everyone, roles, settings and the audit log. Your NAS can also snapshot the <code>NAS/friends</code> dataset on a schedule (Data Protection → Periodic Snapshot Tasks).</p>
        <a className="btn btn-quiet" href="/api/admin/backup" download><Download aria-hidden />Download backup</a>
      </section>
    </div>
  );
}
