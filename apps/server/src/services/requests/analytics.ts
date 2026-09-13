import { sql, type SQL } from 'drizzle-orm';
import type {
  MediaRequestMediaType,
  RequesterFollowThrough,
  RequestOutcomeRow,
  RequestRequester,
  RequestSeason,
  RequestsFunnel,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { uuidArraySql } from '../../utils/sqlArrays.js';

export interface RequestsAnalyticsData {
  funnel: RequestsFunnel;
  unplayed: RequestOutcomeRow[];
  unplayedBytes: number;
  requesters: RequesterFollowThrough[];
}

const NO_SEASON = -1;

interface AnalyticsSqlRow {
  id: string;
  server_id: string;
  media_id: string | null;
  media_type: MediaRequestMediaType;
  title: string | null;
  year: number | null;
  requested_at: Date | string;
  available_at: Date | string | null;
  seasons: RequestSeason[] | null;
  lens_user_id: string | null;
  remote_username: string;
  server_user_id: string | null;
  user_server_id: string | null;
  username: string | null;
  identity_name: string | null;
  thumb: string | null;
}

function at(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function requesterOf(row: AnalyticsSqlRow): RequestRequester {
  return row.server_user_id
    ? {
        serverUserId: row.server_user_id,
        userId: row.lens_user_id,
        serverId: row.user_server_id ?? row.server_id,
        username: row.username,
        identityName: row.identity_name,
        thumb: row.thumb,
      }
    : {
        serverUserId: null,
        userId: null,
        serverId: row.server_id,
        username: row.remote_username,
        identityName: null,
        thumb: null,
      };
}

function requesterKey(row: AnalyticsSqlRow): string {
  return row.lens_user_id ?? `remote:${row.server_id}:${row.remote_username}`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  if (sorted.length % 2 === 1) return sorted[Math.floor(mid)] ?? null;
  const low = sorted[mid - 1];
  const high = sorted[mid];
  return low === undefined || high === undefined ? null : (low + high) / 2;
}

type SizeIndex = Map<string, Map<number, number>>;

/** Mirror-deduped like mediaSizeSubquery: one file indexed by several libraries or servers counts once. */
async function fetchSizeIndex(
  mediaIds: string[],
  serverIds: string[] | undefined
): Promise<SizeIndex> {
  const index: SizeIndex = new Map();
  if (mediaIds.length === 0) return index;
  const serverFragment = buildMultiServerFragment(serverIds, 'li2.server_id');
  const result = await db.execute(sql`
    SELECT media_id, season, COALESCE(SUM(sz), 0) AS bytes
    FROM (
      SELECT DISTINCT
        COALESCE(im.show_media_id, im.id) AS media_id,
        CASE WHEN im.media_type = 'episode' THEN li2.parent_index END AS season,
        li2.media_id AS item_media_id,
        v.file_size AS sz
      FROM library_items li2
      JOIN library_item_versions v
        ON v.library_item_id = li2.id AND v.removed_at IS NULL AND v.file_size IS NOT NULL
      JOIN media im ON im.id = li2.media_id
      WHERE COALESCE(im.show_media_id, im.id) = ANY(${uuidArraySql(mediaIds)})
        AND li2.removed_at IS NULL ${serverFragment}
    ) d
    GROUP BY media_id, season
  `);

  for (const row of result.rows as unknown as {
    media_id: string;
    season: number | null;
    bytes: string | number;
  }[]) {
    const buckets = index.get(row.media_id) ?? new Map<number, number>();
    buckets.set(row.season ?? NO_SEASON, Number(row.bytes));
    index.set(row.media_id, buckets);
  }
  return index;
}

/** Expects library_items aliased as li. */
function inRequestedSeasons(seasons: SQL): SQL {
  return sql`(
    COALESCE(jsonb_array_length(${seasons}), 0) = 0
    OR li.parent_index IN (SELECT (s->>'seasonNumber')::int FROM jsonb_array_elements(${seasons}) s)
  )`;
}

interface RequestPlays {
  watched: boolean;
  watchedBy: Set<string>;
}

/**
 * Every request anyone played; absent means no plays. Unlike the library
 * badges, episodes whose files were deleted still count toward watched.
 */
async function fetchRequestPlays(
  serverIds: string[] | undefined
): Promise<Map<string, RequestPlays>> {
  const authFragment = buildMultiServerFragment(serverIds, 'rs.server_id');
  const playFragment = buildMultiServerFragment(serverIds, 'p2.server_id');
  const itemFragment = buildMultiServerFragment(serverIds, 'li.server_id');
  // Same LATERAL/OFFSET 0 shape as the watched probes, so each alias row
  // probes the cagg's media_id or show_media_id index instead of seq-scanning it.
  const result = await db.execute(sql`
    WITH req AS (
      SELECT mr.id, COALESCE(cm.merged_into_id, cm.id) AS media_id, mr.media_type, mr.seasons
      FROM media_requests mr
      JOIN request_services rs ON rs.id = mr.service_id
      JOIN media cm ON cm.id = mr.media_id
      WHERE mr.deleted_at IS NULL AND mr.available_at IS NOT NULL ${authFragment}
    ), episodes AS (
      SELECT r.id, COUNT(e.id)::int AS episode_count
      FROM req r
      JOIN media e ON e.show_media_id = r.media_id AND e.media_type = 'episode'
      WHERE r.media_type = 'show'
        AND EXISTS (
          SELECT 1 FROM library_items li
          WHERE li.media_id = e.id ${itemFragment} AND ${inRequestedSeasons(sql`r.seasons`)}
        )
      GROUP BY r.id
    ), alias AS (
      SELECT id, media_type, seasons, media_id AS any_id FROM req
      UNION ALL
      SELECT r.id, r.media_type, r.seasons, m.id
      FROM req r JOIN media m ON m.merged_into_id = r.media_id
    )
    SELECT
      al.id AS request_id,
      vsu.user_id AS viewer_user_id,
      CASE WHEN al.media_type = 'show'
        THEN COALESCE(ep.episode_count, 0) > 0
          AND COUNT(DISTINCT p.media_id) FILTER (
            WHERE p.any_watched AND EXISTS (
              SELECT 1 FROM library_items li
              WHERE li.media_id = p.media_id ${itemFragment}
                AND ${inRequestedSeasons(sql`al.seasons`)}
            )
          ) >= ep.episode_count
        ELSE BOOL_OR(p.any_watched)
      END AS watched
    FROM alias al
    CROSS JOIN LATERAL (
      SELECT p2.media_id, p2.plays, p2.any_watched, p2.server_user_id
      FROM user_media_plays_daily p2
      WHERE al.media_type = 'show' AND p2.show_media_id = al.any_id ${playFragment}
      UNION ALL
      SELECT p2.media_id, p2.plays, p2.any_watched, p2.server_user_id
      FROM user_media_plays_daily p2
      WHERE al.media_type <> 'show' AND p2.media_id = al.any_id ${playFragment}
      OFFSET 0
    ) p
    JOIN server_users vsu ON vsu.id = p.server_user_id
    LEFT JOIN episodes ep ON ep.id = al.id
    WHERE (p.plays > 0 OR p.any_watched)
      AND (
        al.media_type <> 'show'
        OR COALESCE(jsonb_array_length(al.seasons), 0) = 0
        OR EXISTS (
          SELECT 1 FROM library_items li
          WHERE li.media_id = p.media_id ${itemFragment} AND ${inRequestedSeasons(sql`al.seasons`)}
        )
      )
    GROUP BY GROUPING SETS (
      (al.id, al.media_type, ep.episode_count, vsu.user_id),
      (al.id, al.media_type, ep.episode_count)
    )
  `);

  const byRequest = new Map<string, RequestPlays>();
  for (const row of result.rows as unknown as {
    request_id: string;
    /** Null on the everyone-combined row; server_users.user_id is never null. */
    viewer_user_id: string | null;
    watched: boolean;
  }[]) {
    const plays = byRequest.get(row.request_id) ?? { watched: false, watchedBy: new Set<string>() };
    if (row.viewer_user_id === null) plays.watched = row.watched;
    else if (row.watched) plays.watchedBy.add(row.viewer_user_id);
    byRequest.set(row.request_id, plays);
  }
  return byRequest;
}

function bucketsFor(
  index: SizeIndex,
  mediaId: string,
  seasons: RequestSeason[] | null
): [number, number][] {
  const buckets = index.get(mediaId);
  if (!buckets) return [];
  if (!seasons || seasons.length === 0) return [...buckets];
  return [...new Set(seasons.map((season) => season.seasonNumber))].flatMap((season) => {
    const bytes = buckets.get(season);
    return bytes === undefined ? [] : [[season, bytes] as [number, number]];
  });
}

function chargedBytes(rows: RequestOutcomeRow[], buckets: Map<string, [number, number][]>): number {
  const charged = new Map<string, number>();
  for (const row of rows) {
    for (const [season, bytes] of buckets.get(row.id) ?? []) {
      charged.set(`${row.mediaId ?? ''}|${season}`, bytes);
    }
  }
  return [...charged.values()].reduce((sum, bytes) => sum + bytes, 0);
}

export async function getRequestsAnalytics(
  serverIds: string[] | undefined
): Promise<RequestsAnalyticsData> {
  const authFragment = buildMultiServerFragment(serverIds, 'rs.server_id');
  const result = await db.execute(sql`
    SELECT
      mr.id,
      rs.server_id,
      COALESCE(cm.merged_into_id, mr.media_id) AS media_id,
      mr.media_type,
      mr.title,
      mr.year,
      mr.requested_at,
      mr.available_at,
      mr.seasons,
      mr.remote_username,
      mr.server_user_id,
      su.user_id AS lens_user_id,
      su.server_id AS user_server_id,
      su.username,
      u.name AS identity_name,
      COALESCE(u.thumbnail, su.thumb_url) AS thumb
    FROM media_requests mr
    JOIN request_services rs ON rs.id = mr.service_id
    -- A merge repoints library rows but not requests, so the id stored at sync time can be a loser.
    LEFT JOIN media cm ON cm.id = mr.media_id
    LEFT JOIN server_users su ON su.id = mr.server_user_id
    LEFT JOIN users u ON u.id = su.user_id
    WHERE mr.deleted_at IS NULL ${authFragment}
    ORDER BY mr.requested_at DESC, mr.id
  `);

  const rows = result.rows as unknown as AnalyticsSqlRow[];
  // Without a matched title there are no plays to measure, so an unmatched request never lands.
  const landed = rows.filter((row) => row.available_at !== null && row.media_id !== null);
  const sizeIndex = await fetchSizeIndex(
    [...new Set(landed.flatMap((row) => (row.media_id ? [row.media_id] : [])))],
    serverIds
  );
  const plays = await fetchRequestPlays(serverIds);

  const sizeBuckets = new Map<string, [number, number][]>();
  const outcomes = landed.map((row): RequestOutcomeRow => {
    const availableAt = row.available_at ? at(row.available_at) : null;
    const rowBuckets = row.media_id ? bucketsFor(sizeIndex, row.media_id, row.seasons) : [];
    sizeBuckets.set(row.id, rowBuckets);
    return {
      id: row.id,
      mediaId: row.media_id,
      mediaType: row.media_type,
      title: row.title,
      year: row.year,
      requestedAt: at(row.requested_at).toISOString(),
      availableAt: availableAt?.toISOString() ?? null,
      waitMs: availableAt ? availableAt.getTime() - at(row.requested_at).getTime() : null,
      seasons: row.seasons,
      fileSizeBytes: rowBuckets.reduce((sum, [, bytes]) => sum + bytes, 0),
      requester: requesterOf(row),
    };
  });

  const watchedBy = (id: string) => plays.get(id)?.watchedBy ?? new Set<string>();
  // Zero plays, not under 85%: this list drives deletion, and a half-watched
  // title is not one nobody wanted. Nothing on disk means nothing to reclaim.
  const unplayed = outcomes
    .filter((row) => !plays.has(row.id) && row.fileSizeBytes > 0)
    .sort((a, b) => b.fileSizeBytes - a.fileSizeBytes);

  const landedById = new Map(outcomes.map((row) => [row.id, row]));
  const buckets = new Map<string, { requester: RequestRequester; rows: AnalyticsSqlRow[] }>();
  for (const row of rows) {
    const key = requesterKey(row);
    const bucket = buckets.get(key) ?? { requester: requesterOf(row), rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }

  const requesters: RequesterFollowThrough[] = [...buckets.values()]
    .map((bucket) => {
      const landedRows = bucket.rows.flatMap((row) => landedById.get(row.id) ?? []);
      return {
        requester: bucket.requester,
        requested: bucket.rows.length,
        landed: landedRows.length,
        watched: landedRows.filter(
          (row) => row.requester.userId !== null && watchedBy(row.id).has(row.requester.userId)
        ).length,
        watchedByOthers: landedRows.filter((row) =>
          [...watchedBy(row.id)].some((viewer) => viewer !== row.requester.userId)
        ).length,
        medianWaitMs: median(
          landedRows.flatMap((row) => (row.waitMs === null ? [] : [row.waitMs]))
        ),
      };
    })
    .sort((a, b) => b.requested - a.requested);

  return {
    funnel: {
      requested: rows.length,
      landed: outcomes.length,
      watched: outcomes.filter((row) => plays.get(row.id)?.watched === true).length,
    },
    unplayed,
    unplayedBytes: chargedBytes(unplayed, sizeBuckets),
    requesters,
  };
}
