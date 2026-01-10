/**
 * Quality Statistics Route
 *
 * GET /quality - Transcode vs direct play breakdown
 * Uses prepared statement for 10-30% query plan reuse speedup
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { statsQuerySchema } from '@tracearr/shared';
import { qualityStatsSince } from '../../db/prepared.js';
import { db } from '../../db/client.js';
import { resolveDateRange } from './utils.js';
import { MEDIA_TYPE_SQL_FILTER } from '../../constants/index.js';

export const qualityRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /quality - Transcode vs direct play breakdown
   * Uses prepared statement for better performance
   */
  app.get('/quality', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate } = query.data;
    const dateRange = resolveDateRange(period, startDate, endDate);

    let qualityStats: { isTranscode: boolean | null; count: number }[];

    // For 'all' period (no start date), use raw query
    // For standard periods, use prepared statement for performance
    if (!dateRange.start) {
      const result = await db.execute(sql`
        SELECT
          is_transcode,
          COUNT(DISTINCT COALESCE(reference_id, id))::int as count
        FROM sessions
        WHERE true
        ${MEDIA_TYPE_SQL_FILTER}
        GROUP BY is_transcode
      `);
      qualityStats = (result.rows as { is_transcode: boolean | null; count: number }[]).map(
        (r) => ({ isTranscode: r.is_transcode, count: r.count })
      );
    } else {
      qualityStats = await qualityStatsSince.execute({ since: dateRange.start });
    }

    const directPlay = qualityStats.find((q) => !q.isTranscode)?.count ?? 0;
    const transcode = qualityStats.find((q) => q.isTranscode)?.count ?? 0;
    const total = directPlay + transcode;

    return {
      directPlay,
      transcode,
      total,
      directPlayPercent: total > 0 ? Math.round((directPlay / total) * 100) : 0,
      transcodePercent: total > 0 ? Math.round((transcode / total) * 100) : 0,
    };
  });
};
