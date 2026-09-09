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
 * - user_id scopes the whole aggregate rather than annotating rows, so a
 *   two-tone badge is built from the difference of two pulls.
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
import { decodeCursor } from '../../src/utils/cursor.js';
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
      userId: null,
      serverIds: [server.id],
      minState: 'watched',
      pageSize: 100,
      cursorValue: null,
    });

    const movie = data.find((row) => row.media_id === movieId);
    expect(movie?.watched_state).toBe('watched');
    expect(movie?.tmdb_id).toBe(710001);
    expect(movie?.title).toBe('Listed Movie');
    expect(movie?.plays).toBe(1);
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
        userId: null,
        serverIds: [server.id],
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

  it('scopes the whole result to one identity, so the badge is a set difference', async () => {
    const server = await createTestServer({ type: 'plex' });
    const viewer = await createTestUser({ role: 'member' });
    const other = await createTestUser({ role: 'member' });
    const viewerAccount = await createTestServerUser({ userId: viewer.id, serverId: server.id });
    const otherAccount = await createTestServerUser({ userId: other.id, serverId: server.id });

    const mineId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 730001,
      title: 'Watched By Viewer',
      year: 2024,
      serverId: server.id,
      ratingKey: 'mine-movie',
    });
    const theirsId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 730002,
      title: 'Watched By Others Only',
      year: 2024,
      serverId: server.id,
      ratingKey: 'theirs-movie',
    });
    const sharedId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 730003,
      title: 'Watched By Both',
      year: 2024,
      serverId: server.id,
      ratingKey: 'shared-movie',
    });

    for (const [mediaId, ratingKey, account] of [
      [mineId, 'mine-movie', viewerAccount],
      [theirsId, 'theirs-movie', otherAccount],
      [sharedId, 'shared-movie', viewerAccount],
      [sharedId, 'shared-movie', otherAccount],
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

    const listMovies = (userId: string | null) =>
      listWatchedMedia({
        kind: 'movie',
        userId,
        serverIds: [server.id],
        minState: 'watched',
        pageSize: 100,
        cursorValue: null,
      });

    const everyone = await listMovies(null);
    const mine = await listMovies(viewer.id);

    const everyoneIds = everyone.data.map((row) => row.media_id);
    const mineIds = mine.data.map((row) => row.media_id);

    expect(everyoneIds).toContain(mineId);
    expect(everyoneIds).toContain(theirsId);
    // The scoped pull is a strict subset: a title this identity never played is
    // absent, not present with an unwatched marker.
    expect(mineIds.sort()).toEqual([mineId, sharedId].sort());
    // Which makes the two-tone badge a set difference: green is the scoped pull,
    // orange is what is left of the unscoped one.
    const othersOnly = everyoneIds.filter((id) => !mineIds.includes(id));
    expect(othersOnly).toEqual([theirsId]);

    // Scoping has to re-grain the measures too, not just the row set: the title
    // both identities played counts once for the viewer and twice overall.
    expect(mine.data.find((row) => row.media_id === sharedId)?.plays).toBe(1);
    expect(everyone.data.find((row) => row.media_id === sharedId)?.plays).toBe(2);
  });

  it('scopes a show to one identity while the episode total stays server-wide', async () => {
    const server = await createTestServer({ type: 'plex' });
    const viewer = await createTestUser({ role: 'member' });
    const other = await createTestUser({ role: 'member' });
    const viewerAccount = await createTestServerUser({ userId: viewer.id, serverId: server.id });
    const otherAccount = await createTestServerUser({ userId: other.id, serverId: server.id });

    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 760001,
      title: 'Split Between Two',
      year: 2025,
      serverId: server.id,
      ratingKey: 'split-show',
    });
    const episodeIds: string[] = [];
    for (const [index, key] of ['split-ep-1', 'split-ep-2'].entries()) {
      const episodeId = await resolveMediaForItem({
        mediaType: 'episode',
        tvdbId: 760010 + index,
        title: `Split Episode ${index + 1}`,
        year: 2025,
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

    // Between them the household has finished the show; neither identity has.
    for (const [episodeId, ratingKey, account] of [
      [episodeIds[0], 'split-ep-1', viewerAccount],
      [episodeIds[1], 'split-ep-2', otherAccount],
    ] as const) {
      await createTestSession({
        serverId: server.id,
        serverUserId: account.id,
        mediaType: 'episode',
        mediaId: episodeId,
        showMediaId: showId,
        ratingKey,
        durationMs: 1_800_000,
        totalDurationMs: 1_800_000,
        referenceId: null,
        watched: true,
      });
    }

    await refreshPlaysAggregate();

    const listShows = (userId: string | null, minState: 'watched' | 'partial') =>
      listWatchedMedia({
        kind: 'show',
        userId,
        serverIds: [server.id],
        minState,
        pageSize: 100,
        cursorValue: null,
      });

    const household = await listShows(null, 'watched');
    expect(household.data.find((row) => row.media_id === showId)?.watched_state).toBe('watched');

    // The denominator must stay server-wide. Scoping it to the identity too
    // would make one-of-one look complete and mark the show watched for both.
    const scopedWatched = await listShows(viewer.id, 'watched');
    expect(scopedWatched.data.some((row) => row.media_id === showId)).toBe(false);

    const scopedPartial = await listShows(viewer.id, 'partial');
    const row = scopedPartial.data.find((r) => r.media_id === showId);
    expect(row?.watched_state).toBe('partial');
    expect(row?.episodes_watched).toBe(1);
    expect(row?.episode_count).toBe(2);
  });

  it('places an episode row in its series with season and episode numbers', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const account = await createTestServerUser({ userId: user.id, serverId: server.id });

    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 750001,
      title: 'Numbered Show',
      year: 2022,
      serverId: server.id,
      ratingKey: 'numbered-show',
    });
    const episodeId = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 750010,
      title: 'Numbered Episode',
      year: 2022,
      serverId: server.id,
      ratingKey: 'numbered-ep',
      showMediaId: showId,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'numbered-ep',
      mediaType: 'episode',
      mediaId: episodeId,
      parentIndex: 2,
      itemIndex: 5,
    });

    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaType: 'episode',
      mediaId: episodeId,
      showMediaId: showId,
      ratingKey: 'numbered-ep',
      durationMs: 1_800_000,
      totalDurationMs: 1_800_000,
      referenceId: null,
      watched: true,
    });

    await refreshPlaysAggregate();

    const { data } = await listWatchedMedia({
      kind: 'episode',
      userId: null,
      serverIds: [server.id],
      minState: 'watched',
      pageSize: 100,
      cursorValue: null,
    });

    // An episode's own tvdb id is only set when the server supplied one, so the
    // series id plus these numbers are what actually locate the episode.
    const row = data.find((r) => r.media_id === episodeId);
    expect(row?.season_number).toBe(2);
    expect(row?.episode_number).toBe(5);
    expect(row?.show_media_id).toBe(showId);
    expect(row?.show_tvdb_id).toBe(750001);
  });
  it('walks every page exactly once and stops, paging over the ordered candidate list', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const account = await createTestServerUser({ userId: user.id, serverId: server.id });

    const ids: string[] = [];
    for (const [index, key] of ['walk-1', 'walk-2', 'walk-3'].entries()) {
      const mediaId = await resolveMediaForItem({
        mediaType: 'movie',
        tmdbId: 770001 + index,
        title: `Walk Movie ${index + 1}`,
        year: 2026,
        serverId: server.id,
        ratingKey: key,
      });
      await createTestSession({
        serverId: server.id,
        serverUserId: account.id,
        mediaType: 'movie',
        mediaId,
        ratingKey: key,
        durationMs: 1_800_000,
        totalDurationMs: 1_800_000,
        referenceId: null,
        watched: true,
      });
      ids.push(mediaId);
    }

    await refreshPlaysAggregate();

    // pageSize 1 over titles that share a last_watched_day, so the walk leans on
    // the canonical-id tiebreak rather than on distinct timestamps.
    const seen: string[] = [];
    let cursorValue: { startedAt: Date; id: string } | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await listWatchedMedia({
        kind: 'movie',
        userId: user.id,
        serverIds: [server.id],
        minState: 'watched',
        pageSize: 1,
        cursorValue,
      });
      seen.push(...page.data.map((row) => row.media_id));
      if (!page.nextCursor) break;
      const decoded = decodeCursor(page.nextCursor);
      expect(decoded).not.toBeNull();
      cursorValue = decoded;
    }

    expect(seen.sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });
});
