/**
 * Server user routes tests
 *
 * POST /server-users/:id/split with the merge service mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { APIError } from 'better-auth/api';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';
import type * as MergeServiceModule from '../../services/mergeService.js';

vi.mock('../../services/mergeService.js', async (importActual) => {
  const actual = await importActual<typeof MergeServiceModule>();
  return { ...actual, splitServerUser: vi.fn() };
});

import { splitServerUser, MergeValidationError } from '../../services/mergeService.js';
import { serverUserRoutes } from '../serverUsers.js';

const mockSplit = vi.mocked(splitServerUser);

function createAuthUser(role: AuthUser['role']): AuthUser {
  return { userId: randomUUID(), username: 'tester', role, serverIds: [] };
}

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('requireOwner', async (request: any, reply: any) => {
    request.user = authUser;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Owner access required');
    }
  });
  await app.register(serverUserRoutes, { prefix: '/server-users' });
  return app;
}

describe('POST /server-users/:id/split', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it('splits and returns the new identity id', async () => {
    const owner = createAuthUser('owner');
    app = await buildTestApp(owner);
    const serverUserId = randomUUID();
    const newUserId = randomUUID();
    mockSplit.mockResolvedValue({ newUserId, serverUserId });

    const response = await app.inject({
      method: 'POST',
      url: `/server-users/${serverUserId}/split`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ newUserId, serverUserId });
    expect(mockSplit).toHaveBeenCalledWith(serverUserId, owner.userId);
  });

  it('returns 400 on a validation error', async () => {
    app = await buildTestApp(createAuthUser('owner'));
    mockSplit.mockRejectedValue(
      new MergeValidationError('cannot split the only server account of an identity')
    );

    const response = await app.inject({
      method: 'POST',
      url: `/server-users/${randomUUID()}/split`,
    });

    expect(response.statusCode).toBe(400);
  });

  it("refuses a split that would take the owner's last way to sign in", async () => {
    app = await buildTestApp(createAuthUser('owner'));
    mockSplit.mockRejectedValue(
      new APIError('BAD_REQUEST', { message: 'That would leave the owner with no way to sign in.' })
    );

    const response = await app.inject({
      method: 'POST',
      url: `/server-users/${randomUUID()}/split`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe('That would leave the owner with no way to sign in.');
  });

  it('keeps the status of any other sign-in refusal', async () => {
    app = await buildTestApp(createAuthUser('owner'));
    mockSplit.mockRejectedValue(new APIError('FORBIDDEN', { message: 'not yours' }));

    const response = await app.inject({
      method: 'POST',
      url: `/server-users/${randomUUID()}/split`,
    });

    expect(response.statusCode).toBe(403);
  });

  it('rejects non-owners', async () => {
    app = await buildTestApp(createAuthUser('admin'));

    const response = await app.inject({
      method: 'POST',
      url: `/server-users/${randomUUID()}/split`,
    });

    expect(response.statusCode).toBe(403);
    expect(mockSplit).not.toHaveBeenCalled();
  });
});
