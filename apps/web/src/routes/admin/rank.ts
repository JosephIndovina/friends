import type { AdminUser, Role, Session } from "@friends/shared";

/** Who this admin can manage and which roles they can hand out (mirrors the server's checks). */
export function ranks(session: Session, roles: Role[] | null) {
  const list = roles ?? [];
  const myRank = session.isOwner ? -1 : (list.find((r) => r.id === session.role?.id)?.position ?? 1000);
  const rankOf = (u: AdminUser) => (u.isOwner ? -1 : (list.find((r) => r.id === u.roleId)?.position ?? 1000));
  return {
    myRank,
    manageable: (u: AdminUser) => !u.isOwner && u.id !== session.user.id && (session.isOwner || myRank < rankOf(u)),
    assignable: list.filter((r) => r.id !== "owner" && (session.isOwner || r.position > myRank)),
    roleName: (id: string | null) => list.find((r) => r.id === id)?.name ?? "No role",
  };
}
