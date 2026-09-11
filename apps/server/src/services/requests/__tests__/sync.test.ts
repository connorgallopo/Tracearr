import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    remoteIdsWithStoredTitle: vi.fn(),
  },
  resolution: { resolveRequests: vi.fn() },
}));

vi.mock('../../../db/client.js', () => ({ db: mockDb }));
vi.mock('../store.js', () => store);
vi.mock('../resolution.js', () => resolution);
vi.mock('../serverLookup.js', () => ({
  serverTypeById: vi.fn(async () => 'plex'),
}));

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
  extra: Partial<Record<'movie' | 'tv', (tmdbId: number) => Promise<SeerrTitleLookup>>> = {}
): SeerrClientLike {
  return {
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
    movie: extra.movie ?? vi.fn(async () => ({ title: 'Looked Up', year: 2024 })),
    tv: extra.tv ?? vi.fn(async () => ({ title: 'Looked Up TV', year: 2020 })),
  };
}

describe('runRequestSync', () => {
  let upserts: unknown[];
  beforeEach(() => {
    vi.clearAllMocks();
    upserts = [];
    store.readApiKey.mockReturnValue({ ok: true, apiKey: 'k' });
    store.remoteIdsWithStoredTitle.mockResolvedValue(new Set());
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
      new Map([[1, { mediaId: 'm-1', serverUserId: null, title: 'Local Title', year: 2019 }]])
    );
    const movie = vi.fn(async () => ({ title: 'Remote Title', year: 2024 }));
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
    const movie = vi.fn(async () => ({ title: 'Remote Title', year: 2024 }));
    const c = client([[request(1, '2026-09-03T00:00:00.000Z')]], { movie });

    await runRequestSync('svc', 'full', { clientFor: () => c });
    expect(movie).toHaveBeenCalledTimes(1);

    store.remoteIdsWithStoredTitle.mockResolvedValue(new Set([1]));
    await runRequestSync('svc', 'full', { clientFor: () => c });
    expect(movie).toHaveBeenCalledTimes(1);
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

  it('skips a disabled service', async () => {
    store.getRequestService.mockResolvedValue(serviceRow({ enabled: false }));
    const c = client([]);
    const result = await runRequestSync('svc', 'incremental', { clientFor: () => c });
    expect(result.skipped).toBe(true);
    expect(c.requestCount).not.toHaveBeenCalled();
  });
});
