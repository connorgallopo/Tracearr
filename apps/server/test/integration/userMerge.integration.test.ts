/**
 * User merge integration tests
 *
 * Exercises mergeUsers against a real database: cross-server repoint,
 * same-server combine, direction rule, aggregate recompute, audit row,
 * and the Better Auth session obligations (revoke on absorb, refresh on
 * target after commit).
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- userMerge
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
  createConcurrentStreamsAutomation,
  createGeoRestrictionAutomation,
  createTestRun,
} from '@tracearr/test-utils/factories';
// The routes here are the ones that move trust; the announce is spied, never sent.
const { mockDispatchTrustMoves, mockDispatchTrustChanged } = vi.hoisted(() => ({
  mockDispatchTrustMoves: vi.fn().mockResolvedValue(undefined),
  mockDispatchTrustChanged: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/automations/events/producers.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dispatchTrustMoves: mockDispatchTrustMoves,
  dispatchTrustChanged: mockDispatchTrustChanged,
}));

import { db } from '../../src/db/client.js';
import { fullRoutes } from '../../src/routes/users/full.js';
import { listRoutes } from '../../src/routes/users/list.js';
import { sessionsRoutes } from '../../src/routes/users/sessions.js';
import { terminationsRoutes } from '../../src/routes/users/terminations.js';
import { violationRoutes } from '../../src/routes/violations.js';
import { recomputeIdentityAggregates } from '../../src/services/userService.js';
import {
  users,
  serverUsers,
  sessions,
  automations,
  authAccounts,
  authSessions,
  userMergeAudits,
  terminationLogs,
} from '../../src/db/schema.js';
import {
  mergeUsers,
  splitServerUser,
  MergeDirectionError,
  MergeValidationError,
  SameServerCombineNotConfirmedError,
} from '../../src/services/mergeService.js';

/** The list envelope reports total and pageSize; the page count derives from them. */
function pageCount(body: { meta: { pageSize: number; total: number } }): number {
  return Math.ceil(body.meta.total / body.meta.pageSize);
}

describe('mergeUsers', () => {
  it('merges a cross-server duplicate: repoints server users, carries history, recomputes aggregates, deletes source, writes audit', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    const target = await createTestUser({ role: 'member', email: 'bob@example.com' });
    const source = await createTestUser({ role: 'member', email: null });

    await createTestServerUser({
      userId: target.id,
      serverId: serverA.id,
      trustScore: 90,
    });
    const sourceSu = await createTestServerUser({
      userId: source.id,
      serverId: serverB.id,
      trustScore: 50,
    });

    const sourceSession = await createTestSession({
      serverId: serverB.id,
      serverUserId: sourceSu.id,
      durationMs: 60_000,
    });
    const rule = await createConcurrentStreamsAutomation(2);
    await createTestRun({
      automationId: rule.id,
      serverUserId: sourceSu.id,
      sessionId: sourceSession.id,
    });

    const result = await mergeUsers(source.id, target.id, admin.id);

    expect(result.targetUserId).toBe(target.id);
    expect(result.movedServerUserIds).toEqual([sourceSu.id]);
    expect(result.wasSameServerCombine).toBe(false);

    // Source server user now belongs to the target identity
    const [movedSu] = await db.select().from(serverUsers).where(eq(serverUsers.id, sourceSu.id));
    expect(movedSu?.userId).toBe(target.id);

    // Sessions and violations still hang off the moved server user (history carried)
    const [carriedSession] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sourceSession.id));
    expect(carriedSession?.serverUserId).toBe(sourceSu.id);

    // Source identity is gone, target identity fields untouched
    const sourceRows = await db.select().from(users).where(eq(users.id, source.id));
    expect(sourceRows).toHaveLength(0);
    const [survivor] = await db.select().from(users).where(eq(users.id, target.id));
    expect(survivor?.email).toBe('bob@example.com');
    expect(survivor?.role).toBe('member');

    // Worst-account rollup: min(90, 50) = 50, one violation total
    expect(survivor?.aggregateTrustScore).toBe(50);
    expect(survivor?.totalViolations).toBe(1);

    // Audit row enables split later
    const [audit] = await db
      .select()
      .from(userMergeAudits)
      .where(eq(userMergeAudits.id, result.auditId));
    expect(audit?.sourceUserId).toBe(source.id);
    expect(audit?.targetUserId).toBe(target.id);
    expect(audit?.actingUserId).toBe(admin.id);
    expect(audit?.movedServerUserIds).toEqual([sourceSu.id]);
    expect(audit?.wasSameServerCombine).toBe(false);
    expect(audit?.sourceUserSnapshot.username).toBe(source.username);
  });

  it('rejects a same-server merge without explicit confirmation', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    await createTestServerUser({ userId: target.id, serverId: server.id });
    await createTestServerUser({ userId: source.id, serverId: server.id });

    // A pre-existing Better Auth session for the source; a rejected merge
    // must leave it untouched since the confirmation guard runs first.
    const sourceAuthSessionId = randomUUID();
    await db.insert(authSessions).values({
      id: sourceAuthSessionId,
      expiresAt: new Date(Date.now() + 60_000),
      token: randomUUID(),
      userId: source.id,
    });

    await expect(mergeUsers(source.id, target.id, admin.id)).rejects.toBeInstanceOf(
      SameServerCombineNotConfirmedError
    );

    // Nothing changed
    const sourceRows = await db.select().from(users).where(eq(users.id, source.id));
    expect(sourceRows).toHaveLength(1);
    const [survivingSession] = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, sourceAuthSessionId));
    expect(survivingSession).toBeDefined();
  });

  it('combines same-server accounts when confirmed: history repointed, primary metadata wins, source row deleted, counts recomputed', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });

    const targetSu = await createTestServerUser({
      userId: target.id,
      serverId: server.id,
      email: 'primary@example.com',
      trustScore: 95,
    });
    const sourceSu = await createTestServerUser({
      userId: source.id,
      serverId: server.id,
      email: 'dupe@example.com',
      trustScore: 40,
    });

    await createTestSession({ serverId: server.id, serverUserId: targetSu.id });
    await createTestSession({ serverId: server.id, serverUserId: sourceSu.id });
    await createTestSession({ serverId: server.id, serverUserId: sourceSu.id });

    // Conflicting per-user automation override: primary wins, source copy dropped
    await createConcurrentStreamsAutomation(2, { name: 'Max streams', serverUserId: targetSu.id });
    await createConcurrentStreamsAutomation(5, { name: 'Max streams', serverUserId: sourceSu.id });
    // Source-only override: moves to the target server user
    const geoRule = await createGeoRestrictionAutomation(['XX'], {
      name: 'Geo lock',
      serverUserId: sourceSu.id,
    });

    const result = await mergeUsers(source.id, target.id, admin.id, {
      confirmSameServerCombine: true,
    });

    expect(result.wasSameServerCombine).toBe(true);
    expect(result.combinedServerUsers).toEqual([
      { sourceServerUserId: sourceSu.id, targetServerUserId: targetSu.id, serverId: server.id },
    ]);

    // Source server user is gone, its sessions live on the target server user
    const sourceSuRows = await db.select().from(serverUsers).where(eq(serverUsers.id, sourceSu.id));
    expect(sourceSuRows).toHaveLength(0);
    const combinedSessions = await db
      .select()
      .from(sessions)
      .where(eq(sessions.serverUserId, targetSu.id));
    expect(combinedSessions).toHaveLength(3);

    // Primary metadata and trust kept
    const [combinedSu] = await db.select().from(serverUsers).where(eq(serverUsers.id, targetSu.id));
    expect(combinedSu?.email).toBe('primary@example.com');
    expect(combinedSu?.trustScore).toBe(95);

    // Automation overrides: conflicting name dropped, unique one repointed
    const targetRules = await db
      .select()
      .from(automations)
      .where(eq(automations.serverUserId, targetSu.id));
    const names = targetRules.map((r) => r.name).sort();
    expect(names).toEqual(['Geo lock', 'Max streams']);
    const [movedGeoRule] = await db
      .select()
      .from(automations)
      .where(eq(automations.id, geoRule.id));
    expect(movedGeoRule?.serverUserId).toBe(targetSu.id);
    const maxStreamRules = targetRules.filter((r) => r.name === 'Max streams');
    expect(maxStreamRules).toHaveLength(1);
    // The target's threshold survived, not the source's 5.
    expect(maxStreamRules[0]?.conditions?.groups[0]?.conditions[0]?.value).toBe(2);
  });

  it('never carries removedAt from the source onto the surviving row on a same-server combine', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });

    // A member re-created a lost account on the same server; the old
    // server_user was soft-removed but the new one is active.
    const targetSu = await createTestServerUser({
      userId: target.id,
      serverId: server.id,
      trustScore: 80,
    });
    const sourceSu = await createTestServerUser({
      userId: source.id,
      serverId: server.id,
      trustScore: 60,
      removedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const sourceSession = await createTestSession({
      serverId: server.id,
      serverUserId: sourceSu.id,
    });

    const result = await mergeUsers(source.id, target.id, admin.id, {
      confirmSameServerCombine: true,
    });

    expect(result.wasSameServerCombine).toBe(true);

    const [survivingSu] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, targetSu.id));
    expect(survivingSu?.removedAt).toBeNull();

    // History from the removed source is still folded in
    const [carriedSession] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sourceSession.id));
    expect(carriedSession?.serverUserId).toBe(targetSu.id);
  });

  it('refuses to absorb a login-capable identity', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const loginCapableSource = await createTestUser({ role: 'admin' });
    await createTestServerUser({ userId: target.id, serverId: serverA.id });
    await createTestServerUser({ userId: loginCapableSource.id, serverId: serverB.id });

    await expect(mergeUsers(loginCapableSource.id, target.id, admin.id)).rejects.toBeInstanceOf(
      MergeDirectionError
    );
  });

  it('rejects absorbing a source that owns a Better Auth login account, and changes nothing', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    // role stays 'member' (not login-capable by role) but the identity has
    // acquired a login account through data drift; the in-transaction
    // authAccounts count must still reject it.
    const source = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

    await db.insert(authAccounts).values({
      id: randomUUID(),
      accountId: source.id,
      providerId: 'credential',
      userId: source.id,
    });

    await expect(mergeUsers(source.id, target.id, admin.id)).rejects.toBeInstanceOf(
      MergeDirectionError
    );

    // Nothing changed: both server users still belong to their original identities
    const [unmovedTargetSu] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, targetSu.id));
    expect(unmovedTargetSu?.userId).toBe(target.id);
    const [unmovedSourceSu] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, sourceSu.id));
    expect(unmovedSourceSu?.userId).toBe(source.id);
    const sourceRows = await db.select().from(users).where(eq(users.id, source.id));
    expect(sourceRows).toHaveLength(1);
    const [authAccountRow] = await db
      .select()
      .from(authAccounts)
      .where(eq(authAccounts.userId, source.id));
    expect(authAccountRow).toBeDefined();
  });

  it('rejects merging an identity into itself', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const user = await createTestUser({ role: 'member' });
    await expect(mergeUsers(user.id, user.id, admin.id)).rejects.toThrow(
      'cannot merge an identity into itself'
    );
  });
});

describe('splitServerUser', () => {
  it('detaches a merged server user back into a fresh identity using the audit snapshot', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({
      role: 'member',
      username: 'dupe-bob',
      email: 'dupe-bob@example.com',
    });
    await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });
    const sourceSession = await createTestSession({
      serverId: serverB.id,
      serverUserId: sourceSu.id,
    });

    const mergeResult = await mergeUsers(source.id, target.id, admin.id);

    const splitResult = await splitServerUser(sourceSu.id, admin.id);

    // Fresh identity restored from the audit snapshot, role never raised
    const [restored] = await db.select().from(users).where(eq(users.id, splitResult.newUserId));
    expect(restored?.username).toBe('dupe-bob');
    expect(restored?.email).toBe('dupe-bob@example.com');
    expect(restored?.role).toBe('member');

    // Server user and its history follow the new identity
    const [detachedSu] = await db.select().from(serverUsers).where(eq(serverUsers.id, sourceSu.id));
    expect(detachedSu?.userId).toBe(splitResult.newUserId);
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sourceSession.id));
    expect(session?.serverUserId).toBe(sourceSu.id);

    // Audit marked as undone
    const [audit] = await db
      .select()
      .from(userMergeAudits)
      .where(eq(userMergeAudits.id, mergeResult.auditId));
    expect(audit?.undoneAt).not.toBeNull();
  });

  it('falls back to server user fields when no audit record covers the server user', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const identity = await createTestUser({ role: 'member' });
    await createTestServerUser({ userId: identity.id, serverId: serverA.id });
    const su = await createTestServerUser({
      userId: identity.id,
      serverId: serverB.id,
      username: 'never-merged',
      email: 'never-merged@example.com',
    });

    const result = await splitServerUser(su.id, admin.id);

    const [restored] = await db.select().from(users).where(eq(users.id, result.newUserId));
    expect(restored?.username).toBe('never-merged');
    expect(restored?.email).toBe('never-merged@example.com');
    expect(restored?.role).toBe('member');
  });

  it('refuses to split the only server account of an identity', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const identity = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: identity.id, serverId: server.id });

    await expect(splitServerUser(su.id, admin.id)).rejects.toBeInstanceOf(MergeValidationError);
  });

  it('drops the email on the new identity when it is already taken', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const identity = await createTestUser({ role: 'member', email: 'shared@example.com' });
    await createTestServerUser({ userId: identity.id, serverId: serverA.id });
    const su = await createTestServerUser({
      userId: identity.id,
      serverId: serverB.id,
      email: 'shared@example.com',
    });

    const result = await splitServerUser(su.id, admin.id);

    const [restored] = await db.select().from(users).where(eq(users.id, result.newUserId));
    expect(restored?.email).toBeNull();
  });
});

describe('GET /users/:id/full identity aggregation', () => {
  it('returns the identity server user set and combined stats after a merge', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });
    await createTestSession({
      serverId: serverA.id,
      serverUserId: targetSu.id,
      durationMs: 1000,
      stoppedAt: new Date(),
      state: 'stopped',
    });
    await createTestSession({
      serverId: serverB.id,
      serverUserId: sourceSu.id,
      durationMs: 2000,
      stoppedAt: new Date(),
      state: 'stopped',
    });

    await mergeUsers(source.id, target.id, admin.id);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(fullRoutes, { prefix: '/users' });

    const response = await app.inject({ method: 'GET', url: `/users/${targetSu.id}/full` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.identity.userId).toBe(target.id);
    const identitySuIds = body.identity.serverUsers.map((su: { id: string }) => su.id).sort();
    expect(identitySuIds).toEqual([sourceSu.id, targetSu.id].sort());
    expect(body.identity.stats.totalSessions).toBe(2);
    expect(body.identity.stats.totalWatchTime).toBe(3000);
    // Both accounts default to trustScore 100, so the worst-account rollup
    // stays at the default, and no violations were recorded for either side
    // of the merge.
    expect(body.identity.aggregateTrustScore).toBe(100);
    expect(body.identity.totalViolations).toBe(0);

    // Requesting through the other sibling's id returns the same identity block.
    const responseFromSource = await app.inject({
      method: 'GET',
      url: `/users/${sourceSu.id}/full`,
    });
    expect(responseFromSource.statusCode).toBe(200);
    const bodyFromSource = responseFromSource.json();
    expect(bodyFromSource.identity.userId).toBe(target.id);
    const identitySuIdsFromSource = bodyFromSource.identity.serverUsers
      .map((su: { id: string }) => su.id)
      .sort();
    expect(identitySuIdsFromSource).toEqual([sourceSu.id, targetSu.id].sort());
    expect(bodyFromSource.identity.stats.totalSessions).toBe(2);
    expect(bodyFromSource.identity.stats.totalWatchTime).toBe(3000);

    await app.close();
  });

  it('scopes the identity block to servers the caller can access', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });
    await createTestSession({
      serverId: serverA.id,
      serverUserId: targetSu.id,
      durationMs: 1000,
      stoppedAt: new Date(),
      state: 'stopped',
    });
    await createTestSession({
      serverId: serverB.id,
      serverUserId: sourceSu.id,
      durationMs: 2000,
      stoppedAt: new Date(),
      state: 'stopped',
    });

    await mergeUsers(source.id, target.id, admin.id);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    // Viewer scoped only to serverA (where targetSu lives), not serverB
    // (where the merged-in sourceSu lives).
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        userId: randomUUID(),
        username: 'viewer',
        role: 'viewer',
        serverIds: [serverA.id],
      };
    });
    await app.register(fullRoutes, { prefix: '/users' });

    const response = await app.inject({ method: 'GET', url: `/users/${targetSu.id}/full` });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const identitySuIds = body.identity.serverUsers.map((su: { id: string }) => su.id);
    expect(identitySuIds).toEqual([targetSu.id]);
    expect(body.identity.stats.totalSessions).toBe(1);
    expect(body.identity.stats.totalWatchTime).toBe(1000);
  });
});

describe('GET /users/:id/full?scope=identity panels', () => {
  async function setupMergedIdentity() {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

    const sessionA = await createTestSession({
      serverId: serverA.id,
      serverUserId: targetSu.id,
      durationMs: 1000,
      stoppedAt: new Date(),
      state: 'stopped',
    });
    const sessionB = await createTestSession({
      serverId: serverB.id,
      serverUserId: sourceSu.id,
      durationMs: 2000,
      stoppedAt: new Date(),
      state: 'stopped',
    });

    const rule = await createConcurrentStreamsAutomation(2);
    await createTestRun({
      automationId: rule.id,
      serverUserId: targetSu.id,
      sessionId: sessionA.id,
    });
    await createTestRun({
      automationId: rule.id,
      serverUserId: sourceSu.id,
      sessionId: sessionB.id,
    });

    await db.insert(terminationLogs).values([
      {
        sessionId: sessionA.id,
        serverId: serverA.id,
        serverUserId: targetSu.id,
        trigger: 'manual',
        triggeredByUserId: admin.id,
        success: true,
      },
      {
        sessionId: sessionB.id,
        serverId: serverB.id,
        serverUserId: sourceSu.id,
        trigger: 'manual',
        triggeredByUserId: admin.id,
        success: true,
      },
    ]);

    await mergeUsers(source.id, target.id, admin.id);

    return { admin, serverA, serverB, target, source, targetSu, sourceSu };
  }

  it('combines sessions/violations/terminations across accounts vs the single-account default', async () => {
    const { targetSu } = await setupMergedIdentity();

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(fullRoutes, { prefix: '/users' });

    const defaultResponse = await app.inject({
      method: 'GET',
      url: `/users/${targetSu.id}/full`,
    });
    const identityResponse = await app.inject({
      method: 'GET',
      url: `/users/${targetSu.id}/full?scope=identity`,
    });
    await app.close();

    expect(defaultResponse.statusCode).toBe(200);
    expect(identityResponse.statusCode).toBe(200);
    const defaultBody = defaultResponse.json();
    const identityBody = identityResponse.json();

    // Default (no scope) stays anchored on just the requested account.
    expect(defaultBody.sessions.total).toBe(1);
    expect(defaultBody.violations.total).toBe(1);
    expect(defaultBody.terminations.total).toBe(1);

    // scope=identity fans out across every accessible sibling account.
    expect(identityBody.sessions.total).toBe(2);
    expect(identityBody.violations.total).toBe(2);
    expect(identityBody.terminations.total).toBe(2);
    expect(identityBody.user.stats.totalSessions).toBe(2);
    expect(identityBody.user.stats.totalWatchTime).toBe(3000);
  });

  it('scopes scope=identity panels to servers the caller can access', async () => {
    const { serverA, targetSu } = await setupMergedIdentity();

    const app = Fastify({ logger: false });
    await app.register(sensible);
    // Viewer scoped only to serverA (where targetSu lives), not serverB.
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        userId: randomUUID(),
        username: 'viewer',
        role: 'viewer',
        serverIds: [serverA.id],
      };
    });
    await app.register(fullRoutes, { prefix: '/users' });

    const response = await app.inject({
      method: 'GET',
      url: `/users/${targetSu.id}/full?scope=identity`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.sessions.total).toBe(1);
    expect(body.violations.total).toBe(1);
    expect(body.terminations.total).toBe(1);
  });

  it('returns identical output with and without scope=identity for an unmerged user', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const solo = await createTestUser({ role: 'member' });
    const soloSu = await createTestServerUser({ userId: solo.id, serverId: server.id });
    await createTestSession({
      serverId: server.id,
      serverUserId: soloSu.id,
      durationMs: 1500,
      stoppedAt: new Date(),
      state: 'stopped',
    });

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(fullRoutes, { prefix: '/users' });

    const defaultResponse = await app.inject({ method: 'GET', url: `/users/${soloSu.id}/full` });
    const identityResponse = await app.inject({
      method: 'GET',
      url: `/users/${soloSu.id}/full?scope=identity`,
    });
    await app.close();

    expect(defaultResponse.statusCode).toBe(200);
    expect(identityResponse.statusCode).toBe(200);
    const defaultBody = defaultResponse.json();
    const identityBody = identityResponse.json();

    expect(identityBody.sessions.total).toBe(defaultBody.sessions.total);
    expect(identityBody.violations.total).toBe(defaultBody.violations.total);
    expect(identityBody.terminations.total).toBe(defaultBody.terminations.total);
    expect(identityBody.user.stats).toEqual(defaultBody.user.stats);
  });

  it('scope=identity fans out /sessions and /terminations sub-endpoints the same way', async () => {
    const { targetSu } = await setupMergedIdentity();

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(sessionsRoutes, { prefix: '/users' });
    await app.register(terminationsRoutes, { prefix: '/users' });

    const defaultSessions = await app.inject({
      method: 'GET',
      url: `/users/${targetSu.id}/sessions`,
    });
    const identitySessions = await app.inject({
      method: 'GET',
      url: `/users/${targetSu.id}/sessions?scope=identity`,
    });
    const defaultTerminations = await app.inject({
      method: 'GET',
      url: `/users/${targetSu.id}/terminations`,
    });
    const identityTerminations = await app.inject({
      method: 'GET',
      url: `/users/${targetSu.id}/terminations?scope=identity`,
    });
    await app.close();

    expect(defaultSessions.json().total).toBe(1);
    expect(identitySessions.json().total).toBe(2);
    expect(defaultTerminations.json().total).toBe(1);
    expect(identityTerminations.json().total).toBe(2);
  });
});

describe('GET /violations userId identity filter', () => {
  it('returns violations from every accessible account under the identity', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    const admin = await createTestUser({ role: 'owner' });
    const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

    const sessionA = await createTestSession({ serverId: serverA.id, serverUserId: targetSu.id });
    const sessionB = await createTestSession({ serverId: serverB.id, serverUserId: sourceSu.id });
    const rule = await createConcurrentStreamsAutomation(2);
    await createTestRun({
      automationId: rule.id,
      serverUserId: targetSu.id,
      sessionId: sessionA.id,
    });
    await createTestRun({
      automationId: rule.id,
      serverUserId: sourceSu.id,
      sessionId: sessionB.id,
    });

    await mergeUsers(source.id, target.id, admin.id);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(violationRoutes, { prefix: '/violations' });

    const response = await app.inject({
      method: 'GET',
      url: `/violations?userId=${target.id}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta.total).toBe(2);
    const returnedServerUserIds = body.data
      .map((v: { serverUserId: string }) => v.serverUserId)
      .sort();
    expect(returnedServerUserIds).toEqual([sourceSu.id, targetSu.id].sort());
  });

  it('scopes the userId filter to servers the caller can access', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    const admin = await createTestUser({ role: 'owner' });
    const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

    const sessionA = await createTestSession({ serverId: serverA.id, serverUserId: targetSu.id });
    const sessionB = await createTestSession({ serverId: serverB.id, serverUserId: sourceSu.id });
    const rule = await createConcurrentStreamsAutomation(2);
    await createTestRun({
      automationId: rule.id,
      serverUserId: targetSu.id,
      sessionId: sessionA.id,
    });
    await createTestRun({
      automationId: rule.id,
      serverUserId: sourceSu.id,
      sessionId: sessionB.id,
    });

    await mergeUsers(source.id, target.id, admin.id);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    // Viewer scoped only to serverA - can't see the merged-in sourceSu's server.
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        userId: randomUUID(),
        username: 'viewer',
        role: 'viewer',
        serverIds: [serverA.id],
      };
    });
    await app.register(violationRoutes, { prefix: '/violations' });

    const response = await app.inject({
      method: 'GET',
      url: `/violations?userId=${target.id}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta.total).toBe(1);
    expect(body.data[0].serverUserId).toBe(targetSu.id);
  });
});

describe('GET /users identityServers', () => {
  it('shows a single row for a merged identity, using the deterministic representative account', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    // Both accounts are active and neither matches the identity's plex_account_id,
    // so more recent activity is the deterministic tiebreaker that makes
    // targetSu the representative row.
    const targetSu = await createTestServerUser({
      userId: target.id,
      serverId: serverA.id,
      lastActivityAt: new Date('2026-06-02T00:00:00Z'),
    });
    const sourceSu = await createTestServerUser({
      userId: source.id,
      serverId: serverB.id,
      lastActivityAt: new Date('2026-06-01T00:00:00Z'),
    });
    const unrelatedIdentity = await createTestUser({ role: 'member' });
    const unrelatedSu = await createTestServerUser({
      userId: unrelatedIdentity.id,
      serverId: serverA.id,
    });

    await mergeUsers(source.id, target.id, admin.id);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const response = await app.inject({ method: 'GET', url: '/users?pageSize=100' });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const rows = body.data as { id: string; identityServers: { id: string; name: string }[] }[];

    // Exactly one row represents the merged identity, and it is the
    // higher-session-count account, not the sibling.
    const mergedRows = rows.filter((r) => r.id === targetSu.id || r.id === sourceSu.id);
    expect(mergedRows).toHaveLength(1);
    expect(mergedRows[0]?.id).toBe(targetSu.id);

    // The single row still reports both servers (batched lookup, not per-row).
    const mergedServerIds = mergedRows[0]?.identityServers.map((s) => s.id).sort();
    expect(mergedServerIds).toEqual([serverA.id, serverB.id].sort());

    // An unrelated, unmerged identity still shows its own single row with its one server.
    const unrelatedRow = rows.find((r) => r.id === unrelatedSu.id);
    expect(unrelatedRow?.identityServers.map((s) => s.id)).toEqual([serverA.id]);
  });

  it('scopes a merged identity sibling on an inaccessible server out of identityServers', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
    await createTestServerUser({ userId: source.id, serverId: serverB.id });

    await mergeUsers(source.id, target.id, admin.id);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    // Viewer scoped only to serverA - serverB (the merged-in sibling) is
    // outside their access, so it must not leak into identityServers.
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        userId: randomUUID(),
        username: 'viewer',
        role: 'viewer',
        serverIds: [serverA.id],
      };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const response = await app.inject({ method: 'GET', url: '/users?pageSize=100' });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const rows = body.data as { id: string; identityServers: { id: string; name: string }[] }[];
    // The viewer can't see serverB at all, so the merged identity shows up as
    // exactly one row scoped to serverA.
    expect(rows).toHaveLength(1);
    expect(body.meta.total).toBe(1);
    const row = rows.find((r) => r.id === targetSu.id);
    expect(row?.identityServers.map((s) => s.id)).toEqual([serverA.id]);
  });
});

describe('GET /users dedup + includeRemoved + access scoping', () => {
  it('keeps a merged identity visible by default when its representative account is active but a sibling account is removed', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSu = await createTestServerUser({
      userId: source.id,
      serverId: serverB.id,
      removedAt: new Date('2026-01-01T00:00:00Z'),
    });

    await mergeUsers(source.id, target.id, admin.id);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const response = await app.inject({ method: 'GET', url: '/users?pageSize=100' });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const rows = body.data as { id: string }[];

    // The identity stays visible, represented by its still-active account,
    // even though its merged-in sibling is removed.
    const mergedRows = rows.filter((r) => r.id === targetSu.id || r.id === sourceSu.id);
    expect(mergedRows).toHaveLength(1);
    expect(mergedRows[0]?.id).toBe(targetSu.id);
    expect(body.meta.total).toBeGreaterThanOrEqual(1);
  });

  it('hides a merged identity by default when every account is removed, and shows it with includeRemoved=true', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({
      userId: target.id,
      serverId: serverA.id,
      removedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const sourceSu = await createTestServerUser({
      userId: source.id,
      serverId: serverB.id,
      removedAt: new Date('2026-01-01T00:00:00Z'),
    });

    await mergeUsers(source.id, target.id, admin.id);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const defaultResponse = await app.inject({ method: 'GET', url: '/users?pageSize=100' });
    const defaultBody = defaultResponse.json();
    const defaultRows = defaultBody.data as { id: string }[];
    expect(defaultResponse.statusCode).toBe(200);
    expect(defaultRows.some((r) => r.id === targetSu.id || r.id === sourceSu.id)).toBe(false);

    const includeRemovedResponse = await app.inject({
      method: 'GET',
      url: '/users?pageSize=100&includeRemoved=true',
    });
    await app.close();

    expect(includeRemovedResponse.statusCode).toBe(200);
    const includeRemovedBody = includeRemovedResponse.json();
    const includeRemovedRows = includeRemovedBody.data as { id: string }[];
    const mergedRows = includeRemovedRows.filter(
      (r) => r.id === targetSu.id || r.id === sourceSu.id
    );
    expect(mergedRows).toHaveLength(1);
  });

  it('never builds the representative from an account on a server the caller cannot access', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    // sourceSu is more recently active, so without server scoping it would win
    // the representative tiebreak - but the viewer can't see serverB at all.
    const targetSu = await createTestServerUser({
      userId: target.id,
      serverId: serverA.id,
      lastActivityAt: new Date('2026-06-01T00:00:00Z'),
    });
    await createTestServerUser({
      userId: source.id,
      serverId: serverB.id,
      lastActivityAt: new Date('2026-06-02T00:00:00Z'),
    });

    await mergeUsers(source.id, target.id, admin.id);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        userId: randomUUID(),
        username: 'viewer',
        role: 'viewer',
        serverIds: [serverA.id],
      };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const response = await app.inject({ method: 'GET', url: '/users?pageSize=100' });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const rows = body.data as {
      id: string;
      serverId: string;
      identityServers: { id: string }[];
    }[];

    expect(rows).toHaveLength(1);
    expect(body.meta.total).toBe(1);
    expect(rows[0]?.id).toBe(targetSu.id);
    expect(rows[0]?.serverId).toBe(serverA.id);
    expect(rows[0]?.identityServers.map((s) => s.id)).toEqual([serverA.id]);
  });
});

describe('GET /users serverIds (multi-select)', () => {
  it('selecting a subset of servers returns only people on those servers', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const serverC = await createTestServer({ type: 'emby' });
    const identityA = await createTestUser({ role: 'member' });
    const identityB = await createTestUser({ role: 'member' });
    const identityC = await createTestUser({ role: 'member' });
    const suA = await createTestServerUser({ userId: identityA.id, serverId: serverA.id });
    const suB = await createTestServerUser({ userId: identityB.id, serverId: serverB.id });
    const suC = await createTestServerUser({ userId: identityC.id, serverId: serverC.id });

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const response = await app.inject({
      method: 'GET',
      url: `/users?pageSize=100&serverIds=${serverA.id}&serverIds=${serverB.id}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const rowIds = (body.data as { id: string }[]).map((r) => r.id);

    expect(rowIds).toEqual(expect.arrayContaining([suA.id, suB.id]));
    expect(rowIds).not.toContain(suC.id);
  });

  it('shows a merged person on a selected server via their selected-server account, even with an account on a non-selected server', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    // sourceSu is more recently active, so without server scoping it would win
    // the representative tiebreak - but only serverA is selected, so the
    // selected account must represent the merged identity instead.
    const targetSu = await createTestServerUser({
      userId: target.id,
      serverId: serverA.id,
      lastActivityAt: new Date('2026-06-01T00:00:00Z'),
    });
    const sourceSu = await createTestServerUser({
      userId: source.id,
      serverId: serverB.id,
      lastActivityAt: new Date('2026-06-02T00:00:00Z'),
    });

    await mergeUsers(source.id, target.id, admin.id);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const response = await app.inject({
      method: 'GET',
      url: `/users?pageSize=100&serverIds=${serverA.id}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const rows = body.data as { id: string; serverId: string }[];
    const mergedRows = rows.filter((r) => r.id === targetSu.id || r.id === sourceSu.id);

    expect(mergedRows).toHaveLength(1);
    expect(mergedRows[0]?.id).toBe(targetSu.id);
    expect(mergedRows[0]?.serverId).toBe(serverA.id);
  });

  it('never widens beyond a non-owner viewer accessible servers when serverIds requests more', async () => {
    await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const identityA = await createTestUser({ role: 'member' });
    const identityB = await createTestUser({ role: 'member' });
    const suA = await createTestServerUser({ userId: identityA.id, serverId: serverA.id });
    const suB = await createTestServerUser({ userId: identityB.id, serverId: serverB.id });

    const app = Fastify({ logger: false });
    await app.register(sensible);
    // Viewer only has access to serverA, but requests both servers.
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        userId: randomUUID(),
        username: 'viewer',
        role: 'viewer',
        serverIds: [serverA.id],
      };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const response = await app.inject({
      method: 'GET',
      url: `/users?pageSize=100&serverIds=${serverA.id}&serverIds=${serverB.id}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const rowIds = (body.data as { id: string }[]).map((r) => r.id);

    expect(rowIds).toContain(suA.id);
    expect(rowIds).not.toContain(suB.id);
  });
});

describe('GET /users search', () => {
  it('matches by account username, case-insensitively', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const identity = await createTestUser({ role: 'member', name: 'Nobody Special' });
    const su = await createTestServerUser({
      userId: identity.id,
      serverId: server.id,
      username: 'ZebraStripes',
    });
    const otherIdentity = await createTestUser({ role: 'member' });
    await createTestServerUser({
      userId: otherIdentity.id,
      serverId: server.id,
      username: 'Aardvark',
    });

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const response = await app.inject({ method: 'GET', url: '/users?search=zebra' });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const rows = body.data as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual([su.id]);
    expect(body.meta.total).toBe(1);
    expect(pageCount(body)).toBe(1);
  });

  it('matches by identity display name, not just account username', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const identity = await createTestUser({ role: 'member', name: 'Constance Featherweight' });
    const su = await createTestServerUser({
      userId: identity.id,
      serverId: server.id,
      username: 'unrelated-handle',
    });
    const otherIdentity = await createTestUser({ role: 'member', name: 'Someone Else' });
    await createTestServerUser({
      userId: otherIdentity.id,
      serverId: server.id,
      username: 'other-handle',
    });

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const response = await app.inject({ method: 'GET', url: '/users?search=featherweight' });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const rows = body.data as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual([su.id]);
    expect(body.meta.total).toBe(1);
  });

  it('escapes % and _ so a literal search term is not treated as a wildcard', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const identity = await createTestUser({ role: 'member' });
    // Would match "100%" as a substring wildcard search (100 followed by
    // anything) if the % in the search term weren't escaped to a literal.
    const decoy = await createTestServerUser({
      userId: identity.id,
      serverId: server.id,
      username: 'disc100off',
    });
    const otherIdentity = await createTestUser({ role: 'member' });
    // Contains the literal substring "100%", the only row that should match.
    const literalMatch = await createTestServerUser({
      userId: otherIdentity.id,
      serverId: server.id,
      username: 'clearance100%special',
    });

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const response = await app.inject({
      method: 'GET',
      url: `/users?search=${encodeURIComponent('100%')}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const rowIds = (body.data as { id: string }[]).map((r) => r.id);
    expect(rowIds).toEqual([literalMatch.id]);
    expect(rowIds).not.toContain(decoy.id);
    expect(body.meta.total).toBe(1);
  });

  it('composes search with serverIds, includeRemoved, and the one-row-per-identity dedup', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    // Merged identity: matches the search term, has an active account on
    // serverA and a removed account on serverB.
    const target = await createTestUser({ role: 'member', name: 'Harbor Lighthouse' });
    const source = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({
      userId: target.id,
      serverId: serverA.id,
      username: 'harbor-a',
    });
    const sourceSu = await createTestServerUser({
      userId: source.id,
      serverId: serverB.id,
      username: 'harbor-b',
      removedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await mergeUsers(source.id, target.id, admin.id);

    // Unrelated identity that also matches the search term but lives only on
    // serverB, so a serverIds=serverA filter should exclude it.
    const otherOnB = await createTestUser({ role: 'member', name: 'Harbor Watch' });
    await createTestServerUser({ userId: otherOnB.id, serverId: serverB.id, username: 'watcher' });

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const response = await app.inject({
      method: 'GET',
      url: `/users?search=harbor&serverIds=${serverA.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const rows = body.data as { id: string }[];

    // Only the merged identity's serverA account shows, represented once
    // even though the search also matches its removed serverB sibling.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(targetSu.id);
    expect(body.meta.total).toBe(1);
    expect(pageCount(body)).toBe(1);

    // With includeRemoved and no server filter, both sides of the search
    // still collapse to the identity's single representative row, and the
    // unrelated identity now also counts toward the filtered total.
    const includeRemovedResponse = await app.inject({
      method: 'GET',
      url: '/users?search=harbor&includeRemoved=true',
    });
    await app.close();
    const includeRemovedBody = includeRemovedResponse.json();
    const includeRemovedRows = includeRemovedBody.data as { id: string }[];
    const mergedRows = includeRemovedRows.filter(
      (r) => r.id === targetSu.id || r.id === sourceSu.id
    );
    expect(mergedRows).toHaveLength(1);
    expect(includeRemovedBody.meta.total).toBe(2);
    expect(pageCount(includeRemovedBody)).toBe(1);
  });
});

describe('identity trust rollup stays current outside merge/split', () => {
  it('recomputes the aggregate immediately when a manual trust edit changes one account, and restores it on reversal', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const person = await createTestUser({ role: 'member' });

    const suA = await createTestServerUser({
      userId: person.id,
      serverId: serverA.id,
      trustScore: 90,
    });
    const suB = await createTestServerUser({
      userId: person.id,
      serverId: serverB.id,
      trustScore: 90,
    });

    // No trust-affecting write has touched this identity yet, so the rollup
    // still sits at the untouched default - it is not backfilled from the
    // accounts created directly above.
    const [before] = await db.select().from(users).where(eq(users.id, person.id));
    expect(before?.aggregateTrustScore).toBe(100);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });

    // Lower trust on one account
    const lowerResponse = await app.inject({
      method: 'PATCH',
      url: `/users/${suB.id}`,
      payload: { trustScore: 50 },
    });
    expect(lowerResponse.statusCode).toBe(200);

    // Worst account now: min(90, 50) = 50
    const [afterLower] = await db.select().from(users).where(eq(users.id, person.id));
    expect(afterLower?.aggregateTrustScore).toBe(50);

    // Reverse the edit back to the original score
    const reverseResponse = await app.inject({
      method: 'PATCH',
      url: `/users/${suB.id}`,
      payload: { trustScore: 90 },
    });
    expect(reverseResponse.statusCode).toBe(200);

    const [afterReverse] = await db.select().from(users).where(eq(users.id, person.id));
    expect(afterReverse?.aggregateTrustScore).toBe(90);

    await app.close();

    // Untouched sibling account keeps its own score
    const [suARow] = await db.select().from(serverUsers).where(eq(serverUsers.id, suA.id));
    expect(suARow?.trustScore).toBe(90);
  });

  it('rolls the earliest join and latest activity across accounts onto the identity', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const person = await createTestUser({ role: 'member' });

    const earlyJoin = new Date('2024-03-04T05:06:07.000Z');
    const lateActivity = new Date('2026-06-02T00:00:00.000Z');
    const suA = await createTestServerUser({
      userId: person.id,
      serverId: serverA.id,
      lastActivityAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    const suB = await createTestServerUser({
      userId: person.id,
      serverId: serverB.id,
      lastActivityAt: lateActivity,
    });
    await db.update(serverUsers).set({ joinedAt: earlyJoin }).where(eq(serverUsers.id, suA.id));
    await db
      .update(serverUsers)
      .set({ joinedAt: new Date('2025-09-09T00:00:00.000Z') })
      .where(eq(serverUsers.id, suB.id));

    await recomputeIdentityAggregates(person.id);

    const [row] = await db.select().from(users).where(eq(users.id, person.id));
    expect(row?.firstJoinedAt).toEqual(earlyJoin);
    expect(row?.lastActivityAt).toEqual(lateActivity);
  });

  it('recomputes the aggregate when dismissing a violation reverses a rule trust adjustment on one account', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const person = await createTestUser({ role: 'member' });

    const suA = await createTestServerUser({
      userId: person.id,
      serverId: serverA.id,
      trustScore: 90,
    });
    const suB = await createTestServerUser({
      userId: person.id,
      serverId: serverB.id,
      trustScore: 50,
    });

    // Seed a correct baseline rollup the way a prior trust-affecting write
    // would have left it: min(90, 50) = 50. Creating accounts directly (as
    // above) does not itself trigger a recompute.
    await recomputeIdentityAggregates(person.id);
    const [before] = await db.select().from(users).where(eq(users.id, person.id));
    expect(before?.aggregateTrustScore).toBe(50);

    const rule = await createConcurrentStreamsAutomation(2);
    await db
      .update(automations)
      .set({ actions: { actions: [{ type: 'trust', mode: 'adjust', amount: -20 }] } })
      .where(eq(automations.id, rule.id));

    const session = await createTestSession({ serverId: serverB.id, serverUserId: suB.id });
    const violation = await createTestRun({
      automationId: rule.id,
      serverUserId: suB.id,
      sessionId: session.id,
    });

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(violationRoutes, { prefix: '/violations' });

    const response = await app.inject({ method: 'DELETE', url: `/violations/${violation.id}` });
    await app.close();

    expect(response.statusCode).toBe(200);

    // Dismiss reverses the rule's -20 adjustment: 50 - (-20) = 70
    const [suBRow] = await db.select().from(serverUsers).where(eq(serverUsers.id, suB.id));
    expect(suBRow?.trustScore).toBe(70);

    // Worst account after reversal: min(90, 70) = 70
    const [after] = await db.select().from(users).where(eq(users.id, person.id));
    expect(after?.aggregateTrustScore).toBe(70);

    // Untouched sibling account keeps its own score
    const [suARow] = await db.select().from(serverUsers).where(eq(serverUsers.id, suA.id));
    expect(suARow?.trustScore).toBe(90);
  });
});

describe('POST /users/bulk/reset-trust', () => {
  it('resets every account of a merged person when reset via their representative row, and the identity aggregate returns to 100', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({
      userId: target.id,
      serverId: serverA.id,
      trustScore: 60,
    });
    const sourceSu = await createTestServerUser({
      userId: source.id,
      serverId: serverB.id,
      trustScore: 40,
    });

    await mergeUsers(source.id, target.id, admin.id);

    // Merge already recomputed the rollup: min(60, 40) = 40
    const [beforeReset] = await db.select().from(users).where(eq(users.id, target.id));
    expect(beforeReset?.aggregateTrustScore).toBe(40);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });

    // Only the representative row's id is sent, the same way the roster sends it
    const response = await app.inject({
      method: 'POST',
      url: '/users/bulk/reset-trust',
      payload: { ids: [targetSu.id] },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, updated: 2 });

    const [targetSuRow] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, targetSu.id));
    const [sourceSuRow] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, sourceSu.id));
    expect(targetSuRow?.trustScore).toBe(100);
    expect(sourceSuRow?.trustScore).toBe(100);

    const [afterReset] = await db.select().from(users).where(eq(users.id, target.id));
    expect(afterReset?.aggregateTrustScore).toBe(100);
  });

  it('scopes a reset to accounts the caller can access, and recomputes the aggregate over the whole person', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({
      userId: target.id,
      serverId: serverA.id,
      trustScore: 60,
    });
    const sourceSu = await createTestServerUser({
      userId: source.id,
      serverId: serverB.id,
      trustScore: 40,
    });

    await mergeUsers(source.id, target.id, admin.id);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    // Admin scoped only to serverA - the only account this caller can see or
    // select on the roster is targetSu, so that's the only id sent.
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        userId: randomUUID(),
        username: 'scoped-admin',
        role: 'admin',
        serverIds: [serverA.id],
      };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const response = await app.inject({
      method: 'POST',
      url: '/users/bulk/reset-trust',
      payload: { ids: [targetSu.id] },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, updated: 1 });

    // Only the accessible account was reset
    const [targetSuRow] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, targetSu.id));
    expect(targetSuRow?.trustScore).toBe(100);
    const [sourceSuRow] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, sourceSu.id));
    expect(sourceSuRow?.trustScore).toBe(40);

    // Aggregate still recomputes over the person's full account set, so the
    // untouched account keeps it short of 100: min(100, 40) = 40
    const [afterReset] = await db.select().from(users).where(eq(users.id, target.id));
    expect(afterReset?.aggregateTrustScore).toBe(40);
  });

  it('selectAll with the roster filters resets every matching identity in full, without touching non-matching people', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    // Merged person with one account on the filtered server (serverA) and one
    // account outside it (serverB) - selectAll should still expand to both,
    // since the filter only decides the seed, not the caller's access.
    const targetSu = await createTestServerUser({
      userId: target.id,
      serverId: serverA.id,
      trustScore: 60,
    });
    const sourceSu = await createTestServerUser({
      userId: source.id,
      serverId: serverB.id,
      trustScore: 20,
    });
    await mergeUsers(source.id, target.id, admin.id);

    // Unrelated person, entirely on serverB - outside the selectAll filter,
    // so must be left alone.
    const unrelated = await createTestUser({ role: 'member' });
    const unrelatedSu = await createTestServerUser({
      userId: unrelated.id,
      serverId: serverB.id,
      trustScore: 30,
    });
    await recomputeIdentityAggregates(unrelated.id);
    const [unrelatedBefore] = await db.select().from(users).where(eq(users.id, unrelated.id));
    expect(unrelatedBefore?.aggregateTrustScore).toBe(30);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const response = await app.inject({
      method: 'POST',
      url: '/users/bulk/reset-trust',
      payload: { selectAll: true, filters: { serverIds: [serverA.id] } },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, updated: 2 });

    const [targetSuRow] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, targetSu.id));
    const [sourceSuRow] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, sourceSu.id));
    expect(targetSuRow?.trustScore).toBe(100);
    expect(sourceSuRow?.trustScore).toBe(100);
    const [targetIdentityAfter] = await db.select().from(users).where(eq(users.id, target.id));
    expect(targetIdentityAfter?.aggregateTrustScore).toBe(100);

    // The unrelated person was never in the filtered seed set, so untouched
    const [unrelatedSuRow] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, unrelatedSu.id));
    expect(unrelatedSuRow?.trustScore).toBe(30);
    const [unrelatedAfter] = await db.select().from(users).where(eq(users.id, unrelated.id));
    expect(unrelatedAfter?.aggregateTrustScore).toBe(30);
  });
});

describe('GET /users orderBy', () => {
  it('orders by trustScore across pages, not just within the loaded page', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const high = await createTestUser({ role: 'member', aggregateTrustScore: 90 });
    const mid = await createTestUser({ role: 'member', aggregateTrustScore: 50 });
    const low = await createTestUser({ role: 'member', aggregateTrustScore: 10 });
    const highSu = await createTestServerUser({ userId: high.id, serverId: server.id });
    const midSu = await createTestServerUser({ userId: mid.id, serverId: server.id });
    const lowSu = await createTestServerUser({ userId: low.id, serverId: server.id });

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const page1 = await app.inject({
      method: 'GET',
      url: '/users?pageSize=2&page=1&orderBy=trustScore&orderDir=desc',
    });
    const page2 = await app.inject({
      method: 'GET',
      url: '/users?pageSize=2&page=2&orderBy=trustScore&orderDir=desc',
    });
    await app.close();

    expect(page1.statusCode).toBe(200);
    expect(page2.statusCode).toBe(200);
    // Highest two scores land on page 1, the lowest on page 2 - a sort that
    // only reordered the current page would instead just echo insertion order.
    expect((page1.json().data as { id: string }[]).map((r) => r.id)).toEqual([highSu.id, midSu.id]);
    expect((page2.json().data as { id: string }[]).map((r) => r.id)).toEqual([lowSu.id]);
  });

  it('rejects an invalid orderBy value', async () => {
    const admin = await createTestUser({ role: 'owner' });

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const response = await app.inject({ method: 'GET', url: '/users?orderBy=notAField' });
    await app.close();

    expect(response.statusCode).toBe(400);
  });

  it('defaults to username ascending when no sort params are given, matching prior behavior', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    // The roster sorts on the identity label the row renders, so the display
    // name has to carry the username the ordering is being asserted on.
    const identityA = await createTestUser({ role: 'member', name: 'zebra' });
    const identityB = await createTestUser({ role: 'member', name: 'aardvark' });
    const suZebra = await createTestServerUser({
      userId: identityA.id,
      serverId: server.id,
      username: 'zebra',
    });
    const suAardvark = await createTestServerUser({
      userId: identityB.id,
      serverId: server.id,
      username: 'aardvark',
    });

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const response = await app.inject({ method: 'GET', url: '/users?pageSize=100' });
    await app.close();

    expect(response.statusCode).toBe(200);
    const rows = response.json().data as { id: string }[];
    const relevantIds = rows
      .map((r) => r.id)
      .filter((id) => id === suZebra.id || id === suAardvark.id);
    expect(relevantIds).toEqual([suAardvark.id, suZebra.id]);
  });

  it('sorts lastActivityAt with unset accounts last, regardless of direction', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const active = await createTestUser({ role: 'member' });
    const neverActive = await createTestUser({ role: 'member' });
    const activeSu = await createTestServerUser({ userId: active.id, serverId: server.id });
    const neverActiveSu = await createTestServerUser({
      userId: neverActive.id,
      serverId: server.id,
    });

    await db
      .update(serverUsers)
      .set({ lastActivityAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(serverUsers.id, activeSu.id));
    // The roster sorts on the identity rollup, which a direct account write
    // leaves untouched; without this both rows are null and the id tiebreak
    // decides the order.
    await recomputeIdentityAggregates(active.id);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: admin.id, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });

    const descResponse = await app.inject({
      method: 'GET',
      url: '/users?pageSize=100&orderBy=lastActivityAt&orderDir=desc',
    });
    const ascResponse = await app.inject({
      method: 'GET',
      url: '/users?pageSize=100&orderBy=lastActivityAt&orderDir=asc',
    });
    await app.close();

    const relevantIds = (rows: { id: string }[]) =>
      rows.map((r) => r.id).filter((id) => id === activeSu.id || id === neverActiveSu.id);

    // The account with no recorded activity sorts last either way - never
    // first just because DESC otherwise treats nulls as the "greatest" value.
    expect(relevantIds(descResponse.json().data)).toEqual([activeSu.id, neverActiveSu.id]);
    expect(relevantIds(ascResponse.json().data)).toEqual([activeSu.id, neverActiveSu.id]);
  });
});

describe('every trust move announces itself', () => {
  beforeEach(() => {
    mockDispatchTrustChanged.mockClear();
    mockDispatchTrustMoves.mockClear();
  });

  /** The list routes under an owner who can see every server. */
  async function ownerApp(adminId: string) {
    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = { userId: adminId, username: 'owner', role: 'owner', serverIds: [] };
    });
    await app.register(listRoutes, { prefix: '/users' });
    return app;
  }

  it('announces a PATCH that moves a score, and stays quiet for one that does not', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const person = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({
      userId: person.id,
      serverId: server.id,
      trustScore: 90,
    });
    const app = await ownerApp(admin.id);

    const moved = await app.inject({
      method: 'PATCH',
      url: `/users/${su.id}`,
      payload: { trustScore: 40 },
    });
    expect(moved.statusCode).toBe(200);
    expect(mockDispatchTrustChanged).toHaveBeenCalledTimes(1);
    expect(mockDispatchTrustChanged).toHaveBeenCalledWith({
      serverId: server.id,
      serverUserId: su.id,
      previous: 90,
      next: 40,
      reason: 'changed by an owner',
    });

    mockDispatchTrustChanged.mockClear();
    const untouched = await app.inject({
      method: 'PATCH',
      url: `/users/${su.id}`,
      payload: {},
    });
    expect(untouched.statusCode).toBe(200);
    // Nothing wrote a score, so there is no move to announce.
    expect(mockDispatchTrustChanged).not.toHaveBeenCalled();

    await app.close();
  });

  it('announces one move per account the bulk reset put back to 100', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const person = await createTestUser({ role: 'member' });
    const low = await createTestServerUser({
      userId: person.id,
      serverId: server.id,
      trustScore: 30,
    });
    // One account per person per server, so the untouched sibling lives on a second one.
    const other = await createTestServer({ type: 'jellyfin' });
    const already = await createTestServerUser({
      userId: person.id,
      serverId: other.id,
      trustScore: 100,
    });
    const app = await ownerApp(admin.id);

    const response = await app.inject({
      method: 'POST',
      url: '/users/bulk/reset-trust',
      payload: { ids: [low.id, already.id] },
    });

    expect(response.statusCode).toBe(200);
    expect(mockDispatchTrustMoves).toHaveBeenCalledTimes(1);
    const [moves, reason] = mockDispatchTrustMoves.mock.calls[0] as [
      Array<{ previous: number; serverUser: { id: string; trustScore: number } }>,
      string,
    ];
    expect(reason).toBe('reset by an owner');
    // Both rows come back; the producer's previous === next skip is what drops the no-op.
    expect(moves.map((m) => [m.serverUser.id, m.previous, m.serverUser.trustScore]).sort()).toEqual(
      [
        [already.id, 100, 100],
        [low.id, 30, 100],
      ].sort()
    );

    await app.close();
  });
});
