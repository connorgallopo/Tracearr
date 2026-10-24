/**
 * Duplicates grouping correctness, against a real database.
 *
 * The route computes grouping, the distinct-file gate, storage math, and the
 * summary in one SQL statement; these prove that statement over seeded rows.
 * A duplicate is a title with two or more distinct physical files (distinct
 * byte sizes after mirror collapse), so mirror-only groups must never ship -
 * that is what keeps a fully mirrored multi-server install from reporting
 * every title as a duplicate.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- duplicatesGrouping
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import type { AuthUser, DuplicatesResponse } from '@tracearr/shared';
import {
  createTestServer,
  createTestLibraryItem,
  createTestLibraryItemVersion,
} from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { media } from '../../src/db/schema.js';
import { libraryDuplicatesRoute } from '../../src/routes/library/duplicates.js';
import { permissionGuard } from '../../src/lib/scope.js';

async function buildApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: FastifyRequest) => {
    (request as FastifyRequest & { user: AuthUser }).user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('redis', createMockRedis() as unknown as Redis);
  await app.register(libraryDuplicatesRoute, { prefix: '/library' });
  return app;
}

function ownerUser(): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
}

async function requestDuplicates(
  app: FastifyInstance,
  serverIds: string[],
  extra = '',
  includeFuzzy = false
): Promise<DuplicatesResponse> {
  const scope = serverIds.map((id) => `serverIds=${id}`).join('&');
  const response = await app.inject({
    method: 'GET',
    url: `/library/duplicates?includeFuzzy=${includeFuzzy}&${scope}${extra}`,
  });
  expect(response.statusCode).toBe(200);
  return response.json<DuplicatesResponse>();
}

describe('GET /library/duplicates (real SQL)', () => {
  it('counts mirrored cross-library versions once (issue #958 shape)', async () => {
    // One server, the same movie in Movies and Movies 4K via merge-versions:
    // two items, each listing BOTH physical files (100 and 60)
    const server = await createTestServer();
    const imdb = `tt${Date.now()}1`;
    for (const libraryId of ['lib-movies', 'lib-movies-4k']) {
      const item = await createTestLibraryItem({
        serverId: server.id,
        libraryId,
        imdbId: imdb,
        fileSize: 160,
        withoutVersion: true,
      });
      await createTestLibraryItemVersion({
        libraryItemId: item.id,
        fileSize: 100,
        videoResolution: '4k',
      });
      await createTestLibraryItemVersion({
        libraryItemId: item.id,
        fileSize: 60,
        videoResolution: '1080p',
      });
    }

    const app = await buildApp(ownerUser());
    const body = await requestDuplicates(app, [server.id]);

    expect(body.summary.totalGroups).toBe(1);
    const group = body.duplicates[0]!;
    expect(group.matchType).toBe('imdb');
    // Two physical files, not four
    expect(group.uniqueFileCount).toBe(2);
    expect(group.totalStorageBytes).toBe(160);
    expect(group.potentialSavingsBytes).toBe(60);
    // Every file still listed under its library entry; the second listing of
    // each physical file is flagged as a mirror
    const allVersions = group.items.flatMap((item) => item.versions);
    expect(allVersions).toHaveLength(4);
    expect(allVersions.filter((v) => v.isMirror)).toHaveLength(2);
  });

  it('does not report a byte-identical same-item pair as a duplicate', async () => {
    const server = await createTestServer();
    const item = await createTestLibraryItem({
      serverId: server.id,
      fileSize: 1000,
      withoutVersion: true,
    });
    await createTestLibraryItemVersion({ libraryItemId: item.id, fileSize: 500 });
    await createTestLibraryItemVersion({ libraryItemId: item.id, fileSize: 500 });

    const app = await buildApp(ownerUser());
    const body = await requestDuplicates(app, [server.id]);

    expect(body.summary.totalGroups).toBe(0);
    expect(body.duplicates).toHaveLength(0);
  });

  it('reports a real same-item version pair with distinct sizes', async () => {
    const server = await createTestServer();
    const item = await createTestLibraryItem({
      serverId: server.id,
      fileSize: 1199,
      withoutVersion: true,
    });
    await createTestLibraryItemVersion({
      libraryItemId: item.id,
      fileSize: 600,
      videoResolution: '4k',
    });
    await createTestLibraryItemVersion({
      libraryItemId: item.id,
      fileSize: 599,
      videoResolution: '4k',
    });

    const app = await buildApp(ownerUser());
    const body = await requestDuplicates(app, [server.id]);

    expect(body.summary.totalGroups).toBe(1);
    const group = body.duplicates[0]!;
    expect(group.matchType).toBe('version');
    expect(group.confidence).toBe(100);
    expect(group.uniqueFileCount).toBe(2);
    expect(group.totalStorageBytes).toBe(1199);
    expect(group.potentialSavingsBytes).toBe(599);
    expect(body.summary.byMatchType.version).toBe(1);
  });

  it('keeps classic cross-server duplicates with distinct files', async () => {
    const serverA = await createTestServer();
    const serverB = await createTestServer();
    const imdb = `tt${Date.now()}2`;
    await createTestLibraryItem({
      serverId: serverA.id,
      imdbId: imdb,
      fileSize: 900,
      videoResolution: '4k',
    });
    await createTestLibraryItem({
      serverId: serverB.id,
      imdbId: imdb,
      fileSize: 400,
      videoResolution: '1080p',
    });

    const app = await buildApp(ownerUser());
    const body = await requestDuplicates(app, [serverA.id, serverB.id]);

    expect(body.summary.totalGroups).toBe(1);
    const group = body.duplicates[0]!;
    expect(group.matchType).toBe('imdb');
    expect(group.serverCount).toBe(2);
    expect(group.sameServer).toBe(false);
    expect(group.uniqueFileCount).toBe(2);
    expect(group.totalStorageBytes).toBe(1300);
    // Keeper is the 4k file; the 1080p copy is reclaimable
    expect(group.potentialSavingsBytes).toBe(400);
  });

  it('never ships a mirror-only cross-server group', async () => {
    // Two servers mounting the same storage: same title, same single file
    // byte-for-byte on both. One physical file means no duplicate.
    const serverA = await createTestServer();
    const serverB = await createTestServer();
    const imdb = `tt${Date.now()}3`;
    for (const serverId of [serverA.id, serverB.id]) {
      await createTestLibraryItem({
        serverId,
        imdbId: imdb,
        fileSize: 500,
        videoResolution: '4k',
      });
    }

    const app = await buildApp(ownerUser());
    const body = await requestDuplicates(app, [serverA.id, serverB.id]);

    expect(body.summary.totalGroups).toBe(0);
    expect(body.duplicates).toHaveLength(0);
  });

  it('does not collapse a show and an episode sharing a TVDB id', async () => {
    const server = await createTestServer();
    const tvdb = Math.floor(Date.now() / 1000);
    await createTestLibraryItem({
      serverId: server.id,
      mediaType: 'show',
      tvdbId: tvdb,
      fileSize: 100,
    });
    await createTestLibraryItem({
      serverId: server.id,
      mediaType: 'episode',
      tvdbId: tvdb,
      fileSize: 50,
    });

    const app = await buildApp(ownerUser());
    const body = await requestDuplicates(app, [server.id]);

    // Different media types never share a group; each is single-file and gated
    expect(body.summary.totalGroups).toBe(0);
  });

  it('does not pair two episodes of one show that share an id but differ in episode number', async () => {
    const server = await createTestServer();
    for (const [season, episode, size] of [
      [1, 2, 918_142_971],
      [2, 1, 934_866_823],
    ] as const) {
      await createTestLibraryItem({
        serverId: server.id,
        mediaType: 'episode',
        imdbId: 'tt32429838',
        grandparentTitle: 'Tires',
        parentIndex: season,
        itemIndex: episode,
        fileSize: size,
      });
    }

    const app = await buildApp(ownerUser());
    const body = await requestDuplicates(app, [server.id]);

    expect(body.summary.totalGroups).toBe(0);
  });

  it('pairs the same episode across servers by id and episode number', async () => {
    const serverA = await createTestServer();
    const serverB = await createTestServer();
    const tvdb = Math.floor(Date.now() / 1000) + 2;
    for (const [serverId, size] of [
      [serverA.id, 100],
      [serverB.id, 60],
    ] as const) {
      await createTestLibraryItem({
        serverId,
        mediaType: 'episode',
        tvdbId: tvdb,
        grandparentTitle: 'Breaking Bad',
        parentIndex: 2,
        itemIndex: 2,
        fileSize: size,
      });
    }

    const app = await buildApp(ownerUser());
    const body = await requestDuplicates(app, [serverA.id, serverB.id]);

    expect(body.summary.totalGroups).toBe(1);
    expect(body.duplicates[0]!.items).toHaveLength(2);
  });

  it('hydrates the show, season and episode numbers for episode duplicates', async () => {
    const server = await createTestServer();
    const tvdb = Math.floor(Date.now() / 1000) + 1;
    for (const size of [100, 60]) {
      await createTestLibraryItem({
        serverId: server.id,
        title: 'Grilled',
        mediaType: 'episode',
        year: null,
        tvdbId: tvdb,
        grandparentTitle: 'Breaking Bad',
        parentIndex: 2,
        itemIndex: 2,
        fileSize: size,
      });
    }

    const app = await buildApp(ownerUser());
    const body = await requestDuplicates(app, [server.id]);

    expect(body.summary.totalGroups).toBe(1);
    const item = body.duplicates[0]!.items[0]!;
    expect(item.grandparentTitle).toBe('Breaking Bad');
    expect(item.seasonNumber).toBe(2);
    expect(item.episodeNumber).toBe(2);
  });

  it('never fuzzy-matches same-titled episodes of different shows', async () => {
    const server = await createTestServer();
    const pilot = (show: string, fileSize: number) =>
      createTestLibraryItem({
        serverId: server.id,
        title: 'Pilot',
        mediaType: 'episode',
        year: 2015,
        grandparentTitle: show,
        parentIndex: 1,
        itemIndex: 1,
        fileSize,
      });
    await pilot('Powers', 101);
    await pilot('Powerless', 99);
    await pilot('Powers', 98);

    const app = await buildApp(ownerUser());
    const body = await requestDuplicates(app, [server.id], '&minConfidence=60', true);

    expect(body.summary.totalGroups).toBe(1);
    expect(body.duplicates[0]?.matchType).toBe('fuzzy');
    expect(body.duplicates[0]?.items).toHaveLength(2);
  });

  it('groups tagged tracks by MusicBrainz id, never by a shared title', async () => {
    const serverA = await createTestServer();
    const serverB = await createTestServer();
    const mbid = randomUUID();
    const [row] = await db
      .insert(media)
      .values({ mediaType: 'track', matchKey: `track:mbid:${mbid}`, title: 'Girls & Boys' })
      .returning({ id: media.id });
    for (const [serverId, fileSize] of [
      [serverA.id, 38_000_000],
      [serverB.id, 9_000_000],
    ] as const) {
      await createTestLibraryItem({
        serverId,
        title: 'Girls & Boys',
        mediaType: 'track',
        year: null,
        grandparentTitle: 'Blur',
        parentTitle: 'Parklife',
        itemIndex: 1,
        mediaId: row!.id,
        fileSize,
      });
    }
    // The same song on a compilation, untagged: not a copy of the album track
    await createTestLibraryItem({
      serverId: serverA.id,
      title: 'Girls & Boys',
      mediaType: 'track',
      year: null,
      grandparentTitle: 'Blur',
      parentTitle: 'Blur: The Best Of',
      itemIndex: 1,
      fileSize: 8_000_000,
    });

    const app = await buildApp(ownerUser());
    const body = await requestDuplicates(app, [serverA.id, serverB.id], '&minConfidence=60', true);

    expect(body.summary.totalGroups).toBe(1);
    const group = body.duplicates[0]!;
    expect(group.matchType).toBe('mbid');
    expect(group.confidence).toBe(100);
    expect(group.items.map((item) => item.parentTitle)).toEqual(['Parklife', 'Parklife']);
    expect(body.summary.byMatchType.mbid).toBe(1);
  });

  it('fuzzy-matches untagged tracks within one artist, album edition and track number', async () => {
    const server = await createTestServer();
    const track = (artist: string, album: string, itemIndex: number, fileSize: number) =>
      createTestLibraryItem({
        serverId: server.id,
        title: 'Intro',
        mediaType: 'track',
        year: null,
        grandparentTitle: artist,
        parentTitle: album,
        itemIndex,
        fileSize,
      });
    await track('Blur', 'Parklife', 1, 101);
    await track('Blur', 'Parklife (Deluxe Edition)', 1, 99);
    await track('Blur', 'Leisure', 1, 98);
    await track('Blur', 'Parklife', 2, 97);
    await track('Oasis', 'Parklife', 1, 96);
    await track('Oasis', 'Be Here Now', 1, 50);
    await track('Oasis', 'Be Here Now', 1, 40);

    const app = await buildApp(ownerUser());
    const body = await requestDuplicates(app, [server.id], '&minConfidence=60', true);

    // Two pairs titled Intro by different artists stay two groups
    expect(body.summary.totalGroups).toBe(2);
    const albums = body.duplicates.map((group) =>
      group.items.map((item) => `${item.grandparentTitle}/${item.parentTitle}`).sort()
    );
    expect(albums).toEqual(
      expect.arrayContaining([
        ['Blur/Parklife', 'Blur/Parklife (Deluxe Edition)'],
        ['Oasis/Be Here Now', 'Oasis/Be Here Now'],
      ])
    );
  });

  it('orders by reclaimable bytes and sums the summary over all groups', async () => {
    const server = await createTestServer();
    const seedVersionPair = async (sizes: [number, number]) => {
      const item = await createTestLibraryItem({
        serverId: server.id,
        fileSize: sizes[0] + sizes[1],
        withoutVersion: true,
      });
      for (const fileSize of sizes) {
        await createTestLibraryItemVersion({ libraryItemId: item.id, fileSize });
      }
    };
    await seedVersionPair([600, 599]);
    await seedVersionPair([600, 10]);

    const app = await buildApp(ownerUser());
    const body = await requestDuplicates(app, [server.id]);

    expect(body.summary.totalGroups).toBe(2);
    expect(body.duplicates.map((g) => g.potentialSavingsBytes)).toEqual([599, 10]);
    expect(body.summary.totalPotentialSavingsBytes).toBe(609);
    expect(body.summary.totalDuplicateItems).toBe(2);
  });

  it('keeps the summary when the requested page is past the end', async () => {
    const server = await createTestServer();
    const item = await createTestLibraryItem({
      serverId: server.id,
      fileSize: 300,
      withoutVersion: true,
    });
    await createTestLibraryItemVersion({ libraryItemId: item.id, fileSize: 200 });
    await createTestLibraryItemVersion({ libraryItemId: item.id, fileSize: 100 });

    const app = await buildApp(ownerUser());
    const body = await requestDuplicates(app, [server.id], '&page=5&pageSize=10');

    expect(body.duplicates).toHaveLength(0);
    expect(body.summary.totalGroups).toBe(1);
    expect(body.pagination.total).toBe(1);
  });
});
