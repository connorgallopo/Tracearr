/**
 * The termination history helper reads sessions inside a window built from the started_at
 * each log stored and the log's own time. It must return exactly what the id-only join it
 * replaced returned: sessions in old compressed chunks, a session whose started_at was
 * rewritten earlier after the log was written, and nulls for a session since deleted.
 *
 * Run with: pnpm --filter @tracearr/server test:integration terminationHistory
 */

import { describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import {
  createTestServer,
  createTestServerUser,
  createTestSession,
  createTestUser,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { automations, servers, sessions, terminationLogs, users } from '../../src/db/schema.js';
import { queryTerminationHistory } from '../../src/routes/users/queries/index.js';
import { compressSessionChunks } from '../../src/test/compressChunks.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The join the helper replaced: sessions by id alone, so every chunk. */
function idOnlyJoin(serverUserId: string) {
  return db
    .select({
      id: terminationLogs.id,
      sessionId: terminationLogs.sessionId,
      serverId: terminationLogs.serverId,
      serverName: servers.name,
      serverUserId: terminationLogs.serverUserId,
      trigger: terminationLogs.trigger,
      triggeredByUserId: terminationLogs.triggeredByUserId,
      triggeredByUsername: users.username,
      ruleId: terminationLogs.ruleId,
      ruleName: automations.name,
      violationId: terminationLogs.violationId,
      reason: terminationLogs.reason,
      success: terminationLogs.success,
      errorMessage: terminationLogs.errorMessage,
      createdAt: terminationLogs.createdAt,
      mediaTitle: sessions.mediaTitle,
      mediaType: sessions.mediaType,
      grandparentTitle: sessions.grandparentTitle,
      seasonNumber: sessions.seasonNumber,
      episodeNumber: sessions.episodeNumber,
      year: sessions.year,
      artistName: sessions.artistName,
      albumName: sessions.albumName,
    })
    .from(terminationLogs)
    .leftJoin(users, eq(terminationLogs.triggeredByUserId, users.id))
    .leftJoin(automations, eq(terminationLogs.ruleId, automations.id))
    .leftJoin(sessions, eq(terminationLogs.sessionId, sessions.id))
    .leftJoin(servers, eq(terminationLogs.serverId, servers.id))
    .where(eq(terminationLogs.serverUserId, serverUserId))
    .orderBy(desc(terminationLogs.createdAt))
    .limit(10);
}

describe('queryTerminationHistory', () => {
  it('returns the rows the id-only join returned, across chunks, after a started_at rewrite, and for a deleted session', async () => {
    const server = await createTestServer();
    const user = await createTestUser();
    const serverUser = await createTestServerUser({ serverId: server.id, userId: user.id });
    const now = Date.now();
    const base = { serverId: server.id, serverUserId: serverUser.id };
    const old = await createTestSession({ ...base, startedAt: new Date(now - 400 * DAY_MS) });
    const moved = await createTestSession({ ...base, startedAt: new Date(now - 3 * DAY_MS) });
    const recent = await createTestSession({ ...base, startedAt: new Date(now - 2 * DAY_MS) });
    const gone = await createTestSession({ ...base, startedAt: new Date(now - DAY_MS) });

    const log = { ...base, trigger: 'manual' as const, triggeredByUserId: user.id, success: true };
    await db.insert(terminationLogs).values(
      [old, moved, recent, gone].map((s) => ({
        ...log,
        sessionId: s.id,
        sessionStartedAt: s.startedAt,
        createdAt: new Date(s.startedAt.getTime() + 60 * 60 * 1000),
      }))
    );
    // Confirmation rewrites started_at to first sight, earlier than what the log stored
    await db
      .update(sessions)
      .set({ startedAt: new Date(moved.startedAt.getTime() - 60 * 60 * 1000) })
      .where(eq(sessions.id, moved.id));
    await db.delete(sessions).where(eq(sessions.id, gone.id));
    await compressSessionChunks();

    const expected = await idOnlyJoin(serverUser.id);
    const actual = await queryTerminationHistory(
      db,
      eq(terminationLogs.serverUserId, serverUser.id),
      {
        limit: 10,
      }
    );

    expect(actual).toEqual(expected);
    expect(actual.map((row) => [row.sessionId, row.mediaTitle])).toEqual([
      [gone.id, null],
      [recent.id, recent.mediaTitle],
      [moved.id, moved.mediaTitle],
      [old.id, old.mediaTitle],
    ]);
  });
});
