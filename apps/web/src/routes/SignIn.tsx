import { useGlow } from "../lib/glow";

const errors: Record<string, string> = {
  not_member: "That Discord account isn’t in the server. Ask someone for an invite, then try again.",
  cancelled: "Sign-in was cancelled. Try again when you’re ready.",
  expired: "That sign-in link expired. Try again.",
  discord: "Discord didn’t answer properly. Try again in a moment.",
  banned: "This account can’t sign in here. Ask an admin if you think that’s a mistake.",
  suspended: "Your access is paused. Ask an admin if you think that’s a mistake.",
  lockdown: "The site is closed to everyone but admins for now. Check back soon.",
};

export function SignIn() {
  useGlow(null);
  const code = new URLSearchParams(window.location.search).get("auth_error");
  const error = code ? (errors[code] ?? errors.discord) : null;
  return (
    <main className="signin">
      <div className="signin-inner">
        <h1>friends</h1>
        <p>Music, watch parties and screens, in sync for the server.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <a className="btn btn-primary" href="/auth/discord/login">Continue with Discord</a>
        <small>Members of the server can ask to join. An admin lets you in.</small>
      </div>
    </main>
  );
}
