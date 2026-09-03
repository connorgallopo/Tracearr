/**
 * Debug routes - owner only
 *
 * Hidden utilities for development and troubleshooting.
 * All routes require owner authentication.
 */

import type { FastifyPluginAsync } from 'fastify';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { ZipArchive } from 'archiver';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { getActiveAggregateNames } from '../db/timescale.js';
import {
  clearStuckMaintenanceJobs,
  obliterateMaintenanceQueue,
  getMaintenanceQueueStats,
} from '../jobs/maintenanceQueue.js';
import { obliterateImportQueue, getImportQueueStats } from '../jobs/importQueue.js';
import { obliterateLibrarySyncQueue, getLibrarySyncQueueStats } from '../jobs/librarySyncQueue.js';
import { forceReleaseHeavyOpsLock } from '../jobs/heavyOpsLock.js';
import { getQueueStats as getNotificationQueueStats } from '../jobs/notificationQueue.js';
import { getVersionCheckQueueStats } from '../jobs/versionCheckQueue.js';
import {
  getCurrentVersion,
  getCurrentTag,
  getCurrentCommit,
  getBuildDate,
} from '../utils/buildInfo.js';
import { getInactivityCheckQueueStats } from '../jobs/inactivityCheckQueue.js';
import { invalidateAutomationsCache, invalidateServersCache } from '../jobs/poller/database.js';
import { getBackupQueueStats } from '../jobs/backupQueue.js';
import { getNewsletterQueueStats } from '../jobs/newsletterQueue.js';
import { resetSettingsCache } from '../services/settings.js';
import {
  invalidateDestinationsCache,
  publishDestinationsChanged,
} from '../services/notifications/destinationStore.js';
import { seedBuiltinDestinations } from '../services/notifications/destinationsMigration.js';
import { violationAliasConditions } from '../services/automations/aliasFilter.js';
import { getAllServices } from '../services/serviceTracker.js';
import { getAuth } from '../lib/auth.js';
import { revokeMobileDeviceSession } from './mobile.js';
import {
  sessions,
  automationRuns,
  users,
  servers,
  serverUsers,
  automations,
  automationTemplates,
  settings,
  mobileTokens,
  mobileSessions,
  notificationPreferences,
  destinations,
  terminationLogs,
  plexAccounts,
  libraryItems,
  librarySnapshots,
  authSessions,
} from '../db/schema.js';

// Read a cgroup file, returning null if unavailable
const readCgroup = async (path: string): Promise<string | null> => {
  try {
    const val = (await fs.readFile(path, 'utf8')).trim();
    return val && val !== 'max' ? val : null;
  } catch {
    return null;
  }
};

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

const getContainerInfo = async () => {
  const isDocker = await fs.access('/.dockerenv').then(
    () => true,
    () => false
  );

  const base = {
    isDocker,
    memoryLimit: formatBytes(os.totalmem()),
    memoryUsage: formatBytes(os.totalmem() - os.freemem()),
    cpuLimit: `${os.cpus().length} cores`,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
  };

  if (!isDocker) return base;

  // Try cgroup v2 first, then v1
  const [memLimit, memUsage, cpuMax] = await Promise.all([
    readCgroup('/sys/fs/cgroup/memory.max'),
    readCgroup('/sys/fs/cgroup/memory.current'),
    readCgroup('/sys/fs/cgroup/cpu.max'),
  ]);

  const [memLimitV1, memUsageV1, cpuQuota, cpuPeriod] = !memLimit
    ? await Promise.all([
        readCgroup('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
        readCgroup('/sys/fs/cgroup/memory/memory.usage_in_bytes'),
        readCgroup('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
        readCgroup('/sys/fs/cgroup/cpu/cpu.cfs_period_us'),
      ])
    : [null, null, null, null];

  // Override with cgroup values where available
  const memLimitBytes = parseInt(memLimit ?? memLimitV1 ?? '', 10);
  if (memLimitBytes > 0 && memLimitBytes < Number.MAX_SAFE_INTEGER) {
    base.memoryLimit = formatBytes(memLimitBytes);
  }

  const memUsageBytes = parseInt(memUsage ?? memUsageV1 ?? '', 10);
  if (memUsageBytes > 0) {
    base.memoryUsage = formatBytes(memUsageBytes);
  }

  if (cpuMax) {
    const parts = cpuMax.split(' ').map(Number);
    const quota = parts[0] ?? 0;
    const period = parts[1] ?? 0;
    if (quota > 0 && period > 0) {
      base.cpuLimit = `${(quota / period).toFixed(1)} cores`;
    }
  } else if (cpuQuota && cpuPeriod) {
    const quota = parseInt(cpuQuota, 10);
    const period = parseInt(cpuPeriod, 10);
    if (quota > 0 && period > 0) {
      base.cpuLimit = `${(quota / period).toFixed(1)} cores`;
    }
  }

  return base;
};

interface ProcessInfo {
  name: string;
  memory: string;
}

/**
 * Get a process list from /proc.
 * Aggregates postgres workers into a single entry using RssAnon + RssShmem (once).
 * Other processes use VmRSS directly.
 */
const getProcessList = async (): Promise<ProcessInfo[]> => {
  try {
    const entries = await fs.readdir('/proc');
    let pgAnonTotal = 0;
    let pgSharedMax = 0;
    const others: ProcessInfo[] = [];

    await Promise.all(
      entries
        .filter((e) => /^\d+$/.test(e))
        .map(async (pid) => {
          try {
            const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
            const rssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
            if (!rssMatch?.[1]) return; // kernel thread

            const nameMatch = status.match(/^Name:\s+(.+)$/m);
            const name = nameMatch?.[1]?.trim() ?? 'unknown';

            const anonMatch = status.match(/^RssAnon:\s+(\d+)\s+kB$/m);
            const anon = parseInt(anonMatch?.[1] ?? '0', 10) * 1024;

            if (name === 'postgres') {
              pgAnonTotal += anon;
              const shmMatch = status.match(/^RssShmem:\s+(\d+)\s+kB$/m);
              const shm = parseInt(shmMatch?.[1] ?? '0', 10) * 1024;
              if (shm > pgSharedMax) pgSharedMax = shm;
            } else {
              others.push({ name, memory: formatBytes(anon) });
            }
          } catch {
            // Process may have exited
          }
        })
    );

    const result: ProcessInfo[] = [];
    if (pgAnonTotal > 0 || pgSharedMax > 0) {
      result.push({ name: 'postgres', memory: formatBytes(pgAnonTotal + pgSharedMax) });
    }
    result.push(...others);
    return result.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
};

/**
 * Parse a Docker volume source path into a friendly display name.
 * e.g. "/var/lib/docker/volumes/compose_tracearr_redis/_data" →
 *   last segment "_data" indicates a Docker volume, parent "compose_tracearr_redis"
 *   starts with "compose_" so the volume name is "tracearr_redis".
 * Falls back to the raw source path for bind mounts.
 */
const formatVolumeSource = (source: string): string => {
  const parts = source.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  const parent = parts[parts.length - 2];

  if (last === '_data' && parent) {
    // Strip the Compose project prefix (everything up to the first underscore)
    const underscoreIdx = parent.indexOf('_');
    if (underscoreIdx !== -1) {
      return parent.slice(underscoreIdx + 1);
    }
    return parent;
  }

  return source;
};

const getVolumeMounts = async (): Promise<{ path: string; source: string; free: string }[]> => {
  try {
    const raw = await fs.readFile('/proc/self/mountinfo', 'utf8');
    const mounts = raw
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        // Field 4 = mount point — only keep mounts under /data
        const mountPoint = line.split(' ')[4];
        return mountPoint === '/data' || mountPoint?.startsWith('/data/');
      })
      .map((line) => {
        const fields = line.split(' ');
        // Field 3 = root (source path), Field 4 = mount point
        return { source: fields[3] ?? '', path: fields[4] ?? '' };
      });

    // Dedupe by mount path
    const seen = new Set<string>();
    const unique = mounts.filter((m) => {
      if (seen.has(m.path)) return false;
      seen.add(m.path);
      return true;
    });

    const results = await Promise.all(
      unique.map(async ({ path, source }) => {
        try {
          const stat = await fs.statfs(path);
          const free = stat.bsize * stat.bavail;

          return { path, source: formatVolumeSource(source), free: formatBytes(free) };
        } catch {
          return null;
        }
      })
    );

    return results.filter((r): r is NonNullable<typeof r> => r !== null);
  } catch {
    return [];
  }
};

// Gate log explorer feature to supervised deployments only
const IS_SUPERVISED = (getCurrentTag() ?? '').toLowerCase().includes('supervised');

// Specify accessible supervised log files
const SUPERVISOR_LOG_DIR = '/var/log/supervisor';
const SUPERVISOR_LOG_FILES = [
  'tracearr.log',
  'tracearr-error.log',
  'postgres.log',
  'postgres-error.log',
  'redis.log',
  'redis-error.log',
  'supervisord.log',
];
const LOG_READ_BYTES = 256 * 1024;
const LOG_LIMIT_DEFAULT = 200;
const LOG_LIMIT_MAX = 1000;

interface DebugLogEntriesResponse {
  entries: string[];
  truncated: boolean;
  fileExists: boolean;
}

const resolveLogPath = (name: string) =>
  SUPERVISOR_LOG_FILES.includes(name) ? join(SUPERVISOR_LOG_DIR, name) : null;

const readLogTail = async (filePath: string, limit: number): Promise<DebugLogEntriesResponse> => {
  try {
    const stats = await fs.stat(filePath);
    if (stats.size === 0) {
      return { entries: [], truncated: false, fileExists: true };
    }

    const readBytes = Math.min(stats.size, LOG_READ_BYTES);
    const start = Math.max(0, stats.size - readBytes);
    const handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, start);
    await handle.close();

    let content = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = content.indexOf('\n');
      if (firstNewline !== -1) {
        content = content.slice(firstNewline + 1);
      }
    }

    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    const truncated = start > 0 || lines.length > limit;
    const entries = lines.slice(-limit).reverse();

    return { entries, truncated, fileExists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], truncated: false, fileExists: false };
    }
    throw error;
  }
};

export const debugRoutes: FastifyPluginAsync = async (app) => {
  // All debug routes require owner
  app.addHook('preHandler', async (request, reply) => {
    await app.authenticate(request, reply);
    if (request.user?.role !== 'owner') {
      return reply.forbidden('Owner access required');
    }
  });

  /**
   * GET /debug/stats - Database statistics
   */
  app.get('/stats', async () => {
    const [
      sessionCount,
      violationCount,
      userCount,
      serverCount,
      ruleCount,
      terminationLogCount,
      libraryItemCount,
      plexAccountCount,
    ] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(sessions),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(automationRuns)
        .where(and(...violationAliasConditions())),
      db.select({ count: sql<number>`count(*)::int` }).from(users),
      db.select({ count: sql<number>`count(*)::int` }).from(servers),
      db.select({ count: sql<number>`count(*)::int` }).from(automations),
      db.select({ count: sql<number>`count(*)::int` }).from(terminationLogs),
      db.select({ count: sql<number>`count(*)::int` }).from(libraryItems),
      db.select({ count: sql<number>`count(*)::int` }).from(plexAccounts),
    ]);

    // Get database size
    const dbSize = await db.execute(sql`
      SELECT pg_size_pretty(pg_database_size(current_database())) as size
    `);

    // Get table sizes - split into application tables and system/aggregate tables
    const appTables = await db.execute(sql`
      SELECT
        relname as table_name,
        pg_size_pretty(pg_total_relation_size(relid)) as total_size,
        pg_total_relation_size(relid) as size_bytes
      FROM pg_catalog.pg_statio_user_tables
      WHERE relname IN (
        'sessions', 'users', 'servers', 'server_users',
        'automations', 'automation_runs', 'automation_versions',
        'automation_templates', 'automation_template_versions',
        'termination_logs', 'plex_accounts', 'settings',
        'notification_preferences', 'destinations',
        'mobile_sessions', 'mobile_tokens',
        'library_items', 'library_item_versions', 'library_snapshots'
      )
      ORDER BY pg_total_relation_size(relid) DESC
    `);

    // Get continuous aggregates and materialized views
    const aggregateTables = await db.execute(sql`
      SELECT
        view_name as table_name,
        pg_size_pretty(
          COALESCE(
            (SELECT pg_total_relation_size(format('_timescaledb_internal.%I', materialization_hypertable_name)::regclass)
             FROM timescaledb_information.continuous_aggregates ca2
             WHERE ca2.view_name = ca.view_name),
            0
          )
        ) as total_size,
        COALESCE(
          (SELECT pg_total_relation_size(format('_timescaledb_internal.%I', materialization_hypertable_name)::regclass)
           FROM timescaledb_information.continuous_aggregates ca2
           WHERE ca2.view_name = ca.view_name),
          0
        ) as size_bytes
      FROM timescaledb_information.continuous_aggregates ca
      ORDER BY size_bytes DESC
    `);

    return {
      counts: {
        sessions: sessionCount[0]?.count ?? 0,
        violations: violationCount[0]?.count ?? 0,
        users: userCount[0]?.count ?? 0,
        servers: serverCount[0]?.count ?? 0,
        rules: ruleCount[0]?.count ?? 0,
        terminationLogs: terminationLogCount[0]?.count ?? 0,
        libraryItems: libraryItemCount[0]?.count ?? 0,
        plexAccounts: plexAccountCount[0]?.count ?? 0,
      },
      database: {
        size: (dbSize.rows[0] as { size: string })?.size ?? 'unknown',
        tables: appTables.rows as { table_name: string; total_size: string }[],
        aggregates: aggregateTables.rows as { table_name: string; total_size: string }[],
      },
    };
  });

  /**
   * DELETE /debug/sessions - Clear all sessions
   */
  app.delete('/sessions', async () => {
    // Delete violations first (FK constraint)
    const violationsDeleted = await db.delete(automationRuns).returning({ id: automationRuns.id });
    // Delete termination logs (references sessions but no FK due to TimescaleDB)
    const terminationLogsDeleted = await db
      .delete(terminationLogs)
      .returning({ id: terminationLogs.id });
    const sessionsDeleted = await db.delete(sessions).returning({ id: sessions.id });

    return {
      success: true,
      deleted: {
        sessions: sessionsDeleted.length,
        violations: violationsDeleted.length,
        terminationLogs: terminationLogsDeleted.length,
      },
    };
  });

  /**
   * DELETE /debug/violations - Clear all violations
   */
  app.delete('/violations', async () => {
    const deleted = await db.delete(automationRuns).returning({ id: automationRuns.id });
    return {
      success: true,
      deleted: deleted.length,
    };
  });

  /**
   * DELETE /debug/users - Clear all non-owner users
   */
  app.delete('/users', async () => {
    // Delete sessions and violations for non-owner users first
    const nonOwnerUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`role != 'owner'`);

    const userIds = nonOwnerUsers.map((u) => u.id);

    if (userIds.length === 0) {
      return { success: true, deleted: 0 };
    }

    // Get serverUser IDs for these users (sessions/violations link to serverUsers, not users)
    const userIdArray = sql.raw(`ARRAY[${userIds.map((id) => `'${id}'::uuid`).join(',')}]`);
    const serverUserRows = await db
      .select({ id: serverUsers.id })
      .from(serverUsers)
      .where(sql`user_id = ANY(${userIdArray})`);

    const serverUserIds = serverUserRows.map((su) => su.id);

    if (serverUserIds.length > 0) {
      const serverUserIdArray = sql.raw(
        `ARRAY[${serverUserIds.map((id) => `'${id}'::uuid`).join(',')}]`
      );

      // Delete violations for these server users
      await db.delete(automationRuns).where(sql`server_user_id = ANY(${serverUserIdArray})`);

      // Delete termination logs for these server users
      await db.delete(terminationLogs).where(sql`server_user_id = ANY(${serverUserIdArray})`);

      // Delete sessions for these server users
      await db.delete(sessions).where(sql`server_user_id = ANY(${serverUserIdArray})`);
    }

    // Delete the users (cascades to serverUsers, plexAccounts, mobileTokens, mobileSessions)
    const deleted = await db
      .delete(users)
      .where(sql`role != 'owner'`)
      .returning({ id: users.id });

    return {
      success: true,
      deleted: deleted.length,
    };
  });

  /**
   * DELETE /debug/servers - Clear all servers (cascades to users, sessions, violations)
   */
  app.delete('/servers', async () => {
    const deleted = await db.delete(servers).returning({ id: servers.id });
    invalidateServersCache();
    return {
      success: true,
      deleted: deleted.length,
    };
  });

  /**
   * DELETE /debug/automations - Clear all automations and their runs
   */
  app.delete('/automations', async () => {
    // Delete runs first (FK constraint)
    await db.delete(automationRuns);
    const deleted = await db.delete(automations).returning({ id: automations.id });
    // Builtin templates come back at boot; imported and local ones do not.
    await db.delete(automationTemplates).where(eq(automationTemplates.builtin, false));
    invalidateAutomationsCache();
    return {
      success: true,
      deleted: deleted.length,
    };
  });

  /**
   * DELETE /debug/library - Clear all library data (items and snapshots)
   */
  app.delete('/library', async () => {
    const snapshotsDeleted = await db
      .delete(librarySnapshots)
      .returning({ id: librarySnapshots.id });
    const itemsDeleted = await db.delete(libraryItems).returning({ id: libraryItems.id });
    return {
      success: true,
      deleted: {
        items: itemsDeleted.length,
        snapshots: snapshotsDeleted.length,
      },
    };
  });

  /**
   * DELETE /debug/termination-logs - Clear all termination logs
   */
  app.delete('/termination-logs', async () => {
    const deleted = await db.delete(terminationLogs).returning({ id: terminationLogs.id });
    return {
      success: true,
      deleted: deleted.length,
    };
  });

  /**
   * DELETE /debug/mobile - Delete all mobile pairing tokens and sessions
   */
  app.delete('/mobile', async () => {
    const sessionRows = await db.select().from(mobileSessions);
    for (const session of sessionRows) {
      await revokeMobileDeviceSession(app.redis, session);
    }
    const sessionsDeleted = await db.delete(mobileSessions).returning({ id: mobileSessions.id });
    const tokensDeleted = await db.delete(mobileTokens).returning({ id: mobileTokens.id });
    return {
      success: true,
      sessionsDeleted: sessionsDeleted.length,
      tokensDeleted: tokensDeleted.length,
    };
  });

  /**
   * POST /debug/reset - Full factory reset (deletes everything including owner)
   */
  app.post('/reset', async () => {
    // deleteSessions throws if Redis is unreachable, aborting before any delete runs.
    const existingSessions = await db.select({ token: authSessions.token }).from(authSessions);
    if (existingSessions.length > 0) {
      const authCtx = await getAuth().$context;
      await authCtx.internalAdapter.deleteSessions(existingSessions.map((s) => s.token));
    }

    // Delete everything in order respecting FK constraints
    // Start with tables that have FK dependencies on other tables
    await db.delete(automationRuns);
    await db.delete(terminationLogs);
    await db.delete(sessions);
    await db.delete(automations);
    await db.delete(destinations);
    await db.delete(notificationPreferences);
    await db.delete(mobileSessions);
    await db.delete(mobileTokens);
    await db.delete(librarySnapshots); // Library data (references servers)
    await db.delete(libraryItems); // Library data (references servers)
    await db.delete(serverUsers);
    await db.delete(servers); // servers references plex_accounts
    invalidateServersCache();
    await db.delete(plexAccounts); // plex_accounts references users
    await db.delete(users);

    // Reset settings to defaults (KV store — just delete all rows; service uses defaults for missing keys)
    await db.delete(settings);

    invalidateAutomationsCache();
    resetSettingsCache();
    invalidateDestinationsCache();
    await seedBuiltinDestinations();
    await publishDestinationsChanged();

    return {
      success: true,
      message: 'Factory reset complete. Please set up Tracearr again.',
    };
  });

  /**
   * POST /debug/refresh-aggregates - Refresh TimescaleDB continuous aggregates
   */
  app.post('/refresh-aggregates', async () => {
    try {
      // Refresh all active continuous aggregates with bounded time range
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 7 * 24 * 60 * 60 * 1000); // Last 7 days

      // Use the centralized aggregate list to stay in sync with timescale.ts
      const aggregates = getActiveAggregateNames();

      // Convert to ISO strings - CALL statements need explicit type hints
      const startStr = startTime.toISOString();
      const endStr = endTime.toISOString();

      for (const agg of aggregates) {
        try {
          // Use parameterized query - agg::regclass validates it's a real relation
          await db.execute(
            sql`CALL refresh_continuous_aggregate(${agg}::regclass, ${startStr}::timestamptz, ${endStr}::timestamptz)`
          );
        } catch {
          // Individual aggregate might not exist - continue with others
        }
      }

      return { success: true, message: 'Aggregates refreshed (last 7 days)' };
    } catch {
      // Aggregates might not exist yet
      return { success: false, message: 'Aggregates not configured or refresh failed' };
    }
  });

  /**
   * POST /debug/clear-stuck-jobs - Clear stuck maintenance jobs
   *
   * Use this to recover from a crash where jobs are left in active state.
   */
  app.post('/clear-stuck-jobs', async () => {
    const result = await clearStuckMaintenanceJobs();
    return {
      success: true,
      message:
        result.cleared > 0 ? `Cleared ${result.cleared} stuck job(s)` : 'No stuck jobs found',
      cleared: result.cleared,
    };
  });

  /**
   * POST /debug/obliterate-all-jobs - Nuclear option: clear ALL jobs from ALL queues
   *
   * Completely wipes maintenance, import, and library sync queues.
   * Also releases any heavy operation locks.
   * Use when job system is in an unrecoverable state.
   */
  app.post('/obliterate-all-jobs', async () => {
    const results = await Promise.all([
      obliterateMaintenanceQueue(),
      obliterateImportQueue(),
      obliterateLibrarySyncQueue(),
    ]);

    // Also release any heavy ops lock
    await forceReleaseHeavyOpsLock();

    const allSuccess = results.every((r) => r.success);

    return {
      success: allSuccess,
      message: allSuccess
        ? 'All job queues obliterated and locks released'
        : 'Some queues failed to obliterate (check logs)',
      queues: {
        maintenance: results[0].success,
        import: results[1].success,
        librarySync: results[2].success,
      },
    };
  });

  /**
   * GET /debug/logs - Available supervised log files
   */
  app.get('/logs', async (_request, reply) => {
    if (!IS_SUPERVISED) {
      return reply.notFound('Log explorer is only available in supervised mode');
    }

    const files = await Promise.all(
      SUPERVISOR_LOG_FILES.map(async (name) => {
        const filePath = resolveLogPath(name);
        if (!filePath) {
          return { name, exists: false };
        }
        try {
          await fs.stat(filePath);
          return { name, exists: true };
        } catch {
          return { name, exists: false };
        }
      })
    );

    return { files };
  });

  /**
   * GET /debug/logs/download - Download all logs as a zip
   */
  app.get('/logs/download', async (_request, reply) => {
    if (!IS_SUPERVISED) {
      return reply.notFound('Log explorer is only available in supervised mode');
    }

    // Find logs that exist
    const existing = (
      await Promise.all(
        SUPERVISOR_LOG_FILES.map(async (name) => {
          const filePath = join(SUPERVISOR_LOG_DIR, name);
          try {
            await fs.stat(filePath);
            return { name, filePath };
          } catch {
            return null;
          }
        })
      )
    ).filter((f): f is { name: string; filePath: string } => f !== null);

    if (existing.length === 0) {
      return reply.notFound('No log files found');
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `tracearr-logs-${timestamp}.zip`;
    const zipPath = join(os.tmpdir(), filename);

    try {
      // Create zip
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(zipPath);
        const archive = new ZipArchive({ zlib: { level: 1 } });
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        for (const { name, filePath } of existing) {
          archive.append(createReadStream(filePath), { name });
        }
        void archive.finalize();
      });

      const stream = createReadStream(zipPath);
      // Clean up zip after stream finishes
      stream.on('close', () => {
        void fs.unlink(zipPath);
      });

      return await reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(stream);
    } catch (err) {
      void fs.unlink(zipPath);
      throw err;
    }
  });

  /**
   * GET /debug/logs/:name - Tail supervised log file
   */
  app.get('/logs/:name', async (request, reply) => {
    if (!IS_SUPERVISED) {
      return reply.notFound('Log explorer is only available in supervised mode');
    }

    const { name } = request.params as { name: string };
    const { limit } = request.query as { limit?: string };
    const filePath = resolveLogPath(name);
    if (!filePath) {
      return reply.notFound('Log file not found');
    }

    const parsedLimit = Math.min(
      Math.max(Number.parseInt(limit ?? String(LOG_LIMIT_DEFAULT), 10) || LOG_LIMIT_DEFAULT, 1),
      LOG_LIMIT_MAX
    );

    return readLogTail(filePath, parsedLimit);
  });

  /**
   * GET /debug/env - Safe environment info (no secrets)
   */
  app.get('/env', async () => {
    // Query database versions in parallel
    const [pgVersionResult, tsVersionResult, redisInfo, container] = await Promise.all([
      db.execute(sql`SELECT version()`).then(
        (r) => {
          const full = (r.rows[0] as { version: string })?.version ?? '';
          return full.match(/^PostgreSQL\s+([\d.]+)/)?.[1] ?? full;
        },
        () => 'unknown'
      ),
      db.execute(sql`SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'`).then(
        (r) => (r.rows[0] as { extversion: string })?.extversion ?? 'not installed',
        () => 'not installed'
      ),
      app.redis.info().then(
        (raw) => {
          const get = (key: string) => raw.match(new RegExp(`${key}:(.+)`))?.[1]?.trim();
          return { version: get('redis_version') ?? 'unknown' };
        },
        () => ({ version: 'unknown' })
      ),
      getContainerInfo(),
    ]);

    const loadAvg = os.loadavg();

    return {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: Math.round(process.uptime()),
      systemUptime: Math.round(os.uptime()),
      loadAverage: [
        (loadAvg[0] ?? 0).toFixed(2),
        (loadAvg[1] ?? 0).toFixed(2),
        (loadAvg[2] ?? 0).toFixed(2),
      ],
      memoryUsage: {
        heapUsed: formatBytes(process.memoryUsage().heapUsed),
        rss: formatBytes(process.memoryUsage().rss),
      },
      database: {
        postgresVersion: pgVersionResult,
        timescaleVersion: tsVersionResult,
      },
      redis: { version: redisInfo.version },
      container,
      volumes: container.isDocker ? await getVolumeMounts() : [],
      processes: container.isDocker ? await getProcessList() : [],
      env: {
        NODE_ENV: process.env.NODE_ENV ?? 'development',
        LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
        TZ: process.env.TZ ?? 'UTC',
        REDIS_PREFIX: process.env.REDIS_PREFIX ?? '',
        CLAIM_CODE: process.env.CLAIM_CODE ? '[set]' : '',
        BASE_PATH: process.env.BASE_PATH ?? '',
        DNS_CACHE_MAX_TTL: process.env.DNS_CACHE_MAX_TTL ?? '',
        APP_VERSION: getCurrentVersion(),
        APP_TAG: getCurrentTag() ?? '[not set]',
        APP_COMMIT: getCurrentCommit() ?? '[not set]',
        APP_BUILD_DATE: getBuildDate() ?? '[not set]',
      },
    };
  });

  /**
   * GET /debug/tasks - Background task and queue status
   */
  app.get('/tasks', async () => {
    const [
      notifications,
      imports,
      maintenance,
      librarySync,
      versionCheck,
      inactivityCheck,
      backup,
      newsletters,
    ] = await Promise.all([
      getNotificationQueueStats(),
      getImportQueueStats(),
      getMaintenanceQueueStats(),
      getLibrarySyncQueueStats(),
      getVersionCheckQueueStats(),
      getInactivityCheckQueueStats(),
      getBackupQueueStats(),
      getNewsletterQueueStats(),
    ]);

    return {
      queues: {
        notifications,
        imports,
        maintenance,
        librarySync,
        versionCheck,
        inactivityCheck,
        backup,
        newsletters,
      },
      services: getAllServices(),
      timestamp: new Date().toISOString(),
    };
  });
};
