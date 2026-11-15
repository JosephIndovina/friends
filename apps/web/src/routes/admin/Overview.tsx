import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Download, Lock, LockOpen } from "lucide-react";
import type { AdminUser, AuditEntry, Role, Session, SiteSettings } from "@friends/shared";
import { LoadError, Loading, PageHead, useConfirm } from "../../components/settings/ui";
import { api, can } from "../../lib/api";
import { actionLabel, ago, bytes, shortDateTime, errorText } from "../../lib/format";
import { useToast } from "../../lib/toast";
import { ranks } from "./rank";
import { Requests } from "./Requests";
import { useLoad } from "./useLoad";

interface SystemInfo {
  version: string; node: string; startedAt: number; dbBytes: number;
  users: Record<string, number>; activeSessions: number; auditEntries: number; auditRetentionDays: number;
  youtube: { used: number; limit: number } | null;
}

const WEEK = 7 * 864e5;
const STATUS_WORD: Record<string, string> = { active: "active", pending: "waiting", suspended: "suspended", banned: "banned", left: "left" };

export function Overview({ session }: { session: Session }) {
  const people = can(session, "admin.people");
  const settings = can(session, "admin.settings");
  const auditing = can(session, "admin.audit");
  return (
    <div className="pane pane-wide">
      <PageHead title="Overview" />
      {settings && <LockdownPanel />}
      {people && <RequestsPanel session={session} />}
      {auditing && <AlertsPanel />}
      {settings && <SystemPanel />}
    </div>
  );
}

function LockdownPanel() {
  const s = useLoad(() => api<SiteSettings>("GET", "/api/admin/settings"));
  const toast = useToast();
  const [ask, dialog] = useConfirm();
  const [busy, setBusy] = useState(false);
  if (!s.data) return s.error ? <LoadError text={s.error} onRetry={s.reload} /> : <Loading rows={1} />;
  const on = s.data.lockdown;

  async function flip() {
    if (!s.data) return;
    if (!on && (await ask({ title: "Turn on lockdown?", body: "Everyone except admins is disconnected right away and can’t use the site until lockdown is off.", confirm: "Turn on", danger: true })) === null) return;
    setBusy(true);
    try {
      s.setData(await api<SiteSettings>("PUT", "/api/admin/settings", { ...s.data, lockdown: !on }));
      toast(on ? "Lockdown is off." : "Lockdown is on.");
    } catch (e) {
      toast(errorText(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`panel status-panel${on ? " panel-alarm" : ""}`} aria-labelledby="lock-title">
      <span className="status-icon" aria-hidden>{on ? <Lock /> : <LockOpen />}</span>
      <div className="status-text">
        <h2 id="lock-title">{on ? "Lockdown is on" : "Lockdown is off"}</h2>
        <p className="quiet">{on ? "Only admins can use the site." : "Turn it on to disconnect everyone except admins."}</p>
      </div>
      <button className={`btn btn-s ${on ? "btn-primary" : "btn-quiet"}`} disabled={busy} onClick={() => void flip()}>
        {on ? "Turn off" : "Turn on lockdown"}
      </button>
      {dialog}
    </section>
  );
}

function RequestsPanel({ session }: { session: Session }) {
  const users = useLoad(() => api<AdminUser[]>("GET", "/api/admin/users"));
  const roles = useLoad(() => api<Role[]>("GET", "/api/admin/roles"));
  const pending = users.data?.filter((u) => u.status === "pending") ?? [];
  return (
    <section className="pblock" aria-labelledby="req-title">
      <div className="block-head">
        <h2 id="req-title">Access requests {pending.length > 0 && <span className="count">{pending.length}</span>}</h2>
        <Link to="/admin/people" className="text-link">People</Link>
      </div>
      {users.error ? <LoadError text={users.error} onRetry={users.reload} />
        : !users.data || !roles.data ? <Loading rows={1} />
        : pending.length === 0 ? <p className="empty-line">No pending requests.</p>
        : <Requests pending={pending} roles={ranks(session, roles.data).assignable} onChanged={() => void users.reload()} />}
    </section>
  );
}

function AlertsPanel() {
  const since = Date.now() - WEEK;
  const alerts = useLoad(async () => {
    const [blocked, denied] = await Promise.all([
      api<AuditEntry[]>("GET", `/api/admin/audit?action=access.forbidden&from=${since}&limit=20`),
      api<AuditEntry[]>("GET", `/api/admin/audit?action=auth.denied&from=${since}&limit=20`),
    ]);
    return [...blocked, ...denied].sort((a, b) => b.id - a.id);
  });
  const rows = alerts.data ?? [];
  return (
    <section className="pblock" aria-labelledby="alerts-title">
      <div className="block-head">
        <h2 id="alerts-title">Blocked in the last 7 days {rows.length > 0 && <span className="count count-alert">{rows.length}</span>}</h2>
        <Link to="/admin/audit" search={{ action: "access." }} className="text-link">Audit log</Link>
      </div>
      {alerts.error ? <LoadError text={alerts.error} onRetry={alerts.reload} />
        : !alerts.data ? <Loading rows={1} />
        : rows.length === 0 ? <p className="empty-line">No blocked sign-ins or actions.</p>
        : (
          <ul className="event-list">
            {rows.slice(0, 6).map((e) => (
              <li key={e.id}>
                <span className="event-what">{actionLabel(e.action)}</span>
                <span>{e.actor?.name ?? e.targetName ?? "Unknown"}</span>
                <span className="quiet event-detail">{e.action === "access.forbidden" ? String((e.details as Record<string, unknown> | null)?.url ?? "") : ""}</span>
                <time className="quiet nowrap" dateTime={new Date(e.at).toISOString()}>{shortDateTime(e.at)}</time>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

function SystemPanel() {
  const info = useLoad(() => api<SystemInfo>("GET", "/api/admin/system"));
  const d = info.data;
  return (
    <section className="pblock" aria-labelledby="sys-title">
      <div className="block-head"><h2 id="sys-title">System</h2></div>
      {info.error ? <LoadError text={info.error} onRetry={info.reload} /> : !d ? <Loading rows={2} /> : (
        <div className="panel">
          {d.youtube ? <Quota used={d.youtube.used} limit={d.youtube.limit} /> : <p className="quiet">YouTube search is not configured.</p>}
          <dl className="kv kv-grid">
            <div><dt>Version</dt><dd className="mono-num">{d.version.slice(0, 7)}</dd></div>
            <div><dt>Running since</dt><dd>{ago(d.startedAt)}</dd></div>
            <div><dt>People</dt><dd>{Object.entries(d.users).map(([k, v]) => `${v} ${STATUS_WORD[k] ?? k}`).join(" · ") || "None"}</dd></div>
            <div><dt>Signed-in sessions</dt><dd>{d.activeSessions}</dd></div>
            <div><dt>Database</dt><dd>{bytes(d.dbBytes)}</dd></div>
            <div><dt>Audit entries</dt><dd>{d.auditEntries.toLocaleString()} <span className="quiet">· kept {d.auditRetentionDays} days</span></dd></div>
            <div><dt>Node</dt><dd className="mono-num">{d.node}</dd></div>
          </dl>
          <div className="setting-row">
            <div className="setting-text">
              <span>Backup</span>
              <span className="quiet">A copy of the database: people, roles, settings and the audit log. You can also schedule snapshots of the <code>NAS/friends</code> dataset in TrueNAS (Data Protection → Periodic Snapshot Tasks).</span>
            </div>
            <div className="setting-control"><a className="btn btn-quiet btn-s" href="/api/admin/backup" download><Download aria-hidden />Download</a></div>
          </div>
        </div>
      )}
    </section>
  );
}

function Quota({ used, limit }: { used: number; limit: number }) {
  const left = Math.max(0, Math.floor((limit - used) / 101));
  const pct = Math.min(100, (used / limit) * 100);
  const level = pct >= 90 ? "is-high" : pct >= 70 ? "is-mid" : "";
  return (
    <div className="quota">
      <div className="quota-text">
        <span>YouTube searches today</span>
        <span className="quiet">About {left} left · {used.toLocaleString()} of {limit.toLocaleString()} units · resets at midnight Pacific</span>
      </div>
      <div className={`meter ${level}`} role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label="YouTube API quota used">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
