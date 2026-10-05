# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# Build stage
FROM node:24-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 AS builder

# pnpm's install script is what puts its native binary in place. corepack never runs it,
# and npm 12 blocks it unless allowed, so both leave pnpm's shebang-less fallback shim instead.
RUN npm install -g --allow-scripts=pnpm pnpm@12.3.4

WORKDIR /app

# Copy ALL workspace package.json files for lockfile resolution
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/emails/package.json ./packages/emails/
COPY packages/translations/package.json ./packages/translations/
COPY packages/test-utils/package.json ./packages/test-utils/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code. data/ only goes into the runner, so it stays out of this layer and its cache.
COPY --exclude=data . .

# Build only production packages (excludes test-utils)
RUN pnpm turbo run build --filter=@tracearr/shared --filter=@tracearr/server --filter=@tracearr/web

# Production stage
FROM node:24-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2 AS runner

RUN npm install -g --allow-scripts=pnpm pnpm@12.3.4

# Tailscale VPN binary (userspace networking, no root required)
RUN apk add --no-cache tailscale postgresql-client

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 tracearr

WORKDIR /app

# Helm pins this to its own PVC mountPath; plain Docker installs mount a named
# volume here. Must stay a path the image creates and chowns, since the server
# mkdirs it at startup and cannot recover from EACCES.
ENV IMAGE_CACHE_DIR=/data/tracearr/image-cache
ENV NODE_ENV=production

# Basemap tiles change far less often than anything below, so they come first and stay cached
COPY --chown=tracearr:nodejs data/basemap.pmtiles ./data/basemap.pmtiles
COPY --chown=tracearr:nodejs data/BASEMAP_NOTICE.txt ./data/BASEMAP_NOTICE.txt

# Server runtime deps only: the web app ships as static files, so its packages never load here (ignore-scripts keeps prepare/husky out).
# Installed before any build output is copied so a code-only change reuses this layer.
COPY --chown=tracearr:nodejs package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY --chown=tracearr:nodejs apps/server/package.json ./apps/server/
COPY --chown=tracearr:nodejs packages/shared/package.json ./packages/shared/
COPY --chown=tracearr:nodejs packages/emails/package.json ./packages/emails/
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter @tracearr/server... && \
    chown -R tracearr:nodejs /app

# GeoIP databases, refreshed from MaxMind on every build
COPY --chown=tracearr:nodejs data/GeoLite2-City.mmdb ./data/GeoLite2-City.mmdb
COPY --chown=tracearr:nodejs data/GeoLite2-ASN.mmdb ./data/GeoLite2-ASN.mmdb

# Server package
COPY --from=builder --chown=tracearr:nodejs /app/apps/server/dist ./apps/server/dist
COPY --from=builder --chown=tracearr:nodejs /app/apps/server/scripts ./apps/server/scripts

# Web static files (served by server or reverse proxy)
COPY --from=builder --chown=tracearr:nodejs /app/apps/web/dist ./apps/web/dist

# Shared package
COPY --from=builder --chown=tracearr:nodejs /app/packages/shared/dist ./packages/shared/dist

# Emails package
COPY --from=builder --chown=tracearr:nodejs /app/packages/emails/dist ./packages/emails/dist

# Database migrations
COPY --from=builder --chown=tracearr:nodejs /app/apps/server/src/db/migrations ./apps/server/src/db/migrations
COPY --from=builder --chown=tracearr:nodejs /app/assets/logo.png ./assets/logo.png

# Create image cache and backup directories
RUN mkdir -p /app/data/image-cache /data/tracearr/image-cache /data/backup && \
    chown tracearr:nodejs /app/data/image-cache /data/tracearr /data/tracearr/image-cache /data/backup

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER tracearr

# Version info comes last: APP_COMMIT changes every build, and every instruction after it misses the cache
ARG APP_VERSION=0.0.0
ARG APP_TAG=
ARG APP_COMMIT=
ARG APP_BUILD_DATE=
ARG CACHE_BUST

# Write build info to JSON file - can't be overridden by compose ENV vars
RUN echo "Build: ${APP_VERSION} (${APP_COMMIT}) - ${CACHE_BUST:-nocache}" && \
    printf '{"version":"%s","tag":"%s","commit":"%s","buildDate":"%s"}\n' \
      "${APP_VERSION}" "${APP_TAG}" "${APP_COMMIT}" "${APP_BUILD_DATE}" > /app/.build-info.json

ENV APP_VERSION=${APP_VERSION}
ENV APP_TAG=${APP_TAG}
ENV APP_COMMIT=${APP_COMMIT}
ENV APP_BUILD_DATE=${APP_BUILD_DATE}

EXPOSE 3000

# Health check - use 127.0.0.1 to force IPv4 (Alpine wget defaults to IPv6 first)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

# OCI image labels for container registries and tools like Renovate
LABEL org.opencontainers.image.source="https://github.com/connorgallopo/Tracearr" \
      org.opencontainers.image.url="https://github.com/connorgallopo/Tracearr" \
      org.opencontainers.image.title="Tracearr" \
      org.opencontainers.image.description="Streaming access manager for Plex, Jellyfin, and Emby" \
      org.opencontainers.image.vendor="connorgallopo" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${APP_COMMIT}" \
      org.opencontainers.image.created="${APP_BUILD_DATE}"

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "apps/server/dist/index.js"]
