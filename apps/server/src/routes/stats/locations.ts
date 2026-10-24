/**
 * Location Statistics Routes
 *
 * GET /locations - Geo data for stream map with filtering
 * GET /locations/people - Every person of one place or of the places inside a box
 *
 * Features cascading filters where each filter's available options depend on
 * the other active filters. Runs 3 parallel queries per request.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { type SQL, sql } from 'drizzle-orm';
import {
  LOCATION_LIST_PEOPLE,
  type LocationFilterOptions,
  type LocationPeopleResponse,
  type LocationStats,
  type LocationStatsQueryInput,
  type LocationUserInfo,
  locationPeopleQuerySchema,
  locationStatsQuerySchema,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { scopeSessionsRaw } from '../../lib/scope.js';
import { representativeAccountOrderSql } from '../../utils/representativeAccount.js';
import { localSessionSql } from '../../db/sessions/rules.js';
import { resolveDateRange } from './utils.js';

/**
 * Build a WHERE fragment matching sessions for either the single-account
 * (serverUserId) or multi-account (serverUserIds) person filter. The array
 * form takes precedence so a merged person's full history can be filtered
 * at once; the scalar form stays supported for existing callers.
 */
function buildUserFilterFragment(
  serverUserId: string | undefined,
  serverUserIds: string[] | undefined
): ReturnType<typeof sql> | null {
  if (serverUserIds && serverUserIds.length > 0) {
    const ids = serverUserIds.map((id) => sql`${id}`);
    return sql`s.server_user_id IN (${sql.join(ids, sql`, `)})`;
  }
  if (serverUserId) {
    return sql`s.server_user_id = ${serverUserId}`;
  }
  return null;
}

/**
 * The session conditions both routes share. The cascading filter options each leave one of
 * them out, so they come back as parts, with `where` to build a WHERE from any subset.
 */
function locationFilters(query: LocationStatsQueryInput, request: FastifyRequest) {
  const {
    period,
    startDate,
    endDate,
    serverUserId,
    serverUserIds,
    serverId: legacyServerId,
    serverIds: rawServerIds,
    mediaType,
  } = query;
  const dateRange = resolveDateRange(period, startDate, endDate);

  const resolvedIds = resolveServerIds(request.user, legacyServerId, rawServerIds, {
    strict: false,
  });
  const serverFragment = buildMultiServerFragment(resolvedIds, 's.server_id');
  const userFragment = buildUserFilterFragment(serverUserId, serverUserIds as string[] | undefined);

  // Mirrors buildHistoryFilterConditions in routes/sessions.ts so a location's count equals
  // History's play count for the same filters.
  const scoped = scopeSessionsRaw(request.scope, sql`s.server_user_id`);
  const baseConditions: SQL[] = [sql`s.geo_country IS NOT NULL`];
  if (scoped) baseConditions.push(scoped);
  if (dateRange.start) {
    baseConditions.push(sql`s.started_at >= ${dateRange.start}`);
  }
  if (period === 'custom') {
    baseConditions.push(sql`s.started_at < ${dateRange.end}`);
  }
  const mediaCondition = mediaType
    ? sql`s.media_type = ${mediaType}`
    : sql`s.media_type <> 'trailer'`;

  // serverFragment already starts with AND (or is empty for owner-all)
  const where = (conditions: SQL[]) =>
    sql`WHERE ${sql.join(conditions, sql` AND `)} ${serverFragment}`;

  return { resolvedIds, userFragment, baseConditions, mediaCondition, where };
}

/**
 * One row per location of the sessions `where` matches, ranked by streams. `peopleLimit` caps
 * each row's `users` (peopleCount stays the full count); `selection` keeps only the locations
 * it matches, written against `l` (location) and `c` (coords).
 */
async function queryLocations(
  where: SQL,
  resolvedIds: string[] | undefined,
  { peopleLimit, selection }: { peopleLimit?: number; selection?: SQL }
): Promise<LocationStats[]> {
  const onlySelected = (column: string) =>
    selection ? sql`WHERE ${sql.raw(column)} IN (SELECT loc_id FROM selected)` : sql``;

  // base: matching sessions tagged with loc_id, a dense id per location key.
  // coords: the most-played coordinate per location (tie: most recent); none when no
  //   session there has coordinates.
  // people: one row per (location, identity) with the representative account.
  // identity_accounts: each identity's accounts within the caller's servers.
  const result = await db.execute(sql`
    WITH base AS (
      SELECT
        s.id,
        s.reference_id,
        s.server_id,
        s.server_user_id,
        s.started_at,
        s.device_id,
        s.player_name,
        s.geo_city,
        s.geo_region,
        s.geo_country,
        s.geo_lat,
        s.geo_lon,
        ${localSessionSql('s')} AS local_flag,
        DENSE_RANK() OVER (
          ORDER BY s.geo_country, s.geo_region, s.geo_city, ${localSessionSql('s')}
        ) AS loc_id
      FROM sessions s
      ${where}
    ),
    location AS (
      SELECT
        loc_id,
        MIN(geo_city) AS city,
        MIN(geo_region) AS region,
        MIN(geo_country) AS country,
        BOOL_OR(local_flag) AS is_local,
        COUNT(DISTINCT COALESCE(reference_id, id))::int AS count,
        MAX(started_at) AS last_activity,
        MIN(started_at) AS first_activity,
        COUNT(DISTINCT COALESCE(device_id, player_name))::int AS device_count
      FROM base
      GROUP BY loc_id
    ),
    coords AS (
      SELECT DISTINCT ON (loc_id) loc_id, geo_lat, geo_lon
      FROM base
      WHERE geo_lat IS NOT NULL AND geo_lon IS NOT NULL
      GROUP BY loc_id, geo_lat, geo_lon
      ORDER BY loc_id, COUNT(DISTINCT COALESCE(reference_id, id)) DESC, MAX(started_at) DESC
    ),
    ${
      selection
        ? sql`selected AS (
      SELECT l.loc_id
      FROM location l
      LEFT JOIN coords c ON c.loc_id = l.loc_id
      WHERE ${selection}
    ),`
        : sql``
    }
    server_agg AS (
      SELECT
        loc_id,
        JSON_AGG(
          jsonb_build_object('serverId', server_id, 'count', server_count)
          ORDER BY server_count DESC, server_id
        ) AS servers
      FROM (
        SELECT loc_id, server_id, COUNT(DISTINCT COALESCE(reference_id, id))::int AS server_count
        FROM base
        GROUP BY loc_id, server_id
      ) per_server
      GROUP BY loc_id
    ),
    people_counts AS (
      SELECT b.loc_id, su.user_id, COUNT(DISTINCT COALESCE(b.reference_id, b.id))::int AS count
      FROM base b
      JOIN server_users su ON su.id = b.server_user_id
      ${onlySelected('b.loc_id')}
      GROUP BY b.loc_id, su.user_id
    ),
    people AS (
      SELECT DISTINCT ON (pa.loc_id, su.user_id)
        pa.loc_id, su.user_id, su.id, su.server_id, su.username, su.thumb_url, u.name AS identity_name
      FROM (SELECT DISTINCT loc_id, server_user_id FROM base ${onlySelected('loc_id')}) pa
      JOIN server_users su ON su.id = pa.server_user_id
      JOIN users u ON u.id = su.user_id
      ORDER BY pa.loc_id, su.user_id, ${representativeAccountOrderSql('su')}
    ),
    identity_accounts AS (
      SELECT su2.user_id, ARRAY_AGG(su2.id::text ORDER BY su2.id) AS server_user_ids
      FROM server_users su2
      WHERE su2.user_id IN (SELECT user_id FROM people)
      ${buildMultiServerFragment(resolvedIds, 'su2.server_id')}
      GROUP BY su2.user_id
    ),
    people_ranked AS (
      SELECT
        p.*,
        pc.count AS play_count,
        ia.server_user_ids,
        ROW_NUMBER() OVER (
          PARTITION BY p.loc_id
          ORDER BY pc.count DESC, COALESCE(p.identity_name, p.username), p.id
        ) AS person_rank
      FROM people p
      JOIN people_counts pc ON pc.loc_id = p.loc_id AND pc.user_id = p.user_id
      LEFT JOIN identity_accounts ia ON ia.user_id = p.user_id
    ),
    people_agg AS (
      SELECT
        loc_id,
        COUNT(*)::int AS people_count,
        JSON_AGG(
          jsonb_build_object(
            'id', id,
            'username', username,
            'identityName', identity_name,
            'thumbUrl', thumb_url,
            'serverId', server_id,
            'serverUserIds', COALESCE(server_user_ids, ARRAY[id::text]),
            'count', play_count
          )
          ORDER BY person_rank
        ) ${peopleLimit === undefined ? sql`` : sql`FILTER (WHERE person_rank <= ${peopleLimit})`} AS users
      FROM people_ranked
      GROUP BY loc_id
    )
    SELECT
      l.city,
      l.region,
      l.country,
      c.geo_lat AS lat,
      c.geo_lon AS lon,
      l.is_local,
      l.count,
      l.last_activity,
      l.first_activity,
      l.device_count,
      COALESCE(pg.people_count, 0) AS people_count,
      pg.users,
      sa.servers
    FROM location l
    LEFT JOIN coords c ON c.loc_id = l.loc_id
    LEFT JOIN server_agg sa ON sa.loc_id = l.loc_id
    LEFT JOIN people_agg pg ON pg.loc_id = l.loc_id
    ${onlySelected('l.loc_id')}
    ORDER BY l.count DESC, l.loc_id
  `);

  return (
    result.rows as {
      city: string | null;
      region: string | null;
      country: string | null;
      lat: number | null;
      lon: number | null;
      is_local: boolean;
      count: number;
      last_activity: Date;
      first_activity: Date;
      device_count: number;
      people_count: number;
      users: LocationUserInfo[] | null;
      servers: { serverId: string; count: number }[] | null;
    }[]
  ).map((row) => ({
    city: row.city,
    region: row.region,
    country: row.country,
    lat: row.lat,
    lon: row.lon,
    isLocal: row.is_local,
    count: row.count,
    lastActivity: row.last_activity,
    firstActivity: row.first_activity,
    deviceCount: row.device_count,
    users: row.users ?? [],
    peopleCount: row.people_count,
    servers: row.servers ?? [],
  }));
}

export const locationsRoutes: FastifyPluginAsync = async (app) => {
  const readMap = { preHandler: [app.requirePermission('map', 'read')] };
  /**
   * GET /locations - Geo data for stream map with filtering
   *
   * Supports filtering by:
   * - period: Time period (day, week, month, year, all, custom)
   * - startDate/endDate: For custom period, endDate exclusive
   * - serverUserId: Filter to a specific account
   * - serverUserIds: Filter to a person's full set of accounts (takes precedence)
   * - serverId: Legacy single-server filter (kept for back-compat)
   * - serverIds: Repeatable multi-server filter
   * - mediaType: Filter by movie/episode/track
   *
   * Each location carries its first LOCATION_LIST_PEOPLE people; /locations/people has them all.
   */
  app.get('/locations', readMap, async (request, reply) => {
    const query = locationStatsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { resolvedIds, userFragment, baseConditions, mediaCondition, where } = locationFilters(
      query.data,
      request
    );

    const conditions = [...baseConditions, mediaCondition];
    if (userFragment) conditions.push(userFragment);
    const whereClause = where(conditions);

    // Cascading filters: each dropdown's options respect the OTHER active filters
    const userFilterWhereClause = where([...baseConditions, mediaCondition]);

    const mediaFilterConditions = [...baseConditions];
    if (userFragment) mediaFilterConditions.push(userFragment);
    const mediaFilterWhereClause = where(mediaFilterConditions);

    const [locationStats, totalsResult, filtersResult] = await Promise.all([
      queryLocations(whereClause, resolvedIds, { peopleLimit: LOCATION_LIST_PEOPLE }),

      db.execute(sql`
        SELECT COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int AS total_streams
        FROM sessions s
        ${whereClause}
      `),

      // Cascading filter options - each filter type uses conditions from OTHER active filters
      // Note: ORDER BY not allowed within UNION subqueries, sorting done in application code
      db.execute(sql`
          SELECT
            'user' as filter_type,
            rep.id::text as id,
            rep.username as name,
            rep.identity_name as identity_name,
            COALESCE(
              (SELECT ARRAY_AGG(su2.id::text ORDER BY su2.id)
               FROM server_users su2
               WHERE su2.user_id = rep.user_id
               ${buildMultiServerFragment(resolvedIds, 'su2.server_id')}
              ),
              ARRAY[rep.id::text]
            ) AS server_user_ids
          FROM (
            SELECT DISTINCT ON (su.user_id) su.id, su.user_id, su.username, u.name as identity_name
            FROM sessions s
            JOIN server_users su ON su.id = s.server_user_id
            JOIN users u ON su.user_id = u.id
            ${userFilterWhereClause}
            ORDER BY su.user_id, ${representativeAccountOrderSql('su')}
          ) rep

          UNION ALL

          SELECT 'media' as filter_type, s.media_type as id, s.media_type as name, NULL as identity_name,
            NULL::text[] as server_user_ids
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
      server_user_ids: string[] | null;
    }[];
    // Cascading filters are always fetched fresh (no caching since they depend on current selections)
    const availableFilters: LocationFilterOptions = {
      users: filters
        .filter((f) => f.filter_type === 'user')
        .map((f) => ({
          id: f.id,
          username: f.name,
          identityName: f.identity_name,
          serverUserIds: f.server_user_ids ?? [f.id],
        }))
        .sort((a, b) => (a.identityName ?? a.username).localeCompare(b.identityName ?? b.username)),
      mediaTypes: filters
        .filter((f) => f.filter_type === 'media')
        .map((f) => f.name)
        .filter(
          (t): t is 'movie' | 'episode' | 'track' =>
            t === 'movie' || t === 'episode' || t === 'track'
        )
        .sort((a, b) => a.localeCompare(b)),
    };

    const totalStreams =
      (totalsResult.rows[0] as { total_streams: number } | undefined)?.total_streams ?? 0;
    const uniqueLocations = locationStats.length;
    const topCity = locationStats[0]?.city ?? null;

    return {
      data: locationStats,
      summary: {
        totalStreams,
        uniqueLocations,
        topCity,
      },
      availableFilters,
    };
  });

  /**
   * GET /locations/people - The rows of /locations, with every person, for one place (`place`,
   * its key) or for every placed location inside a box (`west`, `south`, `east`, `north`).
   * Takes the same filters as /locations.
   */
  app.get('/locations/people', readMap, async (request, reply) => {
    const query = locationPeopleQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { place, west, south, east, north } = query.data;
    const { resolvedIds, userFragment, baseConditions, mediaCondition, where } = locationFilters(
      query.data,
      request
    );

    const conditions = [...baseConditions, mediaCondition];
    if (userFragment) conditions.push(userFragment);
    if (place) {
      conditions.push(
        sql`jsonb_build_array(s.geo_country, s.geo_region, s.geo_city, ${localSessionSql('s')}) = ${JSON.stringify(place)}::jsonb`
      );
    }
    const selection =
      west === undefined || south === undefined || east === undefined || north === undefined
        ? undefined
        : sql`c.geo_lat BETWEEN ${south} AND ${north} AND c.geo_lon BETWEEN ${west} AND ${east}`;

    const response: LocationPeopleResponse = {
      data: await queryLocations(where(conditions), resolvedIds, { selection }),
    };
    return response;
  });
};
