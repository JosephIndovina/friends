import { useState } from "react";
import { Check, X } from "lucide-react";
import type { AdminUser, Role } from "@friends/shared";
import { Avatar } from "../../components/Avatar";
import { useConfirm } from "../../components/settings/ui";
import { api } from "../../lib/api";
import { refreshPendingCount } from "../../lib/attention";
import { ago, errorText } from "../../lib/format";
import { useToast } from "../../lib/toast";

/** Access requests with approve (pick a role) and deny. */
export function Requests({ pending, roles, onChanged }: { pending: AdminUser[]; roles: Role[]; onChanged: () => void }) {
  const toast = useToast();
  const [ask, dialog] = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);

  async function run(u: AdminUser, fn: () => Promise<unknown>, ok: string) {
    setBusy(u.id);
    try {
      await fn();
      toast(ok);
      onChanged();
      refreshPendingCount();
    } catch (e) {
      toast(errorText(e), { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function deny(u: AdminUser) {
    const reason = await ask({ title: `Deny ${u.name}?`, body: "They’re blocked from signing in. You can reinstate them later from People.", confirm: "Deny", danger: true, reason: "Reason (optional, shown in the audit log)" });
    if (reason === null) return;
    await run(u, () => api("POST", `/api/admin/users/${u.id}/deny`, { reason: reason || undefined }), `Denied ${u.name}.`);
  }

  return (
    <>
      <ul className="requests">
        {pending.map((u) => (
          <Request key={u.id} user={u} roles={roles} busy={busy === u.id}
            onApprove={(roleId) => run(u, () => api("POST", `/api/admin/users/${u.id}/approve`, { roleId }), `Approved ${u.name}.`)}
            onDeny={() => void deny(u)} />
        ))}
      </ul>
      {dialog}
    </>
  );
}

function Request({ user, roles, busy, onApprove, onDeny }: { user: AdminUser; roles: Role[]; busy: boolean; onApprove: (roleId: string) => void; onDeny: () => void }) {
  const [roleId, setRoleId] = useState(roles.find((r) => r.id === "member")?.id ?? roles.at(-1)?.id ?? "member");
  return (
    <li className="request" aria-busy={busy}>
      <Avatar src={user.avatarUrl} name={user.name} size={40} />
      <span className="request-who"><span className="person-name">{user.name}</span><span className="quiet">Asked {ago(user.createdAt)}</span></span>
      <div className="request-actions">
        <select className="select" aria-label={`Role for ${user.name}`} value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={busy}>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button className="btn btn-primary btn-s" disabled={busy} onClick={() => onApprove(roleId)}><Check aria-hidden />Approve</button>
        <button className="btn btn-quiet btn-s" disabled={busy} onClick={onDeny}><X aria-hidden />Deny</button>
      </div>
    </li>
  );
}
