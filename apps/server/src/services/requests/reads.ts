/**
 * Read queries behind the two request surfaces: a media item's requesters and
 * one identity's request history. Neither talks to Seerr.
 *
 * `watchedState` reuses the library's own probe so a request row and the
 * poster badge above it never disagree. The probe is identity-grained, so the
 * rows are grouped by requester identity and probed once per group.
 */

import { sql } from 'drizzle-orm';
import type {
  MediaRequestEntry,
  MediaRequestMediaType,
  MediaRequestStatus,
  RequestSeason,
  UserRequestEntry,
  UserRequestsResponse,
  WatchedState,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { uuidArraySql } from '../../utils/sqlArrays.js';
import { fetchEpisodeCounts, resolveWatchedStates } from '../library/mediaWatchedService.js';
import type { MediaScope } from '../library/mediaDetailService.js';
import type { SQL } from 'drizzle-orm';

/** Bounds the never-watched scan so a heavy requester cannot turn a page into a full-history probe. */
const NEVER_WATCHED_SCAN_LIMIT = 500;

const EMPTY_SUMMARY: UserRequestsResponse['summary'] = {
  total: 0,
  approvalRate: null,
  completed: 0,
  neverWatched: 0,
  medianWaitMs: null,
};

interface RequestBaseRow {
  id: string;
  server_id: string;
  media_id: string | null;
  media_type: MediaRequestMediaType;
  status: MediaRequestStatus;
  requested_at: Date | string;
  available_at: Date | string | null;
  deleted_at: Date | string | null;
  seasons: RequestSeason[] | null;
  is_4k: boolean;
  is_auto_request: boolean;
  lens_user_id: string | null;
}

interface MediaRequestSqlRow extends RequestBaseRow {
  remote_username: string;
  server_user_id: string | null;
  user_server_id: string | null;
  username: string | null;
  identity_name: string | null;
  thumb: string | null;
}

interface UserRequestSqlRow extends RequestBaseRow {
  title: string | null;
  year: number | null;
}

interface UserSummarySqlRow {
  total: number;
  completed: number;
  approved_or_completed: number;
  decided: number;
  median_wait_ms: number | null;
}

interface WatchedLensRow {
  id: string;
  mediaId: string | null;
  mediaType: MediaRequestMediaType;
  lensUserId: string | null;
}

function mediaIdsOf(rows: WatchedLensRow[], kind: MediaRequestMediaType): string[] {
  return [
    ...new Set(
      rows.filter((r) => r.mediaType === kind).flatMap((r) => (r.mediaId ? [r.mediaId] : []))
    ),
  ];
}

/**
 * One probe per requester identity, over the distinct media in that group.
 * A request with no matched media or no matched requester has nothing to lens
 * and stays unwatched.
 */
async function watchedStatesFor(
  rows: WatchedLensRow[],
  serverIds: string[] | undefined
): Promise<Map<string, WatchedState>> {
  const out = new Map<string, WatchedState>();
  const byLens = new Map<string, WatchedLensRow[]>();
  for (const row of rows) {
    if (!row.mediaId || !row.lensUserId) {
      out.set(row.id, 'unwatched');
      continue;
    }
    const bucket = byLens.get(row.lensUserId) ?? [];
    bucket.push(row);
    byLens.set(row.lensUserId, bucket);
  }

  if (byLens.size === 0) return out;

  const buckets = [...byLens];
  // The episode denominator does not vary by requester, so it is one query for
  // every lens rather than one per bucket.
  const episodeCounts = await fetchEpisodeCounts(
    mediaIdsOf(
      buckets.flatMap(([, bucket]) => bucket),
      'show'
    ),
    serverIds
  );

  const probed = await Promise.all(
    buckets.map(async ([lensUserId, bucket]) => ({
      bucket,
      states: await resolveWatchedStates({
        movieIds: mediaIdsOf(bucket, 'movie'),
        showIds: mediaIdsOf(bucket, 'show'),
        serverIds,
        lensUserId,
        episodeCounts,
      }),
    }))
  );

  for (const { bucket, states } of probed) {
    for (const row of bucket) {
      out.set(row.id, (row.mediaId ? states.get(row.mediaId) : undefined) ?? 'unwatched');
    }
  }
  return out;
}

/** node-postgres hands raw-query timestamps back as strings, the same coercion the v2 history rows do. */
function at(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function waitMs(row: RequestBaseRow): number | null {
  return row.available_at ? at(row.available_at).getTime() - at(row.requested_at).getTime() : null;
}

function toLensRow(row: RequestBaseRow): WatchedLensRow {
  return {
    id: row.id,
    mediaId: row.media_id,
    mediaType: row.media_type,
    lensUserId: row.lens_user_id,
  };
}

function baseEntry(row: RequestBaseRow, watchedState: WatchedState) {
  return {
    id: row.id,
    serverId: row.server_id,
    status: row.status,
    requestedAt: at(row.requested_at).toISOString(),
    availableAt: row.available_at ? at(row.available_at).toISOString() : null,
    waitMs: waitMs(row),
    deletedAt: row.deleted_at ? at(row.deleted_at).toISOString() : null,
    seasons: row.seasons,
    is4k: row.is_4k,
    isAutoRequest: row.is_auto_request,
    watchedState,
  };
}

/** A season page shows the show's requests, narrowed to the ones covering that season. */
function scopeFilter(scope: MediaScope): SQL {
  if (scope.kind === 'season') {
    return sql`mr.media_id = ANY(${uuidArraySql(scope.showAliases)})
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(mr.seasons, '[]'::jsonb)) s
        WHERE (s->>'seasonNumber')::int = ${scope.seasonNumber}
      )`;
  }
  return sql`mr.media_id = ANY(${uuidArraySql(scope.aliases)})`;
}

export interface ListMediaRequestsArgs {
  scope: MediaScope;
  serverIds: string[] | undefined;
}

export async function listMediaRequests(args: ListMediaRequestsArgs): Promise<MediaRequestEntry[]> {
  const { scope, serverIds } = args;
  const authFragment = buildMultiServerFragment(serverIds, 'rs.server_id');
  const result = await db.execute(sql`
    SELECT
      mr.id,
      rs.server_id,
      mr.media_id,
      mr.media_type,
      mr.status,
      mr.requested_at,
      mr.available_at,
      mr.deleted_at,
      mr.seasons,
      mr.is_4k,
      mr.is_auto_request,
      mr.remote_username,
      mr.server_user_id,
      su.user_id AS lens_user_id,
      su.server_id AS user_server_id,
      su.username,
      u.name AS identity_name,
      COALESCE(u.thumbnail, su.thumb_url) AS thumb
    FROM media_requests mr
    JOIN request_services rs ON rs.id = mr.service_id
    LEFT JOIN server_users su ON su.id = mr.server_user_id
    LEFT JOIN users u ON u.id = su.user_id
    WHERE ${scopeFilter(scope)} ${authFragment}
    ORDER BY mr.requested_at, mr.id
  `);

  const rows = result.rows as unknown as MediaRequestSqlRow[];
  const states = await watchedStatesFor(rows.map(toLensRow), serverIds);

  return rows.map((row) => ({
    ...baseEntry(row, states.get(row.id) ?? 'unwatched'),
    requester: row.server_user_id
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
        },
  }));
}

export interface ListUserRequestsArgs {
  serverUserIds: string[];
  serverIds: string[] | undefined;
  page: number;
  pageSize: number;
}

export async function listUserRequests(args: ListUserRequestsArgs): Promise<UserRequestsResponse> {
  const { serverUserIds, serverIds, page, pageSize } = args;
  if (serverUserIds.length === 0) {
    return { data: [], total: 0, page, pageSize, summary: EMPTY_SUMMARY };
  }

  const ids = uuidArraySql(serverUserIds);
  const scoped = sql`mr.server_user_id = ANY(${ids}) AND mr.deleted_at IS NULL`;

  const [pageResult, summaryResult, completedResult] = await Promise.all([
    db.execute(sql`
      SELECT
        mr.id,
        rs.server_id,
        mr.media_id,
        mr.media_type,
        mr.title,
        mr.year,
        mr.status,
        mr.requested_at,
        mr.available_at,
        mr.deleted_at,
        mr.seasons,
        mr.is_4k,
        mr.is_auto_request,
        su.user_id AS lens_user_id
      FROM media_requests mr
      JOIN request_services rs ON rs.id = mr.service_id
      JOIN server_users su ON su.id = mr.server_user_id
      WHERE ${scoped}
      ORDER BY mr.requested_at DESC, mr.id
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `),
    db.execute(sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE mr.status = 'completed')::int AS completed,
        count(*) FILTER (WHERE mr.status IN ('approved', 'completed'))::int AS approved_or_completed,
        count(*) FILTER (WHERE mr.status <> 'pending')::int AS decided,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (mr.available_at - mr.requested_at)) * 1000
        ) FILTER (WHERE mr.available_at IS NOT NULL) AS median_wait_ms
      FROM media_requests mr
      WHERE ${scoped}
    `),
    db.execute(sql`
      SELECT mr.id, mr.media_id, mr.media_type, su.user_id AS lens_user_id
      FROM media_requests mr
      JOIN server_users su ON su.id = mr.server_user_id
      WHERE ${scoped} AND mr.status = 'completed'
      ORDER BY mr.requested_at DESC, mr.id
      LIMIT ${NEVER_WATCHED_SCAN_LIMIT}
    `),
  ]);

  const rows = pageResult.rows as unknown as UserRequestSqlRow[];
  const completed = (
    completedResult.rows as unknown as {
      id: string;
      media_id: string | null;
      media_type: MediaRequestMediaType;
      lens_user_id: string | null;
    }[]
  ).map((row) => ({
    id: row.id,
    mediaId: row.media_id,
    mediaType: row.media_type,
    lensUserId: row.lens_user_id,
  }));

  const pageLensRows = rows.map(toLensRow);
  const completedIds = new Set(completed.map((row) => row.id));
  const states = await watchedStatesFor(
    [...completed, ...pageLensRows.filter((row) => !completedIds.has(row.id))],
    serverIds
  );

  const summaryRow = (summaryResult.rows as unknown as UserSummarySqlRow[])[0];
  const decided = summaryRow?.decided ?? 0;
  const medianWaitMs = summaryRow?.median_wait_ms;
  const summary = {
    total: summaryRow?.total ?? 0,
    approvalRate: decided > 0 ? (summaryRow?.approved_or_completed ?? 0) / decided : null,
    completed: summaryRow?.completed ?? 0,
    neverWatched: completed.filter((row) => states.get(row.id) === 'unwatched').length,
    medianWaitMs: medianWaitMs == null ? null : Number(medianWaitMs),
  };

  const data: UserRequestEntry[] = rows.map((row) => ({
    ...baseEntry(row, states.get(row.id) ?? 'unwatched'),
    media: {
      mediaId: row.media_id,
      title: row.title,
      year: row.year,
      mediaType: row.media_type,
    },
  }));

  return { data, total: summary.total, page, pageSize, summary };
}
