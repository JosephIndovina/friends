import { useGlow } from "../lib/glow";

const errors: Record<string, string> = {
  not_member: "That Discord account isn’t in the server. Ask someone for an invite, then try again.",
  cancelled: "Sign-in was cancelled. Try again when you’re ready.",
  expired: "That sign-in link expired. Try again.",
  discord: "Discord didn’t answer properly. Try again in a moment.",
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
        <small>Only members of the server can get in.</small>
      </div>
    </main>
  );
}
