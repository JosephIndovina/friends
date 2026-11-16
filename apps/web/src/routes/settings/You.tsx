import { useState } from "react";
import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import type { Session } from "@friends/shared";
import { Avatar } from "../../components/Avatar";
import { PageHead } from "../../components/settings/ui";
import { signOut } from "../../lib/api";
import { usePlayer } from "../../lib/player";
import { useTheme, type ThemeChoice } from "../../lib/theme";
import { useToast } from "../../lib/toast";

function Segmented<T extends string>({ name, label, value, options, onChange }: {
  name: string; label: string; value: T; options: { value: T; label: string; Icon?: typeof Sun }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(({ value: v, label: l, Icon }) => (
        <label key={v}>
          <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} />
          <span>{Icon && <Icon aria-hidden />}{l}</span>
        </label>
      ))}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text"><span>{label}</span>{hint && <span className="quiet">{hint}</span>}</div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

const themes: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "light", label: "Light", Icon: Sun },
];

/** Your settings on this device. Volume, music view and stream quality are set where they're used, on the stage. */
export function Preferences() {
  const [theme, setTheme] = useTheme();
  const p = usePlayer();
  const toast = useToast();
  const viewCount = Object.keys(p.viewOverrides).length;

  return (
    <div className="pane">
      <PageHead title="Preferences" note="Saved on this device." />

      <section className="panel" aria-labelledby="look-title">
        <h2 id="look-title">Appearance</h2>
        <Row label="Theme" hint="System follows your device setting.">
          <Segmented name="theme" label="Theme" value={theme} options={themes} onChange={setTheme} />
        </Row>
      </section>

      <section className="panel" aria-labelledby="stage-title">
        <h2 id="stage-title">Stage</h2>
        <Row label="Music or video per track" hint={viewCount ? `You’ve picked a view for ${viewCount} ${viewCount === 1 ? "track" : "tracks"}.` : "None saved."}>
          <button className="btn btn-quiet btn-s" disabled={!viewCount} onClick={() => { p.clearViewOverrides(); toast("Cleared per-track views."); }}>Clear</button>
        </Row>
      </section>
    </div>
  );
}

export function Account({ session }: { session: Session }) {
  const me = session.user;
  const role = session.isOwner ? "Owner" : (session.role?.name ?? "Member");
  const [busy, setBusy] = useState(false);
  return (
    <div className="pane">
      <PageHead title="Account" />
      <section className="panel account-card" aria-label="Your account">
        <Avatar src={me.avatarUrl} name={me.name} size={64} />
        <div className="account-who">
          <span className="account-name">{me.name}</span>
          <span className="quiet">{role} · Signed in with Discord</span>
          <span className="quiet">Your name and picture come from Discord and update when you sign in.</span>
        </div>
      </section>
      <section className="panel" aria-label="Sign out">
        <Row label="Sign out on this device" hint="Music and streams stop on this device.">
          <button className="btn btn-quiet btn-s" disabled={busy} onClick={() => { setBusy(true); void signOut(); }}><LogOut aria-hidden />Sign out</button>
        </Row>
      </section>
    </div>
  );
}
