/**
 * Library Sync Service Tests
 *
 * Tests for the LibrarySyncService that orchestrates library synchronization:
 * - Fetching items from media servers
 * - Upserting items to database
 * - Delta detection (additions/removals)
 * - Snapshot creation with quality statistics
 * - Progress reporting
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type * as TimescaleModule from '../../db/timescale.js';
import type { SQL } from 'drizzle-orm';

// Mock the database
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    selectDistinct: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

// Mock the media server client factory
vi.mock('../mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(),
}));

vi.mock('../library/mediaResolutionService.js', () => ({
  resolveMediaBatch: vi.fn().mockResolvedValue(new Map()),
  reconcileMediaDuplicates: vi.fn().mockResolvedValue(0),
}));

const mockHasMediaListeners = vi.fn().mockResolvedValue(false);
const mockDispatchMediaAdded = vi.fn();
const mockDispatchMediaUpgraded = vi.fn();
vi.mock('../automations/events/producers.js', () => ({
  hasMediaListeners: (...args: unknown[]) => mockHasMediaListeners(...args),
  dispatchMediaAdded: (...args: unknown[]) => mockDispatchMediaAdded(...args),
  dispatchMediaUpgraded: (...args: unknown[]) => mockDispatchMediaUpgraded(...args),
}));

vi.mock('../../jobs/sessionIdentityBackfill.js', () => ({
  backfillSessionIdentityBatch: vi.fn().mockResolvedValue({ updated: 0, oldest: null }),
  hasStampableSessionsBefore: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../jobs/maintenanceQueue.js', () => ({
  maybeEnqueueMaintenanceJob: vi.fn().mockResolvedValue(null),
}));

// Only the compression-horizon probe is stubbed; the aggregate refresh paths stay
// real so the db.execute assertions below still measure refresh behavior rather
// than this one extra catalog read at the tail of every sync.
vi.mock('../../db/timescale.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TimescaleModule>()),
  getSessionsCompressionHorizon: vi.fn().mockResolvedValue(null),
}));

// Import after mocking
import { db } from '../../db/client.js';
import { renderSql } from '../../test/helpers.js';
import { libraries as librariesTable } from '../../db/schema.js';
import { createMediaServerClient } from '../mediaServer/index.js';
import { reconcileMediaDuplicates, resolveMediaBatch } from '../library/mediaResolutionService.js';
import {
  backfillSessionIdentityBatch,
  hasStampableSessionsBefore,
} from '../../jobs/sessionIdentityBackfill.js';
import { maybeEnqueueMaintenanceJob } from '../../jobs/maintenanceQueue.js';
import { getSessionsCompressionHorizon } from '../../db/timescale.js';
import {
  LibrarySyncService,
  initLibrarySyncRedis,
  _resetAutoBackfillThrottleForTests,
  _resetReconcileThrottleForTests,
} from '../librarySync.js';
import { MEDIA_BUFFER_CAP, flushMediaAnnounceRun } from '../library/mediaAnnounce.js';
import type { MediaLibraryItem } from '../mediaServer/types.js';
import type { LibrarySyncProgress } from '@tracearr/shared';
import type { Redis } from 'ioredis';

// ============================================================================
// Test Data Factories
// ============================================================================

function createMockServer(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    name: 'Test Server',
    type: 'plex' as const,
    url: 'http://localhost:32400',
    token: 'test-token',
    ...overrides,
  };
}

function createMockLibrary(overrides: Record<string, unknown> = {}) {
  return {
    id: '1',
    name: 'Movies',
    type: 'movie',
    ...overrides,
  };
}

function createMockLibraryItem(overrides: Partial<MediaLibraryItem> = {}): MediaLibraryItem {
  return {
    ratingKey: randomUUID(),
    title: 'Test Movie',
    mediaType: 'movie',
    year: 2024,
    addedAt: new Date(),
    videoResolution: '1080p',
    videoCodec: 'h264',
    audioCodec: 'aac',
    fileSize: 5000000000,
    ...overrides,
  };
}

function createMockDbItem(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    serverId: randomUUID(),
    libraryId: '1',
    ratingKey: 'rating-key-123',
    title: 'Test Movie',
    mediaType: 'movie',
    year: 2024,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    videoResolution: '1080p',
    videoCodec: 'h264',
    audioCodec: 'aac',
    fileSize: 5000000000,
    filePath: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ============================================================================
// Mock Helpers
// ============================================================================

function mockSelectChain(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
    returning: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

/** One row as the item upsert returns it: already 4K, and larger than the copy it replaced. */
function changedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'library-item-1',
    ratingKey: 'rk-1',
    mediaId: null,
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    title: 'Cars',
    grandparentTitle: null,
    parentTitle: null,
    grandparentRatingKey: null,
    parentRatingKey: null,
    parentIndex: null,
    itemIndex: null,
    mediaType: 'movie',
    year: 2006,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    thumbPath: null,
    resolution: '4k',
    dynamicRange: null,
    videoCodec: 'H264',
    audioCodec: 'AC3',
    audioChannels: 6,
    fileSize: 9_000_000_000,
    ...overrides,
  };
}

/** A buffered change, only ever counted, so its contents do not matter. */
function fakeCollected() {
  return {
    change: { kind: 'added' as const, row: changedRow() as never },
    libraryId: '1',
    libraryName: 'Movies',
  };
}

/** The announce path's prior read ends at .where(), with no limit. */
function mockPriorQuality(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  } as never);
}

function mockInsertChain(result: unknown[] = []) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.insert).mockReturnValue(chain as never);
  return chain;
}

function mockDeleteChain(returningRows: unknown[] = []) {
  // Awaitable directly AND chains .returning() - cleanupOrphanedLibraries uses .returning() to count removed rows.
  const whereResult = Object.assign(Promise.resolve(undefined), {
    returning: vi.fn().mockResolvedValue(returningRows),
  });
  const chain = {
    where: vi.fn().mockReturnValue(whereResult),
  };
  vi.mocked(db.delete).mockReturnValue(chain as never);
  return chain;
}

function mockUpdateChain(returningRows: unknown[] = []) {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returningRows),
  };
  vi.mocked(db.update).mockReturnValue(chain as never);
  return chain;
}

/** The item tombstone + version cascade run inside one transaction. */
function mockTombstoneTransaction(returningRows: unknown[] = []) {
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returningRows),
  };
  const tx = {
    update: vi.fn().mockReturnValue(updateChain),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
  vi.mocked(db.transaction).mockImplementation(async (callback: any) => callback(tx));
  return { tx, updateChain };
}

function mockTransaction() {
  // Create a mock tx object with insert chain. The item upsert chains
  // .returning(); an empty result means "no rows changed" so the version
  // diff is skipped (its real behavior is covered by the integration tier).
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
  };
  const deleteChain = {
    where: vi.fn().mockResolvedValue(undefined),
  };
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    // Awaitable directly AND chains .returning() - the version tombstone
    // cascade path uses .returning(), reconcile's tombstone awaits .where()
    where: vi.fn().mockImplementation(function (this: unknown) {
      const result = Promise.resolve(undefined) as Promise<undefined> & {
        returning: ReturnType<typeof vi.fn>;
      };
      result.returning = vi.fn().mockResolvedValue([]);
      return result;
    }),
  };
  const tx = {
    insert: vi.fn().mockReturnValue(insertChain),
    delete: vi.fn().mockReturnValue(deleteChain),
    update: vi.fn().mockReturnValue(updateChain),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
  // Transaction executes the callback with tx and returns its result

  vi.mocked(db.transaction).mockImplementation(async (callback: any) => {
    return callback(tx);
  });
  return { tx, insertChain, deleteChain };
}

function mockSelectDistinctChain(results: unknown[][]) {
  let callCount = 0;
  const mock = vi.fn().mockImplementation(() => {
    const result = results[callCount] ?? [];
    callCount++;
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(result),
      }),
    } as never;
  });

  vi.mocked((db as any).selectDistinct as ReturnType<typeof vi.fn>).mockImplementation(mock);
  return mock;
}

function mockMediaServerClient(options: {
  libraries?: ReturnType<typeof createMockLibrary>[];
  items?: MediaLibraryItem[];
  totalCount?: number;
  itemsSince?: MediaLibraryItem[];
  totalCountSince?: number;
  leavesSince?: MediaLibraryItem[];
  leavesCountSince?: number;
}) {
  const client = {
    getLibraries: vi.fn().mockResolvedValue(options.libraries ?? [createMockLibrary()]),
    getLibraryItems: vi.fn().mockResolvedValue({
      items: options.items ?? [],
      totalCount: options.totalCount ?? options.items?.length ?? 0,
    }),
    getLibraryItemsSince: vi.fn().mockResolvedValue({
      items: options.itemsSince ?? [],
      totalCount: options.totalCountSince ?? options.itemsSince?.length ?? 0,
    }),
    getLibraryLeavesSince: vi.fn().mockResolvedValue({
      items: options.leavesSince ?? [],
      totalCount: options.leavesCountSince ?? options.leavesSince?.length ?? 0,
    }),
    // Undefined by default (JF/Emby never implement this) - assign a vi.fn() per test to opt in.
    getLibrarySeasons: undefined as
      | undefined
      | ((
          libraryId: string,
          opts?: { offset?: number; limit?: number }
        ) => Promise<{ items: MediaLibraryItem[]; totalCount: number; rawCount?: number }>),
    serverType: 'plex' as const,
    getSessions: vi.fn(),
    getUsers: vi.fn(),
    testConnection: vi.fn().mockResolvedValue(true),
    terminateSession: vi.fn(),
  };
  vi.mocked(createMediaServerClient).mockReturnValue(client);
  return client;
}

function createMockRedis(overrides: Partial<Record<string, unknown>> = {}): Redis {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    ...overrides,
  } as unknown as Redis;
}

/**
 * Helper to set up a standard select chain for incremental sync tests.
 * Returns server on first call, empty on subsequent calls.
 */
function setupSelectForIncrementalTest(mockServer: ReturnType<typeof createMockServer>) {
  let selectCallCount = 0;
  vi.mocked(db.select).mockImplementation(() => {
    selectCallCount++;
    const chain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        const whereResult = Promise.resolve([]);
        (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
          .fn()
          .mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve([]);
          });
        // copyLastSnapshot's "find the most recent snapshot" query chains .orderBy().limit() instead.
        (whereResult as typeof whereResult & { orderBy: typeof vi.fn }).orderBy = vi
          .fn()
          .mockReturnValue({ limit: vi.fn().mockResolvedValue([]) });
        return whereResult;
      }),
      limit: vi.fn().mockImplementation(() => {
        if (selectCallCount === 1) return Promise.resolve([mockServer]);
        return Promise.resolve([]);
      }),
      returning: vi.fn().mockResolvedValue([]),
    };
    return chain as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no orphaned libraries (selectDistinct returns matching current libraries)
  mockSelectDistinctChain([[], []]);
  // The auto-handoff throttles are module-level, so a test that probes or
  // enqueues would otherwise gate the next one for hours. Reset keeps the
  // order-dependence out of it.
  _resetAutoBackfillThrottleForTests();
  _resetReconcileThrottleForTests();
});

// clearAllMocks only clears call history, not implementations - restore db.execute so a test's override can't leak into the next.
afterEach(() => {
  vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);
});

// ============================================================================
// Tests
// ============================================================================

describe('LibrarySyncService', () => {
  describe('syncServer', () => {
    it('should throw error when server not found', async () => {
      const service = new LibrarySyncService();
      mockSelectChain([]);

      await expect(service.syncServer('non-existent-id')).rejects.toThrow(
        'Server not found: non-existent-id'
      );
    });

    it('should sync all libraries and return results', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [
        createMockLibrary({ id: '1', name: 'Movies' }),
        createMockLibrary({ id: '2', name: 'TV Shows', type: 'show' }),
      ];
      const mockItems = [
        createMockLibraryItem({ ratingKey: 'item-1' }),
        createMockLibraryItem({ ratingKey: 'item-2' }),
      ];

      // First call returns server, subsequent calls return empty (no existing items)
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        // Create a thenable chain that resolves for getPreviousItemKeys (no .limit())
        // and also for getServer (.limit())
        const chain = {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            // For getPreviousItemKeys, resolves via implicit await on .where()
            const whereResult = Promise.resolve([]);
            // Make it thenable and also have .limit() for getServer
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                // First call: server lookup
                if (selectCallCount === 1) return Promise.resolve([mockServer]);
                // Subsequent calls: empty (no existing items)
                return Promise.resolve([]);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve([]);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: mockLibraries,
        items: mockItems,
        totalCount: 2,
      });

      const results = await service.syncServer(mockServer.id);

      expect(results).toHaveLength(2);
      expect(results[0]!.libraryId).toBe('1');
      expect(results[1]!.libraryId).toBe('2');
      expect(createMediaServerClient).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'plex',
          url: 'http://localhost:32400',
          token: 'test-token',
        })
      );
    });

    it('continues past a failed session-identity backfill and still reconciles media duplicates', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [createMockLibrary({ id: '1', name: 'Movies' })];
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            const whereResult = Promise.resolve([]);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                if (selectCallCount === 1) return Promise.resolve([mockServer]);
                return Promise.resolve([]);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve([]);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: mockLibraries,
        items: mockItems,
        totalCount: 1,
      });

      vi.mocked(backfillSessionIdentityBatch).mockRejectedValueOnce(
        new Error('tuple decompression limit exceeded by operation')
      );

      const results = await service.syncServer(mockServer.id);

      // Item upserts already succeeded and must not be undone by the backfill failure.
      expect(results).toHaveLength(1);
      expect(reconcileMediaDuplicates).toHaveBeenCalledTimes(1);
    });

    it('hands compressed history to the maintenance walk when the probe finds work below the horizon', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: [createMockLibrary({ id: '1', name: 'Movies' })],
        items: [createMockLibraryItem({ ratingKey: 'item-1' })],
        totalCount: 1,
      });

      const horizon = new Date('2026-07-01T00:00:00.000Z');
      vi.mocked(getSessionsCompressionHorizon).mockResolvedValueOnce(horizon);
      vi.mocked(hasStampableSessionsBefore).mockResolvedValueOnce(true);

      await service.syncServer(mockServer.id);

      expect(hasStampableSessionsBefore).toHaveBeenCalledWith(horizon);
      expect(maybeEnqueueMaintenanceJob).toHaveBeenCalledWith(
        'backfill_session_identity',
        'system'
      );
    });

    it('stops re-probing after an enqueue, so a walk dying on one bad chunk cannot loop', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const runSync = async () => {
        setupSelectForIncrementalTest(mockServer);
        mockSelectDistinctChain([[], []]);
        mockInsertChain([{ id: randomUUID() }]);
        mockDeleteChain();
        mockTransaction();
        mockMediaServerClient({
          libraries: [createMockLibrary({ id: '1', name: 'Movies' })],
          items: [createMockLibraryItem({ ratingKey: 'item-1' })],
          totalCount: 1,
        });
        await service.syncServer(mockServer.id);
      };

      vi.mocked(getSessionsCompressionHorizon).mockResolvedValue(
        new Date('2026-07-01T00:00:00.000Z')
      );
      vi.mocked(hasStampableSessionsBefore).mockResolvedValue(true);
      vi.mocked(maybeEnqueueMaintenanceJob).mockResolvedValue('maintenance-job-1');

      await runSync();
      expect(maybeEnqueueMaintenanceJob).toHaveBeenCalledTimes(1);

      // The walk it just queued can fail on a bad chunk and leave the probe
      // answering true forever. Both syncs add items, so only the enqueue
      // floor can be what stops the second one.
      await runSync();
      expect(hasStampableSessionsBefore).toHaveBeenCalledTimes(1);
      expect(maybeEnqueueMaintenanceJob).toHaveBeenCalledTimes(1);

      vi.mocked(getSessionsCompressionHorizon).mockResolvedValue(null);
      vi.mocked(hasStampableSessionsBefore).mockResolvedValue(false);
      vi.mocked(maybeEnqueueMaintenanceJob).mockResolvedValue(null);
    });

    it('keeps probing when the enqueue never succeeds, so the floor never arms', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const runSync = async () => {
        setupSelectForIncrementalTest(mockServer);
        mockSelectDistinctChain([[], []]);
        mockInsertChain([{ id: randomUUID() }]);
        mockDeleteChain();
        mockTransaction();
        mockMediaServerClient({
          libraries: [createMockLibrary({ id: '1', name: 'Movies' })],
          items: [createMockLibraryItem({ ratingKey: 'item-1' })],
          totalCount: 1,
        });
        await service.syncServer(mockServer.id);
      };

      vi.mocked(getSessionsCompressionHorizon).mockResolvedValue(
        new Date('2026-07-01T00:00:00.000Z')
      );
      vi.mocked(hasStampableSessionsBefore).mockResolvedValue(true);
      // The queue is already full, or the job fails to enqueue for some other
      // reason - maybeEnqueueMaintenanceJob returns null on every call.
      vi.mocked(maybeEnqueueMaintenanceJob).mockResolvedValue(null);

      await runSync();
      expect(maybeEnqueueMaintenanceJob).toHaveBeenCalledTimes(1);

      // The floor is only meant to arm on a successful enqueue. Since it
      // never succeeded, the second sync must still probe and still try.
      await runSync();
      expect(hasStampableSessionsBefore).toHaveBeenCalledTimes(2);
      expect(maybeEnqueueMaintenanceJob).toHaveBeenCalledTimes(2);

      vi.mocked(getSessionsCompressionHorizon).mockResolvedValue(null);
      vi.mocked(hasStampableSessionsBefore).mockResolvedValue(false);
    });

    it('probes at most once a day on syncs that add no items', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const runSync = async () => {
        setupSelectForIncrementalTest(mockServer);
        mockSelectDistinctChain([[], []]);
        mockInsertChain([{ id: randomUUID() }]);
        mockDeleteChain();
        mockTransaction();
        mockMediaServerClient({
          libraries: [createMockLibrary({ id: '1', name: 'Movies' })],
          items: [],
          totalCount: 0,
        });
        await service.syncServer(mockServer.id);
      };

      vi.mocked(getSessionsCompressionHorizon).mockResolvedValue(
        new Date('2026-07-01T00:00:00.000Z')
      );
      vi.mocked(hasStampableSessionsBefore).mockResolvedValue(false);

      // A false probe decompress-scans every compressed chunk below the
      // horizon, and event syncs fire twice a minute. Nothing new landed in
      // the library on the second sync, so nothing can have flipped the
      // answer - the daily allowance is what keeps that off the hot path.
      await runSync();
      await runSync();

      expect(hasStampableSessionsBefore).toHaveBeenCalledTimes(1);

      vi.mocked(getSessionsCompressionHorizon).mockResolvedValue(null);
    });

    it('skips the probe entirely and runs an unwindowed batch when nothing is compressed', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: [createMockLibrary({ id: '1', name: 'Movies' })],
        items: [createMockLibraryItem({ ratingKey: 'item-1' })],
        totalCount: 1,
      });

      // Default mock already resolves null, but pin it here - this test is
      // about what a null horizon does, not about the default.
      vi.mocked(getSessionsCompressionHorizon).mockResolvedValueOnce(null);

      await service.syncServer(mockServer.id);

      // No compressed chunks means no history the sync tail can't reach, so
      // the expensive probe must not run at all.
      expect(hasStampableSessionsBefore).not.toHaveBeenCalled();
      expect(maybeEnqueueMaintenanceJob).not.toHaveBeenCalled();
      expect(backfillSessionIdentityBatch).toHaveBeenCalledWith(10000, undefined);
    });

    it('leaves the maintenance queue alone when nothing is left below the horizon', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: [createMockLibrary({ id: '1', name: 'Movies' })],
        items: [createMockLibraryItem({ ratingKey: 'item-1' })],
        totalCount: 1,
      });

      vi.mocked(getSessionsCompressionHorizon).mockResolvedValueOnce(
        new Date('2026-07-01T00:00:00.000Z')
      );
      vi.mocked(hasStampableSessionsBefore).mockResolvedValueOnce(false);

      await service.syncServer(mockServer.id);

      expect(maybeEnqueueMaintenanceJob).not.toHaveBeenCalled();
    });

    it('does not truncate a full scan when a page is all extras', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [createMockLibrary({ id: '1', name: 'Movies' })];
      const realItem = createMockLibraryItem({ ratingKey: 'item-real' });

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            const whereResult = Promise.resolve([]);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                if (selectCallCount === 1) return Promise.resolve([mockServer]);
                return Promise.resolve([]);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve([]);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      const client = mockMediaServerClient({ libraries: mockLibraries, totalCount: 300 });
      // Page at offset 0 is entirely extras: the server returns a full page (rawCount
      // = page size 200) but it parses down to zero items, which must not end the scan early.
      client.getLibraryItems = vi.fn().mockImplementation((_libraryId: string, opts?: unknown) => {
        const { offset } = (opts ?? {}) as { offset?: number; limit?: number };
        if (offset === 200) {
          return Promise.resolve({ items: [realItem], totalCount: 300, rawCount: 100 });
        }
        return Promise.resolve({ items: [], totalCount: 300, rawCount: 200 });
      });

      const results = await service.syncServer(mockServer.id);

      expect(client.getLibraryItems).toHaveBeenCalledTimes(3); // count probe + 2 pages
      expect(results[0]!.itemsProcessed).toBe(1);
      expect(results[0]!.itemsAdded).toBe(1);
    });

    it('should skip photo libraries during sync', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [
        createMockLibrary({ id: '1', name: 'Movies', type: 'movie' }),
        createMockLibrary({ id: '2', name: 'Photos', type: 'photo' }),
        createMockLibrary({ id: '3', name: 'TV Shows', type: 'show' }),
      ];
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            const whereResult = Promise.resolve([]);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                if (selectCallCount === 1) return Promise.resolve([mockServer]);
                return Promise.resolve([]);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve([]);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: mockLibraries,
        items: mockItems,
        totalCount: 1,
      });

      const results = await service.syncServer(mockServer.id);

      // Photo library should be filtered out - only Movies and TV Shows synced
      expect(results).toHaveLength(2);
      expect(results[0]!.libraryId).toBe('1');
      expect(results[1]!.libraryId).toBe('3');
    });

    it('should report progress via callback', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [createMockLibrary()];
      const mockItems = [createMockLibraryItem()];
      const progressUpdates: LibrarySyncProgress[] = [];

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            const whereResult = Promise.resolve([]);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                if (selectCallCount === 1) return Promise.resolve([mockServer]);
                return Promise.resolve([]);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve([]);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: mockLibraries,
        items: mockItems,
        totalCount: 1,
      });

      await service.syncServer(mockServer.id, (progress) => {
        progressUpdates.push({ ...progress });
      });

      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates[0]!.status).toBe('running');
      expect(progressUpdates[progressUpdates.length - 1]!.status).toBe('complete');
    });
  });

  describe('upsertItems', () => {
    it('should insert new items to database', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const items = [
        createMockLibraryItem({ ratingKey: 'item-1', title: 'Movie 1' }),
        createMockLibraryItem({ ratingKey: 'item-2', title: 'Movie 2' }),
      ];

      const { tx, insertChain } = mockTransaction();

      await service.upsertItems(serverId, libraryId, items);

      expect(tx.insert).toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalled();
      expect(insertChain.onConflictDoUpdate).toHaveBeenCalled();
    });

    it('should handle empty items array', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';

      await service.upsertItems(serverId, libraryId, []);

      expect(db.insert).not.toHaveBeenCalled();
    });

    it('should map all MediaLibraryItem fields correctly', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const item = createMockLibraryItem({
        ratingKey: 'test-key',
        title: 'Test Title',
        mediaType: 'movie',
        year: 2024,
        videoResolution: '4k',
        videoCodec: 'hevc',
        audioCodec: 'truehd',
        fileSize: 10000000000,
        imdbId: 'tt1234567',
        tmdbId: 12345,
        tvdbId: 67890,
        filePath: '/movies/test.mkv',
        thumbPath: '/library/metadata/test-key/thumb',
      });

      const { insertChain } = mockTransaction();

      await service.upsertItems(serverId, libraryId, [item]);

      expect(insertChain.values).toHaveBeenCalledWith([
        expect.objectContaining({
          serverId,
          libraryId,
          ratingKey: 'test-key',
          title: 'Test Title',
          mediaType: 'movie',
          year: 2024,
          videoResolution: '4k',
          videoCodec: 'hevc',
          audioCodec: 'truehd',
          fileSize: 10000000000,
          imdbId: 'tt1234567',
          tmdbId: 12345,
          tvdbId: 67890,
          filePath: '/movies/test.mkv',
          thumbPath: '/library/metadata/test-key/thumb',
        }),
      ]);
    });

    it('carries thumbPath into the conflict update but never touches dominantColor', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const item = createMockLibraryItem({ ratingKey: 'poster-key', thumbPath: '/thumb/1' });

      const { insertChain } = mockTransaction();

      await service.upsertItems(serverId, libraryId, [item]);

      const conflictArgs = insertChain.onConflictDoUpdate.mock.calls[0]![0] as {
        set: Record<string, unknown>;
      };
      expect(conflictArgs.set).toHaveProperty('thumbPath');
      expect(conflictArgs.set).not.toHaveProperty('dominantColor');
    });

    it('should collapse duplicate ratingKeys, keeping the last occurrence', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const items = [
        createMockLibraryItem({ ratingKey: 'dup', title: 'First' }),
        createMockLibraryItem({ ratingKey: 'unique', title: 'Other' }),
        createMockLibraryItem({ ratingKey: 'dup', title: 'Second' }),
      ];

      const { insertChain } = mockTransaction();

      await service.upsertItems(serverId, libraryId, items);

      const valuesArg = insertChain.values.mock.calls[0]![0] as Array<{
        ratingKey: string;
        title: string;
      }>;
      expect(valuesArg).toHaveLength(2);
      const dup = valuesArg.find((v) => v.ratingKey === 'dup');
      expect(dup?.title).toBe('Second');
      expect(valuesArg.find((v) => v.ratingKey === 'unique')?.title).toBe('Other');
    });

    it('should drop items with empty ratingKey and skip insert when batch becomes empty', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const items = [
        createMockLibraryItem({ ratingKey: '', title: 'No ID 1' }),
        createMockLibraryItem({ ratingKey: '', title: 'No ID 2' }),
      ];

      mockTransaction();

      await service.upsertItems(serverId, libraryId, items);

      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('should drop empty-ratingKey items but still insert valid ones', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const items = [
        createMockLibraryItem({ ratingKey: '', title: 'No ID' }),
        createMockLibraryItem({ ratingKey: 'real', title: 'Real Item' }),
      ];

      const { insertChain } = mockTransaction();

      await service.upsertItems(serverId, libraryId, items);

      const valuesArg = insertChain.values.mock.calls[0]![0] as Array<{
        ratingKey: string;
        title: string;
      }>;
      expect(valuesArg).toHaveLength(1);
      expect(valuesArg[0]!.ratingKey).toBe('real');
    });

    it('reads no prior quality and announces nothing without an announce context', async () => {
      const service = new LibrarySyncService();
      const { insertChain } = mockTransaction();
      insertChain.returning.mockResolvedValue([changedRow()]);

      await service.upsertItems(randomUUID(), '1', [createMockLibraryItem({ ratingKey: 'rk-1' })]);

      expect(db.select).not.toHaveBeenCalled();
      expect(mockDispatchMediaUpgraded).not.toHaveBeenCalled();
    });

    it('reads nothing more once the run has filled its buffer', async () => {
      const service = new LibrarySyncService();
      const run = {
        server: { id: 'server-1', name: 'Basement', type: 'plex' as const },
        budget: { remaining: 20, suppressed: 4 },
        collected: Array.from({ length: MEDIA_BUFFER_CAP }, () => fakeCollected()),
      };
      const announce = { ...run, libraryName: 'Movies', run };
      const { insertChain } = mockTransaction();
      insertChain.returning.mockResolvedValue([changedRow()]);

      await service.upsertItems(
        randomUUID(),
        '1',
        [createMockLibraryItem({ ratingKey: 'rk-1' })],
        undefined,
        announce
      );

      expect(db.select).not.toHaveBeenCalled();
      expect(mockDispatchMediaUpgraded).not.toHaveBeenCalled();
    });

    it('announces the quality a changed row moved to, once the run flushes', async () => {
      const service = new LibrarySyncService();
      const run = {
        server: { id: 'server-1', name: 'Basement', type: 'plex' as const },
        budget: { remaining: 20, suppressed: 0 },
        collected: [],
      };
      const announce = { ...run, libraryName: 'Movies', run };
      mockPriorQuality([
        {
          ratingKey: 'rk-1',
          mediaId: null,
          resolution: '1080p',
          dynamicRange: null,
          videoCodec: 'H264',
          audioCodec: 'AC3',
          audioChannels: 6,
          fileSize: 8_000_000_000,
        },
      ]);
      const { insertChain } = mockTransaction();
      insertChain.returning.mockResolvedValue([changedRow()]);

      await service.upsertItems(
        randomUUID(),
        '1',
        [createMockLibraryItem({ ratingKey: 'rk-1' })],
        undefined,
        announce
      );

      // Nothing leaves upsertItems: the run holds it until every library is in.
      expect(mockDispatchMediaUpgraded).not.toHaveBeenCalled();
      await flushMediaAnnounceRun(run);

      expect(mockDispatchMediaUpgraded).toHaveBeenCalledWith({
        server: announce.server,
        media: expect.objectContaining({
          libraryItemId: 'library-item-1',
          ratingKey: 'rk-1',
          mediaId: null,
          title: 'Cars',
          type: 'movie',
          year: 2006,
          libraryId: '1',
          libraryName: 'Movies',
          quality: {
            resolution: '4k',
            dynamicRange: null,
            videoCodec: 'H264',
            audioCodec: 'AC3',
            audioChannels: 6,
            fileSize: 9_000_000_000,
          },
        }),
        from: {
          resolution: '1080p',
          dynamicRange: null,
          videoCodec: 'H264',
          audioCodec: 'AC3',
          audioChannels: 6,
          fileSize: 8_000_000_000,
        },
        changed: ['resolution', 'fileSize'],
      });
      expect(run.budget).toEqual({ remaining: 19, suppressed: 0 });
    });
  });

  describe('unreachable server preflight', () => {
    it('fails fast without touching libraries or sync state when the server is unreachable', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      mockSelectChain([mockServer]);
      const client = mockMediaServerClient({ libraries: [createMockLibrary()], items: [] });
      client.testConnection = vi.fn().mockResolvedValue(false);

      // Server-level failures throw to the queue's failed handler, same as
      // a getLibraries error - the point is failing in one 10s preflight
      // without touching a single library fetch
      await expect(service.syncServer(mockServer.id)).rejects.toThrow('unreachable');
      expect(client.getLibraries).not.toHaveBeenCalled();
      expect(client.getLibraryItems).not.toHaveBeenCalled();
    });
  });

  describe('markItemsRemoved', () => {
    it('should tombstone items in the database', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const ratingKeys = ['key-1', 'key-2', 'key-3'];

      const { tx, updateChain } = mockTombstoneTransaction();

      await service.markItemsRemoved(serverId, libraryId, ratingKeys);

      expect(tx.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ removedAt: expect.any(Date) })
      );
      expect(updateChain.where).toHaveBeenCalled();
    });

    it('should handle empty ratingKeys array', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';

      await service.markItemsRemoved(serverId, libraryId, []);

      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('should batch updates for large arrays', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      // Create 250 keys (should result in 3 batches of 100)
      const ratingKeys = Array.from({ length: 250 }, (_, i) => `key-${i}`);

      mockTombstoneTransaction();

      await service.markItemsRemoved(serverId, libraryId, ratingKeys);

      // Should be called 3 times (batches of 100, 100, 50)
      expect(db.transaction).toHaveBeenCalledTimes(3);
    });
  });

  describe('tombstoneItemsByRatingKey', () => {
    it('tombstones items by server + rating key without a libraryId', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();

      const { tx, updateChain } = mockTombstoneTransaction();

      await service.tombstoneItemsByRatingKey(serverId, ['rk-1', 'rk-2']);

      expect(tx.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ removedAt: expect.any(Date) })
      );
      expect(updateChain.where).toHaveBeenCalled();
    });

    it('handles an empty ratingKeys array as a no-op', async () => {
      const service = new LibrarySyncService();
      await service.tombstoneItemsByRatingKey(randomUUID(), []);

      expect(db.update).not.toHaveBeenCalled();
    });

    it('batches updates for large arrays', async () => {
      const service = new LibrarySyncService();
      const ratingKeys = Array.from({ length: 250 }, (_, i) => `key-${i}`);

      mockTombstoneTransaction();

      await service.tombstoneItemsByRatingKey(randomUUID(), ratingKeys);

      expect(db.transaction).toHaveBeenCalledTimes(3);
    });
  });

  describe('delta detection', () => {
    it('should detect added items', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [createMockLibrary()];
      // Existing items in DB
      const existingItems = [createMockDbItem({ ratingKey: 'existing-1' })];
      // Items from server (existing + new)
      const serverItems = [
        createMockLibraryItem({ ratingKey: 'existing-1' }),
        createMockLibraryItem({ ratingKey: 'new-1' }),
        createMockLibraryItem({ ratingKey: 'new-2' }),
      ];

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            // For getPreviousItemKeys - returns existing items via implicit await
            const whereResult = Promise.resolve(existingItems);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                // First call: server lookup
                if (selectCallCount === 1) return Promise.resolve([mockServer]);
                return Promise.resolve(existingItems);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve(existingItems);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: mockLibraries,
        items: serverItems,
        totalCount: 3,
      });

      const results = await service.syncServer(mockServer.id);

      expect(results[0]!.itemsAdded).toBe(2); // new-1 and new-2
    });

    it('should detect removed items', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [createMockLibrary()];
      // Existing items in DB
      const existingItems = [
        createMockDbItem({ ratingKey: 'item-1' }),
        createMockDbItem({ ratingKey: 'item-2' }),
        createMockDbItem({ ratingKey: 'item-3' }),
      ];
      // Items from server (missing item-2)
      const serverItems = [
        createMockLibraryItem({ ratingKey: 'item-1' }),
        createMockLibraryItem({ ratingKey: 'item-3' }),
      ];

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            const whereResult = Promise.resolve(existingItems);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                if (selectCallCount === 1) return Promise.resolve([mockServer]);
                return Promise.resolve(existingItems);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve(existingItems);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockUpdateChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: mockLibraries,
        items: serverItems,
        totalCount: 2,
      });

      const results = await service.syncServer(mockServer.id);

      expect(results[0]!.itemsRemoved).toBe(1); // item-2 removed
      expect(db.transaction).toHaveBeenCalled();
    });
  });

  describe('incremental sync', () => {
    const serverId = randomUUID();

    beforeEach(() => {
      // Reset Redis client between tests
      initLibrarySyncRedis(null as unknown as Redis);
    });

    it('does full scan when no lastSyncedAt exists', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      const mockRedis = createMockRedis({
        get: vi.fn().mockResolvedValue(null), // no sync state
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: mockItems,
        totalCount: 1,
      });

      const service = new LibrarySyncService();
      await service.syncServer(serverId);

      // Full scan uses getLibraryItems (not getLibraryItemsSince) for the batch loop
      expect(client.getLibraryItems).toHaveBeenCalledWith('1', { offset: 0, limit: 200 });
      expect(client.getLibraryItemsSince).not.toHaveBeenCalled();
    });

    it('does full scan when totalCount < lastItemCount', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      // Redis says we had 100 items, but server now reports 90 — items were removed
      const mockRedis = createMockRedis({
        get: vi
          .fn()
          .mockResolvedValueOnce(new Date(Date.now() - 60_000).toISOString()) // lastSyncedAt
          .mockResolvedValueOnce('100'), // lastItemCount
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: mockItems,
        totalCount: 90, // fewer than lastItemCount=100
      });

      const service = new LibrarySyncService();
      await service.syncServer(serverId);

      expect(client.getLibraryItems).toHaveBeenCalledWith('1', { offset: 0, limit: 200 });
      expect(client.getLibraryItemsSince).not.toHaveBeenCalled();
    });

    it('escalates to full scan when local active count drifts past the server total', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      const mockRedis = createMockRedis({
        get: vi
          .fn()
          // 20 min ago: outside COUNT_CHECK_MIN_INTERVAL_MS so the drift check runs
          .mockResolvedValueOnce(new Date(Date.now() - 20 * 60_000).toISOString()) // lastSyncedAt
          .mockResolvedValueOnce('10'), // lastItemCount
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      // Server still reports 10, but the DB has 20 active rows - a same-cycle
      // remove+add that incremental sync alone would never surface.
      vi.mocked(db.execute).mockResolvedValueOnce({ rows: [{ count: 20 }] } as never);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: mockItems,
        totalCount: 10,
      });

      const service = new LibrarySyncService();
      await service.syncServer(serverId);

      expect(client.getLibraryItems).toHaveBeenCalledWith('1', { offset: 0, limit: 200 });
      expect(client.getLibraryItemsSince).not.toHaveBeenCalled();
    });

    it('escalates to full scan when an incremental sync finds no changes but the local active count is still below the server total (wrong tombstone)', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      const mockRedis = createMockRedis({
        get: vi
          .fn()
          // 20 min ago: outside COUNT_CHECK_MIN_INTERVAL_MS so the drift check runs
          .mockResolvedValueOnce(new Date(Date.now() - 20 * 60_000).toISOString()) // lastSyncedAt
          .mockResolvedValueOnce('20'), // lastItemCount
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      // A wrong tombstone: only 10 active rows remain locally, before and after the sync.
      vi.mocked(db.execute).mockResolvedValue({ rows: [{ count: 10 }] } as never);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: mockItems,
        totalCount: 20,
      });

      const service = new LibrarySyncService();
      await service.syncServer(serverId);

      // Incremental is attempted first, since the undercount alone doesn't block it.
      expect(client.getLibraryItemsSince).toHaveBeenCalledWith('1', expect.any(Date));
      // The still-short post-sync count escalates to a full scan in the same run.
      expect(client.getLibraryItems).toHaveBeenCalledWith('1', { offset: 0, limit: 200 });
    });

    it('never escalates a music library, even with a local active count far below the server total', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockRedis = createMockRedis({
        get: vi
          .fn()
          // 20 min ago: the drift check window is open, yet music must still not escalate
          .mockResolvedValueOnce(new Date(Date.now() - 20 * 60_000).toISOString()) // lastSyncedAt
          .mockResolvedValueOnce('20'), // lastItemCount
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      // Same gap as the wrong-tombstone case above, but for music this must never escalate.
      vi.mocked(db.execute).mockResolvedValue({ rows: [{ count: 5 }] } as never);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary({ type: 'artist' })],
        totalCount: 20,
      });

      const service = new LibrarySyncService();
      await service.syncServer(serverId);

      // Stays on the incremental "no changes" fast path - never escalates.
      expect(client.getLibraryItemsSince).toHaveBeenCalledWith('1', expect.any(Date));
      expect(client.getLibraryItems).not.toHaveBeenCalledWith('1', { offset: 0, limit: 200 });
    });

    it('counts only top-level items for the mismatch check, never episodes or tracks', async () => {
      // A TV library's server total counts shows only; local episodes share
      // the library_id and must not inflate the local side of the check or
      // every sync of a non-flat library would escalate to a full scan.
      const service = new LibrarySyncService();
      const countQueries: string[] = [];
      vi.mocked(db.execute).mockImplementationOnce(((query: unknown) => {
        const text = renderSql(query as never).sql.replace(/\s+/g, ' ');
        if (text.includes('count(*)') && text.includes('library_items')) {
          countQueries.push(text);
          return Promise.resolve({ rows: [{ count: 5 }] });
        }
        return Promise.resolve({ rows: [] });
      }) as never);

      await (
        service as unknown as {
          getActiveItemCount: (serverId: string, libraryId: string) => Promise<number>;
        }
      ).getActiveItemCount('server-1', 'lib-1');

      expect(countQueries).toHaveLength(1);
      expect(countQueries[0]).toContain("media_type NOT IN ('episode', 'track', 'season')");
      expect(countQueries[0]).toContain('removed_at IS NULL');
    });

    it('stays on the incremental path when local active count matches the server total', async () => {
      const mockServer = createMockServer({ id: serverId });
      const newItem = createMockLibraryItem({ ratingKey: 'new-item' });
      const mockRedis = createMockRedis({
        get: vi
          .fn()
          // 20 min ago: outside COUNT_CHECK_MIN_INTERVAL_MS so both count probes run
          .mockResolvedValueOnce(new Date(Date.now() - 20 * 60_000).toISOString())
          .mockResolvedValueOnce('5'),
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      // Growth: pre-sync count (5) trails the server total (6), the incremental sync catches it up.
      vi.mocked(db.execute)
        .mockResolvedValueOnce({ rows: [{ count: 5 }] } as never)
        .mockResolvedValueOnce({ rows: [{ count: 6 }] } as never)
        // Fallback: rebuildSnapshotFromDb's aggregate query
        .mockResolvedValue({
          rows: [
            {
              item_count: 6,
              total_size: '5000000000',
              movie_count: 6,
              episode_count: 0,
              season_count: 0,
              show_count: 0,
              music_count: 0,
              count_4k: 0,
              count_1080p: 6,
              count_720p: 0,
              count_sd: 0,
              count_high_quality: 6,
              hevc_count: 0,
              h264_count: 6,
              av1_count: 0,
              version_count: 6,
            },
          ],
        } as never);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: [],
        totalCount: 6,
        itemsSince: [newItem],
        totalCountSince: 1,
      });

      const service = new LibrarySyncService();
      await service.syncServer(serverId);

      expect(client.getLibraryItemsSince).toHaveBeenCalledWith('1', expect.any(Date));
      expect(client.getLibraryItems).not.toHaveBeenCalledWith('1', { offset: 0, limit: 200 });
    });

    it('does not run the count-mismatch check on a manual trigger', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      const mockRedis = createMockRedis({
        get: vi
          .fn()
          .mockResolvedValueOnce(new Date(Date.now() - 60_000).toISOString())
          .mockResolvedValueOnce('1'),
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: mockItems,
        totalCount: 1,
      });

      const service = new LibrarySyncService();
      await service.syncServer(serverId, undefined, 'manual');

      // Snapshot aggregates and the sync-tail replacement linking are the only
      // raw queries a manual full scan may run; anything else here would be
      // the count-mismatch check
      for (const call of vi.mocked(db.execute).mock.calls) {
        expect(renderSql(call[0] as SQL).sql).toMatch(/item_rollup|replaces_library_item_id/);
      }
    });

    it('does full scan when triggeredBy is manual', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      // Redis has valid sync state — but it's a manual trigger
      const mockRedis = createMockRedis({
        get: vi
          .fn()
          .mockResolvedValueOnce(new Date(Date.now() - 60_000).toISOString()) // lastSyncedAt
          .mockResolvedValueOnce('1'), // lastItemCount matches
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: mockItems,
        totalCount: 1,
      });

      const service = new LibrarySyncService();
      await service.syncServer(serverId, undefined, 'manual');

      expect(client.getLibraryItems).toHaveBeenCalledWith('1', { offset: 0, limit: 200 });
      expect(client.getLibraryItemsSince).not.toHaveBeenCalled();
    });

    it('does incremental scan when conditions are met', async () => {
      const mockServer = createMockServer({ id: serverId });
      const newItem = createMockLibraryItem({ ratingKey: 'new-item' });
      const snapshotId = randomUUID();
      const lastSyncedAt = new Date(Date.now() - 60_000);
      const mockRedis = createMockRedis({
        get: vi
          .fn()
          .mockResolvedValueOnce(lastSyncedAt.toISOString()) // lastSyncedAt
          .mockResolvedValueOnce('5'), // lastItemCount = 5, totalCount = 6
      });
      initLibrarySyncRedis(mockRedis);

      // Select mock: getServer → items from DB → no existing snapshot today
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            if (selectCallCount === 2) {
              const itemsResult = Promise.resolve([
                createMockDbItem({
                  fileSize: 5_000_000_000,
                  videoResolution: '1080p',
                  videoCodec: 'h264',
                  mediaType: 'movie',
                }),
              ]);
              (itemsResult as typeof itemsResult & { limit: typeof vi.fn }).limit = vi
                .fn()
                .mockResolvedValue([]);
              return itemsResult;
            }
            const whereResult = Promise.resolve([]);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                if (selectCallCount === 1) return Promise.resolve([mockServer]);
                return Promise.resolve([]);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve([]);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      const insertChain = {
        values: vi.fn().mockReturnThis(),
        onConflictDoUpdate: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ id: snapshotId }]),
      };
      vi.mocked(db.insert).mockReturnValue(insertChain as never);
      mockDeleteChain();
      mockTransaction();
      // Growth: pre-sync count (5) trails the server total (6), the incremental sync catches it up.
      vi.mocked(db.execute)
        .mockResolvedValueOnce({ rows: [{ count: 5 }] } as never)
        .mockResolvedValueOnce({ rows: [{ count: 6 }] } as never)
        // Fallback: rebuildSnapshotFromDb's aggregate query
        .mockResolvedValue({
          rows: [
            {
              item_count: 6,
              total_size: '5000000000',
              movie_count: 6,
              episode_count: 0,
              season_count: 0,
              show_count: 0,
              music_count: 0,
              count_4k: 0,
              count_1080p: 6,
              count_720p: 0,
              count_sd: 0,
              count_high_quality: 6,
              hevc_count: 0,
              h264_count: 6,
              av1_count: 0,
              version_count: 6,
            },
          ],
        } as never);

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: [], // full scan returns nothing (shouldn't be called for batch loop)
        totalCount: 6,
        itemsSince: [newItem],
        totalCountSince: 1,
      });

      const service = new LibrarySyncService();
      const results = await service.syncServer(serverId);

      expect(client.getLibraryItemsSince).toHaveBeenCalledWith('1', expect.any(Date));
      expect(client.getLibraryLeavesSince).toHaveBeenCalled();
      expect(results[0]!.itemsAdded).toBe(1);
      expect(results[0]!.itemsRemoved).toBe(0);
      expect(results[0]!.snapshotId).toBe(snapshotId);
    });

    it('skips when incremental finds 0 items and count matches', async () => {
      const mockServer = createMockServer({ id: serverId });
      const lastSyncedAt = new Date(Date.now() - 60_000);
      const mockRedis = createMockRedis({
        get: vi
          .fn()
          .mockResolvedValueOnce(lastSyncedAt.toISOString()) // lastSyncedAt
          .mockResolvedValueOnce('5'), // lastItemCount = 5, totalCount = 5 (unchanged)
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      // Local active count matches the server total, both before and after.
      vi.mocked(db.execute).mockResolvedValue({ rows: [{ count: 5 }] } as never);
      mockInsertChain([]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: [],
        totalCount: 5, // same as lastItemCount
        itemsSince: [],
        totalCountSince: 0, // 0 new items
      });

      const service = new LibrarySyncService();
      const results = await service.syncServer(serverId);

      expect(results[0]!.itemsProcessed).toBe(0);
      expect(results[0]!.itemsAdded).toBe(0);
      expect(results[0]!.itemsRemoved).toBe(0);
      expect(results[0]!.snapshotId).toBeNull();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(client.getLibraryItemsSince).toHaveBeenCalledTimes(1);
      expect(client.getLibraryLeavesSince).toHaveBeenCalledTimes(1);
      expect(mockRedis.set).toHaveBeenCalled();
    });

    it('fetches new episodes even when no new shows exist', async () => {
      const mockServer = createMockServer({ id: serverId });
      const lastSyncedAt = new Date(Date.now() - 60_000);
      const newEpisode = createMockLibraryItem({ ratingKey: 'new-ep-1', mediaType: 'episode' });
      const mockRedis = createMockRedis({
        get: vi
          .fn()
          .mockResolvedValueOnce(lastSyncedAt.toISOString()) // lastSyncedAt
          .mockResolvedValueOnce('5'), // lastItemCount = 5, totalCount = 5
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      // New episodes don't change the top-level active count.
      vi.mocked(db.execute).mockResolvedValue({ rows: [{ count: 5 }] } as never);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: [],
        totalCount: 5, // same as lastItemCount — no new shows
        itemsSince: [], // no new top-level items
        totalCountSince: 0,
        leavesSince: [newEpisode], // but there ARE new episodes
        leavesCountSince: 1,
      });

      const service = new LibrarySyncService();
      const results = await service.syncServer(serverId);

      expect(results[0]!.itemsProcessed).toBe(1);
      expect(results[0]!.itemsAdded).toBe(1);
      expect(db.transaction).toHaveBeenCalled();
      expect(client.getLibraryLeavesSince).toHaveBeenCalled();
    });

    it('falls back to full scan when getLibraryItemsSince throws', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      const lastSyncedAt = new Date(Date.now() - 60_000);
      const mockRedis = createMockRedis({
        get: vi.fn().mockResolvedValueOnce(lastSyncedAt.toISOString()).mockResolvedValueOnce('1'),
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: mockItems,
        totalCount: 1,
      });
      // Make incremental fetch throw
      client.getLibraryItemsSince.mockRejectedValue(new Error('API error'));

      const service = new LibrarySyncService();
      const results = await service.syncServer(serverId);

      // Should fall back to full scan
      expect(client.getLibraryItems).toHaveBeenCalledWith('1', { offset: 0, limit: 200 });
      expect(results[0]!.itemsProcessed).toBe(1);
    });

    it('stores sync state with 5-minute safety margin', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      const mockRedis = createMockRedis({
        get: vi.fn().mockResolvedValue(null),
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: mockItems,
        totalCount: 1,
      });

      const beforeSync = Date.now();
      const service = new LibrarySyncService();
      await service.syncServer(serverId);

      // Redis.set should have been called with the sync state keys
      const setCalls = vi.mocked(mockRedis.set).mock.calls;
      // Find the call for LIBRARY_SYNC_LAST key
      const lastCall = setCalls.find((call) => String(call[0]).includes('sync:last'));
      expect(lastCall).toBeDefined();

      // The stored timestamp should be ~5 minutes before now
      const storedTimestamp = new Date(lastCall![1] as string).getTime();
      const fiveMinutesMs = 5 * 60 * 1000;
      // Should be roughly (beforeSync - 5min), with some tolerance
      expect(storedTimestamp).toBeLessThan(beforeSync - fiveMinutesMs + 5000);
      expect(storedTimestamp).toBeGreaterThan(beforeSync - fiveMinutesMs - 5000);
    });
  });

  describe('season sync (Plex full scan)', () => {
    it('fetches seasons for a TV library via getLibrarySeasons and includes them in media resolution', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [createMockLibrary({ id: '2', name: 'TV Shows', type: 'show' })];
      const showItem = createMockLibraryItem({
        ratingKey: 'show-1',
        title: 'Severance',
        mediaType: 'show',
        fileSize: undefined,
      });
      const seasonItem = createMockLibraryItem({
        ratingKey: 'season-1',
        title: 'Season 1',
        mediaType: 'season',
        fileSize: undefined,
        parentRatingKey: 'show-1',
        parentIndex: 1,
      });

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            const whereResult = Promise.resolve([]);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                if (selectCallCount === 1) return Promise.resolve([mockServer]);
                return Promise.resolve([]);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve([]);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      const client = mockMediaServerClient({
        libraries: mockLibraries,
        items: [showItem],
        totalCount: 1,
      });
      client.getLibrarySeasons = vi.fn().mockResolvedValue({
        items: [seasonItem],
        totalCount: 1,
      });

      await service.syncServer(mockServer.id);

      expect(client.getLibrarySeasons).toHaveBeenCalled();

      const resolveCalls = vi.mocked(resolveMediaBatch).mock.calls;
      const seasonBatchCall = resolveCalls.find((call) =>
        call[0].some((i) => i.mediaType === 'season')
      );
      expect(seasonBatchCall).toBeDefined();
      const seasonInput = seasonBatchCall![0].find((i) => i.mediaType === 'season');
      expect(seasonInput).toMatchObject({
        ratingKey: 'season-1',
        parentRatingKey: 'show-1',
        seasonNumber: 1,
      });
    });

    it('does not call getLibrarySeasons for a library with no shows', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [createMockLibrary({ id: '1', name: 'Movies' })];
      const movieItem = createMockLibraryItem({ ratingKey: 'movie-1', mediaType: 'movie' });

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            const whereResult = Promise.resolve([]);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                if (selectCallCount === 1) return Promise.resolve([mockServer]);
                return Promise.resolve([]);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([mockServer]);
            return Promise.resolve([]);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      const client = mockMediaServerClient({
        libraries: mockLibraries,
        items: [movieItem],
        totalCount: 1,
      });
      client.getLibrarySeasons = vi.fn().mockResolvedValue({ items: [], totalCount: 0 });

      await service.syncServer(mockServer.id);

      expect(client.getLibrarySeasons).not.toHaveBeenCalled();
    });
  });

  describe('orphaned library cleanup', () => {
    function setupSyncWithOrphans(options: {
      server: ReturnType<typeof createMockServer>;
      libraries: ReturnType<typeof createMockLibrary>[];
      items: MediaLibraryItem[];
      itemLibraryIds: { libraryId: string }[];
      snapshotLibraryIds: { libraryId: string }[];
      orphanReturningRows?: unknown[];
    }) {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            const whereResult = Promise.resolve([]);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(() => {
                if (selectCallCount === 1) return Promise.resolve([options.server]);
                return Promise.resolve([]);
              });
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([options.server]);
            return Promise.resolve([]);
          }),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });

      mockSelectDistinctChain([options.itemLibraryIds, options.snapshotLibraryIds]);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain(options.orphanReturningRows ?? []);
      mockTransaction();
      mockMediaServerClient({
        libraries: options.libraries,
        items: options.items,
        totalCount: options.items.length,
      });
    }

    /** Filters out the per-library shortfall COUNT query so these tests only count aggregate-refresh calls. */
    function countAggregateRefreshCalls(): number {
      return vi
        .mocked(db.execute)
        .mock.calls.filter(([query]) =>
          renderSql(query as never).sql.includes('refresh_continuous_aggregate')
        ).length;
    }

    it('should not clean up when no orphaned libraries exist', async () => {
      const mockServer = createMockServer();
      const libraries = [
        createMockLibrary({ id: 'lib-1', name: 'Movies' }),
        createMockLibrary({ id: 'lib-2', name: 'TV Shows', type: 'show' }),
      ];

      setupSyncWithOrphans({
        server: mockServer,
        libraries,
        items: [createMockLibraryItem()],
        // DB has same libraries as server
        itemLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
        snapshotLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
      });

      const service = new LibrarySyncService();
      await service.syncServer(mockServer.id);

      // Delete should only be called for normal syncLibrary operations, not for orphan cleanup
      expect(countAggregateRefreshCalls()).toBe(0);
    });

    it('should clean up orphaned library items and snapshots', async () => {
      const mockServer = createMockServer();
      const libraries = [createMockLibrary({ id: 'lib-2', name: 'New Movies' })];

      setupSyncWithOrphans({
        server: mockServer,
        libraries,
        items: [createMockLibraryItem()],
        itemLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
        snapshotLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
      });

      const service = new LibrarySyncService();
      await service.syncServer(mockServer.id);

      const deleteCalls = vi.mocked(db.delete).mock.calls;
      expect(deleteCalls.length).toBeGreaterThanOrEqual(2);

      expect(countAggregateRefreshCalls()).toBe(2);
    });

    it('surfaces orphan-cleanup removals as a synthetic result so removal-only syncs still invalidate caches', async () => {
      const mockServer = createMockServer();
      const libraries = [createMockLibrary({ id: 'lib-2', name: 'New Movies' })];

      setupSyncWithOrphans({
        server: mockServer,
        libraries,
        items: [createMockLibraryItem()],
        itemLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
        snapshotLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
        orphanReturningRows: [{ id: 'orphan-item-1' }, { id: 'orphan-item-2' }],
      });

      const service = new LibrarySyncService();
      const results = await service.syncServer(mockServer.id);

      const cleanupResult = results.find((r) => r.libraryId === 'orphan-cleanup');
      expect(cleanupResult).toBeDefined();
      expect(cleanupResult!.itemsRemoved).toBe(2);
      expect(cleanupResult!.itemsProcessed).toBe(0);
    });

    it('should clean up multiple orphaned libraries', async () => {
      const mockServer = createMockServer();
      const libraries = [createMockLibrary({ id: 'lib-3', name: 'Current Library' })];

      setupSyncWithOrphans({
        server: mockServer,
        libraries,
        items: [createMockLibraryItem()],
        // DB has lib-1, lib-2 (orphaned) and lib-3 (current)
        itemLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }, { libraryId: 'lib-3' }],
        snapshotLibraryIds: [
          { libraryId: 'lib-1' },
          { libraryId: 'lib-2' },
          { libraryId: 'lib-3' },
        ],
      });

      const service = new LibrarySyncService();
      await service.syncServer(mockServer.id);

      // Should delete for both orphaned libraries (2 deletes each: items + snapshots)
      const deleteCalls = vi.mocked(db.delete).mock.calls;
      expect(deleteCalls.length).toBeGreaterThanOrEqual(4);

      // Aggregate refresh should be called
      expect(countAggregateRefreshCalls()).toBe(2);
    });

    it('should skip aggregate refresh when only items are orphaned (no snapshots)', async () => {
      const mockServer = createMockServer();
      const libraries = [createMockLibrary({ id: 'lib-2', name: 'Current' })];

      setupSyncWithOrphans({
        server: mockServer,
        libraries,
        items: [createMockLibraryItem()],
        // Orphaned lib-1 only in items, not in snapshots
        itemLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
        snapshotLibraryIds: [{ libraryId: 'lib-2' }],
      });

      const service = new LibrarySyncService();
      await service.syncServer(mockServer.id);

      // Delete should be called for orphan cleanup
      expect(db.delete).toHaveBeenCalled();

      // No orphaned snapshots = no aggregate refresh
      expect(countAggregateRefreshCalls()).toBe(0);
    });

    it('should not fail sync when aggregate refresh throws', async () => {
      const mockServer = createMockServer();
      const libraries = [createMockLibrary({ id: 'lib-2', name: 'Current' })];

      setupSyncWithOrphans({
        server: mockServer,
        libraries,
        items: [createMockLibraryItem()],
        itemLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
        snapshotLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
      });

      // Make aggregate refresh fail
      vi.mocked(db.execute).mockRejectedValue(new Error('TimescaleDB not available'));
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const service = new LibrarySyncService();

      // Sync should complete without throwing
      await expect(service.syncServer(mockServer.id)).resolves.not.toThrow();

      // Warning should be logged
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to refresh aggregates'),
        expect.any(Error)
      );

      warnSpy.mockRestore();
    });

    it('should not delete all data when server returns 0 libraries', async () => {
      const mockServer = createMockServer();

      setupSyncWithOrphans({
        server: mockServer,
        libraries: [], // Server returned no libraries (e.g., during restart)
        items: [],
        // DB has existing data that should NOT be deleted
        itemLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
        snapshotLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }],
      });

      const service = new LibrarySyncService();
      await service.syncServer(mockServer.id);

      expect((db as any).selectDistinct).not.toHaveBeenCalled();
      // No aggregate refresh either
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('should continue cleanup if one library delete fails (compressed chunks)', async () => {
      const mockServer = createMockServer();
      const libraries = [createMockLibrary({ id: 'lib-3', name: 'Current' })];

      setupSyncWithOrphans({
        server: mockServer,
        libraries,
        items: [createMockLibraryItem()],
        // Two orphaned libraries
        itemLibraryIds: [{ libraryId: 'lib-1' }, { libraryId: 'lib-2' }, { libraryId: 'lib-3' }],
        snapshotLibraryIds: [
          { libraryId: 'lib-1' },
          { libraryId: 'lib-2' },
          { libraryId: 'lib-3' },
        ],
      });

      // Make delete throw on the first call (simulating compressed chunk error)
      // then succeed on subsequent calls
      let deleteCallCount = 0;
      vi.mocked(db.delete).mockImplementation(() => {
        deleteCallCount++;
        const callIndex = deleteCallCount;
        return {
          where: vi.fn().mockImplementation(() => {
            // Fail on the very first orphan delete (lib-1 items)
            const settled =
              callIndex === 1
                ? Promise.reject(new Error('cannot delete from compressed chunk'))
                : Promise.resolve(undefined);
            // Awaitable directly AND chains .returning(), matching mockDeleteChain above.
            return Object.assign(settled, {
              returning: vi.fn().mockImplementation(() => settled.then(() => [])),
            });
          }),
        } as never;
      });

      // eslint-disable-next-line @typescript-eslint/no-empty-function
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const service = new LibrarySyncService();
      // Sync should complete without throwing
      await expect(service.syncServer(mockServer.id)).resolves.not.toThrow();

      // Should have warned about the failed library
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to clean up orphaned library'),
        expect.any(Error)
      );

      // Second orphaned library should still have been attempted
      expect(deleteCallCount).toBeGreaterThan(1);

      warnSpy.mockRestore();
    });
  });

  describe('library name sync', () => {
    it('upserts name and media type for every reported library', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [
        createMockLibrary({ id: 'lib-1', name: 'Movies', type: 'movie' }),
        createMockLibrary({ id: 'lib-2', name: '4K Movies', type: 'movie' }),
      ];

      setupSelectForIncrementalTest(mockServer);
      mockSelectDistinctChain([[], []]);
      const insertChain = mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({ libraries: mockLibraries, items: [], totalCount: 0 });

      await service.syncServer(mockServer.id);

      const insertCallIndex = vi
        .mocked(db.insert)
        .mock.calls.findIndex(([table]) => table === librariesTable);
      expect(insertCallIndex).toBeGreaterThanOrEqual(0);
      expect(insertChain.values).toHaveBeenNthCalledWith(insertCallIndex + 1, [
        { serverId: mockServer.id, libraryId: 'lib-1', name: 'Movies', mediaType: 'movie' },
        { serverId: mockServer.id, libraryId: 'lib-2', name: '4K Movies', mediaType: 'movie' },
      ]);
    });

    it('strips NUL bytes from library names before the upsert', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [
        createMockLibrary({ id: 'lib-1', name: 'Movies\u0000', type: 'movie\u0000' }),
      ];

      setupSelectForIncrementalTest(mockServer);
      mockSelectDistinctChain([[], []]);
      const insertChain = mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({ libraries: mockLibraries, items: [], totalCount: 0 });

      await service.syncServer(mockServer.id);

      const insertCallIndex = vi
        .mocked(db.insert)
        .mock.calls.findIndex(([table]) => table === librariesTable);
      expect(insertCallIndex).toBeGreaterThanOrEqual(0);
      expect(insertChain.values).toHaveBeenNthCalledWith(insertCallIndex + 1, [
        { serverId: mockServer.id, libraryId: 'lib-1', name: 'Movies', mediaType: 'movie' },
      ]);
    });

    it('continues the sync when the library name upsert throws', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      setupSelectForIncrementalTest(mockServer);
      mockSelectDistinctChain([[], []]);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: [createMockLibrary({ id: 'lib-1', name: 'Movies', type: 'movie' })],
        items: [createMockLibraryItem({ ratingKey: 'item-1' })],
        totalCount: 1,
      });
      vi.spyOn(
        service as unknown as { syncLibraryNames: () => Promise<void> },
        'syncLibraryNames'
      ).mockRejectedValueOnce(new Error('invalid byte sequence for encoding "UTF8": 0x00'));

      const results = await service.syncServer(mockServer.id);

      expect(results).toHaveLength(1);
      expect(reconcileMediaDuplicates).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Library name sync failed'),
        expect.any(Error)
      );

      warnSpy.mockRestore();
    });

    it('deletes libraries the server no longer reports', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [createMockLibrary({ id: 'lib-1', name: 'Movies', type: 'movie' })];

      setupSelectForIncrementalTest(mockServer);
      mockSelectDistinctChain([[], []]);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({ libraries: mockLibraries, items: [], totalCount: 0 });

      await service.syncServer(mockServer.id);

      const deleteCallIndex = vi
        .mocked(db.delete)
        .mock.calls.findIndex(([table]) => table === librariesTable);
      expect(deleteCallIndex).toBeGreaterThanOrEqual(0);
    });

    it('skips upsert and delete when the server reports zero libraries', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();

      setupSelectForIncrementalTest(mockServer);
      mockSelectDistinctChain([[], []]);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({ libraries: [], items: [], totalCount: 0 });

      await service.syncServer(mockServer.id);

      expect(vi.mocked(db.insert).mock.calls.some(([table]) => table === librariesTable)).toBe(
        false
      );
      expect(vi.mocked(db.delete).mock.calls.some(([table]) => table === librariesTable)).toBe(
        false
      );
    });
  });
});
