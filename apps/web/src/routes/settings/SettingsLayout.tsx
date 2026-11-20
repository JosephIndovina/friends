import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Activity, ChevronRight, Gauge, Globe, KeyRound, Lock, ScrollText, ShieldCheck, SlidersHorizontal, UserRound, Users } from "lucide-react";
import type { Permission, Session } from "@friends/shared";
import { Avatar } from "../../components/Avatar";
import { can, isAdminish } from "../../lib/api";
import { usePendingCount } from "../../lib/attention";
import { useGlow } from "../../lib/glow";
import { useSite } from "../../lib/site";

interface Item { to: string; label: string; Icon: typeof SlidersHorizontal; perm?: Permission | "any-admin"; badge?: number; also?: string[] }

export function SettingsLayout({ session }: { session: Session }) {
  useGlow(null);
  const path = useRouterState({ select: (s) => s.location.pathname }).replace(/\/$/, "") || "/";
  const pending = usePendingCount(session);
  const site = useSite();

  const you: Item[] = [
    { to: "/settings/preferences", label: "Preferences", Icon: SlidersHorizontal, also: ["/settings", "/settings/appearance", "/settings/playback"] },
    { to: "/settings/account", label: "Account", Icon: UserRound },
  ];
  const admin: Item[] = [
    { to: "/admin", label: "Overview", Icon: Gauge, perm: "any-admin" },
    { to: "/admin/people", label: "People", Icon: Users, perm: "admin.people", badge: pending },
    { to: "/admin/roles", label: "Roles", Icon: KeyRound, perm: "admin.roles" },
    { to: "/admin/site", label: "Site", Icon: Globe, perm: "admin.settings" },
    { to: "/admin/system", label: "System", Icon: Activity, perm: "admin.settings" },
    { to: "/admin/audit", label: "Audit log", Icon: ScrollText, perm: "admin.audit" },
  ].filter((i) => (i.perm === "any-admin" ? isAdminish(session) : can(session, i.perm as Permission))) as Item[];

  const isActive = (i: Item) => path === i.to || (i.also?.includes(path) ?? false) || (i.to !== "/admin" && path.startsWith(`${i.to}/`));
  const atIndex = path === "/settings";
  const role = session.isOwner ? "Owner" : (session.role?.name ?? "Member");

  const link = (i: Item) => (
    <li key={i.to}>
      <Link to={i.to} className="prefs-link" data-active={isActive(i) || undefined} aria-current={isActive(i) ? "page" : undefined}>
        <i.Icon aria-hidden strokeWidth={1.75} />
        <span>{i.label}</span>
        {i.badge ? <span className="count" aria-label={`${i.badge} waiting`}>{i.badge}</span> : null}
        <ChevronRight aria-hidden className="prefs-chevron" />
      </Link>
    </li>
  );

  return (
      <div className={`prefs${atIndex ? " at-index" : ""}`}>
        <nav className="prefs-nav" aria-label="Settings">
          <Link to="/settings/account" className="prefs-me">
            <Avatar src={session.user.avatarUrl} name={session.user.name} size={40} />
            <span><span className="prefs-me-name">{session.user.name}</span><span className="quiet">{role}</span></span>
          </Link>
          <h2 className="prefs-group">You</h2>
          <ul>{you.map(link)}</ul>
          {admin.length > 0 && (
            <>
              <h2 className="prefs-group">Admin</h2>
              <ul>{admin.map(link)}</ul>
            </>
          )}
        </nav>

        <div className="prefs-pane">
          {site?.lockdown && isAdminish(session) && (
            <div className="lock-banner" role="status">
              <Lock aria-hidden />
              <span><strong>Lockdown is on.</strong> Only admins can use the site.</span>
              {path !== "/admin" && can(session, "admin.settings") && <Link to="/admin" className="btn btn-s btn-quiet">Manage</Link>}
            </div>
          )}
          <Outlet />
        </div>
      </div>
  );
}

export function NotAllowed() {
  return (
    <div className="load-error">
      <ShieldCheck aria-hidden className="quiet" />
      <p>You don’t have access to this page.</p>
    </div>
  );
}
