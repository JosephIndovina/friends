import { useEffect, useState } from "react";
import type { Activity, PresenceEntry, Section } from "@friends/shared";
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

function whenConnected(fn: () => void) {
  const s = getSocket();
  if (s.connected) fn();
  s.on("connect", fn);
  return () => s.off("connect", fn);
}

let lastSection: Section = "home";
let lastActivity: Activity = "idle";

export function reportSection(section: Section) {
  lastSection = section;
  getSocket().connected && getSocket().emit("presence:section", section);
}

export function reportActivity(activity: Activity) {
  lastActivity = activity;
  getSocket().connected && getSocket().emit("presence:activity", activity);
}

// Re-send on every (re)connect so the server's view survives reconnects.
whenConnected(() => {
  getSocket().emit("presence:section", lastSection);
  getSocket().emit("presence:activity", lastActivity);
});
