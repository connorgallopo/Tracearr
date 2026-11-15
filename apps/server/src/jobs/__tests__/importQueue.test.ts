import { describe, it, expect, vi, beforeEach } from 'vitest';
import { REDIS_KEYS } from '@tracearr/shared';

const { mockGetJobs, mockGetJob, mockAdd, mockInvalidatePattern, workerHandlers, worker } =
  vi.hoisted(() => ({
    mockGetJobs: vi.fn(),
    mockGetJob: vi.fn(),
    mockAdd: vi.fn(),
    mockInvalidatePattern: vi.fn(),
    workerHandlers: new Map<string, (...args: unknown[]) => void>(),
    worker: { processor: undefined as undefined | ((job: unknown) => Promise<unknown>) },
  }));

vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function MockQueue() {
    return { getJobs: mockGetJobs, getJob: mockGetJob, add: mockAdd, on: vi.fn() };
  }),
  Worker: vi.fn().mockImplementation(function MockWorker(
    _name: string,
    processor: (job: unknown) => Promise<unknown>
  ) {
    worker.processor = processor;
    return {
      on: (event: string, handler: (...args: unknown[]) => void) =>
        workerHandlers.set(event, handler),
      once: vi.fn(),
    };
  }),
  DelayedError: class DelayedError extends Error {},
  UnrecoverableError: class UnrecoverableError extends Error {},
}));
vi.mock('../../services/cache.js', () => ({
  getCacheService: () => ({ invalidatePattern: mockInvalidatePattern }),
  getPubSubService: () => null,
}));
vi.mock('../../services/import/jellystatUpload.js', () => ({
  sweepJellystatUploads: vi.fn(),
  removeJellystatUpload: vi.fn(),
}));
vi.mock('../heavyOpsLock.js', () => ({
  acquireHeavyOpsLock: vi.fn().mockResolvedValue(null),
  releaseHeavyOpsLock: vi.fn(),
  extendHeavyOpsLock: vi.fn(),
  startHeavyOpsLockHeartbeat: () => () => undefined,
  HEAVY_OPS_WAIT_INTERVAL_MS: 5000,
}));
vi.mock('../librarySyncQueue.js', () => ({ hasPendingFirstSync: vi.fn() }));
vi.mock('../../db/timescale.js', () => ({
  withSessionsCompressionPaused: (run: () => Promise<unknown>) => run(),
}));
vi.mock('../../services/playbackReporting.js', () => ({ importPlaybackReporting: vi.fn() }));

import { UnrecoverableError } from 'bullmq';
import { importPlaybackReporting } from '../../services/playbackReporting.js';
import { removeJellystatUpload } from '../../services/import/jellystatUpload.js';
import { hasPendingFirstSync } from '../librarySyncQueue.js';
import { ServerHistoricalError } from '../../services/liveServers.js';
import {
  dropHeldImport,
  enqueueImport,
  enqueueJellystatImport,
  enqueuePlaybackReportingImport,
  enqueueTofaImport,
  getAllActiveImports,
  getLatestTofaImport,
  initImportQueue,
  releaseHeldImport,
  startImportWorker,
} from '../importQueue.js';

initImportQueue('redis://localhost:6379');

beforeEach(() => {
  vi.clearAllMocks();
  mockGetJobs.mockResolvedValue([]);
  mockInvalidatePattern.mockResolvedValue(undefined);
  vi.mocked(hasPendingFirstSync).mockResolvedValue(false);
});

function tofaJob(id: string, timestamp: number, state: string, returnvalue: unknown) {
  return {
    id,
    timestamp,
    data: { type: 'tofa', serverId: 'srv-1', userId: 'system' },
    progress: 0,
    returnvalue,
    failedReason: undefined,
    finishedOn: timestamp + 1000,
    getState: async () => state,
  };
}

describe('getLatestTofaImport', () => {
  it('describes the run the owner started after the held import failed', async () => {
    const rerun = {
      success: true,
      imported: 9,
      skipped: 0,
      duplicates: 0,
      errors: 0,
      message: 'ok',
    };
    mockGetJobs.mockResolvedValue([
      tofaJob('held-import-srv-1', 1_000, 'completed', {
        success: false,
        imported: 0,
        skipped: 0,
        duplicates: 0,
        errors: 0,
        message: 'Import failed: tofa user sync failed: unreachable',
      }),
      tofaJob('42', 5_000, 'completed', rerun),
      { ...tofaJob('43', 9_000, 'completed', rerun), data: { type: 'tofa', serverId: 'srv-2' } },
    ]);

    expect(await getLatestTofaImport('srv-1')).toMatchObject({
      held: false,
      state: 'completed',
      result: rerun,
    });
  });
});

describe('import enqueues', () => {
  const starts = [
    ['tautulli', () => enqueueImport('srv-1', 'owner', false)],
    ['jellystat', () => enqueueJellystatImport('srv-1', 'owner', '/tmp/backup.json')],
    [
      'playback-reporting',
      () => enqueuePlaybackReportingImport('srv-1', 'owner', 'UTC', false, false),
    ],
    ['tofa', () => enqueueTofaImport('srv-1', 'owner')],
  ] as const;

  it.each(starts)('adds a %s import with one deduplication key per server', async (type, start) => {
    mockAdd.mockImplementation(async (_name: string, _data: unknown, opts: { jobId: string }) => ({
      id: opts.jobId,
    }));

    const jobId = await start();

    const key = `${type}-import-srv-1`;
    expect(mockAdd).toHaveBeenCalledWith(
      `${type}-import`,
      expect.objectContaining({ type, serverId: 'srv-1' }),
      expect.objectContaining({ deduplication: { id: key } })
    );
    expect(jobId.startsWith(`${key}-`)).toBe(true);
  });

  it.each(starts)('refuses a %s import Redis already holds one for', async (_type, start) => {
    mockAdd.mockResolvedValue({ id: 'running-job' });

    await expect(start()).rejects.toThrow(
      'Import already in progress for server srv-1 (job running-job)'
    );
  });
});

describe('imports that wait for a first library sync', () => {
  const libraryKeyedStarts = [
    ['jellystat', () => enqueueJellystatImport('srv-1', 'owner', '/tmp/backup.json')],
    [
      'playback-reporting',
      () => enqueuePlaybackReportingImport('srv-1', 'owner', 'UTC', false, false),
    ],
  ] as const;

  function delayedJob(id: string, data: Record<string, unknown>) {
    return {
      id,
      data,
      isDelayed: async () => true,
      promote: vi.fn(),
      getState: async () => 'delayed',
    };
  }

  beforeEach(() => {
    mockAdd.mockImplementation(async (_name: string, _data: unknown, opts: { jobId: string }) => ({
      id: opts.jobId,
    }));
  });

  it.each(libraryKeyedStarts)(
    'holds a %s import while the first sync is pending',
    async (type, start) => {
      vi.mocked(hasPendingFirstSync).mockResolvedValue(true);

      await start();

      expect(mockAdd).toHaveBeenCalledWith(
        `${type}-import`,
        expect.objectContaining({ heldForFirstSync: true }),
        expect.objectContaining({ delay: 24 * 60 * 60 * 1000 })
      );
      expect(mockGetJob).not.toHaveBeenCalled();
    }
  );

  it.each(libraryKeyedStarts)(
    'adds a %s import at once when no first sync is pending',
    async (type, start) => {
      vi.mocked(hasPendingFirstSync).mockResolvedValue(false);

      await start();

      expect(mockAdd).toHaveBeenCalledWith(
        `${type}-import`,
        expect.not.objectContaining({ heldForFirstSync: true }),
        expect.not.objectContaining({ delay: expect.anything() })
      );
    }
  );

  it('runs a held import at once when the first sync completed while it was being added', async () => {
    vi.mocked(hasPendingFirstSync).mockResolvedValueOnce(true).mockResolvedValue(false);
    const held = delayedJob('held', { type: 'playback-reporting', serverId: 'srv-1' });
    mockGetJob.mockResolvedValue(held);

    await enqueuePlaybackReportingImport('srv-1', 'owner', 'UTC', false, false);

    expect(held.promote).toHaveBeenCalledOnce();
  });

  it('releases the held imports of the synced server and leaves a retry backoff alone', async () => {
    const heldPlays = delayedJob('pr', {
      type: 'playback-reporting',
      serverId: 'srv-1',
      heldForFirstSync: true,
    });
    const heldTofa = delayedJob('held-import-srv-1', { type: 'tofa', serverId: 'srv-1' });
    const backoff = delayedJob('js', { type: 'jellystat', serverId: 'srv-1' });
    const otherServer = delayedJob('pr-2', {
      type: 'playback-reporting',
      serverId: 'srv-2',
      heldForFirstSync: true,
    });
    mockGetJobs.mockResolvedValue([heldPlays, heldTofa, backoff, otherServer]);

    await releaseHeldImport('srv-1');

    expect(
      [heldPlays, heldTofa, backoff, otherServer].map((job) => job.promote.mock.calls.length)
    ).toEqual([1, 1, 0, 0]);
  });

  it('lists an import held for the first sync as held', async () => {
    mockGetJobs.mockResolvedValue([
      delayedJob('pr', { type: 'playback-reporting', serverId: 'srv-1', heldForFirstSync: true }),
    ]);

    expect(await getAllActiveImports()).toEqual([expect.objectContaining({ held: true })]);
  });

  it('treats a held import that started and went back to delayed as no longer held', async () => {
    const retrying = {
      ...delayedJob('pr', {
        type: 'playback-reporting',
        serverId: 'srv-1',
        heldForFirstSync: true,
      }),
      processedOn: 1_000,
    };
    mockGetJobs.mockResolvedValue([retrying]);

    await releaseHeldImport('srv-1');

    expect(retrying.promote).not.toHaveBeenCalled();
    expect(await getAllActiveImports()).toEqual([expect.objectContaining({ held: false })]);
  });

  it('drops a once-held import waiting out a retry when its server goes away', async () => {
    const retrying = {
      ...delayedJob('pr', {
        type: 'playback-reporting',
        serverId: 'srv-1',
        heldForFirstSync: true,
      }),
      processedOn: 1_000,
      remove: vi.fn(),
    };
    const owned = {
      ...delayedJob('own', { type: 'playback-reporting', serverId: 'srv-1' }),
      remove: vi.fn(),
    };
    mockGetJobs.mockResolvedValue([retrying, owned]);

    await dropHeldImport('srv-1');

    expect(retrying.remove).toHaveBeenCalledOnce();
    expect(owned.remove).not.toHaveBeenCalled();
  });
});

describe('import worker', () => {
  it('clears the cached history totals when an import completes', () => {
    startImportWorker();

    workerHandlers.get('completed')?.({ id: 'job-1', data: { type: 'playback-reporting' } });

    expect(mockInvalidatePattern).toHaveBeenCalledWith(REDIS_KEYS.HISTORY_AGGREGATES('*'));
  });

  it('fails an import of a server made historical once, without retrying it', async () => {
    startImportWorker();
    vi.mocked(importPlaybackReporting).mockRejectedValueOnce(new ServerHistoricalError('srv-1'));
    const job = {
      id: 'job-1',
      data: { type: 'playback-reporting', serverId: 'srv-1', userId: 'owner' },
    };

    await expect(worker.processor?.(job)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('removes the upload and skips the dead letter queue for an unrecoverable failure', () => {
    startImportWorker();

    workerHandlers.get('failed')?.(
      {
        id: 'job-1',
        attemptsMade: 1,
        opts: { attempts: 3 },
        data: { type: 'jellystat', serverId: 'srv-1', backupPath: '/tmp/backup.json' },
      },
      new UnrecoverableError('Server srv-1 is historical')
    );

    expect(removeJellystatUpload).toHaveBeenCalledWith('/tmp/backup.json');
    expect(mockAdd).not.toHaveBeenCalled();
  });
});
