/**
 * Overlapping resolution/codec facet semantics, against a real database.
 *
 * A title with a 4K and a 1080p version counts in BOTH buckets, so bucket
 * sums exceed the title count by design; codec facets count distinct titles
 * per codec the same way; the stats total is mirror-deduped (#478): the same
 * physical file (same media identity + byte size) indexed by two libraries
 * or servers counts once.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- facetOverlap
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import type {
  AuthUser,
  LibraryStatsResponse,
  LibraryResolutionResponse,
  DuplicatesResponse,
} from '@tracearr/shared';
import {
  createTestServer,
  createTestLibraryItem,
  createTestLibraryItemVersion,
} from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { libraryResolutionRoute } from '../../src/routes/library/resolution.js';
import { libraryStatsRoute } from '../../src/routes/library/stats.js';
import { libraryDuplicatesRoute } from '../../src/routes/library/duplicates.js';
import { resolveMediaForItem } from '../../src/services/library/mediaResolutionService.js';

async function buildApp(authUser: AuthUser): Promise<{ app: FastifyInstance; redis: Redis }> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: FastifyRequest) => {
    (request as FastifyRequest & { user: AuthUser }).user = authUser;
  });
  const redis = createMockRedis() as unknown as Redis;
  app.decorate('redis', redis);
  await app.register(libraryResolutionRoute, { prefix: '/library' });
  await app.register(libraryStatsRoute, { prefix: '/library' });
  await app.register(libraryDuplicatesRoute, { prefix: '/library' });
  return { app, redis };
}

function ownerFor(): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
}

describe('overlapping facets and mirror-deduped totals', () => {
  it('counts a 4K+1080p title in both resolution buckets', async () => {
    const server = await createTestServer({ type: 'plex' });

    const twoVersion = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'covenant',
      title: 'The Covenant',
      mediaType: 'movie',
      videoResolution: '4k',
      fileSize: 17_430_000_000,
      withoutVersion: true,
    });
    await createTestLibraryItemVersion({
      libraryItemId: twoVersion.id,
      serverVersionKey: '3207',
      videoResolution: '4k',
      videoCodec: 'HEVC',
      fileSize: 13_330_000_000,
    });
    await createTestLibraryItemVersion({
      libraryItemId: twoVersion.id,
      serverVersionKey: '98869',
      videoResolution: '1080p',
      videoCodec: 'H264',
      fileSize: 4_100_000_000,
    });

    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'plain-720',
      title: 'Plain 720p Movie',
      mediaType: 'movie',
      videoResolution: '720p',
      fileSize: 1_000_000_000,
    });

    const { app } = await buildApp(ownerFor());
    const response = await app.inject({
      method: 'GET',
      url: `/library/resolution?serverId=${server.id}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<LibraryResolutionResponse>();

    expect(body.movies.counts['4k']).toBe(1);
    expect(body.movies.counts['1080p']).toBe(1);
    expect(body.movies.counts['720p']).toBe(1);
    // Two titles, three bucket memberships: overlap by design
    expect(
      body.movies.counts['4k'] + body.movies.counts['1080p'] + body.movies.counts['720p']
    ).toBe(3);
  });

  it('stats total dedupes the same physical file across servers and counts buckets via versions', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 960_001,
      title: 'Mirrored Movie',
      year: 2023,
      serverId: serverA.id,
      ratingKey: 'mirror-a',
    });
    const sameId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 960_001,
      title: 'Mirrored Movie',
      year: 2023,
      serverId: serverB.id,
      ratingKey: 'mirror-b',
    });
    expect(sameId).toBe(mediaId);

    // The same 5 GB file served by both servers (shared storage): one
    // physical file, so the deduped total counts it once.
    await createTestLibraryItem({
      serverId: serverA.id,
      ratingKey: 'mirror-a',
      title: 'Mirrored Movie',
      mediaType: 'movie',
      mediaId,
      videoResolution: '4k',
      fileSize: 5_000_000_000,
    });
    await createTestLibraryItem({
      serverId: serverB.id,
      ratingKey: 'mirror-b',
      title: 'Mirrored Movie',
      mediaType: 'movie',
      mediaId,
      videoResolution: '4k',
      fileSize: 5_000_000_000,
    });

    const { app } = await buildApp(ownerFor());
    const response = await app.inject({
      method: 'GET',
      url: `/library/stats?serverIds=${serverA.id}&serverIds=${serverB.id}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<LibraryStatsResponse>();

    expect(body.totalItems).toBe(1);
    expect(Number(body.totalSizeBytes)).toBe(5_000_000_000);
    expect(body.qualityBreakdown['4k']).toBe(2);
  });
});

describe('duplicates taxonomy against a real database', () => {
  it('finds same-server cross-library copies and one-item version groups', async () => {
    const server = await createTestServer({ type: 'plex' });

    // Two copies of the same title on ONE server, two libraries: the old
    // COUNT(DISTINCT server_id) > 1 grouping made this invisible
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'copy-4k-lib',
      title: 'Cross Library Movie',
      mediaType: 'movie',
      imdbId: 'tt7700001',
      libraryId: 'lib-4k',
      videoResolution: '4k',
      fileSize: 10_000_000_000,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'copy-1080-lib',
      title: 'Cross Library Movie',
      mediaType: 'movie',
      imdbId: 'tt7700001',
      libraryId: 'lib-1080',
      videoResolution: '1080p',
      fileSize: 4_000_000_000,
    });

    // One item carrying two physical files (Plex merged versions)
    const merged = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'merged-versions',
      title: 'Merged Versions Movie',
      mediaType: 'movie',
      imdbId: 'tt7700002',
      videoResolution: '4k',
      fileSize: 17_000_000_000,
      withoutVersion: true,
    });
    await createTestLibraryItemVersion({
      libraryItemId: merged.id,
      serverVersionKey: 'm1',
      videoResolution: '4k',
      fileSize: 13_000_000_000,
    });
    await createTestLibraryItemVersion({
      libraryItemId: merged.id,
      serverVersionKey: 'm2',
      videoResolution: '1080p',
      fileSize: 4_000_000_000,
    });
    await db.execute(sql`UPDATE library_items SET version_count = 2 WHERE id = ${merged.id}`);

    const { app } = await buildApp(ownerFor());
    const response = await app.inject({
      method: 'GET',
      url: `/library/duplicates?serverIds=${server.id}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<DuplicatesResponse>();

    const copyGroup = body.duplicates.find((g) => g.matchKey === 'imdb:movie:tt7700001');
    expect(copyGroup).toBeDefined();
    expect(copyGroup!.matchType).toBe('imdb');
    expect(copyGroup!.sameServer).toBe(true);
    expect(copyGroup!.items).toHaveLength(2);
    expect(copyGroup!.items.map((i) => i.libraryId).sort()).toEqual(['lib-1080', 'lib-4k']);
    // Keep the best-quality file (10 GB 4K), reclaim the 4 GB 1080p
    expect(copyGroup!.totalStorageBytes).toBe(14_000_000_000);
    expect(copyGroup!.potentialSavingsBytes).toBe(4_000_000_000);

    // Single-item groups keep their external-id key but present as 'version'
    const versionGroup = body.duplicates.find((g) => g.matchKey === 'imdb:movie:tt7700002');
    expect(versionGroup).toBeDefined();
    expect(versionGroup!.matchType).toBe('version');
    expect(versionGroup!.sameServer).toBe(true);
    expect(versionGroup!.items[0]!.versions).toHaveLength(2);
    expect(versionGroup!.totalStorageBytes).toBe(17_000_000_000);
    expect(versionGroup!.potentialSavingsBytes).toBe(4_000_000_000);

    expect(body.summary.byMatchType.version).toBe(1);
  });

  it('mirrored copies (equal size) never form a group', async () => {
    // A mirror is one physical file listed by several servers, not a
    // duplicate: with no second distinct file there is nothing to reclaim,
    // so the group is gated out entirely rather than shipped with zero
    // savings. This is what keeps a fully mirrored multi-server install
    // from reporting every title as a duplicate.
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    for (const [server, key] of [
      [serverA, 'mirror-dup-a'],
      [serverB, 'mirror-dup-b'],
    ] as const) {
      await createTestLibraryItem({
        serverId: server.id,
        ratingKey: key,
        title: 'Mirrored Duplicate',
        mediaType: 'movie',
        imdbId: 'tt7700003',
        videoResolution: '4k',
        fileSize: 9_000_000_000,
      });
    }

    const { app } = await buildApp(ownerFor());
    const response = await app.inject({
      method: 'GET',
      url: `/library/duplicates?serverIds=${serverA.id}&serverIds=${serverB.id}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<DuplicatesResponse>();

    expect(body.duplicates.find((g) => g.matchKey.includes('tt7700003'))).toBeUndefined();
    expect(body.summary.totalGroups).toBe(0);
  });
});
