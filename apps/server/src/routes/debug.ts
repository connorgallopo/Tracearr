/**
 * Debug routes - owner only
 *
 * Hidden utilities for development and troubleshooting.
 * All routes require owner authentication.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  sessions,
  violations,
  users,
  servers,
  serverUsers,
  rules,
  settings,
  mobileTokens,
  mobileSessions,
  notificationPreferences,
  notificationChannelRouting,
  terminationLogs,
} from '../db/schema.js';

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
    const [sessionCount, violationCount, userCount, serverCount, ruleCount] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(sessions),
      db.select({ count: sql<number>`count(*)::int` }).from(violations),
      db.select({ count: sql<number>`count(*)::int` }).from(users),
      db.select({ count: sql<number>`count(*)::int` }).from(servers),
      db.select({ count: sql<number>`count(*)::int` }).from(rules),
    ]);

    // Get database size
    const dbSize = await db.execute(sql`
      SELECT pg_size_pretty(pg_database_size(current_database())) as size
    `);

    // Get table sizes
    const tableSizes = await db.execute(sql`
      SELECT
        relname as table_name,
        pg_size_pretty(pg_total_relation_size(relid)) as total_size
      FROM pg_catalog.pg_statio_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 10
    `);

    return {
      counts: {
        sessions: sessionCount[0]?.count ?? 0,
        violations: violationCount[0]?.count ?? 0,
        users: userCount[0]?.count ?? 0,
        servers: serverCount[0]?.count ?? 0,
        rules: ruleCount[0]?.count ?? 0,
      },
      database: {
        size: (dbSize.rows[0] as { size: string })?.size ?? 'unknown',
        tables: tableSizes.rows as { table_name: string; total_size: string }[],
      },
    };
  });

  /**
   * DELETE /debug/sessions - Clear all sessions
   */
  app.delete('/sessions', async () => {
    // Delete violations first (FK constraint)
    const violationsDeleted = await db.delete(violations).returning({ id: violations.id });
    const sessionsDeleted = await db.delete(sessions).returning({ id: sessions.id });

    return {
      success: true,
      deleted: {
        sessions: sessionsDeleted.length,
        violations: violationsDeleted.length,
      },
    };
  });

  /**
   * DELETE /debug/violations - Clear all violations
   */
  app.delete('/violations', async () => {
    const deleted = await db.delete(violations).returning({ id: violations.id });
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
      .where(sql`is_owner = false`);

    const userIds = nonOwnerUsers.map((u) => u.id);

    if (userIds.length === 0) {
      return { success: true, deleted: 0 };
    }

    // Build explicit PostgreSQL array literal (Drizzle doesn't auto-convert JS arrays for ANY())
    const userIdArray = sql.raw(`ARRAY[${userIds.map((id) => `'${id}'::uuid`).join(',')}]`);

    // Delete violations for these users
    await db.delete(violations).where(sql`user_id = ANY(${userIdArray})`);

    // Delete sessions for these users
    await db.delete(sessions).where(sql`user_id = ANY(${userIdArray})`);

    // Delete the users
    const deleted = await db
      .delete(users)
      .where(sql`is_owner = false`)
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
    return {
      success: true,
      deleted: deleted.length,
    };
  });

  /**
   * DELETE /debug/rules - Clear all rules
   */
  app.delete('/rules', async () => {
    // Delete violations first (FK constraint)
    await db.delete(violations);
    const deleted = await db.delete(rules).returning({ id: rules.id });
    return {
      success: true,
      deleted: deleted.length,
    };
  });

  /**
   * POST /debug/reset - Full factory reset (deletes everything including owner)
   */
  app.post('/reset', async () => {
    // Delete everything in order respecting FK constraints
    // Start with tables that have FK dependencies on other tables
    await db.delete(violations);
    await db.delete(terminationLogs);
    await db.delete(sessions);
    await db.delete(rules);
    await db.delete(notificationChannelRouting);
    await db.delete(notificationPreferences);
    await db.delete(mobileSessions);
    await db.delete(mobileTokens);
    await db.delete(serverUsers);
    await db.delete(users);
    await db.delete(servers);

    // Reset settings to defaults
    await db
      .update(settings)
      .set({
        allowGuestAccess: false,
        discordWebhookUrl: null,
        customWebhookUrl: null,
        pollerEnabled: true,
        pollerIntervalMs: 15000,
        tautulliUrl: null,
        tautulliApiKey: null,
      })
      .where(sql`id = 1`);

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
      // Refresh all continuous aggregates
      await db.execute(sql`
        CALL refresh_continuous_aggregate('hourly_stats', NULL, NULL)
      `);
      await db.execute(sql`
        CALL refresh_continuous_aggregate('daily_stats', NULL, NULL)
      `);
      return { success: true, message: 'Aggregates refreshed' };
    } catch {
      // Aggregates might not exist yet
      return { success: false, message: 'Aggregates not configured or refresh failed' };
    }
  });

  /**
   * GET /debug/env - Safe environment info (no secrets)
   */
  app.get('/env', async () => {
    return {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: Math.round(process.uptime()),
      memoryUsage: {
        heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)} MB`,
        rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
      },
      env: {
        NODE_ENV: process.env.NODE_ENV ?? 'development',
        DATABASE_URL: process.env.DATABASE_URL ? '[set]' : '[not set]',
        REDIS_URL: process.env.REDIS_URL ? '[set]' : '[not set]',
        ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ? '[set]' : '[not set]',
        GEOIP_DB_PATH: process.env.GEOIP_DB_PATH ?? '[not set]',
      },
    };
  });
};
