/**
 * User Service Integration Tests
 *
 * Tests userService functions against a real database.
 * Uses global integration test setup for database management.
 *
 * Run with: pnpm test:integration
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '../../src/db/client.js';
import { servers } from '../../src/db/schema.js';
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
