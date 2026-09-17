/**
 * fix_imported_progress maintenance job integration tests.
 *
 * Tautulli imports made before Tracearr 1.3.9 wrote null for both progress_ms
 * and total_duration_ms. The job estimates both for those rows only: a row
 * that already has either value, or that sits on a Jellyfin or Emby server,
 * is never selected.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- fixImportedProgress
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
  processFixImportedProgressJob,
  type MaintenanceJobData,
} from '../../src/jobs/maintenanceQueue.js';

function fakeJob(): Job<MaintenanceJobData> {
  return {
    id: 'test-fix-imported-progress',
    token: 'test-token',
    data: { type: 'fix_imported_progress', userId: 'owner' },
    updateProgress: async () => undefined,
    extendLock: async () => undefined,
  } as unknown as Job<MaintenanceJobData>;
}

// The session factory turns a null progress into 0, so the columns are set afterwards.
async function setProgress(
  sessionId: string,
  progressMs: number | null,
  totalDurationMs: number | null
) {
  await executeRawSql(`
    UPDATE sessions
    SET progress_ms = ${progressMs ?? 'NULL'}, total_duration_ms = ${totalDurationMs ?? 'NULL'}
    WHERE id = '${sessionId}'
  `);
}

async function progressOf(sessionId: string) {
  const [row] = await db
    .select({ progressMs: sessions.progressMs, totalDurationMs: sessions.totalDurationMs })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return row;
}

describe('fix_imported_progress maintenance job', () => {
  it('fills only Plex rows that have neither a progress nor a total', async () => {
    const plex = await createTestServer({ type: 'plex' });
    const jellyfin = await createTestServer({ type: 'jellyfin' });
    const user = await createTestUser({ role: 'member' });
    const plexUser = await createTestServerUser({ userId: user.id, serverId: plex.id });
    const jellyfinUser = await createTestServerUser({ userId: user.id, serverId: jellyfin.id });

    const imported = {
      state: 'stopped' as const,
      mediaType: 'movie' as const,
      durationMs: 3_600_000,
      watched: true,
    };

    const bothNullOnPlex = await createTestSession({
      ...imported,
      serverId: plex.id,
      serverUserId: plexUser.id,
      externalSessionId: 'tautulli-1',
    });
    await setProgress(bothNullOnPlex.id, null, null);
    const progressOnlyOnPlex = await createTestSession({
      ...imported,
      serverId: plex.id,
      serverUserId: plexUser.id,
      externalSessionId: 'tautulli-2',
    });
    await setProgress(progressOnlyOnPlex.id, 3_600_000, null);
    const runtimeOnlyOnJellyfin = await createTestSession({
      ...imported,
      serverId: jellyfin.id,
      serverUserId: jellyfinUser.id,
      externalSessionId: 'jellystat-1',
    });
    await setProgress(runtimeOnlyOnJellyfin.id, null, 5_400_000);
    const bothNullOnJellyfin = await createTestSession({
      ...imported,
      serverId: jellyfin.id,
      serverUserId: jellyfinUser.id,
      externalSessionId: 'jellystat-2',
    });
    await setProgress(bothNullOnJellyfin.id, null, null);

    const result = await processFixImportedProgressJob(fakeJob());

    expect(result.success).toBe(true);
    expect(result.processed).toBe(1);
    expect(result.updated).toBe(1);

    expect(await progressOf(bothNullOnPlex.id)).toEqual({
      progressMs: 3_600_000,
      totalDurationMs: Math.round(3_600_000 / 0.85),
    });
    expect(await progressOf(progressOnlyOnPlex.id)).toEqual({
      progressMs: 3_600_000,
      totalDurationMs: null,
    });
    expect(await progressOf(runtimeOnlyOnJellyfin.id)).toEqual({
      progressMs: null,
      totalDurationMs: 5_400_000,
    });
    expect(await progressOf(bothNullOnJellyfin.id)).toEqual({
      progressMs: null,
      totalDurationMs: null,
    });
  });
});
