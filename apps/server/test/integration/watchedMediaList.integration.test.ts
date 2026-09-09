/**
 * Watched-media listing integration coverage.
 *
 * listWatchedMedia resolves watched state in SQL rather than probing a known
 * id list, so nothing in the unit tier executes its queries - the rendered-SQL
 * tests only pin the text. This runs both branches against real TimescaleDB
 * and pins the three behaviors that would silently produce a badge
 * contradicting the library UI:
 * - the movie branch's media_type guard keeps episode rows out (every session
 *   row carries media_id regardless of type).
 * - a show's state compares distinct watched episodes against the episodes
 *   actually present on the server, so min_state filtering happens before the
 *   page is sliced rather than after.
 * - the dual lens returns titles only other people watched, with the lens
 *   identity's own state alongside the all-users state.
 *
 * Every call scopes to its own server so a worker database shared with other
 * seeded suites can't leak rows into the assertions.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- watchedMediaList
 */

import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestServer,
  createTestUser,
  createTestServerUser,
  createTestSession,
  createTestLibraryItem,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { resolveMediaForItem } from '../../src/services/library/mediaResolutionService.js';
import { listWatchedMedia } from '../../src/services/library/mediaWatchedService.js';

async function refreshPlaysAggregate(): Promise<void> {
  await db.execute(
    sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
  );
}

describe('listWatchedMedia', () => {
  it('lists a watched movie with its external ids and leaves episodes out of the movie branch', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const account = await createTestServerUser({ userId: user.id, serverId: server.id });

    const movieId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 710001,
      title: 'Listed Movie',
      year: 2022,
      serverId: server.id,
      ratingKey: 'list-movie',
    });
    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 710002,
      title: 'Listed Show',
      year: 2022,
      serverId: server.id,
      ratingKey: 'list-show',
    });
    const episodeId = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 710003,
      title: 'Listed Episode',
      year: 2022,
      serverId: server.id,
      ratingKey: 'list-ep',
      showMediaId: showId,
    });

    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaType: 'movie',
      mediaId: movieId,
      ratingKey: 'list-movie',
      durationMs: 1_800_000,
      totalDurationMs: 1_800_000,
      referenceId: null,
      watched: true,
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaType: 'episode',
      mediaId: episodeId,
      showMediaId: showId,
      ratingKey: 'list-ep',
      durationMs: 1_800_000,
      totalDurationMs: 1_800_000,
      referenceId: null,
      watched: true,
    });

    await refreshPlaysAggregate();

    const { data } = await listWatchedMedia({
      kind: 'movie',
      lensUserId: null,
      serverIds: [server.id],
      windowDays: null,
      minState: 'watched',
      pageSize: 100,
      cursorValue: null,
    });

    const movie = data.find((row) => row.media_id === movieId);
    expect(movie?.watched_state).toBe('watched');
    expect(movie?.tmdb_id).toBe(710001);
    expect(movie?.title).toBe('Listed Movie');
    expect(movie?.plays).toBe(1);
    expect(movie?.watched_state_user).toBeNull();
    // The episode's own media_id is set on its session row, so without the
    // media_type guard it would join into the movie list as a "movie".
    expect(data.some((row) => row.media_id === episodeId)).toBe(false);
  });

  it('resolves a show against the episodes present on the server, before the page is sliced', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const account = await createTestServerUser({ userId: user.id, serverId: server.id });

    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 720001,
      title: 'Half Watched Show',
      year: 2023,
      serverId: server.id,
      ratingKey: 'half-show',
    });
    const episodeIds: string[] = [];
    for (const [index, key] of ['half-ep-1', 'half-ep-2'].entries()) {
      const episodeId = await resolveMediaForItem({
        mediaType: 'episode',
        tvdbId: 720010 + index,
        title: `Half Episode ${index + 1}`,
        year: 2023,
        serverId: server.id,
        ratingKey: key,
        showMediaId: showId,
      });
      await createTestLibraryItem({
        serverId: server.id,
        ratingKey: key,
        mediaType: 'episode',
        mediaId: episodeId,
      });
      episodeIds.push(episodeId);
    }

    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaType: 'episode',
      mediaId: episodeIds[0],
      showMediaId: showId,
      ratingKey: 'half-ep-1',
      durationMs: 1_800_000,
      totalDurationMs: 1_800_000,
      referenceId: null,
      watched: true,
    });

    await refreshPlaysAggregate();

    const listShows = (minState: 'watched' | 'partial') =>
      listWatchedMedia({
        kind: 'show',
        lensUserId: null,
        serverIds: [server.id],
        windowDays: null,
        minState,
        pageSize: 100,
        cursorValue: null,
      });

    const partial = await listShows('partial');
    const partialRow = partial.data.find((row) => row.media_id === showId);
    expect(partialRow?.watched_state).toBe('partial');
    expect(partialRow?.episodes_watched).toBe(1);
    expect(partialRow?.episode_count).toBe(2);

    // One of two episodes watched must not survive the watched filter, and the
    // filter runs in SQL, so the page comes back without it rather than short.
    const watchedOnly = await listShows('watched');
    expect(watchedOnly.data.some((row) => row.media_id === showId)).toBe(false);

    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaType: 'episode',
      mediaId: episodeIds[1],
      showMediaId: showId,
      ratingKey: 'half-ep-2',
      durationMs: 1_800_000,
      totalDurationMs: 1_800_000,
      referenceId: null,
      watched: true,
    });
    await refreshPlaysAggregate();

    const complete = await listShows('watched');
    const completeRow = complete.data.find((row) => row.media_id === showId);
    expect(completeRow?.watched_state).toBe('watched');
    expect(completeRow?.episodes_watched).toBe(2);
  });

  it('returns a title only other people watched, with the lens identity marked unwatched', async () => {
    const server = await createTestServer({ type: 'plex' });
    const viewer = await createTestUser({ role: 'member' });
    const other = await createTestUser({ role: 'member' });
    const viewerAccount = await createTestServerUser({ userId: viewer.id, serverId: server.id });
    const otherAccount = await createTestServerUser({ userId: other.id, serverId: server.id });

    const sharedId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 730001,
      title: 'Watched By Both',
      year: 2024,
      serverId: server.id,
      ratingKey: 'shared-movie',
    });
    const othersOnlyId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 730002,
      title: 'Watched By Others Only',
      year: 2024,
      serverId: server.id,
      ratingKey: 'others-movie',
    });

    for (const [mediaId, ratingKey, account] of [
      [sharedId, 'shared-movie', viewerAccount],
      [othersOnlyId, 'others-movie', otherAccount],
    ] as const) {
      await createTestSession({
        serverId: server.id,
        serverUserId: account.id,
        mediaType: 'movie',
        mediaId,
        ratingKey,
        durationMs: 1_800_000,
        totalDurationMs: 1_800_000,
        referenceId: null,
        watched: true,
      });
    }

    await refreshPlaysAggregate();

    const { data } = await listWatchedMedia({
      kind: 'movie',
      lensUserId: viewer.id,
      serverIds: [server.id],
      windowDays: null,
      minState: 'watched',
      pageSize: 100,
      cursorValue: null,
    });

    const own = data.find((row) => row.media_id === sharedId);
    expect(own?.watched_state).toBe('watched');
    expect(own?.watched_state_user).toBe('watched');

    // The row set stays everyone who watched, so one call answers both badges:
    // watched_state says somebody did, watched_state_user says it wasn't them.
    const others = data.find((row) => row.media_id === othersOnlyId);
    expect(others?.watched_state).toBe('watched');
    expect(others?.watched_state_user).toBe('unwatched');
  });
});
