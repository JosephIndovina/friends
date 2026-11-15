import { useEffect, useState } from "react";
import type { PresenceEntry, Section } from "@friends/shared";
import { getSocket } from "./socket";

export function usePresence(): PresenceEntry[] {
  const [entries, setEntries] = useState<PresenceEntry[]>([]);
  useEffect(() => {
    const s = getSocket();
    s.on("presence:list", setEntries);
    return () => {
      s.off("presence:list", setEntries);
    };
  }, []);
  return entries;
}

export function reportSection(section: Section) {
  const s = getSocket();
  if (s.connected) s.emit("presence:section", section);
  else s.once("connect", () => s.emit("presence:section", section));
}

export const whereLabel: Record<Section, string> = {
  home: "Hanging out",
  music: "In Music",
  media: "In Media",
  cast: "In Cast",
  settings: "In Settings",
  admin: "In Admin",
};
