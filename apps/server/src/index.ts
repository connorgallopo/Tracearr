import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from 'dotenv';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync, createGzip } from 'node:zlib';
import { Redis } from 'ioredis';
import { API_BASE_PATH, API_V2_BASE_PATH, REDIS_KEYS, WS_EVENTS } from '@tracearr/shared';
import { createBetterAuthHandler } from './lib/betterAuthRequest.js';
import { getBasePath } from './lib/basePath.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Project root directory (apps/server/src -> project root)
const PROJECT_ROOT = resolve(__dirname, '../../..');

// Load .env from project root
config({ path: resolve(PROJECT_ROOT, '.env'), quiet: true });

// Set global DNS cache (must be after dotenv so DNS_CACHE_MAX_TTL is available)
await import('./utils/dnsCache.js');

// GeoIP database path (in project root/data)
const GEOIP_DB_PATH = resolve(PROJECT_ROOT, 'data/GeoLite2-City.mmdb');
const GEOASN_DB_PATH = resolve(PROJECT_ROOT, 'data/GeoLite2-ASN.mmdb');

// Migrations path (relative to compiled output in production, source in dev)
const MIGRATIONS_PATH = resolve(__dirname, '../src/db/migrations');
import type {
  ActiveSession,
  RunFinishedEvent,
  ViolationWithDetails,
  DashboardStats,
  TautulliImportProgress,
  JellystatImportProgress,
  PlaybackReportingImportProgress,
  MaintenanceJobProgress,
  LibrarySyncProgress,
  NotificationToast,
} from '@tracearr/shared';

import authPlugin, { loadJwtRevokeSettings } from './plugins/auth.js';
import redisPlugin, { connectRedis } from './plugins/redis.js';
import { closeAuth } from './lib/auth.js';
import { authRoutes } from './routes/auth/index.js';
import { setupRoutes } from './routes/setup.js';
import { serverRoutes } from './routes/servers.js';
import { userRoutes } from './routes/users/index.js';
import { serverUserRoutes } from './routes/serverUsers.js';
import { sessionRoutes } from './routes/sessions.js';
import { automationRoutes } from './routes/automations.js';
import { templateRoutes } from './routes/templates.js';
import { runRoutes } from './routes/runs.js';
import { violationRoutes } from './routes/violations.js';
import { statsRoutes } from './routes/stats/index.js';
import { settingsRoutes } from './routes/settings.js';
import { importRoutes } from './routes/import.js';
import { imageRoutes } from './routes/images.js';
import { startImageCacheSweepTimer, stopImageCacheSweep } from './services/imageCacheSweep.js';
import { debugRoutes } from './routes/debug.js';
import { mobileRoutes } from './routes/mobile.js';
import { notificationPreferencesRoutes } from './routes/notificationPreferences.js';
import { destinationRoutes } from './routes/destinations.js';
import { newsletterRoutes } from './routes/newsletters.js';
import { emailRoutes } from './routes/email.js';
import { versionRoutes } from './routes/version.js';
import { maintenanceRoutes } from './routes/maintenance.js';
import { mapRoutes } from './routes/map.js';
import { publicRoutes } from './routes/public.js';
import { publicV2Routes } from './routes/publicV2/index.js';
import { libraryRoutes } from './routes/library.js';
import { tailscaleRoutes } from './routes/tailscale.js';
import { tasksRoutes } from './routes/tasks.js';
import { backupRoutes } from './routes/backup.js';
import {
  getPollerSettings,
  getNetworkSettings,
  getBackupScheduleSettings,
} from './routes/settings.js';
import { initializeEncryption, migrateToken, looksEncrypted } from './utils/crypto.js';
import { publicApiRateLimitKey } from './utils/publicApiRateLimitKey.js';
import { registerErrorHandler } from './utils/errors.js';
import { resolveWebAsset } from './utils/webRoot.js';
import { geoipService } from './services/geoip.js';
import { tailscaleService } from './services/tailscale.js';
import { geoasnService } from './services/geoasn.js';
import { createCacheService, createPubSubService } from './services/cache.js';
import { initializePoller, startPoller, stopPoller } from './jobs/poller/index.js';
import { invalidateServersCache } from './jobs/poller/database.js';
import { sseManager } from './services/sseManager.js';
import {
  initializeSSEProcessor,
  startSSEProcessor,
  stopSSEProcessor,
  cleanupOrphanedPendingSessions,
} from './jobs/sseProcessor.js';
import { startPluginUpdateChecker, stopPluginUpdateChecker } from './jobs/pluginUpdateChecker.js';
import { startServerUpdateChecker, stopServerUpdateChecker } from './jobs/serverUpdateChecker.js';
import { startLeaderLease, stopLeaderLease } from './services/leaderLease.js';
import { initializeWebSocket, broadcastToSessions } from './websocket/index.js';
import {
  initNotificationQueue,
  startNotificationWorker,
  shutdownNotificationQueue,
} from './jobs/notificationQueue.js';
import { closeAllTransporters } from './services/notifications/destinations/emailTransport.js';
import { runAutomationModelMigration } from './services/automations/modelMigration.js';
import { runSystemEventsMigration } from './services/automations/systemEventsMigration.js';
import { seedBuiltinTemplates } from './services/automations/templates/seeder.js';
import { initDestinationCrypto } from './services/notifications/destinationCrypto.js';
import { invalidateDestinationsCache } from './services/notifications/destinationStore.js';
import {
  runDestinationsMigration,
  sweepDestinationConfigs,
} from './services/notifications/destinationsMigration.js';
import { initKillQueue, startKillWorker, shutdownKillQueue } from './jobs/killQueue.js';
import { initImportQueue, startImportWorker, shutdownImportQueue } from './jobs/importQueue.js';
import {
  initMaintenanceQueue,
  startMaintenanceWorker,
  shutdownMaintenanceQueue,
} from './jobs/maintenanceQueue.js';
import {
  initLibrarySyncQueue,
  startLibrarySyncWorker,
  scheduleAutoSync,
  shutdownLibrarySyncQueue,
} from './jobs/librarySyncQueue.js';
import {
  initImagePrecacheQueue,
  startImagePrecacheWorker,
  shutdownImagePrecacheQueue,
} from './jobs/imagePrecacheQueue.js';
import {
  initVersionCheckQueue,
  startVersionCheckWorker,
  scheduleVersionChecks,
  shutdownVersionCheckQueue,
} from './jobs/versionCheckQueue.js';
import {
  initInactivityCheckQueue,
  startInactivityCheckWorker,
  scheduleInactivityChecks,
  shutdownInactivityCheckQueue,
} from './jobs/inactivityCheckQueue.js';
import {
  initBackupQueue,
  startBackupWorker,
  scheduleBackupJob,
  shutdownBackupQueue,
} from './jobs/backupQueue.js';
import {
  initNewsletterQueues,
  startNewsletterWorkers,
  resyncNewsletterSchedules,
  shutdownNewsletterQueues,
} from './jobs/newsletterQueue.js';
import { listNewsletters } from './services/newsletters/store.js';
import {
  initPlexTokenRefreshQueue,
  startPlexTokenRefreshWorker,
  schedulePlexTokenRefresh,
  shutdownPlexTokenRefreshQueue,
} from './jobs/plexTokenRefresh.js';
import {
  initRunRetentionQueue,
  startRunRetentionWorker,
  scheduleRunRetention,
  shutdownRunRetentionQueue,
} from './jobs/runRetentionQueue.js';
import { initHeavyOpsLock } from './jobs/heavyOpsLock.js';
import { startConnectionBudget, stopConnectionBudget } from './services/connectionBudget.js';
import { initPushRateLimiter } from './services/pushRateLimiter.js';
import { initializeV2Rules } from './services/automations/v2Integration.js';
import { rehydratePauseWakes, stopPauseWakes } from './services/automations/wakes/pauseWakes.js';
import { processPushReceipts } from './services/pushNotification.js';
import { cleanupMobileTokens } from './jobs/cleanupMobileTokens.js';
import { db, checkDatabaseConnection } from './db/client.js';
import { runMigrationsGuarded } from './db/migrationRunner.js';
import { pickRecoveryIntervalMs, type InitFailureKind } from './lib/bootRecovery.js';
import {
  initTimescaleDB,
  getTimescaleStatus,
  updateTimescaleExtensions,
  warnOnTimescaleVersionDrift,
  runAggregateBackfill,
  isCompressionPolicyDegraded,
  retryDegradedCompressionPolicy,
} from './db/timescale.js';
import { eq } from 'drizzle-orm';
import { servers } from './db/schema.js';
import { initializeClaimCode } from './utils/claimCode.js';
import { registerService, unregisterService } from './services/serviceTracker.js';
import { backfillMissingServerIdentifiers } from './services/serverIdentity.js';
import {
  getServerMode,
  setServerMode,
  isMaintenance,
  isServicesInitialized,
  setServicesInitialized,
  onModeChange,
  wasEverReady,
  isDbHealthy,
  setDbHealthy,
  isRedisHealthy,
  setRedisHealthy,
  isRestoring,
  getRestoreProgress,
  setRestoreProgress,
  getLastMigrationError,
  setLastMigrationError,
  setInitStep,
  getInitStep,
} from './serverState.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const RECOVERY_INTERVAL_MS = 10_000;
// A migration failure is usually deterministic (bad SQL, missing privilege) rather
// than a transient outage, so retry it more slowly than the plain connectivity probe.
const MIGRATION_RETRY_INTERVAL_MS = 60_000;

/** Set by buildApp()/initializeServices() failures to steer the recovery loop's cadence. */
let lastInitFailureKind: InitFailureKind = 'connectivity';

/** No-op callback for suppressing ioredis error events on disposable probe clients. */
// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop() {}

// Module-level references for cleanup
let wsSubscriber: Redis | null = null;
let pubSubRedis: Redis | null = null;
let pushReceiptInterval: ReturnType<typeof setInterval> | null = null;
let mobileTokenCleanupInterval: ReturnType<typeof setInterval> | null = null;
let recoveryInterval: ReturnType<typeof setInterval> | null = null;
let dbHealthInterval: ReturnType<typeof setInterval> | null = null;
let redisCloseHandler: (() => void) | null = null;
let redisReadyHandler: (() => void) | null = null;
const DB_HEALTH_CHECK_MS = 10_000;

/** Set by initializeServices() when initTimescaleDB() reports a historical
 * aggregate backfill is still needed; consumed by initializePostListen() so
 * the (potentially slow) backfill never blocks startup. */
let pendingAggregateBackfill: { targetVersion: number } | null = null;
let aggregateBackfillRunning = false;

/** Cached timescale status — refreshed by the DB health interval. */
let cachedTimescale: {
  installed: boolean;
  hypertable: boolean;
  compression: boolean;
  aggregates: number;
  chunks: number;
  /** True if a previous sessions-compression-policy restore failed and hasn't self-healed yet. */
  compressionDegraded: boolean;
} | null = null;

async function refreshTimescaleCache(): Promise<void> {
  try {
    const tsStatus = await getTimescaleStatus();
    cachedTimescale = {
      installed: tsStatus.extensionInstalled,
      hypertable: tsStatus.sessionsIsHypertable,
      compression: tsStatus.compressionEnabled,
      aggregates: tsStatus.continuousAggregates.length,
      chunks: tsStatus.chunkCount,
      // Locally-marked degradation surfaces instantly (in-process hint);
      // another instance's flag surfaces within the check's own short TTL.
      compressionDegraded: await isCompressionPolicyDegraded(),
    };
  } catch {
    cachedTimescale = null;
  }
}

// basePath from env var — always known at startup, never changes at runtime.
const BASE_PATH = getBasePath();

// ============================================================================
// Phase 1: Build the Fastify app (builds without DB/Redis, but fails fast if
// required secrets like BETTER_AUTH_SECRET are missing)
// ============================================================================

async function buildApp(options: { trustProxy?: boolean } = {}) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
    // Trust proxy if enabled in settings or via env var
    // This respects X-Forwarded-For, X-Forwarded-Proto headers from reverse proxies
    trustProxy: options.trustProxy ?? process.env.TRUST_PROXY === 'true',
    // Strip basePath prefix from incoming URLs before routing.
    // All existing routes (/api/v1/..., /health, etc.) match without changes.
    // Fastify automatically stores the original URL as request.originalUrl.
    rewriteUrl(req) {
      const url = req.url ?? '/';
      if (BASE_PATH) {
        if (url.startsWith(`${BASE_PATH}/`) || url === BASE_PATH) {
          return url.slice(BASE_PATH.length) || '/';
        }
      }
      return url;
    },
  });

  // Handle requests without a Content-Type header.
  // Some reverse proxies (e.g. Zoraxy with chunked transfer encoding enabled) replace
  // Content-Length with Transfer-Encoding: chunked on bodyless requests. Fastify sees
  // transfer-encoding, assumes there's a body to parse, and returns 415 because there's
  // no Content-Type. Strip the proxy-injected header so Fastify correctly treats the
  // request as bodyless.
  app.addHook('onRequest', async (request) => {
    if (!request.headers['content-type']) {
      delete request.headers['transfer-encoding'];
    }
  });

  // Maintenance gate hook — MUST be registered before rate limiter so it
  // short-circuits requests before the rate limiter tries to access Redis
  app.addHook('onRequest', async (request, reply) => {
    // Always allow health endpoint (includes restore progress when restoring)
    if (request.url === '/health') return;

    // Allow static files and SPA routes so frontend can load and show maintenance page
    if (!request.url.startsWith('/api/')) return;

    if (isMaintenance()) {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'Tracearr is starting up. Database or Redis is not yet available.',
        maintenance: true,
      });
    }
  });

  // Security plugins - relaxed for HTTP-only deployments
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
    originAgentCluster: false,
  });
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 1000,
    timeWindow: '1 minute',
    keyGenerator: publicApiRateLimitKey,
  });

  // Gzip compression for all responses (global onSend hook).
  // Disabled by default — most deployments use a reverse proxy (nginx, Caddy, Traefik)
  // that already handles compression. Enable with GZIP_ENABLED=true for direct-access
  // setups without a reverse proxy.
  if (process.env.GZIP_ENABLED === 'true') {
    app.addHook('onSend', (request, reply, payload, done) => {
      if (payload == null) return done(null, payload);

      // Skip if already compressed or client doesn't accept gzip
      const existing = reply.getHeader('Content-Encoding');
      if (existing && existing !== 'identity') return done(null, payload);
      const accept = request.headers['accept-encoding'];
      if (!accept?.includes('gzip')) return done(null, payload);

      // Only compress text-like content types (not images, fonts, etc.)
      const ct = (reply.getHeader('Content-Type') || 'application/json') as string;
      if (!/text\/(?!event-stream)|json|xml|javascript|css/i.test(ct)) return done(null, payload);

      // Streams (from reply.sendFile — JS, CSS, SVG, etc.)
      if (
        typeof payload === 'object' &&
        typeof (payload as NodeJS.ReadableStream).pipe === 'function'
      ) {
        reply.header('Content-Encoding', 'gzip');
        reply.header('Vary', 'Accept-Encoding');
        reply.removeHeader('Content-Length');
        const gz = createGzip();
        (payload as NodeJS.ReadableStream).pipe(gz);
        return done(null, gz);
      }

      // Strings and buffers (API JSON, SPA HTML)
      if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
        const size = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;
        if (size < 1024) return done(null, payload);
        reply.header('Content-Encoding', 'gzip');
        reply.header('Vary', 'Accept-Encoding');
        reply.removeHeader('Content-Length');
        return done(null, gzipSync(typeof payload === 'string' ? Buffer.from(payload) : payload));
      }

      return done(null, payload);
    });
  }

  // Utility plugins
  await app.register(sensible);

  // The SPA fallback below claims the not-found slot in production, and Fastify
  // throws on a second handler for the same scope - so hand off the 404 half
  // only when that branch is inactive.
  const webDistPath = resolve(PROJECT_ROOT, 'apps/web/dist');
  const serveSpa = process.env.NODE_ENV === 'production' && existsSync(webDistPath);
  registerErrorHandler(app, { notFound: !serveSpa });
  await app.register(cookie, {
    secret: process.env.COOKIE_SECRET,
  });

  // Redis plugin (lazyConnect — does not attempt connection yet)
  await app.register(redisPlugin);

  // Auth plugin (depends on cookie, uses JWT — no Redis dependency)
  await app.register(authPlugin);

  // Health check endpoint — always reachable, even in maintenance mode.
  // Every value returned here is read from in-memory caches; nothing awaits
  // a network call, so the handler is effectively synchronous.
  app.get('/health', (_request, reply) => {
    // The web client polls this to decide if we're up; a cached answer is a wrong answer
    reply.header('Cache-Control', 'no-store');
    const dbHealthy = isDbHealthy();
    const redisHealthy = isRedisHealthy();
    const mode = getServerMode();

    // A restore in progress is always reported as maintenance, even during
    // the restore point phase before setServerMode('maintenance') is called.
    const restoreProgress = getRestoreProgress();
    if (restoreProgress) {
      return {
        status: 'maintenance',
        mode: 'maintenance',
        wasReady: wasEverReady(),
        db: dbHealthy,
        redis: redisHealthy,
        restore: restoreProgress,
      };
    }

    if (mode === 'ready') {
      return {
        status: dbHealthy && redisHealthy ? 'ok' : 'degraded',
        mode,
        db: dbHealthy,
        redis: redisHealthy,
        geoip: geoipService.hasDatabase(),
        tailscale: tailscaleService.getInfo().status,
        timescale: cachedTimescale,
      };
    }

    return {
      status: 'maintenance',
      mode,
      wasReady: wasEverReady(),
      db: dbHealthy,
      redis: redisHealthy,
      // Non-null while a startup phase is applying; 'migrations' and
      // 'timescale' mean interrupting the process risks half-applied work
      initStep: getInitStep(),
      // Set when db/redis are both reachable but startup init (migrations, etc.)
      // failed - otherwise the maintenance state looks identical to a plain
      // connectivity outage even though it needs a different fix.
      migrationError: getLastMigrationError(),
    };
  });

  // API routes — registered now but gated by the maintenance hook above
  await app.register(setupRoutes, { prefix: `${API_BASE_PATH}/setup` });

  // Better Auth catch-all. Static legacy routes registered below win over this
  // wildcard for their exact paths; everything else under /api/v1/auth is BA.
  app.route({
    method: ['GET', 'POST'],
    url: `${API_BASE_PATH}/auth/*`,
    config: { rateLimit: false },
    handler: createBetterAuthHandler(),
  });

  await app.register(authRoutes, { prefix: `${API_BASE_PATH}/auth` });
  await app.register(serverRoutes, { prefix: `${API_BASE_PATH}/servers` });
  await app.register(userRoutes, { prefix: `${API_BASE_PATH}/users` });
  await app.register(serverUserRoutes, { prefix: `${API_BASE_PATH}/server-users` });
  await app.register(sessionRoutes, { prefix: `${API_BASE_PATH}/sessions` });
  await app.register(automationRoutes, { prefix: `${API_BASE_PATH}/automations` });
  await app.register(templateRoutes, { prefix: `${API_BASE_PATH}/templates` });
  await app.register(runRoutes, { prefix: `${API_BASE_PATH}/runs` });
  await app.register(violationRoutes, { prefix: `${API_BASE_PATH}/violations` });
  await app.register(statsRoutes, { prefix: `${API_BASE_PATH}/stats` });
  await app.register(settingsRoutes, { prefix: `${API_BASE_PATH}/settings` });
  await app.register(destinationRoutes, { prefix: `${API_BASE_PATH}/destinations` });
  await app.register(newsletterRoutes, { prefix: `${API_BASE_PATH}/newsletters` });
  await app.register(emailRoutes, { prefix: `${API_BASE_PATH}/email` });
  await app.register(importRoutes, { prefix: `${API_BASE_PATH}/import` });
  await app.register(imageRoutes, { prefix: `${API_BASE_PATH}/images` });
  await app.register(debugRoutes, { prefix: `${API_BASE_PATH}/debug` });
  await app.register(mobileRoutes, { prefix: `${API_BASE_PATH}/mobile` });
  await app.register(notificationPreferencesRoutes, { prefix: `${API_BASE_PATH}/notifications` });
  await app.register(versionRoutes, { prefix: `${API_BASE_PATH}/version` });
  await app.register(maintenanceRoutes, { prefix: `${API_BASE_PATH}/maintenance` });
  await app.register(mapRoutes, { prefix: `${API_BASE_PATH}/map` });
  await app.register(tailscaleRoutes, { prefix: `${API_BASE_PATH}/tailscale` });
  await app.register(tasksRoutes, { prefix: `${API_BASE_PATH}/tasks` });
  await app.register(publicRoutes, { prefix: `${API_BASE_PATH}/public` });
  await app.register(publicV2Routes, { prefix: `${API_V2_BASE_PATH}/public` });
  await app.register(libraryRoutes, { prefix: `${API_BASE_PATH}/library` });
  await app.register(backupRoutes, { prefix: `${API_BASE_PATH}/backup` });

  // Serve static frontend in production
  if (serveSpa) {
    // Read index.html once at startup for <base> tag injection
    const indexHtmlPath = resolve(webDistPath, 'index.html');
    const cachedIndexHtml = readFileSync(indexHtmlPath, 'utf-8');

    // Register @fastify/static for reply.sendFile() without auto-serving routes.
    // We handle all routing ourselves to inject <base> into index.html responses.
    await app.register(fastifyStatic, {
      root: webDistPath,
      prefix: '/',
      serve: false,
    });

    // All non-API requests: serve static assets or SPA fallback with <base> tag
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/') || request.url === '/health') {
        return reply.code(404).send({ error: 'Not Found' });
      }

      // Redirect to basePath if original URL isn't under it (e.g. "/" → "/tracearr/")
      if (BASE_PATH) {
        const originalUrl = request.originalUrl;
        if (!originalUrl.startsWith(`${BASE_PATH}/`) && originalUrl !== BASE_PATH) {
          return reply.redirect(`${BASE_PATH}/`);
        }
      }

      // request.url is already stripped by rewriteUrl
      const urlPath = request.url.split('?')[0]!;

      // Serve static files (paths with a file extension). resolveWebAsset
      // returns null for anything escaping the web root, so a crafted path
      // falls through to the SPA response instead of stat-ing the filesystem.
      if (urlPath !== '/' && /\.\w+$/.test(urlPath)) {
        const assetPath = resolveWebAsset(webDistPath, urlPath);
        if (assetPath && existsSync(resolve(webDistPath, assetPath))) {
          // Vite content-hashes /assets/ filenames, so they are immutable;
          // basemap glyphs and sprites are stable vendored files.
          if (assetPath.startsWith('assets/')) {
            reply.header('Cache-Control', 'public, max-age=31536000, immutable');
          } else if (assetPath.startsWith('basemaps/')) {
            reply.header('Cache-Control', 'public, max-age=604800');
          }
          return reply.sendFile(assetPath);
        }
        // A hashed chunk that no longer exists after an upgrade must 404; the HTML
        // fallback would resolve as a module and break the import with a parse error.
        if (assetPath?.startsWith('assets/')) {
          return reply.code(404).send();
        }
      }

      // SPA fallback — always inject <base> tag so relative asset paths (./assets/...)
      // resolve correctly on nested routes like /library/watch
      const baseHref = BASE_PATH ? `${BASE_PATH}/` : '/';
      const html = cachedIndexHtml.replace('<head>', `<head>\n    <base href="${baseHref}">`);
      reply.header('Cache-Control', 'no-cache');
      return reply.type('text/html').send(html);
    });

    app.log.info('Static file serving enabled for production');
  }

  // Cleanup hook — handles both maintenance and ready mode resources
  app.addHook('onClose', async () => {
    if (recoveryInterval) {
      clearInterval(recoveryInterval);
    }
    if (dbHealthInterval) {
      clearInterval(dbHealthInterval);
    }
    if (pushReceiptInterval) {
      clearInterval(pushReceiptInterval);
    }
    if (mobileTokenCleanupInterval) {
      clearInterval(mobileTokenCleanupInterval);
    }
    stopImageCacheSweep();
    await closeAuth();
    if (pubSubRedis) await pubSubRedis.quit();
    if (wsSubscriber) await wsSubscriber.quit();
    // Producers stop before the lease releases so the next leader never
    // overlaps an in-flight poll from this instance
    stopPoller();
    stopSSEProcessor();
    stopPauseWakes();
    stopPluginUpdateChecker();
    stopServerUpdateChecker();
    await sseManager.stop();
    await stopLeaderLease();
    await tailscaleService.shutdown();
    await shutdownNotificationQueue();
    await shutdownKillQueue();
    await shutdownImportQueue();
    await shutdownMaintenanceQueue();
    await shutdownLibrarySyncQueue();
    await shutdownImagePrecacheQueue();
    await shutdownVersionCheckQueue();
    await shutdownInactivityCheckQueue();
    await shutdownBackupQueue();
    await shutdownNewsletterQueues();
    closeAllTransporters();
    await shutdownPlexTokenRefreshQueue();
    await shutdownRunRetentionQueue();
  });

  // Probe DB and Redis to decide if we can initialize services now
  const dbOk = await checkDatabaseConnection();
  let redisOk: boolean;
  try {
    // Temporarily connect to test reachability
    const testRedis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy: () => null, // Don't retry for the probe
    });
    testRedis.on('error', noop); // Suppress — failure is handled via catch
    try {
      await testRedis.connect();
      const pong = await testRedis.ping();
      redisOk = pong === 'PONG';
    } finally {
      testRedis.disconnect();
    }
  } catch {
    redisOk = false;
  }

  setDbHealthy(dbOk);
  setRedisHealthy(redisOk);

  // Initialization (migrations, TimescaleDB, services) deliberately does NOT
  // run here. It runs in start() after listen(), so /health is reachable and
  // the UI can show which phase is applying with a do-not-restart warning
  // while a long migration or aggregate rebuild holds the boot. A slow
  // migration must never look like a dead container, or orchestrators with
  // tight start periods kill it mid-DDL.
  if (!dbOk || !redisOk) {
    lastInitFailureKind = 'connectivity';
    app.log.warn(
      { db: dbOk, redis: redisOk },
      'Server starting in MAINTENANCE mode — database or Redis unavailable'
    );
  }
  setServerMode('maintenance');

  return app;
}

// ============================================================================
// Phase 2: Initialize all DB/Redis-dependent services
// ============================================================================

async function initializeServices(app: FastifyInstance) {
  if (isServicesInitialized()) return;

  // Connect the lazy Redis client
  await connectRedis(app);

  // Update TimescaleDB extensions before migrations: must happen before any
  // query touches timescaledb objects, otherwise the old version gets locked in.
  // Opt-in (TIMESCALEDB_AUTO_UPDATE): the update is one-way, needs ALTER
  // EXTENSION privilege (managed hosts often lack it), and rolling the image
  // back after an update leaves the database unable to load the extension.
  // When disabled, a version drift still gets a loud warning: bumping the
  // database image does NOT update the extension inside the database, and the
  // gap otherwise goes unnoticed.
  if (process.env.TIMESCALEDB_AUTO_UPDATE === 'true') {
    try {
      await updateTimescaleExtensions();
    } catch (err) {
      app.log.warn({ err }, 'Failed to update TimescaleDB extensions (non-fatal)');
    }
  } else {
    try {
      await warnOnTimescaleVersionDrift(app.log);
    } catch {
      // Drift check is best-effort; boot continues either way
    }
  }

  // Run database migrations on a dedicated session guarded by an advisory lock
  // (a second booting instance waits instead of racing DDL) and a short
  // lock_timeout (fails fast instead of wedging boot behind a live writer).
  try {
    setInitStep('migrations');
    app.log.info('Running database migrations...');
    await runMigrationsGuarded(MIGRATIONS_PATH);
    app.log.info('Database migrations complete');
  } catch (err) {
    app.log.error({ err }, 'Failed to run database migrations');
    setInitStep(null);
    throw err;
  }

  // Build prepared statements now that the db pool is ready
  const { initPreparedStatements } = await import('./db/prepared.js');
  initPreparedStatements();

  // Load JWT revoke settings — ensures tokens issued before a prior restore are rejected
  await loadJwtRevokeSettings();

  // Generate this install's Plex client identifier on first boot
  const { initializePlexClientIdentifier } = await import('./lib/plexIdentity.js');
  await initializePlexClientIdentifier();

  // Initialize TimescaleDB features (hypertable, compression, aggregates)
  try {
    setInitStep('timescale');
    app.log.info('Initializing TimescaleDB...');
    const tsResult = await initTimescaleDB();
    for (const action of tsResult.actions) {
      app.log.info(`  TimescaleDB: ${action}`);
    }
    if (tsResult.status.sessionsIsHypertable) {
      app.log.info(
        `TimescaleDB ready: ${tsResult.status.chunkCount} chunks, ` +
          `compression=${tsResult.status.compressionEnabled}, ` +
          `aggregates=${tsResult.status.continuousAggregates.length}`
      );
    } else if (!tsResult.status.extensionInstalled) {
      app.log.warn(
        'TimescaleDB extension not installed - running without time-series optimization'
      );
    }
    if (tsResult.backfillPending) {
      pendingAggregateBackfill = { targetVersion: tsResult.backfillPending.targetVersion };
      app.log.warn(
        `TimescaleDB aggregates need a historical backfill (target schema v${tsResult.backfillPending.targetVersion}). ` +
          'Recent dashboards are available now; full history will backfill in the background after startup.'
      );
    }
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize TimescaleDB - continuing without optimization');
    // Don't throw - app can still work without TimescaleDB features
  }

  setInitStep('services');

  // Initialize encryption (optional - only needed for migrating existing encrypted tokens)
  const encryptionAvailable = initializeEncryption();
  if (encryptionAvailable) {
    app.log.info('Encryption key available for token migration');
  }

  // Migrate any encrypted tokens to plain text
  try {
    const allServers = await db.select({ id: servers.id, token: servers.token }).from(servers);
    let migrated = 0;
    let failed = 0;

    for (const server of allServers) {
      if (looksEncrypted(server.token)) {
        const result = migrateToken(server.token);
        if (result.wasEncrypted) {
          await db
            .update(servers)
            .set({ token: result.plainText })
            .where(eq(servers.id, server.id));
          migrated++;
        } else {
          // Looks encrypted but couldn't decrypt - always warn regardless of key availability
          app.log.warn(
            { serverId: server.id, hasEncryptionKey: encryptionAvailable },
            'Server token appears encrypted but could not be decrypted. ' +
              (encryptionAvailable
                ? 'The encryption key may not match. '
                : 'No ENCRYPTION_KEY provided. ') +
              'You may need to re-add this server.'
          );
          failed++;
        }
      }
    }

    if (migrated > 0) {
      invalidateServersCache();
      app.log.info(`Migrated ${migrated} server token(s) from encrypted to plain text storage`);
    }
    if (failed > 0) {
      app.log.warn(
        `${failed} server(s) have tokens that could not be decrypted. ` +
          'These servers will need to be re-added.'
      );
    }
  } catch (err) {
    app.log.error({ err }, 'Failed to migrate encrypted tokens');
    // Don't throw - let the app start, individual servers will fail gracefully
  }

  // Initialize GeoIP service (optional - graceful degradation)
  await geoipService.initialize(GEOIP_DB_PATH);
  if (geoipService.hasDatabase()) {
    app.log.info('GeoIP database loaded');
  } else {
    app.log.warn('GeoIP database not available - location features disabled');
  }

  // Initialize GeoASN service (optional - graceful degradation)
  await geoasnService.initialize(GEOASN_DB_PATH);
  if (geoasnService.hasDatabase()) {
    app.log.info('GeoASN database loaded');
  } else {
    app.log.warn('GeoASN database not available - ASN data disabled');
  }

  // Initialize V2 rules system (wire action executor dependencies)
  try {
    await initializeV2Rules(app.redis);
    app.log.info('V2 rules system initialized');
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize V2 rules system');
    // Don't throw - rules can still work with default no-op deps
  }

  // Create cache and pubsub services
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  pubSubRedis = new Redis(redisUrl);
  pubSubRedis.on('error', (err: Error) => {
    app.log.error({ err }, 'PubSub Redis error');
  });
  const cacheService = createCacheService(app.redis);
  const pubSubService = createPubSubService(app.redis, pubSubRedis);

  const keySource = initDestinationCrypto();
  app.log.info(`Destination secrets keyed from ${keySource}`);

  // Unwrapped on purpose: a half-applied migration must reach the boot recovery loop, not leave
  // rules pointing at destinations that were never inserted.
  await runDestinationsMigration();

  // Runs after the destinations rewrite so node ids land on the final action set, and unwrapped
  // for the same reason: a half-migrated automation model must not survive into serving.
  await runAutomationModelMigration();

  // Unwrapped like its neighbours: a catalog that failed to seed would leave the gallery
  // and every bound instance pointing at a template version that was never written.
  await seedBuiltinTemplates();

  // Needs the catalog it seeds: the destination subscriptions it converts become instances of
  // those templates. Unwrapped too, or an install ends up with neither the checkbox nor the rule.
  await runSystemEventsMigration();

  try {
    await sweepDestinationConfigs();
  } catch (err) {
    app.log.warn({ err }, 'Failed to sweep destination configs');
  }

  // Initialize push notification rate limiter (uses Redis for sliding window counters)
  initPushRateLimiter(app.redis);
  app.log.info('Push notification rate limiter initialized');

  try {
    initNotificationQueue(redisUrl);
    startNotificationWorker();
    initKillQueue(redisUrl);
    startKillWorker();
    pushReceiptInterval = setInterval(
      () => {
        processPushReceipts().catch((err) => {
          app.log.warn({ err }, 'Failed to process push receipts');
        });
      },
      15 * 60 * 1000
    );
    registerService('push-receipts', {
      name: 'Push Receipt Processing',
      description: 'Processes push notification delivery receipts',
      intervalMs: 15 * 60 * 1000,
    });
    // Cleanup expired/invalid mobile tokens every hour
    mobileTokenCleanupInterval = setInterval(
      () => {
        cleanupMobileTokens().catch((err) => {
          app.log.warn({ err }, 'Failed to cleanup mobile tokens');
        });
      },
      60 * 60 * 1000 // 1 hour
    );
    registerService('mobile-token-cleanup', {
      name: 'Mobile Token Cleanup',
      description: 'Cleans up expired mobile push tokens',
      intervalMs: 60 * 60 * 1000,
    });
    app.log.info('Notification queue initialized');
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize notification queue');
    // Don't throw - notifications are non-critical
  }

  // Initialize import queue (uses Redis for job storage)
  try {
    initImportQueue(redisUrl);
    startImportWorker();
    app.log.info('Import queue initialized');
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize import queue');
    // Don't throw - imports can fall back to direct execution
  }

  // Initialize maintenance queue (uses Redis for job storage)
  try {
    initMaintenanceQueue(redisUrl);
    startMaintenanceWorker();
    app.log.info('Maintenance queue initialized');
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize maintenance queue');
    // Don't throw - maintenance jobs are non-critical
  }

  // Initialize heavy operations lock (coordinates import + maintenance jobs)
  await initHeavyOpsLock(app.redis);
  app.log.info('Heavy operations lock initialized');

  // Size the pg pool from the server's real max_connections and the live
  // instance count (no-op when DATABASE_POOL_MAX is set explicitly)
  try {
    await startConnectionBudget(app.redis);
  } catch (err) {
    app.log.warn({ err }, 'Connection budget unavailable, keeping default pool size');
  }

  // Initialize library sync queue (uses Redis for job storage)
  try {
    initLibrarySyncQueue(redisUrl);
    startLibrarySyncWorker();
    // Schedule auto-sync after a small delay to ensure all services are initialized
    setTimeout(() => {
      scheduleAutoSync().catch((err) => {
        app.log.error({ err }, 'Failed to schedule library auto-sync');
      });
    }, 5000);
    app.log.info('Library sync queue initialized');
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize library sync queue');
    // Don't throw - library sync is non-critical
  }

  // Initialize image precache queue (uses Redis for job storage)
  try {
    initImagePrecacheQueue(redisUrl);
    await startImagePrecacheWorker();
    app.log.info('Image precache queue initialized');
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize image precache queue');
    // Don't throw - image precache is non-critical
  }
  startImageCacheSweepTimer();

  // Initialize version check queue (uses Redis for job storage and caching)
  try {
    initVersionCheckQueue(redisUrl, app.redis, pubSubService.publish.bind(pubSubService));
    startVersionCheckWorker();
    void scheduleVersionChecks();
    app.log.info('Version check queue initialized');
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize version check queue');
    // Don't throw - version checks are non-critical
  }

  // Registers the rule subscribers; the inactivity worker below dispatches into them.
  initializePoller(cacheService, pubSubService);

  // Initialize inactivity check queue (monitors inactive accounts)
  try {
    initInactivityCheckQueue(redisUrl, app.redis, pubSubService.publish.bind(pubSubService));
    startInactivityCheckWorker();
    void scheduleInactivityChecks();
    app.log.info('Inactivity check queue initialized');
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize inactivity check queue');
    // Don't throw - inactivity checks are non-critical
  }

  // Initialize backup queue (scheduled backups)
  try {
    initBackupQueue(redisUrl);
    startBackupWorker();

    // Read backup schedule from settings and configure repeatable job
    const backupSchedule = await getBackupScheduleSettings();
    await scheduleBackupJob(backupSchedule);

    app.log.info('Backup queue initialized');
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize backup queue');
    // Don't throw - scheduled backups are non-critical
  }

  try {
    initNewsletterQueues(redisUrl);
    await resyncNewsletterSchedules(await listNewsletters());
    startNewsletterWorkers();
    app.log.info('Newsletter queues initialized');
  } catch (error) {
    app.log.error({ err: error }, 'Failed to initialize newsletter queues');
  }

  // Initialize run retention queue (daily purge of aged automation runs)
  try {
    initRunRetentionQueue(redisUrl);
    startRunRetentionWorker();
    void scheduleRunRetention();
    app.log.info('Run retention queue initialized');
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize run retention queue');
  }

  // Initialize plex token refresh queue (renews strong-PIN JWT tokens before they expire)
  try {
    initPlexTokenRefreshQueue(redisUrl);
    startPlexTokenRefreshWorker();
    void schedulePlexTokenRefresh();
    app.log.info('Plex token refresh queue initialized');
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize plex token refresh queue');
    // Don't throw - legacy tokens don't need refreshing and login has its own fallback
  }

  // Initialize SSE manager and processor for real-time Plex updates
  try {
    await sseManager.initialize(cacheService, pubSubService);
    initializeSSEProcessor(cacheService, pubSubService);
    app.log.info('SSE manager initialized');
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize SSE manager');
    // Don't throw - SSE is optional, fallback to polling
  }

  // Monitor the main Redis client for mid-operation failures.
  // When Redis disconnects, transition to maintenance mode so the
  // maintenance gate returns 503 instead of letting requests fail with 500.
  // When Redis reconnects, transition back to ready.
  //
  // Remove previous listeners first to prevent stacking if initializeServices
  // runs again after maintenance recovery.
  if (redisCloseHandler) app.redis.removeListener('close', redisCloseHandler);
  if (redisReadyHandler) app.redis.removeListener('ready', redisReadyHandler);

  redisCloseHandler = () => {
    setRedisHealthy(false);
    if (isServicesInitialized() && !isMaintenance()) {
      app.log.warn('Redis connection lost — entering MAINTENANCE mode');
      setServerMode('maintenance');
    }
  };
  redisReadyHandler = () => {
    setRedisHealthy(true);
    void (async () => {
      if (isServicesInitialized() && isMaintenance()) {
        // Redis is back — verify DB is also reachable before going ready
        const dbOk = await checkDatabaseConnection();
        if (dbOk) {
          app.log.info('Redis reconnected and database is reachable — returning to READY mode');
          setServerMode('ready');
        } else {
          app.log.warn(
            'Redis reconnected but database is still unreachable — staying in MAINTENANCE mode'
          );
        }
      }
    })();
  };
  app.redis.on('close', redisCloseHandler);
  app.redis.on('ready', redisReadyHandler);

  // Monitor database connectivity with periodic health checks.
  // Unlike Redis (which emits connection events), pg-pool doesn't notify on
  // connection loss, so we poll instead.
  dbHealthInterval = setInterval(() => {
    void (async () => {
      if (!isServicesInitialized()) return;

      const dbOk = await checkDatabaseConnection();
      setDbHealthy(dbOk);

      if (dbOk) {
        await refreshTimescaleCache();
        retryDegradedCompressionPolicy().catch((err) => {
          app.log.warn({ err }, 'Failed to retry degraded compression policy');
        });
      } else {
        cachedTimescale = null;
      }

      if (!dbOk && !isMaintenance()) {
        app.log.warn('Database connection lost — entering MAINTENANCE mode');
        setServerMode('maintenance');
      } else if (dbOk && isMaintenance() && isRedisHealthy()) {
        app.log.info('Database reconnected and Redis is ready — returning to READY mode');
        setServerMode('ready');
      }
    })();
  }, DB_HEALTH_CHECK_MS);
  registerService('db-health-check', {
    name: 'DB Health Check',
    description: 'Monitors database connectivity',
    intervalMs: DB_HEALTH_CHECK_MS,
  });

  // Initialize Tailscale VPN service (starts daemon if previously enabled)
  try {
    await tailscaleService.initialize();
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize Tailscale service');
    // Don't throw — Tailscale is non-critical
  }

  setDbHealthy(true);
  await refreshTimescaleCache();
  setServicesInitialized(true);
  setLastMigrationError(null);
  setInitStep(null);
  setServerMode('ready');
}

// ============================================================================
// Post-listen initialization (WebSocket, pub/sub subscriber, poller, SSE)
// ============================================================================

async function initializePostListen(app: FastifyInstance) {
  // Initialize WebSocket server using Fastify's underlying HTTP server
  const httpServer = app.server;
  initializeWebSocket(httpServer, BASE_PATH, app.redis);
  app.log.info('WebSocket server initialized');

  // Set up Redis pub/sub to forward events to WebSocket clients
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  wsSubscriber = new Redis(redisUrl);
  wsSubscriber.on('error', (err: Error) => {
    app.log.error({ err }, 'WebSocket subscriber Redis error');
  });

  void wsSubscriber.subscribe(REDIS_KEYS.PUBSUB_EVENTS, (err) => {
    if (err) {
      app.log.error({ err }, 'Failed to subscribe to pub/sub channel');
    } else {
      app.log.info('Subscribed to pub/sub channel for WebSocket events');
    }
  });

  wsSubscriber.on('message', (_channel: string, message: string) => {
    try {
      const { event, data } = JSON.parse(message) as {
        event: string;
        data: unknown;
        timestamp: number;
      };

      // Forward events to WebSocket clients
      switch (event) {
        case WS_EVENTS.SESSION_STARTED:
          broadcastToSessions('session:started', data as ActiveSession);
          break;
        case WS_EVENTS.SESSION_STOPPED:
          broadcastToSessions('session:stopped', data as string);
          break;
        case WS_EVENTS.SESSION_UPDATED:
          broadcastToSessions('session:updated', data as ActiveSession);
          break;
        case WS_EVENTS.VIOLATION_NEW:
          broadcastToSessions('violation:new', data as ViolationWithDetails);
          break;
        case WS_EVENTS.RUN_FINISHED:
          broadcastToSessions('run:finished', data as RunFinishedEvent[]);
          break;
        case WS_EVENTS.STATS_UPDATED:
          broadcastToSessions('stats:updated', data as DashboardStats);
          break;
        case WS_EVENTS.IMPORT_PROGRESS:
          broadcastToSessions('import:progress', data as TautulliImportProgress);
          break;
        case WS_EVENTS.IMPORT_JELLYSTAT_PROGRESS:
          broadcastToSessions('import:jellystat:progress', data as JellystatImportProgress);
          break;
        case WS_EVENTS.IMPORT_PLAYBACK_REPORTING_PROGRESS:
          broadcastToSessions(
            'import:playbackreporting:progress',
            data as PlaybackReportingImportProgress
          );
          break;
        case WS_EVENTS.MAINTENANCE_PROGRESS:
          broadcastToSessions('maintenance:progress', data as MaintenanceJobProgress);
          break;
        case WS_EVENTS.LIBRARY_SYNC_PROGRESS:
          broadcastToSessions('library:sync:progress', data as LibrarySyncProgress);
          break;
        case WS_EVENTS.VERSION_UPDATE:
          broadcastToSessions(
            'version:update',
            data as { current: string; latest: string; releaseUrl: string }
          );
          break;
        case WS_EVENTS.DESTINATIONS_CHANGED:
          invalidateDestinationsCache();
          broadcastToSessions('destinations:changed');
          break;
        case WS_EVENTS.SERVERS_CHANGED:
          invalidateServersCache();
          broadcastToSessions('servers:changed');
          break;
        case WS_EVENTS.NOTIFICATION_TOAST:
          broadcastToSessions('notification:toast', data as NotificationToast);
          break;
        case WS_EVENTS.SERVER_DOWN:
          broadcastToSessions('server:down', data as { serverId: string; serverName: string });
          break;
        case WS_EVENTS.SERVER_UP:
          broadcastToSessions('server:up', data as { serverId: string; serverName: string });
          break;
        default:
          // Unknown event, ignore
          break;
      }
    } catch (err) {
      app.log.error({ err, message }, 'Failed to process pub/sub message');
    }
  });

  // The session producers (poller loop + SSE connections) run on exactly one
  // instance: N instances would otherwise open N connections per media server
  // and poll N times. The leader lease gates them; HTTP, Socket.io, pub/sub,
  // and the BullMQ workers above run on every instance.
  const startProducers = async (): Promise<void> => {
    const pollerSettings = await getPollerSettings();
    if (pollerSettings.enabled) {
      startPoller({ enabled: true, intervalMs: pollerSettings.intervalMs });
    } else {
      app.log.info('Session poller disabled in settings');
    }

    try {
      // Clean up any orphaned pending sessions from the previous leader
      await cleanupOrphanedPendingSessions();
      startSSEProcessor(); // Subscribe to SSE events
      startPluginUpdateChecker();
      startServerUpdateChecker();
      await sseManager.start(); // Start SSE connections
      app.log.info('Real-time SSE connections started');
    } catch (err) {
      app.log.error({ err }, 'Failed to start SSE connections - falling back to polling');
    }

    try {
      await rehydratePauseWakes();
    } catch (err) {
      app.log.error({ err }, 'Failed to rehydrate pause wakes');
    }

    // One bounded pass per leadership term; nothing else sweeps these rows.
    void backfillMissingServerIdentifiers(app.log)
      .then((filled) => {
        if (filled > 0) app.log.info(`Recorded identifiers for ${filled} server(s)`);
      })
      .catch((err: unknown) => {
        app.log.debug({ err }, 'Server identifier backfill failed');
      });
  };

  const stopProducers = async (): Promise<void> => {
    stopPoller();
    stopSSEProcessor();
    stopPauseWakes();
    stopPluginUpdateChecker();
    stopServerUpdateChecker();
    await sseManager.stop();
  };

  await startLeaderLease(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    onAcquired: startProducers,
    onLost: stopProducers,
  });

  // Log network settings status
  const networkSettings = await getNetworkSettings();
  const envTrustProxy = process.env.TRUST_PROXY === 'true';
  if (networkSettings.trustProxy && !envTrustProxy) {
    app.log.warn(
      'Trust proxy is enabled in settings but TRUST_PROXY env var is not set. ' +
        'Set TRUST_PROXY=true and restart for reverse proxy support.'
    );
  }
  if (networkSettings.externalUrl) {
    app.log.info(`External URL configured: ${networkSettings.externalUrl}`);
  }

  // Kick off any pending historical aggregate backfill now that the server is
  // accepting traffic. Recent data is already available from the bounded
  // refresh initTimescaleDB() did synchronously; this fills in older history
  // in the background without blocking startup or the startup probe.
  if (pendingAggregateBackfill && !aggregateBackfillRunning) {
    const targetVersion = pendingAggregateBackfill.targetVersion;
    pendingAggregateBackfill = null;
    aggregateBackfillRunning = true;
    void runAggregateBackfill(targetVersion)
      .catch((err) => {
        app.log.error({ err }, 'Aggregate backfill failed unexpectedly');
      })
      .finally(() => {
        aggregateBackfillRunning = false;
      });
  }
}

// ============================================================================
// Recovery loop — probes DB/Redis and transitions out of maintenance mode
// ============================================================================

function startRecoveryLoop(app: FastifyInstance, intervalMs: number = RECOVERY_INTERVAL_MS) {
  if (recoveryInterval) {
    clearInterval(recoveryInterval);
    recoveryInterval = null;
  }
  let tickInFlight = false;
  recoveryInterval = setInterval(() => {
    void (async () => {
      // A probe against a hung-but-connected Postgres can outlive the
      // interval; without this guard two ticks could both reach
      // initializeServices and double-start every queue worker
      if (tickInFlight) return;
      tickInFlight = true;
      try {
        await runRecoveryTick();
      } finally {
        tickInFlight = false;
      }
    })();
  }, intervalMs);

  async function runRecoveryTick(): Promise<void> {
    {
      if (isRestoring()) {
        app.log.info('Recovery check skipped — restore in progress');
        return;
      }

      app.log.info('Recovery check: probing database and Redis...');

      const dbOk = await checkDatabaseConnection();
      setDbHealthy(dbOk);
      let redisOk: boolean;
      try {
        const testRedis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
          connectTimeout: 5000,
          maxRetriesPerRequest: 1,
          lazyConnect: true,
          retryStrategy: () => null,
        });
        testRedis.on('error', noop); // Suppress — failure is handled via catch
        try {
          await testRedis.connect();
          const pong = await testRedis.ping();
          redisOk = pong === 'PONG';
        } finally {
          testRedis.disconnect();
        }
      } catch {
        redisOk = false;
      }
      setRedisHealthy(redisOk);

      if (dbOk && redisOk) {
        if (recoveryInterval) {
          clearInterval(recoveryInterval);
          recoveryInterval = null;
        }
        app.log.info('Database and Redis are now available — initializing services...');

        try {
          await initializeServices(app);
          await initializePostListen(app);
          setRestoreProgress(null);
          app.log.info('Server transitioned to READY mode');
        } catch (err) {
          // Connectivity just succeeded above, so this is a migration/init failure -
          // back off to the slower cadence rather than hammering it every 10s.
          app.log.error({ err }, 'Failed to initialize after recovery — restarting recovery loop');
          lastInitFailureKind = 'migration';
          setLastMigrationError('migration or startup initialization failed - see server logs');
          setInitStep(null);
          setServerMode('maintenance');
          startRecoveryLoop(app, MIGRATION_RETRY_INTERVAL_MS);
        }
      } else {
        app.log.info(`Recovery check: services still unavailable (db:${dbOk}, redis:${redisOk})`);
      }
    }
  }
}

// ============================================================================
// Server entrypoint
// ============================================================================

async function start() {
  try {
    // Initialize claim code for first-time setup security
    initializeClaimCode();

    const app = await buildApp();

    // Handle graceful shutdown - use process.once to prevent handler stacking in test/restart scenarios
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    for (const signal of signals) {
      process.once(signal, () => {
        app.log.info(`Received ${signal}, shutting down gracefully...`);
        stopPoller();
        void stopConnectionBudget(app.redis);
        void tailscaleService.shutdown();
        void Promise.all([shutdownNotificationQueue(), shutdownNewsletterQueues()]).finally(() =>
          closeAllTransporters()
        );
        void shutdownKillQueue();
        void shutdownImportQueue();
        void shutdownLibrarySyncQueue();
        void shutdownImagePrecacheQueue();
        void shutdownVersionCheckQueue();
        void shutdownInactivityCheckQueue();
        void shutdownBackupQueue();
        void shutdownPlexTokenRefreshQueue();
        void shutdownRunRetentionQueue();
        void app.close().then(() => process.exit(0));
      });
    }

    // Tear down / rebuild services when transitioning in/out of maintenance mode.
    // This prevents log flooding from Redis clients and BullMQ workers that keep
    // trying to reconnect after Redis goes down.
    onModeChange((newMode, prevMode) => {
      if (newMode === 'maintenance' && prevMode === 'ready') {
        app.log.info('Entering maintenance mode — shutting down services');
        stopPoller();
        stopSSEProcessor();
        stopPauseWakes();
        stopPluginUpdateChecker();
        void sseManager
          .stop()
          .then(() => stopLeaderLease())
          .catch(() => stopLeaderLease());
        void tailscaleService.shutdown();

        // Disconnect extra Redis clients to stop reconnection attempts
        if (pubSubRedis) {
          pubSubRedis.disconnect();
          pubSubRedis = null;
        }
        if (wsSubscriber) {
          wsSubscriber.disconnect();
          wsSubscriber = null;
        }

        // Shut down BullMQ workers/queues (closes their internal Redis connections)
        void Promise.all([
          shutdownNotificationQueue(),
          shutdownKillQueue(),
          shutdownImportQueue(),
          shutdownMaintenanceQueue(),
          shutdownLibrarySyncQueue(),
          shutdownImagePrecacheQueue(),
          shutdownVersionCheckQueue(),
          shutdownInactivityCheckQueue(),
          shutdownBackupQueue(),
          shutdownNewsletterQueues(),
          shutdownPlexTokenRefreshQueue(),
          shutdownRunRetentionQueue(),
        ])
          .finally(() => closeAllTransporters())
          .catch((err: unknown) => {
            app.log.error({ err }, 'Error shutting down queues during maintenance');
          });

        // Stop the DB health interval — initializeServices will recreate it on recovery.
        if (dbHealthInterval) {
          clearInterval(dbHealthInterval);
          dbHealthInterval = null;
          unregisterService('db-health-check');
        }
        setDbHealthy(false);

        // Clear timers that won't fire correctly without Redis/DB
        if (pushReceiptInterval) {
          clearInterval(pushReceiptInterval);
          pushReceiptInterval = null;
          unregisterService('push-receipts');
        }
        if (mobileTokenCleanupInterval) {
          clearInterval(mobileTokenCleanupInterval);
          mobileTokenCleanupInterval = null;
          unregisterService('mobile-token-cleanup');
        }

        // Reset so recovery loop can re-run initializeServices + initializePostListen
        setServicesInitialized(false);

        startRecoveryLoop(app);
      }
    });

    await app.listen({ port: PORT, host: HOST });
    app.log.info(`Server running at http://${HOST}:${PORT}`);
    if (BASE_PATH) {
      app.log.info(`Base path: ${BASE_PATH}`);
    }

    if (isDbHealthy() && isRedisHealthy()) {
      try {
        await initializeServices(app);
        await initializePostListen(app);
        app.log.info('Server transitioned to READY mode');
      } catch (err) {
        // Connectivity was fine - a migration or other init failure, which is
        // usually deterministic. Stay in maintenance (API 503s, /health and
        // the SPA maintenance page stay reachable) and retry on an interval
        // instead of exiting: exiting would restart the container into the
        // exact same failure, forever.
        lastInitFailureKind = 'migration';
        setLastMigrationError('migration or startup initialization failed - see server logs');
        setInitStep(null);
        setServerMode('maintenance');
        app.log.error(
          { err },
          'Failed to initialize services after listen - staying in MAINTENANCE mode; will retry automatically'
        );
        startRecoveryLoop(app, MIGRATION_RETRY_INTERVAL_MS);
      }
    } else {
      app.log.warn('Waiting for database and Redis to become available...');
      startRecoveryLoop(
        app,
        pickRecoveryIntervalMs(
          lastInitFailureKind,
          RECOVERY_INTERVAL_MS,
          MIGRATION_RETRY_INTERVAL_MS
        )
      );
    }
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Last-resort safety net. Individual handlers (SSE processor, poller, queues)
// already catch their own errors; this only catches rejections that slipped
// every local boundary. It logs loudly and keeps the process alive so a single
// transient Redis/Postgres blip on a background tick cannot take the server
// down. Tradeoff: a genuinely fatal rejection no longer crashes the process, so
// a latent bug can be masked - the loud log is the signal to investigate.
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled promise rejection (kept alive):', reason);
});

void start();
