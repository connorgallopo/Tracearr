/**
 * Violations identity-filter integration tests
 *
 * Exercises the "this person" slice of the Violations page against a real
 * database: the bulk acknowledge/dismiss endpoints' identity (userId) filter,
 * proving select-all under a person filter can never touch another person's
 * violations, and that dismissing a merged person's violations across both
 * of their accounts recomputes the identity trust rollup correctly.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- violationsIdentity
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
  createConcurrentStreamsAutomation,
  createTestRun,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { violationRoutes } from '../../src/routes/violations.js';
import { users, serverUsers, automationRuns, automations } from '../../src/db/schema.js';
import { mergeUsers } from '../../src/services/mergeService.js';
import * as userService from '../../src/services/userService.js';

async function buildApp(authUser: {
  userId: string;
  username: string;
  role: 'owner' | 'admin' | 'viewer' | 'member';
  serverIds: string[];
}) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: any) => {
    request.user = authUser;
  });
  await app.register(violationRoutes, { prefix: '/violations' });
  return app;
}

describe('POST /violations/bulk/acknowledge - person filter', () => {
  it('selectAll scoped to a person filter acknowledges only that person, even when a merged person has accounts on multiple servers', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    // Person A: merged, one account per server, both with violations.
    const personATarget = await createTestUser({ role: 'member' });
    const personASource = await createTestUser({ role: 'member' });
    const personASu1 = await createTestServerUser({
      userId: personATarget.id,
      serverId: serverA.id,
    });
    const personASu2 = await createTestServerUser({
      userId: personASource.id,
      serverId: serverB.id,
    });
    await mergeUsers(personASource.id, personATarget.id, admin.id);

    // Person B: unrelated, on the same servers, also with violations.
    const personB = await createTestUser({ role: 'member' });
    const personBSu = await createTestServerUser({ userId: personB.id, serverId: serverA.id });

    const rule = await createConcurrentStreamsAutomation(2);

    const sessionA1 = await createTestSession({
      serverId: serverA.id,
      serverUserId: personASu1.id,
    });
    const sessionA2 = await createTestSession({
      serverId: serverB.id,
      serverUserId: personASu2.id,
    });
    const sessionB = await createTestSession({ serverId: serverA.id, serverUserId: personBSu.id });

    const violationA1 = await createTestRun({
      automationId: rule.id,
      serverUserId: personASu1.id,
      sessionId: sessionA1.id,
    });
    const violationA2 = await createTestRun({
      automationId: rule.id,
      serverUserId: personASu2.id,
      sessionId: sessionA2.id,
    });
    const violationB = await createTestRun({
      automationId: rule.id,
      serverUserId: personBSu.id,
      sessionId: sessionB.id,
    });

    const app = await buildApp({
      userId: admin.id,
      username: 'owner',
      role: 'owner',
      serverIds: [],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/violations/bulk/acknowledge',
      payload: { selectAll: true, filters: { userId: personATarget.id } },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, acknowledged: 2 });

    const [rowA1] = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, violationA1.id));
    const [rowA2] = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, violationA2.id));
    const [rowB] = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, violationB.id));

    expect(rowA1?.acknowledgedAt).not.toBeNull();
    expect(rowA2?.acknowledgedAt).not.toBeNull();
    // Person B's violation must be untouched by person A's select-all.
    expect(rowB?.acknowledgedAt).toBeNull();
  });

  it('rejects a non-owner before resolving the person filter at all', async () => {
    const server = await createTestServer({ type: 'plex' });
    const person = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: person.id, serverId: server.id });
    const rule = await createConcurrentStreamsAutomation(2);
    const session = await createTestSession({ serverId: server.id, serverUserId: su.id });
    const violation = await createTestRun({
      automationId: rule.id,
      serverUserId: su.id,
      sessionId: session.id,
    });

    const app = await buildApp({
      userId: randomUUID(),
      username: 'viewer',
      role: 'viewer',
      serverIds: [server.id],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/violations/bulk/acknowledge',
      payload: { selectAll: true, filters: { userId: person.id } },
    });
    await app.close();

    expect(response.statusCode).toBe(403);
    const [row] = await db.select().from(automationRuns).where(eq(automationRuns.id, violation.id));
    expect(row?.acknowledgedAt).toBeNull();
  });
});

describe('POST /violations/bulk/acknowledge - already acknowledged rows', () => {
  it('keeps the earlier acknowledgedAt and counts only the rows it stamped, by selectAll or by id', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const person = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: person.id, serverId: server.id });
    const rule = await createConcurrentStreamsAutomation(2);
    const [earlier, pending] = await Promise.all(
      [1, 2].map(async () => {
        const session = await createTestSession({ serverId: server.id, serverUserId: su.id });
        return createTestRun({ automationId: rule.id, serverUserId: su.id, sessionId: session.id });
      })
    );
    if (!earlier || !pending) throw new Error('runs were not created');
    const acknowledgedAt = new Date('2026-01-02T03:04:05.000Z');
    await db
      .update(automationRuns)
      .set({ acknowledgedAt })
      .where(eq(automationRuns.id, earlier.id));

    const app = await buildApp({
      userId: admin.id,
      username: 'owner',
      role: 'owner',
      serverIds: [],
    });
    const bySelectAll = await app.inject({
      method: 'POST',
      url: '/violations/bulk/acknowledge',
      payload: { selectAll: true },
    });
    const byIds = await app.inject({
      method: 'POST',
      url: '/violations/bulk/acknowledge',
      payload: { ids: [earlier.id, pending.id] },
    });
    await app.close();

    expect(bySelectAll.json()).toEqual({ success: true, acknowledged: 1 });
    expect(byIds.json()).toEqual({ success: true, acknowledged: 0 });

    const [earlierRow] = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, earlier.id));
    const [pendingRow] = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, pending.id));
    expect(earlierRow?.acknowledgedAt).toEqual(acknowledgedAt);
    expect(pendingRow?.acknowledgedAt).not.toBeNull();
  });
});

describe('DELETE /violations/bulk - person filter', () => {
  it('selectAll scoped to a person filter dismisses only that person, leaving another person untouched', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    const personATarget = await createTestUser({ role: 'member' });
    const personASource = await createTestUser({ role: 'member' });
    const personASu1 = await createTestServerUser({
      userId: personATarget.id,
      serverId: serverA.id,
    });
    const personASu2 = await createTestServerUser({
      userId: personASource.id,
      serverId: serverB.id,
    });
    await mergeUsers(personASource.id, personATarget.id, admin.id);

    const personB = await createTestUser({ role: 'member' });
    const personBSu = await createTestServerUser({ userId: personB.id, serverId: serverA.id });

    const rule = await createConcurrentStreamsAutomation(2);

    const sessionA1 = await createTestSession({
      serverId: serverA.id,
      serverUserId: personASu1.id,
    });
    const sessionA2 = await createTestSession({
      serverId: serverB.id,
      serverUserId: personASu2.id,
    });
    const sessionB = await createTestSession({ serverId: serverA.id, serverUserId: personBSu.id });

    const violationA1 = await createTestRun({
      automationId: rule.id,
      serverUserId: personASu1.id,
      sessionId: sessionA1.id,
    });
    const violationA2 = await createTestRun({
      automationId: rule.id,
      serverUserId: personASu2.id,
      sessionId: sessionA2.id,
    });
    const violationB = await createTestRun({
      automationId: rule.id,
      serverUserId: personBSu.id,
      sessionId: sessionB.id,
    });

    const app = await buildApp({
      userId: admin.id,
      username: 'owner',
      role: 'owner',
      serverIds: [],
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/violations/bulk',
      payload: { selectAll: true, filters: { userId: personATarget.id } },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, dismissed: 2 });

    // Dismiss is a soft delete: rows survive with dismissedAt stamped so
    // dedup keeps blocking re-creation.
    const rows = await db.select().from(automationRuns);
    const dismissedById = new Map(rows.map((v) => [v.id, v.dismissedAt]));
    expect(dismissedById.get(violationA1.id)).toBeInstanceOf(Date);
    expect(dismissedById.get(violationA2.id)).toBeInstanceOf(Date);
    // Person B's violation must survive person A's select-all dismiss.
    expect(dismissedById.get(violationB.id)).toBeNull();
  });

  it('recomputes the merged person aggregate trust once after dismissing reversible violations on both of their accounts', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });

    const targetSu = await createTestServerUser({
      userId: target.id,
      serverId: serverA.id,
      trustScore: 90,
    });
    const sourceSu = await createTestServerUser({
      userId: source.id,
      serverId: serverB.id,
      trustScore: 90,
    });
    await mergeUsers(source.id, target.id, admin.id);

    // Seed a correct baseline rollup the way a prior trust-affecting write would
    // have left it, matching the pattern used elsewhere for this recompute:
    // both accounts at 90, so the worst-account rollup is 90.
    await userService.recomputeIdentityAggregates(target.id);
    const [before] = await db.select().from(users).where(eq(users.id, target.id));
    expect(before?.aggregateTrustScore).toBe(90);

    const rule = await createConcurrentStreamsAutomation(2);
    await db
      .update(automations)
      .set({ actions: { actions: [{ type: 'trust', mode: 'adjust', amount: -20 }] } })
      .where(eq(automations.id, rule.id));

    const sessionA = await createTestSession({ serverId: serverA.id, serverUserId: targetSu.id });
    const sessionB = await createTestSession({ serverId: serverB.id, serverUserId: sourceSu.id });
    await db.update(serverUsers).set({ trustScore: 70 }).where(eq(serverUsers.id, targetSu.id));
    await db.update(serverUsers).set({ trustScore: 70 }).where(eq(serverUsers.id, sourceSu.id));

    const violationA = await createTestRun({
      automationId: rule.id,
      serverUserId: targetSu.id,
      sessionId: sessionA.id,
    });
    const violationB = await createTestRun({
      automationId: rule.id,
      serverUserId: sourceSu.id,
      sessionId: sessionB.id,
    });

    const recomputeSpy = vi.spyOn(userService, 'recomputeIdentityAggregates');

    const app = await buildApp({
      userId: admin.id,
      username: 'owner',
      role: 'owner',
      serverIds: [],
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/violations/bulk',
      payload: { ids: [violationA.id, violationB.id] },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, dismissed: 2 });

    // Both accounts reversed the rule's -20 adjustment: 70 - (-20) = 90 each.
    const [targetSuRow] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, targetSu.id));
    const [sourceSuRow] = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, sourceSu.id));
    expect(targetSuRow?.trustScore).toBe(90);
    expect(sourceSuRow?.trustScore).toBe(90);

    // The identity rollup reflects BOTH reversed accounts, not a stale
    // half-applied recompute: (90*10 + 90*30) / 40 = 90.
    const [after] = await db.select().from(users).where(eq(users.id, target.id));
    expect(after?.aggregateTrustScore).toBe(90);

    // One recompute per affected identity, not once per dismissed violation.
    expect(recomputeSpy).toHaveBeenCalledTimes(1);
    expect(recomputeSpy).toHaveBeenCalledWith(target.id, expect.anything());

    recomputeSpy.mockRestore();
  });
});

describe('GET /violations - user.userId identity field', () => {
  it('includes the identity id on each violation row for row-level "filter by this person"', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const person = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: person.id, serverId: server.id });
    const rule = await createConcurrentStreamsAutomation(2);
    const session = await createTestSession({ serverId: server.id, serverUserId: su.id });
    await createTestRun({ automationId: rule.id, serverUserId: su.id, sessionId: session.id });

    const app = await buildApp({
      userId: admin.id,
      username: 'owner',
      role: 'owner',
      serverIds: [],
    });

    const response = await app.inject({ method: 'GET', url: '/violations' });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].user.userId).toBe(person.id);
  });
});

describe('bulk endpoints - people (userIds) multiselect filter', () => {
  async function seedThreePeople() {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });
    const personA = await createTestUser({ role: 'member' });
    const personB = await createTestUser({ role: 'member' });
    const personC = await createTestUser({ role: 'member' });
    const suA = await createTestServerUser({ userId: personA.id, serverId: server.id });
    const suB = await createTestServerUser({ userId: personB.id, serverId: server.id });
    const suC = await createTestServerUser({ userId: personC.id, serverId: server.id });
    const rule = await createConcurrentStreamsAutomation(2);

    const sessionA = await createTestSession({ serverId: server.id, serverUserId: suA.id });
    const sessionB = await createTestSession({ serverId: server.id, serverUserId: suB.id });
    const sessionC = await createTestSession({ serverId: server.id, serverUserId: suC.id });

    const violationA = await createTestRun({
      automationId: rule.id,
      serverUserId: suA.id,
      sessionId: sessionA.id,
    });
    const violationB = await createTestRun({
      automationId: rule.id,
      serverUserId: suB.id,
      sessionId: sessionB.id,
    });
    const violationC = await createTestRun({
      automationId: rule.id,
      serverUserId: suC.id,
      sessionId: sessionC.id,
    });

    return { admin, personA, personB, personC, violationA, violationB, violationC };
  }

  it('bulk acknowledge selectAll scoped to two selected people touches exactly those two and nobody else', async () => {
    const { admin, personA, personB, violationA, violationB, violationC } = await seedThreePeople();
    const app = await buildApp({
      userId: admin.id,
      username: 'owner',
      role: 'owner',
      serverIds: [],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/violations/bulk/acknowledge',
      payload: { selectAll: true, filters: { userIds: [personA.id, personB.id] } },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, acknowledged: 2 });

    const [rowA] = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, violationA.id));
    const [rowB] = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, violationB.id));
    const [rowC] = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, violationC.id));

    expect(rowA?.acknowledgedAt).not.toBeNull();
    expect(rowB?.acknowledgedAt).not.toBeNull();
    // The third, unselected person must be untouched by the two-person select-all.
    expect(rowC?.acknowledgedAt).toBeNull();
  });

  it('bulk dismiss selectAll scoped to two selected people touches exactly those two and nobody else', async () => {
    const { admin, personA, personB, violationA, violationB, violationC } = await seedThreePeople();
    const app = await buildApp({
      userId: admin.id,
      username: 'owner',
      role: 'owner',
      serverIds: [],
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/violations/bulk',
      payload: { selectAll: true, filters: { userIds: [personA.id, personB.id] } },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, dismissed: 2 });

    const rows = await db.select().from(automationRuns);
    const dismissedById = new Map(rows.map((v) => [v.id, v.dismissedAt]));
    expect(dismissedById.get(violationA.id)).toBeInstanceOf(Date);
    expect(dismissedById.get(violationB.id)).toBeInstanceOf(Date);
    expect(dismissedById.get(violationC.id)).toBeNull();
  });

  it('GET /violations with userIds returns exactly the union of the selected people, singular userId still works', async () => {
    const { admin, personA, personB, personC } = await seedThreePeople();
    const app = await buildApp({
      userId: admin.id,
      username: 'owner',
      role: 'owner',
      serverIds: [],
    });

    const multiResponse = await app.inject({
      method: 'GET',
      url: `/violations?userIds=${personA.id}&userIds=${personB.id}`,
    });
    const singularResponse = await app.inject({
      method: 'GET',
      url: `/violations?userId=${personC.id}`,
    });
    await app.close();

    expect(multiResponse.statusCode).toBe(200);
    const multiBody = multiResponse.json();
    expect(multiBody.meta.total).toBe(2);
    const multiUserIds = multiBody.data
      .map((v: { user: { userId: string } }) => v.user.userId)
      .sort();
    expect(multiUserIds).toEqual([personA.id, personB.id].sort());

    expect(singularResponse.statusCode).toBe(200);
    const singularBody = singularResponse.json();
    expect(singularBody.meta.total).toBe(1);
    expect(singularBody.data[0].user.userId).toBe(personC.id);
  });

  it('bulk acknowledge rejects a malformed body instead of touching anything', async () => {
    const { admin, violationA, violationB, violationC } = await seedThreePeople();
    const app = await buildApp({
      userId: admin.id,
      username: 'owner',
      role: 'owner',
      serverIds: [],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/violations/bulk/acknowledge',
      payload: { selectAll: true, filters: { userIds: ['not-a-uuid'] } },
    });
    await app.close();

    expect(response.statusCode).toBe(400);
    for (const id of [violationA.id, violationB.id, violationC.id]) {
      const [row] = await db.select().from(automationRuns).where(eq(automationRuns.id, id));
      expect(row?.acknowledgedAt).toBeNull();
    }
  });

  it('bulk dismiss rejects a malformed body instead of touching anything', async () => {
    const { admin, violationA, violationB, violationC } = await seedThreePeople();
    const app = await buildApp({
      userId: admin.id,
      username: 'owner',
      role: 'owner',
      serverIds: [],
    });

    const response = await app.inject({
      method: 'DELETE',
      url: '/violations/bulk',
      payload: { ids: 'not-an-array' },
    });
    await app.close();

    expect(response.statusCode).toBe(400);
    const remaining = await db.select().from(automationRuns);
    const remainingIds = remaining.map((v) => v.id);
    expect(remainingIds).toEqual(
      expect.arrayContaining([violationA.id, violationB.id, violationC.id])
    );
  });
});

describe('recomputeIdentityAggregates semantics', () => {
  it('a solo account mirrors its own score, and its violations set the identity total', async () => {
    const server = await createTestServer({ type: 'plex' });
    const person = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({
      userId: person.id,
      serverId: server.id,
      trustScore: 85,
    });
    const rule = await createConcurrentStreamsAutomation(2);
    const session = await createTestSession({ serverId: server.id, serverUserId: su.id });
    await createTestRun({ automationId: rule.id, serverUserId: su.id, sessionId: session.id });

    await userService.recomputeIdentityAggregates(person.id);

    const [row] = await db.select().from(users).where(eq(users.id, person.id));
    expect(row?.aggregateTrustScore).toBe(85);
    expect(row?.totalViolations).toBe(1);
  });

  it('a removed account stops dragging the trust rollup but its violations still count', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const person = await createTestUser({ role: 'member' });
    await createTestServerUser({
      userId: person.id,
      serverId: serverA.id,
      trustScore: 95,
    });
    const removedSu = await createTestServerUser({
      userId: person.id,
      serverId: serverB.id,
      trustScore: 20,
      removedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const rule = await createConcurrentStreamsAutomation(2);
    const session = await createTestSession({ serverId: serverB.id, serverUserId: removedSu.id });
    await createTestRun({
      automationId: rule.id,
      serverUserId: removedSu.id,
      sessionId: session.id,
    });

    await userService.recomputeIdentityAggregates(person.id);

    const [row] = await db.select().from(users).where(eq(users.id, person.id));
    expect(row?.aggregateTrustScore).toBe(95);
    expect(row?.totalViolations).toBe(1);
  });

  it('an identity whose accounts are all removed keeps its worst historical score instead of resetting to 100', async () => {
    const server = await createTestServer({ type: 'plex' });
    const person = await createTestUser({ role: 'member' });
    await createTestServerUser({
      userId: person.id,
      serverId: server.id,
      trustScore: 35,
      removedAt: new Date('2026-01-01T00:00:00Z'),
    });

    await userService.recomputeIdentityAggregates(person.id);

    const [row] = await db.select().from(users).where(eq(users.id, person.id));
    expect(row?.aggregateTrustScore).toBe(35);
    expect(row?.totalViolations).toBe(0);
  });
});
