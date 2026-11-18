/**
 * Session Lifecycle Identity Tests
 *
 * Tests for findActiveSession accepting SessionIdentity object with optional ratingKey.
 * Part of the session reliability plan to prevent race conditions during media changes.
 *
 * Expected behavior:
 * 1. findActiveSession accepts a SessionIdentity object (not separate parameters)
 * 2. When ratingKey is provided, it validates the session has matching ratingKey
 * 3. Backward compatibility: works without ratingKey for existing call sites
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as DrizzleOrm from 'drizzle-orm';
import type { SessionIdentity } from '../types.js';

describe('findActiveSession with SessionIdentity', () => {
  // Track the SQL query that would be generated
  let capturedConditions: Array<{ type: string; value?: unknown; column?: string }> = [];

  beforeEach(async () => {
    capturedConditions = [];

    // Reset module cache to get fresh imports
    vi.resetModules();

    // Create mocked versions before importing the module under test
    vi.doMock('drizzle-orm', async (importOriginal) => {
      const actual = await importOriginal<typeof DrizzleOrm>();
      return {
        ...actual,
        eq: (column: unknown, value: unknown) => {
          // Extract column name from various drizzle structures
          let columnName = 'unknown';
          if (typeof column === 'object' && column !== null) {
            // Try different properties where drizzle might store the column name
            if ('name' in column) columnName = String(column.name);
            else if ('_' in column && typeof column._ === 'object') {
              const inner = (column as { _: { name?: string } })._;
              if (inner?.name) columnName = inner.name;
            }
          }
          capturedConditions.push({ type: 'eq', column: columnName, value });
          return actual.eq(column as never, value as never);
        },
        and: (...conditions: unknown[]) => {
          // Track the total count passed to and()
          capturedConditions.push({ type: 'and_count', value: conditions.length });
          return actual.and(...(conditions as never[]));
        },
      };
    });

    // Mock the db to return mock results
    vi.doMock('../../../db/client.js', () => ({
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => Promise.resolve([{ id: 'session-1', ratingKey: 'episode-100' }]),
              }),
            }),
          }),
        }),
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('../../../db/client.js');
    vi.resetModules();
  });

  /**
   * This test verifies that findActiveSession extracts serverId from the identity object.
   */
  it('should extract serverId from SessionIdentity object', async () => {
    const { findActiveSession } = await import('../sessionLifecycle.js');

    const identity: SessionIdentity = {
      serverId: 'server-1',
      sessionKey: 'abc123',
      ratingKey: 'episode-100',
    };

    await findActiveSession(identity);

    // Check that eq() was called with the correct serverId value
    const serverIdEq = capturedConditions.find((c) => c.type === 'eq' && c.value === 'server-1');
    expect(serverIdEq).toBeDefined();
    expect(serverIdEq?.value).toBe('server-1');
  });

  /**
   * This test verifies that ratingKey is included in the WHERE clause when provided.
   */
  it('should include ratingKey in query when provided in identity', async () => {
    const { findActiveSession } = await import('../sessionLifecycle.js');

    const identity: SessionIdentity = {
      serverId: 'server-1',
      sessionKey: 'abc123',
      ratingKey: 'episode-100',
    };

    await findActiveSession(identity);

    // Check that eq() was called with the ratingKey value
    const ratingKeyEq = capturedConditions.find(
      (c) => c.type === 'eq' && c.value === 'episode-100'
    );
    expect(ratingKeyEq).toBeDefined();
    expect(ratingKeyEq?.value).toBe('episode-100');

    // Verify and() was called with 5 conditions (serverId, sessionKey, isNull, gte, ratingKey)
    const andCount = capturedConditions.find((c) => c.type === 'and_count');
    expect(andCount?.value).toBe(5);
  });

  /**
   * This test verifies backward compatibility - when ratingKey is undefined,
   * the query should NOT include a ratingKey condition (only 4 conditions).
   */
  it('should NOT include ratingKey in query when not provided (backward compat)', async () => {
    const { findActiveSession } = await import('../sessionLifecycle.js');

    // Without ratingKey
    const identity: SessionIdentity = {
      serverId: 'server-1',
      sessionKey: 'abc123',
    };

    await findActiveSession(identity);

    // Verify and() was called with 4 conditions (no ratingKey)
    const andCount = capturedConditions.find((c) => c.type === 'and_count');
    expect(andCount?.value).toBe(4);

    // Verify the ratingKey value 'episode-100' was NOT passed to eq()
    const ratingKeyEq = capturedConditions.find(
      (c) => c.type === 'eq' && c.value === 'episode-100'
    );
    expect(ratingKeyEq).toBeUndefined();
  });

  /**
   * This test verifies that null ratingKey is treated the same as undefined
   * (no ratingKey filtering).
   */
  it('should NOT include ratingKey in query when explicitly null', async () => {
    const { findActiveSession } = await import('../sessionLifecycle.js');

    const identity: SessionIdentity = {
      serverId: 'server-1',
      sessionKey: 'abc123',
      ratingKey: null, // Explicitly null
    };

    await findActiveSession(identity);

    // Verify and() was called with 4 conditions (null should not add a condition)
    const andCount = capturedConditions.find((c) => c.type === 'and_count');
    expect(andCount?.value).toBe(4);

    // Verify no null value was passed to eq()
    const nullEq = capturedConditions.find((c) => c.type === 'eq' && c.value === null);
    expect(nullEq).toBeUndefined();
  });

  it('does not match on an empty ratingKey, which a read that did not describe its media carries', async () => {
    const { findActiveSession } = await import('../sessionLifecycle.js');

    await findActiveSession({ serverId: 'server-1', sessionKey: 'abc123', ratingKey: '' });

    const andCount = capturedConditions.find((c) => c.type === 'and_count');
    expect(andCount?.value).toBe(4);
    expect(capturedConditions.find((c) => c.type === 'eq' && c.value === '')).toBeUndefined();
  });
});
