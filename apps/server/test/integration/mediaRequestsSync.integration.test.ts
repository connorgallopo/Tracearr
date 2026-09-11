/**
 * Seerr request sync against the real database.
 *
 * The fixture is one scrubbed page of 40 requests captured from a live
 * Overseerr, so the mapping, resolution and upsert paths run over real data
 * shapes rather than a hand-written row: unmatched media, unmatched
 * requesters, tv requests with seasons and movies with none all appear in it.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- mediaRequestsSync
 */

import { beforeAll, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import {
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
import { seerrRequestsPageSchema } from '../../src/services/requests/seerrClient.js';
import { createRequestService } from '../../src/services/requests/store.js';
import { runRequestSync } from '../../src/services/requests/sync.js';
import type { SeerrCounts, SeerrRequest } from '../../src/services/requests/seerrClient.js';
import type { SeerrClientLike } from '../../src/services/requests/sync.js';

const MACHINE_ID = 'fixture-machine';
/** The first movie and the first tv row of the fixture; both requested by seeded accounts. */
const MOVIE_TMDB_ID = 1433367;
const SHOW_TVDB_ID = 251085;
const SEEDED_PLEX_IDS = ['100031', '100001', '100003'];

const page = seerrRequestsPageSchema.parse(
  JSON.parse(readFileSync(new URL('../fixtures/seerr-requests-page.json', import.meta.url), 'utf8'))
);
const FIXTURE_REQUESTS = page.results;

function countsFor(results: SeerrRequest[]): SeerrCounts {
  const withStatus = (code: number): number => results.filter((r) => r.status === code).length;
  return {
    total: results.length,
    movie: results.filter((r) => r.type === 'movie').length,
    tv: results.filter((r) => r.type === 'tv').length,
    pending: withStatus(1),
    approved: withStatus(2),
    declined: withStatus(3),
    processing: 0,
    available: withStatus(5),
    completed: withStatus(5),
  };
}

function fixtureClient(results: SeerrRequest[]): SeerrClientLike {
  return {
    requestCount: () => Promise.resolve(countsFor(results)),
    requestsPage: () => Promise.resolve({ pageInfo: { pages: 1 }, results }),
    movie: () => Promise.resolve({ title: 'Fixture', year: 2020 }),
    tv: () => Promise.resolve({ title: 'Fixture', year: 2020 }),
  };
}

interface Seeded {
  serverId: string;
  serviceId: string;
  accountIds: string[];
  movieMediaId: string;
  showMediaId: string;
}

async function seed(): Promise<Seeded> {
  const server = await createTestServer({ type: 'plex' });
  await db.execute(
    sql`UPDATE servers SET machine_identifier = ${MACHINE_ID} WHERE id = ${server.id}`
  );

  const accountIds: string[] = [];
  for (const plexId of SEEDED_PLEX_IDS) {
    const user = await createTestUser({ role: 'member' });
    const account = await createTestServerUser({
      userId: user.id,
      serverId: server.id,
      username: `requester${plexId}`,
    });
    await db.execute(
      sql`UPDATE server_users SET plex_account_id = ${plexId} WHERE id = ${account.id}`
    );
    accountIds.push(account.id);
  }

  const movieMediaId = await resolveMediaForItem({
    mediaType: 'movie',
    tmdbId: MOVIE_TMDB_ID,
    title: 'Fixture Movie',
    year: 2026,
    serverId: server.id,
    ratingKey: 'fixture-movie',
  });
  const showMediaId = await resolveMediaForItem({
    mediaType: 'show',
    tvdbId: SHOW_TVDB_ID,
    title: 'Fixture Show',
    year: 2026,
    serverId: server.id,
    ratingKey: 'fixture-show',
  });

  const service = await createRequestService({
    serverId: server.id,
    type: 'seerr',
    name: 'Fixture Seerr',
    url: 'http://seerr.fixture.test',
    apiKey: 'fixture-api-key',
    remoteServerId: MACHINE_ID,
    version: '1.33.2',
  });

  return {
    serverId: server.id,
    serviceId: service.id,
    accountIds,
    movieMediaId,
    showMediaId,
  };
}

async function requestRows(): Promise<Record<string, unknown>[]> {
  const result = await db.execute(sql`
    SELECT remote_id, media_id, title, media_type, server_user_id, remote_username, remote_plex_id,
           status, seasons, deleted_at
    FROM media_requests
    ORDER BY remote_id
  `);
  return result.rows as unknown as Record<string, unknown>[];
}

describe('Seerr request sync', () => {
  beforeAll(() => {
    initDestinationCrypto();
  });

  it('stores the whole page and links the seeded media and requesters', async () => {
    const seeded = await seed();

    const result = await runRequestSync(seeded.serviceId, 'full', {
      clientFor: () => fixtureClient(FIXTURE_REQUESTS),
    });

    expect(result).toEqual({ skipped: false, upserted: 40, markedDeleted: 0 });

    const rows = await requestRows();
    expect(rows).toHaveLength(40);

    const movieRow = rows.find((r) => r.media_id === seeded.movieMediaId);
    expect(movieRow).toMatchObject({ title: 'Fixture Movie', media_type: 'movie' });

    const showRow = rows.find((r) => r.media_id === seeded.showMediaId);
    expect(showRow).toMatchObject({ title: 'Fixture Show', media_type: 'show' });
    expect(showRow?.seasons).toBeTruthy();

    for (const plexId of SEEDED_PLEX_IDS) {
      const matched = rows.filter((r) => r.remote_plex_id === plexId);
      expect(matched.length).toBeGreaterThan(0);
      for (const row of matched) {
        expect(seeded.accountIds).toContain(row.server_user_id);
      }
    }

    const unmatched = rows.filter((r) => !SEEDED_PLEX_IDS.includes(r.remote_plex_id as string));
    expect(unmatched.length).toBeGreaterThan(0);
    for (const row of unmatched) {
      expect(row.server_user_id).toBeNull();
      expect(row.remote_username).toBeTruthy();
    }
  });

  it('has nowhere to put the requester email Seerr sends', async () => {
    const result = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'media_requests' AND column_name LIKE '%email%'
    `);

    expect(result.rows).toEqual([]);
  });

  it('lenses the requester watched state onto a media request list', async () => {
    const seeded = await seed();
    const [accountId] = seeded.accountIds;
    if (!accountId) throw new Error('seed produced no accounts');

    await createTestSession({
      serverId: seeded.serverId,
      serverUserId: accountId,
      mediaType: 'movie',
      mediaId: seeded.movieMediaId,
      ratingKey: 'fixture-movie',
      durationMs: 1_800_000,
      totalDurationMs: 1_800_000,
      referenceId: null,
      watched: true,
    });
    await db.execute(
      sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
    );

    await runRequestSync(seeded.serviceId, 'full', {
      clientFor: () => fixtureClient(FIXTURE_REQUESTS),
    });

    const canonical = await resolveCanonicalMediaByRef(seeded.movieMediaId);
    if (!canonical) throw new Error('movie media row vanished');
    const scope = await buildMediaScope(canonical);
    if (!scope) throw new Error('movie media row has no scope');

    const entries = await listMediaRequests({ scope, serverIds: [seeded.serverId] });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.requester.serverUserId).toBe(accountId);
    expect(entries[0]?.watchedState).toBe('watched');
    expect(entries[0]?.waitMs).toBeGreaterThan(0);
  });

  it('marks a request the next full run no longer returns as deleted', async () => {
    const seeded = await seed();
    await runRequestSync(seeded.serviceId, 'full', {
      clientFor: () => fixtureClient(FIXTURE_REQUESTS),
    });

    const dropped = FIXTURE_REQUESTS[FIXTURE_REQUESTS.length - 1];
    if (!dropped) throw new Error('fixture is empty');
    const kept = FIXTURE_REQUESTS.slice(0, -1);

    const result = await runRequestSync(seeded.serviceId, 'full', {
      clientFor: () => fixtureClient(kept),
    });

    expect(result.markedDeleted).toBe(1);

    const rows = await requestRows();
    expect(rows).toHaveLength(40);
    const deleted = rows.filter((r) => r.deleted_at !== null);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.remote_id).toBe(dropped.id);
  });
});
