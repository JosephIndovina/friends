# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
TypeScript end to end (user's choice: "TypeScript full-stack").
- **Front end:** React + Vite + TanStack Router.
- **Server:** Fastify + Socket.IO, with the discord.js bot running in the same process.
- **Data:** SQLite via Drizzle.
- **Cast:** self-hosted LiveKit.
- **Deployment:** Caddy and Docker Compose on the user's home server or VPS, at `friends.indovina.dev` (DNS on Cloudflare).

## Users
A private group of about 5–15 friends who share one Discord server. They use the app in their downtime: hanging out in voice, gaming, or idling. Use is split equally between desktop (a browser next to Discord or a game) and phones (checking the feed, queueing a song, watching along).

## Product Purpose
"friends" (working name) is the group's shared hangout on the web. It plays music and YouTube or Twitch video in sync for everyone, lets people cast their screen or game, and collects the images, clips and links the group shares. The Discord bot does no playback. It announces activity and links people into the site. Success means people open the site whenever something is happening, and the bot's posts reliably pull others in.

## Positioning
It belongs to this group alone: one shared space per section, no rooms and no hosts, and anyone can control anything. It replaces a music bot and Discord Activities with a place the group owns and self-hosts.

## Operating Context
- People arrive from a bot post in Discord (a deep link), or from a bookmark.
- The site is often running next to Discord voice and a game.
- Music keeps playing across pages, in the global player.
- Sign-in is Discord OAuth, restricted to members of the server.

## Capabilities and Constraints
- **Nav:** Dashboard (activity feed plus a post stream for messages and media) · Music · Media (synced YouTube and Twitch) · Cast (game and desktop sharing) · Settings.
- **Control:** anyone can play, pause, skip or seek at any time.
- **YouTube player:** must stay visible (YouTube API ToS), including on the Music page. Search quota is about 100 searches a day.
- **Spotify links:** used for track details only. Playback is resolved to YouTube.
- **Twitch:** live channels sync only which channel is on, plus play/pause. VODs and clips sync fully.
- **Cast:** system audio capture is reliable only in Chromium on Windows.
- **Open decision:** the final product name ("friends" is a placeholder).

## Brand Commitments
- Working name: "friends".
- Domain: friends.indovina.dev.
- Must ship both dark and light modes.

## Evidence on Hand
None yet: no logo, assets or content. Don't invent group members, inside jokes or history. Use clearly fake placeholder content only in development.

## Product Principles
1. **Get in fast:** every Discord post opens straight to the thing that's happening.
2. **One shared space:** no rooms, hosts or permissions ceremony between friends.
3. **The media is the star:** the interface recedes behind the album art, video and streams.
4. **Equal on phone and desktop:** every section is fully usable on both.
5. **Quiet notifications:** batch and summarize rather than spam the channel.

## Accessibility & Inclusion
No specific needs reported. Target WCAG AA contrast in both themes, keyboard operability, and support for `prefers-reduced-motion`.
