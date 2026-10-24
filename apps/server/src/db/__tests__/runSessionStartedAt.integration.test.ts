import { readFileSync, readdirSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  createTestAutomation,
  createTestRun,
  createTestServer,
  createTestServerUser,
  createTestSession,
  createTestUser,
} from '@tracearr/test-utils/factories';
import { db } from '../client.js';
import { automationRuns } from '../schema.js';

const MIGRATIONS = `${import.meta.dirname}/../migrations`;

function statementsOf(): string[] {
  const file = readdirSync(MIGRATIONS).find((name) => /^0123_.*\.sql$/.test(name));
  if (!file) throw new Error('migration 0123 not found');
  return readFileSync(`${MIGRATIONS}/${file}`, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('migration 0123 automation_runs.session_started_at backfill', () => {
  it('fills completed violations from their session and leaves diagnostics to age out', async () => {
    const server = await createTestServer();
    const user = await createTestUser();
    const serverUser = await createTestServerUser({ serverId: server.id, userId: user.id });
    const base = { serverId: server.id, serverUserId: serverUser.id };
    const flagged = await createTestSession({
      ...base,
      startedAt: new Date('2025-03-01T10:00:00Z'),
    });
    const passed = await createTestSession({
      ...base,
      startedAt: new Date('2025-03-02T10:00:00Z'),
    });
    const automation = await createTestAutomation();
    const run = { automationId: automation.id, serverUserId: serverUser.id };
    const violation = await createTestRun({ ...run, sessionId: flagged.id });
    const diagnostic = await createTestRun({
      ...run,
      sessionId: passed.id,
      outcome: 'stopped_by_condition',
    });
    await db.execute(sql`UPDATE automation_runs SET session_started_at = NULL`);

    for (const statement of statementsOf()) await db.execute(sql.raw(statement));

    const rows = await db
      .select({ id: automationRuns.id, startedAt: automationRuns.sessionStartedAt })
      .from(automationRuns);
    const startedAt = Object.fromEntries(rows.map((r) => [r.id, r.startedAt]));
    expect(startedAt[violation.id]).toEqual(flagged.startedAt);
    expect(startedAt[diagnostic.id]).toBeNull();
  });
});
