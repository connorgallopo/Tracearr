/**
 * Library duplicates route tests
 *
 * db.execute is mocked (this suite's convention, see catalog.routes.test.ts).
 * Grouping, the distinct-file gate, and the storage math live in SQL now, so
 * duplicatesGrouping.integration.test.ts proves those against a real
 * database; this suite covers what remains in Node - page assembly, mirror
 * flag attachment, the past-the-end summary fallback, and caching.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, DuplicatesResponse } from '@tracearr/shared';

vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
  },
}));

import { db } from '../../../db/client.js';
import { libraryDuplicatesRoute } from '../duplicates.js';
import { permissionGuard } from '../../../lib/scope.js';

function createSpyRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _seconds: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
  };
}

async function buildTestApp(
  authUser: AuthUser,
  redis: ReturnType<typeof createSpyRedis>
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('redis', redis as never);
  await app.register(libraryDuplicatesRoute, { prefix: '/library' });
  return app;
}

function createOwnerUser(): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
}

const SERVER_A = randomUUID();

interface GroupRowInput {
  groupKey: string;
  matchType?: string;
  itemIds: string[];
  serverCount?: number;
  uniqueFileCount?: number;
  totalBytes?: number;
  savingsBytes?: number;
  totalGroups?: number;
  totalSavings?: number;
}

/** Row shape produced by the route's single group query (summary via window aggregates) */
function groupRow(input: GroupRowInput) {
  return {
    group_key: input.groupKey,
    match_type: input.matchType ?? 'imdb',
    confidence: 100,
    item_ids: input.itemIds,
    item_count: input.itemIds.length,
    server_count: input.serverCount ?? 1,
    unique_file_count: input.uniqueFileCount ?? 2,
    total_bytes: String(input.totalBytes ?? 160),
    savings_bytes: String(input.savingsBytes ?? 60),
    total_groups: input.totalGroups ?? 1,
    total_duplicate_items: input.itemIds.length,
    total_savings_bytes: String(input.totalSavings ?? input.savingsBytes ?? 60),
    imdb_groups: 1,
    tmdb_groups: 0,
    tvdb_groups: 0,
    fuzzy_groups: 0,
    version_groups: 0,
  };
}

function itemRow(
  id: string,
  fileSize: number | null = 160,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    server_id: SERVER_A,
    server_name: 'Server',
    library_id: 'lib-1',
    library_name: 'Movies',
    title: 'Some Movie',
    year: 2023,
    media_type: 'movie',
    grandparent_title: null,
    parent_index: null,
    item_index: null,
    file_size: fileSize != null ? String(fileSize) : null,
    video_resolution: '4k',
    ...overrides,
  };
}

function versionRow(itemId: string, fileSize: number, resolution = '4k', path = '/a.mkv') {
  return {
    library_item_id: itemId,
    video_resolution: resolution,
    video_codec: 'hevc',
    file_size: String(fileSize),
    file_path: path,
  };
}

/** Queue the route's db.execute calls: group query, then details when rows exist */
function mockQueries(opts: { groups?: unknown[]; items?: unknown[]; versions?: unknown[] }) {
  const execute = vi.mocked(db.execute);
  execute.mockResolvedValueOnce({ rows: opts.groups ?? [] } as never);
  if ((opts.groups?.length ?? 0) > 0) {
    execute.mockResolvedValueOnce({ rows: opts.items ?? [] } as never);
    execute.mockResolvedValueOnce({ rows: opts.versions ?? [] } as never);
  }
}

async function requestDuplicates(
  app: FastifyInstance,
  extra = '',
  includeFuzzy = false
): Promise<DuplicatesResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/library/duplicates?includeFuzzy=${includeFuzzy}${extra}`,
  });
  expect(response.statusCode).toBe(200);
  return response.json<DuplicatesResponse>();
}

describe('GET /library/duplicates', () => {
  let app: FastifyInstance;
  let redis: ReturnType<typeof createSpyRedis>;

  beforeEach(async () => {
    vi.clearAllMocks();
    redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
  });

  it('assembles page groups and flags mirrored listings (issue #958 shape)', async () => {
    const itemX = randomUUID();
    const itemY = randomUUID();
    mockQueries({
      groups: [
        groupRow({
          groupKey: 'imdb:movie:tt0000001',
          itemIds: [itemX, itemY],
          uniqueFileCount: 2,
          totalBytes: 160,
          savingsBytes: 60,
        }),
      ],
      items: [itemRow(itemX), itemRow(itemY)],
      versions: [
        versionRow(itemX, 100, '4k', '/movies/a-4k.mkv'),
        versionRow(itemX, 60, '1080p', '/movies/a-1080.mkv'),
        versionRow(itemY, 100, '4k', '/movies4k/a-4k.mkv'),
        versionRow(itemY, 60, '1080p', '/movies4k/a-1080.mkv'),
      ],
    });

    const body = await requestDuplicates(app);

    expect(body.summary.totalGroups).toBe(1);
    expect(body.summary.totalPotentialSavingsBytes).toBe(60);
    const group = body.duplicates[0]!;
    expect(group.matchKey).toBe('imdb:movie:tt0000001');
    // Group math comes from the SQL row, not recomputed in Node
    expect(group.uniqueFileCount).toBe(2);
    expect(group.totalStorageBytes).toBe(160);
    expect(group.potentialSavingsBytes).toBe(60);
    // Every file still listed; the second listing of each physical file is a mirror
    const allVersions = group.items.flatMap((item) => item.versions);
    expect(allVersions).toHaveLength(4);
    expect(allVersions.filter((v) => v.isMirror)).toHaveLength(2);
    expect(allVersions.filter((v) => !v.isMirror)).toHaveLength(2);
  });

  it('carries the show and its season and episode numbers for an episode', async () => {
    const itemX = randomUUID();
    const itemY = randomUUID();
    const episode = {
      title: 'Grilled',
      media_type: 'episode',
      year: null,
      grandparent_title: 'Breaking Bad',
      parent_index: 2,
      item_index: 2,
    };
    mockQueries({
      groups: [
        groupRow({
          groupKey: 'tvdb:episode:349232',
          itemIds: [itemX, itemY],
          uniqueFileCount: 2,
          totalBytes: 160,
          savingsBytes: 60,
        }),
      ],
      items: [itemRow(itemX, 100, episode), itemRow(itemY, 60, episode)],
      versions: [versionRow(itemX, 100), versionRow(itemY, 60)],
    });

    const body = await requestDuplicates(app);

    const item = body.duplicates[0]!.items[0]!;
    expect(item.mediaType).toBe('episode');
    expect(item.title).toBe('Grilled');
    expect(item.grandparentTitle).toBe('Breaking Bad');
    expect(item.seasonNumber).toBe(2);
    expect(item.episodeNumber).toBe(2);
  });

  it('returns an honest zero when the gate leaves nothing', async () => {
    mockQueries({ groups: [] });

    const body = await requestDuplicates(app);

    expect(body.summary.totalGroups).toBe(0);
    expect(body.summary.totalPotentialSavingsBytes).toBe(0);
    expect(body.duplicates).toHaveLength(0);
    // No detail queries when there is no page to hydrate
    expect(vi.mocked(db.execute)).toHaveBeenCalledTimes(1);
  });

  it('uses show identity when fuzzy matching episodes with the same episode title', async () => {
    mockQueries({ groups: [] });

    await requestDuplicates(app, '', true);

    const query = vi.mocked(db.execute).mock.calls[0]?.[0] as SQL;
    const { sql: queryText } = new PgDialect().sqlToQuery(query);
    expect(queryText).toContain("a.grandparent_title || ' ' || a.title");
    expect(queryText).toContain('similarity(a.grandparent_title, b.grandparent_title) >= 0.6');
  });

  it('refetches the summary when the requested page is past the end', async () => {
    const execute = vi.mocked(db.execute);
    // Page 3 query: empty. Fallback page-1 query: one group carrying the summary.
    execute.mockResolvedValueOnce({ rows: [] } as never);
    execute.mockResolvedValueOnce({
      rows: [
        groupRow({
          groupKey: 'imdb:movie:tt0000009',
          itemIds: [randomUUID()],
          totalGroups: 4,
          totalSavings: 999,
        }),
      ],
    } as never);

    const body = await requestDuplicates(app, '&page=3&pageSize=10');

    expect(body.duplicates).toHaveLength(0);
    expect(body.summary.totalGroups).toBe(4);
    expect(body.summary.totalPotentialSavingsBytes).toBe(999);
    expect(body.pagination).toEqual({ page: 3, pageSize: 10, total: 4 });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('serves the cached response without touching the database', async () => {
    mockQueries({ groups: [] });
    await requestDuplicates(app);
    expect(vi.mocked(db.execute)).toHaveBeenCalledTimes(1);

    const again = await requestDuplicates(app);
    expect(again.summary.totalGroups).toBe(0);
    expect(vi.mocked(db.execute)).toHaveBeenCalledTimes(1);
  });
});
