import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from 'dotenv';
import Fastify from 'fastify';
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
config({ path: resolve(PROJECT_ROOT, '.env') });

// GeoIP database path (in project root/data)
const GEOIP_DB_PATH = resolve(PROJECT_ROOT, 'data/GeoLite2-City.mmdb');

// Migrations path (relative to compiled output in production, source in dev)
const MIGRATIONS_PATH = resolve(__dirname, '../src/db/migrations');
import type {
  ActiveSession,
  ViolationWithDetails,
  DashboardStats,
  TautulliImportProgress,
} from '@tracearr/shared';

import authPlugin from './plugins/auth.js';
import redisPlugin from './plugins/redis.js';
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
import { debugRoutes } from './routes/debug.js';
import { mobileRoutes } from './routes/mobile.js';
import { notificationPreferencesRoutes } from './routes/notificationPreferences.js';
import { channelRoutingRoutes } from './routes/channelRouting.js';
import { versionRoutes } from './routes/version.js';
import { getPollerSettings, getNetworkSettings } from './routes/settings.js';
import { initializeEncryption, migrateToken, looksEncrypted } from './utils/crypto.js';
import { geoipService } from './services/geoip.js';
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
  initVersionCheckQueue,
  startVersionCheckWorker,
  scheduleVersionChecks,
  shutdownVersionCheckQueue,
} from './jobs/versionCheckQueue.js';
import { initPushRateLimiter } from './services/pushRateLimiter.js';
import { db, runMigrations } from './db/client.js';
import { initTimescaleDB, getTimescaleStatus } from './db/timescale.js';
import { sql, eq } from 'drizzle-orm';
import { servers } from './db/schema.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

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

  // Redis plugin
  await app.register(redisPlugin);

  // Auth plugin (depends on cookie)
  await app.register(authPlugin);

  // Create cache and pubsub services
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const pubSubRedis = new Redis(redisUrl);
  const cacheService = createCacheService(app.redis);
  const pubSubService = createPubSubService(app.redis, pubSubRedis);

  // Initialize push notification rate limiter (uses Redis for sliding window counters)
  initPushRateLimiter(app.redis);
  app.log.info('Push notification rate limiter initialized');

  // Initialize notification queue (uses Redis for job storage)
  try {
    initNotificationQueue(redisUrl);
    startNotificationWorker();
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

  // Cleanup pub/sub redis, notification queue, import queue, and version check queue on close
  app.addHook('onClose', async () => {
    await pubSubRedis.quit();
    stopPoller();
    await sseManager.stop();
    stopSSEProcessor();
    await shutdownNotificationQueue();
    await shutdownImportQueue();
    await shutdownVersionCheckQueue();
  });

  // Health check endpoint
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

    // Check Redis
    try {
      const pong = await app.redis.ping();
      redisHealthy = pong === 'PONG';
    } catch {
      redisHealthy = false;
    }

    // Check TimescaleDB status
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
      db: dbHealthy,
      redis: redisHealthy,
      geoip: geoipService.hasDatabase(),
      timescale,
    };
  });

  // API routes
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

  return app;
}

async function start() {
  try {
    const app = await buildApp();

    // Handle graceful shutdown
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    for (const signal of signals) {
      process.on(signal, () => {
        app.log.info(`Received ${signal}, shutting down gracefully...`);
        stopPoller();
        void shutdownNotificationQueue();
        void shutdownImportQueue();
        void shutdownVersionCheckQueue();
        void app.close().then(() => process.exit(0));
      });
    }

    await app.listen({ port: PORT, host: HOST });
    app.log.info(`Server running at http://${HOST}:${PORT}`);

    // Initialize WebSocket server using Fastify's underlying HTTP server
    const httpServer = app.server;
    initializeWebSocket(httpServer);
    app.log.info('WebSocket server initialized');

    // Set up Redis pub/sub to forward events to WebSocket clients
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const wsSubscriber = new Redis(redisUrl);

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

    // Handle graceful shutdown for WebSocket subscriber
    const cleanupWsSubscriber = () => {
      void wsSubscriber.quit();
    };
    process.on('SIGINT', cleanupWsSubscriber);
    process.on('SIGTERM', cleanupWsSubscriber);

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
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

void start();
