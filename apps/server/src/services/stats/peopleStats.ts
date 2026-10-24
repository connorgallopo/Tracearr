/**
 * Per-person range stats: one identity's numbers for the user page, and the ranked People
 * table on the stats page. The People table reads plays, watch time and finishes from
 * user_media_plays_daily, one row per chain per UTC day, over whole UTC days. The user page
 * reads everything from sessions over the exact window, so its prior window is the same
 * length and meets it at the same instant.
 */

import { eq, sql, type SQL } from 'drizzle-orm';
import {
  TIME_MS,
  type AuthUser,
  type PeopleRank,
  type PeopleResponse,
  type PeopleSummary,
  type PersonRow,
  type UserRangeStats,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { serverUsers, servers } from '../../db/schema.js';
import { countedSessionSql, localSessionSql } from '../../db/sessions/rules.js';
import { buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { likePattern } from '../../utils/listQuery.js';
import { representativeAccountOrderSql } from '../../utils/representativeAccount.js';
import {
  identityAccountsWhere,
  serverUserIdAnyFragment,
} from '../../routes/users/queries/index.js';
import { getBucketInterval } from '../../routes/stats/plays.js';
import { computeStreaks } from '../../routes/stats/me.js';
import {
  queryPlaysByDayOfWeek,
  queryPlaysByHourOfDay,
  queryPlaysOverTime,
} from '../../routes/stats/queries.js';
import {
  previousRange,
  resolveDateRange,
  type DateRange,
  type StatsPeriod,
} from '../../routes/stats/utils.js';
import { getRequestsAnalytics } from '../requests/analytics.js';
import {
  FINISHED_SQL,
  TREND_BUCKETS,
  alignToUtcDays,
  startOfUtcDay,
  TREND_BUCKETS_SQL,
  bucketLabels,
  percent,
  toIso,
  toSeries,
  trendBucketSql,
} from './windows.js';

export interface PeopleWindow {
  period: StatsPeriod;
  range: DateRange;
  prior: { start: Date; end: Date } | null;
  timezone: string;
  now: Date;
}

interface WindowQuery {
  period: StatsPeriod;
  startDate?: string;
  endDate?: string;
  timezone?: string;
}

function toWindow(query: WindowQuery, range: DateRange, now: Date): PeopleWindow {
  return {
    period: query.period,
    range,
    prior: previousRange(range),
    timezone: query.timezone ?? 'UTC',
    now,
  };
}

export function resolvePeopleWindow(query: WindowQuery, now = new Date()): PeopleWindow {
  const range = resolveDateRange(query.period, query.startDate, query.endDate);
  return toWindow(query, alignToUtcDays(query.period, range), now);
}

/** The exact window for one identity's stats, with no alignment to UTC days. */
export function resolveIdentityWindow(query: WindowQuery, now = new Date()): PeopleWindow {
  const range = resolveDateRange(query.period, query.startDate, query.endDate);
  if (query.period === 'custom') {
    range.end = new Date(startOfUtcDay(range.end) + TIME_MS.DAY);
  }
  return toWindow(query, range, now);
}

const QUIET_DAYS = 90;
const TRANSCODED_SQL = sql.raw(
  "(s.video_decision = 'transcode' OR s.audio_decision = 'transcode')"
);
const BYTES_SQL = sql.raw(
  '(SUM(COALESCE(s.bitrate, 0)::bigint * COALESCE(s.duration_ms, 0)::bigint) / 8)::bigint'
);
const CHAIN_S = sql.raw('COALESCE(s.reference_id, s.id)');

function sessionBoundsSql(start: Date | null, end: Date): SQL {
  const lower = start ? sql`AND s.started_at >= ${start}` : sql``;
  return sql`${lower} AND s.started_at < ${end}`;
}

function peakHour(hours: { hour: number; count: number }[]): number | null {
  let peak: { hour: number; count: number } | null = null;
  for (const entry of hours) {
    if (entry.count > 0 && (!peak || entry.count > peak.count)) peak = entry;
  }
  return peak?.hour ?? null;
}

// ============================================================================
// One identity
// ============================================================================

interface IdentityScope {
  serverUserIds: string[];
  resolvedServerIds: string[] | undefined;
}

function identitySessionsWhere(input: IdentityScope, range: DateRange): SQL {
  return sql`${serverUserIdAnyFragment(input.serverUserIds, 's.server_user_id')}
    ${sessionBoundsSql(range.start, range.end)}
    ${buildMultiServerFragment(input.resolvedServerIds, 's.server_id')}`;
}

// The same per-chain columns user_media_plays_daily keeps, read from sessions so the window
// can start and end at any instant.
function identityChainsCte(input: IdentityScope & DateRange): SQL {
  return sql`
    chains AS (
      SELECT
        ${CHAIN_S} AS chain_id,
        MAX(s.media_id::text)::uuid AS media_id,
        MAX(s.show_media_id::text)::uuid AS show_media_id,
        MAX(s.media_type) AS media_type,
        MAX(s.server_id::text) AS server_id,
        BOOL_OR(${countedSessionSql('s')}) AS counted,
        SUM(CASE WHEN ${countedSessionSql('s')} THEN s.duration_ms ELSE 0 END) AS watched_ms,
        MAX(s.progress_ms) AS max_progress_ms,
        MAX(s.total_duration_ms) AS content_duration_ms
      FROM sessions s
      WHERE ${identitySessionsWhere(input, input)}
      GROUP BY 1
    )`;
}

/** Plays, watch time, finish split and media type split for one identity's accounts. */
export function buildIdentityPlaysSql(input: IdentityScope & DateRange): SQL {
  return sql`
    WITH ${identityChainsCte(input)}
    SELECT
      COUNT(DISTINCT chain_id) FILTER (WHERE counted)::int AS plays,
      COALESCE(SUM(watched_ms), 0)::bigint AS watch_ms,
      COUNT(*) FILTER (WHERE counted AND content_duration_ms > 0 AND (${FINISHED_SQL}))::int AS finished,
      COUNT(*) FILTER (WHERE counted AND content_duration_ms > 0 AND NOT (${FINISHED_SQL}))::int AS abandoned,
      COUNT(*) FILTER (WHERE counted AND media_type = 'movie')::int AS movie,
      COUNT(*) FILTER (WHERE counted AND media_type = 'episode')::int AS episode,
      COUNT(*) FILTER (WHERE counted AND media_type = 'track')::int AS track,
      COUNT(*) FILTER (WHERE counted AND media_type NOT IN ('movie', 'episode', 'track'))::int AS other
    FROM chains
  `;
}

// A merged copy's finishes and plays land on the canonical title, as in me.ts.
function identityMostFinishedSql(input: IdentityScope & DateRange) {
  return sql`
    WITH ${identityChainsCte(input)},
    per_media AS (
      SELECT COALESCE(show_media_id, media_id) AS media_id, COUNT(*)::int AS finished,
             MAX(server_id) AS server_id
      FROM chains
      WHERE counted AND content_duration_ms > 0 AND (${FINISHED_SQL})
      GROUP BY 1
    ),
    top_media AS (
      SELECT canon.id AS media_id, canon.title, canon.media_type AS type,
             SUM(pm.finished)::int AS finished, MAX(pm.server_id) AS played_server_id
      FROM per_media pm
      JOIN media pmr ON pmr.id = pm.media_id
      JOIN media canon ON canon.id = COALESCE(pmr.merged_into_id, pmr.id)
      GROUP BY canon.id
      ORDER BY finished DESC, canon.title
      LIMIT 5
    )
    -- The poster and its server come from one library copy, so the pair can be proxied;
    -- with no copy left the server falls back to where the title was played.
    SELECT tm.media_id, tm.title, tm.type, tm.finished, poster.thumb_path,
           COALESCE(poster.server_id::text, tm.played_server_id) AS server_id
    FROM top_media tm
    LEFT JOIN LATERAL (
      SELECT li.thumb_path, li.server_id FROM library_items li
      WHERE li.media_id = tm.media_id AND li.removed_at IS NULL AND li.thumb_path IS NOT NULL
      ORDER BY li.created_at DESC LIMIT 1
    ) poster ON true
    ORDER BY tm.finished DESC, tm.title
  `;
}

function identityTopGenresSql(input: IdentityScope & DateRange) {
  return sql`
    WITH ${identityChainsCte(input)},
    per_media AS (
      SELECT COALESCE(show_media_id, media_id) AS media_id, COUNT(*) AS plays
      FROM chains
      WHERE counted
      GROUP BY 1
    )
    SELECT genre, SUM(pm.plays)::int AS plays
    FROM per_media pm
    JOIN media pmr ON pmr.id = pm.media_id
    JOIN media canon ON canon.id = COALESCE(pmr.merged_into_id, pmr.id)
    , unnest(canon.genres) AS genre
    WHERE canon.media_type IN ('movie', 'show')
    GROUP BY genre
    ORDER BY plays DESC, genre
    LIMIT 6
  `;
}

interface IdentityPlaysRow {
  plays: number;
  watch_ms: string | number;
  finished: number;
  abandoned: number;
  movie: number;
  episode: number;
  track: number;
  other: number;
}

export async function queryIdentityRangeStats(input: {
  serverUserIds: string[];
  resolvedServerIds: string[] | undefined;
  window: PeopleWindow;
}): Promise<UserRangeStats> {
  const { serverUserIds, resolvedServerIds, window } = input;
  const { range, prior, timezone, now } = window;
  const scope = { serverUserIds, resolvedServerIds };
  const current = { ...scope, ...range };
  const where = identitySessionsWhere(scope, range);
  const bucketInterval = getBucketInterval(window.period);
  const personFilter = sql`${buildMultiServerFragment(resolvedServerIds)} AND ${serverUserIdAnyFragment(serverUserIds, 'server_user_id')}`;
  const serverFilter = buildMultiServerFragment(resolvedServerIds);
  const seriesRange = {
    rangeStart: range.start,
    timezone,
    endDate: range.end,
    allMediaTypes: true,
  };

  const [
    totals,
    priorTotals,
    mostFinished,
    topGenres,
    sessionTotals,
    devices,
    locations,
    days,
    series,
    priorSeries,
    serverAvg,
    playsByDow,
    playsByHour,
    serverHours,
  ] = await Promise.all([
    db.execute(buildIdentityPlaysSql(current)),
    prior ? db.execute(buildIdentityPlaysSql({ ...scope, ...prior })) : null,
    db.execute(identityMostFinishedSql(current)),
    db.execute(identityTopGenresSql(current)),
    db.execute(sql`
      SELECT
        ${BYTES_SQL} AS bytes,
        (SUM(COALESCE(s.bitrate, 0)::bigint) / NULLIF(COUNT(*), 0))::bigint AS avg_bitrate,
        COUNT(DISTINCT ${CHAIN_S}) FILTER (WHERE ${countedSessionSql('s')})::int AS plays,
        COUNT(DISTINCT ${CHAIN_S}) FILTER (WHERE ${countedSessionSql('s')} AND ${TRANSCODED_SQL})::int AS transcodes,
        COUNT(DISTINCT ${CHAIN_S}) FILTER (WHERE ${countedSessionSql('s')} AND ${localSessionSql('s')})::int AS local_plays
      FROM sessions s
      WHERE ${where}
    `),
    db.execute(sql`
      SELECT
        COALESCE(NULLIF(s.device, ''), NULLIF(s.product, ''), 'Unknown') AS device,
        s.platform,
        COUNT(DISTINCT ${CHAIN_S})::int AS sessions,
        COUNT(DISTINCT ${CHAIN_S}) FILTER (WHERE ${TRANSCODED_SQL})::int AS transcodes,
        MAX(s.started_at) AS last_seen_at
      FROM sessions s
      WHERE ${where}
      GROUP BY 1, 2
      ORDER BY sessions DESC, last_seen_at DESC
      LIMIT 5
    `),
    db.execute(sql`
      WITH plays AS (
        SELECT DISTINCT ON (${CHAIN_S})
          s.geo_city, s.geo_region, s.geo_country, ${localSessionSql('s')} AS is_local, s.started_at
        FROM sessions s
        WHERE ${where}
        ORDER BY ${CHAIN_S}, s.started_at DESC
      )
      SELECT geo_city AS city, geo_region AS region, geo_country AS country, is_local,
             COUNT(*)::int AS sessions, MAX(started_at) AS last_seen_at
      FROM plays
      GROUP BY 1, 2, 3, 4
      ORDER BY sessions DESC, last_seen_at DESC
      LIMIT 5
    `),
    db.execute(sql`
      SELECT
        COALESCE(
          ARRAY_AGG(DISTINCT to_char((s.started_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD')),
          '{}'
        ) AS local_days,
        COUNT(DISTINCT (s.started_at AT TIME ZONE 'UTC')::date)::int AS active_days
      FROM sessions s
      WHERE ${where} AND ${countedSessionSql('s')}
    `),
    queryPlaysOverTime({ ...seriesRange, bucketInterval, serverFilter: personFilter }),
    prior
      ? queryPlaysOverTime({
          rangeStart: prior.start,
          endDate: prior.end,
          allMediaTypes: true,
          timezone,
          bucketInterval,
          serverFilter: personFilter,
        })
      : [],
    db.execute(sql`
      SELECT
        time_bucket(${bucketInterval}::interval, s.started_at AT TIME ZONE ${timezone})::text AS date,
        ROUND(
          COUNT(DISTINCT ${CHAIN_S}) FILTER (WHERE ${countedSessionSql('s')})::numeric
            / NULLIF(COUNT(DISTINCT su.user_id), 0),
          2
        )::float8 AS count
      FROM sessions s
      JOIN server_users su ON su.id = s.server_user_id
      WHERE true ${sessionBoundsSql(range.start, range.end)}
        ${buildMultiServerFragment(resolvedServerIds, 's.server_id')}
      GROUP BY 1
      ORDER BY 1
    `),
    queryPlaysByDayOfWeek({ ...seriesRange, serverFilter: personFilter }),
    queryPlaysByHourOfDay({ ...seriesRange, serverFilter: personFilter }),
    queryPlaysByHourOfDay({ ...seriesRange, serverFilter }),
  ]);

  const t = totals.rows[0] as IdentityPlaysRow | undefined;
  const pt = priorTotals?.rows[0] as IdentityPlaysRow | undefined;
  const st = sessionTotals.rows[0] as
    | {
        bytes: string | null;
        avg_bitrate: string | null;
        plays: number;
        transcodes: number;
        local_plays: number;
      }
    | undefined;
  const judged = (t?.finished ?? 0) + (t?.abandoned ?? 0);
  const sessionPlays = st?.plays ?? 0;
  const transcodes = st?.transcodes ?? 0;
  const activity = days.rows[0] as { local_days: string[]; active_days: number } | undefined;
  const labels = range.start
    ? bucketLabels(range.start, range.end, bucketInterval, timezone)
    : null;

  return {
    range: {
      start: toIso(range.start),
      end: range.end.toISOString(),
      priorStart: toIso(prior?.start),
      priorEnd: toIso(prior?.end),
    },
    plays: t?.plays ?? 0,
    priorPlays: prior ? (pt?.plays ?? 0) : null,
    watchMs: Number(t?.watch_ms ?? 0),
    priorWatchMs: prior ? Number(pt?.watch_ms ?? 0) : null,
    finishedRate: percent(t?.finished ?? 0, judged),
    abandonedRate: percent(t?.abandoned ?? 0, judged),
    directPlayRate: percent(sessionPlays - transcodes, sessionPlays),
    transcodes,
    localShare: percent(st?.local_plays ?? 0, sessionPlays),
    bytes: Number(st?.bytes ?? 0),
    avgBitrateKbps: st?.avg_bitrate == null ? null : Number(st.avg_bitrate),
    activeDays: activity?.active_days ?? 0,
    daysInRange: range.start
      ? (startOfUtcDay(new Date(range.end.getTime() - 1)) - startOfUtcDay(range.start)) /
          TIME_MS.DAY +
        1
      : null,
    currentStreak: computeStreaks(activity?.local_days ?? [], now, timezone).currentStreak,
    playsByDay: toSeries(series, labels),
    priorPlaysByDay: prior
      ? toSeries(priorSeries, bucketLabels(prior.start, prior.end, bucketInterval, timezone))
      : [],
    serverAvgPlaysByDay: toSeries(serverAvg.rows as { date: string; count: number }[], labels),
    playsByDow,
    playsByHour,
    serverPeakHour: peakHour(serverHours),
    personPeakHour: peakHour(playsByHour),
    mediaTypeSplit: {
      movie: t?.movie ?? 0,
      episode: t?.episode ?? 0,
      track: t?.track ?? 0,
      other: t?.other ?? 0,
    },
    topGenres: topGenres.rows as UserRangeStats['topGenres'],
    mostFinished: (
      mostFinished.rows as {
        media_id: string;
        title: string;
        type: string;
        finished: number;
        thumb_path: string | null;
        server_id: string;
      }[]
    ).map((row) => ({
      mediaId: row.media_id,
      title: row.title,
      type: row.type,
      finished: row.finished,
      thumbPath: row.thumb_path,
      serverId: row.server_id,
    })),
    devices: (
      devices.rows as {
        device: string;
        platform: string | null;
        sessions: number;
        transcodes: number;
        last_seen_at: Date | string | null;
      }[]
    ).map((row) => ({
      device: row.device,
      platform: row.platform,
      sessions: row.sessions,
      directPlayRate: percent(row.sessions - row.transcodes, row.sessions),
      lastSeenAt: toIso(row.last_seen_at),
    })),
    locations: (
      locations.rows as {
        city: string | null;
        region: string | null;
        country: string | null;
        is_local: boolean;
        sessions: number;
        last_seen_at: Date | string | null;
      }[]
    ).map((row) => ({
      city: row.city,
      region: row.region,
      country: row.country,
      sessions: row.sessions,
      isLocal: row.is_local,
      lastSeenAt: toIso(row.last_seen_at),
    })),
  };
}

// ============================================================================
// People table
// ============================================================================

export interface PersonRequests {
  userId: string;
  requests: number;
  requestsWatched: number;
}

interface PeopleRowsInput {
  resolvedServerIds: string[] | undefined;
  window: PeopleWindow;
  search?: string;
  requests: PersonRequests[];
}

const RANK_ORDER: Record<PeopleRank, string> = {
  plays: 'plays DESC',
  hours: 'watch_ms DESC',
  data: 'bytes DESC',
  transcodes: 'transcode_share DESC NULLS LAST, transcodes DESC',
  requests: 'requests_watched DESC, requests DESC',
  lastSeen: 'last_play_at DESC NULLS LAST',
};

/**
 * Every identity holding an account on the resolved servers, zero-play people included, with
 * one representative account and their range aggregates. `last_play_at` is the latest session
 * start across their accounts (server_users.last_activity_at), not bound by the range.
 */
function peopleRowsCte(input: PeopleRowsInput): SQL {
  const { resolvedServerIds, window, search } = input;
  const { range } = window;
  const accountServers = buildMultiServerFragment(resolvedServerIds, 'su.server_id');
  const trend = Array.from(
    { length: TREND_BUCKETS },
    (_, i) => sql`COUNT(*) FILTER (WHERE counted AND bucket = ${sql.raw(String(i + 1))})`
  );
  const pattern = search ? likePattern(search) : null;
  const matched = pattern
    ? sql`(u.name ILIKE ${pattern} OR EXISTS (
        SELECT 1 FROM server_users msu
        WHERE msu.user_id = u.id ${buildMultiServerFragment(resolvedServerIds, 'msu.server_id')}
          AND msu.username ILIKE ${pattern}))`
    : sql`true`;

  return sql`
    WITH accounts AS (
      SELECT su.id, su.user_id, su.last_activity_at
      FROM server_users su
      WHERE true ${accountServers}
    ),
    people AS (
      SELECT user_id, MAX(last_activity_at) AS last_play_at FROM accounts GROUP BY user_id
    ),
    chains AS (
      SELECT
        a.user_id,
        ${CHAIN_S} AS chain_id,
        MIN(s.started_at) AS first_day,
        BOOL_OR(${countedSessionSql('s')}) AS counted,
        SUM(CASE WHEN ${countedSessionSql('s')} THEN s.duration_ms ELSE 0 END) AS watched_ms,
        ${BYTES_SQL} AS bytes,
        BOOL_OR(${countedSessionSql('s')} AND ${TRANSCODED_SQL}) AS transcoded
      FROM sessions s
      JOIN accounts a ON a.id = s.server_user_id
      WHERE true ${sessionBoundsSql(range.start, range.end)}
        ${buildMultiServerFragment(resolvedServerIds, 's.server_id')}
      GROUP BY a.user_id, ${CHAIN_S}
    ),
    bucketed AS (
      SELECT *, ${trendBucketSql(range)} AS bucket FROM chains
    ),
    totals AS (
      SELECT
        user_id,
        COUNT(*) FILTER (WHERE counted)::int AS plays,
        COALESCE(SUM(watched_ms), 0)::bigint AS watch_ms,
        ARRAY[${sql.join(trend, sql`, `)}]::int[] AS trend,
        COALESCE(SUM(bytes), 0)::bigint AS bytes,
        COUNT(*) FILTER (WHERE transcoded)::int AS transcodes
      FROM bucketed
      GROUP BY user_id
    ),
    request_totals AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(input.requests)}::jsonb)
        AS r("userId" uuid, requests int, "requestsWatched" int)
    ),
    rows AS (
      SELECT
        u.id AS user_id,
        u.name AS identity_name,
        u.aggregate_trust_score AS trust_score,
        rep.id AS server_user_id,
        rep.username,
        rep.thumb_url,
        rep.server_id::text AS server_id,
        COALESCE(t.plays, 0) AS plays,
        COALESCE(t.watch_ms, 0)::bigint AS watch_ms,
        COALESCE(t.trend, ARRAY_FILL(0, ARRAY[${TREND_BUCKETS_SQL}])) AS trend,
        COALESCE(t.bytes, 0)::bigint AS bytes,
        COALESCE(t.transcodes, 0) AS transcodes,
        ROUND(100.0 * t.transcodes / NULLIF(t.plays, 0), 1)::float8 AS transcode_share,
        COALESCE(rt.requests, 0) AS requests,
        COALESCE(rt."requestsWatched", 0) AS requests_watched,
        pp.last_play_at,
        ${matched} AS matched
      FROM people pp
      JOIN users u ON u.id = pp.user_id
      INNER JOIN LATERAL (
        SELECT su.id, su.username, su.thumb_url, su.server_id
        FROM server_users su
        WHERE su.user_id = u.id ${accountServers}
        ORDER BY ${representativeAccountOrderSql('su')}
        LIMIT 1
      ) rep ON true
      LEFT JOIN totals t ON t.user_id = u.id
      LEFT JOIN request_totals rt ON rt."userId" = u.id
    )`;
}

/** One page of people, ranked. Zero-play people sort last for every rank but lastSeen. */
export function buildPeopleRowsSql(
  input: PeopleRowsInput & { rank: PeopleRank; pageSize: number; offset: number }
): SQL {
  const zeroPlaysLast = input.rank === 'lastSeen' ? '' : '(plays = 0), ';
  return sql`
    ${peopleRowsCte(input)}
    SELECT * FROM rows
    WHERE matched
    ORDER BY ${sql.raw(`${zeroPlaysLast}${RANK_ORDER[input.rank]}, user_id`)}
    LIMIT ${input.pageSize} OFFSET ${input.offset}
  `;
}

function buildPeopleSummarySql(input: PeopleRowsInput): SQL {
  const quietCutoff = new Date(input.window.now.getTime() - QUIET_DAYS * TIME_MS.DAY);
  return sql`
    ${peopleRowsCte(input)}
    SELECT
      COUNT(*)::int AS total_people,
      COUNT(*) FILTER (WHERE matched)::int AS matched_people,
      COUNT(*) FILTER (WHERE plays > 0)::int AS active_people,
      COALESCE(SUM(plays), 0)::int AS total_plays,
      (SELECT COALESCE(SUM(plays), 0) FROM (SELECT plays FROM rows ORDER BY plays DESC LIMIT 3) top)::int AS top_three_plays,
      COALESCE(SUM(transcodes), 0)::int AS total_transcodes,
      COALESCE(MAX(transcodes), 0)::int AS top_transcoder_count,
      COUNT(*) FILTER (WHERE last_play_at < ${quietCutoff})::int AS quiet_people
    FROM rows
  `;
}

interface PersonSqlRow {
  user_id: string;
  identity_name: string | null;
  trust_score: number | null;
  server_user_id: string;
  username: string;
  thumb_url: string | null;
  server_id: string | null;
  plays: number;
  watch_ms: string | number;
  trend: number[];
  bytes: string | number;
  transcodes: number;
  transcode_share: number | null;
  requests: number;
  requests_watched: number;
  last_play_at: Date | string | null;
}

interface SummarySqlRow {
  total_people: number;
  matched_people: number;
  active_people: number;
  total_plays: number;
  top_three_plays: number;
  total_transcodes: number;
  top_transcoder_count: number;
  quiet_people: number;
}

async function fetchIdentityServers(
  authUser: AuthUser,
  userIds: string[]
): Promise<Map<string, { id: string; name: string }[]>> {
  const byUser = new Map<string, { id: string; name: string }[]>();
  if (userIds.length === 0) return byUser;
  const rows = await db
    .selectDistinct({
      userId: serverUsers.userId,
      serverId: serverUsers.serverId,
      serverName: servers.name,
    })
    .from(serverUsers)
    .innerJoin(servers, eq(serverUsers.serverId, servers.id))
    .where(identityAccountsWhere(authUser, userIds));
  for (const row of rows) {
    const entry = { id: row.serverId, name: row.serverName };
    const existing = byUser.get(row.userId);
    if (existing) existing.push(entry);
    else byUser.set(row.userId, [entry]);
  }
  return byUser;
}

export async function queryPeopleRanked(input: {
  authUser: AuthUser;
  resolvedServerIds: string[] | undefined;
  window: PeopleWindow;
  rank: PeopleRank;
  page: number;
  pageSize: number;
  search?: string;
}): Promise<PeopleResponse> {
  const { authUser, resolvedServerIds, window, rank, page, pageSize, search } = input;
  const analytics = await getRequestsAnalytics(resolvedServerIds, 'all', false);
  const requests = analytics.requesters.flatMap(({ requester, requested, watched }) =>
    requester.userId
      ? [{ userId: requester.userId, requests: requested, requestsWatched: watched }]
      : []
  );
  const rowsInput = { resolvedServerIds, window, search, requests };

  const [pageResult, summaryResult] = await Promise.all([
    db.execute(buildPeopleRowsSql({ ...rowsInput, rank, pageSize, offset: (page - 1) * pageSize })),
    db.execute(buildPeopleSummarySql(rowsInput)),
  ]);
  const rows = pageResult.rows as unknown as PersonSqlRow[];
  const s = summaryResult.rows[0] as SummarySqlRow | undefined;
  const identityServers = await fetchIdentityServers(
    authUser,
    rows.map((row) => row.user_id)
  );

  const data: PersonRow[] = rows.map((row) => ({
    userId: row.user_id,
    serverUserId: row.server_user_id,
    username: row.username,
    identityName: row.identity_name,
    thumbUrl: row.thumb_url,
    serverId: row.server_id,
    trustScore: row.trust_score,
    plays: row.plays,
    watchMs: Number(row.watch_ms),
    bytes: Number(row.bytes),
    directPlayRate: percent(row.plays - row.transcodes, row.plays),
    transcodes: row.transcodes,
    transcodeShare: row.transcode_share,
    requests: row.requests,
    requestsWatched: row.requests_watched,
    lastPlayAt: toIso(row.last_play_at),
    trend: row.trend,
    identityServers: identityServers.get(row.user_id) ?? [],
  }));

  const totalTranscodes = s?.total_transcodes ?? 0;
  const topTranscoderCount = s?.top_transcoder_count ?? 0;
  const summary: PeopleSummary = {
    activePeople: s?.active_people ?? 0,
    totalPeople: s?.total_people ?? 0,
    topThreeShare: percent(s?.top_three_plays ?? 0, s?.total_plays ?? 0),
    topTranscoderShare: percent(topTranscoderCount, totalTranscodes),
    topTranscoderCount,
    totalTranscodes,
    quietPeople: s?.quiet_people ?? 0,
    quietDays: QUIET_DAYS,
  };

  return { data, summary, meta: { page, pageSize, total: s?.matched_people ?? 0 } };
}
