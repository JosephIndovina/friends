import { useEffect, useState } from "react";
import { Lock, Plus, Trash2 } from "lucide-react";
import { ALL_PERMISSIONS, PERMISSIONS, type Permission, type Role, type Session } from "@friends/shared";
import { api } from "../../lib/api";
import { errorText } from "../../lib/format";
import { useLoad } from "./useLoad";

const GROUPS: { label: string; prefix: string[] }[] = [
  { label: "Player", prefix: ["player."] },
  { label: "Cast", prefix: ["cast."] },
  { label: "Stream & moderation", prefix: ["posts.", "playback."] },
  { label: "Admin", prefix: ["admin."] },
];

export function Roles({ session }: { session: Session }) {
  const roles = useLoad(() => api<Role[]>("GET", "/api/admin/roles"));
  const [draft, setDraft] = useState<Record<string, Permission[]>>({});
  const [flash, setFlash] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    if (roles.data) setDraft(Object.fromEntries(roles.data.map((r) => [r.id, r.permissions])));
  }, [roles.data]);

  const myRank = session.isOwner ? -1 : (roles.data?.find((r) => r.id === session.role?.id)?.position ?? 1000);
  const editable = (r: Role) => r.id !== "owner" && (session.isOwner || r.position > myRank);
  const grantable = (p: Permission) => session.isOwner || session.permissions.includes(p);
  const dirty = (roles.data ?? []).filter((r) => editable(r) && JSON.stringify([...(draft[r.id] ?? [])].sort()) !== JSON.stringify([...r.permissions].sort()));

  function toggle(roleId: string, p: Permission) {
    setDraft((d) => {
      const cur = d[roleId] ?? [];
      return { ...d, [roleId]: cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p] };
    });
  }

  async function save() {
    setSaving(true);
    setFlash(null);
    try {
      for (const r of dirty) await api("PATCH", `/api/admin/roles/${r.id}`, { permissions: draft[r.id] });
      setFlash({ kind: "ok", text: `Saved ${dirty.map((r) => r.name).join(", ")}. Changes apply to everyone right away.` });
      await roles.reload();
    } catch (e) {
      setFlash({ kind: "error", text: errorText(e) });
    } finally {
      setSaving(false);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await api("POST", "/api/admin/roles", { name: newName.trim(), permissions: (["player.queue", "cast.watch", "posts.create"] as Permission[]).filter(grantable), position: 25 });
      setNewName("");
      setFlash({ kind: "ok", text: `Created ${newName.trim()}. It sits between Moderator and Member.` });
      await roles.reload();
    } catch (err) {
      setFlash({ kind: "error", text: errorText(err) });
    }
  }

  async function remove(r: Role) {
    if (!window.confirm(`Delete ${r.name}? ${r.memberCount ? `${r.memberCount} ${r.memberCount === 1 ? "person moves" : "people move"} to Member.` : ""}`)) return;
    try {
      await api("DELETE", `/api/admin/roles/${r.id}`);
      setFlash({ kind: "ok", text: `Deleted ${r.name}.` });
      await roles.reload();
    } catch (err) {
      setFlash({ kind: "error", text: errorText(err) });
    }
  }

  const list = roles.data ?? [];
  return (
    <div className="admin-stack">
      {flash && <p className={`flash flash-${flash.kind}`} role="status">{flash.text}</p>}
      {roles.error && <p className="flash flash-error" role="alert">{roles.error}</p>}
      <p className="quiet measure">Roles are ranked left to right. People can only manage roles and people ranked below them, and can’t grant permissions they don’t have.</p>

      <div className="table-wrap">
        <table className="table matrix">
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {list.map((r) => (
                <th key={r.id} scope="col" className="role-col">
                  <span className="role-head">
                    {r.name}
                    {!editable(r) && <Lock aria-label="Locked" className="lock" />}
                    {!r.builtin && editable(r) && (
                      <button className="icon-btn" aria-label={`Delete ${r.name}`} title={`Delete ${r.name}`} onClick={() => remove(r)}><Trash2 aria-hidden /></button>
                    )}
                  </span>
                  <span className="quiet role-count">{r.memberCount} {r.memberCount === 1 ? "person" : "people"}</span>
                </th>
              ))}
            </tr>
          </thead>
          {GROUPS.map((g) => (
            <tbody key={g.label}>
              <tr className="group-row"><th scope="rowgroup" colSpan={list.length + 1}>{g.label}</th></tr>
              {ALL_PERMISSIONS.filter((p) => g.prefix.some((x) => p.startsWith(x))).map((p) => (
                <tr key={p}>
                  <th scope="row"><span className="perm-name">{PERMISSIONS[p]}</span><span className="person-id">{p}</span></th>
                  {list.map((r) => {
                    const on = r.id === "owner" || (draft[r.id] ?? []).includes(p);
                    const disabled = !editable(r) || (!on && !grantable(p));
                    return (
                      <td key={r.id} className="cell-check">
                        <input type="checkbox" className="check" checked={on} disabled={disabled}
                          aria-label={`${r.name}: ${PERMISSIONS[p]}`} onChange={() => toggle(r.id, p)} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>

      <div className={`savebar${dirty.length ? " is-dirty" : ""}`} aria-live="polite">
        <span>{dirty.length ? `Unsaved changes to ${dirty.map((r) => r.name).join(", ")}` : "All changes saved"}</span>
        <button className="btn btn-quiet btn-s" disabled={!dirty.length || saving} onClick={() => roles.data && setDraft(Object.fromEntries(roles.data.map((r) => [r.id, r.permissions])))}>Discard</button>
        <button className="btn btn-primary btn-s" disabled={!dirty.length || saving} onClick={save}>{saving ? "Saving…" : "Save changes"}</button>
      </div>

      {session.permissions.includes("admin.roles") && (
        <form className="inline-form panel" onSubmit={create}>
          <label className="field grow"><span>New role</span>
            <input className="input" placeholder="e.g. DJ" maxLength={32} value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>
          <button className="btn btn-quiet" disabled={!newName.trim()}><Plus aria-hidden />Add role</button>
        </form>
      )}
    </div>
  );
}
