/**
 * Owner account link routes tests
 *
 * GET/POST/DELETE /users/owner-links with the link service mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

vi.mock('../../../services/ownerAccountLink.js', () => ({
  getOwnerLinks: vi.fn(),
  linkOwnerAccount: vi.fn(),
  unlinkOwnerAccount: vi.fn(),
}));
vi.mock('../../../lib/sessionResolver.js', () => ({
  resolveBetterAuthSession: vi.fn(),
}));

import {
  getOwnerLinks,
  linkOwnerAccount,
  unlinkOwnerAccount,
} from '../../../services/ownerAccountLink.js';
import { resolveBetterAuthSession } from '../../../lib/sessionResolver.js';
import { MergeValidationError } from '../../../services/mergeService.js';
import { ServerUserNotFoundError } from '../../../services/userService.js';
import { ownerLinkRoutes } from '../ownerLinks.js';

const mockGetOwnerLinks = vi.mocked(getOwnerLinks);
const mockLink = vi.mocked(linkOwnerAccount);
const mockUnlink = vi.mocked(unlinkOwnerAccount);
const mockResolveSession = vi.mocked(resolveBetterAuthSession);

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
  await app.register(ownerLinkRoutes, { prefix: '/users' });
  return app;
}

describe('owner link routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it("lists the owner's links", async () => {
    const owner = createAuthUser('owner');
    app = await buildTestApp(owner);
    mockGetOwnerLinks.mockResolvedValue([]);

    const response = await app.inject({ method: 'GET', url: '/users/owner-links' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [] });
    expect(mockGetOwnerLinks).toHaveBeenCalledWith(owner.userId);
  });

  it('turns a refused link into a 400 and a missing account into a 404', async () => {
    app = await buildTestApp(createAuthUser('owner'));
    mockLink.mockRejectedValueOnce(new MergeValidationError('refused'));
    mockLink.mockRejectedValueOnce(new ServerUserNotFoundError(randomUUID()));
    const request = { method: 'POST' as const, url: '/users/owner-links' };

    const refused = await app.inject({ ...request, payload: { serverUserId: randomUUID() } });
    const missing = await app.inject({ ...request, payload: { serverUserId: randomUUID() } });

    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toBe('refused');
    expect(missing.statusCode).toBe(404);
  });

  it('keeps the requesting session when unlinking', async () => {
    const owner = createAuthUser('owner');
    app = await buildTestApp(owner);
    const serverUserId = randomUUID();
    mockResolveSession.mockResolvedValue({ user: owner, sessionId: 'session-1' });
    mockUnlink.mockResolvedValue({ newUserId: randomUUID(), serverUserId });

    const response = await app.inject({
      method: 'DELETE',
      url: `/users/owner-links/${serverUserId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(mockUnlink).toHaveBeenCalledWith(owner.userId, serverUserId, 'session-1');
  });

  it('rejects non-owners', async () => {
    app = await buildTestApp(createAuthUser('admin'));

    const response = await app.inject({
      method: 'POST',
      url: '/users/owner-links',
      payload: { serverUserId: randomUUID() },
    });

    expect(response.statusCode).toBe(403);
    expect(mockLink).not.toHaveBeenCalled();
  });
});
