/**
 * Backfill of canonical media identity onto historical sessions.
 *
 * backfillSessionIdentityBatch stamps media_id and provider ids onto existing
 * sessions rows by joining library_items on (server_id, rating_key). It runs in
 * bounded batches and is resumable: sessions whose rating key has no resolvable
 * library item are excluded so they never re-select.
 *
 * Run with: pnpm --filter @tracearr/server test:integration sessionIdentityBackfill
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { REDIS_KEYS } from '@tracearr/shared';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestLibraryItem,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { libraries } from '../../src/db/schema.js';
import { getRedis } from '../../src/lib/redisShared.js';
import { setSetting } from '../../src/services/settings.js';
import { getCompressedSessionChunkRanges, getSessionChunkRanges } from '../../src/db/timescale.js';
import { resolveMediaForItem } from '../../src/services/library/mediaResolutionService.js';
import { stampPendingSessionIdentity } from '../../src/services/librarySync.js';
import { IMPORTED_LINK_REPAIR_VERSION } from '../../src/jobs/importedLinkRepair.js';
import {
  backfillSessionIdentityBatch,
  fullScanFloors,
  goneKeyWindows,
  hasConfirmedAbsentTrackedRows,
  hasStampableSessionsBefore,
  IDENTITY_PASSES_VERSION,
  markGoneKeyFloorsHandled,
  runSessionIdentityBackfillWalk,
  unhandledGoneKeyFloors,
} from '../../src/jobs/sessionIdentityBackfill.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

async function mediaRowsTitled(title: string): Promise<number> {
  const { rows } = await db.execute(
    sql`SELECT count(*)::int AS n FROM media WHERE title = ${title} AND merged_into_id IS NULL`
  );
  return (rows[0] as { n: number }).n;
}

async function fullScanCompletedAt(serverId: string, at: Date | null): Promise<void> {
  await db
    .insert(libraries)
    .values({ serverId, libraryId: '1', name: 'Movies', mediaType: 'movie' });
  if (at) {
    await getRedis().set(REDIS_KEYS.LIBRARY_SYNC_FULL_SCAN_AT(serverId, '1'), at.toISOString());
    await getRedis().set(REDIS_KEYS.LIBRARY_SYNC_FULL_SCAN_DONE(serverId, '1'), at.toISOString());
  }
}

async function linkOf(
  ratingKey: string
): Promise<{ media_id: string | null; show_media_id: string | null }> {
  const { rows } = await db.execute(
    sql`SELECT media_id, show_media_id FROM sessions WHERE rating_key = ${ratingKey}`
  );
  return rows[0] as { media_id: string | null; show_media_id: string | null };
}

async function trackedPlay(
  serverId: string,
  serverUserId: string,
  fields: Record<string, unknown>
): Promise<void> {
  await createTestSession({
    serverId,
    serverUserId,
    externalSessionId: null,
    startedAt: daysAgo(2),
    ...fields,
  } as Parameters<typeof createTestSession>[0]);
}

describe('session identity backfill', () => {
  it('backfills identity onto old sessions from library items', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0322259',
      title: '2 Fast 2 Furious',
      year: 2003,
      serverId: server.id,
      ratingKey: '2733',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: '2733',
      imdbId: 'tt0322259',
      mediaId,
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      ratingKey: '2733',
      externalSessionId: null,
    });

    const { updated } = await backfillSessionIdentityBatch(1000);
    expect(updated).toBe(1);

    const { rows } = await db.execute(
      sql`SELECT media_id, imdb_id FROM sessions WHERE rating_key = '2733'`
    );
    const row = rows[0] as { media_id: string; imdb_id: string | null };
    expect(row.media_id).toBe(mediaId);
    expect(row.imdb_id).toBeNull();
  });

  it('is resumable: second run finds nothing left', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0322259',
      title: '2 Fast 2 Furious',
      year: 2003,
      serverId: server.id,
      ratingKey: '2733',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: '2733',
      imdbId: 'tt0322259',
      mediaId,
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      ratingKey: '2733',
      externalSessionId: null,
    });

    await backfillSessionIdentityBatch(1000);
    const { updated } = await backfillSessionIdentityBatch(1000);
    expect(updated).toBe(0);
  });

  it('returns oldest as a real Date usable by refreshAggregates', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0322259',
      title: '2 Fast 2 Furious',
      year: 2003,
      serverId: server.id,
      ratingKey: '2733',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: '2733',
      imdbId: 'tt0322259',
      mediaId,
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      ratingKey: '2733',
      externalSessionId: null,
    });

    const { updated, oldest } = await backfillSessionIdentityBatch(1000);
    expect(updated).toBeGreaterThanOrEqual(1);
    expect(oldest).toBeInstanceOf(Date);
    expect(typeof oldest?.toISOString).toBe('function');
    expect(() => oldest?.toISOString()).not.toThrow();
  });

  it('leaves a tracked play whose item has not synced untouched, then links it to that item by key once it does', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 61_001,
      title: 'Harbor Lights',
      year: 2021,
      serverId: server.id,
      ratingKey: 'show-new',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'show-new',
      title: 'Harbor Lights',
      mediaType: 'show',
      mediaId: showId,
      withoutVersion: true,
    });
    for (const [ratingKey, mediaType, title] of [
      ['ep-new', 'episode', 'Pilot'],
      ['movie-new', 'movie', 'Gone Harbor'],
    ] as const) {
      await createTestSession({
        serverId: server.id,
        serverUserId: su.id,
        ratingKey,
        mediaType,
        mediaTitle: title,
        grandparentTitle: mediaType === 'episode' ? 'Harbor Lights' : null,
        seasonNumber: mediaType === 'episode' ? 1 : null,
        episodeNumber: mediaType === 'episode' ? 1 : null,
        year: 2001,
        externalSessionId: null,
      });
    }

    const first = await backfillSessionIdentityBatch(1000);
    expect(first.updated).toBe(0);
    const unlinked = await db.execute(
      sql`SELECT count(*)::int AS n FROM sessions WHERE server_id = ${server.id}::uuid AND media_id IS NULL`
    );
    expect((unlinked.rows[0] as { n: number }).n).toBe(2);
    expect(await mediaRowsTitled('Gone Harbor')).toBe(0);

    const episodeId = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 61_002,
      title: 'Pilot',
      serverId: server.id,
      ratingKey: 'ep-new',
      showMediaId: showId,
      grandparentRatingKey: 'show-new',
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'ep-new',
      title: 'Pilot',
      mediaType: 'episode',
      grandparentRatingKey: 'show-new',
      parentIndex: 1,
      itemIndex: 1,
      mediaId: episodeId,
    });
    const movieId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 61_003,
      title: 'Gone Harbor',
      year: 2001,
      serverId: server.id,
      ratingKey: 'movie-new',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'movie-new',
      title: 'Gone Harbor',
      year: 2001,
      mediaType: 'movie',
      mediaId: movieId,
    });

    await stampPendingSessionIdentity(true);

    const linked = (
      await db.execute(sql`
        SELECT rating_key, media_id FROM sessions WHERE server_id = ${server.id}::uuid ORDER BY rating_key
      `)
    ).rows;
    expect(linked).toEqual([
      { rating_key: 'ep-new', media_id: episodeId },
      { rating_key: 'movie-new', media_id: movieId },
    ]);
    expect(await mediaRowsTitled('Gone Harbor')).toBe(1);
  });

  it('does not stamp an episode session stored under a show rating key', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 81189,
      title: 'Breaking Bad',
      year: 2008,
      serverId: server.id,
      ratingKey: 'show-rk',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'show-rk',
      mediaType: 'show',
      tvdbId: 81189,
      mediaId: showId,
    });
    await createTestSession({
      serverId: server.id,
      externalSessionId: null,
      serverUserId: su.id,
      mediaType: 'episode',
      ratingKey: 'show-rk',
    });

    const { updated } = await backfillSessionIdentityBatch(1000);
    expect(updated).toBe(0);

    const { rows } = await db.execute(
      sql`SELECT media_id FROM sessions WHERE server_id = ${server.id}`
    );
    expect((rows[0] as { media_id: string | null }).media_id).toBeNull();
  });

  it('unlinks a session linked to a show media row and keeps it unlinked', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 81189,
      title: 'Breaking Bad',
      year: 2008,
      serverId: server.id,
      ratingKey: 'show-rk',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'show-rk',
      mediaType: 'show',
      tvdbId: 81189,
      mediaId: showId,
    });
    await createTestSession({
      serverId: server.id,
      externalSessionId: null,
      serverUserId: su.id,
      mediaType: 'episode',
      ratingKey: 'show-rk',
      mediaId: showId,
      showMediaId: showId,
      imdbId: 'tt0903747',
      tmdbId: 1396,
      tvdbId: 81189,
    });

    const first = await backfillSessionIdentityBatch(1000);
    expect(first.updated).toBe(1);
    const second = await backfillSessionIdentityBatch(1000);
    expect(second.updated).toBe(0);

    const { rows } = await db.execute(sql`
      SELECT media_id, show_media_id, imdb_id, tmdb_id, tvdb_id
      FROM sessions WHERE server_id = ${server.id}
    `);
    expect(rows[0]).toEqual({
      media_id: null,
      show_media_id: null,
      imdb_id: null,
      tmdb_id: null,
      tvdb_id: null,
    });
  });

  it('does not stamp a movie library item whose media row is a show', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 81189,
      title: 'Breaking Bad',
      year: 2008,
      serverId: server.id,
      ratingKey: 'reused-rk',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'reused-rk',
      mediaType: 'movie',
      mediaId: showId,
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      ratingKey: 'reused-rk',
      externalSessionId: null,
    });

    await backfillSessionIdentityBatch(1000);
    const second = await backfillSessionIdentityBatch(1000);
    expect(second.updated).toBe(0);

    const { rows } = await db.execute(
      sql`SELECT media_id FROM sessions WHERE server_id = ${server.id}`
    );
    expect((rows[0] as { media_id: string | null }).media_id).toBeNull();
  });

  it('still stamps a Jellyfin unknown session played from a movie library item', async () => {
    const server = await createTestServer({ type: 'jellyfin' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0322259',
      title: '2 Fast 2 Furious',
      year: 2003,
      serverId: server.id,
      ratingKey: 'jf-movie',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'jf-movie',
      mediaType: 'movie',
      imdbId: 'tt0322259',
      mediaId,
    });
    await createTestSession({
      serverId: server.id,
      externalSessionId: null,
      serverUserId: su.id,
      mediaType: 'unknown',
      ratingKey: 'jf-movie',
    });

    const { updated } = await backfillSessionIdentityBatch(1000);
    expect(updated).toBe(1);

    const { rows } = await db.execute(
      sql`SELECT media_id FROM sessions WHERE server_id = ${server.id}`
    );
    expect((rows[0] as { media_id: string | null }).media_id).toBe(mediaId);
  });

  it('continues below the previous batch instead of re-reading the rows above it', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0322259',
      title: '2 Fast 2 Furious',
      year: 2003,
      serverId: server.id,
      ratingKey: '2733',
    });
    await createTestLibraryItem({ serverId: server.id, ratingKey: '2733', mediaId });
    for (const days of [1, 2, 3]) {
      await createTestSession({
        serverId: server.id,
        externalSessionId: null,
        serverUserId: su.id,
        ratingKey: '2733',
        startedAt: daysAgo(days),
      });
    }

    const first = await backfillSessionIdentityBatch(2);
    expect(first.updated).toBe(2);
    // A row above the cursor that matches again is left for the next walk.
    await db.execute(sql`
      UPDATE sessions SET media_id = NULL
      WHERE server_id = ${server.id} AND started_at = (
        SELECT max(started_at) FROM sessions WHERE server_id = ${server.id}
      )
    `);

    const second = await backfillSessionIdentityBatch(2, undefined, first.cursor);
    expect(second.updated).toBe(1);
    expect(second.cursor).toEqual([null, null, null, null]);
    const { rows } = await db.execute(sql`
      SELECT media_id FROM sessions WHERE server_id = ${server.id} ORDER BY started_at DESC
    `);
    expect(rows.map((r) => (r as { media_id: string | null }).media_id)).toEqual([
      null,
      mediaId,
      mediaId,
    ]);
  });

  it('stamps a row the unlink pass freed above where the fresh stamp stopped', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const movieId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0322259',
      title: '2 Fast 2 Furious',
      year: 2003,
      serverId: server.id,
      ratingKey: '2733',
    });
    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 81189,
      title: 'Breaking Bad',
      year: 2008,
      serverId: server.id,
      ratingKey: 'show-rk',
    });
    await createTestLibraryItem({ serverId: server.id, ratingKey: '2733', mediaId: movieId });
    // Newest, and linked to a container: only the unlink pass can free it for
    // a fresh stamp, after the fresh pass of the same batch has already run.
    await createTestSession({
      serverId: server.id,
      externalSessionId: null,
      serverUserId: su.id,
      ratingKey: '2733',
      mediaId: showId,
      startedAt: daysAgo(1),
    });
    for (const days of [2, 3]) {
      await createTestSession({
        serverId: server.id,
        externalSessionId: null,
        serverUserId: su.id,
        ratingKey: '2733',
        startedAt: daysAgo(days),
      });
    }

    await runSessionIdentityBackfillWalk({
      batchSize: 1,
      getCompressedRanges: async () => [],
      getChunkRanges: async () => [],
    });

    const { rows } = await db.execute(
      sql`SELECT media_id FROM sessions WHERE server_id = ${server.id}`
    );
    expect(rows.map((r) => (r as { media_id: string | null }).media_id)).toEqual([
      movieId,
      movieId,
      movieId,
    ]);
  });

  it('probes only the rating keys it is given', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0322259',
      title: '2 Fast 2 Furious',
      year: 2003,
      serverId: server.id,
      ratingKey: '2733',
    });
    await createTestLibraryItem({ serverId: server.id, ratingKey: '2733', mediaId });
    await createTestSession({
      serverId: server.id,
      externalSessionId: null,
      serverUserId: su.id,
      ratingKey: '2733',
      startedAt: daysAgo(2),
    });

    await expect(hasStampableSessionsBefore(new Date(), server.id, ['other-rk'])).resolves.toBe(
      false
    );
    await expect(hasStampableSessionsBefore(new Date(), server.id, ['2733'])).resolves.toBe(true);
  });

  it('resolves a tracked play by title once its rating key is confirmed absent from the server', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    await fullScanCompletedAt(server.id, new Date());
    const movieId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 61_201,
      title: 'Harbor Gone',
      year: 2001,
      serverId: server.id,
      ratingKey: 'movie-cur',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'movie-cur',
      title: 'Harbor Gone',
      year: 2001,
      mediaType: 'movie',
      mediaId: movieId,
    });
    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 61_202,
      title: 'Harbor Lights',
      year: 2020,
      serverId: server.id,
      ratingKey: 'show-cur',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'show-cur',
      title: 'Harbor Lights',
      mediaType: 'show',
      mediaId: showId,
      withoutVersion: true,
    });
    const episodeId = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 61_203,
      title: 'Pilot',
      serverId: server.id,
      ratingKey: 'ep-cur',
      showMediaId: showId,
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'ep-cur',
      title: 'Pilot',
      mediaType: 'episode',
      grandparentRatingKey: 'show-cur',
      parentIndex: 1,
      itemIndex: 1,
      mediaId: episodeId,
    });
    await trackedPlay(server.id, su.id, {
      ratingKey: 'gone-movie',
      mediaType: 'movie',
      mediaTitle: 'Harbor Gone',
      year: 2001,
      tmdbId: 61_201,
    });
    await trackedPlay(server.id, su.id, {
      ratingKey: 'gone-ep',
      mediaType: 'episode',
      mediaTitle: 'Pilot',
      grandparentTitle: 'Harbor Lights',
      seasonNumber: 1,
      episodeNumber: 1,
      year: 2020,
    });

    const { updated } = await backfillSessionIdentityBatch(1000);

    expect(updated).toBe(2);
    expect(await linkOf('gone-movie')).toEqual({ media_id: movieId, show_media_id: null });
    expect(await linkOf('gone-ep')).toEqual({ media_id: episodeId, show_media_id: showId });
    expect(await mediaRowsTitled('Harbor Gone')).toBe(1);
  });

  it('leaves a tracked play alone until a full scan has completed after it', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    await fullScanCompletedAt(server.id, daysAgo(3));
    const other = await createTestServer({ type: 'plex' });
    const otherUser = await createTestServerUser({ userId: user.id, serverId: other.id });
    await fullScanCompletedAt(other.id, null);
    for (const [serverId, serverUserId] of [
      [server.id, su.id],
      [other.id, otherUser.id],
    ] as const) {
      await trackedPlay(serverId, serverUserId, {
        ratingKey: `gone-${serverId}`,
        mediaType: 'movie',
        mediaTitle: 'Harbor Gone',
        year: 2001,
      });
    }

    const { updated } = await backfillSessionIdentityBatch(1000);

    expect(updated).toBe(0);
    expect((await linkOf(`gone-${server.id}`)).media_id).toBeNull();
    expect((await linkOf(`gone-${other.id}`)).media_id).toBeNull();
    expect(await mediaRowsTitled('Harbor Gone')).toBe(0);
  });

  it('trusts only a full scan that completed, not the time an incremental sync seeded', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    await db
      .insert(libraries)
      .values({ serverId: server.id, libraryId: '1', name: 'Movies', mediaType: 'movie' });
    await getRedis().set(
      REDIS_KEYS.LIBRARY_SYNC_FULL_SCAN_AT(server.id, '1'),
      new Date().toISOString()
    );
    await trackedPlay(server.id, su.id, {
      ratingKey: 'gone-seeded',
      mediaType: 'movie',
      mediaTitle: 'Harbor Gone',
      year: 2001,
    });

    expect((await backfillSessionIdentityBatch(1000)).updated).toBe(0);
    expect((await linkOf('gone-seeded')).media_id).toBeNull();

    await getRedis().set(
      REDIS_KEYS.LIBRARY_SYNC_FULL_SCAN_DONE(server.id, '1'),
      new Date().toISOString()
    );

    expect((await backfillSessionIdentityBatch(1000)).updated).toBe(1);
    expect((await linkOf('gone-seeded')).media_id).not.toBeNull();
  });

  it('resolves a tracked gone-key play on its own once a full scan completes after the upgrade walk', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    await db
      .insert(libraries)
      .values({ serverId: server.id, libraryId: '1', name: 'Movies', mediaType: 'movie' });
    const movieId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 61_301,
      title: 'Harbor Gone',
      year: 2001,
      serverId: server.id,
      ratingKey: 'movie-cur',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'movie-cur',
      title: 'Harbor Gone',
      year: 2001,
      mediaType: 'movie',
      mediaId: movieId,
    });
    await trackedPlay(server.id, su.id, {
      ratingKey: 'gone-later',
      mediaType: 'movie',
      mediaTitle: 'Harbor Gone',
      year: 2001,
      tmdbId: 61_301,
    });

    const walk = await runSessionIdentityBackfillWalk({
      batchSize: 100,
      getCompressedRanges: getCompressedSessionChunkRanges,
      getChunkRanges: getSessionChunkRanges,
    });
    await setSetting('identityPassesVersion', IDENTITY_PASSES_VERSION);
    expect(walk.total).toBe(0);
    expect((await linkOf('gone-later')).media_id).toBeNull();

    await getRedis().set(
      REDIS_KEYS.LIBRARY_SYNC_FULL_SCAN_DONE(server.id, '1'),
      new Date().toISOString()
    );
    await stampPendingSessionIdentity(false);

    expect((await linkOf('gone-later')).media_id).toBe(movieId);
  });

  it('does not keep reporting gone-key rows the title pass can never resolve', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    await fullScanCompletedAt(server.id, new Date());
    await trackedPlay(server.id, su.id, {
      ratingKey: 'gone-no-number',
      mediaType: 'episode',
      mediaTitle: 'Pilot',
      grandparentTitle: 'Harbor Lights',
      seasonNumber: null,
      episodeNumber: null,
    });
    await trackedPlay(server.id, su.id, {
      ratingKey: 'gone-no-title',
      mediaType: 'movie',
      mediaTitle: '',
      year: 2001,
    });

    const floors = await fullScanFloors();
    expect(floors.size).toBe(1);
    expect(await hasConfirmedAbsentTrackedRows(await goneKeyWindows(floors))).toBe(false);
    expect((await backfillSessionIdentityBatch(1000)).examined).toBe(0);
  });

  it('takes a gone-key movie by its provider id or any non-empty title, whatever the title looks like', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    await fullScanCompletedAt(server.id, new Date());
    const byId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 61_401,
      title: 'Harbor Gone',
      year: 2001,
      serverId: server.id,
      ratingKey: 'movie-id',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'movie-id',
      title: 'Harbor Gone',
      year: 2001,
      mediaType: 'movie',
      mediaId: byId,
    });
    const accented = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 61_402,
      title: 'Ärger im Hafen',
      year: 2002,
      serverId: server.id,
      ratingKey: 'movie-accented',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'movie-accented',
      title: 'Ärger im Hafen',
      year: 2002,
      mediaType: 'movie',
      mediaId: accented,
    });
    await trackedPlay(server.id, su.id, {
      ratingKey: 'gone-blank-title',
      mediaType: 'movie',
      mediaTitle: '',
      year: 2001,
      tmdbId: 61_401,
    });
    await trackedPlay(server.id, su.id, {
      ratingKey: 'gone-accented',
      mediaType: 'movie',
      mediaTitle: 'Ärger im Hafen',
      year: 2002,
    });

    expect(await hasConfirmedAbsentTrackedRows(await goneKeyWindows(await fullScanFloors()))).toBe(
      true
    );
    expect((await backfillSessionIdentityBatch(1000)).updated).toBe(2);
    expect((await linkOf('gone-blank-title')).media_id).toBe(byId);
    expect((await linkOf('gone-accented')).media_id).toBe(accented);
  });

  it('handles a server floor for gone keys once, and again only when the floor advances', async () => {
    const server = await createTestServer({ type: 'plex' });
    await fullScanCompletedAt(server.id, daysAgo(1));

    const floors = await fullScanFloors();
    const pending = await unhandledGoneKeyFloors(floors);
    expect([...pending.keys()]).toEqual([server.id]);
    await markGoneKeyFloorsHandled(pending);
    expect((await unhandledGoneKeyFloors(floors)).size).toBe(0);

    await getRedis().set(
      REDIS_KEYS.LIBRARY_SYNC_FULL_SCAN_DONE(server.id, '1'),
      new Date().toISOString()
    );
    const advanced = await fullScanFloors();
    const pendingAgain = await unhandledGoneKeyFloors(advanced);
    expect([...pendingAgain.keys()]).toEqual([server.id]);
    await markGoneKeyFloorsHandled(pendingAgain);
    expect((await unhandledGoneKeyFloors(advanced)).size).toBe(0);
  });

  it('stamps an import by its rating key unless the key is provably reused', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const movieId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 61_501,
      title: 'Harbor Gone',
      year: 2001,
      serverId: server.id,
      ratingKey: 'key-1',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'key-1',
      title: 'Harbor Gone',
      year: 2001,
      mediaType: 'movie',
      mediaId: movieId,
    });
    const imported = async (ratingKey: string, fields: Record<string, unknown>) =>
      createTestSession({
        serverId: server.id,
        serverUserId: su.id,
        externalSessionId: `import-${ratingKey}-${fields.mediaTitle as string}`,
        ratingKey,
        startedAt: daysAgo(2),
        ...fields,
      } as Parameters<typeof createTestSession>[0]);
    await imported('key-1', { mediaType: 'movie', mediaTitle: 'Harbour Gone', year: 2001 });
    await imported('key-1', { mediaType: 'movie', mediaTitle: 'Harbor Gone', year: 2002 });
    await imported('key-1', {
      mediaType: 'episode',
      mediaTitle: 'Harbor Gone',
      grandparentTitle: 'Other Show',
      seasonNumber: 1,
      episodeNumber: 1,
      year: 2001,
    });
    await imported('key-1', { mediaType: 'movie', mediaTitle: 'Other Film', year: 1990 });

    await backfillSessionIdentityBatch(1000);

    const rows = (
      await db.execute(sql`
        SELECT media_title, year, media_type, media_id FROM sessions
        WHERE server_id = ${server.id}::uuid ORDER BY media_title, year
      `)
    ).rows as Array<{
      media_title: string;
      year: number;
      media_type: string;
      media_id: string | null;
    }>;
    const byTitle = new Map(
      rows.map((r) => [`${r.media_type}:${r.media_title}:${r.year}`, r.media_id])
    );
    expect(byTitle.get('movie:Harbour Gone:2001')).toBe(movieId);
    expect(byTitle.get('movie:Harbor Gone:2002')).toBe(movieId);
    expect(byTitle.get('episode:Harbor Gone:2001')).not.toBe(movieId);
    expect(byTitle.get('movie:Other Film:1990')).not.toBe(movieId);
  });

  it('does not re-attempt gone-key rows older than the floor already handled when the floor advances', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    await fullScanCompletedAt(server.id, daysAgo(1));
    for (const [ratingKey, year] of [
      ['show-twin-a', 2001],
      ['show-twin-b', 2015],
    ] as const) {
      await resolveMediaForItem({
        mediaType: 'show',
        title: 'Twin Harbor',
        year,
        serverId: server.id,
        ratingKey,
      });
    }
    await trackedPlay(server.id, su.id, {
      ratingKey: 'gone-twin',
      mediaType: 'episode',
      mediaTitle: 'Pilot',
      grandparentTitle: 'Twin Harbor',
      seasonNumber: 1,
      episodeNumber: 1,
      year: 2016,
      startedAt: daysAgo(2),
    });

    const first = await goneKeyWindows(await fullScanFloors());
    expect(await hasConfirmedAbsentTrackedRows(first)).toBe(true);
    expect(
      (await backfillSessionIdentityBatch(1000, undefined, undefined, { absentKeyFloors: first }))
        .examined
    ).toBe(1);
    expect((await linkOf('gone-twin')).media_id).toBeNull();
    await markGoneKeyFloorsHandled(first);

    await getRedis().set(
      REDIS_KEYS.LIBRARY_SYNC_FULL_SCAN_DONE(server.id, '1'),
      new Date().toISOString()
    );
    const advanced = await unhandledGoneKeyFloors(await fullScanFloors());
    expect(advanced.size).toBe(1);
    expect(await hasConfirmedAbsentTrackedRows(advanced)).toBe(false);
    expect(
      (
        await backfillSessionIdentityBatch(1000, undefined, undefined, {
          absentKeyFloors: advanced,
        })
      ).examined
    ).toBe(0);
  });

  it('refuses a key held by another media type only where the import source stated the type', async () => {
    const plex = await createTestServer({ type: 'plex' });
    const jellyfin = await createTestServer({ type: 'jellyfin' });
    const user = await createTestUser();
    const items = new Map<string, { su: string; movieId: string }>();
    for (const server of [plex, jellyfin]) {
      const su = await createTestServerUser({ userId: user.id, serverId: server.id });
      const movieId = await resolveMediaForItem({
        mediaType: 'movie',
        tmdbId: 61_701,
        title: 'Source Harbor',
        year: 2001,
        serverId: server.id,
        ratingKey: 'typed-key',
      });
      await createTestLibraryItem({
        serverId: server.id,
        ratingKey: 'typed-key',
        title: 'Source Harbor',
        year: 2001,
        mediaType: 'movie',
        mediaId: movieId,
      });
      items.set(server.id, { su: su.id, movieId });
    }
    const episodeOnKey = async (serverId: string, externalSessionId: string) =>
      createTestSession({
        serverId,
        serverUserId: items.get(serverId)?.su ?? '',
        externalSessionId,
        ratingKey: 'typed-key',
        mediaType: 'episode',
        mediaTitle: 'Source Harbor',
        year: 2001,
        startedAt: daysAgo(2),
      });
    await episodeOnKey(plex.id, '4242');
    await episodeOnKey(jellyfin.id, 'pr-4242');
    await episodeOnKey(jellyfin.id, '4243');
    await episodeOnKey(jellyfin.id, '0123456789abcdef0123456789abcdef');
    await episodeOnKey(jellyfin.id, randomUUID());

    await backfillSessionIdentityBatch(1000);

    const rows = (
      await db.execute(sql`
        SELECT external_session_id, server_id, media_id FROM sessions
        WHERE rating_key = 'typed-key' ORDER BY external_session_id
      `)
    ).rows as Array<{ external_session_id: string; server_id: string; media_id: string | null }>;
    const onItem = (row: { server_id: string; media_id: string | null }) =>
      row.media_id === items.get(row.server_id)?.movieId;
    const byId = new Map(rows.map((row) => [row.external_session_id, onItem(row)]));
    expect(byId.get('4242')).toBe(false);
    expect(byId.get('pr-4242')).toBe(false);
    expect(byId.get('4243')).toBe(true);
    expect(byId.get('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(
      [...byId.entries()]
        .filter(([id]) => id.includes('-') && !id.startsWith('pr-'))
        .map(([, v]) => v)
    ).toEqual([true]);
  });

  it('stamps a Jellystat-shaped import by key even when its stored media type is a heuristic', async () => {
    const server = await createTestServer({ type: 'jellyfin' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 61_601,
      title: 'Legacy Harbor',
      year: 2015,
      serverId: server.id,
      ratingKey: 'show-legacy',
    });
    const episodeId = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 61_602,
      title: 'Pilot',
      serverId: server.id,
      ratingKey: 'ep-legacy',
      showMediaId: showId,
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'ep-legacy',
      title: 'Pilot',
      mediaType: 'episode',
      grandparentRatingKey: 'show-legacy',
      parentIndex: 1,
      itemIndex: 1,
      mediaId: episodeId,
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      externalSessionId: randomUUID(),
      ratingKey: 'ep-legacy',
      mediaType: 'movie',
      mediaTitle: 'Pilot',
      startedAt: daysAgo(2),
    });

    expect((await backfillSessionIdentityBatch(1000)).updated).toBe(1);
    expect(await linkOf('ep-legacy')).toEqual({ media_id: episodeId, show_media_id: showId });
  });

  async function importedOnReusedKey(type: 'plex' | 'jellyfin') {
    const server = await createTestServer({ type });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 61_801,
      title: 'The Blacklist',
      year: 2013,
      serverId: server.id,
      ratingKey: 'blacklist',
    });
    const episodeId = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 61_802,
      title: 'Orion Relocation Services',
      year: 2019,
      serverId: server.id,
      ratingKey: 'reused-key',
      showMediaId: showId,
      seasonNumber: 7,
      episodeNumber: 9,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'reused-key',
      title: 'Orion Relocation Services',
      year: 2019,
      mediaType: 'episode',
      grandparentTitle: 'The Blacklist',
      grandparentRatingKey: 'blacklist',
      parentIndex: 7,
      itemIndex: 9,
      mediaId: episodeId,
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      externalSessionId: 'import-forged-s7e17',
      ratingKey: 'reused-key',
      mediaType: 'episode',
      mediaTitle: 'Charlemagne’s Sword',
      grandparentTitle: 'Forged in Fire',
      seasonNumber: 7,
      episodeNumber: 17,
      year: 2020,
      startedAt: daysAgo(2),
    });
    await backfillSessionIdentityBatch(1000, undefined, undefined, { resolveImports: true });
    return { episodeId, link: await linkOf('reused-key') };
  }

  it('fresh stamp refuses a key the repair unlinked', async () => {
    const { episodeId, link } = await importedOnReusedKey('plex');
    expect(link.media_id).not.toBe(episodeId);
  });

  it('fresh stamp keeps the provably-reused rule on a Jellyfin server', async () => {
    const { episodeId, link } = await importedOnReusedKey('jellyfin');
    expect(link.media_id).toBe(episodeId);
  });

  it('never title-resolves a tracked play whose key a library item has held', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    await fullScanCompletedAt(server.id, new Date());
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'held-key',
      title: 'Removed Title',
      mediaType: 'movie',
      mediaId: null,
      removedAt: daysAgo(1),
    });
    await trackedPlay(server.id, su.id, {
      ratingKey: 'held-key',
      mediaType: 'movie',
      mediaTitle: 'Harbor Gone',
      year: 2001,
    });

    const { updated } = await backfillSessionIdentityBatch(1000);

    expect(updated).toBe(0);
    expect((await linkOf('held-key')).media_id).toBeNull();
    expect(await mediaRowsTitled('Harbor Gone')).toBe(0);
  });

  it('the title pass does not relink a play the repair could not place', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const imported = (ratingKey: string) =>
      createTestSession({
        serverId: server.id,
        serverUserId: su.id,
        externalSessionId: `import-${ratingKey}`,
        ratingKey,
        mediaType: 'movie',
        mediaTitle: 'Harbor Gone',
        year: 2001,
        tmdbId: 61_501,
        startedAt: daysAgo(2),
      });
    const unplaced = await imported('unplaced-key');
    await imported('placed-key');
    await db.execute(sql`
      INSERT INTO session_link_repairs (session_id, started_at, repair_version, server_id, clause)
      SELECT id, started_at, ${IMPORTED_LINK_REPAIR_VERSION}, server_id, 'numbers'
      FROM sessions WHERE id = ${unplaced.id}::uuid
    `);

    await backfillSessionIdentityBatch(1000);

    expect((await linkOf('unplaced-key')).media_id).toBeNull();
    expect((await linkOf('placed-key')).media_id).not.toBeNull();
  });
});
