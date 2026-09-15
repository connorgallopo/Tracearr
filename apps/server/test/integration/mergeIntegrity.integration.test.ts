/**
 * Merge/split integrity integration tests
 *
 * Covers three gaps identified in a review of mergeService.ts:
 * - chained merges must not lose an earlier merge's audit row when the
 *   in-between identity is later deleted as the source of a further merge
 * - split must move plex_accounts / mobile_sessions / mobile_tokens rows
 *   that were repointed by an earlier merge back onto the restored identity
 * - a multi-account merge's audit must stay usable across every split of
 *   the accounts it moved, not just the first one
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- mergeIntegrity
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
import {
  users,
  serverUsers,
  serverUserExternalAliases,
  mobileSessions,
  mobileTokens,
  userMergeAudits,
} from '../../src/db/schema.js';
import { mergeUsers, splitServerUser } from '../../src/services/mergeService.js';
import {
  getServerUserByExternalId,
  syncUserFromMediaServer,
} from '../../src/services/userService.js';

describe('chained merges preserve the audit trail', () => {
  it('repoints an earlier audit onto the final target instead of letting it cascade-delete', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const serverC = await createTestServer({ type: 'emby' });

    const identityA = await createTestUser({ role: 'member', username: 'identity-a' });
    const identityB = await createTestUser({ role: 'member', username: 'identity-b' });
    const identityC = await createTestUser({ role: 'member', username: 'identity-c' });

    const suA = await createTestServerUser({ userId: identityA.id, serverId: serverA.id });
    await createTestServerUser({ userId: identityB.id, serverId: serverB.id });
    await createTestServerUser({ userId: identityC.id, serverId: serverC.id });

    // A -> B: audit1.targetUserId = B, movedServerUserIds = [suA]
    const mergeAB = await mergeUsers(identityA.id, identityB.id, admin.id);

    // B, now owning suA plus its own account, merges into C.
    // audit1 must be repointed onto C before B's row is deleted, or the
    // cascade FK on user_merge_audits.target_user_id destroys it.
    await mergeUsers(identityB.id, identityC.id, admin.id);

    const [audit1] = await db
      .select()
      .from(userMergeAudits)
      .where(eq(userMergeAudits.id, mergeAB.auditId));
    expect(audit1).toBeDefined();
    expect(audit1?.targetUserId).toBe(identityC.id);
    expect(audit1?.undoneAt).toBeNull();
    // Attribution to the acting admin who ran the A->B merge is untouched.
    expect(audit1?.actingUserId).toBe(admin.id);

    // Splitting the A-derived account back out of C restores A's own
    // snapshot, not B's (which absorbed it along the way).
    const splitResult = await splitServerUser(suA.id, admin.id);
    const [restored] = await db.select().from(users).where(eq(users.id, splitResult.newUserId));
    expect(restored?.username).toBe('identity-a');

    const [auditAfterSplit] = await db
      .select()
      .from(userMergeAudits)
      .where(eq(userMergeAudits.id, mergeAB.auditId));
    expect(auditAfterSplit?.undoneAt).not.toBeNull();
  });
});

describe('split restores rows a merge moved off the source identity', () => {
  // plex_accounts rows are only ever created for owner-role identities (Plex
  // OAuth login/discovery), and assertMergeDirection already refuses any
  // login-capable identity as a merge source - so a real merge can never move
  // a plex_accounts row off a source. mobile_sessions and mobile_tokens carry
  // no such restriction (a 'member' identity can pair a device), so they are
  // what actually exercises this path in production; plexAccountIds is
  // asserted to stay an empty array rather than null, which is what proves
  // the capture ran instead of being skipped.
  it('moves a mobile session and mobile token back onto the split identity, leaving the target unchanged', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

    const [targetMobileToken] = await db
      .insert(mobileTokens)
      .values({
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        createdBy: target.id,
      })
      .returning();
    const [sourceMobileToken] = await db
      .insert(mobileTokens)
      .values({
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        createdBy: source.id,
      })
      .returning();
    const [sourceMobileSession] = await db
      .insert(mobileSessions)
      .values({
        userId: source.id,
        refreshTokenHash: randomUUID(),
        deviceName: 'Source Device',
        deviceId: randomUUID(),
        platform: 'ios',
      })
      .returning();

    const mergeResult = await mergeUsers(source.id, target.id, admin.id);

    // Merge repoints both rows onto the target.
    const [movedMobileToken] = await db
      .select()
      .from(mobileTokens)
      .where(eq(mobileTokens.id, sourceMobileToken!.id));
    expect(movedMobileToken?.createdBy).toBe(target.id);
    const [movedMobileSession] = await db
      .select()
      .from(mobileSessions)
      .where(eq(mobileSessions.id, sourceMobileSession!.id));
    expect(movedMobileSession?.userId).toBe(target.id);

    const [audit] = await db
      .select()
      .from(userMergeAudits)
      .where(eq(userMergeAudits.id, mergeResult.auditId));
    expect(audit?.movedIdentityRowIds).toEqual({
      plexAccountIds: [],
      mobileSessionIds: [sourceMobileSession!.id],
      mobileTokenIds: [sourceMobileToken!.id],
    });

    const splitResult = await splitServerUser(sourceSu.id, admin.id);

    const [splitMobileToken] = await db
      .select()
      .from(mobileTokens)
      .where(eq(mobileTokens.id, sourceMobileToken!.id));
    expect(splitMobileToken?.createdBy).toBe(splitResult.newUserId);
    const [splitMobileSession] = await db
      .select()
      .from(mobileSessions)
      .where(eq(mobileSessions.id, sourceMobileSession!.id));
    expect(splitMobileSession?.userId).toBe(splitResult.newUserId);

    // The target's own mobile token never moved.
    const [untouchedTargetMobileToken] = await db
      .select()
      .from(mobileTokens)
      .where(eq(mobileTokens.id, targetMobileToken!.id));
    expect(untouchedTargetMobileToken?.createdBy).toBe(target.id);
  });
});

describe('multi-account merge audit stays usable across both splits', () => {
  it('gives each split the source snapshot and only marks the audit undone after the last one', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const serverC = await createTestServer({ type: 'emby' });

    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member', username: 'multi-source' });
    await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSuB = await createTestServerUser({ userId: source.id, serverId: serverB.id });
    const sourceSuC = await createTestServerUser({ userId: source.id, serverId: serverC.id });

    const mergeResult = await mergeUsers(source.id, target.id, admin.id);
    expect(mergeResult.movedServerUserIds.sort()).toEqual([sourceSuB.id, sourceSuC.id].sort());

    // First split: audit still covers the other moved account, so it must
    // stay usable rather than being marked undone immediately.
    const firstSplit = await splitServerUser(sourceSuB.id, admin.id);
    const [firstRestored] = await db.select().from(users).where(eq(users.id, firstSplit.newUserId));
    expect(firstRestored?.username).toBe('multi-source');

    const [auditAfterFirst] = await db
      .select()
      .from(userMergeAudits)
      .where(eq(userMergeAudits.id, mergeResult.auditId));
    expect(auditAfterFirst?.undoneAt).toBeNull();

    // Target's aggregates recompute after the first split too.
    const [targetAfterFirst] = await db.select().from(users).where(eq(users.id, target.id));
    expect(targetAfterFirst).toBeDefined();

    // Second split: now every moved account has been split away.
    const secondSplit = await splitServerUser(sourceSuC.id, admin.id);
    const [secondRestored] = await db
      .select()
      .from(users)
      .where(eq(users.id, secondSplit.newUserId));
    expect(secondRestored?.username).toBe('multi-source');
    expect(secondSplit.newUserId).not.toBe(firstSplit.newUserId);

    const [auditAfterSecond] = await db
      .select()
      .from(userMergeAudits)
      .where(eq(userMergeAudits.id, mergeResult.auditId));
    expect(auditAfterSecond?.undoneAt).not.toBeNull();

    const [suBRow] = await db.select().from(serverUsers).where(eq(serverUsers.id, sourceSuB.id));
    const [suCRow] = await db.select().from(serverUsers).where(eq(serverUsers.id, sourceSuC.id));
    expect(suBRow?.userId).toBe(firstSplit.newUserId);
    expect(suCRow?.userId).toBe(secondSplit.newUserId);
  });
});

describe('backward compatibility with audits written before movedIdentityRowIds existed', () => {
  it('still splits using the source snapshot when movedIdentityRowIds is null', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member', username: 'legacy-source' });
    await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

    const [sourceMobileToken] = await db
      .insert(mobileTokens)
      .values({
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        createdBy: source.id,
      })
      .returning();

    const mergeResult = await mergeUsers(source.id, target.id, admin.id);

    // Simulate an audit row written before this column existed by nulling it
    // out directly, the same shape older rows have in production.
    await db
      .update(userMergeAudits)
      .set({ movedIdentityRowIds: null })
      .where(eq(userMergeAudits.id, mergeResult.auditId));

    const splitResult = await splitServerUser(sourceSu.id, admin.id);

    const [restored] = await db.select().from(users).where(eq(users.id, splitResult.newUserId));
    expect(restored?.username).toBe('legacy-source');

    // Fallback (pre-existing) behavior preserved: the mobile token merge
    // already moved onto the target stays there, since there is nothing
    // recorded to move it back.
    const [mobileTokenRow] = await db
      .select()
      .from(mobileTokens)
      .where(eq(mobileTokens.id, sourceMobileToken!.id));
    expect(mobileTokenRow?.createdBy).toBe(target.id);

    const [audit] = await db
      .select()
      .from(userMergeAudits)
      .where(eq(userMergeAudits.id, mergeResult.auditId));
    expect(audit?.undoneAt).not.toBeNull();
  });
});

describe('a same-server combine keeps the absorbed external id resolvable', () => {
  it('points the folded external id at the surviving account so playback cannot undo the merge', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });

    const owner = await createTestUser({ role: 'owner', username: 'durzoau' });
    const pollerIdentity = await createTestUser({ role: 'member', username: 'durzoau' });

    const ownerAccount = await createTestServerUser({
      userId: owner.id,
      serverId: server.id,
      externalId: '3328117',
    });
    // What the poller created because a real session reported external id 1.
    const pollerAccount = await createTestServerUser({
      userId: pollerIdentity.id,
      serverId: server.id,
      externalId: '1',
    });

    await mergeUsers(pollerIdentity.id, owner.id, admin.id, { confirmSameServerCombine: true });

    const [absorbed] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, pollerAccount.id));
    expect(absorbed).toBeUndefined();

    const [alias] = await db
      .select()
      .from(serverUserExternalAliases)
      .where(eq(serverUserExternalAliases.externalId, '1'));
    expect(alias?.serverId).toBe(server.id);
    expect(alias?.serverUserId).toBe(ownerAccount.id);

    // The next session still reports 1. Without the alias this misses and the
    // duplicate identity comes straight back.
    const resolved = await getServerUserByExternalId(server.id, '1');
    expect(resolved).toBeNull();

    const [aliasTarget] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, alias!.serverUserId));
    expect(aliasTarget?.userId).toBe(owner.id);
  });

  it('carries the alias forward when the surviving account is itself absorbed', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });

    const first = await createTestUser({ role: 'member', username: 'chain-a' });
    const second = await createTestUser({ role: 'member', username: 'chain-b' });
    const final = await createTestUser({ role: 'owner', username: 'chain-c' });

    await createTestServerUser({ userId: first.id, serverId: server.id, externalId: 'a' });
    await createTestServerUser({ userId: second.id, serverId: server.id, externalId: 'b' });
    const finalAccount = await createTestServerUser({
      userId: final.id,
      serverId: server.id,
      externalId: 'c',
    });

    await mergeUsers(first.id, second.id, admin.id, { confirmSameServerCombine: true });
    await mergeUsers(second.id, final.id, admin.id, { confirmSameServerCombine: true });

    // Both folded ids have to end on the last surviving account, or the first
    // merge's alias dangles at a row the second merge deleted.
    const aliases = await db
      .select()
      .from(serverUserExternalAliases)
      .where(eq(serverUserExternalAliases.serverId, server.id));
    expect(aliases.map((a) => a.externalId).sort()).toEqual(['a', 'b']);
    for (const alias of aliases) {
      expect(alias.serverUserId).toBe(finalAccount.id);
    }
  });
});

describe('sync does not write an absorbed account over the one that survived it', () => {
  it('skips a folded external id instead of recreating it or renaming the survivor', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'jellyfin' });

    const owner = await createTestUser({ role: 'owner', username: 'john' });
    const spare = await createTestUser({ role: 'member', username: 'john-4k' });

    const survivor = await createTestServerUser({
      userId: owner.id,
      serverId: server.id,
      externalId: 'jf-new',
      username: 'john',
    });
    await createTestServerUser({
      userId: spare.id,
      serverId: server.id,
      externalId: 'jf-old',
      username: 'john-4k',
    });

    await mergeUsers(spare.id, owner.id, admin.id, { confirmSameServerCombine: true });

    // Both accounts still exist on the media server, so sync keeps reporting
    // the absorbed one every tick.
    const result = await syncUserFromMediaServer(server.id, {
      id: 'jf-old',
      username: 'john-4k',
      isAdmin: false,
      isDisabled: false,
    });
    expect(result).toBeNull();

    const [after] = await db.select().from(serverUsers).where(eq(serverUsers.id, survivor.id));
    expect(after?.username).toBe('john');

    const accounts = await db.select().from(serverUsers).where(eq(serverUsers.serverId, server.id));
    expect(accounts).toHaveLength(1);
  });
});
