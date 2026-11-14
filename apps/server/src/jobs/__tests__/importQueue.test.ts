import { describe, it, expect, vi } from 'vitest';

const { mockGetJobs } = vi.hoisted(() => ({ mockGetJobs: vi.fn() }));

vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function MockQueue() {
    return { getJobs: mockGetJobs, on: vi.fn() };
  }),
  Worker: vi.fn(),
  DelayedError: class DelayedError extends Error {},
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

import { getLatestTofaImport, initImportQueue } from '../importQueue.js';

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
    initImportQueue('redis://localhost:6379');
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
