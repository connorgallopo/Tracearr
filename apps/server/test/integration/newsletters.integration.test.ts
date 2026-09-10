/**
 * Newsletter schema integration tests: the open-send partial unique index,
 * the lowercase checks, and the first-seen partial index only exist in Postgres.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- newsletters
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
  emailSuppressions,
  newsletterSendRecipients,
  newsletterSendSnapshots,
  newsletterSends,
  newsletters,
  users,
} from '../../src/db/schema.js';

async function seedNewsletter(name = 'Weekly') {
  const [row] = await db
    .insert(newsletters)
    .values({
      name,
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
    .returning();
  return row!;
}

async function insertSend(newsletterId: string, outcome: string) {
  return db
    .insert(newsletterSends)
    .values({
      newsletterId,
      trigger: 'manual',
      windowStart: new Date('2026-08-26T00:00:00Z'),
      windowEnd: new Date('2026-09-02T00:00:00Z'),
      outcome: outcome as 'sending',
    })
    .returning();
}

describe('newsletter tables', () => {
  beforeEach(async () => {
    await db.delete(emailSuppressions);
    await db.delete(newsletters);
  });

  it('refuses a second open send per newsletter but allows one after a finished send', async () => {
    const n = await seedNewsletter();
    await insertSend(n.id, 'sending');
    await expect(insertSend(n.id, 'rendering')).rejects.toMatchObject({
      cause: { code: '23505' },
    });
    await db
      .update(newsletterSends)
      .set({ outcome: 'sent' })
      .where(sql`newsletter_id = ${n.id}`);
    const [second] = await insertSend(n.id, 'rendering');
    expect(second?.outcome).toBe('rendering');
  });

  it('cascades recipients with the send and keeps a suppression with its source nulled', async () => {
    const n = await seedNewsletter();
    const [send] = await insertSend(n.id, 'sent');
    await db
      .insert(newsletterSendRecipients)
      .values({ sendId: send!.id, address: 'a@example.com', variantKey: 'v' });
    await db
      .insert(emailSuppressions)
      .values({ address: 'a@example.com', reason: 'unsubscribed', sourceSendId: send!.id });
    await db.delete(newsletterSends).where(sql`id = ${send!.id}`);
    const recipients = await db.select().from(newsletterSendRecipients);
    expect(recipients).toHaveLength(0);
    const [supp] = await db.select().from(emailSuppressions);
    expect(supp).toMatchObject({ address: 'a@example.com', sourceSendId: null });
  });

  it('cascades snapshots with the send and refuses two snapshots for one variant', async () => {
    const n = await seedNewsletter();
    const [send] = await insertSend(n.id, 'sent');
    const snapshot = { sendId: send!.id, variantKey: 'v', subject: 's', html: '<p/>', text: 'x' };
    await db.insert(newsletterSendSnapshots).values({ ...snapshot, viewToken: 't1' });
    await expect(
      db.insert(newsletterSendSnapshots).values({ ...snapshot, viewToken: 't2' })
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    await db.delete(newsletterSends).where(sql`id = ${send!.id}`);
    expect(await db.select().from(newsletterSendSnapshots)).toEqual([]);
  });

  it('rejects mixed-case addresses in suppressions and contact emails', async () => {
    await expect(
      db.insert(emailSuppressions).values({ address: 'Mixed@Example.com', reason: 'manual' })
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    const [u] = await db
      .insert(users)
      .values({ username: 'nl-int-user', role: 'member' })
      .returning();
    await expect(
      db
        .update(users)
        .set({ contactEmail: 'Mixed@Example.com' })
        .where(sql`id = ${u!.id}`)
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await db
      .update(users)
      .set({ contactEmail: 'mixed@example.com' })
      .where(sql`id = ${u!.id}`);
    await db.delete(users).where(sql`id = ${u!.id}`);
  });

  it('indexes the window predicate expression, not the bare first_seen_at column', async () => {
    const result = await db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_library_items_seen_active'`
    );
    const def = String((result.rows[0] as { indexdef?: string } | undefined)?.indexdef ?? '');
    expect(def).toContain('COALESCE(first_seen_at, created_at)');
    expect(def).toContain('WHERE (removed_at IS NULL)');
  });
});
