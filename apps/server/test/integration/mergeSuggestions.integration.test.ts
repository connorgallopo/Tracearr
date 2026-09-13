/**
 * Merge suggestion integration tests
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- mergeSuggestions
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { authAccounts } from '../../src/db/schema.js';
import {
  dismissMergeSuggestion,
  getDismissedMergeSuggestions,
  getMergeSuggestions,
  mergeUsers,
  restoreMergeSuggestion,
} from '../../src/services/mergeService.js';
import {
  recomputeIdentityAggregates,
  syncUserFromMediaServer,
} from '../../src/services/userService.js';

describe('getMergeSuggestions', () => {
  it('suggests identities whose server accounts share a normalized email', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const userA = await createTestUser({ role: 'member' });
    const userB = await createTestUser({ role: 'member' });
    const suA = await createTestServerUser({
      userId: userA.id,
      serverId: serverA.id,
      email: 'Bob@Example.com',
    });
    const suB = await createTestServerUser({
      userId: userB.id,
      serverId: serverB.id,
      email: 'bob@example.com',
    });

    const suggestions = await getMergeSuggestions();
    const match = suggestions.find(
      (s) => s.matchType === 'email' && s.matchValue === 'bob@example.com'
    );

    expect(match).toBeDefined();
    const ids = match!.users.map((u) => u.userId).sort();
    expect(ids).toEqual([userA.id, userB.id].sort());
    expect(match!.wouldCombineSameServer).toBe(false);
    expect(match!.requiredTargetUserId).toBeNull();

    const sideA = match!.users.find((u) => u.userId === userA.id);
    const sideB = match!.users.find((u) => u.userId === userB.id);
    expect(sideA).toEqual({
      userId: userA.id,
      username: userA.username,
      name: userA.name,
      email: userA.email,
      role: userA.role,
      loginCapable: false,
      lastActivityAt: null,
      sessionCount: 0,
      serverUsers: [
        {
          id: suA.id,
          serverId: serverA.id,
          serverName: serverA.name,
          username: suA.username,
          email: suA.email,
          removedAt: null,
        },
      ],
    });
    expect(sideB).toEqual({
      userId: userB.id,
      username: userB.username,
      name: userB.name,
      email: userB.email,
      role: userB.role,
      loginCapable: false,
      lastActivityAt: null,
      sessionCount: 0,
      serverUsers: [
        {
          id: suB.id,
          serverId: serverB.id,
          serverName: serverB.name,
          username: suB.username,
          email: suB.email,
          removedAt: null,
        },
      ],
    });
  });

  it('pairs a Plex owner with an Emby account whose username is their email, keeping the owner', async () => {
    const plex = await createTestServer({ type: 'plex' });
    const emby = await createTestServer({ type: 'emby' });
    const owner = await createTestUser({ role: 'owner' });
    await createTestServerUser({
      userId: owner.id,
      serverId: plex.id,
      username: 'Gallapagos',
      email: 'owner-pair@example.com',
    });
    const synced = await syncUserFromMediaServer(emby.id, {
      id: `emby-${randomUUID()}`,
      username: 'Owner-Pair@Example.com',
      isAdmin: true,
    });

    const match = (await getMergeSuggestions()).find(
      (s) => s.matchValue === 'owner-pair@example.com'
    );

    expect(synced?.user.email).toBeNull();
    expect(match?.matchType).toBe('email');
    expect(match?.users.map((u) => u.userId).sort()).toEqual([owner.id, synced!.user.id].sort());
    expect(match?.requiredTargetUserId).toBe(owner.id);
    expect(match?.suggestedTargetUserId).toBe(owner.id);
  });

  it('suggests exact-username matches and forces a login-capable side as target', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const admin = await createTestUser({ role: 'admin' });
    const member = await createTestUser({ role: 'member' });
    await createTestServerUser({
      userId: admin.id,
      serverId: serverA.id,
      username: 'carol',
      email: null,
    });
    await createTestServerUser({
      userId: member.id,
      serverId: serverB.id,
      username: 'carol',
      email: null,
    });

    const suggestions = await getMergeSuggestions();
    const match = suggestions.find((s) => s.matchType === 'username' && s.matchValue === 'carol');

    expect(match).toBeDefined();
    expect(match!.requiredTargetUserId).toBe(admin.id);
    const adminSide = match!.users.find((u) => u.userId === admin.id);
    expect(adminSide?.loginCapable).toBe(true);
  });

  it('excludes pairs where both identities are login capable', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const admin = await createTestUser({ role: 'admin' });
    const owner = await createTestUser({ role: 'owner' });
    await createTestServerUser({
      userId: admin.id,
      serverId: serverA.id,
      username: 'dave',
      email: null,
    });
    await createTestServerUser({
      userId: owner.id,
      serverId: serverB.id,
      username: 'dave',
      email: null,
    });

    const suggestions = await getMergeSuggestions();
    const match = suggestions.find((s) => s.matchValue === 'dave');
    expect(match).toBeUndefined();
  });

  it('flags pairs that would require a same-server combine', async () => {
    const server = await createTestServer({ type: 'plex' });
    const userA = await createTestUser({ role: 'member' });
    const userB = await createTestUser({ role: 'member' });
    await createTestServerUser({
      userId: userA.id,
      serverId: server.id,
      username: 'erin',
      email: null,
    });
    await createTestServerUser({
      userId: userB.id,
      serverId: server.id,
      username: 'erin',
      email: null,
    });

    const suggestions = await getMergeSuggestions();
    const match = suggestions.find((s) => s.matchValue === 'erin');
    expect(match?.wouldCombineSameServer).toBe(true);
  });

  it('stops suggesting a pair after it has been merged', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const userA = await createTestUser({ role: 'member' });
    const userB = await createTestUser({ role: 'member' });
    await createTestServerUser({
      userId: userA.id,
      serverId: serverA.id,
      email: 'frank@example.com',
    });
    await createTestServerUser({
      userId: userB.id,
      serverId: serverB.id,
      email: 'frank@example.com',
    });

    await mergeUsers(userB.id, userA.id, admin.id);

    const suggestions = await getMergeSuggestions();
    const match = suggestions.find((s) => s.matchValue === 'frank@example.com');
    expect(match).toBeUndefined();
  });

  it('treats a bare auth account row as login capable and forces it as the merge target', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    // Both start as 'member' (not login-capable by role), but one has
    // acquired a Better Auth login account through data drift.
    const authedMember = await createTestUser({ role: 'member' });
    const plainMember = await createTestUser({ role: 'member' });
    await createTestServerUser({
      userId: authedMember.id,
      serverId: serverA.id,
      username: 'greg',
      email: null,
    });
    await createTestServerUser({
      userId: plainMember.id,
      serverId: serverB.id,
      username: 'greg',
      email: null,
    });

    await db.insert(authAccounts).values({
      id: randomUUID(),
      accountId: authedMember.id,
      providerId: 'credential',
      userId: authedMember.id,
    });

    const suggestions = await getMergeSuggestions();
    const match = suggestions.find((s) => s.matchValue === 'greg');

    expect(match).toBeDefined();
    expect(match!.requiredTargetUserId).toBe(authedMember.id);
    const authedSide = match!.users.find((u) => u.userId === authedMember.id);
    expect(authedSide?.loginCapable).toBe(true);
  });

  it('includes a soft-removed server account matching a replacement on the same server', async () => {
    const server = await createTestServer({ type: 'plex' });
    const removedIdentity = await createTestUser({ role: 'member' });
    const replacementIdentity = await createTestUser({ role: 'member' });
    await createTestServerUser({
      userId: removedIdentity.id,
      serverId: server.id,
      email: 'harry@example.com',
      removedAt: new Date(),
    });
    await createTestServerUser({
      userId: replacementIdentity.id,
      serverId: server.id,
      email: 'harry@example.com',
    });

    const suggestions = await getMergeSuggestions();
    const match = suggestions.find((s) => s.matchValue === 'harry@example.com');

    expect(match).toBeDefined();
    const ids = match!.users.map((u) => u.userId).sort();
    expect(ids).toEqual([removedIdentity.id, replacementIdentity.id].sort());
    expect(match!.wouldCombineSameServer).toBe(true);

    const removedSide = match!.users.find((u) => u.userId === removedIdentity.id);
    const replacementSide = match!.users.find((u) => u.userId === replacementIdentity.id);
    expect(removedSide?.serverUsers[0]?.removedAt).not.toBeNull();
    expect(replacementSide?.serverUsers[0]?.removedAt).toBeNull();
  });

  it('picks the lexicographically smallest matchValue when a pair shares two usernames', async () => {
    const serverA1 = await createTestServer({ type: 'plex' });
    const serverA2 = await createTestServer({ type: 'jellyfin' });
    const serverB1 = await createTestServer({ type: 'plex' });
    const serverB2 = await createTestServer({ type: 'jellyfin' });
    const userA = await createTestUser({ role: 'member' });
    const userB = await createTestUser({ role: 'member' });

    await createTestServerUser({
      userId: userA.id,
      serverId: serverA1.id,
      username: 'zzz-ida',
      email: null,
    });
    await createTestServerUser({
      userId: userA.id,
      serverId: serverA2.id,
      username: 'aaa-ida',
      email: null,
    });
    await createTestServerUser({
      userId: userB.id,
      serverId: serverB1.id,
      username: 'zzz-ida',
      email: null,
    });
    await createTestServerUser({
      userId: userB.id,
      serverId: serverB2.id,
      username: 'aaa-ida',
      email: null,
    });

    const suggestions = await getMergeSuggestions();
    const matches = suggestions.filter(
      (s) =>
        s.users.some((u) => u.userId === userA.id) && s.users.some((u) => u.userId === userB.id)
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]!.matchType).toBe('username');
    expect(matches[0]!.matchValue).toBe('aaa-ida');
  });

  it('hides a dismissed pair, lists it as dismissed, and brings it back on restore in either order', async () => {
    const owner = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const userA = await createTestUser({ role: 'member' });
    const userB = await createTestUser({ role: 'member' });
    await createTestServerUser({ userId: userA.id, serverId: serverA.id, email: 'jo@example.com' });
    await createTestServerUser({ userId: userB.id, serverId: serverB.id, email: 'jo@example.com' });

    await dismissMergeSuggestion([userB.id, userA.id], owner.id);
    await dismissMergeSuggestion([userA.id, userB.id], owner.id);

    const hidden = await getMergeSuggestions();
    expect(hidden.find((s) => s.matchValue === 'jo@example.com')).toBeUndefined();
    const dismissed = await getDismissedMergeSuggestions();
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0]!.users.map((u) => u.userId).sort()).toEqual([userA.id, userB.id].sort());

    await restoreMergeSuggestion(userA.id, userB.id);

    const restored = await getMergeSuggestions();
    expect(restored.find((s) => s.matchValue === 'jo@example.com')).toBeDefined();
    expect(await getDismissedMergeSuggestions()).toEqual([]);
  });

  it('suggests the live account over a removed one with more activity, and reports activity and sessions', async () => {
    const server = await createTestServer({ type: 'plex' });
    const removedIdentity = await createTestUser({ role: 'member' });
    const liveIdentity = await createTestUser({ role: 'member' });
    const removedSu = await createTestServerUser({
      userId: removedIdentity.id,
      serverId: server.id,
      email: 'kim@example.com',
      removedAt: new Date('2026-08-01T00:00:00Z'),
      lastActivityAt: new Date('2026-07-30T00:00:00Z'),
    });
    await createTestServerUser({
      userId: liveIdentity.id,
      serverId: server.id,
      email: 'kim@example.com',
    });
    await createTestSession({ serverId: server.id, serverUserId: removedSu.id });
    await createTestSession({ serverId: server.id, serverUserId: removedSu.id });
    await recomputeIdentityAggregates(removedIdentity.id);

    const suggestions = await getMergeSuggestions();
    const match = suggestions.find((s) => s.matchValue === 'kim@example.com');

    expect(match?.suggestedTargetUserId).toBe(liveIdentity.id);
    const removedSide = match!.users.find((u) => u.userId === removedIdentity.id);
    const liveSide = match!.users.find((u) => u.userId === liveIdentity.id);
    expect(removedSide).toMatchObject({
      lastActivityAt: '2026-07-30T00:00:00.000Z',
      sessionCount: 2,
    });
    expect(liveSide).toMatchObject({ lastActivityAt: null, sessionCount: 0 });
  });
});
