import { useEffect, useState } from "react";
import type { SiteSettings as Settings } from "@friends/shared";
import { api } from "../../lib/api";
import { errorText } from "../../lib/format";
import { useLoad } from "./useLoad";

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <span className="toggle-text"><span>{label}</span>{hint && <span className="quiet">{hint}</span>}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden />
    </label>
  );
}

export function SiteSettings() {
  const saved = useLoad(() => api<Settings>("GET", "/api/admin/settings"));
  const [s, setS] = useState<Settings | null>(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setS(saved.data), [saved.data]);
  if (!s) return saved.error ? <p className="flash flash-error">{saved.error}</p> : null;

  const dirty = JSON.stringify(s) !== JSON.stringify(saved.data);
  const channelValid = s.notify.channelId === null || /^\d{15,22}$/.test(s.notify.channelId);

  async function save() {
    setSaving(true);
    try {
      saved.setData(await api<Settings>("PUT", "/api/admin/settings", s));
      setFlash({ kind: "ok", text: "Settings saved." });
    } catch (e) {
      setFlash({ kind: "error", text: errorText(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-stack settings-narrow">
      {flash && <p className={`flash flash-${flash.kind}`} role="status">{flash.text}</p>}

      <section className={`panel${s.lockdown ? " panel-alarm" : ""}`} aria-labelledby="lock-title">
        <h2 id="lock-title">Lockdown</h2>
        <Toggle label="Only admins can use the site" hint="Disconnects all non-admin users immediately."
          checked={s.lockdown} onChange={(v) => setS({ ...s, lockdown: v })} />
      </section>

      <section className="panel" aria-labelledby="sections-title">
        <h2 id="sections-title">Sections</h2>
        <Toggle label="Music" checked={s.sections.music} onChange={(v) => setS({ ...s, sections: { ...s.sections, music: v } })} />
        <Toggle label="Media" checked={s.sections.media} onChange={(v) => setS({ ...s, sections: { ...s.sections, media: v } })} />
        <Toggle label="Cast" hint="Turning this off ends every live stream." checked={s.sections.cast} onChange={(v) => setS({ ...s, sections: { ...s.sections, cast: v } })} />
      </section>

      <section className="panel" aria-labelledby="notify-title">
        <h2 id="notify-title">Discord notifications</h2>
        <label className="field"><span>Channel ID</span>
          <input className="input" inputMode="numeric" value={s.notify.channelId ?? ""} aria-invalid={!channelValid}
            onChange={(e) => setS({ ...s, notify: { ...s.notify, channelId: e.target.value.trim() || null } })} />
          {!channelValid && <span className="field-error">Channel IDs are 15–22 digits.</span>}
        </label>
        <Toggle label="Access requests" hint="Post when someone requests access." checked={s.notify.accessRequests} onChange={(v) => setS({ ...s, notify: { ...s.notify, accessRequests: v } })} />
        <Toggle label="Now playing" hint="Post when music or a video starts after 30 minutes of inactivity." checked={s.notify.nowPlaying} onChange={(v) => setS({ ...s, notify: { ...s.notify, nowPlaying: v } })} />
        <Toggle label="Going live" hint="Post when someone starts casting." checked={s.notify.goLive} onChange={(v) => setS({ ...s, notify: { ...s.notify, goLive: v } })} />
        <Toggle label="New posts" hint="Post a digest of new posts." checked={s.notify.posts} onChange={(v) => setS({ ...s, notify: { ...s.notify, posts: v } })} />
      </section>

      <div className={`savebar${dirty ? " is-dirty" : ""}`}>
        <span>{dirty ? "Unsaved changes" : "All changes saved"}</span>
        <button className="btn btn-quiet btn-s" disabled={!dirty || saving} onClick={() => setS(saved.data)}>Discard</button>
        <button className="btn btn-primary btn-s" disabled={!dirty || saving || !channelValid} onClick={save}>{saving ? "Saving…" : "Save changes"}</button>
      </div>
    </div>
  );
}
