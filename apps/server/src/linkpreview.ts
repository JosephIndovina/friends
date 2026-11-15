import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { LinkPreview } from "@friends/shared";
import { fetchMeta, parseLink } from "./links.js";
import { parseSpotify, spotifyEnabled, spotifyTracks } from "./spotify.js";
import { youtubeListId } from "./youtube.js";

/**
 * Link previews for posts. The server fetches arbitrary URLs here, so requests to anything that
 * resolves to a private, loopback or link-local address are refused (re-checked on every redirect).
 * Note: a DNS answer could change between our check and the fetch; this guards the realistic case.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
// No "::ffff:0:0/96" rule: Node applies it to every IPv4 address. Mapped addresses are unwrapped below instead.
for (const [net, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

async function safeHost(host: string): Promise<boolean> {
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
  return (
    addrs.length > 0 &&
    addrs.every((a) => {
      const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a.address)?.[1];
      if (mapped) return !blocked.check(mapped, "ipv4");
      return !blocked.check(a.address, a.family === 6 ? "ipv6" : "ipv4");
    })
  );
}

const MAX_BYTES = 512 * 1024;

async function fetchHtml(start: string): Promise<{ url: string; html: string } | null> {
  let url = start;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol) || (u.port && !["80", "443"].includes(u.port))) return null;
    if (!(await safeHost(u.hostname))) return null;
    const res = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; friends-link-preview/1.0)", Accept: "text/html" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, u).toString();
      continue;
    }
    if (!res.ok || !res.headers.get("content-type")?.includes("text/html") || !res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    void reader.cancel().catch(() => {});
    return { url, html: Buffer.concat(chunks).toString("utf8") };
  }
  return null;
}

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

function meta(html: string, key: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i");
  const tag = re.exec(html)?.[0];
  const content = tag && /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return content ? decode(content).trim().slice(0, 300) || null : null;
}

export const firstUrl = (text: string) => /https?:\/\/[^\s<>"']+/i.exec(text)?.[0]?.replace(/[),.!?]+$/, "") ?? null;

export async function preview(url: string): Promise<LinkPreview | null> {
  try {
    // Playable links get their preview from the same metadata the player uses.
    const sp = parseSpotify(url);
    if (sp && spotifyEnabled()) {
      const r = await spotifyTracks(sp, 1);
      const t = r.items[0];
      return { url, title: sp.type === "track" ? (t?.title ?? r.title) : r.title, description: sp.type === "track" ? t?.author ?? null : `Spotify ${sp.type}`, image: t?.thumbnail ?? null, site: "Spotify", playable: true };
    }
    const link = parseLink(url);
    if (link) {
      const m = await fetchMeta(link);
      if (m) return { url, title: m.title, description: m.author, image: m.thumbnail, site: link.kind === "youtube" ? "YouTube" : "Twitch", playable: true };
    }
    if (youtubeListId(url)) return { url, title: "YouTube playlist", description: null, image: null, site: "YouTube", playable: true };

    const page = await fetchHtml(url);
    if (!page) return null;
    const title = meta(page.html, "og:title") ?? meta(page.html, "twitter:title") ?? (decode(/<title[^>]*>([^<]{1,300})<\/title>/i.exec(page.html)?.[1] ?? "").trim() || null);
    if (!title) return null;
    let image = meta(page.html, "og:image") ?? meta(page.html, "twitter:image");
    if (image) {
      try {
        image = new URL(image, page.url).toString();
        if (!image.startsWith("https://")) image = null; // avoid mixed content
      } catch {
        image = null;
      }
    }
    return {
      url,
      title,
      description: meta(page.html, "og:description") ?? meta(page.html, "description"),
      image,
      site: meta(page.html, "og:site_name") ?? new URL(page.url).hostname.replace(/^www\./, ""),
      playable: false,
    };
  } catch {
    return null;
  }
}
