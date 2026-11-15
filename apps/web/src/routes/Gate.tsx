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
        <h1 className="gate-title">Waiting for approval</h1>
        <p>An admin needs to approve your account. This page updates automatically.</p>
        <button className="btn btn-quiet" onClick={signOut}>Sign out</button>
      </div>
    </main>
  );
}

const CLOSED: Record<string, string> = {
  lockdown: "The site is currently limited to admins.",
  inactive: "Your account is suspended.",
};

export function Closed({ reason }: { reason: string }) {
  useGlow(null);
  return (
    <main className="signin">
      <div className="signin-inner">
        <h1 className="gate-title">Access unavailable</h1>
        <p>{CLOSED[reason] ?? CLOSED.inactive}</p>
        <button className="btn btn-quiet" onClick={signOut}>Sign out</button>
      </div>
    </main>
  );
}
