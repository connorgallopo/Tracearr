/**
 * Case-folded name sorts against a real database
 *
 * The Alpine image compares text by bytes, so the roster, the violations user
 * and rule columns and the automations list order on lower(...) to keep
 * capitals and lowercase names together.
 *
 * Run with: pnpm --filter @tracearr/server test:integration sortNames
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import { resetTestDb } from '@tracearr/test-utils/db';
import {
  createTestAutomation,
  createTestRun,
  createTestServer,
  createTestServerUser,
  createTestSession,
  createTestUser,
} from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { userRoutes } from '../../src/routes/users/index.js';
import { violationRoutes } from '../../src/routes/violations/index.js';
import { automationRoutes } from '../../src/routes/automations.js';
import { permissionGuard } from '../../src/lib/scope.js';

const PERSON_NAMES = ['Bob', 'alice', '_x', 'Zed', 'Emile', 'emile'];
const AUTOMATION_NAMES = ['Bob', 'alice', '_x', 'Zed', 'Emile'];

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('redis', createMockRedis() as unknown as Redis);
  const owner = { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };
  app.decorate('authenticate', async (request: any) => {
    request.user = owner;
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('requireOwner', async (request: any) => {
    request.user = owner;
  });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(violationRoutes, { prefix: '/violations' });
  await app.register(automationRoutes, { prefix: '/automations' });
  return app;
}

async function seed() {
  const server = await createTestServer({ type: 'plex' });
  const rules = new Map<string, string>();
  for (const name of AUTOMATION_NAMES) {
    const rule = await createTestAutomation({ name });
    rules.set(name.toLowerCase(), rule.id);
  }
  for (const [index, name] of PERSON_NAMES.entries()) {
    const person = await createTestUser({ name, username: `member${index}` });
    const account = await createTestServerUser({ userId: person.id, serverId: server.id });
    const session = await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      startedAt: new Date(Date.UTC(2026, 0, 1 + index)),
      state: 'stopped',
    });
    const automationId = rules.get(name.toLowerCase());
    if (!automationId) throw new Error(`no automation for ${name}`);
    await createTestRun({ automationId, serverUserId: account.id, sessionId: session.id });
  }
}

describe('case-folded name sorts', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(async () => {
    await resetTestDb();
    await seed();
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists the roster by case-folded display name with the id tiebreak for equal names', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/users?orderBy=username&orderDir=asc&pageSize=10',
    });
    const rows = res.json().data as {
      userId: string;
      identityName: string | null;
      username: string;
    }[];
    const names = rows.map((u) => u.identityName ?? u.username);
    expect(names.slice(0, 2)).toEqual(['_x', 'alice']);
    expect(names[2]).toBe('Bob');
    expect(names.slice(3, 5).sort()).toEqual(['Emile', 'emile']);
    expect(names[5]).toBe('Zed');
    const tied = rows.slice(3, 5).map((u) => u.userId);
    expect(tied).toEqual([...tied].sort());
  });

  it('sorts violations by the shown name and by rule name, case folded', async () => {
    const byUser = await app.inject({
      method: 'GET',
      url: '/violations?orderBy=user&orderDir=asc&pageSize=10',
    });
    const userNames = (
      byUser.json().data as { user: { identityName: string | null; username: string } }[]
    ).map((v) => v.user.identityName ?? v.user.username);
    expect(userNames.slice(0, 3)).toEqual(['_x', 'alice', 'Bob']);
    const byRule = await app.inject({
      method: 'GET',
      url: '/violations?orderBy=rule&orderDir=asc&pageSize=10',
    });
    expect(
      (byRule.json().data as { rule: { name: string } }[]).map((v) => v.rule.name).slice(0, 4)
    ).toEqual(['_x', 'alice', 'Bob', 'Emile']);
  });

  it('lists automations by case-folded name', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/automations?orderBy=name&orderDir=asc&pageSize=10',
    });
    expect((res.json().data as { name: string }[]).map((a) => a.name)).toEqual([
      '_x',
      'alice',
      'Bob',
      'Emile',
      'Zed',
    ]);
  });
});
