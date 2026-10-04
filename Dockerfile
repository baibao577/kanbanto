# Kanbanto: the web app and the API server in one image. The server serves the built web app, so one
# container answers both the pages and /api. Needs a Postgres database (DATABASE_URL); migrations run on start.

# (The base image is named by its exact contents, so a build can't pick up a changed one unnoticed. Dependabot
# proposes the newer one each week.)
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
RUN corepack enable
WORKDIR /repo
# Dependencies first, so they're cached until a package.json or the lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY packages/model/package.json packages/model/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @kanbanto/web build \
 && pnpm --filter @kanbanto/server build \
 # Just the server with its production dependencies (the shared model is bundled into it).
 && pnpm --filter @kanbanto/server deploy --prod --legacy /out/server \
 # The site's own pages (a privacy policy, terms…), if there's a `pages` folder beside this file: see docs/configuration.md.
 && mkdir -p /out/pages && if [ -d pages ]; then cp -R pages/. /out/pages/; fi

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/web \
    UPLOADS_DIR=/data/uploads \
    PAGES_DIR=/app/pages \
    KEY_FILE=/data/config/encryption.key
WORKDIR /app/server
COPY --from=build --chown=node:node /out/server ./
COPY --from=build --chown=node:node /repo/apps/web/dist /app/web
COPY --from=build --chown=node:node /out/pages /app/pages
# Attachments kept on the server's disk, and the encryption key Kanbanto makes for itself. Mount volumes at these paths
# so they survive rebuilds (docker-compose.yml does). No VOLUME instruction: some hosts (Railway) refuse it, and a
# host's own volumes or settings (ENCRYPTION_KEY, a bucket for files) take its place.
RUN mkdir -p /data/uploads /data/config && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1
CMD ["node", "dist/main.js"]
