/**
 * Platform Statistics Route
 *
 * GET /platforms - Plays by platform
 * Uses prepared statement for 10-30% query plan reuse speedup
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { statsQuerySchema } from '@tracearr/shared';
import { playsByPlatformSince } from '../../db/prepared.js';
import { db } from '../../db/client.js';
import { resolveDateRange } from './utils.js';
import { MEDIA_TYPE_SQL_FILTER } from '../../constants/index.js';

export const platformsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /platforms - Plays by platform
   * Uses prepared statement for better performance
   */
  app.get('/platforms', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate } = query.data;
    const dateRange = resolveDateRange(period, startDate, endDate);

    // For 'all' period (no start date), use raw query
    // For standard periods, use prepared statement for performance
    if (!dateRange.start) {
      const result = await db.execute(sql`
        SELECT
          platform,
          COUNT(DISTINCT COALESCE(reference_id, id))::int as count
        FROM sessions
        WHERE true
        ${MEDIA_TYPE_SQL_FILTER}
        GROUP BY platform
        ORDER BY count DESC
      `);
      return { data: result.rows as { platform: string; count: number }[] };
    }

    const platformStats = await playsByPlatformSince.execute({ since: dateRange.start });
    return { data: platformStats };
  });
};
