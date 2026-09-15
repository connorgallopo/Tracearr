import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

vi.mock('../../services/whatsNew.js', () => ({
  getWhatsNewState: vi.fn(),
  dismissWhatsNew: vi.fn(),
}));

import { dismissWhatsNew, getWhatsNewState } from '../../services/whatsNew.js';
import { whatsNewRoutes } from '../whatsNew.js';

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: unknown) => {
    (request as { user: AuthUser }).user = authUser;
  });
  await app.register(whatsNewRoutes, { prefix: '/whats-new' });
  return app;
}

const owner: AuthUser = { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
const admin: AuthUser = { userId: randomUUID(), username: 'admin', role: 'admin', serverIds: [] };

describe('whats-new routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  it('returns state to the owner', async () => {
    vi.mocked(getWhatsNewState).mockResolvedValue({
      runningVersion: '2.3.0',
      lastSeenVersion: 'legacy',
    });
    app = await buildTestApp(owner);
    const response = await app.inject({ method: 'GET', url: '/whats-new' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ runningVersion: '2.3.0', lastSeenVersion: 'legacy' });
  });

  it('dismisses for the owner', async () => {
    vi.mocked(dismissWhatsNew).mockResolvedValue(undefined);
    app = await buildTestApp(owner);
    const response = await app.inject({ method: 'POST', url: '/whats-new/dismiss' });
    expect(response.statusCode).toBe(204);
    expect(dismissWhatsNew).toHaveBeenCalledOnce();
  });

  it('refuses anyone but the owner', async () => {
    app = await buildTestApp(admin);
    expect((await app.inject({ method: 'GET', url: '/whats-new' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/whats-new/dismiss' })).statusCode).toBe(403);
    expect(dismissWhatsNew).not.toHaveBeenCalled();
  });
});
