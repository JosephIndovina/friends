# friends

A companion site for our Discord server: synced music and video, screen and game casting, and a shared stream of posts. The plan is in [PLAN.md](PLAN.md), product context in [PRODUCT.md](PRODUCT.md).

## Develop

```sh
cp .env.example .env   # fill in the Discord values
pnpm install
pnpm dev               # web on http://localhost:5173, API on :3000
```

Requires Node 22+ and pnpm 9 (`corepack enable`).

## Deploy (TrueNAS SCALE + Cloudflare)

Every push to `main` runs CI and publishes `ghcr.io/josephindovina/friends:latest` (plus a `sha-…` tag).

### Network layout
- **friends.indovina.dev** goes through a **Cloudflare Tunnel** (`cloudflared` container) for the website, login and realtime sync. No inbound web ports are needed, so you can remove the 80/443 forwards.
- **rtc.indovina.dev** is **DNS only** (grey cloud), kept current by the `ddns` container, for Cast (LiveKit, Phase 4). Forwarded ports: TCP 7881, UDP 3478, UDP 50000–50200.

### One-time setup
1. **Cloudflare Tunnel:** Zero Trust → Networks → Tunnels → Create a tunnel (type *Cloudflared*), name it `friends`, and copy the token.
   - Add a **Public hostname** with `friends` · `indovina.dev`. Service: **HTTP**, URL `app:3000`.
   - Delete any existing A record for `friends` first. The tunnel creates its own CNAME.
2. **Cloudflare API token** (for DDNS): My Profile → API Tokens → Create Token → template *Edit zone DNS*, scoped to the `indovina.dev` zone.
3. **DNS:** add an A record `rtc` → any IP, set to **DNS only**. The ddns container corrects the IP.
4. **NAS dataset:** `NAS/friends` and `NAS/friends/data` (the latter owned by uid/gid **1000**, because the container runs as `node`). Already created.
5. **NAS `.env`:** `/mnt/NAS/friends/.env` (mode 600) holds the Discord values, `TUNNEL_TOKEN` and `CLOUDFLARE_API_TOKEN`. Leave `PUBLIC_URL` unset: compose sets it.
6. **GHCR pull access:** Apps → Configuration → Manage Container Image Registries → add `ghcr.io` with your GitHub username and the read:packages token. If your TrueNAS version lacks that screen, run `sudo docker login ghcr.io -u JosephIndovina` in the NAS shell.
7. **LiveKit (Cast):** `/mnt/NAS/friends/livekit.yaml` (mode 600) holds the LiveKit key pair, which is mirrored as `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` in the NAS `.env`, plus `LIVEKIT_URL=http://host.docker.internal:7880`. The router forwards TCP 7881, UDP 3478 and UDP 50000–50200 to the NAS (192.168.2.119).
8. **Install the app:** Apps → Discover Apps → ⋮ → **Install via YAML**. Paste [deploy/docker-compose.yml](deploy/docker-compose.yml).

### Updating
After CI publishes a new image, open the app in TrueNAS and choose **Pull image / Update** (or run `docker compose pull && docker compose up -d`).
