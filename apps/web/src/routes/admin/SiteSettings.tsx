import { useState } from "react";
import { Send } from "lucide-react";
import type { DiscordChannel, SiteSettings as Settings } from "@friends/shared";
import { LoadError, Loading, PageHead, Toggle, useConfirm } from "../../components/settings/ui";
import { api, ApiError } from "../../lib/api";
import { errorText } from "../../lib/format";
import { useToast } from "../../lib/toast";
import { useLoad } from "./useLoad";

/** Site settings. Each change saves on its own; changes that interrupt everyone ask first. */
export function SiteSettings() {
  const saved = useLoad(() => api<Settings>("GET", "/api/admin/settings"));
  const channels = useLoad(() => api<DiscordChannel[]>("GET", "/api/admin/discord/channels"));
  const toast = useToast();
  const [ask, dialog] = useConfirm();
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [manualId, setManualId] = useState<string | null>(null);

  const s = saved.data;
  if (!s) {
    return (
      <div className="pane">
        <PageHead title="Site" />
        {saved.error ? <LoadError text={saved.error} onRetry={saved.reload} /> : <Loading rows={4} />}
      </div>
    );
  }

  async function update(next: Settings, ok = "Saved.") {
    setBusy(true);
    try {
      saved.setData(await api<Settings>("PUT", "/api/admin/settings", next));
      toast(ok);
      return true;
    } catch (e) {
      toast(errorText(e), { kind: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function setSection(key: "player" | "cast", on: boolean) {
    if (!on) {
      const body = key === "player" ? "Playback stops for everyone and the player is hidden until you turn it back on." : "Every live stream ends and no one can go live until you turn it back on.";
      if ((await ask({ title: `Turn off ${key === "player" ? "the player" : "Cast"}?`, body, confirm: "Turn off", danger: true })) === null) return;
    }
    await update({ ...s!, sections: { ...s!.sections, [key]: on } }, `${key === "player" ? "Player" : "Cast"} is ${on ? "on" : "off"}.`);
  }

  const notify = (patch: Partial<Settings["notify"]>, ok?: string) => update({ ...s, notify: { ...s.notify, ...patch } }, ok);

  async function sendTest() {
    if (!s?.notify.channelId) return;
    setTesting(true);
    try {
      await api("POST", "/api/admin/discord/test", { channelId: s.notify.channelId });
      toast("Test message sent. Check the channel in Discord.");
    } catch (e) {
      toast(errorText(e), { kind: "error" });
    } finally {
      setTesting(false);
    }
  }

  const botOffline = channels.error !== null;
  const list = channels.data ?? [];
  const current = s.notify.channelId;
  const unknownCurrent = current && channels.data && !list.some((c) => c.id === current);
  const manualValid = manualId !== null && /^\d{15,22}$/.test(manualId.trim());
  const byCategory = list.reduce<Record<string, DiscordChannel[]>>((acc, c) => ((acc[c.category ?? ""] ??= []).push(c), acc), {});

  return (
    <div className="pane">
      <PageHead title="Site" note="Changes save as you make them and apply to everyone right away." />

      <section className="panel" aria-labelledby="sections-title">
        <h2 id="sections-title">Sections</h2>
        <Toggle label="Player" hint="Music and video for everyone. Turning it off stops playback." checked={s.sections.player} disabled={busy}
          onChange={(v) => void setSection("player", v)} />
        <Toggle label="Cast" hint="Screen and game sharing. Turning it off ends every live stream." checked={s.sections.cast} disabled={busy}
          onChange={(v) => void setSection("cast", v)} />
      </section>

      <section className="panel" aria-labelledby="player-title">
        <h2 id="player-title">Player</h2>
        <Toggle label="Hide the YouTube player in music view"
          hint="Shows only the visualizer, lyrics or artwork while audio keeps playing. YouTube’s API terms require the player to stay visible, so turn this off if Google flags the API key."
          checked={s.hideVideoInMusic} disabled={busy} onChange={(v) => void update({ ...s, hideVideoInMusic: v })} />
      </section>

      <section className="panel" aria-labelledby="notify-title">
        <h2 id="notify-title">Discord notifications</h2>
        <div className="field">
          <span id="channel-label">Channel</span>
          {!botOffline && manualId === null ? (
            channels.data ? (
              <div className="channel-pick">
                <select className="select grow" aria-labelledby="channel-label" value={current ?? ""} disabled={busy}
                  onChange={(e) => void notify({ channelId: e.target.value || null }, e.target.value ? "Channel saved." : "Notifications turned off.")}>
                  <option value="">None (don’t post)</option>
                  {unknownCurrent && <option value={current}>Unknown channel ({current})</option>}
                  {Object.entries(byCategory).map(([cat, chans]) => (
                    cat ? <optgroup key={cat} label={cat}>{chans.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}</optgroup>
                      : chans.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)
                  ))}
                </select>
                <button className="btn btn-quiet btn-s" disabled={!current || testing} onClick={() => void sendTest()}><Send aria-hidden />{testing ? "Sending…" : "Send test"}</button>
              </div>
            ) : <Loading rows={1} />
          ) : (
            <form className="channel-pick" onSubmit={(e) => {
              e.preventDefault();
              if (manualValid) void notify({ channelId: manualId!.trim() }, "Channel saved.").then((ok) => ok && !botOffline && setManualId(null));
            }}>
              <input className="input grow" inputMode="numeric" aria-labelledby="channel-label" placeholder="Channel ID"
                value={manualId ?? current ?? ""} aria-invalid={manualId !== null && manualId !== "" && !manualValid}
                onChange={(e) => setManualId(e.target.value)} />
              <button className="btn btn-quiet btn-s" disabled={!manualValid || busy}>Save</button>
            </form>
          )}
          {botOffline && (
            <span className="quiet field-note">
              {channels.error && (channels.error === errorText(new ApiError(503, "bot_offline")))
                ? "The bot is offline, so channels can’t be listed. Enter a channel ID instead."
                : "Channels couldn’t be loaded. Enter a channel ID instead."}
            </span>
          )}
          {!botOffline && manualId === null && channels.data && (
            <span className="quiet field-note">Only channels the bot can post in are listed. <button className="text-link" onClick={() => setManualId(current ?? "")}>Enter an ID instead</button></span>
          )}
        </div>
        <Toggle label="Access requests" hint="When someone asks to join." checked={s.notify.accessRequests} disabled={busy} onChange={(v) => void notify({ accessRequests: v })} />
        <Toggle label="Now playing" hint="When music or a video starts after 30 minutes of nothing playing." checked={s.notify.nowPlaying} disabled={busy} onChange={(v) => void notify({ nowPlaying: v })} />
        <Toggle label="Going live" hint="When someone starts casting." checked={s.notify.goLive} disabled={busy} onChange={(v) => void notify({ goLive: v })} />
        <Toggle label="New posts" hint="A digest of new posts, at most every 10 minutes." checked={s.notify.posts} disabled={busy} onChange={(v) => void notify({ posts: v })} />
      </section>
      {dialog}
    </div>
  );
}
