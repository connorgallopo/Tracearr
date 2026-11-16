import { describe, it, expect, vi, beforeEach } from 'vitest';
import { REDIS_KEYS } from '@tracearr/shared';

const {
  mockGetJobs,
  mockGetJob,
  mockAdd,
  mockInvalidatePattern,
  mockPublish,
  workerHandlers,
  worker,
} = vi.hoisted(() => ({
  mockGetJobs: vi.fn(),
  mockGetJob: vi.fn(),
  mockAdd: vi.fn(),
  mockInvalidatePattern: vi.fn(),
  mockPublish: vi.fn(),
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
  getPubSubService: () => ({ publish: mockPublish }),
}));
vi.mock('../../services/import/jellystatUpload.js', async (importActual) => ({
  JellystatUploadMissingError: (
    await importActual<typeof import('../../services/import/jellystatUpload.js')>()
  ).JellystatUploadMissingError,
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
vi.mock('../../services/import/tofaHistory.js', () => ({ importTofaHistory: vi.fn() }));

import { UnrecoverableError } from 'bullmq';
import { importPlaybackReporting } from '../../services/playbackReporting.js';
import { importTofaHistory } from '../../services/import/tofaHistory.js';
import { HttpClientError } from '../../utils/http.js';
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
  getLatestImport,
  initImportQueue,
  releaseHeldImport,
  startImportWorker,
} from '../importQueue.js';

initImportQueue('redis://localhost:6379');

beforeEach(() => {
  vi.clearAllMocks();
  mockGetJobs.mockResolvedValue([]);
  mockInvalidatePattern.mockResolvedValue(undefined);
  mockPublish.mockResolvedValue(undefined);
  vi.mocked(hasPendingFirstSync).mockResolvedValue(false);
});

function tofaJob(id: string, timestamp: number, state: string, returnvalue: unknown) {
  return {
    id,
    timestamp,
    data: { type: 'tofa', serverId: 'srv-1', userId: 'system' },
    opts: { attempts: 3 },
    attemptsMade: 0,
    progress: 0,
    returnvalue,
    failedReason: undefined as string | undefined,
    finishedOn: timestamp + 1000,
    getState: async () => state,
  };
}

describe('getLatestImport', () => {
  const rerun = { success: true, imported: 9, skipped: 0, duplicates: 0, errors: 0, message: 'ok' };

  it('describes the run the owner started after the held import failed', async () => {
    mockGetJobs.mockResolvedValue([
      {
        ...tofaJob('held-import-srv-1', 1_000, 'failed', undefined),
        failedReason: 'tofa user sync failed: unreachable',
      },
      tofaJob('42', 5_000, 'completed', rerun),
      { ...tofaJob('43', 9_000, 'completed', rerun), data: { type: 'tofa', serverId: 'srv-2' } },
      {
        ...tofaJob('44', 9_000, 'completed', rerun),
        data: { type: 'tautulli', serverId: 'srv-1' },
      },
    ]);

    expect(await getLatestImport('tofa', 'srv-1')).toMatchObject({
      held: false,
      state: 'completed',
      result: rerun,
    });
  });

  it('reads a result stored as success: false as the failure it reported', async () => {
    mockGetJobs.mockResolvedValue([
      tofaJob('42', 5_000, 'completed', {
        success: false,
        imported: 0,
        skipped: 0,
        duplicates: 0,
        errors: 0,
        message: 'Import failed: tofa answered 502',
      }),
    ]);

    expect(await getLatestImport('tofa', 'srv-1')).toMatchObject({
      state: 'completed',
      result: null,
      failedReason: 'Import failed: tofa answered 502',
    });
  });

  it('counts the attempts of an import waiting out a retry', async () => {
    mockGetJobs.mockResolvedValue([
      {
        ...tofaJob('42', 5_000, 'delayed', undefined),
        processedOn: 5_500,
        attemptsMade: 1,
        failedReason: 'tofa answered 502',
      },
    ]);

    expect(await getLatestImport('tofa', 'srv-1')).toMatchObject({
      held: false,
      state: 'delayed',
      attemptsMade: 1,
      attempts: 3,
      failedReason: 'tofa answered 502',
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
    ['tautulli', () => enqueueImport('srv-1', 'owner', false)],
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
    const heldTautulli = delayedJob('tt', {
      type: 'tautulli',
      serverId: 'srv-1',
      heldForFirstSync: true,
    });
    const backoff = delayedJob('js', { type: 'jellystat', serverId: 'srv-1' });
    const otherServer = delayedJob('pr-2', {
      type: 'playback-reporting',
      serverId: 'srv-2',
      heldForFirstSync: true,
    });
    const jobs = [heldPlays, heldTofa, heldTautulli, backoff, otherServer];
    mockGetJobs.mockResolvedValue(jobs);

    await releaseHeldImport('srv-1');

    expect(jobs.map((job) => job.promote.mock.calls.length)).toEqual([1, 1, 1, 0, 0]);
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

  const playbackJob = {
    id: 'job-1',
    data: { type: 'playback-reporting', serverId: 'srv-1', userId: 'owner' },
  };

  it.each([
    [
      'a rejected key',
      new HttpClientError({
        service: 'jellyfin',
        statusCode: 401,
        statusText: 'Unauthorized',
        url: '',
      }),
    ],
    ['an unreadable Tautulli answer', new Error('Invalid Tautulli API response: bad shape')],
  ])('fails an import at once for %s', async (_cause, error) => {
    startImportWorker();
    vi.mocked(importPlaybackReporting).mockRejectedValueOnce(error);

    await expect(worker.processor?.(playbackJob)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('leaves an unreachable server to the retries', async () => {
    startImportWorker();
    const unreachable = new Error('connect ECONNREFUSED');
    vi.mocked(importPlaybackReporting).mockRejectedValueOnce(unreachable);

    await expect(worker.processor?.(playbackJob)).rejects.toBe(unreachable);
  });

  it('completes a tofa import with the result it returned', async () => {
    startImportWorker();
    const result = {
      success: true,
      imported: 3,
      skipped: 1,
      duplicates: 1,
      errors: 0,
      message: 'ok',
    };
    vi.mocked(importTofaHistory).mockResolvedValueOnce(result as never);
    const job = {
      id: 'job-2',
      data: { type: 'tofa', serverId: 'srv-1', userId: 'owner' },
      updateProgress: vi.fn(),
    };

    expect(await worker.processor?.(job)).toBe(result);
    expect(mockPublish).toHaveBeenCalledWith(
      'import:tofa:progress',
      expect.objectContaining({
        serverId: 'srv-1',
        status: 'complete',
        importedRecords: 3,
        jobId: 'job-2',
      })
    );
  });

  it('keeps the progress of a Playback Reporting import on its job for the status read', async () => {
    startImportWorker();
    const progress = { status: 'processing', importedRecords: 4 };
    vi.mocked(importPlaybackReporting).mockImplementationOnce(
      async (_serverId, _options, _pubSub, onProgress) => {
        await onProgress?.(progress as never);
        return { success: true, imported: 4, skipped: 0, errors: 0, message: 'ok' } as never;
      }
    );
    const job = { ...playbackJob, data: { ...playbackJob.data }, updateProgress: vi.fn() };

    await worker.processor?.(job);

    expect(job.updateProgress).toHaveBeenCalledWith(progress);
  });

  it('names the server in the progress a Playback Reporting import closes with', async () => {
    startImportWorker();
    vi.mocked(importPlaybackReporting).mockResolvedValueOnce({
      success: true,
      imported: 4,
      skipped: 0,
      errors: 0,
      message: 'ok',
    } as never);

    await worker.processor?.({ ...playbackJob, updateProgress: vi.fn() });

    expect(mockPublish).toHaveBeenCalledWith(
      'import:playbackreporting:progress',
      expect.objectContaining({ serverId: 'srv-1', status: 'complete', jobId: 'job-1' })
    );
  });

  it('tells the panel an import is retrying, not failed, while attempts remain', () => {
    startImportWorker();

    workerHandlers.get('failed')?.(
      {
        id: 'job-1',
        attemptsMade: 1,
        opts: { attempts: 3 },
        data: { type: 'jellystat', serverId: 'srv-1', backupPath: '/tmp/backup.json' },
      },
      new Error('connect ECONNREFUSED')
    );

    expect(mockPublish).toHaveBeenCalledOnce();
    expect(mockPublish).toHaveBeenCalledWith(
      'import:jellystat:progress',
      expect.objectContaining({
        serverId: 'srv-1',
        status: 'retrying',
        retry: { attempt: 1, attempts: 3, reason: 'connect ECONNREFUSED' },
        jobId: 'job-1',
      })
    );
    expect(removeJellystatUpload).not.toHaveBeenCalled();
  });

  it('tells the panel an import failed once its last attempt fails, and moves it to the DLQ', () => {
    startImportWorker();

    workerHandlers.get('failed')?.(
      {
        id: 'job-1',
        attemptsMade: 3,
        opts: { attempts: 3 },
        data: { type: 'tautulli', serverId: 'srv-1' },
      },
      new Error('connect ECONNREFUSED')
    );

    expect(mockPublish).toHaveBeenCalledOnce();
    expect(mockPublish).toHaveBeenCalledWith(
      'import:progress',
      expect.objectContaining({
        serverId: 'srv-1',
        status: 'error',
        message: 'Import failed: connect ECONNREFUSED',
      })
    );
    expect(mockAdd).toHaveBeenCalledWith(
      'dlq-tautulli',
      expect.anything(),
      expect.objectContaining({ jobId: 'dlq-job-1' })
    );
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
    expect(mockPublish).toHaveBeenCalledWith(
      'import:jellystat:progress',
      expect.objectContaining({ status: 'error' })
    );
  });
});
