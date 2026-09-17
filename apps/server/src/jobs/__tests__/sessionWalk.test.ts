/**
 * sessionWalk tests
 *
 * The chunk-window walk shared by the session maintenance jobs: failing
 * windows bisect down to day leaves, a systemic fault aborts, a lost lock is
 * never swallowed as a failed range, and the window list follows the sessions
 * hypertable's chunks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db/timescale.js', () => ({
  getTimescaleStatus: vi.fn(),
  getSessionChunkRanges: vi.fn(),
}));

import { getSessionChunkRanges, getTimescaleStatus } from '../../db/timescale.js';
import { drainWindowsWithBisection, sessionWalkWindows } from '../sessionWalk.js';

const OPTS = { batchSize: 5000, label: 'Test' };

function window(start: string, end: string) {
  return { start: new Date(start), end: new Date(end) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('drainWindowsWithBisection', () => {
  it('bisects a failing window down to the day that fails and records only that range', async () => {
    const badStart = new Date('2026-02-03T00:00:00Z');
    const badEnd = new Date('2026-02-04T00:00:00Z');
    const runBatch = vi.fn(async (w: { start: Date; end: Date } | null) => {
      if (w && w.start < badEnd && w.end > badStart) {
        throw new Error('tuple decompression limit exceeded');
      }
      return { count: 0, oldest: null };
    });

    const result = await drainWindowsWithBisection(
      [window('2026-02-01T00:00:00Z', '2026-02-09T00:00:00Z')],
      runBatch,
      OPTS
    );

    expect(result.failedRanges).toEqual(['2026-02-03T00:00:00.000Z → 2026-02-04T00:00:00.000Z']);
    expect(runBatch.mock.calls.map((c) => c[0])).toEqual([
      window('2026-02-01T00:00:00Z', '2026-02-09T00:00:00Z'),
      window('2026-02-01T00:00:00Z', '2026-02-05T00:00:00Z'),
      window('2026-02-01T00:00:00Z', '2026-02-03T00:00:00Z'),
      window('2026-02-03T00:00:00Z', '2026-02-05T00:00:00Z'),
      window('2026-02-03T00:00:00Z', '2026-02-04T00:00:00Z'),
      window('2026-02-04T00:00:00Z', '2026-02-05T00:00:00Z'),
      window('2026-02-05T00:00:00Z', '2026-02-09T00:00:00Z'),
    ]);
  });

  it('aborts once enough ranges have failed to rule out per-chunk decompression', async () => {
    const windows = Array.from({ length: 45 }, (_, i) => ({
      start: new Date(Date.UTC(2026, 0, i + 1)),
      end: new Date(Date.UTC(2026, 0, i + 2)),
    }));
    const runBatch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:5432'));

    await expect(drainWindowsWithBisection(windows, runBatch, OPTS)).rejects.toThrow(
      /^Aborting walk: 40 failed ranges - this looks like a systemic fault/
    );
    expect(runBatch).toHaveBeenCalledTimes(40);
  });

  it('aborts when onBatch rejects instead of recording a failed range', async () => {
    const runBatch = vi.fn().mockResolvedValue({ count: 0, oldest: null });

    await expect(
      drainWindowsWithBisection(
        [window('2026-02-01T00:00:00Z', '2026-02-08T00:00:00Z')],
        runBatch,
        {
          ...OPTS,
          onBatch: async () => {
            throw new Error('Lost lock for maintenance job 42');
          },
        }
      )
    ).rejects.toThrow('Lost lock for maintenance job 42');
    expect(runBatch).toHaveBeenCalledTimes(1);
  });
});

describe('sessionWalkWindows', () => {
  const status = {
    extensionInstalled: true,
    sessionsIsHypertable: true,
    compressionEnabled: true,
    continuousAggregates: [],
    chunkCount: 3,
  };

  it('drops chunk windows that end at or before minStart', async () => {
    vi.mocked(getTimescaleStatus).mockResolvedValue(status);
    vi.mocked(getSessionChunkRanges).mockResolvedValue([
      window('2026-03-01T00:00:00Z', '2026-03-31T00:00:00Z'),
      window('2026-01-30T00:00:00Z', '2026-03-01T00:00:00Z'),
      window('2025-12-31T00:00:00Z', '2026-01-30T00:00:00Z'),
    ]);

    await expect(sessionWalkWindows(new Date('2026-03-01T00:00:00Z'))).resolves.toEqual([
      window('2026-03-01T00:00:00Z', '2026-03-31T00:00:00Z'),
    ]);
  });

  it('returns null when sessions is not a hypertable', async () => {
    vi.mocked(getTimescaleStatus).mockResolvedValue({ ...status, sessionsIsHypertable: false });

    await expect(sessionWalkWindows(null)).resolves.toBeNull();
    expect(getSessionChunkRanges).not.toHaveBeenCalled();
  });
});
