/**
 * Maintenance normalizers reach rows in compressed chunks.
 *
 * Run with: pnpm --filter @tracearr/server test:integration normalizeCompressed
 */

import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { executeRawSql } from '@tracearr/test-utils/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { sessions } from '../../src/db/schema.js';
import {
  processNormalizeCodecsJob,
  processNormalizePlayersJob,
  type MaintenanceJobData,
} from '../../src/jobs/maintenanceQueue.js';
import { sessionWalkWindows } from '../../src/jobs/sessionWalk.js';
import { normalizeWalk } from '../../src/jobs/sessionNormalize.js';
import { compressSessionChunks } from '../../src/test/compressChunks.js';

vi.mock('../../src/jobs/sessionWalk.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/jobs/sessionWalk.js')>();
  return { ...original, sessionWalkWindows: vi.fn(original.sessionWalkWindows) };
});

const DAY_MS = 24 * 60 * 60 * 1000;

function fakeJob(type: MaintenanceJobData['type']): Job<MaintenanceJobData> {
  return {
    id: `test-${type}`,
    token: 'test-token',
    data: { type, userId: 'owner' },
    updateProgress: async () => undefined,
    extendLock: async () => 1,
  } as unknown as Job<MaintenanceJobData>;
}

async function seedAccount() {
  const server = await createTestServer({ type: 'plex' });
  const user = await createTestUser({ role: 'member' });
  const serverUser = await createTestServerUser({ userId: user.id, serverId: server.id });
  return { serverId: server.id, serverUserId: serverUser.id };
}

describe('maintenance normalizers over compressed chunks', () => {
  it('normalizes players in a compressed chunk and in the current one', async () => {
    const account = await seedAccount();
    const old = await createTestSession({
      ...account,
      startedAt: new Date(Date.now() - 70 * DAY_MS),
      product: 'Plex for Android',
      platform: 'android',
    });
    const recent = await createTestSession({
      ...account,
      product: 'Plex for Android',
      platform: 'android',
    });
    await executeRawSql(
      `UPDATE sessions SET device = 'stale', platform = 'android' WHERE id IN ('${old.id}', '${recent.id}')`
    );
    expect((await compressSessionChunks(7)).length).toBeGreaterThan(0);

    const result = await processNormalizePlayersJob(fakeJob('normalize_players'));

    expect(result.updated).toBe(2);
    const rows = await db.select({ device: sessions.device }).from(sessions);
    expect(rows.map((r) => r.device)).not.toContain('stale');
    const [oldRow] = await db.select().from(sessions).where(eq(sessions.id, old.id));
    expect(oldRow?.platform).toBe('Android');
  });

  it('uppercases codecs in a compressed chunk', async () => {
    const account = await seedAccount();
    const old = await createTestSession({
      ...account,
      startedAt: new Date(Date.now() - 70 * DAY_MS),
    });
    await executeRawSql(
      `UPDATE sessions SET source_video_codec = 'h264', stream_audio_codec = 'aac' WHERE id = '${old.id}'`
    );
    expect((await compressSessionChunks(7)).length).toBeGreaterThan(0);

    const result = await processNormalizeCodecsJob(fakeJob('normalize_codecs'));

    expect(result.updated).toBe(1);
    expect(result.errors).toBe(0);
    const [row] = await db.select().from(sessions).where(eq(sessions.id, old.id));
    expect(row?.sourceVideoCodec).toBe('H264');
    expect(row?.streamAudioCodec).toBe('AAC');
  });

  describe('normalizeWalk', () => {
    const walkOptions = {
      label: 'Test',
      select: sql`s.product, s.device`,
      where: sql`s.product IS NOT NULL`,
      columns: [{ name: 'device', type: 'text' }],
      onBatch: async () => undefined,
    };

    async function seedRows(products: string[]) {
      const account = await seedAccount();
      const base = Date.now() - 3 * DAY_MS;
      for (const [i, product] of products.entries()) {
        await createTestSession({
          ...account,
          startedAt: new Date(base + i * 60_000),
          product,
          device: 'unset',
        });
      }
    }

    it('counts a row whose plan throws as one error and updates the rest of its batch', async () => {
      await seedRows(['a', 'boom', 'c']);

      const result = await normalizeWalk({
        ...walkOptions,
        plan: (row: { product: string }) => {
          if (row.product === 'boom') throw new Error('bad row');
          return { device: 'done' };
        },
      });

      expect(result).toMatchObject({ total: 2, processed: 3, errors: 1, failedRanges: [] });
      const devices = await db
        .select({ product: sessions.product, device: sessions.device })
        .from(sessions);
      expect(devices.filter((r) => r.device === 'done')).toHaveLength(2);
      expect(devices.find((r) => r.product === 'boom')?.device).toBe('unset');
    });

    it('counts every row of a table with no windows', async () => {
      await seedRows(['a', 'b', 'c', 'd', 'e']);
      vi.mocked(sessionWalkWindows).mockResolvedValueOnce(null);

      const result = await normalizeWalk({
        ...walkOptions,
        where: sql`s.device = 'unset'`,
        batchSize: 2,
        plan: () => ({ device: 'done' }),
      });

      expect(result).toMatchObject({ total: 5, processed: 5, skipped: 0, failedRanges: [] });
    });

    it('counts rows once when the retry no longer selects the rows it wrote', async () => {
      await seedRows(['a', 'b', 'keep', 'd', 'e']);
      let failed = false;

      const result = await normalizeWalk({
        ...walkOptions,
        where: sql`s.device = 'unset'`,
        batchSize: 2,
        plan: (row: { product: string }) => (row.product === 'keep' ? null : { device: 'done' }),
        onCommit: () => {
          if (failed) return;
          failed = true;
          throw new Error('transient');
        },
      });

      expect(failed).toBe(true);
      expect(result).toMatchObject({
        total: 4,
        processed: 5,
        skipped: 1,
        errors: 0,
        failedRanges: [],
      });
    });

    it('counts each row once when a window is retried after batches committed', async () => {
      await seedRows(['a', 'b', 'c', 'd', 'e']);
      let failed = false;

      const result = await normalizeWalk({
        ...walkOptions,
        batchSize: 2,
        plan: (row: { device: string }) => (row.device === 'done' ? null : { device: 'done' }),
        onCommit: () => {
          if (failed) return;
          failed = true;
          throw new Error('transient');
        },
      });

      expect(failed).toBe(true);
      expect(result).toMatchObject({
        total: 5,
        processed: 5,
        skipped: 0,
        errors: 0,
        failedRanges: [],
      });
    });
  });
});
