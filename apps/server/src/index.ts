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
import { existsSync } from 'node:fs';
import { Redis } from 'ioredis';
import { API_BASE_PATH, REDIS_KEYS, WS_EVENTS } from '@tracearr/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Project root directory (apps/server/src -> project root)
const PROJECT_ROOT = resolve(__dirname, '../../..');

// Load .env from project root
config({ path: resolve(PROJECT_ROOT, '.env'), quiet: true });

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

import authPlugin from './plugins/auth.js';
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
import { tasksRoutes } from './routes/tasks.js';
import { getPollerSettings, getNetworkSettings } from './routes/settings.js';
import { initializeEncryption, migrateToken, looksEncrypted } from './utils/crypto.js';
import { geoipService } from './services/geoip.js';
import { geoasnService } from './services/geoasn.js';
import { createCacheService, createPubSubService } from './services/cache.js';
import { initializePoller, startPoller, stopPoller } from './jobs/poller/index.js';
import { sseManager } from './services/sseManager.js';
import {
  initializeSSEProcessor,
  startSSEProcessor,
  stopSSEProcessor,
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
  initTrafficCheckQueue,
  startTrafficCheckWorker,
  scheduleTrafficChecks,
  shutdownTrafficCheckQueue,
} from './jobs/trafficCheckQueue.js';
import { initHeavyOpsLock } from './jobs/heavyOpsLock.js';
import { initPushRateLimiter } from './services/pushRateLimiter.js';
import { initializeV2Rules } from './services/rules/v2Integration.js';
import { processPushReceipts } from './services/pushNotification.js';
import { cleanupMobileTokens } from './jobs/cleanupMobileTokens.js';
import { db, checkDatabaseConnection, runMigrations } from './db/client.js';
import { initTimescaleDB, getTimescaleStatus } from './db/timescale.js';
import { sql, eq } from 'drizzle-orm';
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
const DB_HEALTH_CHECK_MS = 15_000;

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
  });

  // Maintenance gate hook — MUST be registered before rate limiter so it
  // short-circuits requests before the rate limiter tries to access Redis
  app.addHook('onRequest', async (request, reply) => {
    // Always allow health endpoint
    if (request.url === '/health') return;

    // Allow static files (non-API routes) so frontend can load and show maintenance page
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

  // Utility plugins
  await app.register(sensible);
  await app.register(cookie, {
    secret: process.env.COOKIE_SECRET,
  });

  // Redis plugin (lazyConnect — does not attempt connection yet)
  await app.register(redisPlugin);

  // Auth plugin (depends on cookie, uses JWT — no Redis dependency)
  await app.register(authPlugin);

  // Health check endpoint — always reachable, even in maintenance mode
  app.get('/health', async () => {
    let dbHealthy = false;
    let redisHealthy = false;

    // Check database
    try {
      await db.execute(sql`SELECT 1`);
      dbHealthy = true;
    } catch {
      dbHealthy = false;
    }

    // Check Redis — trust ioredis connection state instead of probing.
    // The client's status is updated internally via TCP events, so 'ready'
    // means the connection is live. No ping round-trip needed.
    redisHealthy = app.redis.status === 'ready';

    const mode = getServerMode();

    // Only include extended info when fully ready
    if (mode === 'ready') {
      let timescale = null;
      try {
        const tsStatus = await getTimescaleStatus();
        timescale = {
          installed: tsStatus.extensionInstalled,
          hypertable: tsStatus.sessionsIsHypertable,
          compression: tsStatus.compressionEnabled,
          aggregates: tsStatus.continuousAggregates.length,
          chunks: tsStatus.chunkCount,
        };
      } catch {
        timescale = {
          installed: false,
          hypertable: false,
          compression: false,
          aggregates: 0,
          chunks: 0,
        };
      }

      return {
        status: dbHealthy && redisHealthy ? 'ok' : 'degraded',
        mode,
        db: dbHealthy,
        redis: redisHealthy,
        geoip: geoipService.hasDatabase(),
        timescale,
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
  await app.register(tasksRoutes, { prefix: `${API_BASE_PATH}/tasks` });
  await app.register(publicRoutes, { prefix: `${API_BASE_PATH}/public` });
  await app.register(libraryRoutes, { prefix: `${API_BASE_PATH}/library` });

  // Serve static frontend in production
  const webDistPath = resolve(PROJECT_ROOT, 'apps/web/dist');
  if (process.env.NODE_ENV === 'production' && existsSync(webDistPath)) {
    await app.register(fastifyStatic, {
      root: webDistPath,
      prefix: '/',
    });

    // SPA fallback - serve index.html for all non-API routes
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url === '/health') {
        return reply.code(404).send({ error: 'Not Found' });
      }
      return reply.sendFile('index.html');
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
    stopSSEProcessor();
    await shutdownNotificationQueue();
    await shutdownImportQueue();
    await shutdownMaintenanceQueue();
    await shutdownLibrarySyncQueue();
    await shutdownVersionCheckQueue();
    await shutdownInactivityCheckQueue();
    await shutdownTrafficCheckQueue();
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

  // Run database migrations
  try {
    app.log.info('Running database migrations...');
    await runMigrations(MIGRATIONS_PATH);
    app.log.info('Database migrations complete');
  } catch (err) {
    app.log.error({ err }, 'Failed to run database migrations');
    throw err;
  }

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

  // Initialize traffic check queue (monitors bandwidth usage limits)
  try {
    initTrafficCheckQueue(redisUrl, app.redis, pubSubService.publish.bind(pubSubService));
    startTrafficCheckWorker();
    void scheduleTrafficChecks();
    app.log.info('Traffic check queue initialized');
  } catch (err) {
    app.log.error({ err }, 'Failed to initialize traffic check queue');
    // Don't throw - traffic checks are non-critical
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
    if (isServicesInitialized() && !isMaintenance()) {
      app.log.warn('Redis connection lost — entering MAINTENANCE mode');
      setServerMode('maintenance');
    }
  };
  redisReadyHandler = () => {
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

      if (!dbOk && !isMaintenance()) {
        app.log.warn('Database connection lost — entering MAINTENANCE mode');
        setServerMode('maintenance');
      } else if (dbOk && isMaintenance() && app.redis.status === 'ready') {
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

  setServicesInitialized(true);
  setServerMode('ready');
}

// ============================================================================
// Post-listen initialization (WebSocket, pub/sub subscriber, poller, SSE)
// ============================================================================

async function initializePostListen(app: FastifyInstance) {
  // Initialize WebSocket server using Fastify's underlying HTTP server
  const httpServer = app.server;
  initializeWebSocket(httpServer);
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
  if (networkSettings.basePath) {
    app.log.info(`Base path configured: ${networkSettings.basePath}`);
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
      app.log.info('Recovery check: probing database and Redis...');

      const dbOk = await checkDatabaseConnection();
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

      if (dbOk && redisOk) {
        if (recoveryInterval) {
          clearInterval(recoveryInterval);
          recoveryInterval = null;
        }
        app.log.info('Database and Redis are now available — initializing services...');

        try {
          await initializeServices(app);
          await initializePostListen(app);
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
        void shutdownNotificationQueue();
        void shutdownImportQueue();
        void shutdownLibrarySyncQueue();
        void shutdownVersionCheckQueue();
        void shutdownInactivityCheckQueue();
        void shutdownTrafficCheckQueue();
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
          shutdownTrafficCheckQueue(),
        ]).catch((err) => {
          app.log.error({ err }, 'Error shutting down queues during maintenance');
        });

        // Stop the DB health interval — initializeServices will recreate it on recovery.
        if (dbHealthInterval) {
          clearInterval(dbHealthInterval);
          dbHealthInterval = null;
          unregisterService('db-health-check');
        }

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
