import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ name: 'Den' }] }) }),
    }),
  },
}));
vi.mock('../../jobs/importQueue.js', () => ({
  getAllActiveImports: vi.fn(),
  getActiveImportProgress: vi.fn(() => null),
}));
vi.mock('../../jobs/imagePrecacheQueue.js', () => ({
  getAllActiveImagePrecacheJobs: vi.fn(async () => []),
}));
vi.mock('../../jobs/librarySyncQueue.js', () => ({
  getAllActiveLibrarySyncs: vi.fn(async () => []),
}));
vi.mock('../../jobs/maintenanceQueue.js', () => ({
  getMaintenanceProgress: vi.fn(() => null),
  getAllActiveMaintenanceJobs: vi.fn(async () => []),
}));

import { getAllActiveImports } from '../../jobs/importQueue.js';
import { tasksRoutes } from '../tasks.js';
import { permissionGuard } from '../../lib/scope.js';

const owner: AuthUser = { userId: randomUUID(), username: 'admin', role: 'owner', serverIds: [] };

let app: FastifyInstance;

afterEach(async () => {
  await app.close();
});

describe('GET /tasks/running', () => {
  it('names a tofa history import as tofa', async () => {
    vi.mocked(getAllActiveImports).mockResolvedValue([
      {
        jobId: 'held-import-srv-1',
        type: 'tofa',
        serverId: 'srv-1',
        state: 'delayed',
        progress: 0,
        createdAt: Date.parse('2026-11-14T12:00:00Z'),
      },
    ]);
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: unknown) => {
      (request as { user: AuthUser }).user = owner;
    });
    app.decorate('requirePermission', permissionGuard(app));
    await app.register(tasksRoutes, { prefix: '/tasks' });

    const response = await app.inject({ method: 'GET', url: '/tasks/running' });

    expect(response.json().tasks).toEqual([
      expect.objectContaining({ type: 'tofa_import', name: 'tofa Import', context: 'Den' }),
    ]);
  });
});
