/**
 * The newsletter store's load-bearing SQL: finalizeSend's CASE arms and its two
 * guards, markSendSending's rendering guard, beginAttempt, resetFailedRecipients,
 * lastWatermark's trigger and outcome filter, closeStaleSend's two branches,
 * queuedRecipientIds, deleteNewsletter, and getSendByViewToken. Every tier but
 * this one mocks the Drizzle chain, so only Postgres can prove any of these
 * predicates.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- newsletterStore
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NewsletterRecipientStatus, NewsletterSendOutcome } from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import { newsletterSendRecipients, newsletterSends, newsletters } from '../../src/db/schema.js';
import {
  RENDERING_STALE_MS,
  SENDING_STALE_MS,
  beginAttempt,
  closeStaleSend,
  deleteNewsletter,
  finalizeSend,
  getSendByViewToken,
  lastWatermark,
  markSendSending,
  queuedRecipientIds,
  resetFailedRecipients,
  type SendRow,
} from '../../src/services/newsletters/store.js';

const WINDOW_START = new Date('2026-08-26T00:00:00Z');
const WINDOW_END = new Date('2026-09-02T00:00:00Z');

let tokens = 0;

async function seedNewsletter(name = 'Weekly') {
  const [row] = await db
    .insert(newsletters)
    .values({
      name,
      schedule: { kind: 'weekly', dayOfWeek: 5, time: '18:00' },
      timezone: 'UTC',
      window: { kind: 'since_last_send', fallbackDays: 7 },
      scope: { serverIds: [], libraryIds: [] },
      sections: {
        movies: { enabled: true, max: 12 },
        shows: { enabled: true, max: 12, maxSeasonsPerShow: 8 },
        music: { enabled: true, max: 8 },
        mostWatched: { enabled: false, max: 10 },
      },
      subject: 's',
      recipients: { members: true, extraAddresses: [] },
    })
    .returning();
  return row!;
}

async function seedSend(
  newsletterId: string,
  over: Partial<{
    outcome: NewsletterSendOutcome;
    trigger: 'schedule' | 'manual' | 'test';
    windowEnd: Date;
    startedAt: Date;
    finishedAt: Date | null;
  }> = {}
): Promise<SendRow> {
  tokens += 1;
  const [row] = await db
    .insert(newsletterSends)
    .values({
      newsletterId,
      viewToken: `token-${tokens}`,
      trigger: over.trigger ?? 'manual',
      windowStart: WINDOW_START,
      windowEnd: over.windowEnd ?? WINDOW_END,
      outcome: over.outcome ?? 'sending',
      ...(over.startedAt ? { startedAt: over.startedAt } : {}),
      ...(over.finishedAt === undefined ? {} : { finishedAt: over.finishedAt }),
    })
    .returning();
  return row!;
}

async function seedRecipients(
  sendId: string,
  rows: {
    address: string;
    status: NewsletterRecipientStatus;
    attempts?: number;
    error?: string | null;
    messageId?: string | null;
  }[]
) {
  return db
    .insert(newsletterSendRecipients)
    .values(rows.map((r) => ({ ...r, sendId })))
    .returning();
}

const readSend = async (id: string): Promise<SendRow> => {
  const [row] = await db.select().from(newsletterSends).where(eq(newsletterSends.id, id));
  return row!;
};

const readRecipients = async (sendId: string) =>
  db
    .select()
    .from(newsletterSendRecipients)
    .where(eq(newsletterSendRecipients.sendId, sendId))
    .orderBy(newsletterSendRecipients.address);

// The suite-wide reset leaves newsletters in place, and the name is unique.
beforeEach(async () => {
  await db.delete(newsletters);
});

describe('finalizeSend', () => {
  let newsletterId: string;
  beforeEach(async () => {
    newsletterId = (await seedNewsletter()).id;
  });

  it('closes a send where everyone was reached as sent and stamps finished_at', async () => {
    const send = await seedSend(newsletterId);
    await seedRecipients(send.id, [
      { address: 'a@example.com', status: 'sent' },
      { address: 'b@example.com', status: 'sent' },
    ]);
    await finalizeSend(send.id);
    const after = await readSend(send.id);
    expect(after.outcome).toBe('sent');
    expect(after.finishedAt).toBeInstanceOf(Date);
  });

  it('closes a mixed send as partial', async () => {
    const send = await seedSend(newsletterId);
    await seedRecipients(send.id, [
      { address: 'a@example.com', status: 'sent' },
      { address: 'b@example.com', status: 'failed' },
      { address: 'c@example.com', status: 'suppressed' },
    ]);
    await finalizeSend(send.id);
    expect((await readSend(send.id)).outcome).toBe('partial');
  });

  it('closes a send nobody was reached on as failed, counting unknown as attempted', async () => {
    const send = await seedSend(newsletterId);
    await seedRecipients(send.id, [
      { address: 'a@example.com', status: 'failed' },
      { address: 'b@example.com', status: 'unknown' },
    ]);
    await finalizeSend(send.id);
    expect((await readSend(send.id)).outcome).toBe('failed');
  });

  it('closes a send with no attempted rows at all as failed', async () => {
    const send = await seedSend(newsletterId);
    await seedRecipients(send.id, [{ address: 'a@example.com', status: 'suppressed' }]);
    await finalizeSend(send.id);
    expect((await readSend(send.id)).outcome).toBe('failed');
  });

  it('leaves a send alone while a recipient is still queued', async () => {
    const send = await seedSend(newsletterId);
    await seedRecipients(send.id, [
      { address: 'a@example.com', status: 'sent' },
      { address: 'b@example.com', status: 'queued' },
    ]);
    await finalizeSend(send.id);
    const after = await readSend(send.id);
    expect(after.outcome).toBe('sending');
    expect(after.finishedAt).toBeNull();
  });

  it('leaves a send that is not sending alone', async () => {
    const send = await seedSend(newsletterId, { outcome: 'rendering' });
    await seedRecipients(send.id, [{ address: 'a@example.com', status: 'sent' }]);
    await finalizeSend(send.id);
    const after = await readSend(send.id);
    expect(after.outcome).toBe('rendering');
    expect(after.finishedAt).toBeNull();
  });
});

describe('markSendSending', () => {
  it('flips a rendering send and records the deliverable count', async () => {
    const newsletter = await seedNewsletter();
    const send = await seedSend(newsletter.id, { outcome: 'rendering' });
    await markSendSending(send.id, 7);
    const after = await readSend(send.id);
    expect(after.outcome).toBe('sending');
    expect(after.recipientCount).toBe(7);
  });

  it('leaves a send that already failed alone', async () => {
    const newsletter = await seedNewsletter();
    const send = await seedSend(newsletter.id, { outcome: 'failed' });
    await markSendSending(send.id, 7);
    const after = await readSend(send.id);
    expect(after.outcome).toBe('failed');
    expect(after.recipientCount).toBe(0);
  });
});

describe('beginAttempt', () => {
  it('returns the previous attempt and writes the new message id', async () => {
    const newsletter = await seedNewsletter();
    const send = await seedSend(newsletter.id);
    const [recipient] = await seedRecipients(send.id, [
      {
        address: 'a@example.com',
        status: 'queued',
        attempts: 1,
        error: 'Could not connect to h:1',
        messageId: '<old@example.com>',
      },
    ]);
    const attempt = await beginAttempt(recipient!.id, '<new@example.com>');
    expect(attempt).toEqual({
      previousMessageId: '<old@example.com>',
      previousError: 'Could not connect to h:1',
      attempts: 2,
    });
    const [after] = await readRecipients(send.id);
    expect(after?.messageId).toBe('<new@example.com>');
    expect(after?.attempts).toBe(2);
  });
});

describe('resetFailedRecipients', () => {
  it('requeues only the failed rows and reopens the send', async () => {
    const newsletter = await seedNewsletter();
    const send = await seedSend(newsletter.id, {
      outcome: 'partial',
      finishedAt: new Date('2026-09-02T01:00:00Z'),
    });
    const seeded = await seedRecipients(send.id, [
      {
        address: 'failed@example.com',
        status: 'failed',
        attempts: 3,
        error: 'smtp down',
        messageId: '<old@example.com>',
      },
      { address: 'queued@example.com', status: 'queued', attempts: 1 },
      { address: 'sent@example.com', status: 'sent', attempts: 1 },
    ]);
    const failedId = seeded.find((r) => r.address === 'failed@example.com')!.id;

    const reset = await resetFailedRecipients(send.id);
    expect(reset).toEqual([failedId]);

    const rows = await readRecipients(send.id);
    const byAddress = new Map(rows.map((r) => [r.address, r]));
    expect(byAddress.get('failed@example.com')).toMatchObject({
      status: 'queued',
      attempts: 0,
      error: null,
      messageId: null,
    });
    expect(byAddress.get('queued@example.com')).toMatchObject({ status: 'queued', attempts: 1 });
    expect(byAddress.get('sent@example.com')).toMatchObject({ status: 'sent', attempts: 1 });

    const after = await readSend(send.id);
    expect(after.outcome).toBe('sending');
    expect(after.finishedAt).toBeNull();
  });

  it('leaves the send closed when nothing failed', async () => {
    const newsletter = await seedNewsletter();
    const finishedAt = new Date('2026-09-02T01:00:00Z');
    const send = await seedSend(newsletter.id, { outcome: 'sent', finishedAt });
    await seedRecipients(send.id, [{ address: 'a@example.com', status: 'sent' }]);
    expect(await resetFailedRecipients(send.id)).toEqual([]);
    const after = await readSend(send.id);
    expect(after.outcome).toBe('sent');
    expect(after.finishedAt).toEqual(finishedAt);
  });
});

describe('lastWatermark', () => {
  it('takes the newest window end among counted triggers that reached someone', async () => {
    const newsletter = await seedNewsletter();
    await seedSend(newsletter.id, {
      trigger: 'schedule',
      outcome: 'sent',
      windowEnd: new Date('2026-08-20T00:00:00Z'),
    });
    await seedSend(newsletter.id, {
      trigger: 'manual',
      outcome: 'partial',
      windowEnd: new Date('2026-08-27T00:00:00Z'),
    });
    await seedSend(newsletter.id, {
      trigger: 'test',
      outcome: 'sent',
      windowEnd: new Date('2026-09-10T00:00:00Z'),
    });
    await seedSend(newsletter.id, {
      trigger: 'schedule',
      outcome: 'failed',
      windowEnd: new Date('2026-09-11T00:00:00Z'),
    });
    await seedSend(newsletter.id, {
      trigger: 'schedule',
      outcome: 'skipped_empty',
      windowEnd: new Date('2026-09-12T00:00:00Z'),
    });
    expect(await lastWatermark(newsletter.id)).toEqual(new Date('2026-08-27T00:00:00Z'));
  });

  it('is null for a newsletter whose only sends never reached anyone', async () => {
    const newsletter = await seedNewsletter();
    await seedSend(newsletter.id, { trigger: 'schedule', outcome: 'failed' });
    expect(await lastWatermark(newsletter.id)).toBeNull();
  });
});

describe('closeStaleSend', () => {
  it('fails a rendering send whose run never queued anything', async () => {
    const newsletter = await seedNewsletter();
    const startedAt = new Date('2026-09-02T00:00:00Z');
    const send = await seedSend(newsletter.id, { outcome: 'rendering', startedAt });
    expect(await closeStaleSend(send, startedAt.getTime() + RENDERING_STALE_MS + 1)).toBe(true);
    const after = await readSend(send.id);
    expect(after.outcome).toBe('failed');
    expect(after.error).toBe('Interrupted before delivery started');
    expect(after.finishedAt).toBeInstanceOf(Date);
  });

  it('fails the stranded queued rows of a sending send and closes it on what is known', async () => {
    const newsletter = await seedNewsletter();
    const startedAt = new Date('2026-09-02T00:00:00Z');
    const send = await seedSend(newsletter.id, { outcome: 'sending', startedAt });
    await seedRecipients(send.id, [
      { address: 'a@example.com', status: 'sent' },
      { address: 'b@example.com', status: 'queued' },
    ]);
    expect(await closeStaleSend(send, startedAt.getTime() + SENDING_STALE_MS + 1)).toBe(true);
    const rows = await readRecipients(send.id);
    expect(rows.map((r) => [r.address, r.status, r.error])).toEqual([
      ['a@example.com', 'sent', null],
      ['b@example.com', 'failed', 'Delivery job lost'],
    ]);
    expect((await readSend(send.id)).outcome).toBe('partial');
  });

  it('leaves a send that is still inside its window alone', async () => {
    const newsletter = await seedNewsletter();
    const startedAt = new Date('2026-09-02T00:00:00Z');
    const send = await seedSend(newsletter.id, { outcome: 'rendering', startedAt });
    expect(await closeStaleSend(send, startedAt.getTime() + RENDERING_STALE_MS - 1)).toBe(false);
    expect((await readSend(send.id)).outcome).toBe('rendering');
  });
});

describe('queuedRecipientIds', () => {
  it('returns the queued rows of that send only', async () => {
    const newsletter = await seedNewsletter();
    const send = await seedSend(newsletter.id);
    const other = await seedSend((await seedNewsletter('Other')).id);
    const seeded = await seedRecipients(send.id, [
      { address: 'queued@example.com', status: 'queued' },
      { address: 'sent@example.com', status: 'sent' },
      { address: 'suppressed@example.com', status: 'suppressed' },
    ]);
    await seedRecipients(other.id, [{ address: 'elsewhere@example.com', status: 'queued' }]);
    expect(await queuedRecipientIds(send.id)).toEqual([
      seeded.find((r) => r.address === 'queued@example.com')!.id,
    ]);
  });
});

describe('getSendByViewToken', () => {
  it('finds a send by its view token and nothing by another', async () => {
    const newsletter = await seedNewsletter();
    const send = await seedSend(newsletter.id, { outcome: 'sent' });
    const found = await getSendByViewToken(send.viewToken);
    expect(found?.id).toBe(send.id);
    expect(await getSendByViewToken('no-such-token')).toBeNull();
  });
});

describe('deleteNewsletter', () => {
  it('refuses while a send is genuinely open and deletes once that send has gone stale', async () => {
    const newsletter = await seedNewsletter();
    const send = await seedSend(newsletter.id, { outcome: 'sending' });
    await seedRecipients(send.id, [{ address: 'a@example.com', status: 'queued' }]);
    expect(await deleteNewsletter(newsletter.id)).toBe('open_send');

    await db
      .update(newsletterSends)
      .set({ startedAt: new Date(Date.now() - SENDING_STALE_MS - 60_000) })
      .where(eq(newsletterSends.id, send.id));
    expect(await deleteNewsletter(newsletter.id)).toBe('deleted');
    expect(await db.select().from(newsletters).where(eq(newsletters.id, newsletter.id))).toEqual(
      []
    );
  });

  it('reports a missing newsletter', async () => {
    expect(await deleteNewsletter('11111111-1111-4111-8111-111111111111')).toBe('missing');
  });
});
