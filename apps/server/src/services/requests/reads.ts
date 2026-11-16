/**
 * Read queries behind the two request surfaces: a media item's requesters and
 * one identity's request history. Neither talks to Seerr.
 */

import { sql } from 'drizzle-orm';
import type {
  MediaRequestEntry,
  MediaRequestMediaType,
  MediaRequestStatus,
  RequestSeason,
  RequestServiceType,
  UserRequestEntry,
  UserRequestsResponse,
  WatchedState,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { scopedServerFragment, seesServerActivity, type Scope } from '../../lib/scope.js';
import { uuidArraySql } from '../../utils/sqlArrays.js';
import { personPictureJoinSql } from '../../utils/representativeAccount.js';
import { buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { buildPosterOrderFragment } from '../../routes/library/catalog.js';
import { buildPosterUrl } from '../imageProxy.js';
import { getSetting } from '../settings.js';
import {
  UNWATCHED_LENSES,
  watchedStatesFor,
  type RequestWatchedLenses,
  type WatchedLensRow,
} from './watchedLenses.js';
import type { MediaScope } from '../library/mediaDetailService.js';
import type { SQL } from 'drizzle-orm';

/** Bounds the never-watched scan so a heavy requester cannot turn a page into a full-history probe. */
const NEVER_WATCHED_SCAN_LIMIT = 500;

const started = (state: WatchedState | undefined): boolean =>
  state === 'watched' || state === 'partial';

const EMPTY_SUMMARY: UserRequestsResponse['summary'] = {
  total: 0,
  approvalRate: null,
  completed: 0,
  neverWatched: 0,
  medianWaitMs: null,
  availableThisWeek: 0,
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
  service_type: RequestServiceType;
  remote_username: string;
  server_user_id: string | null;
  user_server_id: string | null;
  username: string | null;
  identity_name: string | null;
  thumb: string | null;
  thumb_server_id: string | null;
}

interface UserRequestSqlRow extends RequestBaseRow {
  service_id: string;
  title: string | null;
  year: number | null;
  poster_path: string | null;
  poster_server_id: string | null;
  poster_thumb_path: string | null;
}

interface UserSummarySqlRow {
  total: number;
  completed: number;
  approved_or_completed: number;
  decided: number;
  median_wait_ms: number | null;
  available_this_week: number;
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
    seasons: row.seasons,
  };
}

// Without server activity a member sees whether they watched what they asked for, never
// whether someone else did.
function baseEntry(row: RequestBaseRow, lenses: RequestWatchedLenses, showOthers: boolean) {
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
    watchedState: showOthers ? lenses.anyone : lenses.requester,
    watchedStateRequester: lenses.requester,
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
  rowScope: Scope;
}

export async function listMediaRequests(args: ListMediaRequestsArgs): Promise<MediaRequestEntry[]> {
  const { scope, serverIds, rowScope } = args;
  const showOthers = await seesServerActivity(rowScope);
  const authFragment = scopedServerFragment(
    serverIds,
    rowScope,
    'rs.server_id',
    sql`mr.server_user_id`
  );
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
      rs.type AS service_type,
      mr.remote_username,
      mr.server_user_id,
      su.user_id AS lens_user_id,
      su.server_id AS user_server_id,
      su.username,
      COALESCE(u.name, u.username) AS identity_name,
      u.thumbnail AS thumb,
      pic.server_id AS thumb_server_id
    FROM media_requests mr
    JOIN request_services rs ON rs.id = mr.service_id
    LEFT JOIN server_users su ON su.id = mr.server_user_id
    LEFT JOIN users u ON u.id = su.user_id
    ${personPictureJoinSql()}
    WHERE ${scopeFilter(scope)} ${authFragment}
    ORDER BY mr.requested_at, mr.id
  `);

  const rows = result.rows as unknown as MediaRequestSqlRow[];
  const states = await watchedStatesFor(rows.map(toLensRow), serverIds);

  return rows.map((row) => ({
    ...baseEntry(row, states.get(row.id) ?? UNWATCHED_LENSES, showOthers),
    serviceType: row.service_type,
    requester: row.server_user_id
      ? {
          serverUserId: row.server_user_id,
          userId: row.lens_user_id,
          serverId: row.user_server_id ?? row.server_id,
          username: row.username,
          identityName: row.identity_name,
          thumb: row.thumb,
          thumbServerId: row.thumb_server_id,
        }
      : {
          serverUserId: null,
          userId: null,
          serverId: row.server_id,
          username: row.remote_username,
          identityName: null,
          thumb: null,
          thumbServerId: null,
        },
  }));
}

export interface ListUserRequestsArgs {
  serverUserIds: string[];
  showOthers: boolean;
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
  const scoped = sql`mr.server_user_id = ANY(${ids})`;
  const preferredPosterServerId = await getSetting('preferredPosterServerId');

  const [pageResult, summaryResult, completedResult] = await Promise.all([
    db.execute(sql`
      SELECT
        mr.id,
        rs.server_id,
        mr.media_id,
        mr.media_type,
        mr.service_id,
        mr.title,
        mr.year,
        mr.poster_path,
        mr.status,
        mr.requested_at,
        mr.available_at,
        mr.deleted_at,
        mr.seasons,
        mr.is_4k,
        mr.is_auto_request,
        su.user_id AS lens_user_id,
        poster.server_id AS poster_server_id,
        poster.thumb_path AS poster_thumb_path
      FROM media_requests mr
      JOIN request_services rs ON rs.id = mr.service_id
      JOIN server_users su ON su.id = mr.server_user_id
      LEFT JOIN LATERAL (
        SELECT li.server_id, li.thumb_path
        FROM library_items li
        WHERE li.media_id = mr.media_id
          AND li.removed_at IS NULL
          AND li.thumb_path IS NOT NULL
          ${buildMultiServerFragment(serverIds, 'li.server_id')}
        ${buildPosterOrderFragment(preferredPosterServerId)}
        LIMIT 1
      ) poster ON true
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
        ) FILTER (WHERE mr.available_at IS NOT NULL) AS median_wait_ms,
        count(*) FILTER (
          WHERE mr.available_at >= now() - interval '7 days'
        )::int AS available_this_week
      FROM media_requests mr
      WHERE ${scoped}
    `),
    db.execute(sql`
      SELECT mr.id, mr.media_id, mr.media_type, mr.seasons, su.user_id AS lens_user_id
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
      seasons: RequestSeason[] | null;
    }[]
  ).map((row) => ({
    id: row.id,
    mediaId: row.media_id,
    mediaType: row.media_type,
    lensUserId: row.lens_user_id,
    seasons: row.seasons,
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
    neverWatched: completed.filter((row) => !started(states.get(row.id)?.requester)).length,
    medianWaitMs: medianWaitMs == null ? null : Number(medianWaitMs),
    availableThisWeek: summaryRow?.available_this_week ?? 0,
  };

  const data: UserRequestEntry[] = rows.map((row) => ({
    ...baseEntry(row, states.get(row.id) ?? UNWATCHED_LENSES, args.showOthers),
    media: {
      mediaId: row.media_id,
      title: row.title,
      year: row.year,
      mediaType: row.media_type,
      posterUrl:
        buildPosterUrl(row.poster_server_id, row.poster_thumb_path) ??
        buildPosterUrl(row.service_id, row.poster_path),
    },
  }));

  return { data, total: summary.total, page, pageSize, summary };
}
