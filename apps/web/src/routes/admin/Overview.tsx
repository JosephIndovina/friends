import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Lock, LockOpen } from "lucide-react";
import type { AdminUser, AuditEntry, Role, Session, SiteSettings } from "@friends/shared";
import { LoadError, Loading, PageHead, useConfirm } from "../../components/settings/ui";
import { api, can } from "../../lib/api";
import { actionLabel, shortDateTime, errorText } from "../../lib/format";
import { useToast } from "../../lib/toast";
import { ranks } from "./rank";
import { Requests } from "./Requests";
import { useLoad } from "./useLoad";

const WEEK = 7 * 864e5;
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
