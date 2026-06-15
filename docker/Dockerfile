# Build stage
FROM node:24-alpine3.23@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS builder

# Build arguments for version info
ARG APP_VERSION=0.0.0
ARG APP_TAG=
ARG APP_COMMIT=
ARG APP_BUILD_DATE=

RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

WORKDIR /app

# Copy ALL workspace package.json files for lockfile resolution
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY apps/mobile/package.json ./apps/mobile/
COPY packages/shared/package.json ./packages/shared/
COPY packages/translations/package.json ./packages/translations/
COPY packages/test-utils/package.json ./packages/test-utils/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build only production packages (excludes test-utils, mobile)
RUN pnpm turbo run build --filter=@tracearr/shared --filter=@tracearr/server --filter=@tracearr/web

# Production stage
FROM node:24-alpine3.23@sha256:2bdb65ed1dab192432bc31c95f94155ca5ad7fc1392fb7eb7526ab682fa5bf14 AS runner

# Build arguments for version info (must redeclare in each stage)
ARG APP_VERSION=0.0.0
ARG APP_TAG=
ARG APP_COMMIT=
ARG APP_BUILD_DATE=

RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

# Tailscale VPN binary (userspace networking, no root required)
RUN apk add --no-cache tailscale postgresql-client

WORKDIR /app

ARG CACHE_BUST
# Write build info to JSON file - can't be overridden by compose ENV vars

RUN echo "Build: ${APP_VERSION} (${APP_COMMIT}) - ${CACHE_BUST:-nocache}" && \
    printf '{"version":"%s","tag":"%s","commit":"%s","buildDate":"%s"}\n' \
      "${APP_VERSION}" "${APP_TAG}" "${APP_COMMIT}" "${APP_BUILD_DATE}" > /app/.build-info.json

# Set runtime environment variables
ENV NODE_ENV=production
ENV APP_VERSION=${APP_VERSION}
ENV APP_TAG=${APP_TAG}
ENV APP_COMMIT=${APP_COMMIT}
ENV APP_BUILD_DATE=${APP_BUILD_DATE}

# Copy package files for production install
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml ./

# Server package
COPY --from=builder /app/apps/server/package.json ./apps/server/
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/scripts ./apps/server/scripts

# Web static files (served by server or reverse proxy)
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Shared package
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

# Database migrations
COPY --from=builder /app/apps/server/src/db/migrations ./apps/server/src/db/migrations

# GeoIP database (if exists in build context)
COPY data/GeoLite2-City.mmdb ./data/GeoLite2-City.mmdb
COPY data/GeoLite2-ASN.mmdb ./data/GeoLite2-ASN.mmdb

# Create image cache and backup directories
RUN mkdir -p /app/data/image-cache /data/backup

# Install production dependencies only (ignore-scripts prevents prepare/husky from running)
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 tracearr

# Set ownership
RUN chown -R tracearr:nodejs /app /data/backup

USER tracearr

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
