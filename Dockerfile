# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm --filter @friends/server deploy --prod /out
# Text to speech's ONNX runtime ships binaries for every OS; the image only ever runs on Linux.
RUN find /out/node_modules -type d -path '*onnxruntime-node/bin/napi-v*/*' \( -name darwin -o -name win32 \) -prune -exec rm -rf {} +

FROM node:22-bookworm-slim
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ENV NODE_ENV=production DATA_DIR=/data WEB_DIST=/app/web PORT=3000
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /src/apps/web/dist ./web
# Friends Live installers, put here by CI (served at /download/…; the folder may be empty).
COPY downloads/ ./downloads/
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
