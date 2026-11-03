/**
 * Library Route Utilities
 *
 * Shared helpers for library statistics routes including server filtering
 * and cache key generation.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { REDIS_KEYS } from '@tracearr/shared';
import { scopeFragment, type Scope } from '../../lib/scope.js';
import { buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { lastDaysWindow, rollupDayWindowSql } from '../../db/sessions/rules.js';

// A library_items row `li` whose thumb_path names a real image. Jellyfin/Emby paths carry
// ?tag= only when the item had a Primary image at sync time; an untagged one 404s. The same
// test as HAS_KNOWN_IMAGE in jobs/imagePrecacheQueue.ts, and false rather than NULL for a
// NULL path so it sorts as a boolean.
export const LI_HAS_KNOWN_IMAGE = sql`(li.thumb_path IS NOT NULL
  AND (li.thumb_path NOT LIKE '/Items/%' OR li.thumb_path LIKE '%?tag=%'))`;

// The active artist row a track rolls up to; t is the track, matched on the outer row.
export const ARTIST_OF_TRACK = sql`
  FROM library_items t
  JOIN library_items ar ON ar.server_id = t.server_id AND ar.rating_key = t.grandparent_rating_key
    AND ar.media_type = 'artist' AND ar.removed_at IS NULL`;

/**
 * Bytes for one canonical title. Identical file_size across copies of the same
 * underlying media means one physical file mirrored across servers, so it counts
 * once; a different size is a distinct rendition. For a show this rolls up every
 * episode (media linked by show_media_id), deduping each episode's mirrors, so
 * show size reflects its episodes rather than the empty container row. For a
 * movie only its own copies match, so this equals the plain mirror-dedupe.
 * serverFragment stays inside so dedupe + rollup respect the requested servers.
 *
 * The self-branch (im.id = mediaIdExpr) excludes show rows on purpose: a show's
 * own library_items row today always has a NULL file_size, so this is a no-op
 * in practice, but nothing stops a future import from writing a size onto that
 * container row. Without the guard that would be summed on top of the episode
 * rollup and double-count the show. Movies are unaffected since a movie row's
 * media_type is never 'show'.
 */
export function mediaSizeSubquery(mediaIdExpr: SQL, serverFragment: SQL): SQL {
  // Version grain: the rendition dedupe compares per-file sizes, so a
  // multi-version title's copies dedupe file-by-file across servers and
  // libraries (#478) instead of comparing whole-title sums.
  return sql`(SELECT COALESCE(SUM(sz), 0) FROM (
    SELECT DISTINCT li2.media_id, v.file_size AS sz
    FROM library_items li2
    JOIN library_item_versions v
      ON v.library_item_id = li2.id AND v.removed_at IS NULL AND v.file_size IS NOT NULL
    JOIN media im ON im.id = li2.media_id
    WHERE (
        (im.id = ${mediaIdExpr} AND im.media_type <> 'show')
        OR im.show_media_id = ${mediaIdExpr}
      )
      AND li2.removed_at IS NULL ${serverFragment}
  ) d)`;
}

/**
 * True when a canonical title has no counted play on the servers, alias-aware (a merged
 * loser's plays count for the canonical row) and, for shows, episode-aware.
 * user_media_plays_daily admits every session with a media_id, so the test is `counted`
 * rather than row existence. A member's scope narrows the plays to their own accounts.
 */
export function neverPlayedSql(
  type: 'movie' | 'show',
  mediaIdExpr: SQL,
  serverIds: string[] | undefined,
  scope: Scope = 'all'
): SQL {
  const mediaCol = sql.raw(type === 'movie' ? 'media_id' : 'show_media_id');
  return sql`NOT EXISTS (
    SELECT 1 FROM user_media_plays_daily p
    WHERE p.${mediaCol} = ${mediaIdExpr} AND p.counted
      ${buildMultiServerFragment(serverIds, 'p.server_id')}${scopeFragment(scope, sql`p.server_user_id`)}
    UNION ALL
    SELECT 1 FROM media loser
    JOIN user_media_plays_daily p2 ON p2.${mediaCol} = loser.id
    WHERE loser.merged_into_id = ${mediaIdExpr} AND p2.counted
      ${buildMultiServerFragment(serverIds, 'p2.server_id')}${scopeFragment(scope, sql`p2.server_user_id`)}
  )`;
}

/**
 * Mirror-deduped total bytes for a scope: the same physical file indexed by
 * several libraries or servers counts once (#478). Identity is the canonical
 * media id (item id fallback) + per-version file size; two distinct files
 * that share both title and exact byte size still collapse, the same accepted
 * heuristic mediaSizeSubquery has always used.
 * Filters must reference library_items as li.
 */
export function dedupedStorageBytesSql(serverFilter: SQL, libraryFilter: SQL): SQL {
  return sql`(
    SELECT COALESCE(SUM(d.sz), 0) FROM (
      SELECT DISTINCT COALESCE(li.media_id::text, li.id::text) AS ident, v.file_size AS sz
      FROM library_items li
      JOIN library_item_versions v
        ON v.library_item_id = li.id AND v.removed_at IS NULL AND v.file_size IS NOT NULL
      WHERE li.removed_at IS NULL
        ${serverFilter}
        ${libraryFilter}
    ) d
  )`;
}

const LIBRARY_PERIOD_DAYS = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 } as const;

export type LibraryPeriod = keyof typeof LIBRARY_PERIOD_DAYS | 'all';

/**
 * The window a library period endpoint reads: [startDate, endDate) when both are given (the
 * period token is then ignored), else the token's length ending now, with a null start for all
 * time. `lastDay` is the bound for queries that compare whole days inclusively: a custom end
 * minus a millisecond, so a day-aligned end does not pull in a day past the selection, and now
 * for presets so today is included. `cacheSegment` names the window in a cache key.
 */
export function resolveLibraryWindow(
  query: { period: LibraryPeriod; startDate?: string; endDate?: string },
  now = new Date()
): { startDate: Date | null; endDate: Date; lastDay: Date; cacheSegment: string } {
  if (query.startDate && query.endDate) {
    const endDate = new Date(query.endDate);
    return {
      startDate: new Date(query.startDate),
      endDate,
      lastDay: new Date(endDate.getTime() - 1),
      cacheSegment: `custom:${query.startDate}:${query.endDate}`,
    };
  }
  const days = query.period === 'all' ? null : LIBRARY_PERIOD_DAYS[query.period];
  return { ...lastDaysWindow(days, now), lastDay: now, cacheSegment: query.period };
}

// Movie and episode plays keyed by the top-level title they count for: the show for an
// episode, the movie itself otherwise, a merged alias folded one hop into its winner.
function rollupIdentPlaysSql(filters: SQL): SQL {
  return sql`
    SELECT p.chain_id, p.counted, p.watched_ms, p.day,
      (CASE WHEN p.show_media_id IS NOT NULL THEN COALESCE(sh.merged_into_id, p.show_media_id)
            ELSE COALESCE(pm.merged_into_id, p.media_id) END)::text AS ident
    FROM user_media_plays_daily p
    LEFT JOIN media pm ON pm.id = p.media_id
    LEFT JOIN media sh ON sh.id = p.show_media_id
    WHERE p.media_type IN ('movie', 'episode') ${filters}`;
}

/** Plays and watch time per title ident within the window. Filters reference the aggregate as p. */
export function rollupIdentWatchCte(
  window: { startDate: Date | null; endDate: Date },
  serverFilterOnP: SQL
): SQL {
  return sql`
    SELECT ident,
      COUNT(DISTINCT chain_id) FILTER (WHERE counted) AS watch_count,
      SUM(watched_ms) AS total_watch_ms,
      MAX(day) AS last_day
    FROM (${rollupIdentPlaysSql(sql`${rollupDayWindowSql(window, sql`p.day`)} ${serverFilterOnP}`)}) x
    GROUP BY ident`;
}

/** The last UTC day each title ident was played, over all time. */
export function identLastWatchedCte(serverFilterOnP: SQL): SQL {
  return sql`
    SELECT ident, MAX(day) AS last_day
    FROM (${rollupIdentPlaysSql(serverFilterOnP)}) x
    GROUP BY ident`;
}

/**
 * Bytes per title ident at episode grain: DISTINCT (title, file, size) keeps two episodes of
 * equal size apart and counts a file mirrored across servers or libraries once. An episode
 * with no media link still belongs to the show item its grandparent rating key names, so
 * the show's size stays whole while matching is incomplete. Filters reference library_items
 * as li, the same fragments a top-level item query uses.
 */
export function identSizesCte(serverFilterOnLi: SQL, libraryFilter: SQL): SQL {
  return sql`
    SELECT ident, SUM(sz) AS file_size FROM (
      SELECT DISTINCT
        COALESCE(sh.merged_into_id, m.show_media_id, gpm.merged_into_id, gp.media_id, gp.id,
                 m.merged_into_id, li.media_id, li.id)::text AS ident,
        COALESCE(m.merged_into_id, li.media_id, li.id)::text AS file_ident,
        v.file_size AS sz
      FROM library_items li
      JOIN library_item_versions v
        ON v.library_item_id = li.id AND v.removed_at IS NULL AND v.file_size IS NOT NULL
      LEFT JOIN media m ON m.id = li.media_id
      LEFT JOIN media sh ON sh.id = m.show_media_id
      LEFT JOIN library_items gp ON li.media_id IS NULL AND li.media_type = 'episode'
        AND gp.server_id = li.server_id AND gp.rating_key = li.grandparent_rating_key
        AND gp.media_type = 'show' AND gp.removed_at IS NULL
      LEFT JOIN media gpm ON gpm.id = gp.media_id
      WHERE li.removed_at IS NULL AND li.media_type IN ('movie', 'episode')
        ${serverFilterOnLi}
        ${libraryFilter}
    ) d
    GROUP BY ident`;
}

/**
 * Generate cache key with all varying parameters to prevent cache collisions.
 *
 * @param prefix - Cache key prefix (e.g., REDIS_KEYS.LIBRARY_STATS)
 * @param serverId - Optional server filter
 * @param period - Optional period filter (for growth endpoint)
 * @param timezone - Optional timezone
 * @param variant - Optional extra segment for any other cacheable input
 *   (e.g. a display preference like preferred poster server)
 * @returns Cache key string
 */
export function buildLibraryCacheKey(
  prefix: string,
  serverId?: string,
  period?: string,
  timezone?: string,
  variant?: string
): string {
  const parts = [prefix];
  if (serverId) parts.push(serverId);
  if (period) parts.push(period);
  if (timezone) parts.push(timezone);
  if (variant) parts.push(variant);
  return parts.join(':');
}

const SINGLE_FLIGHT_LOCK_TTL_SECONDS = 60;
const SINGLE_FLIGHT_POLL_MS = 500;
const SINGLE_FLIGHT_WAIT_MS = 15_000;

/**
 * Single-flight guard around a cold cache-miss compute: the first caller past
 * the cache TTL takes a short SET-NX lock and runs `compute` (which must fill
 * `cacheKey` itself); every other concurrent caller for the same key polls the
 * cache instead of re-running the same expensive query set. Originated as
 * shelves.ts's computeShelvesSingleFlight; also drives catalog.ts's
 * getWatchedCandidates single-flight.
 *
 * Fail-open by design: a Redis error acquiring or polling the lock, or a 15s
 * wait with no cached result yet, falls through to computing directly - a
 * duplicate compute is cheaper than a failed request.
 */
export async function withComputeSingleFlight<T>(
  redis: Redis,
  cacheKey: string,
  compute: () => Promise<T>,
  parseCached: (raw: string) => T
): Promise<T> {
  let acquiredLock: boolean;
  try {
    const lockKey = REDIS_KEYS.LIBRARY_SINGLE_FLIGHT_LOCK(cacheKey);
    acquiredLock =
      (await redis.set(lockKey, '1', 'EX', SINGLE_FLIGHT_LOCK_TTL_SECONDS, 'NX')) === 'OK';
  } catch {
    acquiredLock = true;
  }

  if (acquiredLock) {
    return compute();
  }

  const deadline = Date.now() + SINGLE_FLIGHT_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SINGLE_FLIGHT_POLL_MS));
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return parseCached(cached);
      }
    } catch {
      break; // Redis unavailable - fall through to compute.
    }
  }

  return compute();
}
