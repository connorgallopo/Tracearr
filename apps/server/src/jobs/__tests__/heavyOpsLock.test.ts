/** Heavy Ops Lock Tests - proves the heartbeat-backed short TTL fixes the crash-orphan regression from 71e5922d. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import {
  initHeavyOpsLock,
  acquireHeavyOpsLock,
  releaseHeavyOpsLock,
  extendHeavyOpsLock,
  getHeavyOpsStatus,
  startHeavyOpsLockHeartbeat,
  isImportWaiting,
  HEAVY_OPS_HEARTBEAT_INTERVAL_MS,
  HEAVY_OPS_WAIT_INTERVAL_MS,
} from '../heavyOpsLock.js';

/** Minimal in-memory Redis stand-in with real TTL semantics (get/set/expire/del + NX/EX). */
function createFakeRedis(): Redis {
  const store = new Map<string, { value: string; expiresAt: number | null }>();

  function isLive(key: string): boolean {
    const entry = store.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return false;
    }
    return true;
  }

  return {
    get: vi.fn(async (key: string) => (isLive(key) ? store.get(key)!.value : null)),
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      const nx = args.includes('NX');
      if (nx && isLive(key)) return null;
      const exIndex = args.indexOf('EX');
      const ttlSeconds = exIndex !== -1 ? Number(args[exIndex + 1]) : null;
      store.set(key, {
        value,
        expiresAt: ttlSeconds !== null ? Date.now() + ttlSeconds * 1000 : null,
      });
      return 'OK';
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      if (!isLive(key)) return 0;
      store.get(key)!.expiresAt = Date.now() + seconds * 1000;
      return 1;
    }),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
    // Mirrors RELEASE_SCRIPT/EXTEND_SCRIPT/REACQUIRE_SCRIPT from heavyOpsLock.ts against this
    // same in-memory store, since there's no real Lua interpreter here to run the actual scripts.
    eval: vi.fn(async (script: string, _numKeys: number, ...rest: unknown[]) => {
      const key = rest[0] as string;

      if (script.includes('EXPIRE')) {
        const jobId = rest[1] as string;
        const runToken = String(rest[2] ?? '');
        const ttl = Number(rest[3]);
        if (!isLive(key)) return 0;
        let holder: { jobId: string; runToken: string };
        try {
          holder = JSON.parse(store.get(key)!.value);
        } catch {
          return 0;
        }
        if (holder.jobId !== jobId) return 0;
        if (runToken !== '' && holder.runToken !== runToken) return 0;
        store.get(key)!.expiresAt = Date.now() + ttl * 1000;
        return 1;
      }

      if (script.includes('holder.runToken == ARGV[2]')) {
        const jobId = rest[1] as string;
        const runToken = rest[2] as string;
        const newValue = rest[3] as string;
        const ttl = Number(rest[4]);
        if (!isLive(key)) return [2, ''];
        const raw = store.get(key)!.value;
        let holder: { jobId: string; runToken: string };
        try {
          holder = JSON.parse(raw);
        } catch {
          store.delete(key);
          return [3, ''];
        }
        if (holder.jobId === jobId && holder.runToken === runToken) {
          store.set(key, { value: newValue, expiresAt: Date.now() + ttl * 1000 });
          return [1, ''];
        }
        return [0, raw];
      }

      const jobId = rest[1] as string;
      if (!isLive(key)) return [2, ''];
      let holder: { jobId: string };
      try {
        holder = JSON.parse(store.get(key)!.value);
      } catch {
        store.delete(key);
        return [1, ''];
      }
      if (holder.jobId !== jobId) return [0, holder.jobId];
      store.delete(key);
      return [1, ''];
    }),
  } as unknown as Redis;
}

describe('heavyOpsLock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a live holder renews the lock via its heartbeat and never lets it expire', async () => {
    const redis = createFakeRedis();
    await initHeavyOpsLock(redis);

    const acquireResult = await acquireHeavyOpsLock('maintenance', 'job-1', 'Test job', 'run-a');
    expect(acquireResult).toBeNull();

    const stopHeartbeat = startHeavyOpsLockHeartbeat('job-1', 'run-a');
    try {
      // Well past the old 4-hour safety-net TTL and many heartbeat intervals.
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(HEAVY_OPS_HEARTBEAT_INTERVAL_MS);
      }

      const status = await getHeavyOpsStatus();
      expect(status?.jobId).toBe('job-1');
    } finally {
      stopHeartbeat();
    }
  });

  it("a crashed holder's lock expires within the short TTL, letting a stalled retry of the same job proceed", async () => {
    const redis = createFakeRedis();
    await initHeavyOpsLock(redis);

    // First run acquires the lock, then "crashes" - no heartbeat, no release.
    const firstAcquire = await acquireHeavyOpsLock('maintenance', 'job-1', 'Test job', 'run-a');
    expect(firstAcquire).toBeNull();

    // Same job.id, fresh runToken (a new process) - must not reacquire the dead holder's lock.
    const blockedRetry = await acquireHeavyOpsLock('maintenance', 'job-1', 'Test job', 'run-b');
    expect(blockedRetry).not.toBeNull();
    expect(blockedRetry?.runToken).toBe('run-a');

    // No heartbeat renewing it, so the crashed holder's lock must expire within the new short TTL.
    await vi.advanceTimersByTimeAsync(HEAVY_OPS_HEARTBEAT_INTERVAL_MS * 5);

    const retryAfterExpiry = await acquireHeavyOpsLock('maintenance', 'job-1', 'Test job', 'run-b');
    expect(retryAfterExpiry).toBeNull();
  });

  it('reacquires the lock atomically for the same run, refreshing description and TTL', async () => {
    const redis = createFakeRedis();
    await initHeavyOpsLock(redis);

    const first = await acquireHeavyOpsLock('maintenance', 'job-1', 'First pass', 'run-a');
    expect(first).toBeNull();

    const second = await acquireHeavyOpsLock('maintenance', 'job-1', 'Second pass', 'run-a');
    expect(second).toBeNull();

    const status = await getHeavyOpsStatus();
    expect(status?.jobId).toBe('job-1');
    expect(status?.runToken).toBe('run-a');
    expect(status?.description).toBe('Second pass');
  });

  it('stops renewing once the heartbeat is stopped, so a released lock stays released', async () => {
    const redis = createFakeRedis();
    await initHeavyOpsLock(redis);

    await acquireHeavyOpsLock('maintenance', 'job-1', 'Test job', 'run-a');
    const stopHeartbeat = startHeavyOpsLockHeartbeat('job-1', 'run-a');
    await vi.advanceTimersByTimeAsync(HEAVY_OPS_HEARTBEAT_INTERVAL_MS);
    stopHeartbeat();

    await redis.del('tracearr:heavy-ops:lock');

    // Nothing should resurrect the key - advance well past the TTL to be sure.
    await vi.advanceTimersByTimeAsync(HEAVY_OPS_HEARTBEAT_INTERVAL_MS * 10);

    const status = await getHeavyOpsStatus();
    expect(status).toBeNull();
  });

  it("a stalled run's zombie heartbeat cannot renew a lock its own retry now holds", async () => {
    const redis = createFakeRedis();
    await initHeavyOpsLock(redis);

    // Run A acquires and starts heartbeating, then stalls (no more real extends).
    const firstAcquire = await acquireHeavyOpsLock('maintenance', 'job-1', 'Test job', 'run-a');
    expect(firstAcquire).toBeNull();

    // A's lock expires with nobody renewing it (A's process is stuck, not calling extend).
    await vi.advanceTimersByTimeAsync(HEAVY_OPS_HEARTBEAT_INTERVAL_MS * 5);

    // B is the BullMQ retry of the same job.id, picked up once A's key is gone.
    const bAcquire = await acquireHeavyOpsLock('maintenance', 'job-1', 'Test job', 'run-b');
    expect(bAcquire).toBeNull();

    // A's zombie heartbeat fires late with its own (now stale) runToken.
    const staleExtend = await extendHeavyOpsLock('job-1', 'run-a');
    expect(staleExtend).toBe(false);

    // B's lock must be untouched by A's stale extend.
    const status = await getHeavyOpsStatus();
    expect(status?.runToken).toBe('run-b');
  });

  it('retries SET NX when the holder disappears between the failed SET and the reacquire eval', async () => {
    const redis = createFakeRedis();
    await initHeavyOpsLock(redis);

    await redis.set(
      'tracearr:heavy-ops:lock',
      JSON.stringify({
        jobType: 'maintenance',
        jobId: 'ghost',
        description: 'ghost hold',
        startedAt: new Date().toISOString(),
        runToken: 'ghost',
      }),
      'EX',
      240,
      'NX'
    );

    // Simulates another process's release landing in the exact gap between our failed
    // SET NX and the reacquire eval call, rather than mocking away real store state.
    const originalEval = redis.eval;
    vi.spyOn(redis, 'eval').mockImplementationOnce(async (...args) => {
      await redis.del('tracearr:heavy-ops:lock');
      return (originalEval as (...a: unknown[]) => Promise<unknown>)(...args);
    });

    const result = await acquireHeavyOpsLock('maintenance', 'job-1', 'Test job', 'run-a');
    expect(result).toBeNull();

    const status = await getHeavyOpsStatus();
    expect(status?.jobId).toBe('job-1');
  });

  it('retries SET NX after cleaning up corrupt lock data instead of reporting acquired without writing a key', async () => {
    const redis = createFakeRedis();
    await initHeavyOpsLock(redis);
    await redis.set('tracearr:heavy-ops:lock', 'not-json{{{', 'EX', 240);

    const result = await acquireHeavyOpsLock('maintenance', 'job-1', 'Test job', 'run-a');
    expect(result).toBeNull();

    const status = await getHeavyOpsStatus();
    expect(status?.jobId).toBe('job-1');
  });

  it('reports blocked, not acquired, if the race keeps repeating past the retry bound', async () => {
    const redis = createFakeRedis();
    await initHeavyOpsLock(redis);

    vi.spyOn(redis, 'set').mockImplementation(async () => null as never);
    vi.spyOn(redis, 'get').mockImplementation(async () => null);

    const result = await acquireHeavyOpsLock('maintenance', 'job-1', 'Test job', 'run-a');
    expect(result).not.toBeNull();
    expect(result?.jobId).not.toBe('job-1');
  });

  it('release is atomic: a mismatched jobId does not delete the current holder', async () => {
    const redis = createFakeRedis();
    await initHeavyOpsLock(redis);
    await acquireHeavyOpsLock('maintenance', 'job-1', 'Test job', 'run-a');

    const released = await releaseHeavyOpsLock('job-2');
    expect(released).toBe(false);

    const status = await getHeavyOpsStatus();
    expect(status?.jobId).toBe('job-1');
  });

  it('release clears corrupt lock data unconditionally, same as the old non-atomic path', async () => {
    const redis = createFakeRedis();
    await initHeavyOpsLock(redis);
    await redis.set('tracearr:heavy-ops:lock', 'not-json{{{', 'EX', 240);

    const released = await releaseHeavyOpsLock('any-job');
    expect(released).toBe(true);

    const status = await getHeavyOpsStatus();
    expect(status).toBeNull();
  });

  it('release on an already-gone lock returns true without deleting anything', async () => {
    const redis = createFakeRedis();
    await initHeavyOpsLock(redis);

    const released = await releaseHeavyOpsLock('job-1');
    expect(released).toBe(true);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("extend is atomic: a mismatched jobId does not renew someone else's lock", async () => {
    const redis = createFakeRedis();
    await initHeavyOpsLock(redis);
    await acquireHeavyOpsLock('maintenance', 'job-1', 'Test job', 'run-a');

    const extended = await extendHeavyOpsLock('job-2');
    expect(extended).toBe(false);
  });

  it('marks an import that loses the lock as waiting until it takes the lock', async () => {
    await initHeavyOpsLock(createFakeRedis());
    await acquireHeavyOpsLock('maintenance', 'backfill', 'Backfill', 'run-a');

    await acquireHeavyOpsLock('maintenance', 'normalize', 'Normalize', 'run-b');
    const afterMaintenanceLost = await isImportWaiting();
    await acquireHeavyOpsLock('import', 'import-1', 'Import', 'run-c');
    const afterImportLost = await isImportWaiting();
    await releaseHeavyOpsLock('backfill');
    await acquireHeavyOpsLock('import', 'import-1', 'Import', 'run-c');

    expect([afterMaintenanceLost, afterImportLost, await isImportWaiting()]).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('keeps another import waiting when one import takes the lock', async () => {
    await initHeavyOpsLock(createFakeRedis());
    await acquireHeavyOpsLock('maintenance', 'backfill', 'Backfill', 'run-a');
    await acquireHeavyOpsLock('import', 'import-1', 'Import', 'run-b');
    await acquireHeavyOpsLock('import', 'import-2', 'Import', 'run-c');
    await releaseHeavyOpsLock('backfill');

    await acquireHeavyOpsLock('import', 'import-1', 'Import', 'run-b');

    expect(await isImportWaiting()).toBe(true);
  });

  it('no longer counts an import that stopped trying the lock a few tries ago', async () => {
    await initHeavyOpsLock(createFakeRedis());
    await acquireHeavyOpsLock('maintenance', 'backfill', 'Backfill', 'run-a');
    await acquireHeavyOpsLock('import', 'import-1', 'Import', 'run-b');

    await vi.advanceTimersByTimeAsync(HEAVY_OPS_WAIT_INTERVAL_MS);
    const betweenTries = await isImportWaiting();
    await vi.advanceTimersByTimeAsync(HEAVY_OPS_WAIT_INTERVAL_MS * 2);

    expect([betweenTries, await isImportWaiting()]).toEqual([true, false]);
  });
});
