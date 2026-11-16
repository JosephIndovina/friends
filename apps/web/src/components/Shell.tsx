import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Home } from "lucide-react";
import { useEffect } from "react";
import type { Activity, Section, Session } from "@friends/shared";
import { usePendingCount } from "../lib/attention";
import { useMediaState } from "../lib/media";
import { PlayerProvider, usePlayer, viewModeOf } from "../lib/player";
import { CastProvider, StreamAudio, useCast } from "../lib/cast";
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
  const state = useMediaState();
  const now = state?.now ?? null;
  const p = usePlayer();
  const cast = useCast();
  const visible = !p.hidden.has("player") && (Boolean(p.slot) || p.dismissedFor !== now?.item.id);
  const watchingStream = cast.streams.some((st) => !st.local && !p.hidden.has(st.id))
    || (p.stageOpen && (state?.screens ?? []).some((sc) => sc.playing && p.screenSound.has(sc.item.id) && !p.hidden.has(sc.item.id)));
  const activity: Activity = cast.streams.some((st) => st.local)
    ? "casting"
    : now?.playing && p.audible && visible
      ? viewModeOf(now.item, p.viewOverrides) === "music" ? "listening" : "watching"
      : watchingStream ? "watching" : "idle";
  useEffect(() => reportActivity(activity), [activity]);
  return null;
}

/** Sound for every visible stream, on every page (each with this viewer's own volume and mute). */
function StreamSound() {
  const cast = useCast();
  const p = usePlayer();
  return <>{cast.streams.filter((st) => !st.local && !p.hidden.has(st.id)).map((st) => <StreamAudio key={st.id} stream={st} />)}</>;
}

export function Shell({ session }: { session: Session }) {
  const me = session.user;
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => reportSection(sectionFor(path)), [path]);
  const pending = usePendingCount(session);
  // Settings and admin live behind the avatar. The section nav only shows once there's more than one section.
  const nav = [{ to: "/", label: "Home", Icon: Home }] as const;
  const showNav = nav.length > 1;

  return (
    <PlayerProvider>
     <CastProvider session={session}>
      <div className={`shell${showNav ? "" : " no-tabbar"}`}>
        <header className="topbar">
          <Link to="/" className="wordmark">friends</Link>
          {showNav && (
            <nav className="topnav" aria-label="Sections">
              {nav.map(({ to, label }) => (
                <Link key={to} to={to} activeOptions={{ exact: to === "/" }}>{label}</Link>
              ))}
            </nav>
          )}
          <div className="topbar-end">
            <PresenceStack me={me} />
            <Link to="/settings" className="me-link" aria-label={pending ? `Settings, ${pending} access ${pending === 1 ? "request" : "requests"} waiting` : "Settings"}>
              <Avatar src={me.avatarUrl} name={me.name} size={34} />
              {pending > 0 && <span className="me-badge" aria-hidden>{pending}</span>}
            </Link>
          </div>
        </header>

        <main className="page">
          <Outlet />
        </main>

        <PlayerDock session={session} />
        <StreamSound />
        <ActivityReporter />

        {showNav && (
          <nav className="tabbar" aria-label="Sections" style={{ gridTemplateColumns: `repeat(${nav.length}, 1fr)` }}>
            {nav.map(({ to, label, Icon }) => (
              <Link key={to} to={to} activeOptions={{ exact: to === "/" }}>
                <Icon aria-hidden strokeWidth={1.75} />
                {label}
              </Link>
            ))}
          </nav>
        )}
      </div>
     </CastProvider>
    </PlayerProvider>
  );
}
