import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import type { Me } from "@friends/shared";
import { Avatar } from "../components/Avatar";
import { signOut } from "../lib/api";
import { useGlow } from "../lib/glow";
import { useTheme, type ThemeChoice } from "../lib/theme";

const choices: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "Match device", Icon: Monitor },
  { value: "dark", label: "Lights off", Icon: Moon },
  { value: "light", label: "Lights on", Icon: Sun },
];

export function Settings({ me }: { me: Me }) {
  useGlow(null);
  const [theme, setTheme] = useTheme();
  return (
    <div className="settings">
      <section className="section-head"><h1>Settings</h1></section>

      <section className="panel" aria-labelledby="theme-title">
        <h2 id="theme-title">Theme</h2>
        <div className="segmented" role="radiogroup" aria-labelledby="theme-title">
          {choices.map(({ value, label, Icon }) => (
            <label key={value}>
              <input type="radio" name="theme" value={value} checked={theme === value} onChange={() => setTheme(value)} />
              <span><Icon aria-hidden />{label}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="panel" aria-labelledby="account-title">
        <h2 id="account-title">Account</h2>
        <div className="account">
          <Avatar src={me.avatarUrl} name={me.name} size={48} />
          <span className="who"><span>{me.name}</span><span>Signed in with Discord</span></span>
          <button className="btn btn-quiet" style={{ marginLeft: "auto" }} onClick={signOut}><LogOut aria-hidden />Sign out</button>
        </div>
      </section>
    </div>
  );
}
