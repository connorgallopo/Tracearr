import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { resetTestDb } from '@tracearr/test-utils/db';
import { createTestUser } from '@tracearr/test-utils/factories';
import { verifyPassword } from '../../src/utils/password.js';
import {
  db,
  users,
  authAccounts,
  authSessions,
  plexAccounts,
  getRedis,
  getSetting,
  setSetting,
  resetPasswordCommand,
  setUsernameCommand,
  setEmailCommand,
  listUsersCommand,
  enableLocalLoginCommand,
} from '../lib/commands.js';

describe('admin cli commands', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await getRedis().quit();
  });

  describe('resetPasswordCommand', () => {
    it('works for an owner with no existing hash', async () => {
      const owner = await createTestUser({ role: 'owner', username: 'owner', passwordHash: null });
      await resetPasswordCommand({ username: 'owner', password: 'newPassword123' });

      const [account] = await db
        .select()
        .from(authAccounts)
        .where(and(eq(authAccounts.userId, owner.id), eq(authAccounts.providerId, 'credential')));
      expect(account).toBeDefined();
      expect(await verifyPassword('newPassword123', account!.password!)).toBe(true);

      const [row] = await db.select().from(users).where(eq(users.id, owner.id));
      expect(row?.passwordHash).toBeTruthy();
    });

    it('updates an existing credential row instead of duplicating', async () => {
      const owner = await createTestUser({ role: 'owner', username: 'owner', passwordHash: null });
      await resetPasswordCommand({ username: 'owner', password: 'first1234' });
      await resetPasswordCommand({ username: 'owner', password: 'second1234' });
      const rows = await db
        .select()
        .from(authAccounts)
        .where(and(eq(authAccounts.userId, owner.id), eq(authAccounts.providerId, 'credential')));
      expect(rows).toHaveLength(1);
      expect(await verifyPassword('second1234', rows[0]!.password!)).toBe(true);
    });

    it('defaults to the first owner by created_at when no username is given', async () => {
      const owner = await createTestUser({
        role: 'owner',
        username: 'firstowner',
        passwordHash: null,
      });
      await resetPasswordCommand({ password: 'ownerPass123' });

      const [row] = await db.select().from(users).where(eq(users.id, owner.id));
      expect(row?.passwordHash).toBeTruthy();
    });

    it('throws a clear error for an unknown username', async () => {
      await expect(
        resetPasswordCommand({ username: 'doesnotexist', password: 'whatever123' })
      ).rejects.toThrow(/no user named/i);
    });

    it('finds legacy mixed-case usernames regardless of input case', async () => {
      const owner = await createTestUser({ role: 'owner', username: 'owner', passwordHash: null });
      await db.update(users).set({ username: 'Gallapagos' }).where(eq(users.id, owner.id));

      await resetPasswordCommand({ username: 'gallapagos', password: 'lowerInput123' });
      const [account] = await db
        .select()
        .from(authAccounts)
        .where(and(eq(authAccounts.userId, owner.id), eq(authAccounts.providerId, 'credential')));
      expect(await verifyPassword('lowerInput123', account!.password!)).toBe(true);

      await resetPasswordCommand({ username: 'Gallapagos', password: 'exactInput123' });
      await setEmailCommand({ username: 'GALLAPAGOS', newEmail: 'legacy@example.com' });
      const [row] = await db.select().from(users).where(eq(users.id, owner.id));
      expect(row?.email).toBe('legacy@example.com');
    });

    it('invalidates existing Better Auth sessions on reset', async () => {
      const owner = await createTestUser({ role: 'owner', username: 'owner', passwordHash: null });
      const token = 'test-session-token-123';

      await db.insert(authSessions).values({
        id: crypto.randomUUID(),
        token,
        userId: owner.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const redis = getRedis();
      const prefix = process.env.REDIS_PREFIX ?? '';
      const sessionKey = `${prefix}tracearr:ba:${token}`;
      const listKey = `${prefix}tracearr:ba:active-sessions-${owner.id}`;
      await redis.set(sessionKey, JSON.stringify({ session: { token } }), 'EX', 3600);
      await redis.set(
        listKey,
        JSON.stringify([{ token, expiresAt: Date.now() + 3600000 }]),
        'EX',
        3600
      );

      await resetPasswordCommand({ username: 'owner', password: 'newPassword123' });

      const remaining = await db
        .select()
        .from(authSessions)
        .where(eq(authSessions.userId, owner.id));
      expect(remaining).toHaveLength(0);
      expect(await redis.get(sessionKey)).toBeNull();
      expect(await redis.get(listKey)).toBeNull();
    });

    it('fails closed and changes nothing when Redis is unreachable', async () => {
      const owner = await createTestUser({
        role: 'owner',
        username: 'owner',
        passwordHash: '$2b$12$abcdefghijklmnopqrstuv',
      });
      await db.insert(authAccounts).values({
        id: crypto.randomUUID(),
        accountId: owner.id,
        providerId: 'credential',
        userId: owner.id,
        password: '$2b$12$abcdefghijklmnopqrstuv',
      });

      const token = 'redis-down-session-token';
      await db.insert(authSessions).values({
        id: crypto.randomUUID(),
        token,
        userId: owner.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const redis = getRedis();
      const delSpy = vi.spyOn(redis, 'del').mockRejectedValueOnce(new Error('ECONNREFUSED'));

      let caught: unknown;
      try {
        await resetPasswordCommand({ username: 'owner', password: 'newPassword123' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/redis is unreachable/i);
      expect((caught as Error).message).toMatch(/password was not changed/i);

      delSpy.mockRestore();

      const [account] = await db
        .select()
        .from(authAccounts)
        .where(and(eq(authAccounts.userId, owner.id), eq(authAccounts.providerId, 'credential')));
      expect(await verifyPassword('newPassword123', account!.password!)).toBe(false);
      expect(account!.password).toBe('$2b$12$abcdefghijklmnopqrstuv');

      const [row] = await db.select().from(users).where(eq(users.id, owner.id));
      expect(row?.passwordHash).toBe('$2b$12$abcdefghijklmnopqrstuv');

      const remaining = await db
        .select()
        .from(authSessions)
        .where(eq(authSessions.userId, owner.id));
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.token).toBe(token);
    });

    it('heals fully on retry after a transient Redis failure', async () => {
      const owner = await createTestUser({ role: 'owner', username: 'owner', passwordHash: null });
      const token = 'retry-session-token';

      await db.insert(authSessions).values({
        id: crypto.randomUUID(),
        token,
        userId: owner.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const redis = getRedis();
      const prefix = process.env.REDIS_PREFIX ?? '';
      const sessionKey = `${prefix}tracearr:ba:${token}`;
      const listKey = `${prefix}tracearr:ba:active-sessions-${owner.id}`;
      await redis.set(sessionKey, JSON.stringify({ session: { token } }), 'EX', 3600);
      await redis.set(
        listKey,
        JSON.stringify([{ token, expiresAt: Date.now() + 3600000 }]),
        'EX',
        3600
      );

      // First attempt fails partway through invalidation (Redis blips).
      const delSpy = vi.spyOn(redis, 'del').mockRejectedValueOnce(new Error('temporary blip'));
      await expect(
        resetPasswordCommand({ username: 'owner', password: 'newPassword123' })
      ).rejects.toThrow(/redis is unreachable/i);
      delSpy.mockRestore();

      // Nothing changed yet: session row and Redis keys are still exactly as before.
      const midRun = await db.select().from(authSessions).where(eq(authSessions.userId, owner.id));
      expect(midRun).toHaveLength(1);
      expect(await redis.get(sessionKey)).not.toBeNull();
      const [midAccount] = await db
        .select()
        .from(authAccounts)
        .where(and(eq(authAccounts.userId, owner.id), eq(authAccounts.providerId, 'credential')));
      expect(midAccount).toBeUndefined();

      // Retry with Redis healthy again fully heals: password set, session row
      // gone, both Redis keys gone - a re-run recovers the exact same token
      // list from the still-intact DB row and finishes the job.
      await resetPasswordCommand({ username: 'owner', password: 'newPassword123' });

      const [account] = await db
        .select()
        .from(authAccounts)
        .where(and(eq(authAccounts.userId, owner.id), eq(authAccounts.providerId, 'credential')));
      expect(await verifyPassword('newPassword123', account!.password!)).toBe(true);

      const finalSessions = await db
        .select()
        .from(authSessions)
        .where(eq(authSessions.userId, owner.id));
      expect(finalSessions).toHaveLength(0);
      expect(await redis.get(sessionKey)).toBeNull();
      expect(await redis.get(listKey)).toBeNull();
    });

    it('heals a partial state where Redis was already cleared but the auth_sessions row was not', async () => {
      const owner = await createTestUser({ role: 'owner', username: 'owner', passwordHash: null });
      const token = 'partial-state-session-token';

      await db.insert(authSessions).values({
        id: crypto.randomUUID(),
        token,
        userId: owner.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      // Simulate a prior attempt that made it through the Redis kill but died
      // before the transaction committed: Redis is already clean for this
      // token, but the auth_sessions row is still there. redis.del on an
      // already-absent key is a no-op, so the retry must not choke on it.
      const redis = getRedis();
      const prefix = process.env.REDIS_PREFIX ?? '';
      const sessionKey = `${prefix}tracearr:ba:${token}`;
      const listKey = `${prefix}tracearr:ba:active-sessions-${owner.id}`;
      expect(await redis.get(sessionKey)).toBeNull();
      expect(await redis.get(listKey)).toBeNull();

      await resetPasswordCommand({ username: 'owner', password: 'newPassword123' });

      const [account] = await db
        .select()
        .from(authAccounts)
        .where(and(eq(authAccounts.userId, owner.id), eq(authAccounts.providerId, 'credential')));
      expect(await verifyPassword('newPassword123', account!.password!)).toBe(true);

      const finalSessions = await db
        .select()
        .from(authSessions)
        .where(eq(authSessions.userId, owner.id));
      expect(finalSessions).toHaveLength(0);
    });

    it('does not choke on an orphaned Redis session key with no matching auth_sessions row, and still clears the per-user session list', async () => {
      const owner = await createTestUser({ role: 'owner', username: 'owner', passwordHash: null });

      // Simulate pre-existing damage from outside this command's control (e.g.
      // a row deleted directly, or leftover state from before this fix): a
      // Redis session-cache entry with no corresponding DB row, so its exact
      // key can never be rediscovered from the database. The per-user
      // active-sessions list key, which is derived from userId alone and
      // does not depend on any DB row, must still be cleared.
      const redis = getRedis();
      const prefix = process.env.REDIS_PREFIX ?? '';
      const orphanKey = `${prefix}tracearr:ba:orphaned-token-with-no-db-row`;
      const listKey = `${prefix}tracearr:ba:active-sessions-${owner.id}`;
      await redis.set(orphanKey, JSON.stringify({ session: { token: 'orphaned' } }), 'EX', 3600);
      await redis.set(listKey, JSON.stringify([]), 'EX', 3600);

      await expect(
        resetPasswordCommand({ username: 'owner', password: 'newPassword123' })
      ).resolves.toBeUndefined();

      const [account] = await db
        .select()
        .from(authAccounts)
        .where(and(eq(authAccounts.userId, owner.id), eq(authAccounts.providerId, 'credential')));
      expect(await verifyPassword('newPassword123', account!.password!)).toBe(true);
      expect(await redis.get(listKey)).toBeNull();
      // The orphaned key is unreachable by design (no DB row to derive it
      // from) - documented behavior, not a bug this command can fix.
      expect(await redis.get(orphanKey)).not.toBeNull();

      // Clean up the intentionally-undeletable key so it doesn't leak into
      // other test files sharing this Redis instance.
      await redis.del(orphanKey);
    });
  });

  describe('setUsernameCommand', () => {
    it('normalizes and preserves display form', async () => {
      await createTestUser({ role: 'owner', username: 'owner' });
      await setUsernameCommand({ identifier: 'owner', newUsername: 'NewName' });
      const [row] = await db.select().from(users).where(eq(users.username, 'newname'));
      expect(row?.displayUsername).toBe('NewName');
    });

    it('rejects a collision with a clean error and no partial write', async () => {
      await createTestUser({ role: 'owner', username: 'owner' });
      await createTestUser({ role: 'admin', username: 'admin' });

      await expect(
        setUsernameCommand({ identifier: 'admin', newUsername: 'owner' })
      ).rejects.toThrow(/already taken/i);

      const [adminRow] = await db.select().from(users).where(eq(users.username, 'admin'));
      expect(adminRow).toBeDefined();
      expect(adminRow?.displayUsername).not.toBe('owner');
    });

    it('throws for an unknown identifier', async () => {
      await expect(
        setUsernameCommand({ identifier: 'ghost', newUsername: 'whoever' })
      ).rejects.toThrow(/no user found/i);
    });
  });

  describe('setEmailCommand', () => {
    it('updates email and keeps email_verified true', async () => {
      const owner = await createTestUser({
        role: 'owner',
        username: 'owner',
        email: 'old@example.com',
      });
      await setEmailCommand({ username: 'owner', newEmail: 'new@example.com' });

      const [row] = await db.select().from(users).where(eq(users.id, owner.id));
      expect(row?.email).toBe('new@example.com');
      expect(row?.emailVerified).toBe(true);
    });

    it('rejects a collision with a clean error', async () => {
      await createTestUser({ role: 'owner', username: 'owner', email: 'owner@example.com' });
      await createTestUser({ role: 'admin', username: 'admin', email: 'admin@example.com' });

      await expect(
        setEmailCommand({ username: 'admin', newEmail: 'owner@example.com' })
      ).rejects.toThrow(/already in use/i);

      const [adminRow] = await db.select().from(users).where(eq(users.username, 'admin'));
      expect(adminRow?.email).toBe('admin@example.com');
    });
  });

  describe('listUsersCommand', () => {
    it('includes login methods derived from auth_accounts providers', async () => {
      const owner = await createTestUser({
        role: 'owner',
        username: 'owner',
        passwordHash: '$2b$12$abcdefghijklmnopqrstuv',
      });
      await db.insert(authAccounts).values({
        id: crypto.randomUUID(),
        accountId: owner.id,
        providerId: 'credential',
        userId: owner.id,
        password: '$2b$12$abcdefghijklmnopqrstuv',
      });
      await db.insert(authAccounts).values({
        id: crypto.randomUUID(),
        accountId: 'plex-123',
        providerId: 'plex',
        userId: owner.id,
      });
      await db.insert(plexAccounts).values({
        userId: owner.id,
        plexAccountId: 'plex-123',
        plexUsername: 'owner',
        plexToken: 'tok-abc',
        allowLogin: true,
      });
      await createTestUser({ role: 'member', username: 'noaccounts' });

      const rows = await listUsersCommand();
      expect(rows).toHaveLength(2);

      const ownerRow = rows.find((r) => r.username === 'owner');
      expect(ownerRow).toMatchObject({ username: 'owner', role: 'owner' });
      expect(ownerRow?.loginMethods.sort()).toEqual(['credential', 'plex']);

      const noAccountsRow = rows.find((r) => r.username === 'noaccounts');
      expect(noAccountsRow?.loginMethods).toEqual([]);
    });

    it('does not report plex as a login method when allow_login is off', async () => {
      const owner = await createTestUser({ role: 'owner', username: 'owner' });
      await db.insert(authAccounts).values({
        id: crypto.randomUUID(),
        accountId: 'plex-456',
        providerId: 'plex',
        userId: owner.id,
      });
      await db.insert(plexAccounts).values({
        userId: owner.id,
        plexAccountId: 'plex-456',
        plexUsername: 'owner',
        plexToken: 'tok-def',
        allowLogin: false,
      });

      const rows = await listUsersCommand();
      const ownerRow = rows.find((r) => r.username === 'owner');
      expect(ownerRow?.loginMethods).not.toContain('plex');
    });
  });

  describe('enableLocalLoginCommand', () => {
    it('turns local login back on and keeps the other methods', async () => {
      await setSetting('loginMethods', {
        local: false,
        plex: false,
        oidc: true,
        tofa: false,
        member: true,
      });
      await enableLocalLoginCommand();
      expect(await getSetting('loginMethods')).toEqual({
        local: true,
        plex: false,
        oidc: true,
        tofa: false,
        member: true,
      });
    });
  });
});
