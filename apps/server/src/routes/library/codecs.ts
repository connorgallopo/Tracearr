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
import { validateServerAccess } from '../../utils/serverFiltering.js';
import {
  normalizeVideoCodec,
  normalizeAudioCodec,
  normalizeAudioChannels,
} from '../../utils/codecNormalizer.js';
import { buildLibraryServerFilter, buildLibraryCacheKey } from './utils.js';

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
  rows: Array<{ codec: string | null; count: number }>,
  normalizer: (codec: string | null) => string,
  topN: number = 7
): { codecs: CodecEntry[]; total: number } {
  // Group by normalized codec name
  const codecMap = new Map<string, number>();
  let total = 0;

  for (const row of rows) {
    const normalized = normalizer(row.codec);
    const existing = codecMap.get(normalized) ?? 0;
    codecMap.set(normalized, existing + row.count);
    total += row.count;
  }

  // Sort by count descending
  const sorted = Array.from(codecMap.entries())
    .map(([codec, count]) => ({ codec, count }))
    .sort((a, b) => b.count - a.count);

  // Take top N, aggregate rest as "Other"
  const topCodecs = sorted.slice(0, topN);
  const otherCount = sorted.slice(topN).reduce((sum, item) => sum + item.count, 0);

  if (otherCount > 0) {
    topCodecs.push({ codec: 'Other', count: otherCount });
  }

  // Calculate percentages
  const codecs: CodecEntry[] = topCodecs.map((item) => ({
    codec: item.codec,
    count: item.count,
    percentage: total > 0 ? Math.round((item.count / total) * 1000) / 10 : 0,
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
    { preHandler: [app.authenticate] },
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

      // Build cache key
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_CODECS ?? 'library:codecs',
        serverId,
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
      const serverFilter = buildLibraryServerFilter(serverId, authUser);

      // Library filter
      const libraryFilter = libraryId ? sql`AND library_id = ${libraryId}` : sql``;

      // Query video codecs for movies and episodes
      const videoCodecsResult = await db.execute(sql`
        SELECT video_codec AS codec, COUNT(*)::int AS count
        FROM library_items
        WHERE media_type IN ('movie', 'episode')
          AND video_codec IS NOT NULL
          ${serverFilter}
          ${libraryFilter}
        GROUP BY video_codec
        ORDER BY count DESC
      `);

      // Query audio codecs for movies and episodes
      const audioCodecsResult = await db.execute(sql`
        SELECT audio_codec AS codec, COUNT(*)::int AS count
        FROM library_items
        WHERE media_type IN ('movie', 'episode')
          AND audio_codec IS NOT NULL
          ${serverFilter}
          ${libraryFilter}
        GROUP BY audio_codec
        ORDER BY count DESC
      `);

      // Query audio channels for movies and episodes
      const channelsResult = await db.execute(sql`
        SELECT audio_channels AS channels, COUNT(*)::int AS count
        FROM library_items
        WHERE media_type IN ('movie', 'episode')
          AND audio_channels IS NOT NULL
          ${serverFilter}
          ${libraryFilter}
        GROUP BY audio_channels
        ORDER BY count DESC
      `);

      // Query audio codecs for music tracks
      const musicCodecsResult = await db.execute(sql`
        SELECT audio_codec AS codec, COUNT(*)::int AS count
        FROM library_items
        WHERE media_type = 'track'
          AND audio_codec IS NOT NULL
          ${serverFilter}
          ${libraryFilter}
        GROUP BY audio_codec
        ORDER BY count DESC
      `);

      // Process results with normalization
      const videoRows = videoCodecsResult.rows as Array<{ codec: string | null; count: number }>;
      const audioRows = audioCodecsResult.rows as Array<{ codec: string | null; count: number }>;
      const channelRows = channelsResult.rows as Array<{ channels: number | null; count: number }>;
      const musicRows = musicCodecsResult.rows as Array<{ codec: string | null; count: number }>;

      // Convert channel rows to codec-like format for reusing aggregateCodecs
      const channelRowsAsCodec = channelRows.map((row) => ({
        codec: row.channels !== null ? String(row.channels) : null,
        count: row.count,
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
