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
import { API_BASE_PATH, REDIS_KEYS, WS_EVENTS } from '@tracearr/shared';

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
  ViolationWithDetails,
  DashboardStats,
  TautulliImportProgress,
  JellystatImportProgress,
  MaintenanceJobProgress,
  LibrarySyncProgress,
} from '@tracearr/shared';

import authPlugin, { loadJwtRevokeSettings } from './plugins/auth.js';
import redisPlugin, { connectRedis } from './plugins/redis.js';
import { authRoutes } from './routes/auth/index.js';
import { setupRoutes } from './routes/setup.js';
import { serverRoutes } from './routes/servers.js';
import { userRoutes } from './routes/users/index.js';
import { sessionRoutes } from './routes/sessions.js';
import { ruleRoutes } from './routes/rules.js';
import { violationRoutes } from './routes/violations.js';
import { statsRoutes } from './routes/stats/index.js';
import { settingsRoutes } from './routes/settings.js';
import { importRoutes } from './routes/import.js';
import { imageRoutes } from './routes/images.js';
import { stopImageCacheCleanup } from './services/imageProxy.js';
import { debugRoutes } from './routes/debug.js';
import { mobileRoutes } from './routes/mobile.js';
import { notificationPreferencesRoutes } from './routes/notificationPreferences.js';
import { channelRoutingRoutes } from './routes/channelRouting.js';
import { versionRoutes } from './routes/version.js';
import { maintenanceRoutes } from './routes/maintenance.js';
import { publicRoutes } from './routes/public.js';
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
import { geoipService } from './services/geoip.js';
import { tailscaleService } from './services/tailscale.js';
import { geoasnService } from './services/geoasn.js';
import { createCacheService, createPubSubService } from './services/cache.js';
import { initializePoller, startPoller, stopPoller } from './jobs/poller/index.js';
import { sseManager } from './services/sseManager.js';
import {
  initializeSSEProcessor,
  startSSEProcessor,
  stopSSEProcessor,
  cleanupOrphanedPendingSessions,
} from './jobs/sseProcessor.js';
import { initializeWebSocket, broadcastToSessions } from './websocket/index.js';
import {
  initNotificationQueue,
  startNotificationWorker,
  shutdownNotificationQueue,
} from './jobs/notificationQueue.js';
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
import { initHeavyOpsLock } from './jobs/heavyOpsLock.js';
import { initPushRateLimiter } from './services/pushRateLimiter.js';
import { initializeV2Rules } from './services/rules/v2Integration.js';
import { processPushReceipts } from './services/pushNotification.js';
import { cleanupMobileTokens } from './jobs/cleanupMobileTokens.js';
import { db, checkDatabaseConnection, runMigrations } from './db/client.js';
import { initTimescaleDB, getTimescaleStatus, updateTimescaleExtensions } from './db/timescale.js';
import { eq } from 'drizzle-orm';
import { servers } from './db/schema.js';
import { initializeClaimCode } from './utils/claimCode.js';
import { registerService, unregisterService } from './services/serviceTracker.js';
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
} from './serverState.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const RECOVERY_INTERVAL_MS = 10_000;

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

/** Cached timescale status — refreshed by the DB health interval. */
let cachedTimescale: {
  installed: boolean;
  hypertable: boolean;
  compression: boolean;
  aggregates: number;
  chunks: number;
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
    };
  } catch {
    cachedTimescale = null;
  }
}

// basePath from env var — always known at startup, never changes at runtime.
const BASE_PATH = process.env.BASE_PATH?.replace(/\/+$/, '').replace(/^\/?/, '/') || '';

// ============================================================================
// Phase 1: Build the Fastify app (always succeeds, even without DB/Redis)
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
  app.get('/health', () => {
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
    };
  });

  // API routes — registered now but gated by the maintenance hook above
  await app.register(setupRoutes, { prefix: `${API_BASE_PATH}/setup` });
  await app.register(authRoutes, { prefix: `${API_BASE_PATH}/auth` });
  await app.register(serverRoutes, { prefix: `${API_BASE_PATH}/servers` });
  await app.register(userRoutes, { prefix: `${API_BASE_PATH}/users` });
  await app.register(sessionRoutes, { prefix: `${API_BASE_PATH}/sessions` });
  await app.register(ruleRoutes, { prefix: `${API_BASE_PATH}/rules` });
  await app.register(violationRoutes, { prefix: `${API_BASE_PATH}/violations` });
  await app.register(statsRoutes, { prefix: `${API_BASE_PATH}/stats` });
  await app.register(settingsRoutes, { prefix: `${API_BASE_PATH}/settings` });
  await app.register(channelRoutingRoutes, { prefix: `${API_BASE_PATH}/settings/notifications` });
  await app.register(importRoutes, { prefix: `${API_BASE_PATH}/import` });
  await app.register(imageRoutes, { prefix: `${API_BASE_PATH}/images` });
  await app.register(debugRoutes, { prefix: `${API_BASE_PATH}/debug` });
  await app.register(mobileRoutes, { prefix: `${API_BASE_PATH}/mobile` });
  await app.register(notificationPreferencesRoutes, { prefix: `${API_BASE_PATH}/notifications` });
  await app.register(versionRoutes, { prefix: `${API_BASE_PATH}/version` });
  await app.register(maintenanceRoutes, { prefix: `${API_BASE_PATH}/maintenance` });
  await app.register(tailscaleRoutes, { prefix: `${API_BASE_PATH}/tailscale` });
  await app.register(tasksRoutes, { prefix: `${API_BASE_PATH}/tasks` });
  await app.register(publicRoutes, { prefix: `${API_BASE_PATH}/public` });
  await app.register(libraryRoutes, { prefix: `${API_BASE_PATH}/library` });
  await app.register(backupRoutes, { prefix: `${API_BASE_PATH}/backup` });

  // Serve static frontend in production
  const webDistPath = resolve(PROJECT_ROOT, 'apps/web/dist');

  if (process.env.NODE_ENV === 'production' && existsSync(webDistPath)) {
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

      // Serve static files (paths with a file extension)
      if (urlPath !== '/' && /\.\w+$/.test(urlPath)) {
        const fullPath = resolve(webDistPath, urlPath.slice(1));
        if (existsSync(fullPath)) {
          return reply.sendFile(urlPath.slice(1));
        }
      }

      // SPA fallback — always inject <base> tag so relative asset paths (./assets/...)
      // resolve correctly on nested routes like /library/watch
      const baseHref = BASE_PATH ? `${BASE_PATH}/` : '/';
      const html = cachedIndexHtml.replace('<head>', `<head>\n    <base href="${baseHref}">`);
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
    stopImageCacheCleanup();
    if (pubSubRedis) await pubSubRedis.quit();
    if (wsSubscriber) await wsSubscriber.quit();
    stopPoller();
    await sseManager.stop();
    await tailscaleService.shutdown();
    stopSSEProcessor();
    await shutdownNotificationQueue();
    await shutdownImportQueue();
    await shutdownMaintenanceQueue();
    await shutdownLibrarySyncQueue();
    await shutdownVersionCheckQueue();
    await shutdownInactivityCheckQueue();
    await shutdownBackupQueue();
  });

  // Probe DB and Redis to decide if we can initialize services now
  const dbOk = await checkDatabaseConnection();
  let redisOk = false;
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

  if (dbOk && redisOk) {
    await initializeServices(app);
  } else {
    setServerMode('maintenance');
    app.log.warn(
      { db: dbOk, redis: redisOk },
      'Server starting in MAINTENANCE mode — database or Redis unavailable'
    );
  }

  return app;
}

// ============================================================================
// Phase 2: Initialize all DB/Redis-dependent services
// ============================================================================

async function initializeServices(app: FastifyInstance) {
  if (isServicesInitialized()) return;

  // Connect the lazy Redis client
  await connectRedis(app);

  // Update TimescaleDB extensions before migrations — must happen before any
  // query touches timescaledb objects, otherwise the old version gets locked in.
  // Opt-in only: requires ALTER EXTENSION privilege, which managed DB hosts often lack.
  // Note: we generally dont want users to update extensions since it can cause issues.
  //
  // This is disabled for now, but the code is left in place for a rainy day.
  // Future devs: do not remove this functionality.
  // eslint-disable-next-line no-constant-condition
  if (false) {
    try {
      await updateTimescaleExtensions();
    } catch (err) {
      app.log.warn({ err }, 'Failed to update TimescaleDB extensions (non-fatal)');
    }
  }

  // Run database migrations
  try {
    app.log.info('Running database migrations...');
    await runMigrations(MIGRATIONS_PATH);
    app.log.info('Database migrations complete');
  } catch (err) {
    app.log.error({ err }, 'Failed to run database migrations');
    throw err;
  }

  // Build prepared statements now that the db pool is ready
  const { initPreparedStatements } = await import('./db/prepared.js');
  initPreparedStatements();

  // Load JWT revoke settings — ensures tokens issued before a prior restore are rejected
  await loadJwtRevokeSettings();

  // Initialize TimescaleDB features (hypertable, compression, aggregates)
  try {
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
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize TimescaleDB - continuing without optimization');
    // Don't throw - app can still work without TimescaleDB features
  }

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

  // Initialize V2 rules system (wire dependencies, run migration)
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

  // Initialize push notification rate limiter (uses Redis for sliding window counters)
  initPushRateLimiter(app.redis);
  app.log.info('Push notification rate limiter initialized');

  try {
    initNotificationQueue(redisUrl);
    startNotificationWorker();
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

  // Initialize poller with cache services
  initializePoller(cacheService, pubSubService);

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
        case WS_EVENTS.STATS_UPDATED:
          broadcastToSessions('stats:updated', data as DashboardStats);
          break;
        case WS_EVENTS.IMPORT_PROGRESS:
          broadcastToSessions('import:progress', data as TautulliImportProgress);
          break;
        case WS_EVENTS.IMPORT_JELLYSTAT_PROGRESS:
          broadcastToSessions('import:jellystat:progress', data as JellystatImportProgress);
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
        default:
          // Unknown event, ignore
          break;
      }
    } catch (err) {
      app.log.error({ err, message }, 'Failed to process pub/sub message');
    }
  });

  // Start session poller after server is listening (uses DB settings)
  const pollerSettings = await getPollerSettings();
  if (pollerSettings.enabled) {
    startPoller({ enabled: true, intervalMs: pollerSettings.intervalMs });
  } else {
    app.log.info('Session poller disabled in settings');
  }

  // Start SSE connections for Plex servers (real-time updates)
  try {
    // Clean up any orphaned pending sessions from previous server instance
    await cleanupOrphanedPendingSessions();
    startSSEProcessor(); // Subscribe to SSE events
    await sseManager.start(); // Start SSE connections
    app.log.info('SSE connections started for Plex servers');
  } catch (err) {
    app.log.error({ err }, 'Failed to start SSE connections - falling back to polling');
  }

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
}

// ============================================================================
// Recovery loop — probes DB/Redis and transitions out of maintenance mode
// ============================================================================

function startRecoveryLoop(app: FastifyInstance) {
  if (recoveryInterval) {
    clearInterval(recoveryInterval);
    recoveryInterval = null;
  }
  recoveryInterval = setInterval(() => {
    void (async () => {
      if (isRestoring()) {
        app.log.info('Recovery check skipped — restore in progress');
        return;
      }

      app.log.info('Recovery check: probing database and Redis...');

      const dbOk = await checkDatabaseConnection();
      setDbHealthy(dbOk);
      let redisOk = false;
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
          app.log.error({ err }, 'Failed to initialize after recovery — restarting recovery loop');
          setServerMode('maintenance');
          startRecoveryLoop(app);
        }
      } else {
        app.log.info(`Recovery check: services still unavailable (db:${dbOk}, redis:${redisOk})`);
      }
    })();
  }, RECOVERY_INTERVAL_MS);
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
        void tailscaleService.shutdown();
        void shutdownNotificationQueue();
        void shutdownImportQueue();
        void shutdownLibrarySyncQueue();
        void shutdownVersionCheckQueue();
        void shutdownInactivityCheckQueue();
        void shutdownBackupQueue();
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
        void sseManager.stop();
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
          shutdownImportQueue(),
          shutdownMaintenanceQueue(),
          shutdownLibrarySyncQueue(),
          shutdownVersionCheckQueue(),
          shutdownInactivityCheckQueue(),
          shutdownBackupQueue(),
        ]).catch((err) => {
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

    if (isMaintenance()) {
      app.log.warn('Waiting for database and Redis to become available...');
      startRecoveryLoop(app);
    } else {
      await initializePostListen(app);
    }
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

void start();
