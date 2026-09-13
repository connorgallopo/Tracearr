import { beforeAll, describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestLibraryItem,
  createTestServer,
  createTestServerUser,
  createTestSession,
  createTestUser,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import {
  mergeMediaRows,
  resolveMediaForItem,
} from '../../src/services/library/mediaResolutionService.js';
import { initDestinationCrypto } from '../../src/services/notifications/destinationCrypto.js';
import { getRequestsAnalytics } from '../../src/services/requests/analytics.js';
import { createRequestService } from '../../src/services/requests/store.js';

const MACHINE_ID = 'requests-analytics-machine';
const MERGE_MACHINE_ID = 'requests-analytics-merge-machine';
const SEASON_ONE_BYTES = 2 * 100_000;
const SEASON_TWO_BYTES = 2 * 300_000;

describe('the reclaim table charges a season request for its own seasons', () => {
  beforeAll(() => {
    initDestinationCrypto();
  });

  it('never bills a season request for the whole series, and counts a shared season once', async () => {
    const server = await createTestServer({ type: 'plex' });
    await db.execute(
      sql`UPDATE servers SET machine_identifier = ${MACHINE_ID} WHERE id = ${server.id}`
    );

    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 820_001,
      title: 'Reclaim Scope Show',
      year: 2019,
      serverId: server.id,
      ratingKey: 'rs-show',
    });

    for (const season of [1, 2]) {
      for (const number of [1, 2]) {
        const key = `rs-s${season}e${number}`;
        const id = await resolveMediaForItem({
          mediaType: 'episode',
          tvdbId: 820_100 + season * 10 + number,
          title: `S${season}E${number}`,
          year: 2019,
          serverId: server.id,
          ratingKey: key,
          showMediaId: showId,
          seasonNumber: season,
          episodeNumber: number,
        });
        await createTestLibraryItem({
          serverId: server.id,
          ratingKey: key,
          title: `S${season}E${number}`,
          mediaType: 'episode',
          mediaId: id,
          parentIndex: season,
          itemIndex: number,
          fileSize: season === 1 ? 100_000 : 300_000,
        });
      }
    }

    const service = await createRequestService({
      serverId: server.id,
      type: 'seerr',
      name: 'Reclaim Scope Seerr',
      url: 'http://seerr.reclaim.test',
      apiKey: 'reclaim-api-key',
      remoteServerId: MACHINE_ID,
      version: '1.33.2',
    });

    const insertRequest = async (remoteId: number, seasons: number[]): Promise<void> => {
      await db.execute(sql`
        INSERT INTO media_requests (
          service_id, remote_id, remote_media_id, media_type, media_id, server_user_id,
          remote_user_id, remote_username, status, seasons, requested_at, available_at,
          remote_updated_at, synced_at
        ) VALUES (
          ${service.id}, ${remoteId}, ${remoteId}, 'show', ${showId}, NULL,
          ${remoteId}, 'reclaim-requester', 'completed',
          ${JSON.stringify(seasons.map((seasonNumber) => ({ seasonNumber, status: 'completed' })))}::jsonb,
          now() - interval '30 days', now() - interval '29 days', now() - interval '29 days', now()
        )
      `);
    };
    await insertRequest(9101, [1]);
    await insertRequest(9102, [2]);

    const result = await getRequestsAnalytics([server.id]);
    const bySeason = new Map(
      result.unplayed.map((row) => [row.seasons?.[0]?.seasonNumber ?? -1, row.fileSizeBytes])
    );

    expect(bySeason.get(1)).toBe(SEASON_ONE_BYTES);
    expect(bySeason.get(2)).toBe(SEASON_TWO_BYTES);
    expect(result.unplayedBytes).toBe(SEASON_ONE_BYTES + SEASON_TWO_BYTES);

    await insertRequest(9103, [1, 2]);

    const withOverlap = await getRequestsAnalytics([server.id]);

    expect(withOverlap.unplayed).toHaveLength(3);
    expect(withOverlap.unplayedBytes).toBe(SEASON_ONE_BYTES + SEASON_TWO_BYTES);
  });

  it('reads a request through a later merge, and a title played before its file was removed stays off the list', async () => {
    const server = await createTestServer({ type: 'plex' });
    await db.execute(
      sql`UPDATE servers SET machine_identifier = ${MERGE_MACHINE_ID} WHERE id = ${server.id}`
    );
    const user = await createTestUser({ role: 'member' });
    const account = await createTestServerUser({ userId: user.id, serverId: server.id });

    const resolveMovie = (tmdbId: number, ratingKey: string) =>
      resolveMediaForItem({
        mediaType: 'movie',
        tmdbId,
        title: `Request Merge ${tmdbId}`,
        year: 2022,
        serverId: server.id,
        ratingKey,
      });
    const keptWinner = await resolveMovie(830_001, 'kept-winner');
    const keptLoser = await resolveMovie(830_002, 'kept-loser');
    const playedWinner = await resolveMovie(830_003, 'played-winner');
    const playedLoser = await resolveMovie(830_004, 'played-loser');

    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'kept-loser',
      title: 'Kept',
      mediaType: 'movie',
      mediaId: keptLoser,
      fileSize: 500_000,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'played-loser',
      title: 'Played',
      mediaType: 'movie',
      mediaId: playedLoser,
      fileSize: 700_000,
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaType: 'movie',
      mediaId: playedLoser,
      ratingKey: 'played-loser',
      durationMs: 1_800_000,
      totalDurationMs: 1_800_000,
      referenceId: null,
      watched: true,
    });

    const service = await createRequestService({
      serverId: server.id,
      type: 'seerr',
      name: 'Request Merge Seerr',
      url: 'http://seerr.merge.test',
      apiKey: 'merge-api-key',
      remoteServerId: MERGE_MACHINE_ID,
      version: '1.33.2',
    });
    for (const [remoteId, mediaId] of [
      [9201, keptLoser],
      [9202, playedLoser],
    ] as const) {
      await db.execute(sql`
        INSERT INTO media_requests (
          service_id, remote_id, remote_media_id, media_type, media_id, server_user_id,
          remote_user_id, remote_username, status, requested_at, available_at,
          remote_updated_at, synced_at
        ) VALUES (
          ${service.id}, ${remoteId}, ${remoteId}, 'movie', ${mediaId}, ${account.id},
          ${remoteId}, 'merge-requester', 'completed',
          now() - interval '30 days', now() - interval '29 days', now() - interval '29 days', now()
        )
      `);
    }

    await mergeMediaRows(keptWinner, keptLoser);
    await mergeMediaRows(playedWinner, playedLoser);
    await db.execute(
      sql`UPDATE library_items SET removed_at = now() WHERE server_id = ${server.id} AND rating_key = 'played-loser'`
    );
    await db.execute(
      sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
    );

    const result = await getRequestsAnalytics([server.id]);

    expect(result.funnel).toMatchObject({ landed: 2, watched: 1 });
    expect(result.unplayed).toHaveLength(1);
    expect(result.unplayed[0]).toMatchObject({ mediaId: keptWinner, fileSizeBytes: 500_000 });
    expect(result.requesters[0]).toMatchObject({ landed: 2, watched: 1, watchedByOthers: 0 });
  });

  it('credits someone else only once they have watched every episode of the requested season', async () => {
    const server = await createTestServer({ type: 'plex' });
    await db.execute(
      sql`UPDATE servers SET machine_identifier = 'requests-analytics-season-machine' WHERE id = ${server.id}`
    );
    const requester = await createTestUser({ role: 'member' });
    const viewer = await createTestUser({ role: 'member' });
    const requesterAccount = await createTestServerUser({
      userId: requester.id,
      serverId: server.id,
    });
    const viewerAccount = await createTestServerUser({ userId: viewer.id, serverId: server.id });

    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 840_001,
      title: 'Season Bar Show',
      year: 2020,
      serverId: server.id,
      ratingKey: 'sb-show',
    });
    const episodes = new Map<string, string>();
    for (const season of [1, 2]) {
      for (const number of [1, 2]) {
        const key = `sb-s${season}e${number}`;
        const id = await resolveMediaForItem({
          mediaType: 'episode',
          tvdbId: 840_100 + season * 10 + number,
          title: `S${season}E${number}`,
          year: 2020,
          serverId: server.id,
          ratingKey: key,
          showMediaId: showId,
          seasonNumber: season,
          episodeNumber: number,
        });
        episodes.set(key, id);
        await createTestLibraryItem({
          serverId: server.id,
          ratingKey: key,
          title: `S${season}E${number}`,
          mediaType: 'episode',
          mediaId: id,
          parentIndex: season,
          itemIndex: number,
          fileSize: 100_000,
        });
      }
    }

    const service = await createRequestService({
      serverId: server.id,
      type: 'seerr',
      name: 'Season Bar Seerr',
      url: 'http://seerr.season.test',
      apiKey: 'season-api-key',
      remoteServerId: 'requests-analytics-season-machine',
      version: '1.33.2',
    });
    await db.execute(sql`
      INSERT INTO media_requests (
        service_id, remote_id, remote_media_id, media_type, media_id, server_user_id,
        remote_user_id, remote_username, status, seasons, requested_at, available_at,
        remote_updated_at, synced_at
      ) VALUES (
        ${service.id}, 9301, 9301, 'show', ${showId}, ${requesterAccount.id},
        9301, 'season-requester', 'completed',
        ${JSON.stringify([{ seasonNumber: 1, status: 'completed' }])}::jsonb,
        now() - interval '30 days', now() - interval '29 days', now() - interval '29 days', now()
      )
    `);

    const watch = async (keys: string[]): Promise<void> => {
      for (const key of keys) {
        await createTestSession({
          serverId: server.id,
          serverUserId: viewerAccount.id,
          mediaType: 'episode',
          mediaId: episodes.get(key),
          showMediaId: showId,
          ratingKey: key,
          durationMs: 1_800_000,
          totalDurationMs: 1_800_000,
          referenceId: null,
          watched: true,
        });
      }
      await db.execute(
        sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
      );
    };

    await watch(['sb-s2e1', 'sb-s2e2', 'sb-s1e1']);
    const partway = await getRequestsAnalytics([server.id]);

    expect(partway.unplayed).toEqual([]);
    expect(partway.requesters[0]).toMatchObject({ watchedByOthers: 0 });

    await watch(['sb-s1e2']);
    const finished = await getRequestsAnalytics([server.id]);

    expect(finished.requesters[0]).toMatchObject({ watchedByOthers: 1 });

    await db.execute(
      sql`UPDATE library_items SET removed_at = now() WHERE server_id = ${server.id} AND parent_index = 1`
    );
    const deleted = await getRequestsAnalytics([server.id]);

    expect(deleted.funnel.watched).toBe(1);
    expect(deleted.unplayed).toEqual([]);
    expect(deleted.requesters[0]).toMatchObject({ watchedByOthers: 1 });
  });
});
