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
  "sounds.play": "Play soundboard sounds",
  "sounds.add": "Add sounds to the soundboard",
  "tts.speak": "Say things out loud with text to speech",
  "playback.moderate": "Clear or lock queues, end someone's stream, delete anyone's sounds",
  "admin.people": "Approve, suspend and assign roles",
  "admin.roles": "Edit roles and permissions",
  "admin.audit": "Read the audit log",
  "admin.settings": "Change site settings",
} as const;

export type Permission = keyof typeof PERMISSIONS;
/** How long audit entries are kept. */
export const AUDIT_RETENTION_DAYS = 365;
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
  /** hide the YouTube player in music view (against YouTube's API terms; admin's call) */
  hideVideoInMusic: boolean;
  /** people who can stream can also turn on a camera */
  cameras: boolean;
  sections: { player: boolean; cast: boolean };
  /** which Friends Live installers the site offers; one turned off isn't listed or served */
  downloads: { windows: boolean; linux: boolean; arch: boolean };
  notify: { channelId: string | null; accessRequests: boolean; nowPlaying: boolean; goLive: boolean; posts: boolean };
}

/** A Discord text channel the bot can post in. */
export interface DiscordChannel {
  id: string;
  name: string;
  category: string | null;
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
  /** videos and streams watched alongside the player, each synced on its own; no queue */
  screens: Playback[];
}

/** How many screens can be open alongside the player. */
export const SCREENS_MAX = 4;

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
  /** site settings that affect every viewer changed: refetch /api/site */
  "site:changed": () => void;
  /** a post was created, updated (preview, reactions) or deleted; refetch it by id */
  "posts:changed": (input: { id: string; deleted?: boolean }) => void;
  /** admins only: something that needs attention changed (access requests); refetch counts */
  "admin:attention": () => void;
  /** someone else (a moderator) ended one of your streams; `app` when it was streaming from Friends Live */
  "cast:ended": (input: { by: string; app: boolean }) => void;
  /** someone started or stopped something everyone sees (the player, a screen, a stream); shown to everyone else */
  notice: (input: { by: string; text: string }) => void;
  /** someone played a soundboard sound (not sent back to the tab that played it) */
  "sound:played": (input: { id: string; by: { id: string; name: string } }) => void;
  /** a sound was added or deleted: refetch /api/sounds */
  "sounds:changed": () => void;
  /** someone said something with text to speech (sent to everyone, them included) */
  "tts:spoken": (input: TtsSpoken) => void;
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
  "media:stop": (input: { id: string }, ack: Ack) => void;
  "media:playNow": (input: { id: string }, ack: Ack) => void;
  "media:replay": (input: { id: string }, ack: Ack) => void;
  "media:remove": (input: { id: string }, ack: Ack) => void;
  "media:move": (input: { id: string; to: number }, ack: Ack) => void;
  "media:clear": (ack: Ack) => void;
  /** watch a single video or stream alongside the player */
  "media:screen:add": (input: { url: string }, ack: Ack) => void;
  "media:screen:play": (input: { id: string }, ack: Ack) => void;
  "media:screen:pause": (input: { id: string }, ack: Ack) => void;
  "media:screen:seek": (input: { id: string; position: number }, ack: Ack) => void;
  "media:screen:close": (input: { id: string }, ack: Ack) => void;
  /** a client's player reached the end of `itemId` (the player's item or a screen's) */
  "media:ended": (input: { itemId: string }) => void;
  /** a client's player learned the duration of `itemId` */
  "media:duration": (input: { itemId: string; duration: number }) => void;
  /** play a soundboard sound for everyone */
  "sound:play": (input: { id: string }, ack: Ack) => void;
}

// ---------- soundboard ----------

export interface Sound {
  id: string;
  name: string;
  /** shown on the button and over the player's avatar; null = the name only */
  emoji: string | null;
  url: string;
  /** seconds */
  duration: number;
  addedBy: { id: string; name: string };
  createdAt: number;
}

export const SOUND_LIMITS = {
  bytes: 50 * 1024 * 1024,
  seconds: 60,
  name: 32,
  total: 100,
  perPerson: 20,
} as const;

// ---------- text to speech ----------

export const TTS_LIMITS = { chars: 200 } as const;

/**
 * Kokoro's voices. The id's first letter is the accent, the second f/m. Everything is read as English:
 * the non-English voices speak it with their accent.
 */
const ACCENTS: Record<string, string> = {
  a: "US", b: "UK", e: "Spanish", f: "French", i: "Italian", h: "Hindi", p: "Brazilian Portuguese", j: "Japanese", z: "Chinese",
};
export const TTS_VOICES = [
  ["af_heart", "Heart"], ["af_bella", "Bella"], ["af_nicole", "Nicole"], ["af_sarah", "Sarah"],
  ["am_michael", "Michael"], ["am_fenrir", "Fenrir"], ["am_puck", "Puck"], ["am_echo", "Echo"], ["am_eric", "Eric"],
  ["am_liam", "Liam"], ["am_onyx", "Onyx"], ["am_santa", "Santa"], ["am_adam", "Adam"],
  ["bf_emma", "Emma"], ["bf_isabella", "Isabella"], ["bf_alice", "Alice"], ["bf_lily", "Lily"],
  ["bm_george", "George"], ["bm_fable", "Fable"], ["bm_lewis", "Lewis"], ["bm_daniel", "Daniel"],
  ["ef_dora", "Dora"], ["em_alex", "Alex"],
  ["ff_siwis", "Siwis"],
  ["if_sara", "Sara"], ["im_nicola", "Nicola"],
  ["hf_alpha", "Alpha"], ["hm_omega", "Omega"],
  ["pf_dora", "Dora"], ["pm_alex", "Alex"],
  ["jf_alpha", "Alpha"], ["jm_kumo", "Kumo"],
  ["zf_xiaoxiao", "Xiaoxiao"], ["zm_yunxi", "Yunxi"],
].map(([id, name]) => {
  const accent = ACCENTS[id![0]!]!;
  return { id: id!, accent, label: `${name} (${accent}, ${id![1] === "f" ? "female" : "male"})` };
});
export const TTS_DEFAULT_VOICE = "af_heart";

export interface TtsSpoken {
  url: string;
  /** what was said, after links and emoji were taken out */
  text: string;
  voice: string;
  by: { id: string; name: string; avatarUrl: string };
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

// ---------- posts ----------

export const REACTIONS = ["👍", "😂", "❤️", "🔥", "😮", "😢"] as const;
export type Reaction = (typeof REACTIONS)[number];

export interface PostMedia {
  id: string;
  kind: "image" | "video";
  url: string;
  mime: string;
}

export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  site: string | null;
  /** the link can be queued in the player (YouTube, Spotify, Twitch) */
  playable: boolean;
}

export interface Post {
  id: string;
  author: Me;
  text: string;
  media: PostMedia[];
  preview: LinkPreview | null;
  reactions: Array<{ emoji: string; count: number; mine: boolean; names: string[] }>;
  createdAt: number;
}

/* ---------- system metrics (admin) ---------- */

/**
 * One point on a metrics chart. Rates are per second (bytes, requests); gauges are as sampled.
 * `a` is the average over the point's span and `m` the peak; a raw 10-second sample has a === m.
 * A key is missing when it wasn't measured (e.g. LiveKit unreachable).
 */
export interface MetricPoint {
  t: number;
  a: Partial<Record<MetricKey, number>>;
  m: Partial<Record<MetricKey, number>>;
}

export type MetricKey =
  // app process and container
  | "cpu" | "mem" | "lag" | "rx" | "tx"
  // HTTP: requests/s, 5xx/s, mean response ms, bytes/s served by type
  | "req" | "err" | "ms" | "webB" | "apiB" | "uploadsB" | "soundsB" | "downloadsB"
  // realtime and Discord
  | "sockets" | "online" | "ping"
  // LiveKit (Cast): bytes/s, retransmitted bytes/s out, loss %, rtt ms, jitter ms, participants, cpu %, memory
  | "lkRx" | "lkTx" | "lkRetx" | "lkLoss" | "lkRtt" | "lkJitter" | "lkPeople" | "lkCpu" | "lkMem";

export type MetricRange = "1h" | "24h" | "7d" | "30d";

export interface MetricsResponse {
  range: MetricRange;
  /** Seconds each point covers. */
  step: number;
  points: MetricPoint[];
  /** The latest 10-second sample. */
  now: MetricPoint | null;
  cores: number;
  memLimit: number | null;
  livekit: { configured: boolean; error: string | null };
  storage: { db: number; uploads: number; sounds: number; free: number | null; total: number | null };
}
