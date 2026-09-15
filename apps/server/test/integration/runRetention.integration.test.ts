/**
 * Run retention integration tests
 *
 * The purge windows are per-row SQL — COALESCE over the joined automation's
 * retention_days — so only a real database can answer which rows survive.
 *
 * Run with: pnpm --filter @tracearr/server exec vitest run --config vitest.integration.config.ts runRetention
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import type { AutomationKind, RunOutcome } from '@tracearr/shared';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  automations,
  automationRuns,
  users,
  newsletters,
  newsletterSends,
  newsletterSendSnapshots,
  emailSuppressions,
} from '../../src/db/schema.js';
import { processRunRetention } from '../../src/jobs/runRetentionQueue.js';
import { recomputeIdentityAggregatesForServerUser } from '../../src/services/userService.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS);

async function seedAutomation(
  kind: AutomationKind,
  retentionDays: number | null = null
): Promise<string> {
  const [row] = await db
    .insert(automations)
    .values({
      name: `${kind}-${randomUUID().slice(0, 8)}`,
      kind,
      retentionDays,
      conditions: { groups: [] },
      actions: { actions: [] },
    })
    .returning({ id: automations.id });
  if (!row) throw new Error('failed to insert the automation');
  return row.id;
}

interface RunSeed {
  automationId: string;
  serverUserId: string;
  sessionId: string | null;
  kind: AutomationKind;
  finishedAt: Date;
  outcome?: RunOutcome;
  acknowledgedAt?: Date | null;
  dismissedAt?: Date | null;
}

async function seedRun(seed: RunSeed): Promise<string> {
  const [row] = await db
    .insert(automationRuns)
    .values({
      automationId: seed.automationId,
      serverUserId: seed.serverUserId,
      sessionId: seed.sessionId,
      kind: seed.kind,
      outcome: seed.outcome ?? 'completed',
      finishedAt: seed.finishedAt,
      acknowledgedAt: seed.acknowledgedAt ?? null,
      dismissedAt: seed.dismissedAt ?? null,
      data: {},
    })
    .returning({ id: automationRuns.id });
  if (!row) throw new Error('failed to insert the run');
  return row.id;
}

async function survivors(): Promise<Set<string>> {
  const rows = await db.select({ id: automationRuns.id }).from(automationRuns);
  return new Set(rows.map((row) => row.id));
}

async function seedSubject(): Promise<{
  serverUserId: string;
  sessionId: string;
  userId: string;
}> {
  const owner = await createTestUser({ role: 'owner' });
  const server = await createTestServer({ type: 'plex' });
  const serverUser = await createTestServerUser({ userId: owner.id, serverId: server.id });
  const session = await createTestSession({ serverId: server.id, serverUserId: serverUser.id });
  return { serverUserId: serverUser.id, sessionId: session.id, userId: owner.id };
}

async function totalViolationsOf(userId: string): Promise<number | null> {
  const rows = await db
    .select({ total: users.totalViolations })
    .from(users)
    .where(eq(users.id, userId));
  return rows[0]?.total ?? null;
}

describe('processRunRetention', () => {
  it('ages completed runs on the default window for their kind', async () => {
    const { serverUserId, sessionId } = await seedSubject();
    const notify = await seedAutomation('notification');
    const policy = await seedAutomation('policy');

    const staleNotification = await seedRun({
      automationId: notify,
      serverUserId,
      sessionId,
      kind: 'notification',
      finishedAt: daysAgo(31),
    });
    const freshNotification = await seedRun({
      automationId: notify,
      serverUserId,
      sessionId,
      kind: 'notification',
      finishedAt: daysAgo(29),
    });
    const stalePolicy = await seedRun({
      automationId: policy,
      serverUserId,
      sessionId,
      kind: 'policy',
      finishedAt: daysAgo(400),
    });
    const freshPolicy = await seedRun({
      automationId: policy,
      serverUserId,
      sessionId,
      kind: 'policy',
      finishedAt: daysAgo(100),
    });

    const result = await processRunRetention();
    const left = await survivors();

    expect(result.notificationPurged).toBe(1);
    expect(result.policyPurged).toBe(1);
    expect(left.has(staleNotification)).toBe(false);
    expect(left.has(stalePolicy)).toBe(false);
    expect(left.has(freshNotification)).toBe(true);
    expect(left.has(freshPolicy)).toBe(true);
  });

  it('lets a per-automation override shorten or lengthen the window', async () => {
    const { serverUserId, sessionId } = await seedSubject();
    const shortPolicy = await seedAutomation('policy', 5);
    const longNotification = await seedAutomation('notification', 400);

    const purgedEarly = await seedRun({
      automationId: shortPolicy,
      serverUserId,
      sessionId,
      kind: 'policy',
      finishedAt: daysAgo(10),
    });
    const keptLonger = await seedRun({
      automationId: longNotification,
      serverUserId,
      sessionId,
      kind: 'notification',
      finishedAt: daysAgo(100),
    });

    await processRunRetention();
    const left = await survivors();

    expect(left.has(purgedEarly)).toBe(false);
    expect(left.has(keptLonger)).toBe(true);
  });

  it('purges non-completed runs at 30 days whatever the kind, override or session binding says', async () => {
    const { serverUserId, sessionId } = await seedSubject();
    const policy = await seedAutomation('policy', 400);
    const notify = await seedAutomation('notification', 400);

    const stoppedPolicy = await seedRun({
      automationId: policy,
      serverUserId,
      sessionId,
      kind: 'policy',
      outcome: 'stopped_by_condition',
      finishedAt: daysAgo(31),
    });
    // The hourly account sweep writes one of these per candidate automation per cycle.
    const stoppedAccount = await seedRun({
      automationId: policy,
      serverUserId,
      sessionId: null,
      kind: 'policy',
      outcome: 'stopped_by_condition',
      finishedAt: daysAgo(31),
    });
    const erroredNotification = await seedRun({
      automationId: notify,
      serverUserId,
      sessionId,
      kind: 'notification',
      outcome: 'error',
      finishedAt: daysAgo(31),
    });
    const recentError = await seedRun({
      automationId: policy,
      serverUserId,
      sessionId,
      kind: 'policy',
      outcome: 'error',
      finishedAt: daysAgo(29),
    });

    const result = await processRunRetention();
    const left = await survivors();

    expect(result.diagnosticPurged).toBe(3);
    expect(left.has(stoppedPolicy)).toBe(false);
    expect(left.has(stoppedAccount)).toBe(false);
    expect(left.has(erroredNotification)).toBe(false);
    expect(left.has(recentError)).toBe(true);
  });

  it('never touches account-keyed rows and ignores ack or dismiss state', async () => {
    const { serverUserId, sessionId } = await seedSubject();
    const policy = await seedAutomation('policy');
    const notify = await seedAutomation('notification');

    const accountPolicy = await seedRun({
      automationId: policy,
      serverUserId,
      sessionId: null,
      kind: 'policy',
      finishedAt: daysAgo(400),
    });
    const accountNotification = await seedRun({
      automationId: notify,
      serverUserId,
      sessionId: null,
      kind: 'notification',
      finishedAt: daysAgo(400),
    });
    const acknowledged = await seedRun({
      automationId: policy,
      serverUserId,
      sessionId,
      kind: 'policy',
      finishedAt: daysAgo(400),
      acknowledgedAt: daysAgo(399),
    });
    const dismissed = await seedRun({
      automationId: policy,
      serverUserId,
      sessionId,
      kind: 'policy',
      finishedAt: daysAgo(400),
      dismissedAt: daysAgo(399),
    });

    await processRunRetention();
    const left = await survivors();

    expect(left.has(accountPolicy)).toBe(true);
    expect(left.has(accountNotification)).toBe(true);
    expect(left.has(acknowledged)).toBe(false);
    expect(left.has(dismissed)).toBe(false);
  });

  it('restates the violation rollup of every identity the policy purge touched', async () => {
    const { serverUserId, sessionId, userId } = await seedSubject();
    const policy = await seedAutomation('policy', 1);

    for (const age of [10, 11, 12]) {
      await seedRun({
        automationId: policy,
        serverUserId,
        sessionId,
        kind: 'policy',
        finishedAt: daysAgo(age),
      });
    }
    const kept = await seedRun({
      automationId: policy,
      serverUserId,
      sessionId,
      kind: 'policy',
      finishedAt: new Date(),
    });
    await recomputeIdentityAggregatesForServerUser(serverUserId);
    expect(await totalViolationsOf(userId)).toBe(4);

    const result = await processRunRetention();

    expect(result.policyPurged).toBe(3);
    expect((await survivors()).has(kept)).toBe(true);
    expect(await totalViolationsOf(userId)).toBe(1);
  });
});

describe('newsletter send retention', () => {
  async function seedSend(
    newsletterId: string,
    ageDays: number,
    opts: { finished: boolean; html: string | null }
  ): Promise<string> {
    const [row] = await db
      .insert(newsletterSends)
      .values({
        newsletterId,
        trigger: 'schedule',
        windowStart: daysAgo(ageDays + 7),
        windowEnd: daysAgo(ageDays),
        itemCounts: {},
        outcome: opts.finished ? 'sent' : 'sending',
        startedAt: daysAgo(ageDays),
        finishedAt: opts.finished ? daysAgo(ageDays) : null,
      })
      .returning({ id: newsletterSends.id });
    if (opts.html !== null) {
      await db.insert(newsletterSendSnapshots).values({
        sendId: row!.id,
        variantKey: 'v',
        viewToken: randomUUID().replaceAll('-', '') + randomUUID().slice(0, 11),
        subject: 's',
        html: opts.html,
        text: 'text',
        posters: { m1: { serverId: 's', thumbPath: '/t', version: 'v' } },
      });
    }
    return row!.id;
  }

  it('deletes year-old closed sends, clears 90-day-old snapshots, and leaves open and young sends alone', async () => {
    const [nl] = await db
      .insert(newsletters)
      .values({
        name: `retention-${randomUUID().slice(0, 8)}`,
        schedule: { kind: 'weekly', dayOfWeek: 5, time: '18:00' },
        timezone: 'UTC',
        window: { kind: 'since_last_send', fallbackDays: 7 },
        scope: { serverIds: [], libraries: [] },
        sections: {
          movies: { enabled: true, max: 12 },
          shows: { enabled: true, max: 12, maxSeasonsPerShow: 8 },
          music: { enabled: true, max: 8 },
          mostWatched: { enabled: false, max: 10 },
        },
        subject: 's',
        recipients: { members: true, extraAddresses: [], excludeUserIds: [] },
      })
      .returning({ id: newsletters.id });
    const ancient = await seedSend(nl!.id, 400, { finished: true, html: '<p>a</p>' });
    const old = await seedSend(nl!.id, 100, { finished: true, html: '<p>o</p>' });
    const openOld = await seedSend(nl!.id, 100, { finished: false, html: '<p>x</p>' });
    const young = await seedSend(nl!.id, 10, { finished: true, html: '<p>y</p>' });
    const [suppressionSeed] = await db
      .insert(emailSuppressions)
      .values({
        address: `retention-${randomUUID().slice(0, 8)}@example.com`,
        reason: 'unsubscribed',
        sourceSendId: ancient,
      })
      .returning({ address: emailSuppressions.address });

    const result = await processRunRetention();

    expect(result.newsletterSendsPurged).toBeGreaterThanOrEqual(1);
    expect(result.newsletterSnapshotsPruned).toBeGreaterThanOrEqual(1);
    const rows = await db
      .select({ id: newsletterSends.id })
      .from(newsletterSends)
      .where(eq(newsletterSends.newsletterId, nl!.id));
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.has(ancient)).toBe(false);
    expect(ids.has(old)).toBe(true);
    const snapshots = await db
      .select({ sendId: newsletterSendSnapshots.sendId, html: newsletterSendSnapshots.html })
      .from(newsletterSendSnapshots)
      .where(inArray(newsletterSendSnapshots.sendId, [ancient, old, openOld, young]));
    expect(snapshots.sort((a, b) => a.html.localeCompare(b.html))).toEqual([
      { sendId: openOld, html: '<p>x</p>' },
      { sendId: young, html: '<p>y</p>' },
    ]);
    const survivingSuppressions = await db
      .select({ sourceSendId: emailSuppressions.sourceSendId })
      .from(emailSuppressions)
      .where(eq(emailSuppressions.address, suppressionSeed!.address));
    expect(survivingSuppressions).toEqual([{ sourceSendId: null }]);
    await db
      .delete(emailSuppressions)
      .where(eq(emailSuppressions.address, suppressionSeed!.address));
    await db.delete(newsletters).where(eq(newsletters.id, nl!.id));
  });
});
