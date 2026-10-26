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

const mockMediaListeners = vi.fn().mockResolvedValue({ added: false, upgraded: false });
const mockDispatchMediaAdded = vi.fn();
const mockDispatchMediaUpgraded = vi.fn();
vi.mock('../automations/events/producers.js', () => ({
  mediaListeners: (...args: unknown[]) => mockMediaListeners(...args),
  dispatchMediaAdded: (...args: unknown[]) => mockDispatchMediaAdded(...args),
  dispatchMediaUpgraded: (...args: unknown[]) => mockDispatchMediaUpgraded(...args),
}));

vi.mock('../../jobs/sessionIdentityBackfill.js', () => ({
  IDENTITY_PASSES_VERSION: 1,
  backfillSessionIdentityBatch: vi.fn().mockResolvedValue({ updated: 0, oldest: null }),
  hasStampableSessionsBefore: vi.fn().mockResolvedValue(false),
  fullScanFloors: vi.fn().mockResolvedValue(new Map()),
  unhandledGoneKeyFloors: vi.fn().mockResolvedValue(new Map()),
  markGoneKeyFloorsHandled: vi.fn().mockResolvedValue(undefined),
  hasConfirmedAbsentTrackedRows: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../jobs/maintenanceQueue.js', () => ({
  maybeEnqueueMaintenanceJob: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../jobs/heavyOpsLock.js', () => ({
  getHeavyOpsStatus: vi.fn().mockResolvedValue(null),
}));

vi.mock('../settings.js', () => ({
  getImportedHistoryLinkState: vi.fn(),
  getSetting: vi.fn(),
  getSettings: vi.fn(),
  setImportedHistoryLinkState: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock('../../jobs/importedHistoryLinking.js', () => ({
  listPlexServers: vi.fn(),
  MAX_AUTO_LINK_ATTEMPTS: 5,
  AUTO_LINK_WINDOW_MS: 14 * 24 * 60 * 60 * 1000,
}));

// Only the compression-horizon probe is stubbed; the aggregate refresh paths stay
// real so the db.execute assertions below still measure refresh behavior rather
// than this one extra catalog read at the tail of every sync.
vi.mock('../../db/timescale.js', async (importOriginal) => ({
  ...(await importOriginal<typeof TimescaleModule>()),
  getSessionsCompressionHorizon: vi.fn().mockResolvedValue(null),
  refreshAggregates: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocking
import { db } from '../../db/client.js';
import { renderSql } from '../../test/helpers.js';
import { libraries as librariesTable } from '../../db/schema.js';
import { createMediaServerClient } from '../mediaServer/index.js';
import { reconcileMediaDuplicates, resolveMediaBatch } from '../library/mediaResolutionService.js';
import {
  IDENTITY_PASSES_VERSION,
  backfillSessionIdentityBatch,
  hasStampableSessionsBefore,
  hasConfirmedAbsentTrackedRows,
  unhandledGoneKeyFloors,
  markGoneKeyFloorsHandled,
  fullScanFloors,
} from '../../jobs/sessionIdentityBackfill.js';
import { maybeEnqueueMaintenanceJob } from '../../jobs/maintenanceQueue.js';
import { getHeavyOpsStatus } from '../../jobs/heavyOpsLock.js';
import { listPlexServers } from '../../jobs/importedHistoryLinking.js';
import { getSessionsCompressionHorizon, refreshAggregates } from '../../db/timescale.js';
import {
  getImportedHistoryLinkState,
  getSetting,
  getSettings,
  setImportedHistoryLinkState,
  setSetting,
} from '../settings.js';
import {
  LibrariesFailedError,
  LibrarySyncService,
  initLibrarySyncRedis,
  _resetAutoBackfillThrottleForTests,
  _resetImportedHistoryLinkThrottleForTests,
  _resetReconcileThrottleForTests,
  maybeEnqueueImportedHistoryLink,
} from '../librarySync.js';
import { MEDIA_BUFFER_CAP, flushMediaAnnounceRun } from '../library/mediaAnnounce.js';
import type { IMediaServerClient, MediaLibraryItem } from '../mediaServer/types.js';
import type { LibrarySyncProgress } from '@tracearr/shared';
import type { Redis } from 'ioredis';

// ============================================================================
// Test Data Factories
// ============================================================================

const LINK_DONE = { state: 'done', providerPassDoneServers: [], autoAttempts: 0, generation: 0 };
const NO_TAUTULLI = { tautulliUrl: null, tautulliApiKey: null };
const TAUTULLI = { tautulliUrl: 'http://tautulli.local:8181', tautulliApiKey: 'key' };

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

/**
 * The first select is the server lookup; every later one (previous item keys and the
 * rest) finds nothing, through either an awaited .where() or a .limit().
 */
function mockServerThenEmpty(server: ReturnType<typeof createMockServer>) {
  let selectCallCount = 0;
  vi.mocked(db.select).mockImplementation(() => {
    selectCallCount++;
    const rows = () => Promise.resolve(selectCallCount === 1 ? [server] : []);
    const chain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        const whereResult = Promise.resolve([]);
        (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
          .fn()
          .mockImplementation(rows);
        return whereResult;
      }),
      limit: vi.fn().mockImplementation(rows),
      returning: vi.fn().mockResolvedValue([]),
    };
    return chain as never;
  });
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
    getLibraryLeaves: undefined as IMediaServerClient['getLibraryLeaves'],
    getLibraryAlbums: undefined as IMediaServerClient['getLibraryAlbums'],
    getLibraryAlbumsSince: undefined as IMediaServerClient['getLibraryAlbumsSince'],
    findExistingRatingKeys: undefined as
      | undefined
      | ((ratingKeys: string[], library: { id: string; type: string }) => Promise<Set<string>>),
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

/** Prior sync state, read in getSyncState order: last synced, item count, full scan, shortfall, scan version. */
function syncStateReads(lastSyncedAt: string, lastItemCount: string) {
  return vi
    .fn()
    .mockResolvedValueOnce(lastSyncedAt)
    .mockResolvedValueOnce(lastItemCount)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce('4');
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
  _resetImportedHistoryLinkThrottleForTests();
  _resetReconcileThrottleForTests();
  vi.mocked(getImportedHistoryLinkState).mockResolvedValue(LINK_DONE as never);
  vi.mocked(getSettings).mockResolvedValue(NO_TAUTULLI as never);
  // Settings read as a current install: the passes version is the code's, counters are zero.
  vi.mocked(getSetting).mockImplementation((async (key: string) =>
    key === 'identityPassesVersion' ? IDENTITY_PASSES_VERSION : 0) as never);
  vi.mocked(listPlexServers).mockResolvedValue([]);
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

      mockServerThenEmpty(mockServer);

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

    it('syncs the other libraries when one fails, then reports the failure with their results', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      mockServerThenEmpty(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      const client = mockMediaServerClient({
        libraries: [
          createMockLibrary({ id: '1', name: 'Movies' }),
          createMockLibrary({ id: '2', name: 'TV Shows', type: 'show' }),
        ],
        items: [createMockLibraryItem({ ratingKey: 'item-1' })],
        totalCount: 1,
      });
      const listing = client.getLibraryItems.getMockImplementation();
      client.getLibraryItems.mockImplementation((libraryId: string, ...rest: unknown[]) =>
        libraryId === '1'
          ? Promise.reject(new Error('plex request to /library/sections/1/all timed out'))
          : listing?.(libraryId, ...rest)
      );

      const error = await service.syncServer(mockServer.id).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LibrariesFailedError);
      expect((error as LibrariesFailedError).message).toBe(
        'Library sync failed for Movies (plex request to /library/sections/1/all timed out)'
      );
      expect((error as LibrariesFailedError).results.map((r) => r.libraryName)).toEqual([
        'TV Shows',
      ]);
    });

    it('continues past a failed session-identity backfill and still reconciles media duplicates', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [createMockLibrary({ id: '1', name: 'Movies' })];
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];

      mockServerThenEmpty(mockServer);

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

      expect(hasStampableSessionsBefore).toHaveBeenCalledWith(horizon, mockServer.id, ['item-1']);
      expect(maybeEnqueueMaintenanceJob).toHaveBeenCalledWith(
        'backfill_session_identity',
        'system',
        { trigger: 'auto' }
      );
    });

    it('stops handing compressed history to the walk after five failed automatic walks', async () => {
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
      vi.mocked(getSetting).mockResolvedValue(5 as never);

      await service.syncServer(mockServer.id);

      expect(getSetting).toHaveBeenCalledWith('identityBackfillAutoAttempts');
      expect(hasStampableSessionsBefore).not.toHaveBeenCalled();
      expect(maybeEnqueueMaintenanceJob).not.toHaveBeenCalled();
    });

    it('skips the identity tail on a sync that upserted nothing', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: [createMockLibrary({ id: '1', name: 'Movies' })],
        items: [],
        totalCount: 0,
      });

      await service.syncServer(mockServer.id);

      expect(backfillSessionIdentityBatch).not.toHaveBeenCalled();
      expect(hasStampableSessionsBefore).not.toHaveBeenCalled();
    });

    it('runs the identity tail once after an upgrade added a pass, even when the sync upserted nothing', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const idle = () => {
        setupSelectForIncrementalTest(mockServer);
        mockInsertChain([{ id: randomUUID() }]);
        mockDeleteChain();
        mockTransaction();
        mockMediaServerClient({
          libraries: [createMockLibrary({ id: '1', name: 'Movies' })],
          items: [],
          totalCount: 0,
        });
      };
      vi.mocked(getSetting).mockImplementation((async (key: string) =>
        key === 'identityPassesVersion' ? IDENTITY_PASSES_VERSION - 1 : 0) as never);

      // Compressed history: the walk is queued without the probe, under the enqueue floor.
      idle();
      vi.mocked(getSessionsCompressionHorizon).mockResolvedValueOnce(
        new Date('2026-07-01T00:00:00.000Z')
      );
      await service.syncServer(mockServer.id);
      expect(backfillSessionIdentityBatch).toHaveBeenCalledTimes(1);
      expect(backfillSessionIdentityBatch).toHaveBeenCalledWith(
        10000,
        { start: new Date('2026-07-01T00:00:00.000Z') },
        undefined,
        { resolveImports: true, absentKeyFloors: new Map() }
      );
      expect(hasStampableSessionsBefore).not.toHaveBeenCalled();
      expect(maybeEnqueueMaintenanceJob).toHaveBeenCalledWith(
        'backfill_session_identity',
        'system',
        { trigger: 'auto' }
      );
      expect(setSetting).not.toHaveBeenCalledWith('identityPassesVersion', expect.anything());

      // Nothing compressed: the inline batch covered everything, so the version is stamped here.
      _resetAutoBackfillThrottleForTests();
      idle();
      vi.mocked(getSessionsCompressionHorizon).mockResolvedValueOnce(null);
      await service.syncServer(mockServer.id);
      expect(backfillSessionIdentityBatch).toHaveBeenCalledTimes(2);
      expect(setSetting).toHaveBeenCalledWith('identityPassesVersion', IDENTITY_PASSES_VERSION);
    });

    it('follows a full inline batch from its cursor when nothing is compressed, stamping the version only once a batch comes back short', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: [createMockLibrary({ id: '1', name: 'Movies' })],
        items: [],
        totalCount: 0,
      });
      vi.mocked(getSetting).mockImplementation((async (key: string) =>
        key === 'identityPassesVersion' ? IDENTITY_PASSES_VERSION - 1 : 0) as never);
      vi.mocked(getSessionsCompressionHorizon).mockResolvedValueOnce(null);
      const cursor = [null, null, null, '2026-05-01T00:00:00.000Z'];
      vi.mocked(backfillSessionIdentityBatch)
        .mockResolvedValueOnce({
          updated: 10000,
          examined: 10000,
          oldest: new Date('2026-05-01T00:00:00.000Z'),
          cursor,
        } as never)
        .mockResolvedValueOnce({
          updated: 40,
          examined: 40,
          oldest: new Date('2026-04-02T00:00:00.000Z'),
          cursor: [null, null, null, null],
        } as never);

      await service.syncServer(mockServer.id);

      expect(backfillSessionIdentityBatch).toHaveBeenCalledTimes(2);
      expect(backfillSessionIdentityBatch).toHaveBeenLastCalledWith(10000, undefined, cursor, {
        resolveImports: true,
        absentKeyFloors: new Map(),
      });
      expect(refreshAggregates).toHaveBeenCalledWith({
        startTime: new Date('2026-04-02T00:00:00.000Z'),
        endTime: expect.any(Date),
      });
      expect(setSetting).toHaveBeenCalledWith('identityPassesVersion', IDENTITY_PASSES_VERSION);
    });

    it('resolves tracked plays on confirmed-gone keys in the tail without a library change, and queues the walk for compressed ones', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: [createMockLibrary({ id: '1', name: 'Movies' })],
        items: [],
        totalCount: 0,
      });
      const floors = new Map([[mockServer.id, new Date('2026-09-01T00:00:00.000Z')]]);
      const windows = new Map([
        [mockServer.id, { floor: new Date('2026-09-01T00:00:00.000Z'), after: null }],
      ]);
      vi.mocked(fullScanFloors).mockResolvedValue(floors);
      vi.mocked(unhandledGoneKeyFloors).mockResolvedValue(windows);
      vi.mocked(hasConfirmedAbsentTrackedRows).mockResolvedValue(true);
      vi.mocked(getSessionsCompressionHorizon).mockResolvedValueOnce(
        new Date('2026-07-01T00:00:00.000Z')
      );

      await service.syncServer(mockServer.id);

      expect(backfillSessionIdentityBatch).toHaveBeenCalledWith(
        10000,
        { start: new Date('2026-07-01T00:00:00.000Z') },
        undefined,
        { resolveImports: true, absentKeyFloors: windows }
      );
      expect(maybeEnqueueMaintenanceJob).toHaveBeenCalledWith(
        'backfill_session_identity',
        'system',
        { trigger: 'auto' }
      );
      // Rows below the horizon are the walk's to finish; it marks the floor when it completes.
      expect(markGoneKeyFloorsHandled).not.toHaveBeenCalled();

      // Once the walk has handled the floor, a tail with nothing else to do runs no batch and queues nothing.
      vi.mocked(unhandledGoneKeyFloors).mockResolvedValue(new Map());
      vi.mocked(hasConfirmedAbsentTrackedRows).mockResolvedValue(false);
      vi.clearAllMocks();
      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: [createMockLibrary({ id: '1', name: 'Movies' })],
        items: [],
        totalCount: 0,
      });
      await service.syncServer(mockServer.id);
      expect(backfillSessionIdentityBatch).not.toHaveBeenCalled();
      expect(maybeEnqueueMaintenanceJob).not.toHaveBeenCalled();
      vi.mocked(fullScanFloors).mockResolvedValue(new Map());
    });

    it('marks a gone-key floor handled only once nothing below the horizon is owed and the inline batch was not full', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const idle = () => {
        setupSelectForIncrementalTest(mockServer);
        mockInsertChain([{ id: randomUUID() }]);
        mockDeleteChain();
        mockTransaction();
        mockMediaServerClient({
          libraries: [createMockLibrary({ id: '1', name: 'Movies' })],
          items: [],
          totalCount: 0,
        });
      };
      const floors = new Map([[mockServer.id, new Date('2026-09-01T00:00:00.000Z')]]);
      const windows = new Map([
        [mockServer.id, { floor: new Date('2026-09-01T00:00:00.000Z'), after: null }],
      ]);
      vi.mocked(fullScanFloors).mockResolvedValue(floors);
      vi.mocked(unhandledGoneKeyFloors).mockResolvedValue(windows);
      vi.mocked(hasConfirmedAbsentTrackedRows).mockResolvedValue(true);

      // Rows below the horizon and the enqueue throttled: the walk is owed, the floor stays open.
      idle();
      vi.mocked(getSessionsCompressionHorizon).mockResolvedValueOnce(
        new Date('2026-07-01T00:00:00.000Z')
      );
      vi.mocked(maybeEnqueueMaintenanceJob).mockResolvedValueOnce(null);
      await service.syncServer(mockServer.id);
      expect(maybeEnqueueMaintenanceJob).toHaveBeenCalledTimes(1);
      expect(markGoneKeyFloorsHandled).not.toHaveBeenCalled();

      // A later tail tries the enqueue again; the walk, not the tail, will mark the floor.
      _resetAutoBackfillThrottleForTests();
      idle();
      vi.mocked(getSessionsCompressionHorizon).mockResolvedValueOnce(
        new Date('2026-07-01T00:00:00.000Z')
      );
      await service.syncServer(mockServer.id);
      expect(maybeEnqueueMaintenanceJob).toHaveBeenCalledTimes(2);
      expect(markGoneKeyFloorsHandled).not.toHaveBeenCalled();

      // Nothing compressed but the inline batch came back full: more rows may remain.
      idle();
      vi.mocked(getSessionsCompressionHorizon).mockResolvedValueOnce(null);
      vi.mocked(backfillSessionIdentityBatch).mockResolvedValueOnce({
        updated: 10000,
        examined: 10000,
        oldest: null,
      } as never);
      await service.syncServer(mockServer.id);
      expect(markGoneKeyFloorsHandled).not.toHaveBeenCalled();

      // Nothing compressed and a partial batch: handled.
      idle();
      vi.mocked(getSessionsCompressionHorizon).mockResolvedValueOnce(null);
      vi.mocked(backfillSessionIdentityBatch).mockResolvedValueOnce({
        updated: 3,
        examined: 3,
        oldest: null,
      } as never);
      await service.syncServer(mockServer.id);
      expect(markGoneKeyFloorsHandled).toHaveBeenCalledWith(windows);

      vi.mocked(fullScanFloors).mockResolvedValue(new Map());
      vi.mocked(unhandledGoneKeyFloors).mockResolvedValue(new Map());
      vi.mocked(hasConfirmedAbsentTrackedRows).mockResolvedValue(false);
    });

    it('marks an unhandled floor handled when no gone-key row sits under it', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      mockMediaServerClient({
        libraries: [createMockLibrary({ id: '1', name: 'Movies' })],
        items: [],
        totalCount: 0,
      });
      const floors = new Map([[mockServer.id, new Date('2026-09-01T00:00:00.000Z')]]);
      const windows = new Map([
        [mockServer.id, { floor: new Date('2026-09-01T00:00:00.000Z'), after: null }],
      ]);
      vi.mocked(fullScanFloors).mockResolvedValue(floors);
      vi.mocked(unhandledGoneKeyFloors).mockResolvedValue(windows);
      vi.mocked(hasConfirmedAbsentTrackedRows).mockResolvedValue(false);

      await service.syncServer(mockServer.id);

      expect(backfillSessionIdentityBatch).not.toHaveBeenCalled();
      expect(markGoneKeyFloorsHandled).toHaveBeenCalledWith(windows);
      vi.mocked(fullScanFloors).mockResolvedValue(new Map());
      vi.mocked(unhandledGoneKeyFloors).mockResolvedValue(new Map());
    });

    it('skips the identity tail while an import or maintenance job holds the heavy-ops lock', async () => {
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
      vi.mocked(getHeavyOpsStatus).mockResolvedValue({
        jobType: 'maintenance',
        jobId: 'maintenance-1',
        description: 'Backfilling media identity',
        startedAt: new Date().toISOString(),
        runToken: 'token',
      });

      await service.syncServer(mockServer.id);

      expect(backfillSessionIdentityBatch).not.toHaveBeenCalled();
      vi.mocked(getHeavyOpsStatus).mockResolvedValue(null);
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
      // answering true forever; the enqueue floor is what stops the second
      // sync from queueing it again.
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

    it('probes at most once a day once a probe finds nothing', async () => {
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
      vi.mocked(hasStampableSessionsBefore).mockResolvedValue(false);

      // Plex marks every metadata touch as an upsert, so event syncs that
      // upsert items fire twice a minute. A no has to close the gate for the
      // day, or the probe runs on every one of them.
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
      expect(backfillSessionIdentityBatch).toHaveBeenCalledWith(10000, undefined, undefined, {
        resolveImports: false,
        absentKeyFloors: new Map(),
      });
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

    describe('imported history link hand-off', () => {
      const noPendingSync = async () => false;

      async function runPlexSync(
        service: LibrarySyncService,
        server: ReturnType<typeof createMockServer>
      ) {
        setupSelectForIncrementalTest(server);
        mockSelectDistinctChain([[], []]);
        mockInsertChain([{ id: randomUUID() }]);
        mockDeleteChain();
        mockTransaction();
        mockMediaServerClient({
          libraries: [createMockLibrary({ id: '1', name: 'Movies' })],
          items: [createMockLibraryItem({ ratingKey: 'item-1' })],
          totalCount: 1,
        });
        await service.syncServer(server.id);
      }

      afterEach(() => {
        vi.mocked(getSessionsCompressionHorizon).mockResolvedValue(null);
        vi.mocked(hasStampableSessionsBefore).mockResolvedValue(false);
        vi.mocked(maybeEnqueueMaintenanceJob).mockResolvedValue(null);
      });

      it('never enqueues the link job once it is done or out of automatic attempts', async () => {
        vi.mocked(getSettings).mockResolvedValue(TAUTULLI as never);

        await maybeEnqueueImportedHistoryLink(true, noPendingSync);
        vi.mocked(getImportedHistoryLinkState).mockResolvedValue({
          state: 'pending',
          providerPassDoneServers: [],
          autoAttempts: 5,
          generation: 0,
        } as never);
        await maybeEnqueueImportedHistoryLink(true, noPendingSync);

        expect(maybeEnqueueMaintenanceJob).not.toHaveBeenCalled();
        expect(setImportedHistoryLinkState).not.toHaveBeenCalled();
      });

      it('marks linking done without enqueueing when Tautulli is not configured and every Plex server finished the provider pass', async () => {
        const armedAt = new Date().toISOString();
        vi.mocked(getImportedHistoryLinkState).mockResolvedValue({
          state: 'pending',
          providerPassDoneServers: ['plex-a', 'plex-b'],
          autoAttempts: 2,
          generation: 4,
          armedAt,
        } as never);
        vi.mocked(listPlexServers).mockResolvedValue([
          { id: 'plex-a', name: 'Home', machineIdentifier: null },
          { id: 'plex-b', name: 'Office', machineIdentifier: null },
        ]);

        await maybeEnqueueImportedHistoryLink(false, noPendingSync);

        expect(setImportedHistoryLinkState).toHaveBeenCalledWith(4, {
          state: 'done',
          providerPassDoneServers: ['plex-a', 'plex-b'],
          autoAttempts: 0,
          generation: 4,
          armedAt,
        });
        expect(maybeEnqueueMaintenanceJob).not.toHaveBeenCalled();
      });

      it('marks linking done for a Tautulli-less install even after the 14-day window has passed', async () => {
        vi.mocked(getImportedHistoryLinkState).mockResolvedValue({
          state: 'pending',
          providerPassDoneServers: ['plex-a'],
          autoAttempts: 0,
          generation: 1,
          armedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
        } as never);
        vi.mocked(listPlexServers).mockResolvedValue([
          { id: 'plex-a', name: 'Home', machineIdentifier: null },
        ]);

        await maybeEnqueueImportedHistoryLink(false, noPendingSync);

        expect(setImportedHistoryLinkState).toHaveBeenCalledWith(
          1,
          expect.objectContaining({ state: 'done' })
        );
        expect(maybeEnqueueMaintenanceJob).not.toHaveBeenCalled();
      });

      it('waits without stamping its throttle while any Plex server has a library sync pending', async () => {
        vi.mocked(getSettings).mockResolvedValue(TAUTULLI as never);
        vi.mocked(getImportedHistoryLinkState).mockResolvedValue({
          state: 'pending',
          providerPassDoneServers: [],
          autoAttempts: 0,
          generation: 0,
          armedAt: new Date().toISOString(),
        } as never);
        vi.mocked(listPlexServers).mockResolvedValue([
          { id: 'plex-a', name: 'Home', machineIdentifier: null },
          { id: 'plex-b', name: 'Office', machineIdentifier: null },
        ]);
        vi.mocked(maybeEnqueueMaintenanceJob).mockResolvedValue('maintenance-job-1');

        await maybeEnqueueImportedHistoryLink(true, async (serverId) => serverId === 'plex-b');
        expect(maybeEnqueueMaintenanceJob).not.toHaveBeenCalled();

        await maybeEnqueueImportedHistoryLink(false, noPendingSync);
        expect(maybeEnqueueMaintenanceJob).toHaveBeenCalledWith('link_imported_history', 'system', {
          trigger: 'auto',
        });
      });

      it('stops enqueueing 14 days after the last re-arm', async () => {
        vi.mocked(getSettings).mockResolvedValue(TAUTULLI as never);
        vi.mocked(maybeEnqueueMaintenanceJob).mockResolvedValue('maintenance-job-1');
        const armed = (days: number) =>
          ({
            state: 'pending',
            providerPassDoneServers: [],
            autoAttempts: 0,
            generation: 0,
            armedAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
          }) as never;

        vi.mocked(getImportedHistoryLinkState).mockResolvedValue(armed(14.5));
        await maybeEnqueueImportedHistoryLink(true, noPendingSync);
        expect(maybeEnqueueMaintenanceJob).not.toHaveBeenCalled();

        vi.mocked(getImportedHistoryLinkState).mockResolvedValue(armed(13.5));
        await maybeEnqueueImportedHistoryLink(true, noPendingSync);
        expect(maybeEnqueueMaintenanceJob).toHaveBeenCalledTimes(1);
      });

      it('leaves its throttle unstamped when the maintenance queue refuses the job', async () => {
        vi.mocked(getSettings).mockResolvedValue(TAUTULLI as never);
        vi.mocked(getImportedHistoryLinkState).mockResolvedValue({
          state: 'pending',
          providerPassDoneServers: [],
          autoAttempts: 0,
          generation: 0,
          armedAt: new Date().toISOString(),
        } as never);
        vi.mocked(listPlexServers).mockResolvedValue([
          { id: 'plex-a', name: 'Home', machineIdentifier: null },
        ]);
        vi.mocked(maybeEnqueueMaintenanceJob).mockResolvedValueOnce(null);

        await maybeEnqueueImportedHistoryLink(true, noPendingSync);
        vi.mocked(maybeEnqueueMaintenanceJob).mockResolvedValueOnce('maintenance-job-1');
        await maybeEnqueueImportedHistoryLink(false, noPendingSync);

        expect(maybeEnqueueMaintenanceJob).toHaveBeenCalledTimes(2);
      });

      it('enqueues the link job on its own throttle, leaving the identity backfill free to enqueue, and never from the sync tail', async () => {
        const service = new LibrarySyncService();
        const server = createMockServer();
        vi.mocked(getSettings).mockResolvedValue(TAUTULLI as never);
        vi.mocked(getImportedHistoryLinkState).mockResolvedValue({
          state: 'pending',
          providerPassDoneServers: [],
          autoAttempts: 0,
          generation: 0,
          armedAt: new Date().toISOString(),
        } as never);
        vi.mocked(getSessionsCompressionHorizon).mockResolvedValue(
          new Date('2026-07-01T00:00:00.000Z')
        );
        vi.mocked(maybeEnqueueMaintenanceJob).mockResolvedValue('maintenance-job-1');

        await maybeEnqueueImportedHistoryLink(true, noPendingSync);
        expect(maybeEnqueueMaintenanceJob).toHaveBeenCalledWith('link_imported_history', 'system', {
          trigger: 'auto',
        });

        await maybeEnqueueImportedHistoryLink(true, noPendingSync);
        const linkEnqueues = () =>
          vi
            .mocked(maybeEnqueueMaintenanceJob)
            .mock.calls.filter((c) => c[0] === 'link_imported_history');
        expect(linkEnqueues()).toHaveLength(1);

        _resetImportedHistoryLinkThrottleForTests();
        vi.mocked(hasStampableSessionsBefore).mockResolvedValue(true);
        await runPlexSync(service, server);

        expect(maybeEnqueueMaintenanceJob).toHaveBeenCalledWith(
          'backfill_session_identity',
          'system',
          { trigger: 'auto' }
        );
        expect(linkEnqueues()).toHaveLength(1);
      });
    });

    it('does not truncate a full scan when a page is all extras', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const mockLibraries = [createMockLibrary({ id: '1', name: 'Movies' })];
      const realItem = createMockLibraryItem({ ratingKey: 'item-real' });

      mockServerThenEmpty(mockServer);

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

    describe('page pacing', () => {
      async function runTwoPageScan(pageMs: number) {
        const service = new LibrarySyncService();
        const mockServer = createMockServer();
        let selectCallCount = 0;
        vi.mocked(db.select).mockImplementation(() => {
          selectCallCount++;
          const first = () => Promise.resolve(selectCallCount === 1 ? [mockServer] : []);
          const chain = {
            from: vi.fn().mockReturnThis(),
            innerJoin: vi.fn().mockReturnThis(),
            where: vi
              .fn()
              .mockImplementation(() =>
                Object.assign(Promise.resolve([]), { limit: vi.fn().mockImplementation(first) })
              ),
            limit: vi.fn().mockImplementation(first),
            returning: vi.fn().mockResolvedValue([]),
          };
          return chain as never;
        });
        mockInsertChain([{ id: randomUUID() }]);
        mockDeleteChain();
        mockTransaction();
        const client = mockMediaServerClient({
          libraries: [createMockLibrary({ id: '1', name: 'Movies' })],
          totalCount: 300,
        });
        client.getLibraryItems = vi.fn().mockImplementation(async (_id: string, opts?: unknown) => {
          const { offset } = (opts ?? {}) as { offset?: number };
          if (offset === undefined) return { items: [], totalCount: 300 };
          if (pageMs > 0) await new Promise((resolve) => setTimeout(resolve, pageMs));
          return {
            items: [createMockLibraryItem({ ratingKey: `item-${offset}` })],
            totalCount: 300,
            rawCount: offset === 0 ? 200 : 100,
          };
        });

        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        await service.syncServer(mockServer.id);
        expect(client.getLibraryItems).toHaveBeenCalledTimes(3);
        return setTimeoutSpy.mock.calls
          .map(([, ms]) => ms)
          .filter((ms): ms is number => typeof ms === 'number' && ms > 0 && ms <= 150);
      }

      it('waits the full pause after a page the server answered instantly', async () => {
        const pauses = await runTwoPageScan(0);

        expect(pauses).toHaveLength(1);
        expect(pauses[0]).toBeGreaterThan(0);
      });

      it('adds no pause after a page that took longer than the pause', async () => {
        const pauses = await runTwoPageScan(200);

        expect(pauses).toEqual([]);
      });
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

      mockServerThenEmpty(mockServer);

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

      mockServerThenEmpty(mockServer);

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

    it('writes plexGuid on insert and guards the conflict update with a plex_guid change', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const item = createMockLibraryItem({
        ratingKey: 'guid-key',
        plexGuid: 'plex://movie/5d776b59ad5437001f79c6f8',
      });

      const { insertChain } = mockTransaction();

      await service.upsertItems(serverId, libraryId, [item]);

      expect(insertChain.values).toHaveBeenCalledWith([
        expect.objectContaining({ plexGuid: 'plex://movie/5d776b59ad5437001f79c6f8' }),
      ]);

      const conflictArgs = insertChain.onConflictDoUpdate.mock.calls[0]![0] as {
        set: Record<string, unknown>;
        setWhere: SQL;
      };
      expect(conflictArgs.set).toHaveProperty('plexGuid');
      expect(renderSql(conflictArgs.setWhere).sql).toContain('plex_guid');
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
      const announce = {
        ...run,
        libraryName: 'Movies',
        run,
        listening: { added: true, upgraded: true },
      };
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
      const announce = {
        ...run,
        libraryName: 'Movies',
        run,
        listening: { added: true, upgraded: true },
      };
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

  describe('removal confirmation', () => {
    // item-2 is tracked but absent from the listing
    function setupMissingItemScan(mockServer: ReturnType<typeof createMockServer>) {
      const existingItems = [
        createMockDbItem({ ratingKey: 'item-1' }),
        createMockDbItem({ ratingKey: 'item-2' }),
      ];
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const rows = () =>
          selectCallCount === 1 ? Promise.resolve([mockServer]) : Promise.resolve(existingItems);
        const chain = {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            const whereResult = Promise.resolve(existingItems);
            (whereResult as typeof whereResult & { limit: typeof vi.fn }).limit = vi
              .fn()
              .mockImplementation(rows);
            return whereResult;
          }),
          limit: vi.fn().mockImplementation(rows),
          returning: vi.fn().mockResolvedValue([]),
        };
        return chain as never;
      });
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockUpdateChain();
      mockTransaction();
      return mockMediaServerClient({
        libraries: [createMockLibrary()],
        items: [createMockLibraryItem({ ratingKey: 'item-1' })],
        totalCount: 1,
      });
    }

    it('keeps a missing item the server still has', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const client = setupMissingItemScan(mockServer);
      client.findExistingRatingKeys = vi.fn().mockResolvedValue(new Set(['item-2']));

      const results = await service.syncServer(mockServer.id);

      expect(client.findExistingRatingKeys).toHaveBeenCalledWith(['item-2'], {
        id: '1',
        name: 'Movies',
        type: 'movie',
      });
      expect(results[0]!.itemsRemoved).toBe(0);
    });

    it('tombstones a missing item the server no longer has', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const client = setupMissingItemScan(mockServer);
      client.findExistingRatingKeys = vi.fn().mockResolvedValue(new Set());

      const results = await service.syncServer(mockServer.id);

      expect(results[0]!.itemsRemoved).toBe(1);
    });

    it('keeps every missing item when the existence check fails', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const client = setupMissingItemScan(mockServer);
      client.findExistingRatingKeys = vi.fn().mockRejectedValue(new Error('server went away'));

      const results = await service.syncServer(mockServer.id);

      expect(results[0]!.itemsRemoved).toBe(0);
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
      expect(client.getLibraryItems).toHaveBeenCalledWith('1', {
        offset: 0,
        limit: 200,
        libraryType: 'movie',
      });
      expect(client.getLibraryItemsSince).not.toHaveBeenCalled();
    });

    it('does full scan when totalCount < lastItemCount', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      // Redis says we had 100 items, but server now reports 90 — items were removed
      const mockRedis = createMockRedis({
        get: syncStateReads(new Date(Date.now() - 60_000).toISOString(), '100'),
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

      expect(client.getLibraryItems).toHaveBeenCalledWith('1', {
        offset: 0,
        limit: 200,
        libraryType: 'movie',
      });
      expect(client.getLibraryItemsSince).not.toHaveBeenCalled();
    });

    it('escalates to full scan when local active count drifts past the server total', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      const mockRedis = createMockRedis({
        // 20 min ago: outside COUNT_CHECK_MIN_INTERVAL_MS so the drift check runs
        get: syncStateReads(new Date(Date.now() - 20 * 60_000).toISOString(), '10'),
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

      expect(client.getLibraryItems).toHaveBeenCalledWith('1', {
        offset: 0,
        limit: 200,
        libraryType: 'movie',
      });
      expect(client.getLibraryItemsSince).not.toHaveBeenCalled();
    });

    it('escalates to full scan when an incremental sync finds no changes but the local active count is still below the server total (wrong tombstone)', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      const mockRedis = createMockRedis({
        // 20 min ago: outside COUNT_CHECK_MIN_INTERVAL_MS so the drift check runs
        get: syncStateReads(new Date(Date.now() - 20 * 60_000).toISOString(), '20'),
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
      expect(client.getLibraryItemsSince).toHaveBeenCalledWith('1', expect.any(Date), {
        libraryType: 'movie',
      });
      // The still-short post-sync count escalates to a full scan in the same run.
      expect(client.getLibraryItems).toHaveBeenCalledWith('1', {
        offset: 0,
        limit: 200,
        libraryType: 'movie',
      });
    });

    it('never escalates a music library, even with a local active count far below the server total', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockRedis = createMockRedis({
        // 20 min ago: the drift check window is open, yet music must still not escalate
        get: syncStateReads(new Date(Date.now() - 20 * 60_000).toISOString(), '20'),
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
      expect(client.getLibraryItemsSince).toHaveBeenCalledWith('1', expect.any(Date), {
        libraryType: 'artist',
      });
      expect(client.getLibraryItems).not.toHaveBeenCalledWith('1', {
        offset: 0,
        limit: 200,
        libraryType: 'movie',
      });
    });

    it('counts only top-level items for the mismatch check, never episodes, tracks, seasons or albums', async () => {
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
      expect(countQueries[0]).toContain(
        "media_type NOT IN ('episode', 'track', 'season', 'album')"
      );
      expect(countQueries[0]).toContain('removed_at IS NULL');
    });

    it('stays on the incremental path when local active count matches the server total', async () => {
      const mockServer = createMockServer({ id: serverId });
      const newItem = createMockLibraryItem({ ratingKey: 'new-item' });
      const mockRedis = createMockRedis({
        // 20 min ago: outside COUNT_CHECK_MIN_INTERVAL_MS so both count probes run
        get: syncStateReads(new Date(Date.now() - 20 * 60_000).toISOString(), '5'),
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

      expect(client.getLibraryItemsSince).toHaveBeenCalledWith('1', expect.any(Date), {
        libraryType: 'movie',
      });
      expect(client.getLibraryItems).not.toHaveBeenCalledWith('1', {
        offset: 0,
        limit: 200,
        libraryType: 'movie',
      });
    });

    it('does not run the count-mismatch check on a manual trigger', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      const mockRedis = createMockRedis({
        get: syncStateReads(new Date(Date.now() - 60_000).toISOString(), '1'),
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
        get: syncStateReads(new Date(Date.now() - 60_000).toISOString(), '1'),
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

      expect(client.getLibraryItems).toHaveBeenCalledWith('1', {
        offset: 0,
        limit: 200,
        libraryType: 'movie',
      });
      expect(client.getLibraryItemsSince).not.toHaveBeenCalled();
    });

    it('does incremental scan when conditions are met', async () => {
      const mockServer = createMockServer({ id: serverId });
      const newItem = createMockLibraryItem({ ratingKey: 'new-item' });
      const snapshotId = randomUUID();
      const lastSyncedAt = new Date(Date.now() - 60_000);
      const mockRedis = createMockRedis({
        get: syncStateReads(lastSyncedAt.toISOString(), '5'),
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

      expect(client.getLibraryItemsSince).toHaveBeenCalledWith('1', expect.any(Date), {
        libraryType: 'movie',
      });
      // A movie section's leaves are its items, so asking for both would upsert each twice
      expect(client.getLibraryLeavesSince).not.toHaveBeenCalled();
      expect(results[0]!.itemsAdded).toBe(1);
      expect(results[0]!.itemsRemoved).toBe(0);
      expect(results[0]!.snapshotId).toBe(snapshotId);
    });

    it('skips when incremental finds 0 items and count matches', async () => {
      const mockServer = createMockServer({ id: serverId });
      const lastSyncedAt = new Date(Date.now() - 60_000);
      const mockRedis = createMockRedis({
        get: syncStateReads(lastSyncedAt.toISOString(), '5'),
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
      expect(client.getLibraryLeavesSince).not.toHaveBeenCalled();
      expect(mockRedis.set).toHaveBeenCalled();
    });

    it('fetches new episodes even when no new shows exist', async () => {
      const mockServer = createMockServer({ id: serverId });
      const lastSyncedAt = new Date(Date.now() - 60_000);
      const newEpisode = createMockLibraryItem({ ratingKey: 'new-ep-1', mediaType: 'episode' });
      const mockRedis = createMockRedis({
        get: syncStateReads(lastSyncedAt.toISOString(), '5'),
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      // New episodes don't change the top-level active count.
      vi.mocked(db.execute).mockResolvedValue({ rows: [{ count: 5 }] } as never);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary({ name: 'TV Shows', type: 'show' })],
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

    it('fetches new Plex albums for a music library even when no new artists exist', async () => {
      const mockServer = createMockServer({ id: serverId });
      const lastSyncedAt = new Date(Date.now() - 60_000);
      const newAlbum = createMockLibraryItem({
        ratingKey: 'album-1',
        title: 'Mezzanine',
        mediaType: 'album',
        parentRatingKey: 'artist-1',
        fileSize: undefined,
      });
      const mockRedis = createMockRedis({
        get: syncStateReads(lastSyncedAt.toISOString(), '5'),
      });
      initLibrarySyncRedis(mockRedis);

      setupSelectForIncrementalTest(mockServer);
      vi.mocked(db.execute).mockResolvedValue({ rows: [{ count: 5 }] } as never);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();

      const client = mockMediaServerClient({
        libraries: [createMockLibrary({ name: 'Music', type: 'artist' })],
        totalCount: 5,
        itemsSince: [],
        totalCountSince: 0,
      });
      client.getLibraryAlbumsSince = vi
        .fn()
        .mockResolvedValue({ items: [newAlbum], totalCount: 1 });

      const service = new LibrarySyncService();
      const results = await service.syncServer(serverId);

      expect(client.getLibraryAlbumsSince).toHaveBeenCalledWith('1', expect.any(Date));
      expect(results[0]!.itemsAdded).toBe(1);
      const albumBatch = vi
        .mocked(resolveMediaBatch)
        .mock.calls.find((call) => call[0].some((i) => i.mediaType === 'album'));
      expect(albumBatch?.[0]).toEqual([
        expect.objectContaining({ ratingKey: 'album-1', parentRatingKey: 'artist-1' }),
      ]);
    });

    it('falls back to full scan when getLibraryItemsSince throws', async () => {
      const mockServer = createMockServer({ id: serverId });
      const mockItems = [createMockLibraryItem({ ratingKey: 'item-1' })];
      const lastSyncedAt = new Date(Date.now() - 60_000);
      const mockRedis = createMockRedis({
        get: syncStateReads(lastSyncedAt.toISOString(), '1'),
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
      expect(client.getLibraryItems).toHaveBeenCalledWith('1', {
        offset: 0,
        limit: 200,
        libraryType: 'movie',
      });
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

      mockServerThenEmpty(mockServer);

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

      mockServerThenEmpty(mockServer);

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

  describe('album sync (Plex full scan)', () => {
    it('fetches albums for a music library via getLibraryAlbums and upserts them beside the tracks', async () => {
      const service = new LibrarySyncService();
      const mockServer = createMockServer();
      const artistItem = createMockLibraryItem({
        ratingKey: 'artist-1',
        title: 'Massive Attack',
        mediaType: 'artist',
        fileSize: undefined,
      });
      const albumItem = createMockLibraryItem({
        ratingKey: 'album-1',
        title: 'Mezzanine',
        mediaType: 'album',
        parentRatingKey: 'artist-1',
        parentTitle: 'Massive Attack',
        fileSize: undefined,
      });
      const trackItem = createMockLibraryItem({
        ratingKey: 'track-1',
        title: 'Teardrop',
        mediaType: 'track',
        parentRatingKey: 'album-1',
        grandparentRatingKey: 'artist-1',
      });

      setupSelectForIncrementalTest(mockServer);
      mockInsertChain([{ id: randomUUID() }]);
      mockDeleteChain();
      mockTransaction();
      const client = mockMediaServerClient({
        libraries: [createMockLibrary({ id: '7', name: 'Music', type: 'artist' })],
        items: [artistItem],
        totalCount: 1,
      });
      client.getLibraryLeaves = vi.fn().mockResolvedValue({ items: [trackItem], totalCount: 1 });
      client.getLibraryAlbums = vi.fn().mockResolvedValue({ items: [albumItem], totalCount: 1 });

      await service.syncServer(mockServer.id);

      expect(client.getLibraryAlbums).toHaveBeenCalledWith('7', { offset: 0, limit: 200 });
      const upserted = vi
        .mocked(resolveMediaBatch)
        .mock.calls.flatMap((call) => call[0].map((i) => [i.ratingKey, i.mediaType]));
      expect(upserted).toEqual(
        expect.arrayContaining([
          ['artist-1', 'artist'],
          ['album-1', 'album'],
          ['track-1', 'track'],
        ])
      );
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
