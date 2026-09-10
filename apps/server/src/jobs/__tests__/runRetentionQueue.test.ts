/**
 * Run Retention Queue Tests
 *
 * Pins the delete predicates the daily purge renders: one pass per distinct
 * retention window with a constant cutoff, the flat diagnostic window, which
 * passes stay session bound, and the rollup restatement the policy pass owes.
 * Row-level behavior lives in test/integration/runRetention.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AUTOMATION_KINDS } from '@tracearr/shared';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { queryChain } from '../../test/helpers.js';

vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
    select: vi.fn(),
  },
}));
vi.mock('../../services/userService.js', () => ({
  recomputeIdentityAggregatesForServerUser: vi.fn(),
}));

import { db } from '../../db/client.js';
import { recomputeIdentityAggregatesForServerUser } from '../../services/userService.js';
import { processRunRetention } from '../runRetentionQueue.js';

const mockDb = db as unknown as {
  execute: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
};
const dialect = new PgDialect();

const NOTIFY_ID = '11111111-1111-4111-8111-111111111111';
const POLICY_ID = '22222222-2222-4222-8222-222222222222';
const SHORT_POLICY_ID = '33333333-3333-4333-8333-333333333333';

interface RenderedQuery {
  sql: string;
  params: unknown[];
}

function rendered(): RenderedQuery[] {
  return mockDb.execute.mock.calls.map((call) => {
    const query = dialect.sqlToQuery(call[0] as SQL);
    return { sql: query.sql.replace(/\s+/g, ' ').trim().toLowerCase(), params: query.params };
  });
}

/** The automations select runs once per kind, notification first. */
function stageAutomations(
  notification: Array<{ id: string; retentionDays: number | null }>,
  policy: Array<{ id: string; retentionDays: number | null }>
) {
  mockDb.select
    .mockReturnValueOnce(queryChain(vi.fn, notification))
    .mockReturnValueOnce(queryChain(vi.fn, policy));
}

describe('processRunRetention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.execute.mockResolvedValue({ rowCount: 0, rows: [] });
    stageAutomations(
      [{ id: NOTIFY_ID, retentionDays: null }],
      [{ id: POLICY_ID, retentionDays: null }]
    );
  });

  it('purges completed runs per kind and non-completed runs on the flat window', async () => {
    await processRunRetention();

    const queries = rendered().filter((q) => q.sql.startsWith('delete from automation_runs'));
    expect(queries).toHaveLength(4);

    const [notification, policy, ...diagnostics] = queries;
    expect(notification?.sql).toContain("ar.kind = $1 and ar.outcome = 'completed'");
    expect(notification?.params).toEqual(['notification', NOTIFY_ID, expect.any(Date), 5000]);

    expect(policy?.sql).toContain("ar.kind = $1 and ar.outcome = 'completed'");
    expect(policy?.params).toEqual(['policy', POLICY_ID, expect.any(Date), 5000]);

    // Both kinds get the same flat diagnostic window; the split only keeps the index usable.
    expect(diagnostics).toHaveLength(2);
    for (const query of diagnostics) {
      expect(query.sql).toContain("ar.outcome <> 'completed'");
      expect(query.params.slice(1)).toEqual([expect.any(Date), 5000]);
    }
    expect(diagnostics.map((query) => query.params[0]).sort()).toEqual(
      [...AUTOMATION_KINDS].sort()
    );
  });

  it('compares finished_at against a constant, never a joined per-row window', async () => {
    await processRunRetention();

    const queries = rendered().filter((q) => q.sql.startsWith('delete from automation_runs'));
    for (const query of queries) {
      expect(query.sql).not.toContain('join automations');
      expect(query.sql).not.toContain('coalesce');
      expect(query.sql).toContain('ar.finished_at < $');
    }
  });

  it('splits a kind into one pass per distinct retention window', async () => {
    mockDb.select.mockReset();
    stageAutomations(
      [],
      [
        { id: POLICY_ID, retentionDays: null },
        { id: SHORT_POLICY_ID, retentionDays: 1 },
      ]
    );

    await processRunRetention();

    const [defaultWindow, shortWindow] = rendered();
    expect(defaultWindow?.params).toEqual(['policy', POLICY_ID, expect.any(Date), 5000]);
    expect(shortWindow?.params).toEqual(['policy', SHORT_POLICY_ID, expect.any(Date), 5000]);
    // 365 days back against 1 day back.
    expect(Number(defaultWindow?.params[2])).toBeLessThan(Number(shortWindow?.params[2]));
  });

  it('exempts account-keyed completed rows and purges session, server and install ones', async () => {
    await processRunRetention();

    const [notification, policy, ...diagnostics] = rendered().filter((q) =>
      q.sql.startsWith('delete from automation_runs')
    );
    for (const query of [notification, policy]) {
      expect(query?.sql).toContain('(ar.session_id is not null or ar.server_user_id is null)');
    }
    for (const query of diagnostics) {
      expect(query.sql).not.toContain('session_id');
    }
  });

  it('keeps every predicate blind to ack or dismiss', async () => {
    await processRunRetention();

    const queries = rendered().filter((q) => q.sql.startsWith('delete from automation_runs'));
    expect(queries).toHaveLength(4);
    for (const query of queries) {
      expect(query.sql).toContain('delete from automation_runs');
      expect(query.sql).not.toContain('acknowledged_at');
      expect(query.sql).not.toContain('dismissed_at');
    }
  });

  it('deletes in batches of 5000 until a short batch ends the pass', async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rowCount: 5000, rows: [] })
      .mockResolvedValueOnce({ rowCount: 17, rows: [] })
      .mockResolvedValue({ rowCount: 0, rows: [] });

    const result = await processRunRetention();

    // Two calls to drain the notification pass, one each for the three automation_runs
    // passes that follow, two more for the newsletter purge and prune.
    expect(mockDb.execute).toHaveBeenCalledTimes(7);
    expect(result.notificationPurged).toBe(5017);
    for (const query of rendered().filter((q) => q.sql.startsWith('delete from automation_runs'))) {
      expect(query.sql).toContain('limit $');
      expect(query.params.at(-1)).toBe(5000);
    }
  });

  it('counts each pass separately and sums the diagnostic sweeps', async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rowCount: 3, rows: [] })
      .mockResolvedValueOnce({ rowCount: 7, rows: [] })
      .mockResolvedValueOnce({ rowCount: 11, rows: [] })
      .mockResolvedValueOnce({ rowCount: 4, rows: [] });

    const result = await processRunRetention();

    expect(result).toEqual({
      notificationPurged: 3,
      policyPurged: 7,
      diagnosticPurged: 15,
      newsletterSendsPurged: 0,
      newsletterSnapshotsPruned: 0,
    });
  });

  it('restates each identity the policy pass removed rows from, once per batch', async () => {
    mockDb.execute
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 3,
        rows: [{ server_user_id: 'su-1' }, { server_user_id: 'su-2' }, { server_user_id: 'su-1' }],
      })
      .mockResolvedValue({ rowCount: 0, rows: [] });

    await processRunRetention();

    expect(recomputeIdentityAggregatesForServerUser).toHaveBeenCalledTimes(2);
    expect(recomputeIdentityAggregatesForServerUser).toHaveBeenCalledWith('su-1');
    expect(recomputeIdentityAggregatesForServerUser).toHaveBeenCalledWith('su-2');
  });

  it('restates nothing for the notification or diagnostic passes', async () => {
    mockDb.execute.mockResolvedValue({ rowCount: 0, rows: [{ server_user_id: 'su-1' }] });

    await processRunRetention();

    expect(recomputeIdentityAggregatesForServerUser).toHaveBeenCalledTimes(1);
  });

  describe('newsletter sends', () => {
    it('purges closed sends after a year and deletes closed snapshots after 90 days', async () => {
      const before = Date.now();
      const result = await processRunRetention();
      const queries = rendered();
      const purge = queries.find((q) => q.sql.startsWith('delete from newsletter_sends'));
      const prune = queries.find((q) => q.sql.startsWith('delete from newsletter_send_snapshots'));
      expect(purge?.sql).toBe(
        'delete from newsletter_sends where finished_at is not null and started_at < $1'
      );
      expect(prune?.sql).toBe(
        'delete from newsletter_send_snapshots as ns using newsletter_sends as s where s.id = ns.send_id and s.finished_at is not null and s.started_at < $1'
      );
      const purgeCutoff = (purge!.params[0] as Date).getTime();
      const pruneCutoff = (prune!.params[0] as Date).getTime();
      expect(Math.abs(before - 365 * 86_400_000 - purgeCutoff)).toBeLessThan(5_000);
      expect(Math.abs(before - 90 * 86_400_000 - pruneCutoff)).toBeLessThan(5_000);
      expect(result.newsletterSendsPurged).toBe(0);
      expect(result.newsletterSnapshotsPruned).toBe(0);
    });
  });
});
