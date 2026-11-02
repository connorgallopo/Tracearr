/**
 * Library Codecs Route
 *
 * GET /codecs - Codec distribution for library items
 *
 * Returns video and audio codec breakdowns grouped by media type:
 * - Movies/Episodes: Both video and audio codecs
 * - Music (tracks): Audio codecs only
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { REDIS_KEYS, CACHE_TTL, uuidSchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import {
  validateServerAccess,
  resolveServerIds,
  buildMultiServerFragment,
} from '../../utils/serverFiltering.js';
import {
  normalizeVideoCodec,
  normalizeAudioCodec,
  normalizeAudioChannels,
} from '../../utils/codecNormalizer.js';
import { buildLibraryCacheKey } from './utils.js';
import { serverCacheSegment } from '../../lib/scope.js';

/** Query schema for codecs endpoint */
const codecsQuerySchema = z.object({
  serverId: uuidSchema.optional(),
  libraryId: uuidSchema.optional(),
});

type CodecsQueryInput = z.infer<typeof codecsQuerySchema>;

/** Single codec entry with count and percentage */
interface CodecEntry {
  codec: string;
  count: number;
  percentage: number;
}

/** Response structure for codecs endpoint */
interface LibraryCodecsResponse {
  video: {
    codecs: CodecEntry[];
    total: number;
  };
  audio: {
    codecs: CodecEntry[];
    total: number;
  };
  channels: {
    codecs: CodecEntry[];
    total: number;
  };
  music: {
    codecs: CodecEntry[];
    total: number;
  };
}

/**
 * Aggregate and normalize codec counts, returning top entries plus "Other"
 */
function aggregateCodecs(
  rows: Array<{ codec: string | null; count: number; media_type?: string }>,
  normalizer: (codec: string | null) => string,
  topN: number = 7
): { codecs: CodecEntry[]; total: number } {
  // Group by normalized codec name; rows carrying media_type also split movies from episodes
  const codecMap = new Map<string, { count: number; movies: number; episodes: number }>();
  const byType = rows.some((row) => row.media_type !== undefined);
  let total = 0;

  for (const row of rows) {
    const normalized = normalizer(row.codec);
    const entry = codecMap.get(normalized) ?? { count: 0, movies: 0, episodes: 0 };
    entry.count += row.count;
    if (row.media_type === 'movie') entry.movies += row.count;
    if (row.media_type === 'episode') entry.episodes += row.count;
    codecMap.set(normalized, entry);
    total += row.count;
  }

  // Sort by count descending
  const sorted = Array.from(codecMap.entries())
    .map(([codec, entry]) => ({ codec, ...entry }))
    .sort((a, b) => b.count - a.count);

  // Take top N, aggregate rest as "Other"
  const topCodecs: Array<(typeof sorted)[number] & { includes?: string[] }> = sorted.slice(0, topN);
  const rest = sorted.slice(topN);
  if (rest.length > 0) {
    topCodecs.push({
      codec: 'Other',
      count: rest.reduce((sum, item) => sum + item.count, 0),
      movies: rest.reduce((sum, item) => sum + item.movies, 0),
      episodes: rest.reduce((sum, item) => sum + item.episodes, 0),
      includes: rest.map((item) => item.codec),
    });
  }

  // Calculate percentages
  const codecs: CodecEntry[] = topCodecs.map((item) => ({
    codec: item.codec,
    count: item.count,
    percentage: total > 0 ? Math.round((item.count / total) * 1000) / 10 : 0,
    ...(byType && { movies: item.movies, episodes: item.episodes }),
    ...(item.includes && { includes: item.includes }),
  }));

  return { codecs, total };
}

export const libraryCodecsRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /codecs - Codec distribution
   *
   * Returns video and audio codec breakdowns for movies/episodes and music.
   */
  app.get<{ Querystring: CodecsQueryInput }>(
    '/codecs',
    { preHandler: [app.requirePermission('insights', 'read')] },
    async (request, reply) => {
      const query = codecsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, libraryId } = query.data;
      const authUser = request.user;

      // Validate server access
      if (serverId) {
        const error = validateServerAccess(authUser, serverId);
        if (error) {
          return reply.forbidden(error);
        }
      }

      const resolvedIds = resolveServerIds(authUser, serverId, undefined, { strict: false });

      // Build cache key
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_CODECS ?? 'library:codecs',
        serverCacheSegment(resolvedIds),
        libraryId ?? 'all'
      );

      // Try cache first
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as LibraryCodecsResponse;
        } catch {
          // Fall through to compute
        }
      }

      // Build server filter
      const serverFilter = buildMultiServerFragment(resolvedIds);

      // Library filter
      const libraryFilter = libraryId ? sql`AND library_id = ${libraryId}` : sql``;

      // Query video codecs for movies and episodes
      const videoCodecsResult = await db.execute(sql`
        SELECT v.video_codec AS codec, media_type, COUNT(DISTINCT library_items.id)::int AS count
        FROM library_items
        JOIN library_item_versions v
          ON v.library_item_id = library_items.id AND v.removed_at IS NULL
        WHERE media_type IN ('movie', 'episode')
          AND v.video_codec IS NOT NULL
          AND library_items.removed_at IS NULL
          ${serverFilter}
          ${libraryFilter}
        GROUP BY v.video_codec, media_type
        ORDER BY count DESC
      `);

      // Query audio codecs for movies and episodes
      const audioCodecsResult = await db.execute(sql`
        SELECT v.audio_codec AS codec, media_type, COUNT(DISTINCT library_items.id)::int AS count
        FROM library_items
        JOIN library_item_versions v
          ON v.library_item_id = library_items.id AND v.removed_at IS NULL
        WHERE media_type IN ('movie', 'episode')
          AND v.audio_codec IS NOT NULL
          AND library_items.removed_at IS NULL
          ${serverFilter}
          ${libraryFilter}
        GROUP BY v.audio_codec, media_type
        ORDER BY count DESC
      `);

      // Query audio channels for movies and episodes
      const channelsResult = await db.execute(sql`
        SELECT v.audio_channels AS channels, media_type, COUNT(DISTINCT library_items.id)::int AS count
        FROM library_items
        JOIN library_item_versions v
          ON v.library_item_id = library_items.id AND v.removed_at IS NULL
        WHERE media_type IN ('movie', 'episode')
          AND v.audio_channels IS NOT NULL
          AND library_items.removed_at IS NULL
          ${serverFilter}
          ${libraryFilter}
        GROUP BY v.audio_channels, media_type
        ORDER BY count DESC
      `);

      // Query audio codecs for music tracks
      const musicCodecsResult = await db.execute(sql`
        SELECT v.audio_codec AS codec, COUNT(DISTINCT library_items.id)::int AS count
        FROM library_items
        JOIN library_item_versions v
          ON v.library_item_id = library_items.id AND v.removed_at IS NULL
        WHERE media_type = 'track'
          AND v.audio_codec IS NOT NULL
          AND library_items.removed_at IS NULL
          ${serverFilter}
          ${libraryFilter}
        GROUP BY v.audio_codec
        ORDER BY count DESC
      `);

      // Process results with normalization
      const videoRows = videoCodecsResult.rows as Array<{
        codec: string | null;
        count: number;
        media_type: string;
      }>;
      const audioRows = audioCodecsResult.rows as Array<{
        codec: string | null;
        count: number;
        media_type: string;
      }>;
      const channelRows = channelsResult.rows as Array<{
        channels: number | null;
        count: number;
        media_type: string;
      }>;
      const musicRows = musicCodecsResult.rows as Array<{ codec: string | null; count: number }>;

      // Convert channel rows to codec-like format for reusing aggregateCodecs
      const channelRowsAsCodec = channelRows.map((row) => ({
        codec: row.channels !== null ? String(row.channels) : null,
        count: row.count,
        media_type: row.media_type,
      }));

      const response: LibraryCodecsResponse = {
        video: aggregateCodecs(videoRows, normalizeVideoCodec),
        audio: aggregateCodecs(audioRows, normalizeAudioCodec),
        channels: aggregateCodecs(channelRowsAsCodec, (ch) =>
          normalizeAudioChannels(ch ? parseInt(ch, 10) : null)
        ),
        music: aggregateCodecs(musicRows, normalizeAudioCodec),
      };

      // Cache for 5 minutes
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_CODECS ?? 300, JSON.stringify(response));

      return response;
    }
  );
};
