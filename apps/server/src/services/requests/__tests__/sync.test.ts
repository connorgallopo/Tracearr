import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeerrRequest, SeerrTitleLookup } from '../seerrClient.js';
import type { SeerrClientLike } from '../sync.js';

const { mockDb, store, resolution } = vi.hoisted(() => ({
  mockDb: { execute: vi.fn(), select: vi.fn(), insert: vi.fn(), update: vi.fn() },
  store: {
    getRequestService: vi.fn(),
    readApiKey: vi.fn(),
    recordSyncResult: vi.fn(),
    markRequestServiceReencrypt: vi.fn(),
    publishRequestsChanged: vi.fn(),
    mirroredRequests: vi.fn(),
  },
  resolution: { resolveRequests: vi.fn() },
}));

vi.mock('../../../db/client.js', () => ({ db: mockDb }));
vi.mock('../store.js', () => store);
vi.mock('../resolution.js', () => resolution);
vi.mock('../serverLookup.js', () => ({
  serverTypeById: vi.fn(async () => 'plex'),
  liveServerConnection: vi.fn(async () => ({ url: 'http://tofa.local:33333', token: 'key' })),
}));

import { TofaClient } from '../../mediaServer/tofa/client.js';
import { fakeTofaRequestSource } from '../../../test/mediaServerFakes.js';
import tofa from '../../../test/mediaServerResponses/tofa.json' with { type: 'json' };
import { PAGE_SIZE, runRequestSync } from '../sync.js';

const counts = {
  total: 1,
  movie: 1,
  tv: 0,
  pending: 0,
  approved: 0,
  declined: 0,
  processing: 0,
  available: 1,
  completed: 1,
};

function request(id: number, updatedAt: string, mediaId = 500 + id): SeerrRequest {
  return {
    id,
    status: 5,
    type: 'movie',
    is4k: false,
    isAutoRequest: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt,
    seasons: [],
    media: {
      id: mediaId,
      mediaType: 'movie',
      tmdbId: 1000 + id,
      tvdbId: null,
      imdbId: null,
      status: 5,
      mediaAddedAt: '2026-09-01T00:10:00.000Z',
      ratingKey: null,
      jellyfinMediaId: null,
    },
    requestedBy: { id: 1, displayName: 'req', plexId: 42, jellyfinUserId: null },
  };
}

function serviceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'svc',
    serverId: 'srv',
    type: 'seerr',
    name: 'S',
    url: 'http://s',
    config: 'enc',
    configStatus: 'ok',
    enabled: true,
    takesRequests: true,
    remoteServerId: 'abc',
    version: null,
    syncCursor: null,
    lastCounts: null,
    lastSyncAt: null,
    lastFullSyncAt: null,
    lastSyncError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function client(
  pages: SeerrRequest[][],
  extra: Partial<Pick<SeerrClientLike, 'movie' | 'tv' | 'mainSettings'>> = {}
): SeerrClientLike {
  return {
    status: vi.fn(async () => ({ version: '3.5.0' })),
    mainSettings: extra.mainSettings ?? vi.fn(async () => ({ cacheImages: false })),
    requestCount: vi.fn(async () => counts),
    requestsPage: vi.fn(async (skip: number, take: number) => {
      const index = skip / take;
      const results = pages[index] ?? [];
      return {
        pageInfo: {
          page: index + 1,
          pages: pages.length,
          results: pages.flat().length,
          pageSize: take,
        },
        results,
      };
    }),
    movie:
      extra.movie ??
      vi.fn(async (): Promise<SeerrTitleLookup> => ({
        title: 'Looked Up',
        year: 2024,
        posterPath: null,
      })),
    tv:
      extra.tv ??
      vi.fn(async (): Promise<SeerrTitleLookup> => ({
        title: 'Looked Up TV',
        year: 2020,
        posterPath: null,
      })),
  };
}

describe('runRequestSync', () => {
  let upserts: unknown[];
  beforeEach(() => {
    vi.clearAllMocks();
    upserts = [];
    store.readApiKey.mockReturnValue({ ok: true, apiKey: 'k' });
    store.mirroredRequests.mockResolvedValue(new Map());
    resolution.resolveRequests.mockResolvedValue(new Map());
    mockDb.execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
      upserts.push(query);
      return { rows: [] };
    });
  });

  it('does nothing when the counts match the last run', async () => {
    store.getRequestService.mockResolvedValue(serviceRow({ lastCounts: counts }));
    const c = client([[request(1, '2026-09-02T00:00:00.000Z')]]);
    const result = await runRequestSync('svc', 'incremental', { clientFor: () => c });
    expect(result.skipped).toBe(true);
    expect(c.requestsPage).not.toHaveBeenCalled();
    expect(store.recordSyncResult).toHaveBeenCalledWith(
      'svc',
      expect.objectContaining({ lastSyncError: null })
    );
  });

  it('stops paging at the cursor minus five minutes and advances the cursor', async () => {
    store.getRequestService.mockResolvedValue(
      serviceRow({ syncCursor: new Date('2026-09-02T00:00:00.000Z') })
    );
    const c = client([
      [request(3, '2026-09-03T00:00:00.000Z'), request(2, '2026-09-01T23:56:00.000Z')],
      [request(1, '2026-08-01T00:00:00.000Z')],
    ]);
    const result = await runRequestSync('svc', 'incremental', { clientFor: () => c });
    expect(c.requestsPage).toHaveBeenCalledTimes(1);
    expect(result.upserted).toBe(2);
    expect(store.recordSyncResult).toHaveBeenCalledWith(
      'svc',
      expect.objectContaining({
        syncCursor: new Date('2026-09-03T00:00:00.000Z'),
        lastCounts: counts,
        lastSyncError: null,
      })
    );
    expect(store.publishRequestsChanged).toHaveBeenCalledWith('svc');
  });

  it('full mode walks every page and marks missing rows deleted without hard deletes', async () => {
    store.getRequestService.mockResolvedValue(serviceRow());
    // A full-size first page mirrors the real API's contract: a page shorter than
    // requested means no more data, so the fixture must fill it to prove paging
    // continues past a genuinely full page.
    const page0 = Array.from({ length: PAGE_SIZE }, (_, i) =>
      request(i + 1, '2026-09-03T00:00:00.000Z')
    );
    const page1 = [request(PAGE_SIZE + 1, '2026-09-02T00:00:00.000Z')];
    const c = client([page0, page1]);
    const result = await runRequestSync('svc', 'full', { clientFor: () => c });
    expect(c.requestsPage).toHaveBeenCalledTimes(2);
    expect(result.upserted).toBe(PAGE_SIZE + 1);
    const sqlText = upserts.map((q) => JSON.stringify(q)).join('\n');
    expect(sqlText).toContain('deleted_at');
    expect(sqlText.toLowerCase()).not.toContain('delete from');
    expect(store.recordSyncResult).toHaveBeenCalledWith(
      'svc',
      expect.objectContaining({ lastFullSyncAt: expect.any(Date) })
    );
  });

  it('keeps a landed request landed when a later sync reports it approved without a landing time', async () => {
    store.getRequestService.mockResolvedValue(serviceRow());
    const c = client([[request(1, '2026-09-03T00:00:00.000Z')]]);
    await runRequestSync('svc', 'full', { clientFor: () => c });
    const sqlText = upserts.map((q) => JSON.stringify(q)).join('\n');
    expect(sqlText).toContain(
      "WHEN EXCLUDED.status = 'approved' AND media_requests.available_at IS NOT NULL THEN 'completed'"
    );
    expect(sqlText).toContain('COALESCE(EXCLUDED.available_at, media_requests.available_at)');
  });

  it('does not soft-delete every request when a full sync fetches zero rows but the service still reports requests', async () => {
    store.getRequestService.mockResolvedValue(serviceRow());
    const c = client([]);
    const result = await runRequestSync('svc', 'full', { clientFor: () => c });
    expect(result.markedDeleted).toBe(0);
    const sqlText = upserts.map((q) => JSON.stringify(q)).join('\n');
    expect(sqlText.toLowerCase()).not.toContain('deleted_at');
  });

  it('does not soft-delete when the full walk returns fewer rows than the service counts', async () => {
    store.getRequestService.mockResolvedValue(serviceRow());
    const c = client([
      [request(1, '2026-09-03T00:00:00.000Z'), request(2, '2026-09-03T00:00:00.000Z')],
    ]);
    c.requestCount = vi.fn(async () => ({ ...counts, total: 3 }));

    const result = await runRequestSync('svc', 'full', { clientFor: () => c });

    expect(result.upserted).toBe(2);
    expect(result.markedDeleted).toBe(0);
    const sqlText = upserts.map((q) => JSON.stringify(q)).join('\n');
    expect(sqlText).not.toContain('UPDATE media_requests');
  });

  it('takes titles from matched media and looks up only unresolved rows', async () => {
    store.getRequestService.mockResolvedValue(serviceRow());
    resolution.resolveRequests.mockResolvedValue(
      new Map([['1', { mediaId: 'm-1', serverUserId: null, title: 'Local Title', year: 2019 }]])
    );
    const movie = vi.fn(async () => ({ title: 'Remote Title', year: 2024, posterPath: null }));
    const c = client(
      [[request(1, '2026-09-03T00:00:00.000Z'), request(2, '2026-09-03T00:00:00.000Z')]],
      { movie }
    );
    await runRequestSync('svc', 'full', { clientFor: () => c });
    expect(movie).toHaveBeenCalledTimes(1);
    expect(movie).toHaveBeenCalledWith(1002);
  });

  it('leaves the title lookups alone on a second run over rows that already stored one', async () => {
    store.getRequestService.mockResolvedValue(serviceRow());
    const movie = vi.fn(async () => ({ title: 'Remote Title', year: 2024, posterPath: null }));
    const c = client([[request(1, '2026-09-03T00:00:00.000Z')]], { movie });

    await runRequestSync('svc', 'full', { clientFor: () => c });
    expect(movie).toHaveBeenCalledTimes(1);

    store.mirroredRequests.mockResolvedValue(new Map([['1', { titled: true, postered: false }]]));
    await runRequestSync('svc', 'full', { clientFor: () => c });
    expect(movie).toHaveBeenCalledTimes(1);
  });

  it("stores Seerr's image cache path for a request in no library while Seerr caches images", async () => {
    store.getRequestService.mockResolvedValue(serviceRow());
    const c = client([[request(1, '2026-09-03T00:00:00.000Z')]], {
      mainSettings: vi.fn(async () => ({ cacheImages: true })),
      movie: vi.fn(async () => ({ title: 'Remote Title', year: 2024, posterPath: '/abc.jpg' })),
    });

    await runRequestSync('svc', 'full', { clientFor: () => c });

    const sqlText = upserts.map((q) => JSON.stringify(q)).join('\n');
    expect(sqlText).toContain('"/imageproxy/tmdb/t/p/w600_and_h900_bestv2/abc.jpg"');
  });

  it('stores no poster while Seerr does not cache images', async () => {
    store.getRequestService.mockResolvedValue(serviceRow());
    const c = client([[request(1, '2026-09-03T00:00:00.000Z')]], {
      movie: vi.fn(async () => ({ title: 'Remote Title', year: 2024, posterPath: '/abc.jpg' })),
    });

    await runRequestSync('svc', 'full', { clientFor: () => c });

    const sqlText = upserts.map((q) => JSON.stringify(q)).join('\n');
    expect(sqlText).not.toContain('abc.jpg');
  });

  it('drops the stored posters once Seerr stops caching images', async () => {
    store.getRequestService.mockResolvedValue(serviceRow());
    store.mirroredRequests.mockResolvedValue(new Map([['1', { titled: true, postered: true }]]));
    const c = client([[request(1, '2026-09-03T00:00:00.000Z')]]);

    await runRequestSync('svc', 'full', { clientFor: () => c });

    const sqlText = upserts.map((q) => JSON.stringify(q)).join('\n');
    expect(sqlText).toContain('UPDATE media_requests SET poster_path = NULL');
  });

  it('marks the service for re-entry when the key no longer decrypts', async () => {
    store.getRequestService.mockResolvedValue(serviceRow());
    store.readApiKey.mockReturnValue({ ok: false });
    const c = client([]);
    const result = await runRequestSync('svc', 'incremental', { clientFor: () => c });
    expect(result.skipped).toBe(true);
    expect(store.markRequestServiceReencrypt).toHaveBeenCalledWith('svc');
    expect(store.recordSyncResult).toHaveBeenCalledWith(
      'svc',
      expect.objectContaining({ lastSyncError: expect.any(String) })
    );
  });

  it('refreshes the stored version even when the counts match', async () => {
    store.getRequestService.mockResolvedValue(serviceRow({ lastCounts: counts, version: '3.4.1' }));
    const c = client([]);
    await runRequestSync('svc', 'incremental', { clientFor: () => c });
    expect(store.recordSyncResult).toHaveBeenCalledWith(
      'svc',
      expect.objectContaining({ version: '3.5.0' })
    );
  });

  it('skips a disabled service', async () => {
    store.getRequestService.mockResolvedValue(serviceRow({ enabled: false }));
    const c = client([]);
    const result = await runRequestSync('svc', 'incremental', { clientFor: () => c });
    expect(result.skipped).toBe(true);
    expect(c.requestCount).not.toHaveBeenCalled();
  });
});

describe('runRequestSync for tofa', () => {
  let statements: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    statements = [];
    resolution.resolveRequests.mockResolvedValue(new Map());
    store.mirroredRequests.mockResolvedValue(new Map());
    mockDb.execute.mockImplementation(async (query: unknown) => {
      statements.push(JSON.stringify(query));
      return { rows: [], rowCount: 0 };
    });
    store.getRequestService.mockResolvedValue(
      serviceRow({ type: 'tofa', url: 'http://tofa.local:33333', config: null })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists every request on each scheduled run, so a status change lands without a socket frame', async () => {
    const [waiting] = tofa.requests;
    if (!waiting) throw new Error('fixture has no requests');
    const source = fakeTofaRequestSource({ getRequests: vi.fn(async () => [waiting]) });
    await runRequestSync('svc', 'incremental', { tofaClientFor: () => source });

    source.getRequests = vi.fn(async () => [{ ...waiting, status: 'available' }]);
    statements = [];
    const result = await runRequestSync('svc', 'incremental', { tofaClientFor: () => source });

    expect(result).toEqual({ skipped: false, upserted: 1, markedDeleted: 0 });
    const upsert = statements.find((q) => q.includes('INSERT INTO media_requests'));
    expect(upsert).toContain('"completed"');
    expect(statements.some((q) => q.includes('UPDATE media_requests SET deleted_at'))).toBe(true);
  });

  it('asks tofa for the poster of a request in no library and stores its image cache path', async () => {
    const [show, inLibrary] = tofa.requests;
    if (!show || !inLibrary) throw new Error('fixture has too few requests');
    resolution.resolveRequests.mockResolvedValue(
      new Map([[inLibrary.id, { mediaId: 'm-1', serverUserId: null, title: 'T', year: 2020 }]])
    );
    const source = fakeTofaRequestSource({
      getRequests: vi.fn(async () => [show, inLibrary]),
      getRequestPosterPath: vi.fn(async () => '/cache/images/posters/abc.jpg'),
    });

    await runRequestSync('svc', 'incremental', { tofaClientFor: () => source });

    expect(source.getRequestPosterPath).toHaveBeenCalledTimes(1);
    expect(source.getRequestPosterPath).toHaveBeenCalledWith('tv', show.tmdb_id);
    const upsert = statements.find((q) => q.includes('INSERT INTO media_requests'));
    expect(upsert).toContain('"/cache/images/posters/abc.jpg"');
  });

  it('asks again for a missing poster only on a full run', async () => {
    const [waiting] = tofa.requests;
    if (!waiting) throw new Error('fixture has no requests');
    store.mirroredRequests.mockResolvedValue(
      new Map([[waiting.id, { titled: true, postered: false }]])
    );
    const source = fakeTofaRequestSource({ getRequests: vi.fn(async () => [waiting]) });

    await runRequestSync('svc', 'incremental', { tofaClientFor: () => source });
    expect(source.getRequestPosterPath).not.toHaveBeenCalled();

    await runRequestSync('svc', 'full', { tofaClientFor: () => source });
    expect(source.getRequestPosterPath).toHaveBeenCalledTimes(1);
  });

  it('reports requests turned off and leaves the mirror alone', async () => {
    const source = fakeTofaRequestSource({
      systemInfo: vi.fn(async () => ({ ...tofa.systemInfo, requests_available: false })),
    });

    const result = await runRequestSync('svc', 'full', { tofaClientFor: () => source });

    expect(result.skipped).toBe(true);
    expect(source.getRequests).not.toHaveBeenCalled();
    expect(statements).toEqual([]);
    expect(store.recordSyncResult).toHaveBeenCalledWith(
      'svc',
      expect.objectContaining({ lastSyncError: 'Requests are turned off on this tofa server' })
    );
  });

  it('records whether tofa takes requests, and tells the web when that changes', async () => {
    const off = fakeTofaRequestSource({
      systemInfo: vi.fn(async () => ({ ...tofa.systemInfo, requests_available: false })),
    });
    await runRequestSync('svc', 'full', { tofaClientFor: () => off });

    expect(store.recordSyncResult).toHaveBeenLastCalledWith(
      'svc',
      expect.objectContaining({ takesRequests: false })
    );
    expect(store.publishRequestsChanged).toHaveBeenCalledTimes(1);

    store.getRequestService.mockResolvedValue(
      serviceRow({
        type: 'tofa',
        url: 'http://tofa.local:33333',
        config: null,
        takesRequests: false,
      })
    );
    const on = fakeTofaRequestSource({ getRequests: vi.fn(async () => []) });
    await runRequestSync('svc', 'full', { tofaClientFor: () => on });

    expect(store.recordSyncResult).toHaveBeenLastCalledWith(
      'svc',
      expect.objectContaining({ takesRequests: true })
    );
    expect(store.publishRequestsChanged).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an error status', async () => new Response('', { status: 502 })],
    [
      'a timeout',
      async (): Promise<Response> => {
        throw new DOMException('The operation timed out', 'TimeoutError');
      },
    ],
    ['a body that is not JSON', async () => new Response('<html>', { status: 200 })],
    ['a body without the list', async () => Response.json({})],
  ])('leaves the mirror untouched when listing the requests fails with %s', async (_, listing) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/system/info') ? Response.json(tofa.systemInfo) : listing()
      )
    );

    await expect(
      runRequestSync('svc', 'incremental', { tofaClientFor: (server) => new TofaClient(server) })
    ).rejects.toThrow();

    expect(statements).toEqual([]);
    expect(store.recordSyncResult).toHaveBeenCalledWith('svc', {
      lastSyncError: expect.any(String),
    });
  });
});
