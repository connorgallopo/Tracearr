/**
 * User downloads route tests
 *
 * Identity resolution and the page query are mocked: these assert the permission gate, the
 * 404 and the arguments the query receives.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';
import type * as QueriesModule from '../queries/index.js';

vi.mock('../../../db/client.js', () => ({ db: {} }));

vi.mock('../queries/index.js', async (importActual) => ({
  ...(await importActual<typeof QueriesModule>()),
  resolveIdentityScopedServerUserIds: vi.fn(),
  queryUserDownloads: vi.fn(),
}));

import { queryUserDownloads, resolveIdentityScopedServerUserIds } from '../queries/index.js';
import { downloadsRoutes } from '../downloads.js';
import { permissionGuard } from '../../../lib/scope.js';

const mockResolve = vi.mocked(resolveIdentityScopedServerUserIds);
const mockQuery = vi.mocked(queryUserDownloads);

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));
  await app.register(downloadsRoutes, { prefix: '/users' });
  return app;
}

const owner = (): AuthUser => ({
  userId: randomUUID(),
  username: 'owner',
  role: 'owner',
  serverIds: [],
});

describe('GET /users/:id/downloads', () => {
  let app: FastifyInstance;
  const id = randomUUID();

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue({
      serverUser: { id, serverId: randomUUID(), userId: randomUUID() },
      ids: [id],
    });
    mockQuery.mockResolvedValue({ data: [], total: 0 });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 404 to a member', async () => {
    app = await buildTestApp({ ...owner(), role: 'member' });
    const response = await app.inject({ url: `/users/${id}/downloads` });
    expect(response.statusCode).toBe(404);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown user', async () => {
    mockResolve.mockResolvedValue({ error: 'notFound' });
    app = await buildTestApp(owner());
    const response = await app.inject({ url: `/users/${id}/downloads` });
    expect(response.statusCode).toBe(404);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('pages the first account only by default', async () => {
    mockQuery.mockResolvedValue({ data: [], total: 41 });
    app = await buildTestApp(owner());
    const response = await app.inject({ url: `/users/${id}/downloads?page=2&pageSize=10` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [], total: 41 });
    expect(mockResolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      id,
      undefined,
      'all'
    );
    expect(mockQuery).toHaveBeenCalledWith(expect.anything(), [id], 2, 10);
  });

  it('queries every account the identity scope resolves', async () => {
    const sibling = randomUUID();
    mockResolve.mockResolvedValue({
      serverUser: { id, serverId: randomUUID(), userId: randomUUID() },
      ids: [id, sibling],
    });
    app = await buildTestApp(owner());
    const response = await app.inject({ url: `/users/${id}/downloads?scope=identity` });
    expect(response.statusCode).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      id,
      'identity',
      'all'
    );
    expect(mockQuery).toHaveBeenCalledWith(expect.anything(), [id, sibling], 1, 20);
  });
});
