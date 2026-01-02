/**
 * Tests for Violation Deduplication Logic
 *
 * Tests the isDuplicateViolation function for all rule types:
 * - Multi-session rules: concurrent_streams, simultaneous_locations
 * - Single-session rules: impossible_travel, device_velocity, geo_restriction
 *
 * Also tests isDuplicateViolationInTransaction for:
 * - Advisory lock acquisition for multi-session rules
 * - Shared deduplication logic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isDuplicateViolation, isDuplicateViolationInTransaction } from '../violations.js';
import { db } from '../../../db/client.js';

// Mock the database
vi.mock('../../../db/client.js', () => ({
  db: {
    select: vi.fn(),
  },
}));

describe('isDuplicateViolation', () => {
  const serverUserId = 'user-123';
  const triggeringSessionId = 'session-new';

  // Helper to create mock query chain
  function mockDbQuery(results: Array<{ id: string; sessionId: string; data: unknown }>) {
    const mockChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(results),
    };
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(mockChain);
    return mockChain;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('single-session rules (impossible_travel, device_velocity, geo_restriction)', () => {
    it.each(['impossible_travel', 'device_velocity', 'geo_restriction'] as const)(
      '%s: should return false when no recent violations exist',
      async (ruleType) => {
        mockDbQuery([]);

        const result = await isDuplicateViolation(serverUserId, ruleType, triggeringSessionId, []);

        expect(result).toBe(false);
      }
    );

    it.each(['impossible_travel', 'device_velocity', 'geo_restriction'] as const)(
      '%s: should return true when same session already has violation',
      async (ruleType) => {
        mockDbQuery([
          {
            id: 'violation-1',
            sessionId: triggeringSessionId, // Same session
            data: {},
          },
        ]);

        const result = await isDuplicateViolation(serverUserId, ruleType, triggeringSessionId, []);

        expect(result).toBe(true);
      }
    );

    it.each(['impossible_travel', 'geo_restriction'] as const)(
      '%s: should return false when different session has violation',
      async (ruleType) => {
        mockDbQuery([
          {
            id: 'violation-1',
            sessionId: 'session-other', // Different session
            data: {},
          },
        ]);

        const result = await isDuplicateViolation(serverUserId, ruleType, triggeringSessionId, []);

        expect(result).toBe(false);
      }
    );

    it('device_velocity: should return true when different session has violation (user-level dedup)', async () => {
      // device_velocity is a user-level rule - any recent violation for the same user is a duplicate
      mockDbQuery([
        {
          id: 'violation-1',
          sessionId: 'session-other', // Different session, but same user
          data: {},
        },
      ]);

      const result = await isDuplicateViolation(
        serverUserId,
        'device_velocity',
        triggeringSessionId,
        []
      );

      expect(result).toBe(true);
    });

    it('impossible_travel: should allow multiple violations from different sessions', async () => {
      // Scenario: User triggers impossible_travel from session A, then from session B
      // Both should create violations (different triggering sessions)
      mockDbQuery([
        {
          id: 'violation-1',
          sessionId: 'session-A',
          data: {},
        },
      ]);

      const result = await isDuplicateViolation(
        serverUserId,
        'impossible_travel',
        'session-B', // Different session
        []
      );

      expect(result).toBe(false);
    });
  });

  describe('multi-session rules (concurrent_streams, simultaneous_locations)', () => {
    it.each(['concurrent_streams', 'simultaneous_locations'] as const)(
      '%s: should return false when no recent violations exist',
      async (ruleType) => {
        mockDbQuery([]);

        const result = await isDuplicateViolation(serverUserId, ruleType, triggeringSessionId, [
          'related-1',
          'related-2',
        ]);

        expect(result).toBe(false);
      }
    );

    it.each(['concurrent_streams', 'simultaneous_locations'] as const)(
      '%s: should return true when triggering session is in existing violation related sessions',
      async (ruleType) => {
        mockDbQuery([
          {
            id: 'violation-1',
            sessionId: 'session-other',
            data: { relatedSessionIds: [triggeringSessionId, 'session-x'] },
          },
        ]);

        const result = await isDuplicateViolation(serverUserId, ruleType, triggeringSessionId, []);

        expect(result).toBe(true);
      }
    );

    it.each(['concurrent_streams', 'simultaneous_locations'] as const)(
      '%s: should return true when existing violation triggering session is in our related sessions',
      async (ruleType) => {
        const existingTriggerSession = 'session-existing';
        mockDbQuery([
          {
            id: 'violation-1',
            sessionId: existingTriggerSession,
            data: { relatedSessionIds: [] },
          },
        ]);

        const result = await isDuplicateViolation(serverUserId, ruleType, triggeringSessionId, [
          existingTriggerSession, // Our related sessions include the existing trigger
          'related-2',
        ]);

        expect(result).toBe(true);
      }
    );

    it.each(['concurrent_streams', 'simultaneous_locations'] as const)(
      '%s: should return true when any related session IDs overlap',
      async (ruleType) => {
        mockDbQuery([
          {
            id: 'violation-1',
            sessionId: 'session-other',
            data: { relatedSessionIds: ['shared-session', 'session-x'] },
          },
        ]);

        const result = await isDuplicateViolation(serverUserId, ruleType, triggeringSessionId, [
          'shared-session', // Overlaps with existing violation
          'session-y',
        ]);

        expect(result).toBe(true);
      }
    );

    it.each(['concurrent_streams', 'simultaneous_locations'] as const)(
      '%s: should return false when no session overlap',
      async (ruleType) => {
        mockDbQuery([
          {
            id: 'violation-1',
            sessionId: 'session-a',
            data: { relatedSessionIds: ['session-b', 'session-c'] },
          },
        ]);

        const result = await isDuplicateViolation(serverUserId, ruleType, triggeringSessionId, [
          'session-x', // No overlap
          'session-y',
        ]);

        expect(result).toBe(false);
      }
    );

    it('concurrent_streams: scenario - 3 sessions start simultaneously', async () => {
      // Scenario: Sessions A, B, C all start at once
      // When A is processed: creates violation with relatedSessionIds=[B, C]
      // When B is processed: should detect duplicate (B is in A's related sessions)
      // When C is processed: should detect duplicate (C is in A's related sessions)

      // Simulating when B is processed
      mockDbQuery([
        {
          id: 'violation-from-A',
          sessionId: 'session-A',
          data: { relatedSessionIds: ['session-B', 'session-C'] },
        },
      ]);

      const resultB = await isDuplicateViolation(
        serverUserId,
        'concurrent_streams',
        'session-B', // B is triggering
        ['session-A', 'session-C'] // B sees A and C as related
      );

      expect(resultB).toBe(true); // B should be deduplicated
    });
  });

  describe('edge cases', () => {
    it('should handle null data gracefully', async () => {
      mockDbQuery([
        {
          id: 'violation-1',
          sessionId: 'session-other',
          data: null,
        },
      ]);

      const result = await isDuplicateViolation(
        serverUserId,
        'concurrent_streams',
        triggeringSessionId,
        ['related-1']
      );

      expect(result).toBe(false);
    });

    it('should handle missing relatedSessionIds in data', async () => {
      mockDbQuery([
        {
          id: 'violation-1',
          sessionId: 'session-other',
          data: { someOtherField: 'value' },
        },
      ]);

      const result = await isDuplicateViolation(
        serverUserId,
        'concurrent_streams',
        triggeringSessionId,
        ['related-1']
      );

      expect(result).toBe(false);
    });

    it('should handle empty relatedSessionIds array', async () => {
      mockDbQuery([
        {
          id: 'violation-1',
          sessionId: 'session-other',
          data: { relatedSessionIds: [] },
        },
      ]);

      const result = await isDuplicateViolation(
        serverUserId,
        'concurrent_streams',
        triggeringSessionId,
        []
      );

      expect(result).toBe(false);
    });
  });
});

// ============================================================================
// isDuplicateViolationInTransaction Tests (P1-3)
// ============================================================================

describe('isDuplicateViolationInTransaction', () => {
  const serverUserId = 'user-123';
  const triggeringSessionId = 'session-new';

  // Helper to create mock transaction context
  function createMockTx(queryResults: Array<{ id: string; sessionId: string; data: unknown }>) {
    const executeCalls: unknown[] = [];
    const mockTx = {
      execute: vi.fn().mockImplementation((query: unknown) => {
        // Track the raw query object for inspection
        executeCalls.push(query);
        return Promise.resolve([]);
      }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(queryResults),
      }),
      _executeCalls: executeCalls,
    };
    return mockTx;
  }

  // Helper to check if any execute call contains advisory lock
  function hasAdvisoryLock(executeCalls: unknown[]): boolean {
    for (const call of executeCalls) {
      // Drizzle SQL templates have various shapes, check common patterns
      const callStr = JSON.stringify(call);
      if (callStr.includes('pg_advisory_xact_lock')) {
        return true;
      }
      // Also check if it's a SQL template with queryChunks
      const queryObj = call as { queryChunks?: unknown[]; sql?: { queryChunks?: unknown[] } };
      const chunks = queryObj?.queryChunks ?? queryObj?.sql?.queryChunks ?? [];
      for (const chunk of chunks) {
        if (String(chunk).includes('pg_advisory_xact_lock')) {
          return true;
        }
      }
    }
    return false;
  }

  describe('advisory lock behavior', () => {
    it.each(['concurrent_streams', 'simultaneous_locations'] as const)(
      '%s: should acquire advisory lock for multi-session rules',
      async (ruleType) => {
        const mockTx = createMockTx([]);

        await isDuplicateViolationInTransaction(
          mockTx as never,
          serverUserId,
          ruleType,
          triggeringSessionId,
          ['related-1']
        );

        // Should have called execute with pg_advisory_xact_lock
        expect(mockTx.execute).toHaveBeenCalled();
        expect(hasAdvisoryLock(mockTx._executeCalls)).toBe(true);
      }
    );

    it.each(['impossible_travel', 'device_velocity', 'geo_restriction'] as const)(
      '%s: should NOT acquire advisory lock for single-session rules',
      async (ruleType) => {
        const mockTx = createMockTx([]);

        await isDuplicateViolationInTransaction(
          mockTx as never,
          serverUserId,
          ruleType,
          triggeringSessionId,
          []
        );

        // Should NOT have called execute with pg_advisory_xact_lock
        expect(hasAdvisoryLock(mockTx._executeCalls)).toBe(false);
      }
    );

    it('advisory lock should be called for multi-session rules before dedup check', async () => {
      const mockTx = createMockTx([]);

      await isDuplicateViolationInTransaction(
        mockTx as never,
        'user-abc',
        'concurrent_streams',
        triggeringSessionId,
        ['related-1']
      );

      // Execute should be called (for the advisory lock)
      expect(mockTx.execute).toHaveBeenCalled();
      // And select should also be called (for the dedup query)
      expect(mockTx.select).toHaveBeenCalled();
    });
  });

  describe('deduplication logic (shared with non-transaction version)', () => {
    it.each(['impossible_travel', 'device_velocity', 'geo_restriction'] as const)(
      '%s: should return true when same session has violation',
      async (ruleType) => {
        const mockTx = createMockTx([
          {
            id: 'violation-1',
            sessionId: triggeringSessionId,
            data: {},
          },
        ]);

        const result = await isDuplicateViolationInTransaction(
          mockTx as never,
          serverUserId,
          ruleType,
          triggeringSessionId,
          []
        );

        expect(result).toBe(true);
      }
    );

    it.each(['concurrent_streams', 'simultaneous_locations'] as const)(
      '%s: should return true when session overlap exists',
      async (ruleType) => {
        const mockTx = createMockTx([
          {
            id: 'violation-1',
            sessionId: 'session-other',
            data: { relatedSessionIds: [triggeringSessionId] },
          },
        ]);

        const result = await isDuplicateViolationInTransaction(
          mockTx as never,
          serverUserId,
          ruleType,
          triggeringSessionId,
          []
        );

        expect(result).toBe(true);
      }
    );

    it('should return false when no violations exist', async () => {
      const mockTx = createMockTx([]);

      const result = await isDuplicateViolationInTransaction(
        mockTx as never,
        serverUserId,
        'concurrent_streams',
        triggeringSessionId,
        ['related-1']
      );

      expect(result).toBe(false);
    });
  });
});
