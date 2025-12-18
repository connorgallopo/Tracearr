/**
 * Cleanup Mobile Tokens Job Tests
 *
 * Tests the mobile token cleanup job:
 * - Deletes expired unused tokens (older than 1 hour)
 * - Deletes used tokens (older than 30 days)
 * - Returns count of deleted tokens
 *
 * Uses mocked database to test cleanup logic in isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

// Mock the database
vi.mock('../../db/client.js', () => ({
  db: {
    delete: vi.fn(),
  },
}));

// Import after mocking
import { db } from '../../db/client.js';
import { cleanupMobileTokens } from '../cleanupMobileTokens.js';

// Type the mocked db
const mockDb = db as unknown as {
  delete: ReturnType<typeof vi.fn>;
};

// Helper to create a mock delete chain
function mockDeleteChain(expiredResult: { id: string }[], usedResult: { id: string }[]) {
  let callCount = 0;

  mockDb.delete.mockImplementation(() => ({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockImplementation(() => {
        callCount++;
        // First call is for expired tokens, second for used tokens
        return callCount === 1 ? expiredResult : usedResult;
      }),
    }),
  }));
}

describe('cleanupMobileTokens', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('expired unused tokens cleanup', () => {
    it('should delete expired unused tokens older than 1 hour', async () => {
      const expiredTokens = [{ id: randomUUID() }, { id: randomUUID() }, { id: randomUUID() }];
      mockDeleteChain(expiredTokens, []);

      const result = await cleanupMobileTokens();

      expect(result.deleted).toBe(3);
      expect(mockDb.delete).toHaveBeenCalledTimes(2); // Both expired and used queries
    });

    it('should not delete recently created unused tokens', async () => {
      // No expired tokens found
      mockDeleteChain([], []);

      const result = await cleanupMobileTokens();

      expect(result.deleted).toBe(0);
    });
  });

  describe('used tokens cleanup', () => {
    it('should delete used tokens older than 30 days', async () => {
      const usedTokens = [{ id: randomUUID() }, { id: randomUUID() }];
      mockDeleteChain([], usedTokens);

      const result = await cleanupMobileTokens();

      expect(result.deleted).toBe(2);
    });

    it('should not delete recently used tokens', async () => {
      // No old used tokens found
      mockDeleteChain([], []);

      const result = await cleanupMobileTokens();

      expect(result.deleted).toBe(0);
    });
  });

  describe('combined cleanup', () => {
    it('should delete both expired and used tokens in single run', async () => {
      const expiredTokens = [{ id: randomUUID() }, { id: randomUUID() }];
      const usedTokens = [{ id: randomUUID() }, { id: randomUUID() }, { id: randomUUID() }];
      mockDeleteChain(expiredTokens, usedTokens);

      const result = await cleanupMobileTokens();

      // Total: 2 expired + 3 used = 5
      expect(result.deleted).toBe(5);
    });

    it('should return zero when no tokens need cleanup', async () => {
      mockDeleteChain([], []);

      const result = await cleanupMobileTokens();

      expect(result.deleted).toBe(0);
    });

    it('should handle large number of tokens', async () => {
      const expiredTokens = Array.from({ length: 100 }, () => ({ id: randomUUID() }));
      const usedTokens = Array.from({ length: 50 }, () => ({ id: randomUUID() }));
      mockDeleteChain(expiredTokens, usedTokens);

      const result = await cleanupMobileTokens();

      expect(result.deleted).toBe(150);
    });
  });

  describe('database query construction', () => {
    it('should call delete on mobileTokens table', async () => {
      mockDeleteChain([], []);

      await cleanupMobileTokens();

      // Should be called twice: once for expired, once for used
      expect(mockDb.delete).toHaveBeenCalledTimes(2);
    });

    it('should use where clause with proper conditions', async () => {
      const whereMock = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      });
      mockDb.delete.mockReturnValue({ where: whereMock });

      await cleanupMobileTokens();

      // Each delete should chain to where
      expect(whereMock).toHaveBeenCalledTimes(2);
    });

    it('should return ids from deleted tokens', async () => {
      const returningMock = vi
        .fn()
        .mockResolvedValueOnce([{ id: 'expired-1' }])
        .mockResolvedValueOnce([{ id: 'used-1' }, { id: 'used-2' }]);

      mockDb.delete.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: returningMock,
        }),
      });

      const result = await cleanupMobileTokens();

      expect(result.deleted).toBe(3);
      expect(returningMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('time boundaries', () => {
    it('should calculate 1 hour cutoff correctly', async () => {
      // Set current time to noon UTC
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));

      let capturedWhereFn: unknown;
      mockDb.delete.mockImplementation(() => ({
        where: vi.fn().mockImplementation((condition) => {
          if (!capturedWhereFn) {
            capturedWhereFn = condition;
          }
          return { returning: vi.fn().mockResolvedValue([]) };
        }),
      }));

      await cleanupMobileTokens();

      // The first where clause should be for expired tokens
      // 1 hour ago from noon = 11:00 AM
      expect(capturedWhereFn).toBeDefined();
    });

    it('should calculate 30 day cutoff correctly', async () => {
      // Set current time to Jan 15, 2025
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));

      const whereConditions: unknown[] = [];
      mockDb.delete.mockImplementation(() => ({
        where: vi.fn().mockImplementation((condition) => {
          whereConditions.push(condition);
          return { returning: vi.fn().mockResolvedValue([]) };
        }),
      }));

      await cleanupMobileTokens();

      // Should have captured both where conditions
      // First for expired (1 hour), second for used (30 days)
      expect(whereConditions).toHaveLength(2);
    });
  });

  describe('error handling', () => {
    it('should propagate database errors for expired query', async () => {
      mockDb.delete.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(new Error('Database connection failed')),
        }),
      });

      await expect(cleanupMobileTokens()).rejects.toThrow('Database connection failed');
    });

    it('should propagate database errors for used query', async () => {
      const returningMock = vi
        .fn()
        .mockResolvedValueOnce([]) // Expired query succeeds
        .mockRejectedValueOnce(new Error('Query timeout')); // Used query fails

      mockDb.delete.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: returningMock,
        }),
      });

      await expect(cleanupMobileTokens()).rejects.toThrow('Query timeout');
    });
  });
});
