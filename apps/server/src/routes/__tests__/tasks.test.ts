import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
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
import { getAllActiveLibrarySyncs } from '../../jobs/librarySyncQueue.js';
import { tasksRoutes } from '../tasks.js';
import { permissionGuard } from '../../lib/scope.js';

const owner: AuthUser = { userId: randomUUID(), username: 'admin', role: 'owner', serverIds: [] };
const createdAt = Date.parse('2026-11-14T12:00:00Z');

let app: FastifyInstance;

afterEach(async () => {
  await app.close();
});

async function runningTasks(): Promise<unknown[]> {
  app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: unknown) => {
    (request as { user: AuthUser }).user = owner;
  });
  app.decorate('requirePermission', permissionGuard(app));
  await app.register(tasksRoutes, { prefix: '/tasks' });
  const response = await app.inject({ method: 'GET', url: '/tasks/running' });
  return response.json().tasks;
}

function librarySync(state: string, firstSync: boolean, attemptsMade = 0) {
  return {
    jobId: 'sync-srv-1-a',
    serverId: 'srv-1',
    triggeredBy: 'scheduled' as const,
    state,
    progress: 0,
    createdAt,
    firstSync,
    attemptsMade,
  };
}

function tofaImport(jobId: string, state: string, held: boolean, attemptsMade = 0) {
  return {
    jobId,
    type: 'tofa' as const,
    serverId: 'srv-1',
    state,
    progress: 0,
    createdAt,
    held,
    attemptsMade,
  };
}

describe('GET /tasks/running', () => {
  beforeEach(() => {
    vi.mocked(getAllActiveImports).mockResolvedValue([]);
    vi.mocked(getAllActiveLibrarySyncs).mockResolvedValue([]);
  });

  it('names a tofa history import as tofa', async () => {
    vi.mocked(getAllActiveImports).mockResolvedValue([
      tofaImport('held-import-srv-1', 'delayed', true),
    ]);

    expect(await runningTasks()).toEqual([
      expect.objectContaining({ type: 'tofa_import', name: 'tofa Import', context: 'Den' }),
    ]);
  });

  it('lists a queued first sync and hides a queued change-event sync', async () => {
    vi.mocked(getAllActiveLibrarySyncs).mockResolvedValue([
      librarySync('waiting', true),
      { ...librarySync('waiting', false), jobId: 'sync-srv-1-b' },
    ]);

    expect(await runningTasks()).toEqual([
      expect.objectContaining({
        id: 'sync-srv-1-a',
        status: 'pending',
        message: 'Waiting to start',
      }),
    ]);
  });

  it('reads a first sync waiting after a failed attempt as retrying', async () => {
    vi.mocked(getAllActiveLibrarySyncs).mockResolvedValue([librarySync('delayed', true, 1)]);

    expect(await runningTasks()).toEqual([
      expect.objectContaining({ status: 'pending', message: 'Retrying after an error' }),
    ]);
  });

  it('reads an import waiting out a retry as retrying without its old progress', async () => {
    vi.mocked(getAllActiveImports).mockResolvedValue([
      { ...tofaImport('import-srv-1', 'delayed', false, 1), progress: 42 },
    ]);

    expect(await runningTasks()).toEqual([
      expect.objectContaining({
        status: 'pending',
        progress: null,
        message: 'Retrying after an error',
      }),
    ]);
  });

  it('reads a held import as waiting for the first library sync', async () => {
    vi.mocked(getAllActiveImports).mockResolvedValue([
      tofaImport('held-import-srv-1', 'delayed', true),
    ]);

    expect(await runningTasks()).toEqual([
      expect.objectContaining({
        status: 'waiting',
        progress: null,
        message: 'Waiting for the first library sync',
      }),
    ]);
  });

  it.each([
    ['playback-reporting', 'playback_reporting_import'],
    ['tautulli', 'tautulli_import'],
  ] as const)('reads a %s import held for the first sync as waiting for it', async (type, task) => {
    vi.mocked(getAllActiveImports).mockResolvedValue([
      { ...tofaImport('held-1', 'delayed', true), type },
    ]);

    expect(await runningTasks()).toEqual([
      expect.objectContaining({
        type: task,
        status: 'waiting',
        message: 'Waiting for the first library sync',
      }),
    ]);
  });

  it('reads a queued import at 0% as starting', async () => {
    vi.mocked(getAllActiveImports).mockResolvedValue([tofaImport('7', 'waiting', false)]);

    expect(await runningTasks()).toEqual([
      expect.objectContaining({ status: 'pending', progress: null, message: 'Starting import...' }),
    ]);
  });
});
