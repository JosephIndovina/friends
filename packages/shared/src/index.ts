// Types shared by server and web. Type-only except the permission catalog.

export type Section = "home" | "cast" | "settings" | "admin";

/** What someone is doing right now, shown as the ring on their avatar. */
export type Activity = "watching" | "listening" | "casting" | "idle";

export const PERMISSIONS = {
  "player.queue": "Add to the queue",
  "player.control": "Play, pause, skip, seek and reorder",
  "cast.watch": "Watch cast streams",
  "cast.stream": "Go live",
  "posts.create": "Post to the stream",
  "posts.moderate": "Delete anyone's posts",
  "playback.moderate": "Clear or lock queues, end someone's stream",
  "admin.people": "Approve, suspend and assign roles",
  "admin.roles": "Edit roles and permissions",
  "admin.audit": "Read the audit log",
  "admin.settings": "Change site settings",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export type UserStatus = "pending" | "active" | "suspended" | "banned" | "left";

export interface Me {
  id: string;
  name: string;
  avatarUrl: string;
}

export interface Session {
  user: Me;
  status: UserStatus;
  role: { id: string; name: string } | null;
  permissions: Permission[];
  isOwner: boolean;
}

export interface Role {
  id: string;
  name: string;
  permissions: Permission[];
  builtin: boolean;
  /** lower = more senior; owner is 0 */
  position: number;
  memberCount: number;
}

export interface AdminUser extends Me {
  status: UserStatus;
  statusReason: string | null;
  roleId: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  activeSessions: number;
  isOwner: boolean;
}

export interface AuditEntry {
  id: number;
  at: number;
  actor: { id: string; name: string } | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetName: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
}

export interface SiteSettings {
  lockdown: boolean;
  sections: { player: boolean; cast: boolean };
  notify: { channelId: string | null; accessRequests: boolean; nowPlaying: boolean; goLive: boolean; posts: boolean };
}

export interface PresenceEntry extends Me {
  section: Section;
  activity: Activity;
  /** epoch ms of the last section change */
  since: number;
}

// ---------- media (synced YouTube / Twitch) ----------

/** "spotify" items wait in the queue until just before they play, then become a matched YouTube video. */
export type MediaKind = "youtube" | "twitch-vod" | "twitch-clip" | "twitch-live" | "spotify";

/** How the player presents an item: full video, or artwork + visualizer for music. */
export type MediaMode = "video" | "music";

export interface MediaItem {
  id: string;
  kind: MediaKind;
  mode: MediaMode;
  /** YouTube video id, Twitch VOD id, clip slug or channel login */
  ref: string;
  title: string;
  /** channel / uploader name */
  author: string | null;
  thumbnail: string | null;
  /** seconds; null until known (live channels never have one) */
  duration: number | null;
  /** seconds to start from (e.g. a ?t= in the pasted link) */
  startAt: number;
  addedBy: { id: string; name: string };
  addedAt: number;
  /** the Spotify track this item was matched from */
  spotifyId?: string;
}

export interface Playback {
  item: MediaItem;
  playing: boolean;
  /** position in seconds at `updatedAt` */
  position: number;
  /** server epoch ms */
  updatedAt: number;
  startedBy: { id: string; name: string };
}

export interface MediaState {
  now: Playback | null;
  queue: MediaItem[];
  /** most recent first */
  history: Array<MediaItem & { playedAt: number }>;
}

export interface YouTubeResult {
  id: string;
  title: string;
  author: string;
  thumbnail: string | null;
  duration: number | null;
  live: boolean;
  music: boolean;
}

/** Kinds whose position can be synced (live channels and clips can't be seeked by the embed). */
export const SEEKABLE: Record<MediaKind, boolean> = { youtube: true, "twitch-vod": true, "twitch-clip": false, "twitch-live": false, spotify: true };

export type Ack = (res: { ok: true } | { ok: false; error: string }) => void;

export interface ServerToClient {
  "presence:list": (entries: PresenceEntry[]) => void;
  /** your role, status or permissions changed: refetch /api/me */
  "session:changed": () => void;
  "media:state": (state: MediaState) => void;
}

export interface ClientToServer {
  "presence:section": (section: Section) => void;
  "presence:activity": (activity: Activity) => void;
  /** clock sync: replies with server epoch ms */
  "time:ping": (ack: (serverNow: number) => void) => void;
  "media:subscribe": () => void;
  /** `whole`: for a YouTube link with both a video and a playlist, queue the whole playlist */
  "media:add": (input: { url: string; playNext?: boolean; whole?: boolean }, ack: Ack) => void;
  "media:play": (ack: Ack) => void;
  "media:pause": (input: { position: number }, ack: Ack) => void;
  "media:seek": (input: { position: number }, ack: Ack) => void;
  "media:skip": (ack: Ack) => void;
  "media:playNow": (input: { id: string }, ack: Ack) => void;
  "media:replay": (input: { id: string }, ack: Ack) => void;
  "media:remove": (input: { id: string }, ack: Ack) => void;
  "media:move": (input: { id: string; to: number }, ack: Ack) => void;
  "media:clear": (ack: Ack) => void;
  "media:setMode": (input: { id: string; mode: MediaMode }, ack: Ack) => void;
  /** a client's player reached the end of `itemId` */
  "media:ended": (input: { itemId: string }) => void;
  /** a client's player learned the duration of `itemId` */
  "media:duration": (input: { itemId: string; duration: number }) => void;
}

// ---------- music ----------

export interface Lyrics {
  /** null = no lyrics found */
  lines: Array<{ t: number; text: string }> | null;
  plain: string | null;
  instrumental: boolean;
  artist: string;
  track: string;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  owner: { id: string; name: string };
  count: number;
  updatedAt: number;
  cover: string | null;
}

export interface Playlist extends PlaylistSummary {
  items: MediaItem[];
}
