/**
 * Location Statistics Routes
 *
 * GET /locations - Geo data for stream map with filtering
 *
 * Features cascading filters where each filter's available options depend on
 * the other active filters. Runs 2 parallel queries per request.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { locationStatsQuerySchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveDateRange } from './utils.js';

interface LocationFilters {
  users: { id: string; username: string; identityName: string | null }[];
  servers: { id: string; name: string }[];
  mediaTypes: ('movie' | 'episode' | 'track')[];
}

export const locationsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /locations - Geo data for stream map with filtering
   *
   * Supports filtering by:
   * - period: Time period (day, week, month, year, all, custom)
   * - startDate/endDate: For custom period
   * - serverUserId: Filter to specific user
   * - serverId: Filter to specific server
   * - mediaType: Filter by movie/episode/track
   */
  app.get('/locations', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = locationStatsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverUserId, serverId, mediaType } = query.data;
    const dateRange = resolveDateRange(period, startDate, endDate);
    const authUser = request.user;

    // Build WHERE conditions for main query (all qualified with 's.' for sessions table)
    const conditions: ReturnType<typeof sql>[] = [
      sql`s.geo_lat IS NOT NULL`,
      sql`s.geo_lon IS NOT NULL`,
    ];

    // Add date range filter (null start means "all time")
    if (dateRange.start) {
      conditions.push(sql`s.started_at >= ${dateRange.start}`);
    }
    if (period === 'custom') {
      conditions.push(sql`s.started_at < ${dateRange.end}`);
    }

    // Apply server access restriction if user has limited access
    // Note: We build the array literal explicitly because Drizzle doesn't auto-convert JS arrays for ANY()
    if (authUser.serverIds.length > 0) {
      const serverIdArray = sql.raw(
        `ARRAY[${authUser.serverIds.map((id: string) => `'${id}'::uuid`).join(',')}]`
      );
      conditions.push(sql`s.server_id = ANY(${serverIdArray})`);
    }

    if (serverUserId) {
      conditions.push(sql`s.server_user_id = ${serverUserId}`);
    }
    if (serverId) {
      conditions.push(sql`s.server_id = ${serverId}`);
    }
    if (mediaType) {
      conditions.push(sql`s.media_type = ${mediaType}`);
    }

    const whereClause = sql`WHERE ${sql.join(conditions, sql` AND `)}`;

    // Build cascading filter conditions - each filter type sees options based on OTHER active filters
    // This gives users a consistent UX where selecting one filter narrows down the others
    const baseConditions: ReturnType<typeof sql>[] = [
      sql`s.geo_lat IS NOT NULL`,
      sql`s.geo_lon IS NOT NULL`,
    ];

    // Add date range filter for cascading filters
    if (dateRange.start) {
      baseConditions.push(sql`s.started_at >= ${dateRange.start}`);
    }
    if (period === 'custom') {
      baseConditions.push(sql`s.started_at < ${dateRange.end}`);
    }
    if (authUser.serverIds.length > 0) {
      const baseServerIdArray = sql.raw(
        `ARRAY[${authUser.serverIds.map((id: string) => `'${id}'::uuid`).join(',')}]`
      );
      baseConditions.push(sql`s.server_id = ANY(${baseServerIdArray})`);
    }

    // Users filter: apply server + mediaType filters (not user filter)
    const userFilterConditions = [...baseConditions];
    if (serverId) userFilterConditions.push(sql`s.server_id = ${serverId}`);
    if (mediaType) userFilterConditions.push(sql`s.media_type = ${mediaType}`);
    const userFilterWhereClause = sql`WHERE ${sql.join(userFilterConditions, sql` AND `)}`;

    // Servers filter: apply user + mediaType filters (not server filter)
    const serverFilterConditions = [...baseConditions];
    if (serverUserId) serverFilterConditions.push(sql`s.server_user_id = ${serverUserId}`);
    if (mediaType) serverFilterConditions.push(sql`s.media_type = ${mediaType}`);
    const serverFilterWhereClause = sql`WHERE ${sql.join(serverFilterConditions, sql` AND `)}`;

    // MediaType filter: apply user + server filters (not mediaType filter)
    const mediaFilterConditions = [...baseConditions];
    if (serverUserId) mediaFilterConditions.push(sql`s.server_user_id = ${serverUserId}`);
    if (serverId) mediaFilterConditions.push(sql`s.server_id = ${serverId}`);
    const mediaFilterWhereClause = sql`WHERE ${sql.join(mediaFilterConditions, sql` AND `)}`;

    // Cascading filters are always fetched fresh (no caching since they depend on current selections)
    let availableFilters: LocationFilters | null = null;

    // Execute queries in parallel (2 instead of 4 sequential)
    const [mainResult, filtersResult] = await Promise.all([
      // Query 1: Main location data with all filters applied
      db.execute(sql`
          SELECT
            s.geo_city as city,
            s.geo_region as region,
            s.geo_country as country,
            s.geo_lat as lat,
            s.geo_lon as lon,
            COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int as count,
            MAX(s.started_at) as last_activity,
            MIN(s.started_at) as first_activity,
            COUNT(DISTINCT COALESCE(s.device_id, s.player_name))::int as device_count,
            JSON_AGG(DISTINCT jsonb_build_object('id', su.id, 'username', su.username, 'thumbUrl', su.thumb_url))
              FILTER (WHERE su.id IS NOT NULL) as user_info
          FROM sessions s
          LEFT JOIN server_users su ON s.server_user_id = su.id
          ${whereClause}
          GROUP BY s.geo_city, s.geo_region, s.geo_country, s.geo_lat, s.geo_lon
          ORDER BY count DESC
          LIMIT 200
        `),

      // Query 2: Cascading filter options - each filter type uses conditions from OTHER active filters
      // Note: ORDER BY not allowed within UNION subqueries, sorting done in application code
      db.execute(sql`
          SELECT 'user' as filter_type, su.id::text as id, su.username as name, u.name as identity_name
          FROM sessions s
          JOIN server_users su ON su.id = s.server_user_id
          JOIN users u ON su.user_id = u.id
          ${userFilterWhereClause}
          GROUP BY su.id, su.username, u.name

          UNION ALL

          SELECT 'server' as filter_type, sv.id::text as id, sv.name as name, NULL as identity_name
          FROM sessions s
          JOIN servers sv ON sv.id = s.server_id
          ${serverFilterWhereClause}
          GROUP BY sv.id, sv.name

          UNION ALL

          SELECT 'media' as filter_type, s.media_type as id, s.media_type as name, NULL as identity_name
          FROM sessions s
          ${mediaFilterWhereClause} AND s.media_type IS NOT NULL
          GROUP BY s.media_type
        `),
    ]);

    // Parse filter results (no caching - cascading filters depend on current selections)
    // Sorting done here since ORDER BY not allowed within UNION subqueries
    const filters = filtersResult.rows as {
      filter_type: string;
      id: string;
      name: string;
      identity_name: string | null;
    }[];
    availableFilters = {
      users: filters
        .filter((f) => f.filter_type === 'user')
        .map((f) => ({ id: f.id, username: f.name, identityName: f.identity_name }))
        .sort((a, b) => (a.identityName ?? a.username).localeCompare(b.identityName ?? b.username)),
      servers: filters
        .filter((f) => f.filter_type === 'server')
        .map((f) => ({ id: f.id, name: f.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      mediaTypes: filters
        .filter((f) => f.filter_type === 'media')
        .map((f) => f.name)
        .filter(
          (t): t is 'movie' | 'episode' | 'track' =>
            t === 'movie' || t === 'episode' || t === 'track'
        )
        .sort((a, b) => a.localeCompare(b)),
    };

    // Transform main query results
    const locationStats = (
      mainResult.rows as {
        city: string | null;
        region: string | null;
        country: string | null;
        lat: number;
        lon: number;
        count: number;
        last_activity: Date;
        first_activity: Date;
        device_count: number;
        user_info: { id: string; username: string; thumbUrl: string | null }[] | null;
      }[]
    ).map((row) => ({
      city: row.city,
      region: row.region,
      country: row.country,
      lat: row.lat,
      lon: row.lon,
      count: row.count,
      lastActivity: row.last_activity,
      firstActivity: row.first_activity,
      deviceCount: row.device_count,
      // Only include users array if NOT filtering by a specific user
      users: serverUserId ? undefined : (row.user_info ?? []).slice(0, 5),
    }));

    // Calculate summary stats for the overlay card
    const totalStreams = locationStats.reduce((sum, loc) => sum + loc.count, 0);
    const uniqueLocations = locationStats.length;
    const topCity = locationStats[0]?.city ?? null;

    return {
      data: locationStats,
      summary: {
        totalStreams,
        uniqueLocations,
        topCity,
      },
      availableFilters: availableFilters ?? { users: [], servers: [], mediaTypes: [] },
    };
  });
};
