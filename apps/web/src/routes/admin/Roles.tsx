import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ChevronRight, Lock, Plus, Trash2 } from "lucide-react";
import { ALL_PERMISSIONS, PERMISSIONS, type AdminUser, type Permission, type Role, type Session } from "@friends/shared";
import { Avatar } from "../../components/Avatar";
import { LoadError, Loading, PageHead, Toggle, useConfirm } from "../../components/settings/ui";
import { api, can } from "../../lib/api";
import { errorText } from "../../lib/format";
import { useToast } from "../../lib/toast";
import { useLoad } from "./useLoad";

const GROUPS: { label: string; prefix: string[] }[] = [
  { label: "Player", prefix: ["player."] },
  { label: "Cast", prefix: ["cast."] },
  { label: "Posts and moderation", prefix: ["posts.", "playback."] },
  { label: "Admin", prefix: ["admin."] },
];
const permsIn = (g: (typeof GROUPS)[number]) => ALL_PERMISSIONS.filter((p) => g.prefix.some((x) => p.startsWith(x)));
const sameSet = (a: Permission[], b: Permission[]) => a.length === b.length && a.every((p) => b.includes(p));

function useRoleRules(session: Session, roles: Role[] | null) {
  const myRank = session.isOwner ? -1 : (roles?.find((r) => r.id === session.role?.id)?.position ?? 1000);
  return {
    editable: (r: Role) => r.id !== "owner" && (session.isOwner || r.position > myRank),
    grantable: (p: Permission) => session.isOwner || session.permissions.includes(p),
  };
}

export function Roles({ session }: { session: Session }) {
  const roles = useLoad(() => api<Role[]>("GET", "/api/admin/roles"));
  const [view, setView] = useState<"list" | "compare">("list");
  return (
    <div className="pane pane-wide">
      <PageHead title="Roles" note="Roles higher in the list outrank the ones below. People can only manage people and roles ranked below their own, and can’t grant permissions they don’t have."
        actions={
          <div className="segmented segmented-s" role="radiogroup" aria-label="View">
            {(["list", "compare"] as const).map((v) => (
              <label key={v}>
                <input type="radio" name="roles-view" checked={view === v} onChange={() => setView(v)} />
                <span>{v === "list" ? "List" : "Compare"}</span>
              </label>
            ))}
          </div>
        } />
      {roles.error ? <LoadError text={roles.error} onRetry={roles.reload} />
        : !roles.data ? <Loading rows={4} />
        : view === "list" ? <RoleList session={session} roles={roles.data} onChange={roles.setData} reload={roles.reload} />
        : <Compare session={session} roles={roles.data} reload={roles.reload} />}
    </div>
  );
}

function RoleList({ session, roles, onChange, reload }: { session: Session; roles: Role[]; onChange: (r: Role[]) => void; reload: () => Promise<void> }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { editable, grantable } = useRoleRules(session, roles);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const ranked = roles.filter((r) => r.id !== "owner");
  const owner = roles.find((r) => r.id === "owner");

  async function move(i: number, dir: -1 | 1) {
    const ids = ranked.map((r) => r.id);
    [ids[i], ids[i + dir]] = [ids[i + dir]!, ids[i]!];
    setBusy(true);
    try {
      onChange(await api<Role[]>("POST", "/api/admin/roles/order", { ids }));
    } catch (e) {
      toast(errorText(e), { kind: "error" });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const member = roles.find((r) => r.id === "member");
    const lowestEditable = Math.min(...ranked.filter(editable).map((r) => r.position), 999);
    const position = Math.max(1, member && editable(member) ? member.position - 1 : lowestEditable + 1);
    setBusy(true);
    try {
      const { id } = await api<{ id: string }>("POST", "/api/admin/roles", { name, permissions: (["player.queue", "cast.watch", "posts.create"] as Permission[]).filter(grantable), position });
      setNewName("");
      toast(`Created ${name}.`);
      void navigate({ to: "/admin/roles/$roleId", params: { roleId: id } });
    } catch (err) {
      toast(errorText(err), { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  const row = (r: Role, i: number | null) => {
    const canEdit = editable(r);
    const canUp = i !== null && i > 0 && canEdit && editable(ranked[i - 1]!);
    const canDown = i !== null && i < ranked.length - 1 && canEdit;
    return (
      <li key={r.id} className="role-row">
        <span className="role-rank mono-num" aria-hidden>{i === null ? "" : i + 1}</span>
        {canEdit ? (
          <Link to="/admin/roles/$roleId" params={{ roleId: r.id }} className="role-main">
            <span className="person-name">{r.name}</span>
            <span className="quiet">{r.memberCount} {r.memberCount === 1 ? "person" : "people"} · {r.permissions.length} of {ALL_PERMISSIONS.length} permissions</span>
            <ChevronRight aria-hidden className="row-chevron" />
          </Link>
        ) : (
          <span className="role-main">
            <span className="person-name">{r.name} <Lock aria-label="Locked" className="lock" /></span>
            <span className="quiet">{r.id === "owner" ? "All permissions · can’t be changed" : `${r.memberCount} ${r.memberCount === 1 ? "person" : "people"} · ranked at or above you`}</span>
          </span>
        )}
        {i !== null && canEdit && (
          <span className="role-move">
            <button className="icon-btn" aria-label={`Move ${r.name} up`} disabled={!canUp || busy} onClick={() => void move(i, -1)}><ArrowUp aria-hidden /></button>
            <button className="icon-btn" aria-label={`Move ${r.name} down`} disabled={!canDown || busy} onClick={() => void move(i, 1)}><ArrowDown aria-hidden /></button>
          </span>
        )}
      </li>
    );
  };

  return (
    <>
      <ol className="role-list">
        {owner && row(owner, null)}
        {ranked.map((r, i) => row(r, i))}
      </ol>
      {can(session, "admin.roles") && (
        <form className="inline-form" onSubmit={create}>
          <label className="field grow"><span>New role</span>
            <input className="input" placeholder="DJ" maxLength={32} value={newName} onChange={(e) => setNewName(e.target.value)} />
          </label>
          <button className="btn btn-quiet" disabled={!newName.trim() || busy}><Plus aria-hidden />Add role</button>
        </form>
      )}
    </>
  );
}

export function RoleEdit({ session, roleId }: { session: Session; roleId: string }) {
  const roles = useLoad(() => api<Role[]>("GET", "/api/admin/roles"));
  const users = useLoad(() => (can(session, "admin.people") ? api<AdminUser[]>("GET", "/api/admin/users") : Promise.resolve([] as AdminUser[])));
  const toast = useToast();
  const navigate = useNavigate();
  const [ask, dialog] = useConfirm();
  const role = roles.data?.find((r) => r.id === roleId) ?? null;
  const { editable, grantable } = useRoleRules(session, roles.data);
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<Permission[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (role) {
      setName(role.name);
      setPerms(role.permissions);
    }
  }, [role]);

  const back = { to: "/admin/roles", label: "Roles", always: true };
  if (roles.error) return <div className="pane"><PageHead title="Role" back={back} /><LoadError text={roles.error} onRetry={roles.reload} /></div>;
  if (!roles.data) return <div className="pane"><PageHead title="Role" back={back} /><Loading rows={4} /></div>;
  if (!role) return <div className="pane"><PageHead title="Role not found" back={back} /><p className="empty-line">This role was deleted or never existed.</p></div>;

  const locked = !editable(role);
  const dirty = name.trim() !== role.name || !sameSet(perms, role.permissions);
  const members = (users.data ?? []).filter((u) => u.roleId === role.id && u.status !== "banned");

  async function save() {
    setSaving(true);
    try {
      await api("PATCH", `/api/admin/roles/${role!.id}`, { ...(name.trim() !== role!.name ? { name: name.trim() } : {}), permissions: perms });
      toast(`Saved ${name.trim()}. Changes apply to everyone right away.`);
      await roles.reload();
    } catch (e) {
      toast(errorText(e), { kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const n = role!.memberCount;
    if ((await ask({ title: `Delete ${role!.name}?`, body: n ? `${n} ${n === 1 ? "person moves" : "people move"} to Member.` : "No one has this role.", confirm: "Delete role", danger: true })) === null) return;
    try {
      await api("DELETE", `/api/admin/roles/${role!.id}`);
      toast(`Deleted ${role!.name}.`);
      void navigate({ to: "/admin/roles" });
    } catch (e) {
      toast(errorText(e), { kind: "error" });
    }
  }

  return (
    <div className="pane">
      <PageHead title={role.name} back={back} note={locked ? "This role is ranked at or above yours, so you can’t change it." : undefined} />

      <section className="panel" aria-labelledby="name-title">
        <h2 id="name-title">Name</h2>
        <input className="input" aria-labelledby="name-title" value={name} maxLength={32} disabled={locked} onChange={(e) => setName(e.target.value)} />
      </section>

      {GROUPS.map((g) => (
        <section key={g.label} className="panel" aria-labelledby={`g-${g.label}`}>
          <h2 id={`g-${g.label}`}>{g.label}</h2>
          {permsIn(g).map((p) => {
            const on = role.id === "owner" || perms.includes(p);
            const cant = !on && !grantable(p);
            return (
              <Toggle key={p} label={PERMISSIONS[p]} checked={on} disabled={locked || cant}
                hint={cant ? "You don’t have this permission, so you can’t grant it." : undefined}
                onChange={(v) => setPerms((cur) => (v ? [...cur, p] : cur.filter((x) => x !== p)))} />
            );
          })}
        </section>
      ))}

      {can(session, "admin.people") && (
        <section className="panel" aria-labelledby="members-title">
          <h2 id="members-title">People with this role <span className="quiet">· {members.length}</span></h2>
          {members.length === 0 ? <p className="quiet">No one yet. Assign roles from People.</p> : (
            <ul className="member-chips">
              {members.map((u) => <li key={u.id}><Avatar src={u.avatarUrl} name={u.name} size={24} />{u.name}</li>)}
            </ul>
          )}
        </section>
      )}

      {!role.builtin && !locked && (
        <section className="panel" aria-labelledby="delete-title">
          <div className="setting-row">
            <div className="setting-text"><span id="delete-title">Delete role</span><span className="quiet">Anyone with this role moves to Member.</span></div>
            <div className="setting-control"><button className="btn btn-quiet btn-s btn-danger-quiet" onClick={() => void remove()}><Trash2 aria-hidden />Delete</button></div>
          </div>
        </section>
      )}

      {!locked && (
        <div className={`savebar${dirty ? " is-dirty" : ""}`} aria-live="polite">
          <span>{dirty ? "Unsaved changes" : "No changes"}</span>
          <button className="btn btn-quiet btn-s" disabled={!dirty || saving} onClick={() => { setName(role.name); setPerms(role.permissions); }}>Discard</button>
          <button className="btn btn-primary btn-s" disabled={!dirty || saving || !name.trim()} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</button>
        </div>
      )}
      {dialog}
    </div>
  );
}

function Compare({ session, roles, reload }: { session: Session; roles: Role[]; reload: () => Promise<void> }) {
  const toast = useToast();
  const { editable, grantable } = useRoleRules(session, roles);
  const fresh = () => Object.fromEntries(roles.map((r) => [r.id, r.permissions]));
  const [draft, setDraft] = useState<Record<string, Permission[]>>(fresh);
  const [saving, setSaving] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setDraft(fresh()), [roles]);
  const dirty = roles.filter((r) => editable(r) && !sameSet(draft[r.id] ?? [], r.permissions));

  async function save() {
    setSaving(true);
    try {
      for (const r of dirty) await api("PATCH", `/api/admin/roles/${r.id}`, { permissions: draft[r.id] });
      toast(`Saved ${dirty.map((r) => r.name).join(", ")}. Changes apply to everyone right away.`);
      await reload();
    } catch (e) {
      toast(errorText(e), { kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="table-wrap">
        <table className="table matrix">
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {roles.map((r) => (
                <th key={r.id} scope="col" className="role-col">
                  <span className="role-head">{r.name}{!editable(r) && <Lock aria-label="Locked" className="lock" />}</span>
                </th>
              ))}
            </tr>
          </thead>
          {GROUPS.map((g) => (
            <tbody key={g.label}>
              <tr className="group-row"><th scope="rowgroup" colSpan={roles.length + 1}>{g.label}</th></tr>
              {permsIn(g).map((p) => (
                <tr key={p}>
                  <th scope="row">{PERMISSIONS[p]}</th>
                  {roles.map((r) => {
                    const on = r.id === "owner" || (draft[r.id] ?? []).includes(p);
                    return (
                      <td key={r.id} className="cell-check">
                        <input type="checkbox" className="check" checked={on} disabled={!editable(r) || (!on && !grantable(p))}
                          aria-label={`${r.name}: ${PERMISSIONS[p]}`}
                          onChange={() => setDraft((d) => {
                            const cur = d[r.id] ?? [];
                            return { ...d, [r.id]: cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p] };
                          })} />
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
        <span>{dirty.length ? `Unsaved changes to ${dirty.map((r) => r.name).join(", ")}` : "No changes"}</span>
        <button className="btn btn-quiet btn-s" disabled={!dirty.length || saving} onClick={() => setDraft(fresh())}>Discard</button>
        <button className="btn btn-primary btn-s" disabled={!dirty.length || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</button>
      </div>
    </>
  );
}
