/**
 * Maintenance normalizers reach rows in compressed chunks.
 *
 * Run with: pnpm --filter @tracearr/server test:integration normalizeCompressed
 */

import { describe, it, expect } from 'vitest';
import type { Job } from 'bullmq';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { executeRawSql } from '@tracearr/test-utils/db';
import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { sessions } from '../../src/db/schema.js';
import {
  processNormalizeCodecsJob,
  processNormalizePlayersJob,
  type MaintenanceJobData,
} from '../../src/jobs/maintenanceQueue.js';
import { compressSessionChunks } from '../../src/test/compressChunks.js';

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
});
