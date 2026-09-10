/**
 * User detail aggregate route tests
 *
 * The db is mocked and every query records the WHERE it was handed, so the
 * assertions render the predicates the handler actually built. The violations
 * panel and its count read automation_runs, which also holds notification runs
 * and runs that stopped or errored; both have to carry the alias filter.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';
import { queryChain, renderedWheres } from '../../../test/helpers.js';

vi.mock('../../../db/client.js', () => ({
  db: { transaction: vi.fn() },
}));

import { db } from '../../../db/client.js';
import { fullRoutes } from '../full.js';

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: any) => {
    request.user = authUser;
  });
  await app.register(fullRoutes, { prefix: '/users' });
  return app;
}

describe('GET /users/:id/full violations panel', () => {
  let app: FastifyInstance;
  let chains: any[];

  beforeEach(() => {
    vi.clearAllMocks();
    chains = [];
  });

  afterEach(async () => {
    await app.close();
  });

  it('filters the violations list and its count to completed policy runs', async () => {
    const serverUserId = randomUUID();
    const serverId = randomUUID();
    const authUser: AuthUser = {
      userId: randomUUID(),
      username: 'owner',
      role: 'owner',
      serverIds: [serverId],
    };
    app = await buildTestApp(authUser);

    let selectCall = 0;
    const tx = {
      select: vi.fn(() => {
        selectCall++;
        const rows = selectCall === 1 ? [{ id: serverUserId, serverId, userId: randomUUID() }] : [];
        const chain = queryChain(vi.fn, rows);
        chains.push(chain);
        return chain;
      }),
      execute: vi.fn(async () => ({ rows: [] })),
    };
    vi.mocked((db as any).transaction).mockImplementation(async (callback: any) => callback(tx));

    const response = await app.inject({
      method: 'GET',
      url: `/users/${serverUserId}/full`,
    });

    expect(response.statusCode).toBe(200);

    const runWheres = renderedWheres(chains).filter((text) => text.includes('automation_runs'));
    expect(runWheres).toHaveLength(2);
    for (const where of runWheres) {
      expect(where).toContain('automation_runs.kind =');
      expect(where).toContain('automation_runs.outcome =');
      expect(where).toContain('automation_runs.dismissed_at is null');
    }
  });

  it('carries the identity contact email in the identity block', async () => {
    const serverUserId = randomUUID();
    const serverId = randomUUID();
    const authUser: AuthUser = {
      userId: randomUUID(),
      username: 'owner',
      role: 'owner',
      serverIds: [serverId],
    };
    app = await buildTestApp(authUser);

    let selectCall = 0;
    const tx = {
      select: vi.fn(() => {
        selectCall++;
        const rows =
          selectCall === 1
            ? [
                {
                  id: serverUserId,
                  serverId,
                  userId: randomUUID(),
                  identityName: 'Ann',
                  identityContactEmail: 'ann@example.com',
                  identityAggregateTrustScore: 90,
                  identityTotalViolations: 0,
                },
              ]
            : [];
        const chain = queryChain(vi.fn, rows);
        chains.push(chain);
        return chain;
      }),
      execute: vi.fn(async () => ({ rows: [] })),
    };
    vi.mocked((db as any).transaction).mockImplementation(async (callback: any) => callback(tx));

    const response = await app.inject({ method: 'GET', url: `/users/${serverUserId}/full` });

    expect(response.statusCode).toBe(200);
    expect(response.json().identity.contactEmail).toBe('ann@example.com');
    expect(response.json().user).not.toHaveProperty('identityContactEmail');
  });
});
