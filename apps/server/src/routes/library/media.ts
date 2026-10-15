/**
 * Media detail endpoint
 *
 * GET /media/:id, /children, /stats, /watchers, /history, /platforms - the
 * canonical-media detail surface for the Media detail page, scoped to the
 * caller's accessible servers. :id is a media uuid only; provider refs
 * (movie:tmdb:584, used by the public API) are rejected with 400 here.
 * Query bodies live in services/library/mediaDetailService.ts, shared with
 * public API v2's /media routes.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  uuidSchema,
  serverIdsQuerySchema,
  REDIS_KEYS,
  CACHE_TTL,
  POSTER_IMAGE_SIZE,
  type MediaAvailabilityEntry,
  type MediaDetailResponse,
  type MediaChildEntry,
  type MediaChildrenResponse,
  type MediaStatsResponse,
  type MediaStatsWindow,
  type MediaWatchersResponse,
  type MediaWatcherEntry,
  type MediaPlatformBreakdownEntry,
  type MediaPlatformBreakdownResponse,
  type MediaSeasonHeatResponse,
  type SeasonHeatSeason,
} from '@tracearr/shared';
import { resolveServerIds } from '../../utils/serverFiltering.js';
import {
  assertInScope,
  libraryCacheSegment,
  memberCacheSegment,
  seesServerActivity,
  type Scope,
} from '../../lib/scope.js';
import { decodeCursor } from '../../utils/cursor.js';
import { cursorPage, cursorPaginationSchema } from '../publicV2/shared.js';
import { resolveMediaAliases } from '../../services/library/mediaResolutionService.js';
import { buildProxyUrl, posterVersionFor } from '../../services/imageProxy.js';
import { listMediaRequests } from '../../services/requests/reads.js';
import { getSetting } from '../../services/settings.js';
import {
  buildMediaScope,
  getAvailability,
  getChildren,
  getMediaHistoryPage,
  getMediaPlatformBreakdown,
  getMediaStats,
  getMediaWatchers,
  getPosterCopy,
  getSeasonHeat,
  hiddenByLibraryLimit,
  resolveCanonicalMediaByRef,
  type AvailabilityRow,
  type MediaChildRow,
  type MediaPlatformBreakdownRow,
  type MediaStatsWindowResult,
  type MediaWatcherRow,
  type SeasonHeatSeasonRow,
} from '../../services/library/mediaDetailService.js';

const mediaIdParamSchema = z.object({ id: uuidSchema });

// Shared serverIds-only query schema for the media detail routes that take
// no other query params (detail, children, stats, platforms).
const mediaScopeQuerySchema = z.object({ serverIds: serverIdsQuerySchema });

// The routes that also accept an explicit serverId to narrow within that scope.
const mediaServerQuerySchema = z.object({
  serverId: uuidSchema.optional(),
  serverIds: serverIdsQuerySchema,
});

function mediaCacheKey(id: string, segment: string, serverIds: string[] | undefined): string {
  const scope = serverIds !== undefined ? [...serverIds].sort().join(',') : 'all';
  return REDIS_KEYS.LIBRARY_MEDIA_DETAIL(`${id}:${segment}:${scope}`);
}

async function readCache<T>(
  redis: { get(key: string): Promise<string | null> },
  key: string
): Promise<T | null> {
  const cached = await redis.get(key);
  if (!cached) return null;
  try {
    return JSON.parse(cached) as T;
  } catch {
    return null;
  }
}

function toAvailabilityEntry(r: AvailabilityRow): MediaAvailabilityEntry {
  return {
    serverId: r.server_id,
    serverType: r.server_type,
    libraryId: r.library_id,
    libraryName: r.library_name,
    ratingKey: r.rating_key,
    addedAt: new Date(r.added_at).toISOString(),
    removedAt: r.removed_at ? new Date(r.removed_at).toISOString() : null,
    videoResolution: r.video_resolution,
    fileSize: r.file_size === null ? null : Number(r.file_size),
    episodeFileSize: r.episode_file_size == null ? null : Number(r.episode_file_size),
    episodeResolutions: r.episode_resolutions ?? null,
    episodeCount: r.episode_count ?? null,
    versions: (r.versions ?? []).map((v) => ({
      ...v,
      fileSize: v.fileSize === null ? null : Number(v.fileSize),
    })),
    replaces:
      r.replaces_added_at && r.replaces_removed_at
        ? {
            addedAt: new Date(r.replaces_added_at).toISOString(),
            removedAt: new Date(r.replaces_removed_at).toISOString(),
            videoResolution: r.replaces_video_resolution,
            fileSize: r.replaces_file_size == null ? null : Number(r.replaces_file_size),
          }
        : null,
  };
}

function toChildEntry(r: MediaChildRow): MediaChildEntry {
  return {
    id: r.id,
    mediaType: r.media_type,
    title: r.title,
    seasonNumber: r.season_number,
    episodeCount: r.episode_count,
    episodeNumber: r.episode_number,
    imdbId: r.imdb_id,
    tmdbId: r.tmdb_id,
    tvdbId: r.tvdb_id,
    showMediaId: r.show_media_id,
    genres: r.genres,
  };
}

function toStatsWindow(w: MediaStatsWindowResult): MediaStatsWindow {
  return {
    combined: {
      plays: w.combined.plays,
      watchTimeMs: w.combined.watch_time_ms,
      uniqueUsers: w.combined.unique_users,
    },
    perServer: w.per_server.map((s) => ({
      serverId: s.server_id,
      serverName: s.server_name,
      plays: s.plays,
      watchTimeMs: s.watch_time_ms,
      uniqueUsers: s.unique_users,
    })),
  };
}

function toWatcherEntry(r: MediaWatcherRow): MediaWatcherEntry {
  return {
    user: {
      serverUserId: r.user.server_user_id,
      userId: r.user.user_id,
      serverId: r.user.server_id,
      username: r.user.username,
      identityName: r.user.identity_name,
      thumb: r.user.thumb,
    },
    plays: r.plays,
    watchTimeMs: r.watch_time_ms,
    completionPct: r.completion_pct,
    lastWatchedDay: r.last_watched_day,
    distinctEpisodesWatched: r.distinct_episodes_watched,
  };
}

// The cache holds every watcher; a member gets their own rows, plus a count of the other people
// when the owner shows members server activity.
async function ownWatchers(
  response: MediaWatchersResponse,
  scope: Scope
): Promise<MediaWatchersResponse> {
  if (scope === 'all') return response;
  const watchers = response.watchers.filter((w) => assertInScope(scope, w.user.serverUserId));
  if (!(await seesServerActivity(scope))) return { ...response, watchers };
  const others = new Set(
    response.watchers.filter((w) => w.user.userId !== scope.userId).map((w) => w.user.userId)
  );
  return { ...response, watchers, othersCount: others.size };
}

function toPlatformEntry(r: MediaPlatformBreakdownRow): MediaPlatformBreakdownEntry {
  return { platform: r.platform, player: r.player, plays: r.plays, watchTimeMs: r.watch_time_ms };
}

function toSeasonHeatSeason(r: SeasonHeatSeasonRow): SeasonHeatSeason {
  const episodeCount = r.episodes.length;
  const watchedCount = r.episodes.filter((e) => e.watched_state === 'watched').length;
  return {
    seasonNumber: r.season_number,
    title: r.title,
    year: r.year,
    episodeCount,
    watchedCount,
    watchedPct: episodeCount > 0 ? (watchedCount / episodeCount) * 100 : 0,
    episodes: r.episodes.map((e) => ({
      episodeNumber: e.episode_number,
      watchedState: e.watched_state,
    })),
  };
}

export const libraryMediaRoute: FastifyPluginAsync = async (app) => {
  const readMedia = { preHandler: [app.requirePermission('media', 'read')] };
  /**
   * GET /media/:id - Canonical media identity with per-server availability,
   * scoped to accessible servers. Cached per (id, sorted serverIds).
   */
  app.get('/media/:id', readMedia, async (request, reply) => {
    const params = mediaIdParamSchema.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid media id');
    const { id } = params.data;
    const query = mediaScopeQuerySchema.safeParse(request.query);
    if (!query.success) return reply.badRequest('Invalid query parameters');
    const authUser = request.user;

    const resolvedIds = resolveServerIds(authUser, undefined, query.data.serverIds);
    const canonical = await resolveCanonicalMediaByRef(id);
    if (!canonical) return reply.notFound();
    if (await hiddenByLibraryLimit(canonical.id, resolvedIds, request.scope)) {
      return reply.notFound();
    }

    // detail-v4: response gained the poster fields
    const cacheKey = mediaCacheKey(
      canonical.id,
      `detail-v4${libraryCacheSegment(request.scope)}`,
      resolvedIds
    );
    const cached = await readCache<MediaDetailResponse>(app.redis, cacheKey);
    if (cached) return cached;

    const aliases = await resolveMediaAliases(canonical.id);
    const mergedIds = aliases.filter((aliasId) => aliasId !== canonical.id);
    const { availability, seasonCount, episodeCount } = await getAvailability(
      canonical.id,
      canonical.mediaType,
      resolvedIds,
      request.scope
    );
    const poster = await getPosterCopy(
      canonical.id,
      resolvedIds,
      await getSetting('preferredPosterServerId'),
      request.scope
    );
    const posterVersion = poster ? posterVersionFor(poster.thumbPath) : null;

    const response: MediaDetailResponse = {
      id: canonical.id,
      mediaType: canonical.mediaType,
      title: canonical.title,
      year: canonical.year,
      imdbId: canonical.imdbId,
      tmdbId: canonical.tmdbId,
      tvdbId: canonical.tvdbId,
      genres: canonical.genres,
      showMediaId: canonical.showMediaId,
      mergedIds,
      availability: availability.map(toAvailabilityEntry),
      seasonCount,
      episodeCount,
      posterUrl:
        poster && posterVersion
          ? buildProxyUrl({
              serverId: poster.serverId,
              path: poster.thumbPath,
              ...POSTER_IMAGE_SIZE,
              version: posterVersion,
              fallback: 'poster',
            })
          : null,
      posterVersion,
      dominantColor: poster?.dominantColor ?? null,
    };
    await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_MEDIA_DETAIL, JSON.stringify(response));
    return response;
  });

  /**
   * GET /media/:id/children - Seasons of a show, or episodes of a season.
   * Movie and episode ids have no children and return 404.
   */
  app.get('/media/:id/children', readMedia, async (request, reply) => {
    const params = mediaIdParamSchema.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid media id');
    const { id } = params.data;
    const query = mediaScopeQuerySchema.safeParse(request.query);
    if (!query.success) return reply.badRequest('Invalid query parameters');
    const authUser = request.user;

    const resolvedIds = resolveServerIds(authUser, undefined, query.data.serverIds);
    const canonical = await resolveCanonicalMediaByRef(id);
    if (!canonical) return reply.notFound();
    if (await hiddenByLibraryLimit(canonical.id, resolvedIds, request.scope)) {
      return reply.notFound();
    }

    const cacheKey = mediaCacheKey(
      canonical.id,
      `children${libraryCacheSegment(request.scope)}`,
      resolvedIds
    );
    const cached = await readCache<MediaChildrenResponse>(app.redis, cacheKey);
    if (cached) return cached;

    const rows = await getChildren(canonical, resolvedIds, request.scope);
    if (rows === null) return reply.notFound();

    const response: MediaChildrenResponse = { data: rows.map(toChildEntry) };
    await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_MEDIA_DETAIL, JSON.stringify(response));
    return response;
  });

  /**
   * GET /media/:id/season-heat - Per-episode watched state grouped by season,
   * for the show detail page's watch-heat strip. Movie and episode ids have
   * no seasons and 404. Whole-audience (no lens query param): the detail
   * page's own stats aggregate across every identity, not one viewer.
   */
  app.get('/media/:id/season-heat', readMedia, async (request, reply) => {
    const params = mediaIdParamSchema.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid media id');
    const { id } = params.data;
    const query = mediaScopeQuerySchema.safeParse(request.query);
    if (!query.success) return reply.badRequest('Invalid query parameters');
    const authUser = request.user;

    const resolvedIds = resolveServerIds(authUser, undefined, query.data.serverIds);
    const canonical = await resolveCanonicalMediaByRef(id);
    if (!canonical) return reply.notFound();
    if (await hiddenByLibraryLimit(canonical.id, resolvedIds, request.scope)) {
      return reply.notFound();
    }

    // A member's heat is what they watched, not what anyone did.
    const lensUserId = request.scope === 'all' ? null : request.scope.userId;
    const cacheKey = mediaCacheKey(
      canonical.id,
      `season-heat${memberCacheSegment(request.scope)}`,
      resolvedIds
    );
    const cached = await readCache<MediaSeasonHeatResponse>(app.redis, cacheKey);
    if (cached) return cached;

    const rows = await getSeasonHeat(canonical, resolvedIds, lensUserId, request.scope);
    if (rows === null) return reply.notFound();

    const response: MediaSeasonHeatResponse = {
      mediaId: canonical.id,
      seasons: rows.map(toSeasonHeatSeason),
    };
    await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_MEDIA_DETAIL, JSON.stringify(response));
    return response;
  });

  /**
   * GET /media/:id/stats - Play counts, watch time, and distinct viewers
   * across all_time/last_30/last_7 windows, scoped to accessible servers.
   */
  app.get('/media/:id/stats', readMedia, async (request, reply) => {
    const params = mediaIdParamSchema.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid media id');
    const { id } = params.data;
    const query = mediaScopeQuerySchema.safeParse(request.query);
    if (!query.success) return reply.badRequest('Invalid query parameters');
    const authUser = request.user;

    const resolvedIds = resolveServerIds(authUser, undefined, query.data.serverIds);
    const canonical = await resolveCanonicalMediaByRef(id);
    if (!canonical) return reply.notFound();
    const scope = await buildMediaScope(canonical);
    if (!scope) return reply.notFound();

    // Totals across everyone only when the caller may see server activity; otherwise own plays.
    const rowScope = (await seesServerActivity(request.scope)) ? 'all' : request.scope;
    const cacheKey = mediaCacheKey(
      canonical.id,
      `stats${memberCacheSegment(rowScope)}`,
      resolvedIds
    );
    const cached = await readCache<MediaStatsResponse>(app.redis, cacheKey);
    if (cached) return cached;

    const windows = await getMediaStats(scope, resolvedIds, rowScope);
    const response: MediaStatsResponse = {
      mediaId: canonical.id,
      mediaType: canonical.mediaType,
      windows: {
        all_time: toStatsWindow(windows.all_time),
        last_30: toStatsWindow(windows.last_30),
        last_7: toStatsWindow(windows.last_7),
      },
    };
    await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_MEDIA_DETAIL, JSON.stringify(response));
    return response;
  });

  /**
   * GET /media/:id/watchers - Per server-user rollup, scoped to accessible
   * servers. An explicit serverId query narrows further within that scope
   * (fail-closed 403 if the caller cannot reach it).
   */
  app.get('/media/:id/watchers', readMedia, async (request, reply) => {
    const params = mediaIdParamSchema.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid media id');
    const { id } = params.data;

    const querySchema = mediaServerQuerySchema.extend({
      window: z.enum(['all_time', 'last_30', 'last_7']).default('all_time'),
    });
    const query = querySchema.safeParse(request.query);
    if (!query.success) return reply.badRequest('Invalid query parameters');
    const { window: windowKey, serverId, serverIds } = query.data;
    const authUser = request.user;

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    const canonical = await resolveCanonicalMediaByRef(id);
    if (!canonical) return reply.notFound();
    const scope = await buildMediaScope(canonical);
    if (!scope) return reply.notFound();

    // watchers-v2: rows gained user thumb/serverId for avatars
    const cacheKey = mediaCacheKey(canonical.id, `watchers-v2:${windowKey}`, resolvedIds);
    const cached = await readCache<MediaWatchersResponse>(app.redis, cacheKey);
    if (cached) return ownWatchers(cached, request.scope);

    const watchers = await getMediaWatchers({ scope, windowKey, serverIds: resolvedIds });
    const response: MediaWatchersResponse = {
      mediaId: canonical.id,
      mediaType: canonical.mediaType,
      window: windowKey,
      watchers: watchers.map(toWatcherEntry),
    };
    await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_MEDIA_DETAIL, JSON.stringify(response));
    return ownWatchers(response, request.scope);
  });

  /**
   * GET /media/:id/requests - Seerr requests for this title, scoped to
   * accessible servers. Never cached: the socket event that tells the client
   * to refetch would otherwise land on a stale copy for the rest of the TTL.
   */
  app.get('/media/:id/requests', readMedia, async (request, reply) => {
    const params = mediaIdParamSchema.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid media id');

    const query = mediaServerQuerySchema.safeParse(request.query);
    if (!query.success) return reply.badRequest('Invalid query parameters');

    const resolvedIds = resolveServerIds(request.user, query.data.serverId, query.data.serverIds);
    const canonical = await resolveCanonicalMediaByRef(params.data.id);
    if (!canonical) return reply.notFound();
    if (canonical.mediaType === 'episode') return { data: [] };
    const scope = await buildMediaScope(canonical);
    if (!scope) return reply.notFound();

    return {
      data: await listMediaRequests({ scope, serverIds: resolvedIds, rowScope: request.scope }),
    };
  });

  /**
   * GET /media/:id/history - Watch history for a media item as plays,
   * scoped to accessible servers. Computed live (paginated, never cached).
   */
  app.get('/media/:id/history', readMedia, async (request, reply) => {
    const params = mediaIdParamSchema.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid media id');
    const { id } = params.data;

    const query = cursorPaginationSchema.safeParse(request.query);
    if (!query.success) return reply.badRequest('Invalid query parameters');
    const { cursor, pageSize } = query.data;
    const scopeQuery = mediaScopeQuerySchema.safeParse(request.query);
    if (!scopeQuery.success) return reply.badRequest('Invalid query parameters');

    let cursorValue: { startedAt: Date; id: string } | null = null;
    if (cursor) {
      cursorValue = decodeCursor(cursor);
      if (!cursorValue || !uuidSchema.safeParse(cursorValue.id).success) {
        return reply.badRequest('Invalid cursor');
      }
    }

    const authUser = request.user;
    const resolvedIds = resolveServerIds(authUser, undefined, scopeQuery.data.serverIds);
    const canonical = await resolveCanonicalMediaByRef(id);
    if (!canonical) return reply.notFound();
    const scope = await buildMediaScope(canonical);
    if (!scope) return reply.notFound();

    const { data, nextCursor } = await getMediaHistoryPage({
      scope,
      pageSize,
      cursorValue,
      serverIds: resolvedIds,
      rowScope: request.scope,
    });
    return cursorPage(data, nextCursor, pageSize);
  });

  /**
   * GET /media/:id/platforms - All-time plays/watch time by platform and
   * player, scoped to accessible servers. Season ids fall back to their
   * parent show's breakdown (not filtered to the single season).
   */
  app.get('/media/:id/platforms', readMedia, async (request, reply) => {
    const params = mediaIdParamSchema.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid media id');
    const { id } = params.data;
    const query = mediaScopeQuerySchema.safeParse(request.query);
    if (!query.success) return reply.badRequest('Invalid query parameters');
    const authUser = request.user;

    const resolvedIds = resolveServerIds(authUser, undefined, query.data.serverIds);
    const canonical = await resolveCanonicalMediaByRef(id);
    if (!canonical) return reply.notFound();
    const scope = await buildMediaScope(canonical);
    if (!scope) return reply.notFound();

    // Player names are often a person's own ("Sarah's iPad"), so a member sees only theirs.
    const cacheKey = mediaCacheKey(
      canonical.id,
      `platforms${memberCacheSegment(request.scope)}`,
      resolvedIds
    );
    const cached = await readCache<MediaPlatformBreakdownResponse>(app.redis, cacheKey);
    if (cached) return cached;

    const aliasIds = scope.kind === 'season' ? scope.showAliases : scope.aliases;
    const rows = await getMediaPlatformBreakdown(
      canonical.id,
      aliasIds,
      resolvedIds,
      request.scope
    );
    const response: MediaPlatformBreakdownResponse = { data: rows.map(toPlatformEntry) };
    await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_MEDIA_DETAIL, JSON.stringify(response));
    return response;
  });
};
