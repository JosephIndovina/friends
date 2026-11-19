import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Home } from "lucide-react";
import { useEffect } from "react";
import type { Activity, Section, Session } from "@friends/shared";
import { usePendingCount } from "../lib/attention";
import { useMediaState } from "../lib/media";
import { PlayerProvider, usePlayer, viewModeOf } from "../lib/player";
import { CastProvider, StreamAudio, useCast } from "../lib/cast";
import { SoundsProvider } from "../lib/sounds";
import { ToastProvider, useToast } from "../lib/toast";
import { getSocket } from "../lib/socket";
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
  const watchingStream = cast.streams.some((st) => !st.local && cast.watching.has(st.id))
    || (p.stageOpen && (state?.screens ?? []).some((sc) => sc.playing && p.screenSound.has(sc.item.id) && !p.hidden.has(sc.item.id)));
  const activity: Activity = cast.streams.some((st) => st.local && st.kind === "screen")
    ? "casting"
    : now?.playing && p.audible && visible
      ? viewModeOf(now.item, p.viewOverrides) === "music" ? "listening" : "watching"
      : watchingStream ? "watching" : "idle";
  useEffect(() => reportActivity(activity), [activity]);
  return null;
}

/** Sound for every watched stream, on every page (each with this viewer's own volume and mute). */
function StreamSound() {
  const cast = useCast();
  return <>{cast.streams.filter((st) => !st.local && cast.watching.has(st.id)).map((st) => <StreamAudio key={st.id} stream={st} />)}</>;
}

/** Your avatar: opens settings, with a badge for access requests waiting on you. */
export function MeLink({ session, size = 34 }: { session: Session; size?: number }) {
  const me = session.user;
  const pending = usePendingCount(session);
  return (
    <Link to="/settings" className="me-link" aria-label={pending ? `Settings, ${pending} access ${pending === 1 ? "request" : "requests"} waiting` : "Settings"}>
      <Avatar src={me.avatarUrl} name={me.name} size={size} />
      {pending > 0 && <span className="me-badge" aria-hidden>{pending}</span>}
    </Link>
  );
}

export function Shell({ session }: { session: Session }) {
  const me = session.user;
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => reportSection(sectionFor(path)), [path]);
  // Settings and admin live behind the avatar. The section nav only shows once there's more than one section.
  const nav = [{ to: "/", label: "Home", Icon: Home }] as const;
  const showNav = nav.length > 1;

  return (
    <PlayerProvider>
     <CastProvider session={session}>
      <ToastProvider>
      <SoundsProvider session={session}>
      <StreamEndedNotice />
      <OthersNotice me={me.id} />
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
            <MeLink session={session} />
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
      </SoundsProvider>
      </ToastProvider>
     </CastProvider>
    </PlayerProvider>
  );
}

/** Who started or stopped something on the stage (the player, a screen, a stream), unless it was you. */
function OthersNotice({ me }: { me: string }) {
  const toast = useToast();
  useEffect(() => {
    const s = getSocket();
    const on = ({ by, text }: { by: string; text: string }) => {
      if (by !== me) toast(text);
    };
    s.on("notice", on);
    return () => void s.off("notice", on);
  }, [toast, me]);
  return null;
}

/** When a moderator ends your stream, say who: otherwise it just vanishes. Stays until dismissed, in case you weren't looking. */
function StreamEndedNotice() {
  const toast = useToast();
  useEffect(() => {
    const s = getSocket();
    const on = ({ by, app }: { by: string; app: boolean }) =>
      toast(`${by} ended your stream${app ? " from Friends Live" : ""}.`, { kind: "error" });
    s.on("cast:ended", on);
    return () => void s.off("cast:ended", on);
  }, [toast]);
  return null;
}
