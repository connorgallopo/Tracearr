# Build stage
FROM node:22-alpine AS builder

# Build arguments for version info
ARG APP_VERSION=0.0.0
ARG APP_TAG=
ARG APP_COMMIT=
ARG APP_BUILD_DATE=

RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

WORKDIR /app

# Copy ALL workspace package.json files for lockfile resolution
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY apps/mobile/package.json ./apps/mobile/
COPY packages/shared/package.json ./packages/shared/
COPY packages/test-utils/package.json ./packages/test-utils/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build only production packages (excludes test-utils, mobile)
RUN pnpm turbo run build --filter=@tracearr/shared --filter=@tracearr/server --filter=@tracearr/web

# Production stage
FROM node:22-alpine AS runner

# Build arguments for version info (must redeclare in each stage)
ARG APP_VERSION=0.0.0
ARG APP_TAG=
ARG APP_COMMIT=
ARG APP_BUILD_DATE=

RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

WORKDIR /app

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

# Web static files (served by server or reverse proxy)
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Shared package
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

# Database migrations
COPY --from=builder /app/apps/server/src/db/migrations ./apps/server/src/db/migrations

# GeoIP database (if exists in build context)
COPY data/GeoLite2-City.mmdb ./data/GeoLite2-City.mmdb

# Create image cache directory (for volume mount compatibility)
RUN mkdir -p /app/data/image-cache

# Install production dependencies only (ignore-scripts prevents prepare/husky from running)
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 tracearr

# Set ownership
RUN chown -R tracearr:nodejs /app

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

CMD ["node", "apps/server/dist/index.js"]
