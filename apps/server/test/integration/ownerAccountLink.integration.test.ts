/**
 * Owner account link integration tests
 *
 * The owner's own Jellyfin or Emby account folded into the owner through a merge, the refusals
 * that keep anyone else's account out, and unlinking back to a person of its own.
 *
 * Run with: pnpm --filter @tracearr/server test:integration ownerAccountLink
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { authSessions, mobileSessions, serverUsers, sessions, users } from '../../src/db/schema.js';
import { MergeValidationError } from '../../src/services/mergeService.js';
import {
  getOwnerLinks,
  linkOwnerAccount,
  unlinkOwnerAccount,
} from '../../src/services/ownerAccountLink.js';
import { ServerUserNotFoundError } from '../../src/services/userService.js';

async function insertAuthSession(userId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(authSessions).values({
    id,
    expiresAt: new Date(Date.now() + 60_000),
    token: randomUUID(),
    userId,
  });
  return id;
}

async function authSessionExists(id: string): Promise<boolean> {
  const rows = await db.select().from(authSessions).where(eq(authSessions.id, id));
  return rows.length > 0;
}

async function ownerWithJellyfinAccount() {
  const owner = await createTestUser({ role: 'owner' });
  const server = await createTestServer({ type: 'jellyfin' });
  const person = await createTestUser({ role: 'member', username: 'gabriel' });
  const account = await createTestServerUser({
    userId: person.id,
    serverId: server.id,
    username: 'gabriel',
    isServerAdmin: true,
  });
  return { owner, server, person, account };
}

describe('getOwnerLinks', () => {
  it('lists linkable accounts on Jellyfin and Emby servers with the reason any is refused', async () => {
    const { owner, server, account } = await ownerWithJellyfinAccount();
    const plex = await createTestServer({ type: 'plex' });
    const other = await createTestServer({ type: 'emby' });
    const traveler = await createTestUser({ role: 'member' });
    const travelerHere = await createTestServerUser({ userId: traveler.id, serverId: server.id });
    await createTestServerUser({ userId: traveler.id, serverId: other.id });
    const admin = await createTestUser({ role: 'admin' });
    const adminHere = await createTestServerUser({ userId: admin.id, serverId: server.id });
    const gone = await createTestUser({ role: 'member' });
    await createTestServerUser({ userId: gone.id, serverId: server.id, removedAt: new Date() });
    await createTestServerUser({
      userId: (await createTestUser({ role: 'member' })).id,
      serverId: plex.id,
    });

    const links = await getOwnerLinks(owner.id);

    expect(links.map((l) => l.serverId).sort()).toEqual([server.id, other.id].sort());
    const here = links.find((l) => l.serverId === server.id);
    expect(here?.linked).toBeNull();
    const reasons = Object.fromEntries(
      (here?.candidates ?? []).map((c) => [c.serverUserId, c.blockedReason])
    );
    expect(reasons).toEqual({
      [account.id]: null,
      [travelerHere.id]: 'other_accounts',
      [adminHere.id]: 'signs_in',
    });
  });

  it("reports the owner's account and offers nothing else on that server", async () => {
    const { owner, server, account } = await ownerWithJellyfinAccount();
    await linkOwnerAccount(owner.id, account.id);

    const [here] = await getOwnerLinks(owner.id);

    expect(here?.serverId).toBe(server.id);
    expect(here?.linked).toEqual({ serverUserId: account.id, username: 'gabriel' });
    expect(here?.candidates).toEqual([]);
  });
});

describe('linkOwnerAccount', () => {
  it('moves the account and its plays to the owner and removes the person it belonged to', async () => {
    const { owner, server, person, account } = await ownerWithJellyfinAccount();
    const play = await createTestSession({ serverId: server.id, serverUserId: account.id });

    await linkOwnerAccount(owner.id, account.id);

    const [moved] = await db.select().from(serverUsers).where(eq(serverUsers.id, account.id));
    expect(moved?.userId).toBe(owner.id);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, play.id));
    expect(session?.serverUserId).toBe(account.id);
    expect(await db.select().from(users).where(eq(users.id, person.id))).toEqual([]);
  });

  it('refuses a Plex account, a removed one, and a person with accounts elsewhere', async () => {
    const owner = await createTestUser({ role: 'owner' });
    const plex = await createTestServer({ type: 'plex' });
    const jellyfin = await createTestServer({ type: 'jellyfin' });
    const emby = await createTestServer({ type: 'emby' });
    const plexPerson = await createTestUser({ role: 'member' });
    const plexAccount = await createTestServerUser({ userId: plexPerson.id, serverId: plex.id });
    const gonePerson = await createTestUser({ role: 'member' });
    const goneAccount = await createTestServerUser({
      userId: gonePerson.id,
      serverId: jellyfin.id,
      removedAt: new Date(),
    });
    const traveler = await createTestUser({ role: 'member' });
    const travelerHere = await createTestServerUser({ userId: traveler.id, serverId: jellyfin.id });
    await createTestServerUser({ userId: traveler.id, serverId: emby.id });

    for (const id of [plexAccount.id, goneAccount.id, travelerHere.id]) {
      await expect(linkOwnerAccount(owner.id, id)).rejects.toBeInstanceOf(MergeValidationError);
    }
    const [stillTraveler] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, travelerHere.id));
    expect(stillTraveler?.userId).toBe(traveler.id);
  });

  it('refuses a second account on a server where the owner already has one', async () => {
    const { owner, server, account } = await ownerWithJellyfinAccount();
    await linkOwnerAccount(owner.id, account.id);
    const second = await createTestUser({ role: 'member' });
    const secondHere = await createTestServerUser({ userId: second.id, serverId: server.id });

    await expect(linkOwnerAccount(owner.id, secondHere.id)).rejects.toThrow(
      'You already have an account linked on this server'
    );
  });

  it('refuses a person who signs in on their own', async () => {
    const owner = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'jellyfin' });
    const admin = await createTestUser({ role: 'admin' });
    const adminHere = await createTestServerUser({ userId: admin.id, serverId: server.id });

    await expect(linkOwnerAccount(owner.id, adminHere.id)).rejects.toBeInstanceOf(
      MergeValidationError
    );
  });
});

describe('unlinkOwnerAccount', () => {
  it("restores the person, keeps this browser and paired phones, and ends the owner's other sessions", async () => {
    const { owner, account } = await ownerWithJellyfinAccount();
    await linkOwnerAccount(owner.id, account.id);
    const current = await insertAuthSession(owner.id);
    const elsewhere = await insertAuthSession(owner.id);
    const phone = await insertAuthSession(owner.id);
    await db.insert(mobileSessions).values({
      userId: owner.id,
      refreshTokenHash: randomUUID().replace(/-/g, ''),
      betterAuthSessionId: phone,
      deviceName: 'phone',
      deviceId: randomUUID(),
      platform: 'ios',
    });

    const { newUserId } = await unlinkOwnerAccount(owner.id, account.id, current);

    const [restored] = await db.select().from(users).where(eq(users.id, newUserId));
    expect(restored?.username).toBe('gabriel');
    expect(restored?.role).toBe('member');
    const [detached] = await db.select().from(serverUsers).where(eq(serverUsers.id, account.id));
    expect(detached?.userId).toBe(newUserId);
    expect(await authSessionExists(current)).toBe(true);
    expect(await authSessionExists(phone)).toBe(true);
    expect(await authSessionExists(elsewhere)).toBe(false);
  });

  it("refuses an account that is not the owner's", async () => {
    const { owner, account } = await ownerWithJellyfinAccount();

    await expect(unlinkOwnerAccount(owner.id, account.id, undefined)).rejects.toBeInstanceOf(
      ServerUserNotFoundError
    );
  });
});
