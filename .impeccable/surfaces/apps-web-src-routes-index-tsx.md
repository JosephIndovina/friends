---
version: 1
slug: "apps-web-src-routes-index-tsx"
primary_target: "apps/web/src/routes/index.tsx"
related_targets: []
---

# Dashboard surface brief

Scope: the Dashboard route (also sets the world for Music, Media, Cast, Settings). Mode: Operate.
Audience/job: friends arriving from a Discord post or a bookmark; see what's on right now and join in one tap; then glance at the stream and who's around.
Must not feel: precious, corporate/SaaS, or busy. Idle state: a quiet waiting room with one-tap ways to start something.
Chosen sketch: .impeccable/mocks/decision/r1/pick.html

## Direction contract
THESIS: The room takes the colour of whatever is on. The shell is a dark living room lit by the current media. It refuses the equal-tile card grid that dashboards default to: one thing is on the screen, and everything else is furniture.
OWN-WORLD: A warm near-black ground (#0e0c0d), translucent upholstery surfaces (#1b1719 at about 50% over the glow), warm ink (#f1e9e1) and a muted taupe (#a99d94). One `--glow` colour is sampled from the current artwork and clamped to a lightness and chroma band so text keeps AA contrast. It washes a radial light out from the stage. Media and Cast get only desaturated hint hues. Hanken Grotesk is the only face, with hierarchy by scale. The primary action is an ink pill. In light mode the lights are on: a warm linen ground, and the glow becomes a soft tinted wash and shadow.
STORY: Visitors see instantly what's on and who's on the couch, believe they'll be in sync the moment they join, and press "Listen in" or "Watch".
FIRST VIEWPORT:
- Top bar: brand, Home · Music · Media · Cast · Settings, and the user's avatar.
- Left two thirds: the stage, showing the current video or album art at 16:9 with a soft glow shadow. Under it, an info row: section kicker, title at 26px, listeners and a live timecode, and the ink pill on the right.
- Right column (360px): "Also on" tiles for the other live sections, then "On the couch" presence.
- Below: the stream.
- On phone: the stage goes full-bleed, tiles stack under it, and a bottom tab bar replaces the top nav.
- Idle: the glow cools to an ember, and the stage becomes "Nothing's on" with Start music, Watch something and Go live.
- Signature interaction: when the item changes, the glow crossfades across the whole room in about 1.2s (instant under reduced motion).
FORM: Couch Glow (a TV-lit living room), position 1 on the ordered list (taken as IMPECCABLE'S PICK in re-roll round 1). seed:9faee20250aa6dc0
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
