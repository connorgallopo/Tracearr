/**
 * User Service Integration Tests
 *
 * Tests userService functions against a real database.
 * Uses global integration test setup for database management.
 *
 * Run with: pnpm test:integration
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../../src/db/client.js';
import { servers, serverUsers, users } from '../../src/db/schema.js';
import { syncServerUsers } from '../../src/services/sync.js';
import * as userService from '../../src/services/userService.js';
import {
  applyTrustChange,
  syncUserFromMediaServer,
  getServerUserByExternalId,
} from '../../src/services/userService.js';
import type { MediaUser } from '../../src/services/userService.js';

describe('userService integration tests', () => {
  let testServerId: string;

  // Create a fresh server before each test (after global reset)
  beforeEach(async () => {
    const [server] = await db
      .insert(servers)
      .values({
        name: 'Integration Test Server',
        type: 'plex',
        url: 'http://localhost:32400',
        token: 'encrypted-test-token',
      })
      .returning();

    testServerId = server.id;
  });

  describe('syncUserFromMediaServer', () => {
    it('should create a new user and server user when none exists', async () => {
      const mediaUser: MediaUser = {
        id: `ext-${randomUUID().slice(0, 8)}`,
        username: 'newuser',
        email: 'newuser@example.com',
        thumb: 'https://example.com/thumb.jpg',
        isAdmin: false,
      };

      const result = await syncUserFromMediaServer(testServerId, mediaUser);

      expect(result.created).toBe(true);
      expect(result.serverUser.externalId).toBe(mediaUser.id);
      expect(result.serverUser.username).toBe(mediaUser.username);
      expect(result.user.username).toBe(mediaUser.username);

      // Verify in database
      const dbServerUser = await getServerUserByExternalId(testServerId, mediaUser.id);
      expect(dbServerUser).not.toBeNull();
      expect(dbServerUser?.username).toBe(mediaUser.username);
    });

    it('should update existing server user when already exists', async () => {
      const externalId = `ext-${randomUUID().slice(0, 8)}`;
      const mediaUser: MediaUser = {
        id: externalId,
        username: 'originalname',
        isAdmin: false,
      };

      // First create
      const createResult = await syncUserFromMediaServer(testServerId, mediaUser);
      expect(createResult.created).toBe(true);

      // Then update with new username
      const updatedMediaUser: MediaUser = {
        id: externalId,
        username: 'updatedname',
        email: 'updated@example.com',
        isAdmin: true,
      };

      const updateResult = await syncUserFromMediaServer(testServerId, updatedMediaUser);
      expect(updateResult.created).toBe(false);
      expect(updateResult.serverUser.username).toBe('updatedname');
    });

    it('stores a Jellyfin or Emby username that is an email as the account email only', async () => {
      const [jellyfin] = await db
        .insert(servers)
        .values({
          name: 'Integration Jellyfin',
          type: 'jellyfin',
          url: 'http://localhost:8096',
          token: 'encrypted-test-token',
        })
        .returning();
      const emailId = `ext-${randomUUID().slice(0, 8)}`;
      const plainId = `ext-${randomUUID().slice(0, 8)}`;

      const created = await syncUserFromMediaServer(jellyfin!.id, {
        id: emailId,
        username: 'Mixed.Case@Example.com',
        isAdmin: false,
      });
      const plain = await syncUserFromMediaServer(jellyfin!.id, {
        id: plainId,
        username: 'no-email-here',
        isAdmin: false,
      });
      const renamed = await syncUserFromMediaServer(jellyfin!.id, {
        id: plainId,
        username: 'renamed@example.com',
        isAdmin: false,
      });

      expect(created.serverUser.email).toBe('mixed.case@example.com');
      expect(created.user.email).toBeNull();
      expect(plain.serverUser.email).toBeNull();
      expect(renamed.serverUser.email).toBe('renamed@example.com');
      expect(renamed.user.email).toBeNull();
    });
  });

  describe('syncServerUsers', () => {
    /** Statistics land per backend, ~1 s after it goes idle; the pool spreads one sync over several. */
    async function counters(): Promise<{ updates: number }> {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await db.execute(sql`SELECT pg_stat_force_next_flush()`);
      const result = await db.execute<{ updates: string }>(sql`
        SELECT n_tup_upd AS updates FROM pg_stat_user_tables WHERE relname = 'server_users'
      `);
      return { updates: Number(result.rows[0]!.updates) };
    }

    it('a second sync of unchanged accounts writes no server_users rows', async () => {
      const [jellyfin] = await db
        .insert(servers)
        .values({
          name: 'Sync Jellyfin',
          type: 'jellyfin',
          url: 'http://localhost:8096',
          token: 'encrypted-test-token',
        })
        .returning();
      const mediaUsers: MediaUser[] = Array.from({ length: 50 }, (_, i) => ({
        id: `jf-${i}`,
        username: `viewer${i}`,
        isAdmin: i === 0,
        sharedLibraries: i % 2 === 0 ? ['b', 'a'] : undefined,
        lastActivityAt: new Date(Date.UTC(2026, 0, 1 + i)),
      }));

      const first = await syncServerUsers(jellyfin!.id, mediaUsers);
      expect(first.added).toBe(50);
      const before = await counters();

      const queries = vi.spyOn(pg.Client.prototype, 'query');
      const second = await syncServerUsers(jellyfin!.id, mediaUsers);
      const statements = queries.mock.calls.length;
      queries.mockRestore();
      const after = await counters();

      expect(second).toMatchObject({ added: 0, updated: 50, removed: 0, errors: [] });
      expect(after.updates - before.updates).toBe(0);
      // Statements on the sync's own connections; per-account statements would put 50 or more here.
      expect(statements).toBeLessThan(15);
    });

    it('writes an account whose activity advanced and restates its identity', async () => {
      const [jellyfin] = await db
        .insert(servers)
        .values({ name: 'Sync Jellyfin', type: 'jellyfin', url: 'http://jf', token: 't' })
        .returning();
      const seen = new Date(Date.UTC(2026, 0, 1));
      const later = new Date(Date.UTC(2026, 5, 1));
      const viewers: MediaUser[] = ['a', 'b'].map((id) => ({
        id,
        username: `viewer-${id}`,
        isAdmin: false,
        lastActivityAt: seen,
      }));
      await syncServerUsers(jellyfin!.id, viewers);

      const second = await syncServerUsers(jellyfin!.id, [
        { ...viewers[0]!, lastActivityAt: later },
        viewers[1]!,
      ]);

      expect(second).toMatchObject({ updated: 2, errors: [] });
      const rows = await db
        .select({ externalId: serverUsers.externalId, identityActivity: users.lastActivityAt })
        .from(serverUsers)
        .innerJoin(users, eq(users.id, serverUsers.userId))
        .where(eq(serverUsers.serverId, jellyfin!.id))
        .orderBy(serverUsers.externalId);
      expect(rows).toEqual([
        { externalId: 'a', identityActivity: later },
        { externalId: 'b', identityActivity: seen },
      ]);
    });

    it('keeps the account writes when the identity recount after them fails', async () => {
      const [jellyfin] = await db
        .insert(servers)
        .values({ name: 'Sync Jellyfin', type: 'jellyfin', url: 'http://jf', token: 't' })
        .returning();
      const viewer: MediaUser = {
        id: 'a',
        username: 'viewer-a',
        isAdmin: false,
        lastActivityAt: new Date(Date.UTC(2026, 0, 1)),
      };
      await syncServerUsers(jellyfin!.id, [viewer]);
      const later = new Date(Date.UTC(2026, 5, 1));
      const recount = vi
        .spyOn(userService, 'recomputeIdentityAggregates')
        .mockRejectedValueOnce(new Error('deadlock detected'));

      const second = await syncServerUsers(jellyfin!.id, [
        { ...viewer, username: 'viewer-renamed', lastActivityAt: later },
      ]);
      recount.mockRestore();

      expect(second.updated).toBe(1);
      expect(second.errors).toEqual(['Failed to recount 1 identities: deadlock detected']);
      const [row] = await db
        .select({ username: serverUsers.username, lastActivityAt: serverUsers.lastActivityAt })
        .from(serverUsers)
        .where(eq(serverUsers.serverId, jellyfin!.id));
      expect(row).toEqual({ username: 'viewer-renamed', lastActivityAt: later });
    });
  });

  describe('applyTrustChange', () => {
    /** A fresh account on the test server, at the trust score the case needs. */
    async function account(trustScore: number): Promise<string> {
      const synced = await syncUserFromMediaServer(testServerId, {
        id: `trust-${randomUUID().slice(0, 8)}`,
        username: 'trustuser',
        isAdmin: false,
      });
      if (!synced) throw new Error('account was not created');
      const applied = await applyTrustChange(synced.serverUser.id, {
        mode: 'set',
        value: trustScore,
      });
      if (!applied) throw new Error('seed write found no row');
      return synced.serverUser.id;
    }

    it('returns the score the write replaced alongside the one it wrote', async () => {
      const id = await account(90);

      const applied = await applyTrustChange(id, { mode: 'adjust', amount: -15 });

      expect(applied?.previous).toBe(90);
      expect(applied?.serverUser.trustScore).toBe(75);
      expect(applied?.serverUser.id).toBe(id);
      expect(applied?.serverUser.serverId).toBe(testServerId);
    });

    it.each([
      ['adjust', { mode: 'adjust', amount: -50 } as const, 20, 0],
      ['adjust', { mode: 'adjust', amount: 50 } as const, 80, 100],
      ['set', { mode: 'set', value: -10 } as const, 50, 0],
      ['set', { mode: 'set', value: 500 } as const, 50, 100],
    ])('a %s past the ends clamps to 0-100', async (_mode, change, from, expected) => {
      const id = await account(from);

      const applied = await applyTrustChange(id, change);

      expect(applied?.previous).toBe(from);
      expect(applied?.serverUser.trustScore).toBe(expected);
    });

    it('resets to the baseline and reports no move when it was already there', async () => {
      const id = await account(100);

      const applied = await applyTrustChange(id, { mode: 'reset' });

      // previous === next is what tells the producer this write announced nothing.
      expect(applied?.previous).toBe(100);
      expect(applied?.serverUser.trustScore).toBe(100);
    });

    it('returns null for an account that is not there', async () => {
      expect(await applyTrustChange(randomUUID(), { mode: 'reset' })).toBeNull();
    });
  });
});
