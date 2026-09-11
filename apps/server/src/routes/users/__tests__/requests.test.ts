/**
 * User requests route tests
 *
 * GET /:id/requests - one identity's Seerr request history, identity scoped.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, UserRequestEntry, UserRequestsResponse } from '@tracearr/shared';

vi.mock('../../../db/client.js', () => ({ db: {} }));

vi.mock('../queries.js', () => ({ resolveIdentityScopedServerUserIds: vi.fn() }));

vi.mock('../../../services/requests/reads.js', () => ({ listUserRequests: vi.fn() }));

import { listUserRequests } from '../../../services/requests/reads.js';
import { resolveIdentityScopedServerUserIds } from '../queries.js';
import { requestsRoutes } from '../requests.js';

const SERVER_USER_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_SERVER_USER_ID = '66666666-6666-4666-8666-666666666666';
const SERVER_ID = '77777777-7777-4777-8777-777777777777';

const authUser: AuthUser = {
  userId: randomUUID(),
  username: 'viewer',
  role: 'admin',
  serverIds: [SERVER_ID],
};

const entry: UserRequestEntry = {
  id: 'req-1',
  serverId: SERVER_ID,
  status: 'completed',
  requestedAt: '2026-01-01T00:00:00.000Z',
  availableAt: '2026-01-01T00:00:05.000Z',
  waitMs: 5000,
  deletedAt: null,
  seasons: null,
  is4k: false,
  isAutoRequest: false,
  watchedState: 'partial',
  media: { mediaId: null, title: 'X', year: 2020, mediaType: 'movie' },
};

const emptyResponse: UserRequestsResponse = {
  data: [],
  total: 0,
  page: 1,
  pageSize: 5,
  summary: {
    total: 0,
    approvalRate: null,
    completed: 0,
    neverWatched: 0,
    medianWaitMs: null,
  },
};

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user?: AuthUser }) => {
    request.user = authUser;
  });
  await app.register(requestsRoutes, { prefix: '/users' });
  return app;
}

describe('User Requests Route', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.mocked(listUserRequests).mockResolvedValue(emptyResponse);
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  it('404s a server user that does not exist', async () => {
    vi.mocked(resolveIdentityScopedServerUserIds).mockResolvedValue({ error: 'notFound' });

    const response = await app.inject({
      method: 'GET',
      url: `/users/${SERVER_USER_ID}/requests`,
    });

    expect(response.statusCode).toBe(404);
    expect(listUserRequests).not.toHaveBeenCalled();
  });

  it('403s a server the caller cannot see', async () => {
    vi.mocked(resolveIdentityScopedServerUserIds).mockResolvedValue({ error: 'forbidden' });

    const response = await app.inject({
      method: 'GET',
      url: `/users/${SERVER_USER_ID}/requests`,
    });

    expect(response.statusCode).toBe(403);
    expect(listUserRequests).not.toHaveBeenCalled();
  });

  it('passes the page window through', async () => {
    vi.mocked(resolveIdentityScopedServerUserIds).mockResolvedValue({
      serverUser: { id: SERVER_USER_ID, serverId: SERVER_ID, userId: authUser.userId },
      ids: [SERVER_USER_ID],
    });

    const response = await app.inject({
      method: 'GET',
      url: `/users/${SERVER_USER_ID}/requests?page=3&pageSize=20`,
    });

    expect(response.statusCode).toBe(200);
    expect(listUserRequests).toHaveBeenCalledWith({
      serverUserIds: [SERVER_USER_ID],
      serverIds: [SERVER_ID],
      page: 3,
      pageSize: 20,
    });
  });

  it('returns the watched state the read layer resolved', async () => {
    vi.mocked(resolveIdentityScopedServerUserIds).mockResolvedValue({
      serverUser: { id: SERVER_USER_ID, serverId: SERVER_ID, userId: authUser.userId },
      ids: [SERVER_USER_ID],
    });
    vi.mocked(listUserRequests).mockResolvedValue({ ...emptyResponse, data: [entry], total: 1 });

    const response = await app.inject({
      method: 'GET',
      url: `/users/${SERVER_USER_ID}/requests`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].watchedState).toBe('partial');
  });

  it('expands to every account of the identity under scope=identity', async () => {
    vi.mocked(resolveIdentityScopedServerUserIds).mockResolvedValue({
      serverUser: { id: SERVER_USER_ID, serverId: SERVER_ID, userId: authUser.userId },
      ids: [SERVER_USER_ID, OTHER_SERVER_USER_ID],
    });

    const response = await app.inject({
      method: 'GET',
      url: `/users/${SERVER_USER_ID}/requests?scope=identity`,
    });

    expect(response.statusCode).toBe(200);
    expect(resolveIdentityScopedServerUserIds).toHaveBeenCalledWith(
      expect.anything(),
      authUser,
      SERVER_USER_ID,
      'identity'
    );
    expect(listUserRequests).toHaveBeenCalledWith({
      serverUserIds: [SERVER_USER_ID, OTHER_SERVER_USER_ID],
      serverIds: [SERVER_ID],
      page: 1,
      pageSize: 5,
    });
  });

  it('rejects a page size above the cap', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/users/${SERVER_USER_ID}/requests?pageSize=500`,
    });

    expect(response.statusCode).toBe(400);
    expect(resolveIdentityScopedServerUserIds).not.toHaveBeenCalled();
  });
});
