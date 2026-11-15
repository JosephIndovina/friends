import { useState } from "react";
import { LogOut, Monitor, Moon, Sun, Volume2, VolumeX } from "lucide-react";
import type { Session } from "@friends/shared";
import { Avatar } from "../../components/Avatar";
import { PageHead, Toggle } from "../../components/settings/ui";
import { signOut } from "../../lib/api";
import { STREAM_MODES, useCast, type StreamMode } from "../../lib/cast";
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

export function Appearance() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="pane">
      <PageHead title="Appearance" />
      <section className="panel" aria-label="Theme">
        <Row label="Theme" hint="System follows your device setting.">
          <Segmented name="theme" label="Theme" value={theme} options={themes} onChange={setTheme} />
        </Row>
      </section>
    </div>
  );
}

function readLocal(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* this visit only */
  }
}

type MusicView = "viz" | "lyrics" | "art";

export function Playback() {
  const p = usePlayer();
  const cast = useCast();
  const toast = useToast();
  const [musicView, setMusicView] = useState<MusicView>(() => readLocal("musicView", "viz") as MusicView);
  const [streamMode, setStreamMode] = useState<string>(() => {
    try {
      return (JSON.parse(localStorage.getItem("streamMode") ?? "null") as StreamMode | null)?.id ?? STREAM_MODES[0]!.id;
    } catch {
      return STREAM_MODES[0]!.id;
    }
  });
  const hiddenCount = p.hidden.size;
  const viewCount = Object.keys(p.viewOverrides).length;

  return (
    <div className="pane">
      <PageHead title="Playback" note="Saved on this device." />

      <section className="panel" aria-labelledby="sound-title">
        <h2 id="sound-title">Sound</h2>
        <Row label="Volume" hint="The player. Each cast stream has its own volume on the stage.">
          <div className="volume-control">
            <button className="icon-btn" onClick={() => p.setAudible(!p.audible)} aria-label={p.audible ? "Mute" : "Unmute"} aria-pressed={!p.audible}>
              {p.audible ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}
            </button>
            <input type="range" className="range" min={1} max={100} value={p.volume} aria-label="Volume"
              onChange={(e) => { p.setVolume(Number(e.target.value)); if (!p.audible) p.setAudible(true); }} />
            <output className="volume-value">{p.audible ? `${p.volume}%` : "Muted"}</output>
          </div>
        </Row>
      </section>

      <section className="panel" aria-labelledby="music-title">
        <h2 id="music-title">Music</h2>
        <Row label="Default view" hint="What shows on the stage while music plays. You can still switch on the stage.">
          <Segmented name="music-view" label="Default music view" value={musicView}
            options={[{ value: "viz", label: "Visualizer" }, { value: "lyrics", label: "Lyrics" }, { value: "art", label: "Artwork" }]}
            onChange={(v) => { setMusicView(v); writeLocal("musicView", v); }} />
        </Row>
        <Row label="Music or video per track" hint={viewCount ? `You’ve picked a view for ${viewCount} ${viewCount === 1 ? "track" : "tracks"}.` : "None saved."}>
          <button className="btn btn-quiet btn-s" disabled={!viewCount} onClick={() => { p.clearViewOverrides(); toast("Cleared per-track views."); }}>Clear</button>
        </Row>
      </section>

      <section className="panel" aria-labelledby="stage-title">
        <h2 id="stage-title">Stage</h2>
        <Row label="Hidden sources" hint={hiddenCount ? `${hiddenCount} hidden on this device.` : "Nothing hidden."}>
          <button className="btn btn-quiet btn-s" disabled={!hiddenCount} onClick={() => { for (const id of p.hidden) p.setHidden(id, false); toast("Showing all sources."); }}>Show all</button>
        </Row>
      </section>

      {cast.canStream && (
        <section className="panel" aria-labelledby="live-title">
          <h2 id="live-title">Going live</h2>
          <p className="quiet">The quality picked when you go live. You can change it each time.</p>
          <div className="choice-list" role="radiogroup" aria-labelledby="live-title">
            {STREAM_MODES.map((m) => (
              <label key={m.id} className="choice">
                <input type="radio" name="stream-mode" checked={streamMode === m.id}
                  onChange={() => { setStreamMode(m.id); writeLocal("streamMode", JSON.stringify(m)); }} />
                <span><span className="choice-label">{m.label}</span><span className="quiet">{m.detail}</span></span>
              </label>
            ))}
          </div>
        </section>
      )}
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
        </div>
      </section>
      <section className="panel" aria-labelledby="details-title">
        <h2 id="details-title">Details</h2>
        <dl className="kv">
          <div><dt>Discord ID</dt><dd className="mono-num">{me.id}</dd></div>
          <div><dt>Role</dt><dd>{role}</dd></div>
          <div><dt>Permissions</dt><dd>{session.isOwner ? "All" : session.permissions.length}</dd></div>
        </dl>
        <p className="quiet">Your name and picture come from Discord and update when you sign in.</p>
      </section>
      <section className="panel" aria-labelledby="signout-title">
        <h2 id="signout-title">Sign out</h2>
        <Row label="Sign out on this device" hint="Music and streams stop on this device.">
          <button className="btn btn-quiet btn-s" disabled={busy} onClick={() => { setBusy(true); void signOut(); }}><LogOut aria-hidden />Sign out</button>
        </Row>
      </section>
    </div>
  );
}
