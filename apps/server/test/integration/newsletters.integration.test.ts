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

async function insertSend(newsletterId: string, outcome: string, token: string) {
  return db
    .insert(newsletterSends)
    .values({
      newsletterId,
      viewToken: token,
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
    await insertSend(n.id, 'sending', 't1');
    await expect(insertSend(n.id, 'rendering', 't2')).rejects.toMatchObject({
      cause: { code: '23505' },
    });
    await db
      .update(newsletterSends)
      .set({ outcome: 'sent' })
      .where(sql`newsletter_id = ${n.id}`);
    const [second] = await insertSend(n.id, 'rendering', 't3');
    expect(second?.outcome).toBe('rendering');
  });

  it('cascades recipients with the send and keeps a suppression with its source nulled', async () => {
    const n = await seedNewsletter();
    const [send] = await insertSend(n.id, 'sent', 't1');
    await db
      .insert(newsletterSendRecipients)
      .values({ sendId: send!.id, address: 'a@example.com' });
    await db
      .insert(emailSuppressions)
      .values({ address: 'a@example.com', reason: 'unsubscribed', sourceSendId: send!.id });
    await db.delete(newsletterSends).where(sql`id = ${send!.id}`);
    const recipients = await db.select().from(newsletterSendRecipients);
    expect(recipients).toHaveLength(0);
    const [supp] = await db.select().from(emailSuppressions);
    expect(supp).toMatchObject({ address: 'a@example.com', sourceSendId: null });
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

  it('created the first-seen partial index', async () => {
    const result = await db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_library_items_first_seen_active'`
    );
    const def = String((result.rows[0] as { indexdef?: string } | undefined)?.indexdef ?? '');
    expect(def).toContain('first_seen_at');
    expect(def.toLowerCase()).toContain('where');
  });
});
