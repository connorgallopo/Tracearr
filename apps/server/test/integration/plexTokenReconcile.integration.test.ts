/**
 * Plex token reconcile acceptance proof (issue #1040).
 *
 * A revoked Plex token leaves servers.token dead and, on older installs,
 * servers.plex_account_id null with no way to repair the link from stored
 * state. reconcilePlexAccountToken treats plex.tv as the authority on which
 * account owns which machine identifier and rewrites the caches from it.
 *
 * The route tests mock the query chain, which cannot check a WHERE clause, so
 * the reconcile semantics are pinned here against a real database.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- plexTokenReconcile
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ServerType } from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import { authAccounts, plexAccounts, servers, users } from '../../src/db/schema.js';
import { PlexClient } from '../../src/services/mediaServer/index.js';
import { reconcilePlexAccountToken } from '../../src/services/plexAccounts.js';

vi.mock('../../src/services/serverIdentity.js', () => ({
  ensureServerIdentifier: vi.fn().mockResolvedValue(null),
}));

const DEAD = 'dead-token';
const FRESH = 'fresh-token';

function ownedResource(clientIdentifier: string) {
  return { clientIdentifier } as Awaited<ReturnType<typeof PlexClient.getServers>>[number];
}

async function seedAccount(plexTvId = `plex-tv-${randomUUID()}`) {
  const [user] = await db
    .insert(users)
    .values({ username: `owner-${randomUUID().slice(0, 8)}`, role: 'owner' })
    .returning();

  const [account] = await db
    .insert(plexAccounts)
    .values({
      userId: user!.id,
      plexAccountId: plexTvId,
      plexUsername: 'owner',
      plexToken: DEAD,
      allowLogin: true,
    })
    .returning();

  return account!;
}

async function seedServer(overrides: {
  plexAccountId?: string | null;
  machineIdentifier?: string | null;
  type?: Extract<ServerType, 'plex' | 'jellyfin'>;
}) {
  const [server] = await db
    .insert(servers)
    .values({
      name: `Server ${randomUUID().slice(0, 8)}`,
      type: overrides.type ?? 'plex',
      url: `http://10.0.0.1:${32400 + Math.floor(Math.random() * 1000)}`,
      token: DEAD,
      plexAccountId: overrides.plexAccountId ?? null,
      machineIdentifier: overrides.machineIdentifier ?? null,
    })
    .returning();

  return server!;
}

function authFor(account: { plexAccountId: string }) {
  return {
    id: account.plexAccountId,
    username: 'owner',
    email: 'owner@example.com',
    thumb: 'https://plex.tv/thumb.png',
    token: FRESH,
    tokenKind: 'legacy' as const,
    refreshToken: null,
    expiresAt: null,
  };
}

async function tokenOf(serverId: string) {
  const [row] = await db
    .select({ token: servers.token, plexAccountId: servers.plexAccountId })
    .from(servers)
    .where(eq(servers.id, serverId));
  return row!;
}

describe('reconcilePlexAccountToken', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refreshes servers already linked to the account', async () => {
    const account = await seedAccount();
    const server = await seedServer({ plexAccountId: account.id, machineIdentifier: 'mach-a' });
    vi.spyOn(PlexClient, 'getServers').mockResolvedValue([ownedResource('mach-a')]);

    const result = await reconcilePlexAccountToken(account, authFor(account));

    expect(result.reconciled).toEqual([
      expect.objectContaining({ id: server.id, status: 'refreshed' }),
    ]);
    expect((await tokenOf(server.id)).token).toBe(FRESH);
  });

  it('adopts an unlinked server plex.tv reports the account owns', async () => {
    const account = await seedAccount();
    const orphan = await seedServer({ plexAccountId: null, machineIdentifier: 'mach-orphan' });
    vi.spyOn(PlexClient, 'getServers').mockResolvedValue([ownedResource('mach-orphan')]);

    const result = await reconcilePlexAccountToken(account, authFor(account));

    expect(result.reconciled).toEqual([
      expect.objectContaining({ id: orphan.id, status: 'adopted' }),
    ]);
    const row = await tokenOf(orphan.id);
    expect(row.token).toBe(FRESH);
    expect(row.plexAccountId).toBe(account.id);
  });

  it('leaves another account’s servers untouched', async () => {
    const mine = await seedAccount();
    const theirs = await seedAccount();
    const myServer = await seedServer({ plexAccountId: mine.id, machineIdentifier: 'mach-mine' });
    const theirServer = await seedServer({
      plexAccountId: theirs.id,
      machineIdentifier: 'mach-theirs',
    });
    // plex.tv only reports the servers this account owns
    vi.spyOn(PlexClient, 'getServers').mockResolvedValue([ownedResource('mach-mine')]);

    await reconcilePlexAccountToken(mine, authFor(mine));

    expect((await tokenOf(myServer.id)).token).toBe(FRESH);
    const untouched = await tokenOf(theirServer.id);
    expect(untouched.token).toBe(DEAD);
    expect(untouched.plexAccountId).toBe(theirs.id);
  });

  it('never touches Jellyfin or Emby rows', async () => {
    const account = await seedAccount();
    const jellyfin = await seedServer({ type: 'jellyfin', machineIdentifier: 'mach-jf' });
    // Same identifier plex.tv reports, to prove the type guard carries the weight
    vi.spyOn(PlexClient, 'getServers').mockResolvedValue([ownedResource('mach-jf')]);

    await reconcilePlexAccountToken(account, authFor(account));

    expect((await tokenOf(jellyfin.id)).token).toBe(DEAD);
  });

  it('reports an unlinked server it cannot attribute rather than skipping it', async () => {
    const account = await seedAccount();
    const linked = await seedServer({ plexAccountId: account.id, machineIdentifier: 'mach-a' });
    const stranded = await seedServer({ plexAccountId: null, machineIdentifier: null });
    vi.spyOn(PlexClient, 'getServers').mockResolvedValue([ownedResource('mach-a')]);

    const result = await reconcilePlexAccountToken(account, authFor(account));

    expect(result.reconciled.map((s) => s.id)).toEqual([linked.id]);
    expect(result.unmatched).toEqual([expect.objectContaining({ id: stranded.id })]);
    expect((await tokenOf(stranded.id)).token).toBe(DEAD);
  });

  it('still refreshes linked servers when plex.tv is unreachable', async () => {
    const account = await seedAccount();
    const linked = await seedServer({ plexAccountId: account.id, machineIdentifier: 'mach-a' });
    const orphan = await seedServer({ plexAccountId: null, machineIdentifier: 'mach-orphan' });
    vi.spyOn(PlexClient, 'getServers').mockRejectedValue(new Error('plex.tv unreachable'));

    const result = await reconcilePlexAccountToken(account, authFor(account));

    expect(result.reconciled.map((s) => s.id)).toEqual([linked.id]);
    expect((await tokenOf(linked.id)).token).toBe(FRESH);
    // Adoption needs plex.tv's answer, so the orphan stays put and is reported
    expect((await tokenOf(orphan.id)).token).toBe(DEAD);
    expect(result.unmatched).toEqual([expect.objectContaining({ id: orphan.id })]);
  });

  it('writes the account row and the Better Auth mirror in the same transaction', async () => {
    const account = await seedAccount();
    await seedServer({ plexAccountId: account.id, machineIdentifier: 'mach-a' });
    vi.spyOn(PlexClient, 'getServers').mockResolvedValue([ownedResource('mach-a')]);

    await reconcilePlexAccountToken(account, authFor(account));

    const [stored] = await db
      .select({ plexToken: plexAccounts.plexToken })
      .from(plexAccounts)
      .where(eq(plexAccounts.id, account.id));
    expect(stored!.plexToken).toBe(FRESH);

    const [mirror] = await db
      .select({ accessToken: authAccounts.accessToken })
      .from(authAccounts)
      .where(eq(authAccounts.accountId, account.plexAccountId));
    expect(mirror!.accessToken).toBe(FRESH);
  });

  it('rolls the server and account writes back when the Better Auth mirror fails', async () => {
    const account = await seedAccount();
    const server = await seedServer({ plexAccountId: account.id, machineIdentifier: 'mach-a' });
    vi.spyOn(PlexClient, 'getServers').mockResolvedValue([ownedResource('mach-a')]);

    // A user id with no users row violates the auth_accounts FK, failing the
    // last statement in the transaction.
    const doomed = { ...account, userId: randomUUID() };
    await expect(reconcilePlexAccountToken(doomed, authFor(account))).rejects.toThrow();

    expect((await tokenOf(server.id)).token).toBe(DEAD);
    const [stored] = await db
      .select({ plexToken: plexAccounts.plexToken })
      .from(plexAccounts)
      .where(eq(plexAccounts.id, account.id));
    expect(stored!.plexToken).toBe(DEAD);
  });
});
