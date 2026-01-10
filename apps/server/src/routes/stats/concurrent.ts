/**
 * Concurrent Streams Statistics Route
 *
 * GET /concurrent - Concurrent stream history
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { statsQuerySchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveDateRange } from './utils.js';
import { MEDIA_TYPE_SQL_FILTER } from '../../constants/index.js';

export const concurrentRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /concurrent - Concurrent stream history
   */
  app.get('/concurrent', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate } = query.data;
    const dateRange = resolveDateRange(period, startDate, endDate);

    const baseWhere = dateRange.start
      ? sql`WHERE started_at >= ${dateRange.start} ${MEDIA_TYPE_SQL_FILTER}`
      : sql`WHERE true ${MEDIA_TYPE_SQL_FILTER}`;

    const result = await db.execute(sql`
      SELECT
        date_trunc('hour', started_at)::text as hour,
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE is_transcode = false OR is_transcode IS NULL)::int as direct,
        COUNT(*) FILTER (WHERE is_transcode = true)::int as transcode
      FROM sessions
      ${baseWhere}
      GROUP BY date_trunc('hour', started_at)
      ORDER BY date_trunc('hour', started_at)
    `);

    const hourlyData = (
      result.rows as { hour: string; total: number; direct: number; transcode: number }[]
    ).map((r) => ({
      hour: r.hour,
      total: r.total,
      direct: r.direct,
      transcode: r.transcode,
    }));

    return { data: hourlyData };
  });
};
