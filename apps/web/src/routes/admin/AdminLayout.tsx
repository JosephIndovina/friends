import { Link, Outlet } from "@tanstack/react-router";
import type { Session } from "@friends/shared";
import { ADMIN_TABS, can } from "../../lib/api";
import { useGlow } from "../../lib/glow";

export function AdminLayout({ session }: { session: Session }) {
  useGlow(null);
  const tabs = ADMIN_TABS.filter((t) => can(session, t.perm));
  return (
    <div className="admin">
      <header className="section-head admin-head">
        <h1>Admin</h1>
        <nav className="admin-tabs" aria-label="Admin sections">
          {tabs.map((t) => <Link key={t.to} to={t.to}>{t.label}</Link>)}
        </nav>
      </header>
      <Outlet />
    </div>
  );
}

export function NotAllowed() {
  return <p className="quiet">You don’t have access to this part of the admin panel.</p>;
}
