// Types shared by server and web. Type-only except the permission catalog.

export type Section = "home" | "music" | "media" | "cast" | "settings" | "admin";

export const PERMISSIONS = {
  "music.queue": "Add to the music queue",
  "music.control": "Play, pause, skip and seek music",
  "media.queue": "Add videos to the watch queue",
  "media.control": "Play, pause, skip and seek videos",
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
  sections: { music: boolean; media: boolean; cast: boolean };
  notify: { channelId: string | null; accessRequests: boolean; nowPlaying: boolean; goLive: boolean; posts: boolean };
}

export interface PresenceEntry extends Me {
  section: Section;
  /** epoch ms of the last section change */
  since: number;
}

export interface ServerToClient {
  "presence:list": (entries: PresenceEntry[]) => void;
  /** your role, status or permissions changed: refetch /api/me */
  "session:changed": () => void;
}

export interface ClientToServer {
  "presence:section": (section: Section) => void;
}
