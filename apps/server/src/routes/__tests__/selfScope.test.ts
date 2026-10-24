/**
 * Self scope route tests
 *
 * The reads behind Your Stats take `self=true`, which narrows them to the viewer's own accounts
 * for every role. Without it an owner still reads every account. db.execute is mocked, so these
 * prove which account ids reach the SQL.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { SQL } from 'drizzle-orm';
import type { AuthUser } from '@tracearr/shared';
import { queryChain, renderSql } from '../../test/helpers.js';

vi.mock('../../db/client.js', () => ({ db: { execute: vi.fn(), select: vi.fn() } }));
vi.mock('../../services/cache.js', () => ({ getCacheService: () => null }));
vi.mock('../../services/termination.js', () => ({ terminateSession: vi.fn() }));

import { db } from '../../db/client.js';
import { permissionGuard } from '../../lib/scope.js';
import { sessionRoutes } from '../sessions/index.js';
import { contentRoutes } from '../stats/content.js';
import { engagementRoutes } from '../stats/engagement.js';
import { playsRoutes } from '../stats/plays.js';

const OWNER_ACCOUNT = '11111111-1111-4111-8111-111111111111';
const owner: AuthUser = { userId: 'u-owner', username: 'own', role: 'owner', serverIds: [] };

const ROUTES = [
  '/sessions/history/aggregates',
  '/stats/plays-by-dayofweek',
  '/stats/plays-by-hourofday',
  '/stats/top-content',
  '/stats/engagement',
  '/stats/shows',
];

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);
  vi.mocked(db.select).mockImplementation(() =>
    queryChain(vi.fn, [{ id: OWNER_ACCOUNT, serverId: 'server-1' }])
  );
  app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = owner;
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('requireOwner', async () => undefined);
  app.decorate('redis', { get: vi.fn().mockResolvedValue(null) } as never);
  await app.register(sessionRoutes, { prefix: '/sessions' });
  await app.register(playsRoutes, { prefix: '/stats' });
  await app.register(contentRoutes, { prefix: '/stats' });
  await app.register(engagementRoutes, { prefix: '/stats' });
});

afterEach(async () => {
  await app.close();
});

const sentParams = () =>
  vi.mocked(db.execute).mock.calls.flatMap((call) => renderSql(call[0] as SQL).params);

describe.each(ROUTES)('%s as the owner', (route) => {
  it("reads only the owner's own accounts with self=true", async () => {
    await app.inject({ url: `${route}?self=true` });

    expect(db.execute).toHaveBeenCalled();
    expect(sentParams()).toContain(OWNER_ACCOUNT);
  });

  it('reads every account without self, as before', async () => {
    await app.inject({ url: route });

    expect(db.execute).toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(sentParams()).not.toContain(OWNER_ACCOUNT);
  });
});
