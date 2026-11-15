import type { Session } from "@friends/shared";
import { Avatar } from "../components/Avatar";
import { signOut } from "../lib/api";
import { useGlow } from "../lib/glow";

export function Waiting({ session }: { session: Session }) {
  useGlow(null);
  return (
    <main className="signin">
      <div className="signin-inner">
        <Avatar src={session.user.avatarUrl} name={session.user.name} size={72} />
        <h1 className="gate-title">You’re on the list, {session.user.name}</h1>
        <p>An admin needs to let you in. This page opens up by itself once they do, so you can leave it open.</p>
        <button className="btn btn-quiet" onClick={signOut}>Use a different account</button>
      </div>
    </main>
  );
}

const CLOSED: Record<string, string> = {
  lockdown: "The site is closed to everyone but admins for now. Check back soon.",
  inactive: "Your access is paused. Ask an admin if you think that’s a mistake.",
};

export function Closed({ reason }: { reason: string }) {
  useGlow(null);
  return (
    <main className="signin">
      <div className="signin-inner">
        <h1 className="gate-title">Closed for now</h1>
        <p>{CLOSED[reason] ?? CLOSED.inactive}</p>
        <button className="btn btn-quiet" onClick={signOut}>Sign out</button>
      </div>
    </main>
  );
}
