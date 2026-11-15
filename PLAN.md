# OSW Companion — Plan (draft)

A self-hosted companion web app for our Discord server. The Discord bot posts announcements and links to the site.
Everything else happens on the site: music, synced YouTube, casting, and sharing.

## Decisions so far
- **Surface:** standalone web app. Discord OAuth login, restricted to members of our server.
- **Bot role:** posts notifications and links, plus lightweight slash commands. It does not play audio in voice.
- **Model:** no rooms. One shared space per section. Anyone can control playback at any time.
- **Nav (revised again 2026-11-14):** Home · Settings (+ Admin). There is no Cast page: casting is a Go live action on Home, and streams are stage sources. Home holds the single shared player: one mixed queue, and each item shows in **video view** or **music view** (artwork, title, a small YouTube player, and later the visualizer and lyrics). The default mode comes from YouTube's Music category or a "- Topic" channel, and Spotify links count as music. Each viewer can switch music/video view for themselves; the choice is saved per track on their device and never changes anyone else's view. The player persists across pages (docked mini player off Home). **Here now** presence shows on every page: a top-bar avatar stack with activity rings (watching / listening / casting / online).
- **Look:** "Couch Glow", chosen with the impeccable skills (re-roll round 1). The page is a dark living room lit by whatever is playing. Light mode: "lights on". The full contract is in `.impeccable/surfaces/apps-web-src-routes-index-tsx.md`.
- **Hosting:** the user's TrueNAS SCALE NAS (Docker apps). GitHub repo JosephIndovina/friends; CI publishes to GHCR (private).
- **Stack:** TypeScript end to end.

## Architecture
```
apps/web     React + Vite + TanStack Router, CSS-variable design tokens (light/dark)
apps/server  Fastify + Socket.IO (sync, presence, chat), Discord OAuth, REST API
             └─ discord.js bot runs in-process (notifications + slash commands)
packages/shared  types, sync protocol, zod schemas
db           SQLite + Drizzle (single file, easy backups)
uploads      local disk volume (images/GIFs/clips)
livekit      self-hosted LiveKit SFU for Cast (server mints join tokens)
cloudflared  Cloudflare Tunnel for friends.indovina.dev (web + sync); no inbound web ports
ddns         keeps rtc.indovina.dev (DNS-only) on the home IP for LiveKit media
```
- **Why React and not SvelteKit:** LiveKit ships good React components, and a long-running WebSocket sync server fits better as its own Fastify service than inside a meta-framework.

### Sync engine (shared by Music and Media)
- **Server-authoritative state:** `{ item, playing, positionAt, serverTime, rate }`.
- **Clock alignment:** clients estimate the offset from the server clock with ping round-trips, then compute the expected playback position.
- **Drift correction:** under ~0.3s, nudge `playbackRate`; over ~1s, hard seek. Late joiners snap to the live position.
- **Buffering:** a "who's buffering" indicator. Optionally, a soft pause when someone stalls.
- **Playback:** the YouTube IFrame Player API for both sections.

### Constraints to know
- **Twitch:** uses the Twitch Embed / Player JS API.
  - **VODs and clips** sync like YouTube: play, pause and seek.
  - **Live channels** can't be time-synced. Everyone watches the same live edge, and the app syncs only which channel is on, plus play/pause.
  - The embed needs a `parent=<our domain>` parameter and HTTPS, so a real domain is required.
  - Optional: show "live now" for channels the group follows, using Twitch Helix with an app token.
- **YouTube player visibility:** the YouTube API ToS forbids hiding the player or separating its audio. The Music page shows the YouTube player as its "artwork" panel, at least 200×200, and the global mini-player keeps a small visible player.
- **YouTube search quota:** search costs 100 units of a 10k/day quota, which works out to about 100 searches a day. Mitigations: cache results, resolve pasted links for free, and request a quota increase if needed.
- **Spotify links:** read the track or playlist details with the Spotify Web API (client credentials), then match each track to a YouTube video.
- **Cast:** uses browser `getDisplayMedia`. System and game audio capture works in Chrome or Edge on Windows. On macOS and Linux it is limited (tab audio only). LiveKit needs UDP ports reachable, or TURN. A Cloudflare Tunnel alone will not carry the WebRTC media.

## Pages
- **Dashboard:**
  - Activity feed, plus a chat-style stream of posts (text, images, GIFs, links with previews).
  - Live widgets: what's playing in Music and Media, who's casting.
  - Presence: who's on the site and which section they're in.
- **Music:**
  - Now playing, with synced lyrics later.
  - Shared queue: drag to reorder, see who added each track.
  - Search, paste a link (YouTube or Spotify), saved playlists, history.
  - **Visualizer (on/off toggle):** classic Windows Media Player-style presets (bars, scope, ambience, battery-style swirls) on a canvas or WebGL, drawn in the Couch Glow palette.
    - **The constraint:** the YouTube player runs in a cross-origin iframe, so its audio can't be fed to the Web Audio API.
    - **Default mode:** a procedural visualizer driven by the synced playback clock, seeded per track, so everyone sees the same thing.
    - **Opt-in "react to real audio" mode:** captures this tab's audio with `getDisplayMedia` (works in Chromium, with a one-click browser prompt) and drives a live analyser.
    - YouTube's rules say the visualizer must not cover the player, so the video panel stays visible (at least 200×200) beside or inset in the visualizer stage.
- **Media:**
  - Synced YouTube player with its own queue. Twitch items can be queued alongside YouTube.
  - Reactions and timestamped comments.
  - Watch history.
- **Cast lives on Home's stage (revised 2026-11-14):** the shared player and every cast stream are *sources* on one stage. Each viewer focuses one source large, keeps the others as thumbnails, and can hide any source (hidden = not loaded and not heard). Audio: every visible source is audible, each with its own per-viewer mute. The stage framework, Sources menu and thumbnail strip are built now; streams join as sources in Phase 4. The YouTube player's thumbnail stays at least 356×200 (YouTube's minimum player size).
- **Cast:**
  - **Per-viewer stream toggles:** each viewer turns individual people's streams on or off. Off means not subscribed at all, so no bandwidth is used. Pinning and resizing tiles are client-side only, saved per device.
  - Multiple streams at once is a core requirement. Several people can go live at the same time, and one person can share more than one source (for example a game plus a second monitor).
  - Layout: a grid of live streams that adapts to how many there are, a "Go live" button, and click a stream to focus it (focus mode keeps the others as a strip).
  - Each viewer chooses which streams to watch and which to hear. Streams that aren't being watched get paused or downgraded, to save upload bandwidth (LiveKit simulcast plus adaptive stream).
- **Settings:**
  - Profile, theme, notification preferences.
  - Admin: the notification channel, the allowed role, a quiet-hours digest.
- **Global player bar:** music follows you across pages. Opening Media locally pauses your Music, and you rejoin in sync when you return.

## Discord integration
- **Notification embeds:** thumbnail, actor, a "Join" link button, and a deep link with a timestamp. Rapid events are grouped, for example "Joe queued 12 tracks".
- **Slash commands:** `/play <query|url>`, `/watch <url>`, `/live` (who's casting), `/site`.
- **Per-user preferences:** what triggers a notification, and optional DMs.

## Access control & admin (built 2026-11-14)
- **Who gets in:** an approval queue. Any Discord server member can sign in and request access, then waits as Pending until an admin approves them. Admins can also pre-approve people by Discord ID. The owner (`OWNER_DISCORD_ID`) always has every permission and can't be demoted.
- **Roles:** Owner, Admin, Moderator and Member are built in. Their permissions are editable, and custom roles can be added.
  - Roles are ranked. People can only manage roles and people ranked below them, and can't grant permissions they lack.
- **Enforcement:**
  - The server denies by default. Every API route must declare `public`, `allowPending`, `anyActive` or a `permission`, or the server refuses to start.
  - State-changing requests must come from the site's own origin.
  - Requests are rate-limited.
  - Socket connections are gated the same way. Role and status changes apply live: affected users get `session:changed`, and suspensions drop their sockets.
  - Discord membership is re-checked every 15 minutes. Leaving the server removes access, and rejoining and signing in restores it.
- **Admin panel** (`/admin`):
  - **People:** approve or deny, roles, suspend, ban, reinstate, sign out everywhere, pre-approve.
  - **Roles:** a permission matrix.
  - **Audit log:** filters and CSV export, kept for 1 year, append-only.
  - **Settings:** lockdown, section switches, Discord notification options.
  - **System:** health, counts, database backup download.
- **Audit scope:** everything. Security and admin events now; playback, post and cast events are added as each section ships.

## Phases
0. **Foundation:**
   - Monorepo, Docker Compose, Caddy.
   - Discord OAuth with the server-membership check.
   - The impeccable design pass: tokens, type, light/dark, app shell and nav.
1. **Media** (built 2026-11-14): server-owned playback with clock-synced clients (drift above 0.5s gets a seek). YouTube, plus Twitch VODs, live channels and clips. Queue with drag/keyboard reorder, play next, play now, recently played with replay. Server-side auto-advance. Permission-checked, rate-limited, audited actions. Discord "now playing" post after 30 minutes idle. Optional `TWITCH_CLIENT_ID/SECRET` for Twitch titles, thumbnails and durations; without them, Twitch clips need a manual skip.
2. **Music (music view of the shared player).** Built 2026-11-14: per-viewer Artwork / Visualizer / Lyrics switch. The visualizer is the default music view, in the style of classic Windows Media Player: feedback-trail presets Alchemy, Battery, Bars and Waves, Ambience and Tunnel, plus Shuffle, which changes preset every 30 seconds. Colors follow the artwork's hue. The visuals are procedural from the synced clock with a per-track beat; "React to real audio" (tab capture) makes them follow the actual sound. Synced lyrics from LRCLIB with word stamps stripped and results cached 30 days. Saved group playlists: save queue, save item, queue all / shuffle / play next, rename and delete by owner or moderator. Spotify track, album and playlist links (built 2026-11-14): Spotify supplies the metadata and cover; each track is matched to a YouTube video just before it plays (the next one is matched ahead of time). Matches are cached permanently in `spotify_map`, so each track costs one YouTube search the first time it's ever played. Spotify blocks newer apps from reading Spotify-owned editorial playlists, and users get a clear message. search and link resolution (YouTube and Spotify), playlists, history, mini-player.
3. **Posts and Discord** (built 2026-11-14):
   - **Posts on Home:** text, up to 6 image or video attachments per post (type checked from the file bytes; images up to 15 MB, video up to 200 MB). Previews for the first link: YouTube, Spotify and Twitch links get an Add to queue button, and web pages show their Open Graph details, fetched behind a guard that refuses private and internal addresses.
   - Reactions; delete your own posts, or anyone's with posts.moderate. Updates arrive live.
   - **Discord:** new posts are batched into one message per 10 minutes. Slash commands /play, /queue and /skip map the Discord account to its site account, so site permissions apply.
4. **Cast:** LiveKit, multiple simultaneous streams with the grid and focus view, choosing which streams to hear, simulcast.
5. **Extras (pick later):**
   - Synced lyrics.
   - Reaction timeline.
   - Server "Wrapped" stats.
   - Guess-the-song game.
   - Watch a local file together.
   - Movie-night scheduling via Discord Scheduled Events.
   - PWA push notifications.

## Open items
- **Domain:** friends.indovina.dev (DNS on Cloudflare). Port forwarding is confirmed as possible. Ports: TCP 80/443 (Caddy), TCP 7881 and UDP 50000–50200 (LiveKit media), UDP 3478 (LiveKit's built-in TURN relay).
- A Discord application and bot token, plus the server ID and the notification channel ID.
- Install the impeccable skills before Phase 0's design pass.
