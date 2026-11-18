import { useEffect, useState } from "react";
import { api } from "./api";
import { getSocket } from "./socket";

export interface SiteInfo {
  sections: { player: boolean; cast: boolean };
  lockdown: boolean;
  hideVideoInMusic: boolean;
  cameras: boolean;
}

let cached: SiteInfo | null = null;

/** Site-wide settings that change what every viewer sees; refreshed when an admin changes them. */
export function useSite(): SiteInfo | null {
  const [site, setSite] = useState<SiteInfo | null>(cached);
  useEffect(() => {
    const load = () => api<SiteInfo>("GET", "/api/site").then((s) => setSite((cached = s))).catch(() => {});
    void load();
    const s = getSocket();
    s.on("site:changed", load);
    return () => {
      s.off("site:changed", load);
    };
  }, []);
  return site;
}
