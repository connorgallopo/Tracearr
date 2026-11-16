/**
 * Owner lockout guard integration tests
 *
 * Deleting a server, making it historical or splitting off one account is refused when it takes
 * the owner's last way to sign in, whichever server held it.
 *
 * Run with: pnpm --filter @tracearr/server test:integration ownerLockout
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { authAccounts, servers, serverUsers } from '../../src/db/schema.js';
import { assertOwnerKeepsALoginAfter } from '../../src/lib/authGuards.js';
import { splitServerUser } from '../../src/services/mergeService.js';

const REFUSED = {
  status: 'BAD_REQUEST',
  message: 'That would leave the owner with no way to sign in.',
};

describe('assertOwnerKeepsALoginAfter', () => {
  it('refuses removing the tofa server that holds the owner sign-in until a password remains', async () => {
    const owner = await createTestUser({ role: 'owner' });
    const tofa = await createTestServer({ type: 'tofa' });
    const other = await createTestServer({ type: 'tofa' });
    const own = await createTestServerUser({ userId: owner.id, serverId: tofa.id });
    await db
      .update(serverUsers)
      .set({ cloudIdentityId: 'cloud-owner' })
      .where(eq(serverUsers.id, own.id));
    await db
      .insert(authAccounts)
      .values({ id: randomUUID(), providerId: 'tofa', accountId: 'cloud-owner', userId: owner.id });

    await expect(
      assertOwnerKeepsALoginAfter({ kind: 'deleteServer', serverId: tofa.id })
    ).rejects.toMatchObject(REFUSED);
    await expect(
      assertOwnerKeepsALoginAfter({ kind: 'retireServer', serverId: tofa.id })
    ).rejects.toMatchObject(REFUSED);
    await expect(
      assertOwnerKeepsALoginAfter({ kind: 'unlinkAccount', serverUserId: own.id })
    ).rejects.toMatchObject(REFUSED);
    await expect(
      assertOwnerKeepsALoginAfter({ kind: 'deleteServer', serverId: other.id })
    ).resolves.toBeUndefined();

    await db.insert(authAccounts).values({
      id: randomUUID(),
      providerId: 'credential',
      accountId: owner.id,
      userId: owner.id,
      password: 'hash',
    });
    await expect(
      assertOwnerKeepsALoginAfter({ kind: 'deleteServer', serverId: tofa.id })
    ).resolves.toBeUndefined();
  });

  it('protects an owner who signs in only through their own Jellyfin account', async () => {
    const owner = await createTestUser({ role: 'owner' });
    const jellyfin = await createTestServer({ type: 'jellyfin' });
    await db.update(servers).set({ allowMemberLogin: true }).where(eq(servers.id, jellyfin.id));
    await createTestServerUser({ userId: owner.id, serverId: jellyfin.id });

    await expect(
      assertOwnerKeepsALoginAfter({ kind: 'deleteServer', serverId: jellyfin.id })
    ).rejects.toMatchObject(REFUSED);
    await expect(
      assertOwnerKeepsALoginAfter({ kind: 'retireServer', serverId: jellyfin.id })
    ).rejects.toMatchObject(REFUSED);
  });

  it("refuses splitting off the owner's account that is their only way in, from any caller", async () => {
    const owner = await createTestUser({ role: 'owner' });
    const jellyfin = await createTestServer({ type: 'jellyfin' });
    const emby = await createTestServer({ type: 'emby' });
    await db.update(servers).set({ allowMemberLogin: true }).where(eq(servers.id, jellyfin.id));
    const own = await createTestServerUser({ userId: owner.id, serverId: jellyfin.id });
    await createTestServerUser({ userId: owner.id, serverId: emby.id });

    await expect(splitServerUser(own.id, owner.id)).rejects.toMatchObject(REFUSED);
    const [kept] = await db
      .select({ userId: serverUsers.userId })
      .from(serverUsers)
      .where(eq(serverUsers.id, own.id));
    expect(kept?.userId).toBe(owner.id);
  });

  it("keeps a Plex owner's sign-in when their Plex server only goes historical", async () => {
    const owner = await createTestUser({ role: 'owner' });
    const plex = await createTestServer({ type: 'plex' });
    const own = await createTestServerUser({
      userId: owner.id,
      serverId: plex.id,
      externalId: 'plex-tv-1',
    });
    await db
      .update(serverUsers)
      .set({ plexAccountId: 'plex-tv-1' })
      .where(eq(serverUsers.id, own.id));

    await expect(
      assertOwnerKeepsALoginAfter({ kind: 'retireServer', serverId: plex.id })
    ).resolves.toBeUndefined();
    await expect(
      assertOwnerKeepsALoginAfter({ kind: 'deleteServer', serverId: plex.id })
    ).rejects.toMatchObject(REFUSED);
  });
});
