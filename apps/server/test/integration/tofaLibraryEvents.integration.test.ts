/**
 * tofa's socket reports every library change. Each asks for a delayed sync: the changes before
 * it runs ride on that one job, and changes while a sync runs earn exactly one sync after it.
 *
 * Run with: pnpm --filter @tracearr/server test:integration tofaLibraryEvents
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { REDIS_KEYS } from '@tracearr/shared';
import { createTestServer } from '@tracearr/test-utils/factories';
import {
  enqueueLibrarySync,
  enqueueLibrarySyncForChange,
  getAllActiveLibrarySyncs,
  initLibrarySyncQueue,
  obliterateLibrarySyncQueue,
  shutdownLibrarySyncQueue,
  startLibrarySyncWorker,
} from '../../src/jobs/librarySyncQueue.js';
import { librarySyncService, SYNC_STATE_TTL } from '../../src/services/librarySync.js';

vi.mock('../../src/jobs/precachePassPolicy.js', () => ({
  resolvePrecachePass: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/services/imageCacheSweep.js', () => ({ scheduleImageCacheSweep: vi.fn() }));

const DELAY_MS = 60_000;

async function syncsOf(serverId: string) {
  return (await getAllActiveLibrarySyncs()).filter((sync) => sync.serverId === serverId);
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let redis: Redis;

/** Starts a sync of the server that holds until the returned release is called */
async function runningSync(serverId: string): Promise<() => void> {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(librarySyncService, 'syncServer').mockImplementationOnce(async () => {
    await held;
    return [];
  });
  await enqueueLibrarySync(serverId, 'event');
  await until(
    async () => (await syncsOf(serverId)).some((sync) => sync.state === 'active'),
    'the sync to start'
  );
  return release;
}

describe('library changes reported on the tofa socket', () => {
  beforeAll(() => {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error('REDIS_URL is not set');
    redis = new Redis(redisUrl);
    initLibrarySyncQueue(redisUrl);
    startLibrarySyncWorker();
  });

  afterAll(async () => {
    await redis.quit();
    await obliterateLibrarySyncQueue();
    await shutdownLibrarySyncQueue();
  });

  it('queue one sync for three changes within the delay', async () => {
    const server = await createTestServer({ type: 'tofa' });

    await enqueueLibrarySyncForChange(server.id, DELAY_MS);
    await enqueueLibrarySyncForChange(server.id, DELAY_MS);
    await enqueueLibrarySyncForChange(server.id, DELAY_MS);

    expect(await syncsOf(server.id)).toHaveLength(1);
  });

  it.each([1, 3])(
    'queue exactly one more sync for %i change(s) during a running sync',
    async (changes) => {
      const server = await createTestServer({ type: 'tofa' });
      const release = await runningSync(server.id);

      for (let i = 0; i < changes; i++) await enqueueLibrarySyncForChange(server.id, DELAY_MS);
      release();

      await until(
        async () => (await syncsOf(server.id)).some((sync) => sync.state === 'delayed'),
        'the follow-up sync'
      );
      expect((await syncsOf(server.id)).map((sync) => sync.state)).toEqual(['delayed']);
    }
  );

  it('queue nothing more after a sync no change arrived during', async () => {
    const server = await createTestServer({ type: 'tofa' });
    const release = await runningSync(server.id);
    release();

    await until(async () => (await syncsOf(server.id)).length === 0, 'the sync to finish');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await syncsOf(server.id)).toEqual([]);
  });

  it('queue a sync for a change refused just before the running sync finished', async () => {
    const server = await createTestServer({ type: 'tofa' });
    const release = await runningSync(server.id);
    const getJob = Queue.prototype.getJob;
    vi.spyOn(Queue.prototype, 'getJob').mockImplementationOnce(async function (
      this: Queue,
      jobId: string
    ) {
      release();
      await until(async () => (await syncsOf(server.id)).length === 0, 'the sync to finish');
      return getJob.call(this, jobId);
    });

    await enqueueLibrarySyncForChange(server.id, DELAY_MS);

    expect((await syncsOf(server.id)).map((sync) => sync.state)).toEqual(['delayed']);
    expect(await redis.exists(REDIS_KEYS.LIBRARY_SYNC_CHANGED_DURING_RUN(server.id))).toBe(0);
  });

  it('mark a change during a running sync to expire with the other sync state', async () => {
    const server = await createTestServer({ type: 'tofa' });
    const release = await runningSync(server.id);

    await enqueueLibrarySyncForChange(server.id, DELAY_MS);

    const ttl = await redis.ttl(REDIS_KEYS.LIBRARY_SYNC_CHANGED_DURING_RUN(server.id));
    release();
    expect(ttl).toBeGreaterThan(SYNC_STATE_TTL - 60);
    expect(ttl).toBeLessThanOrEqual(SYNC_STATE_TTL);
  });
});
