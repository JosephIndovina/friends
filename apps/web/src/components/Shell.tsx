import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Home, Settings, Shield } from "lucide-react";
import { useEffect } from "react";
import type { Activity, Section, Session } from "@friends/shared";
import { isAdminish } from "../lib/api";
import { useMediaState } from "../lib/media";
import { PlayerProvider, usePlayer } from "../lib/player";
import { reportActivity, reportSection } from "../lib/presence";
import { Avatar } from "./Avatar";
import { PlayerDock } from "./media/PlayerDock";
import { PresenceStack } from "./PresenceStack";

function sectionFor(path: string): Section {
  if (path.startsWith("/admin")) return "admin";
  if (path.startsWith("/settings")) return "settings";
  return "home";
}

/** Tell the room what we're doing: watching or listening only when the player is actually audible for us. */
function ActivityReporter() {
  const now = useMediaState()?.now ?? null;
  const p = usePlayer();
  const visible = !p.hidden.has("player") && (Boolean(p.slot) || p.dismissedFor !== now?.item.id);
  const activity: Activity = now?.playing && p.audible && visible ? (now.item.mode === "music" ? "listening" : "watching") : "idle";
  useEffect(() => reportActivity(activity), [activity]);
  return null;
}

export function Shell({ session }: { session: Session }) {
  const me = session.user;
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => reportSection(sectionFor(path)), [path]);
  const nav = [
    { to: "/", label: "Home", Icon: Home },
    { to: "/settings", label: "Settings", Icon: Settings },
    ...(isAdminish(session) ? [{ to: "/admin", label: "Admin", Icon: Shield }] : []),
  ] as const;

  return (
    <PlayerProvider>
      <div className="shell">
        <header className="topbar">
          <Link to="/" className="wordmark">friends</Link>
          <nav className="topnav" aria-label="Sections">
            {nav.map(({ to, label }) => (
              <Link key={to} to={to} activeOptions={{ exact: to === "/" }}>{label}</Link>
            ))}
          </nav>
          <div className="topbar-end">
            <PresenceStack me={me} />
            <Link to="/settings" className="me-link" aria-label={`Settings for ${me.name}`}>
              <Avatar src={me.avatarUrl} name={me.name} size={34} />
            </Link>
          </div>
        </header>

        <main className="page">
          <Outlet />
        </main>

        <PlayerDock session={session} />
        <ActivityReporter />

        <nav className="tabbar" aria-label="Sections" style={{ gridTemplateColumns: `repeat(${nav.length}, 1fr)` }}>
          {nav.map(({ to, label, Icon }) => (
            <Link key={to} to={to} activeOptions={{ exact: to === "/" }}>
              <Icon aria-hidden strokeWidth={1.75} />
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </PlayerProvider>
  );
}
