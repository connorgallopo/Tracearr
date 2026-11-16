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
import {
  authAccounts,
  authSessions,
  mobileSessions,
  serverUsers,
  sessions,
  users,
} from '../../src/db/schema.js';
import { upsertTofaAccount } from '../../src/lib/memberLogin.js';
import { MergeValidationError, mergeUsers } from '../../src/services/mergeService.js';
import {
  getOwnerLinks,
  linkOwnerAccount,
  linkOwnerTofaAccount,
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
    expect(here?.linked).toEqual({
      serverUserId: account.id,
      username: 'gabriel',
      canUnlink: true,
    });
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
  it('restores the person of the latest link after an earlier link of the same account was undone', async () => {
    const owner = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'jellyfin' });
    const first = await createTestUser({ role: 'member', username: 'alpha' });
    const account = await createTestServerUser({ userId: first.id, serverId: server.id });
    const holder = await createTestUser({ role: 'member', username: 'bravo' });
    await mergeUsers(first.id, holder.id, owner.id);
    await linkOwnerAccount(owner.id, account.id);
    await unlinkOwnerAccount(owner.id, account.id, undefined);
    await linkOwnerAccount(owner.id, account.id);

    const { newUserId } = await unlinkOwnerAccount(owner.id, account.id, undefined);

    const [restored] = await db.select().from(users).where(eq(users.id, newUserId));
    expect(restored?.username).toBe('alpha');
  });

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

describe('linkOwnerTofaAccount', () => {
  async function ownerWithTofaAccount() {
    const owner = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'tofa' });
    const person = await createTestUser({ role: 'member', username: 'morgan' });
    const account = await createTestServerUser({
      userId: person.id,
      serverId: server.id,
      username: 'morgan',
    });
    await db
      .update(serverUsers)
      .set({ cloudIdentityId: 'cloud-owner' })
      .where(eq(serverUsers.id, account.id));
    return { owner, server, account };
  }

  async function tofaSignInHolder(): Promise<string | undefined> {
    const [row] = await db
      .select({ userId: authAccounts.userId })
      .from(authAccounts)
      .where(eq(authAccounts.accountId, 'cloud-owner'));
    return row?.userId;
  }

  it("folds in the account the sign-in names with the owner's tofa sign-in, and unlinking hands both back", async () => {
    const { owner, server, account } = await ownerWithTofaAccount();
    await db.insert(authAccounts).values({
      id: randomUUID(),
      providerId: 'credential',
      accountId: owner.id,
      userId: owner.id,
      password: 'hash',
    });
    expect((await getOwnerLinks(owner.id)).find((l) => l.serverId === server.id)).toEqual({
      serverId: server.id,
      linked: null,
      candidates: [],
    });

    await linkOwnerTofaAccount(owner.id, server.id, 'cloud-owner');

    const [moved] = await db.select().from(serverUsers).where(eq(serverUsers.id, account.id));
    expect(moved?.userId).toBe(owner.id);
    expect(await tofaSignInHolder()).toBe(owner.id);
    const [here] = await getOwnerLinks(owner.id);
    expect(here?.linked).toEqual({
      serverUserId: account.id,
      username: 'morgan',
      canUnlink: true,
    });

    const { newUserId } = await unlinkOwnerAccount(owner.id, account.id, undefined);

    expect(await tofaSignInHolder()).toBe(newUserId);
  });

  it('offers no unlink for the tofa account the owner connected with, which keeps their sign-in', async () => {
    const owner = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'tofa' });
    const own = await createTestServerUser({ userId: owner.id, serverId: server.id });
    await db
      .update(serverUsers)
      .set({ cloudIdentityId: 'cloud-owner' })
      .where(eq(serverUsers.id, own.id));
    await db
      .insert(authAccounts)
      .values({ id: randomUUID(), providerId: 'tofa', accountId: 'cloud-owner', userId: owner.id });

    const [here] = await getOwnerLinks(owner.id);

    expect(here?.linked).toEqual({
      serverUserId: own.id,
      username: own.username,
      canUnlink: false,
    });
  });

  it('offers and performs the unlink of a tofa account that reached its person through an earlier merge', async () => {
    const { owner, server, account } = await ownerWithTofaAccount();
    await db.insert(authAccounts).values({
      id: randomUUID(),
      providerId: 'credential',
      accountId: owner.id,
      userId: owner.id,
      password: 'hash',
    });
    // B holds only the account, folded in from its first person by an earlier merge.
    const held = await createTestUser({ role: 'member', username: 'holder' });
    await mergeUsers(account.userId, held.id, owner.id);
    await linkOwnerTofaAccount(owner.id, server.id, 'cloud-owner');

    const [here] = await getOwnerLinks(owner.id);
    expect(here?.linked?.canUnlink).toBe(true);

    const { newUserId } = await unlinkOwnerAccount(owner.id, account.id, undefined);

    expect(await tofaSignInHolder()).toBe(newUserId);
  });

  it("keeps the owner's own tofa sign-in after a chained link was unlinked and the sign-in came back", async () => {
    const { owner, server, account } = await ownerWithTofaAccount();
    await db.insert(authAccounts).values({
      id: randomUUID(),
      providerId: 'credential',
      accountId: owner.id,
      userId: owner.id,
      password: 'hash',
    });
    const second = await createTestUser({ role: 'member' });
    const third = await createTestUser({ role: 'member' });
    await mergeUsers(account.userId, second.id, owner.id);
    await mergeUsers(second.id, third.id, owner.id);
    await linkOwnerTofaAccount(owner.id, server.id, 'cloud-owner');
    await unlinkOwnerAccount(owner.id, account.id, undefined);
    // Connecting another tofa server through tofa cloud gives the owner this sign-in as their own.
    await upsertTofaAccount(owner.id, 'cloud-owner');
    await linkOwnerTofaAccount(owner.id, server.id, 'cloud-owner');

    await expect(unlinkOwnerAccount(owner.id, account.id, undefined)).rejects.toThrow(
      'cannot split off the account the owner signs in with'
    );
    expect(await tofaSignInHolder()).toBe(owner.id);
  });

  it('gives a sign-in that came back to the owner outside a merge an id no merge recorded', async () => {
    const { owner, server, account } = await ownerWithTofaAccount();
    await db.insert(authAccounts).values({
      id: randomUUID(),
      providerId: 'credential',
      accountId: owner.id,
      userId: owner.id,
      password: 'hash',
    });
    await linkOwnerTofaAccount(owner.id, server.id, 'cloud-owner');
    const member = await createTestUser({ role: 'member' });
    // A member sign-in takes the row, and connecting a tofa server through tofa cloud brings it back.
    await upsertTofaAccount(member.id, 'cloud-owner');
    await upsertTofaAccount(owner.id, 'cloud-owner');

    await expect(unlinkOwnerAccount(owner.id, account.id, undefined)).rejects.toThrow(
      'cannot split off the account the owner signs in with'
    );
    expect(await tofaSignInHolder()).toBe(owner.id);
  });

  it('refuses a tofa sign-in with no live account on that server', async () => {
    const { owner, server, account } = await ownerWithTofaAccount();
    await db
      .update(serverUsers)
      .set({ removedAt: new Date() })
      .where(eq(serverUsers.id, account.id));

    await expect(linkOwnerTofaAccount(owner.id, server.id, 'cloud-owner')).rejects.toBeInstanceOf(
      MergeValidationError
    );
    expect(await tofaSignInHolder()).toBeUndefined();
  });

  it('keeps the owner tofa sign-in where it was when the merge is refused', async () => {
    const { owner, server, account } = await ownerWithTofaAccount();
    const connected = await createTestServer({ type: 'tofa' });
    const own = await createTestServerUser({ userId: owner.id, serverId: connected.id });
    await db
      .update(serverUsers)
      .set({ cloudIdentityId: 'cloud-owner' })
      .where(eq(serverUsers.id, own.id));
    await db
      .insert(authAccounts)
      .values({ id: randomUUID(), providerId: 'tofa', accountId: 'cloud-owner', userId: owner.id });
    // An admin signs in on their own, so the merge refuses to fold them in.
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, account.userId));

    await expect(linkOwnerTofaAccount(owner.id, server.id, 'cloud-owner')).rejects.toBeInstanceOf(
      MergeValidationError
    );
    expect(await tofaSignInHolder()).toBe(owner.id);
  });

  it('writes no tofa sign-in when the merge it rides on is refused', async () => {
    const { owner, server, account } = await ownerWithTofaAccount();
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, account.userId));

    await expect(linkOwnerTofaAccount(owner.id, server.id, 'cloud-owner')).rejects.toBeInstanceOf(
      MergeValidationError
    );
    expect(await tofaSignInHolder()).toBeUndefined();
  });

  it("refuses to unlink the tofa account that is the owner's last way to sign in", async () => {
    const { owner, server, account } = await ownerWithTofaAccount();
    await linkOwnerTofaAccount(owner.id, server.id, 'cloud-owner');

    await expect(unlinkOwnerAccount(owner.id, account.id, undefined)).rejects.toMatchObject({
      message: 'That would leave the owner with no way to sign in.',
    });
    expect(await tofaSignInHolder()).toBe(owner.id);
  });
});
