import { useGlow } from "../lib/glow";

const errors: Record<string, string> = {
  not_member: "This Discord account isn’t a member of the server.",
  cancelled: "Sign-in was cancelled.",
  expired: "The sign-in link expired. Try again.",
  discord: "Discord returned an error. Try again.",
  banned: "This account is banned.",
  suspended: "This account is suspended.",
  lockdown: "The site is currently limited to admins.",
};

export function SignIn() {
  useGlow(null);
  const code = new URLSearchParams(window.location.search).get("auth_error");
  const error = code ? (errors[code] ?? errors.discord) : null;
  return (
    <main className="signin">
      <div className="signin-inner">
        <h1>friends</h1>
        {error && <p className="error" role="alert">{error}</p>}
        <a className="btn btn-primary" href="/auth/discord/login">Continue with Discord</a>
        <small>Server members can request access. An admin approves requests.</small>
      </div>
    </main>
  );
}
