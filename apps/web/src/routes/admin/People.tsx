import { useRef, useState } from "react";
import { Check, LogOut, Ban, PauseCircle, RotateCcw, UserPlus, X } from "lucide-react";
import type { AdminUser, Role, Session, UserStatus } from "@friends/shared";
import { Avatar } from "../../components/Avatar";
import { api } from "../../lib/api";
import { ago, errorText } from "../../lib/format";
import { useLoad } from "./useLoad";

const STATUS_LABEL: Record<UserStatus, string> = {
  pending: "Waiting", active: "Active", suspended: "Suspended", banned: "Banned", left: "Left server",
};

type Confirm = { user: AdminUser; action: "suspended" | "banned" | "deny" } | null;

export function People({ session }: { session: Session }) {
  const users = useLoad(() => api<AdminUser[]>("GET", "/api/admin/users"));
  const roles = useLoad(() => api<Role[]>("GET", "/api/admin/roles"));
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");

  const myRank = session.isOwner ? -1 : (roles.data?.find((r) => r.id === session.role?.id)?.position ?? 1000);
  const rankOf = (u: AdminUser) => (u.isOwner ? -1 : (roles.data?.find((r) => r.id === u.roleId)?.position ?? 1000));
  const manageable = (u: AdminUser) => !u.isOwner && u.id !== session.user.id && (session.isOwner || myRank < rankOf(u));
  const assignable = (roles.data ?? []).filter((r) => r.id !== "owner" && (session.isOwner || r.position > myRank));

  async function run(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(id);
    setFlash(null);
    try {
      await fn();
      setFlash({ kind: "ok", text: ok });
      await users.reload();
    } catch (e) {
      setFlash({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  function ask(c: NonNullable<Confirm>) {
    setConfirm(c);
    setReason("");
    dialog.current?.showModal();
  }

  async function confirmAction() {
    if (!confirm) return;
    const { user, action } = confirm;
    dialog.current?.close();
    if (action === "deny") await run(user.id, () => api("POST", `/api/admin/users/${user.id}/deny`, { reason: reason || undefined }), `Denied ${user.name}.`);
    else await run(user.id, () => api("POST", `/api/admin/users/${user.id}/status`, { status: action, reason: reason || undefined }), `${user.name} is now ${action}.`);
  }

  const pending = users.data?.filter((u) => u.status === "pending") ?? [];
  const everyone = users.data?.filter((u) => u.status !== "pending") ?? [];

  return (
    <div className="admin-stack">
      {flash && <p className={`flash flash-${flash.kind}`} role="status">{flash.text}</p>}
      {(users.error || roles.error) && <p className="flash flash-error" role="alert">{users.error ?? roles.error}</p>}

      <section aria-labelledby="pending-title">
        <h2 id="pending-title" className="admin-h2">Waiting for approval {pending.length > 0 && <span className="count">{pending.length}</span>}</h2>
        {users.data && pending.length === 0 && <p className="quiet">No pending requests.</p>}
        <ul className="requests">
          {pending.map((u) => (
            <PendingRow key={u.id} user={u} roles={assignable} busy={busy === u.id}
              onApprove={(roleId) => run(u.id, () => api("POST", `/api/admin/users/${u.id}/approve`, { roleId }), `Approved ${u.name}.`)}
              onDeny={() => ask({ user: u, action: "deny" })} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="people-title">
        <h2 id="people-title" className="admin-h2">Everyone</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Last seen</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr>
            </thead>
            <tbody>
              {everyone.map((u) => {
                const can = manageable(u);
                return (
                  <tr key={u.id} aria-busy={busy === u.id}>
                    <td>
                      <span className="person">
                        <Avatar src={u.avatarUrl} name={u.name} size={32} />
                        <span><span className="person-name">{u.name}{u.id === session.user.id && <span className="quiet"> (you)</span>}</span><span className="person-id">{u.id}</span></span>
                      </span>
                    </td>
                    <td>
                      {u.isOwner ? <span className="role-tag">Owner</span> : (
                        <select className="select" aria-label={`Role for ${u.name}`} value={u.roleId ?? ""} disabled={!can || busy === u.id}
                          onChange={(e) => run(u.id, () => api("PATCH", `/api/admin/users/${u.id}/role`, { roleId: e.target.value }), `${u.name} is now ${roles.data?.find((r) => r.id === e.target.value)?.name}.`)}>
                          {!u.roleId && <option value="">No role</option>}
                          {(roles.data ?? []).filter((r) => r.id !== "owner").map((r) => (
                            <option key={r.id} value={r.id} disabled={!assignable.some((a) => a.id === r.id)}>{r.name}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      <span className={`status status-${u.status}`}>{STATUS_LABEL[u.status]}</span>
                      {u.statusReason && <span className="status-reason">{u.statusReason}</span>}
                    </td>
                    <td className="nowrap">{ago(u.lastSeenAt)}{u.activeSessions > 0 && <span className="quiet"> · {u.activeSessions} {u.activeSessions === 1 ? "session" : "sessions"}</span>}</td>
                    <td>
                      {can && (
                        <div className="row-actions">
                          {u.activeSessions > 0 && (
                            <button className="icon-btn" title="Sign out everywhere" aria-label={`Sign ${u.name} out everywhere`} disabled={busy === u.id}
                              onClick={() => run(u.id, () => api("POST", `/api/admin/users/${u.id}/signout`), `Signed ${u.name} out.`)}><LogOut aria-hidden /></button>
                          )}
                          {u.status === "active" || u.status === "left" ? (
                            <>
                              <button className="icon-btn" title="Suspend" aria-label={`Suspend ${u.name}`} disabled={busy === u.id} onClick={() => ask({ user: u, action: "suspended" })}><PauseCircle aria-hidden /></button>
                              <button className="icon-btn danger" title="Ban" aria-label={`Ban ${u.name}`} disabled={busy === u.id} onClick={() => ask({ user: u, action: "banned" })}><Ban aria-hidden /></button>
                            </>
                          ) : (
                            <button className="btn btn-quiet btn-s" disabled={busy === u.id}
                              onClick={() => run(u.id, () => api("POST", `/api/admin/users/${u.id}/status`, { status: "active" }), `Reinstated ${u.name}.`)}><RotateCcw aria-hidden />Reinstate</button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <PreApprove roles={assignable} onDone={(t) => { setFlash({ kind: "ok", text: t }); void users.reload(); }} onError={(t) => setFlash({ kind: "error", text: t })} />

      <dialog ref={dialog} className="dialog" onClose={() => setConfirm(null)}>
        {confirm && (
          <form method="dialog" onSubmit={(e) => { e.preventDefault(); void confirmAction(); }}>
            <h2>{confirm.action === "deny" ? `Deny ${confirm.user.name}?` : confirm.action === "banned" ? `Ban ${confirm.user.name}?` : `Suspend ${confirm.user.name}?`}</h2>
            <p className="quiet">
              {confirm.action === "suspended"
                ? "They’re signed out right away and can’t get back in until someone reinstates them."
                : "They’re signed out right away and blocked from signing in. You can reinstate them later."}
            </p>
            <label className="field">
              <span>Reason <span className="quiet">(optional, shown in the audit log)</span></span>
              <input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} autoFocus />
            </label>
            <div className="dialog-actions">
              <button type="button" className="btn btn-quiet" onClick={() => dialog.current?.close()}>Cancel</button>
              <button type="submit" className="btn btn-danger">{confirm.action === "deny" ? "Deny" : confirm.action === "banned" ? "Ban" : "Suspend"}</button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}

function PendingRow({ user, roles, busy, onApprove, onDeny }: { user: AdminUser; roles: Role[]; busy: boolean; onApprove: (roleId: string) => void; onDeny: () => void }) {
  const [roleId, setRoleId] = useState(roles.find((r) => r.id === "member")?.id ?? roles.at(-1)?.id ?? "member");
  return (
    <li className="request">
      <Avatar src={user.avatarUrl} name={user.name} size={40} />
      <span className="request-who"><span className="person-name">{user.name}</span><span className="quiet">Asked {ago(user.createdAt)}</span></span>
      <select className="select" aria-label={`Role for ${user.name}`} value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={busy}>
        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <button className="btn btn-primary btn-s" disabled={busy} onClick={() => onApprove(roleId)}><Check aria-hidden />Approve</button>
      <button className="btn btn-quiet btn-s" disabled={busy} onClick={onDeny}><X aria-hidden />Deny</button>
    </li>
  );
}

function PreApprove({ roles, onDone, onError }: { roles: Role[]; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [id, setId] = useState("");
  const [roleId, setRoleId] = useState("member");
  const [busy, setBusy] = useState(false);
  const valid = /^\d{15,22}$/.test(id.trim());
  return (
    <section aria-labelledby="pre-title" className="panel">
      <h2 id="pre-title">Pre-approve</h2>
      <p className="quiet">Discord user ID (in Discord: right-click the user → Copy User ID). Their account is approved on first sign-in.</p>
      <form className="inline-form" onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setBusy(true);
        try {
          await api("POST", "/api/admin/preapprove", { discordId: id.trim(), roleId });
          onDone("Pre-approved.");
          setId("");
        } catch (err) {
          onError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}>
        <label className="field grow"><span>Discord user ID</span>
          <input className="input" inputMode="numeric" placeholder="e.g. 164143056172482562" value={id} onChange={(e) => setId(e.target.value)} aria-invalid={id !== "" && !valid} />
        </label>
        <label className="field"><span>Role</span>
          <select className="select" value={roleId} onChange={(e) => setRoleId(e.target.value)}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        </label>
        <button className="btn btn-primary" disabled={!valid || busy}><UserPlus aria-hidden />Pre-approve</button>
      </form>
    </section>
  );
}
