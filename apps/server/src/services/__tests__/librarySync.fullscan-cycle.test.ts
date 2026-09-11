import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the periodic full-scan safety net in LibrarySyncService.
 * Time-based: a full scan is forced when the last one is older than
 * FULL_SCAN_MAX_AGE_MS, so event-sync bursts can't drag the cadence forward.
 */

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    selectDistinct: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    // getActiveItemCount's count-mismatch check reads this. Every test here
    // uses totalCount: 100, so match it - otherwise the (correct) bidirectional
    // mismatch check reads a local count of 0 against a server total of 100 and
    // forces a full scan the incremental-path tests don't expect.
    execute: vi.fn().mockResolvedValue({ rows: [{ count: 100 }] }),
  },
}));

vi.mock('../../jobs/heavyOpsLock.js', () => ({
  getHeavyOpsStatus: vi.fn().mockResolvedValue(null),
}));

vi.mock('../mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(),
}));

vi.mock('../../jobs/sessionIdentityBackfill.js', () => ({
  backfillSessionIdentityBatch: vi.fn().mockResolvedValue({ updated: 0, oldest: null }),
}));

vi.mock('../library/mediaResolutionService.js', () => ({
  resolveMediaBatch: vi.fn().mockResolvedValue(new Map()),
  reconcileMediaDuplicates: vi.fn().mockResolvedValue(0),
}));

// Nothing here listens for the media triggers, so the sync builds no announce context.
vi.mock('../automations/events/producers.js', () => ({
  hasMediaListeners: vi.fn().mockResolvedValue(false),
  dispatchMediaAdded: vi.fn(),
  dispatchMediaUpgraded: vi.fn(),
}));

import type { Redis } from 'ioredis';
import { LibrarySyncService, initLibrarySyncRedis } from '../librarySync.js';
import { createMediaServerClient } from '../mediaServer/index.js';
import { db } from '../../db/client.js';

const mockCreateClient = vi.mocked(createMediaServerClient);

function makeMockRedis(): Redis {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string, ..._args: unknown[]) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
  } as unknown as Redis;
}

/**
 * Sets up db.select() to return the mock server on the first call and empty
 * arrays for all subsequent calls (getPreviousItemKeys, snapshot queries, etc).
 */
function setupDbSelectMocks(mockServer: {
  id: string;
  name: string;
  type: 'plex' | 'jellyfin' | 'emby';
  url: string;
  token: string;
}) {
  let callCount = 0;
  vi.mocked(db.select).mockImplementation(() => {
    callCount++;
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        const whereResult = Promise.resolve([]);
        (whereResult as typeof whereResult & { limit: ReturnType<typeof vi.fn> }).limit = vi
          .fn()
          .mockImplementation(() => {
            if (callCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve([]);
          });
        (whereResult as typeof whereResult & { orderBy: ReturnType<typeof vi.fn> }).orderBy = vi
          .fn()
          .mockReturnValue({ limit: vi.fn().mockResolvedValue([]) });
        return whereResult;
      }),
      limit: vi.fn().mockImplementation(() => {
        if (callCount === 1) return Promise.resolve([mockServer]);
        return Promise.resolve([]);
      }),
      orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      returning: vi.fn().mockResolvedValue([]),
    };
    return chain as never;
  });

  // selectDistinct resolves to empty — no orphaned libraries
  vi.mocked((db as any).selectDistinct).mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  }));

  // insert chain for snapshot creation
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: 'snap-1' }]),
    }),
  } as any);

  // delete chain
  vi.mocked(db.delete).mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  } as any);

  // transaction for upsertItems
  vi.mocked(db.transaction).mockImplementation(async (callback: any) => {
    const tx = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    };
    return callback(tx);
  });
}

function makeMockClient(opts: { totalCount?: number; itemsSinceCount?: number } = {}) {
  const totalCount = opts.totalCount ?? 100;
  const itemsSinceCount = opts.itemsSinceCount ?? 0;

  return {
    serverType: 'plex' as const,
    getLibraries: vi.fn().mockResolvedValue([{ id: '1', name: 'Movies', type: 'movie' }]),
    getLibraryItems: vi.fn().mockResolvedValue({ items: [], totalCount }),
    getLibraryItemsSince: vi.fn().mockResolvedValue({
      items: Array.from({ length: itemsSinceCount }, (_, i) => ({
        ratingKey: String(i),
        title: `Item ${i}`,
        mediaType: 'movie',
        addedAt: new Date(),
        updatedAt: new Date(),
        fileSize: 1000000,
      })),
      totalCount: itemsSinceCount,
    }),
    getLibraryLeavesSince: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
    getLibraryLeaves: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
    getSessions: vi.fn(),
    getUsers: vi.fn(),
    testConnection: vi.fn().mockResolvedValue(true),
    terminateSession: vi.fn(),
  };
}

const TEST_SERVER = {
  id: 'srv-1',
  name: 'Test Plex',
  type: 'plex' as const,
  url: 'http://plex:32400',
  token: 'tok',
};

describe('LibrarySyncService full-scan cycle', () => {
  let service: LibrarySyncService;
  let mockRedis: Redis;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new LibrarySyncService();
    mockRedis = makeMockRedis();
    initLibrarySyncRedis(mockRedis);
    setupDbSelectMocks(TEST_SERVER);
  });

  it('uses incremental sync while the last full scan is fresh', async () => {
    const client = makeMockClient({ totalCount: 100, itemsSinceCount: 5 });
    mockCreateClient.mockReturnValue(client);

    // Prior sync state with a recent full scan (1 hour ago)
    await mockRedis.set(
      'tracearr:library:sync:last:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );
    await mockRedis.set('tracearr:library:sync:count:srv-1:1', '100');
    await mockRedis.set('tracearr:library:sync:scanversion:srv-1:1', '1');
    await mockRedis.set(
      'tracearr:library:sync:fullscan:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );

    await service.syncServer('srv-1', undefined, 'scheduled');

    expect(client.getLibraryItemsSince).toHaveBeenCalled();
  });

  it('forces full scan when the last full scan is older than FULL_SCAN_MAX_AGE_MS', async () => {
    const client = makeMockClient({ totalCount: 100 });
    mockCreateClient.mockReturnValue(client);

    await mockRedis.set(
      'tracearr:library:sync:last:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );
    await mockRedis.set('tracearr:library:sync:count:srv-1:1', '100');
    await mockRedis.set('tracearr:library:sync:scanversion:srv-1:1', '1');
    // 85 hours ago, past the 84h max age
    await mockRedis.set(
      'tracearr:library:sync:fullscan:srv-1:1',
      new Date(Date.now() - 85 * 3600000).toISOString()
    );

    await service.syncServer('srv-1', undefined, 'scheduled');

    expect(client.getLibraryItemsSince).not.toHaveBeenCalled();
    expect(client.getLibraryItems).toHaveBeenCalled();
  });

  it('stays incremental when the full-scan timestamp is missing (upgrade path seeds it)', async () => {
    const client = makeMockClient({ totalCount: 100, itemsSinceCount: 5 });
    mockCreateClient.mockReturnValue(client);

    // Pre-upgrade state: sync history exists but no fullscan timestamp
    await mockRedis.set(
      'tracearr:library:sync:last:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );
    await mockRedis.set('tracearr:library:sync:count:srv-1:1', '100');
    await mockRedis.set('tracearr:library:sync:scanversion:srv-1:1', '1');

    await service.syncServer('srv-1', undefined, 'scheduled');

    expect(client.getLibraryItemsSince).toHaveBeenCalled();
    // The save path seeded the clock so the time-based safety net is armed
    const seeded = await mockRedis.get('tracearr:library:sync:fullscan:srv-1:1');
    expect(seeded).toBeTruthy();
    expect(Number.isNaN(new Date(seeded!).getTime())).toBe(false);
  });

  it('always forces full scan for manual triggers', async () => {
    const client = makeMockClient({ totalCount: 100 });
    mockCreateClient.mockReturnValue(client);

    await mockRedis.set(
      'tracearr:library:sync:last:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );
    await mockRedis.set('tracearr:library:sync:count:srv-1:1', '100');
    await mockRedis.set('tracearr:library:sync:scanversion:srv-1:1', '1');
    await mockRedis.set(
      'tracearr:library:sync:fullscan:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );

    await service.syncServer('srv-1', undefined, 'manual');

    expect(client.getLibraryItemsSince).not.toHaveBeenCalled();
  });
});

describe('undercount escalation memory (accepted shortfall)', () => {
  let service: LibrarySyncService;
  let mockRedis: Redis;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new LibrarySyncService();
    mockRedis = makeMockRedis();
    initLibrarySyncRedis(mockRedis);
    setupDbSelectMocks(TEST_SERVER);
  });

  it('escalates once for a structural gap, records the shortfall, then stays incremental on the same gap', async () => {
    const client1 = makeMockClient({ totalCount: 100, itemsSinceCount: 0 });
    mockCreateClient.mockReturnValue(client1);

    await mockRedis.set(
      'tracearr:library:sync:last:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );
    await mockRedis.set('tracearr:library:sync:count:srv-1:1', '100');
    await mockRedis.set('tracearr:library:sync:scanversion:srv-1:1', '1');
    await mockRedis.set(
      'tracearr:library:sync:fullscan:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );

    // Structural gap: local active count sits 5 below the server total, before and after the sync.
    vi.mocked(db.execute).mockResolvedValue({ rows: [{ count: 95 }] } as never);

    await service.syncServer('srv-1', undefined, 'scheduled');

    // No accepted shortfall yet, so the gap (5) exceeds tolerance (3) and escalates to a full scan.
    expect(client1.getLibraryItems).toHaveBeenCalledWith('1', {
      offset: 0,
      limit: 200,
      libraryType: 'movie',
    });

    // Second sync: same structural gap, nothing new - must stay incremental.
    // Re-arm lastSyncedAt outside the drift-check cooldown, as if the
    // scheduled cadence had passed, so the check actually runs.
    setupDbSelectMocks(TEST_SERVER);
    await mockRedis.set(
      'tracearr:library:sync:last:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );
    const client2 = makeMockClient({ totalCount: 100, itemsSinceCount: 0 });
    mockCreateClient.mockReturnValue(client2);

    await service.syncServer('srv-1', undefined, 'scheduled');

    expect(client2.getLibraryItemsSince).toHaveBeenCalled();
    expect(client2.getLibraryItems).not.toHaveBeenCalledWith('1', {
      offset: 0,
      limit: 200,
      libraryType: 'movie',
    });
  });

  it('still escalates when a new wrong tombstone widens the gap beyond the accepted shortfall', async () => {
    const client1 = makeMockClient({ totalCount: 100, itemsSinceCount: 0 });
    mockCreateClient.mockReturnValue(client1);

    await mockRedis.set(
      'tracearr:library:sync:last:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );
    await mockRedis.set('tracearr:library:sync:count:srv-1:1', '100');
    await mockRedis.set('tracearr:library:sync:scanversion:srv-1:1', '1');
    await mockRedis.set(
      'tracearr:library:sync:fullscan:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );

    vi.mocked(db.execute).mockResolvedValue({ rows: [{ count: 95 }] } as never);
    await service.syncServer('srv-1', undefined, 'scheduled');
    expect(client1.getLibraryItems).toHaveBeenCalledWith('1', {
      offset: 0,
      limit: 200,
      libraryType: 'movie',
    });

    // Second sync: a NEW wrong tombstone widens the gap to 10 - beyond the accepted shortfall (5) plus tolerance.
    // Re-arm lastSyncedAt outside the drift-check cooldown so the check runs.
    setupDbSelectMocks(TEST_SERVER);
    await mockRedis.set(
      'tracearr:library:sync:last:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );
    const client2 = makeMockClient({ totalCount: 100, itemsSinceCount: 0 });
    mockCreateClient.mockReturnValue(client2);
    vi.mocked(db.execute).mockResolvedValue({ rows: [{ count: 90 }] } as never);

    await service.syncServer('srv-1', undefined, 'scheduled');

    expect(client2.getLibraryItemsSince).toHaveBeenCalled();
    expect(client2.getLibraryItems).toHaveBeenCalledWith('1', {
      offset: 0,
      limit: 200,
      libraryType: 'movie',
    });
  });

  it('forces a full scan when the stored scan version is behind the current listing query', async () => {
    const client = makeMockClient({ totalCount: 100, itemsSinceCount: 5 });
    mockCreateClient.mockReturnValue(client);

    await mockRedis.set(
      'tracearr:library:sync:last:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );
    await mockRedis.set('tracearr:library:sync:count:srv-1:1', '100');
    await mockRedis.set(
      'tracearr:library:sync:fullscan:srv-1:1',
      new Date(Date.now() - 3600000).toISOString()
    );

    await service.syncServer('srv-1', undefined, 'scheduled');

    expect(client.getLibraryItemsSince).not.toHaveBeenCalled();
    expect(client.getLibraryItems).toHaveBeenCalledWith('1', {
      offset: 0,
      limit: 200,
      libraryType: 'movie',
    });
    expect(await mockRedis.get('tracearr:library:sync:scanversion:srv-1:1')).toBe('1');
  });
});
