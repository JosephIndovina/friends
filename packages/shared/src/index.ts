// Types shared by server and web. Type-only: nothing here exists at runtime.

export type Section = "home" | "music" | "media" | "cast" | "settings";

export interface Me {
  id: string;
  name: string;
  avatarUrl: string;
}

export interface PresenceEntry extends Me {
  section: Section;
  /** epoch ms of the last section change */
  since: number;
}

export interface ServerToClient {
  "presence:list": (entries: PresenceEntry[]) => void;
}

export interface ClientToServer {
  "presence:section": (section: Section) => void;
}
