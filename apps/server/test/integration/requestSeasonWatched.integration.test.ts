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
  buildMediaScope,
  resolveCanonicalMediaByRef,
} from '../../src/services/library/mediaDetailService.js';
import { resolveMediaForItem } from '../../src/services/library/mediaResolutionService.js';
import { initDestinationCrypto } from '../../src/services/notifications/destinationCrypto.js';
import { listMediaRequests } from '../../src/services/requests/reads.js';
import { createRequestService } from '../../src/services/requests/store.js';

const MACHINE_ID = 'season-watched-machine';

async function refreshPlays(): Promise<void> {
  await db.execute(
    sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
  );
}

describe('a show request is watched only when the requested seasons are', () => {
  beforeAll(() => {
    initDestinationCrypto();
  });

  it('separates the season the requester asked for from the one they actually watched', async () => {
    const server = await createTestServer({ type: 'plex' });
    await db.execute(
      sql`UPDATE servers SET machine_identifier = ${MACHINE_ID} WHERE id = ${server.id}`
    );
    const user = await createTestUser({ role: 'member' });
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });

    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 810_001,
      title: 'Season Scope Show',
      year: 2021,
      serverId: server.id,
      ratingKey: 'ss-show',
    });

    const episodes: { id: string; season: number; number: number; key: string }[] = [];
    for (const season of [1, 2]) {
      for (const number of [1, 2]) {
        const key = `ss-s${season}e${number}`;
        const id = await resolveMediaForItem({
          mediaType: 'episode',
          tvdbId: 810_100 + season * 10 + number,
          title: `S${season}E${number}`,
          year: 2021,
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
        });
        episodes.push({ id, season, number, key });
      }
    }

    for (const episode of episodes.filter((e) => e.season === 1)) {
      await createTestSession({
        serverId: server.id,
        serverUserId: account.id,
        mediaType: 'episode',
        mediaId: episode.id,
        showMediaId: showId,
        ratingKey: episode.key,
        durationMs: 1_500_000,
        totalDurationMs: 1_500_000,
        referenceId: null,
        watched: true,
      });
    }
    await refreshPlays();

    const service = await createRequestService({
      serverId: server.id,
      type: 'seerr',
      name: 'Season Scope Seerr',
      url: 'http://seerr.season.test',
      apiKey: 'season-api-key',
      remoteServerId: MACHINE_ID,
      version: '1.33.2',
    });

    const insertRequest = async (remoteId: number, season: number): Promise<void> => {
      await db.execute(sql`
        INSERT INTO media_requests (
          service_id, remote_id, remote_media_id, media_type, media_id, server_user_id,
          remote_user_id, remote_username, status, seasons, requested_at,
          remote_updated_at, synced_at
        ) VALUES (
          ${service.id}, ${remoteId}, ${remoteId}, 'show', ${showId}, ${account.id},
          ${remoteId}, 'season-requester', 'completed',
          ${JSON.stringify([{ seasonNumber: season, status: 'completed' }])}::jsonb,
          now() - interval '30 days', now() - interval '29 days', now()
        )
      `);
    };
    await insertRequest(9001, 1);
    await insertRequest(9002, 2);

    const canonical = await resolveCanonicalMediaByRef(showId);
    if (!canonical) throw new Error('show media row vanished');
    const scope = await buildMediaScope(canonical);
    if (!scope) throw new Error('show media row has no scope');

    const entries = await listMediaRequests({ scope, serverIds: [server.id] });
    const bySeason = new Map(entries.map((e) => [e.seasons?.[0]?.seasonNumber ?? -1, e] as const));

    expect(bySeason.get(1)?.watchedStateRequester).toBe('watched');
    expect(bySeason.get(2)?.watchedStateRequester).toBe('unwatched');
  });
});
