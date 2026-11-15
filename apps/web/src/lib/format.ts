const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const steps: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536e6], ["month", 2592e6], ["week", 6048e5], ["day", 864e5], ["hour", 36e5], ["minute", 6e4]];

export function ago(ms: number | null | undefined): string {
  if (!ms) return "Never";
  const diff = ms - Date.now();
  for (const [unit, size] of steps) if (Math.abs(diff) >= size) return rtf.format(Math.round(diff / size), unit);
  return "Just now";
}

export const dateTime = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(ms);

export function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) (n /= 1024), i++;
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "auth.denied": "Sign-in denied",
  "access.requested": "Requested access",
  "access.approved": "Approved access",
  "access.denied": "Denied access",
  "access.forbidden": "Blocked action",
  "user.role_changed": "Changed role",
  "user.suspended": "Suspended",
  "user.banned": "Banned",
  "user.reinstated": "Reinstated",
  "user.signed_out": "Signed out everywhere",
  "user.preapproved": "Pre-approved",
  "user.left_server": "Left the Discord server",
  "user.rejoined": "Rejoined",
  "role.created": "Created role",
  "role.updated": "Edited role",
  "role.deleted": "Deleted role",
  "settings.updated": "Changed settings",
  "site.lockdown_on": "Turned lockdown on",
  "site.lockdown_off": "Turned lockdown off",
  "audit.exported": "Exported audit log",
  "backup.downloaded": "Downloaded a backup",
  "media.added": "Queued video",
  "media.added_playlist": "Queued playlist",
  "media.searched": "Searched YouTube",
  "media.mode_changed": "Changed view",
  "media.unmatched": "No YouTube match",
  "cast.started": "Went live",
  "cast.ended": "Stopped streaming",
  "cast.stopped": "Ended someone’s stream",
  "cast.removed": "Removed from the stage",
  "post.created": "Posted",
  "post.deleted": "Deleted post",
  "playlist.created": "Created playlist",
  "playlist.renamed": "Renamed playlist",
  "playlist.deleted": "Deleted playlist",
  "playlist.item_added": "Saved to playlist",
  "playlist.item_removed": "Removed from playlist",
  "playlist.queued": "Queued playlist",
  "media.played": "Played",
  "media.paused": "Paused",
  "media.seeked": "Seeked",
  "media.skipped": "Skipped",
  "media.play_now": "Played now",
  "media.removed": "Removed from queue",
  "media.moved": "Reordered queue",
  "media.cleared": "Cleared queue",
};
export const actionLabel = (a: string) => ACTION_LABELS[a] ?? a;

export const ERROR_TEXT: Record<string, string> = {
  cannot_manage_self: "You can’t change your own access.",
  cannot_manage_owner: "The owner can’t be changed.",
  target_outranks_you: "They’re ranked the same as or above you.",
  role_outranks_you: "That role is ranked the same as or above yours.",
  owner_not_assignable: "The owner role can’t be given out.",
  cannot_grant_permissions_you_lack: "You can’t grant permissions you don’t have yourself.",
  role_name_taken: "A role with that name already exists.",
  builtin_role: "Built-in roles can’t be deleted.",
  already_known: "That person has already signed in. Change their access in the list instead.",
  not_pending: "They’re no longer waiting for approval.",
  missing_permission: "You don’t have permission to do that.",
  invalid_body: "Something in the form isn’t valid.",
  bad_origin: "That request was blocked. Reload the page and try again.",
};
export const errorText = (e: unknown) =>
  (e as { code?: string })?.code ? (ERROR_TEXT[(e as { code: string }).code] ?? "Something went wrong. Try again.") : "Something went wrong. Try again.";
