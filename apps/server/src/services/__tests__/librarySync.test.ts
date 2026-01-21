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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

// Mock the database
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

// Mock the media server client factory
vi.mock('../mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(),
}));

// Import after mocking
import { db } from '../../db/client.js';
import { createMediaServerClient } from '../mediaServer/index.js';
import { LibrarySyncService } from '../librarySync.js';
import type { MediaLibraryItem } from '../mediaServer/types.js';
import type { LibrarySyncProgress } from '@tracearr/shared';

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
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
    returning: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
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

function mockDeleteChain() {
  const chain = {
    where: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(db.delete).mockReturnValue(chain as never);
  return chain;
}

function mockTransaction() {
  // Create a mock tx object with insert chain
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  };
  const deleteChain = {
    where: vi.fn().mockResolvedValue(undefined),
  };
  const tx = {
    insert: vi.fn().mockReturnValue(insertChain),
    delete: vi.fn().mockReturnValue(deleteChain),
  };
  // Transaction executes the callback with tx and returns its result
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(db.transaction).mockImplementation(async (callback: any) => {
    return callback(tx);
  });
  return { tx, insertChain, deleteChain };
}

function mockMediaServerClient(options: {
  libraries?: ReturnType<typeof createMockLibrary>[];
  items?: MediaLibraryItem[];
  totalCount?: number;
}) {
  const client = {
    getLibraries: vi.fn().mockResolvedValue(options.libraries ?? [createMockLibrary()]),
    getLibraryItems: vi.fn().mockResolvedValue({
      items: options.items ?? [],
      totalCount: options.totalCount ?? options.items?.length ?? 0,
    }),
    serverType: 'plex' as const,
    getSessions: vi.fn(),
    getUsers: vi.fn(),
    testConnection: vi.fn(),
    terminateSession: vi.fn(),
  };
  vi.mocked(createMediaServerClient).mockReturnValue(client);
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
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
        }),
      ]);
    });
  });

  describe('createSnapshot', () => {
    it('should create snapshot with correct item count', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const snapshotId = randomUUID();
      const items = [createMockLibraryItem(), createMockLibraryItem(), createMockLibraryItem()];

      const insertChain = mockInsertChain([{ id: snapshotId }]);

      const result = await service.createSnapshot(serverId, libraryId, items);

      expect(result.id).toBe(snapshotId);
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId,
          libraryId,
          itemCount: 3,
        })
      );
    });

    it('should calculate quality distribution correctly', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const items = [
        createMockLibraryItem({ videoResolution: '4k', videoCodec: 'hevc' }),
        createMockLibraryItem({ videoResolution: '4k', videoCodec: 'hevc' }),
        createMockLibraryItem({ videoResolution: '1080p', videoCodec: 'h264' }),
        createMockLibraryItem({ videoResolution: '720p', videoCodec: 'h264' }),
        createMockLibraryItem({ videoResolution: '480p', videoCodec: 'h264' }),
      ];

      const insertChain = mockInsertChain([{ id: randomUUID() }]);

      await service.createSnapshot(serverId, libraryId, items);

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          count4k: 2,
          count1080p: 1,
          count720p: 1,
          countSd: 1,
          hevcCount: 2,
          h264Count: 3,
        })
      );
    });

    it('should calculate total file size', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const items = [
        createMockLibraryItem({ fileSize: 5000000000 }),
        createMockLibraryItem({ fileSize: 3000000000 }),
        createMockLibraryItem({ fileSize: undefined }),
      ];

      const insertChain = mockInsertChain([{ id: randomUUID() }]);

      await service.createSnapshot(serverId, libraryId, items);

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          totalSize: 8000000000,
        })
      );
    });

    it('should count media types correctly', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const items = [
        createMockLibraryItem({ mediaType: 'movie' }),
        createMockLibraryItem({ mediaType: 'movie' }),
        createMockLibraryItem({ mediaType: 'episode' }),
        createMockLibraryItem({ mediaType: 'show' }),
        createMockLibraryItem({ mediaType: 'track' }),
      ];

      const insertChain = mockInsertChain([{ id: randomUUID() }]);

      await service.createSnapshot(serverId, libraryId, items);

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          movieCount: 2,
          episodeCount: 1,
          showCount: 1,
          musicCount: 1,
        })
      );
    });
  });

  describe('markItemsRemoved', () => {
    it('should delete items from database', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      const ratingKeys = ['key-1', 'key-2', 'key-3'];

      const deleteChain = mockDeleteChain();

      await service.markItemsRemoved(serverId, libraryId, ratingKeys);

      expect(db.delete).toHaveBeenCalled();
      expect(deleteChain.where).toHaveBeenCalled();
    });

    it('should handle empty ratingKeys array', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';

      await service.markItemsRemoved(serverId, libraryId, []);

      expect(db.delete).not.toHaveBeenCalled();
    });

    it('should batch delete for large arrays', async () => {
      const service = new LibrarySyncService();
      const serverId = randomUUID();
      const libraryId = '1';
      // Create 250 keys (should result in 3 batches of 100)
      const ratingKeys = Array.from({ length: 250 }, (_, i) => `key-${i}`);

      mockDeleteChain();

      await service.markItemsRemoved(serverId, libraryId, ratingKeys);

      // Should be called 3 times (batches of 100, 100, 50)
      expect(db.delete).toHaveBeenCalledTimes(3);
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
      mockTransaction();
      mockMediaServerClient({
        libraries: mockLibraries,
        items: serverItems,
        totalCount: 2,
      });

      const results = await service.syncServer(mockServer.id);

      expect(results[0]!.itemsRemoved).toBe(1); // item-2 removed
      expect(db.delete).toHaveBeenCalled();
    });
  });
});
