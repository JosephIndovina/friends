import type { SiteSettings } from "@friends/shared";
import { db } from "./db.js";
import { env } from "./env.js";

const defaults = (): SiteSettings => ({
  lockdown: false,
  sections: { music: true, media: true, cast: true },
  notify: { channelId: env.DISCORD_NOTIFY_CHANNEL_ID ?? null, accessRequests: true, nowPlaying: true, goLive: true, posts: false },
});

export function getSettings(): SiteSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'site'").get() as { value: string } | undefined;
  const d = defaults();
  if (!row) return d;
  const saved = JSON.parse(row.value) as Partial<SiteSettings>;
  return { ...d, ...saved, sections: { ...d.sections, ...saved.sections }, notify: { ...d.notify, ...saved.notify } };
}

export function saveSettings(next: SiteSettings) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('site', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    JSON.stringify(next),
  );
}
