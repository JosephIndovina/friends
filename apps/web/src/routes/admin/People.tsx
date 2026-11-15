import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Ban, Check, ChevronRight, Copy, LogOut, PauseCircle, RotateCcw, Search, UserPlus, X } from "lucide-react";
import type { AdminUser, AuditEntry, Role, Session, UserStatus } from "@friends/shared";
import { Avatar } from "../../components/Avatar";
import { LoadError, Loading, PageHead } from "../../components/settings/ui";
import { api, can } from "../../lib/api";
import { actionLabel, ago, shortDateTime, errorText, fullDate } from "../../lib/format";
import { useToast } from "../../lib/toast";
import { ranks } from "./rank";
import { Requests } from "./Requests";
import { useLoad } from "./useLoad";

export const STATUS_LABEL: Record<UserStatus, string> = {
  pending: "Waiting", active: "Active", suspended: "Suspended", banned: "Banned", left: "Left server",
};
const FILTERS: { value: UserStatus | "all"; label: string }[] = [
  { value: "all", label: "All" }, { value: "active", label: "Active" }, { value: "suspended", label: "Suspended" },
  { value: "banned", label: "Banned" }, { value: "left", label: "Left" },
];

export function People({ session }: { session: Session }) {
  const users = useLoad(() => api<AdminUser[]>("GET", "/api/admin/users"));
  const roles = useLoad(() => api<Role[]>("GET", "/api/admin/roles"));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<UserStatus | "all">("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const addRef = useRef<HTMLDialogElement>(null);
  const r = ranks(session, roles.data);

  const pending = users.data?.filter((u) => u.status === "pending") ?? [];
  const everyone = users.data?.filter((u) => u.status !== "pending") ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: everyone.length };
    for (const u of everyone) c[u.status] = (c[u.status] ?? 0) + 1;
    return c;
  }, [everyone]);
  const q = query.trim().toLowerCase();
  const shown = everyone.filter((u) => (filter === "all" || u.status === filter) && (!q || u.name.toLowerCase().includes(q) || u.id.includes(q)));
  const open = users.data?.find((u) => u.id === openId) ?? null;
  const reload = () => void users.reload();

  return (
    <div className="pane pane-wide">
      <PageHead title="People" back={{ to: "/settings", label: "Settings" }}
        actions={<button className="btn btn-quiet btn-s" onClick={() => addRef.current?.showModal()}><UserPlus aria-hidden />Add person</button>} />

      {users.error ? <LoadError text={users.error} onRetry={reload} /> : !users.data || !roles.data ? <Loading rows={5} /> : (
        <>
          {pending.length > 0 && (
            <section className="pblock" aria-labelledby="pending-title">
              <div className="block-head"><h2 id="pending-title">Waiting for approval <span className="count">{pending.length}</span></h2></div>
              <Requests pending={pending} roles={r.assignable} onChanged={reload} />
            </section>
          )}

          <section className="pblock" aria-label="Everyone">
            <div className="list-tools">
              <label className="search">
                <Search aria-hidden />
                <input className="input" type="search" placeholder="Search by name or ID" aria-label="Search people" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
              <div className="chips" role="radiogroup" aria-label="Filter by status">
                {FILTERS.filter((f) => f.value === "all" || counts[f.value]).map((f) => (
                  <label key={f.value} className="chip">
                    <input type="radio" name="status-filter" checked={filter === f.value} onChange={() => setFilter(f.value)} />
                    <span>{f.label} <span className="chip-count">{counts[f.value] ?? 0}</span></span>
                  </label>
                ))}
              </div>
            </div>

            {shown.length === 0 ? <p className="empty-line">{q ? `No one matches “${query.trim()}”.` : "No one here."}</p> : (
              <ul className="people-list">
                {shown.map((u) => (
                  <li key={u.id}>
                    <button className="person-row" onClick={() => setOpenId(u.id)} aria-haspopup="dialog">
                      <Avatar src={u.avatarUrl} name={u.name} size={36} />
                      <span className="person-main">
                        <span className="person-name">{u.name}{u.id === session.user.id && <span className="quiet"> (you)</span>}</span>
                        <span className="quiet">{u.isOwner ? "Owner" : r.roleName(u.roleId)}</span>
                      </span>
                      <span className={`status status-${u.status}`}>{STATUS_LABEL[u.status]}</span>
                      <span className="person-seen quiet">{u.activeSessions > 0 ? "Signed in" : `Seen ${ago(u.lastSeenAt).toLowerCase()}`}</span>
                      <ChevronRight aria-hidden className="row-chevron" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <PersonSheet session={session} user={open} roles={roles.data ?? []} onClose={() => setOpenId(null)} onChanged={reload} />
      <AddPerson dialogRef={addRef} roles={r.assignable} onDone={reload} />
    </div>
  );
}

type Pending = { action: "suspended" | "banned" } | null;

function PersonSheet({ session, user, roles, onClose, onChanged }: { session: Session; user: AdminUser | null; roles: Role[]; onClose: () => void; onChanged: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Pending>(null);
  const [reason, setReason] = useState("");
  const [activity, setActivity] = useState<AuditEntry[] | null>(null);
  const r = ranks(session, roles);
  const userId = user?.id ?? null;

  useEffect(() => {
    if (userId && !ref.current?.open) ref.current?.showModal();
    if (!userId) ref.current?.close();
    setConfirm(null);
    setActivity(null);
    if (!userId || !can(session, "admin.audit")) return;
    let live = true;
    Promise.all([
      api<AuditEntry[]>("GET", `/api/admin/audit?actor=${userId}&limit=8`),
      api<AuditEntry[]>("GET", `/api/admin/audit?target=${userId}&limit=8`),
    ]).then(([a, b]) => {
      if (!live) return;
      const seen = new Set<number>();
      setActivity([...a, ...b].sort((x, y) => y.id - x.id).filter((e) => !seen.has(e.id) && seen.add(e.id)).slice(0, 8));
    }).catch(() => live && setActivity([]));
    return () => { live = false; };
  }, [userId, session]);

  async function run(fn: () => Promise<unknown>, ok: string, undo?: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      toast(ok, undo ? { action: { label: "Undo", run: () => void undo().then(onChanged, (e) => toast(errorText(e), { kind: "error" })) } } : undefined);
      onChanged();
      setConfirm(null);
    } catch (e) {
      toast(errorText(e), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  const u = user;
  const manage = u ? r.manageable(u) : false;
  const setRole = (id: string) => api("PATCH", `/api/admin/users/${u!.id}/role`, { roleId: id });

  return (
    <dialog ref={ref} className="sheet" aria-labelledby="sheet-title" onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current.close()}>
      {u && (
        <div className="sheet-body">
          <header className="sheet-head">
            <Avatar src={u.avatarUrl} name={u.name} size={56} />
            <div>
              <h2 id="sheet-title" tabIndex={-1} autoFocus>{u.name}</h2>
              <span className={`status status-${u.status}`}>{STATUS_LABEL[u.status]}</span>
              {u.statusReason && <span className="quiet sheet-reason">{u.statusReason}</span>}
            </div>
            <button className="icon-btn sheet-close" aria-label="Close" onClick={() => ref.current?.close()}><X aria-hidden /></button>
          </header>

          <dl className="kv">
            <div>
              <dt>Role</dt>
              <dd>
                {u.isOwner ? "Owner" : manage ? (
                  <select className="select" aria-label={`Role for ${u.name}`} value={u.roleId ?? ""} disabled={busy}
                    onChange={(e) => {
                      const prev = u.roleId;
                      const next = e.target.value;
                      void run(() => setRole(next), `${u.name} is now ${r.roleName(next)}.`, prev ? () => setRole(prev) : undefined);
                    }}>
                    {!u.roleId && <option value="">No role</option>}
                    {roles.filter((x) => x.id !== "owner").map((x) => (
                      <option key={x.id} value={x.id} disabled={!r.assignable.some((a) => a.id === x.id)}>{x.name}</option>
                    ))}
                  </select>
                ) : r.roleName(u.roleId)}
              </dd>
            </div>
            <div>
              <dt>Discord ID</dt>
              <dd className="copyable">
                <span className="mono-num">{u.id}</span>
                <button className="icon-btn" aria-label="Copy Discord ID" onClick={() => navigator.clipboard?.writeText(u.id).then(() => toast("Copied."), () => {})}><Copy aria-hidden /></button>
              </dd>
            </div>
            <div><dt>Joined</dt><dd>{fullDate(u.createdAt)}</dd></div>
            <div><dt>Last seen</dt><dd>{ago(u.lastSeenAt)}</dd></div>
            <div><dt>Sessions</dt><dd>{u.activeSessions ? `${u.activeSessions} signed in` : "None"}</dd></div>
          </dl>

          {manage && !confirm && (
            <div className="sheet-actions">
              {u.activeSessions > 0 && (
                <button className="btn btn-quiet btn-s" disabled={busy} onClick={() => void run(() => api("POST", `/api/admin/users/${u.id}/signout`), `Signed ${u.name} out everywhere.`)}>
                  <LogOut aria-hidden />Sign out everywhere
                </button>
              )}
              {u.status === "active" || u.status === "left" ? (
                <>
                  <button className="btn btn-quiet btn-s" disabled={busy} onClick={() => { setReason(""); setConfirm({ action: "suspended" }); }}><PauseCircle aria-hidden />Suspend</button>
                  <button className="btn btn-quiet btn-s btn-danger-quiet" disabled={busy} onClick={() => { setReason(""); setConfirm({ action: "banned" }); }}><Ban aria-hidden />Ban</button>
                </>
              ) : u.status !== "pending" && (
                <button className="btn btn-primary btn-s" disabled={busy} onClick={() => void run(() => api("POST", `/api/admin/users/${u.id}/status`, { status: "active" }), `Reinstated ${u.name}.`)}>
                  <RotateCcw aria-hidden />Reinstate
                </button>
              )}
            </div>
          )}
          {!manage && !u.isOwner && u.id !== session.user.id && <p className="quiet">They’re ranked the same as or above you, so you can’t change their access.</p>}

          {confirm && (
            <form className="inline-confirm" onSubmit={(e) => {
              e.preventDefault();
              void run(() => api("POST", `/api/admin/users/${u.id}/status`, { status: confirm.action, reason: reason.trim() || undefined }), `${u.name} is ${confirm.action}.`);
            }}>
              <h3>{confirm.action === "banned" ? `Ban ${u.name}?` : `Suspend ${u.name}?`}</h3>
              <p className="quiet">They’re signed out right away and can’t sign in until someone reinstates them.</p>
              <label className="field"><span>Reason (optional, shown in the audit log)</span>
                <input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} autoFocus />
              </label>
              <div className="dialog-actions">
                <button type="button" className="btn btn-quiet btn-s" onClick={() => setConfirm(null)}>Cancel</button>
                <button className="btn btn-danger btn-s" disabled={busy}>{confirm.action === "banned" ? "Ban" : "Suspend"}</button>
              </div>
            </form>
          )}

          {can(session, "admin.audit") && (
            <section className="sheet-section" aria-labelledby="activity-title">
              <div className="block-head">
                <h3 id="activity-title">Recent activity</h3>
                <Link to="/admin/audit" search={{ target: u.id, name: u.name }} className="text-link">All</Link>
              </div>
              {!activity ? <Loading rows={2} /> : activity.length === 0 ? <p className="empty-line">Nothing recorded.</p> : (
                <ul className="event-list event-list-compact">
                  {activity.map((e) => (
                    <li key={e.id}>
                      <span className="event-what">{actionLabel(e.action)}</span>
                      <span className="quiet">{e.actor?.id === u.id ? (e.targetName && e.targetId !== u.id ? e.targetName : "") : `by ${e.actor?.name ?? "System"}`}</span>
                      <time className="quiet nowrap" dateTime={new Date(e.at).toISOString()}>{shortDateTime(e.at)}</time>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </dialog>
  );
}

function AddPerson({ dialogRef, roles, onDone }: { dialogRef: React.RefObject<HTMLDialogElement | null>; roles: Role[]; onDone: () => void }) {
  const toast = useToast();
  const [id, setId] = useState("");
  const [roleId, setRoleId] = useState("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^\d{15,22}$/.test(id.trim());
  return (
    <dialog ref={dialogRef} className="dialog" aria-labelledby="add-title" onClose={() => { setId(""); setError(null); }}>
      <form onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setBusy(true);
        setError(null);
        try {
          await api("POST", "/api/admin/preapprove", { discordId: id.trim(), roleId });
          toast("Pre-approved. They can sign in straight away.");
          dialogRef.current?.close();
          onDone();
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}>
        <h2 id="add-title">Add person</h2>
        <p className="quiet">Approve someone before they sign in. In Discord, right-click them and choose Copy User ID (turn on Developer Mode in Discord’s Advanced settings if you don’t see it).</p>
        <label className="field"><span>Discord user ID</span>
          <input className="input" inputMode="numeric" autoComplete="off" placeholder="164143056172482562" value={id} onChange={(e) => setId(e.target.value)} aria-invalid={id !== "" && !valid} autoFocus />
          {id !== "" && !valid && <span className="field-error">Discord user IDs are 15–22 digits.</span>}
        </label>
        <label className="field"><span>Role</span>
          <select className="select" value={roleId} onChange={(e) => setRoleId(e.target.value)}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        </label>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-quiet" onClick={() => dialogRef.current?.close()}>Cancel</button>
          <button className="btn btn-primary" disabled={!valid || busy}><Check aria-hidden />Pre-approve</button>
        </div>
      </form>
    </dialog>
  );
}
