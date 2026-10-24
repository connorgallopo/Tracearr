/**
 * User range stats route tests
 *
 * The service is mocked: these assert what the route resolves and hands it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';
import type * as PeopleStatsModule from '../../../services/stats/peopleStats.js';

vi.mock('../../../db/client.js', () => ({ db: {} }));

vi.mock('../queries/index.js', () => ({
  resolveIdentityScopedServerUserIds: vi.fn(),
}));

vi.mock('../../../services/stats/peopleStats.js', async (importActual) => ({
  ...(await importActual<typeof PeopleStatsModule>()),
  queryIdentityRangeStats: vi.fn(async () => ({ plays: 3 })),
}));

import { resolveIdentityScopedServerUserIds } from '../queries/index.js';
import { queryIdentityRangeStats } from '../../../services/stats/peopleStats.js';
import { statsRoutes } from '../stats.js';
import { permissionGuard } from '../../../lib/scope.js';

const mockResolve = vi.mocked(resolveIdentityScopedServerUserIds);
const mockStats = vi.mocked(queryIdentityRangeStats);

const ANCHOR = randomUUID();
const SIBLING = randomUUID();

function owner(): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
}

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: any) => {
    request.user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));
  await app.register(statsRoutes, { prefix: '/users' });
  return app;
}

describe('GET /users/:id/stats', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockResolve.mockImplementation(async (_db, _user, id, scope) => ({
      serverUser: { id, serverId: randomUUID(), userId: randomUUID() },
      ids: scope === 'identity' ? [id, SIBLING] : [id],
    }));
    app = await buildTestApp(owner());
  });

  afterEach(async () => {
    await app.close();
  });

  it('passes the identity ids for scope=identity and the anchor id otherwise', async () => {
    const identity = await app.inject({ url: `/users/${ANCHOR}/stats?scope=identity` });
    expect(identity.statusCode).toBe(200);
    expect(identity.json()).toEqual({ plays: 3 });
    expect(mockStats.mock.calls[0]?.[0].serverUserIds).toEqual([ANCHOR, SIBLING]);

    await app.inject({ url: `/users/${ANCHOR}/stats` });
    expect(mockStats.mock.calls[1]?.[0].serverUserIds).toEqual([ANCHOR]);
  });

  it('rejects a custom range without dates with 400', async () => {
    const response = await app.inject({ url: `/users/${ANCHOR}/stats?period=custom` });
    expect(response.statusCode).toBe(400);
    expect(mockStats).not.toHaveBeenCalled();
  });

  it('includes the last selected day of a custom range and hands the service an equal prior window', async () => {
    const response = await app.inject({
      url: `/users/${ANCHOR}/stats?period=custom&startDate=2019-03-02T00:00:00.000Z&endDate=2019-03-03T00:00:00.000Z`,
    });
    expect(response.statusCode).toBe(200);
    const window = mockStats.mock.calls[0]?.[0].window;
    expect(window?.range.end).toEqual(new Date('2019-03-04T00:00:00.000Z'));
    expect(window?.prior).toEqual({
      start: new Date('2019-02-28T00:00:00.000Z'),
      end: new Date('2019-03-02T00:00:00.000Z'),
    });
  });

  it('answers 404 for an account outside the caller scope', async () => {
    mockResolve.mockResolvedValueOnce({ error: 'notFound' });
    const response = await app.inject({ url: `/users/${ANCHOR}/stats` });
    expect(response.statusCode).toBe(404);
  });
});
