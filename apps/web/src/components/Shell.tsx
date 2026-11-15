import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Clapperboard, Home, MonitorUp, Music2, Settings } from "lucide-react";
import { useEffect } from "react";
import type { Me, Section } from "@friends/shared";
import { reportSection } from "../lib/presence";
import { Avatar } from "./Avatar";

const nav = [
  { to: "/", label: "Home", section: "home", Icon: Home },
  { to: "/music", label: "Music", section: "music", Icon: Music2 },
  { to: "/media", label: "Media", section: "media", Icon: Clapperboard },
  { to: "/cast", label: "Cast", section: "cast", Icon: MonitorUp },
  { to: "/settings", label: "Settings", section: "settings", Icon: Settings },
] as const satisfies ReadonlyArray<{ to: string; label: string; section: Section; Icon: unknown }>;

function sectionFor(path: string): Section {
  return nav.find((n) => n.to !== "/" && path.startsWith(n.to))?.section ?? "home";
}

export function Shell({ me }: { me: Me }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => reportSection(sectionFor(path)), [path]);

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="wordmark">friends</Link>
        <nav className="topnav" aria-label="Sections">
          {nav.map(({ to, label }) => (
            <Link key={to} to={to} activeOptions={{ exact: to === "/" }}>{label}</Link>
          ))}
        </nav>
        <div className="topbar-end">
          <Link to="/settings" className="me-link" aria-label={`Settings for ${me.name}`}>
            <Avatar src={me.avatarUrl} name={me.name} size={34} />
          </Link>
        </div>
      </header>

      <main className="page">
        <Outlet />
      </main>

      <nav className="tabbar" aria-label="Sections">
        {nav.map(({ to, label, Icon }) => (
          <Link key={to} to={to} activeOptions={{ exact: to === "/" }}>
            <Icon aria-hidden strokeWidth={1.75} />
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
