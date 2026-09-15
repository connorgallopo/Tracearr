/**
 * Recipient candidates and suppressions against the real schema: the join,
 * the disabled-role and removed-account exclusions, the scope filter, the
 * conflict-free suppression insert, the contact-email write path, and which
 * members the last delivered send missed.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- newsletterRecipients
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedBasicOwner, seedMultipleUsers } from '@tracearr/test-utils';
import { DEFAULT_NEWSLETTER_SECTIONS } from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import {
  emailSuppressions,
  newsletters,
  newsletterSendRecipients,
  newsletterSends,
  serverUsers,
  servers,
  users,
} from '../../src/db/schema.js';
import {
  loadCandidates,
  mergeRecipients,
  resolveRecipients,
} from '../../src/services/newsletters/recipients.js';
import {
  addSuppression,
  listSuppressions,
  removeSuppression,
  suppressedAmong,
} from '../../src/services/newsletters/suppressions.js';
import { updateUser } from '../../src/services/userService.js';

describe('recipient candidates', () => {
  beforeEach(async () => {
    await db.delete(emailSuppressions);
  });

  it('joins active accounts to identities, honors scope, skips disabled and removed rows, and names banned and pending ones', async () => {
    const seeded = await seedMultipleUsers(5);
    const members = await db.select().from(serverUsers);
    expect(members.length).toBeGreaterThanOrEqual(5);
    const [a, b, c, d, e] = members as [
      (typeof members)[number],
      (typeof members)[number],
      (typeof members)[number],
      (typeof members)[number],
      (typeof members)[number],
    ];

    await db.update(serverUsers).set({ email: 'A@Example.com' }).where(eq(serverUsers.id, a.id));
    await updateUser(b.userId, { contactEmail: 'Contact@Example.com' });
    await db.update(users).set({ role: 'disabled' }).where(eq(users.id, c.userId));
    await db.update(users).set({ banned: true }).where(eq(users.id, d.userId));
    await db.update(users).set({ role: 'pending' }).where(eq(users.id, e.userId));

    const all = await loadCandidates([]);
    const byUser = new Map(all.map((cand) => [cand.userId, cand]));
    expect(byUser.get(a.userId)?.accountEmails).toEqual(['A@Example.com']);
    expect(byUser.get(a.userId)?.blocked).toBeNull();
    expect(byUser.get(b.userId)?.contactEmail).toBe('contact@example.com');
    expect(byUser.has(c.userId)).toBe(false);
    expect(byUser.get(d.userId)?.blocked).toBe('banned');
    expect(byUser.get(e.userId)?.blocked).toBe('pending');
    expect(byUser.get(a.userId)?.serverUserId).toBe(a.id);

    await db.update(serverUsers).set({ removedAt: new Date() }).where(eq(serverUsers.id, a.id));
    const afterRemoval = await loadCandidates([]);
    expect(afterRemoval.some((cand) => cand.userId === a.userId)).toBe(false);

    const scoped = await loadCandidates(['00000000-0000-4000-8000-000000000000']);
    expect(scoped).toEqual([]);
    expect(seeded).toBeDefined();
  });

  it('carries the username and server name onto a missing-address person, for a Jellyfin account with no identity name', async () => {
    const [jellyfin] = await db
      .insert(servers)
      .values({
        name: 'Basement Jellyfin',
        type: 'jellyfin',
        url: 'http://localhost:8096',
        token: 'tok',
      })
      .returning();
    const [identity] = await db
      .insert(users)
      .values({ username: 'garry-login', name: null, role: 'member' })
      .returning();
    await db.insert(serverUsers).values({
      userId: identity!.id,
      serverId: jellyfin!.id,
      externalId: 'jf-user-1',
      username: 'garry',
    });

    const candidates = await loadCandidates([]);
    const candidate = candidates.find((c) => c.userId === identity!.id);
    expect(candidate?.username).toBe('garry');
    expect(candidate?.serverName).toBe('Basement Jellyfin');

    const { missing } = mergeRecipients(candidates, [], new Set());
    const person = missing.find((p) => p.userId === identity!.id);
    expect(person).toMatchObject({
      name: null,
      username: 'garry',
      serverId: jellyfin!.id,
      serverName: 'Basement Jellyfin',
    });
  });

  it('addresses a person by their Plex email ahead of an older Jellyfin account whose username is an email', async () => {
    const [plex] = await db
      .insert(servers)
      .values({ name: 'Rank Plex', type: 'plex', url: 'http://localhost:32402', token: 'tok' })
      .returning();
    const [jellyfin] = await db
      .insert(servers)
      .values({
        name: 'Rank Jellyfin',
        type: 'jellyfin',
        url: 'http://localhost:8098',
        token: 'tok',
      })
      .returning();
    const [both, jellyfinOnly] = await db
      .insert(users)
      .values([
        { username: 'rank-both', name: null, role: 'member' },
        { username: 'rank-jellyfin', name: null, role: 'member' },
      ])
      .returning();
    await db.insert(serverUsers).values([
      {
        userId: both!.id,
        serverId: jellyfin!.id,
        externalId: 'jf-rank-both',
        username: 'both@jellyfin.example',
        email: 'both@jellyfin.example',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        userId: both!.id,
        serverId: plex!.id,
        externalId: 'plex-rank-both',
        username: 'rankplex',
        email: 'both@plex.example',
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
      {
        userId: jellyfinOnly!.id,
        serverId: jellyfin!.id,
        externalId: 'jf-rank-only',
        username: 'only@jellyfin.example',
        email: 'only@jellyfin.example',
      },
    ]);

    const candidates = (await loadCandidates([])).filter((c) =>
      [both!.id, jellyfinOnly!.id].includes(c.userId)
    );
    const { recipients } = mergeRecipients(candidates, [], new Set());

    expect(Object.fromEntries(recipients.map((r) => [r.address, r.addressFromUsername]))).toEqual({
      'both@plex.example': false,
      'only@jellyfin.example': true,
    });
  });

  it("orders an identity's account emails by the account's own age", async () => {
    const seeded = await seedBasicOwner();
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-06-01T00:00:00Z');
    const [second] = await db
      .insert(servers)
      .values({ name: 'Second Plex', type: 'plex', url: 'http://localhost:32401', token: 'tok' })
      .returning();
    // The younger account is the one already in the table, so row order alone would answer wrong.
    await db
      .update(serverUsers)
      .set({ email: 'newer@example.com', createdAt: newer })
      .where(eq(serverUsers.userId, seeded.userId));
    await db.insert(serverUsers).values({
      userId: seeded.userId,
      serverId: second!.id,
      externalId: 'plex-user-2',
      username: 'testowner',
      email: 'older@example.com',
      createdAt: older,
    });

    const candidate = (await loadCandidates([])).find((c) => c.userId === seeded.userId);
    expect(candidate?.accountEmails).toEqual(['older@example.com', 'newer@example.com']);
    expect(candidate?.serverIds).toEqual([second!.id, seeded.serverId]);
  });

  it('marks members the latest delivered send missed, past test and failed sends, and never an extra address', async () => {
    const [server] = await db
      .insert(servers)
      .values({ name: 'Den Plex', type: 'plex', url: 'http://localhost:32402', token: 'tok' })
      .returning();
    const [regular, newcomer] = await db
      .insert(users)
      .values([
        { username: 'regular', role: 'member' },
        { username: 'newcomer', role: 'member' },
      ])
      .returning();
    await db.insert(serverUsers).values([
      {
        userId: regular!.id,
        serverId: server!.id,
        externalId: 'den-1',
        username: 'regular',
        email: 'regular@example.com',
      },
      {
        userId: newcomer!.id,
        serverId: server!.id,
        externalId: 'den-2',
        username: 'newcomer',
        email: 'newcomer@example.com',
      },
    ]);
    const [newsletter] = await db
      .insert(newsletters)
      .values({
        name: 'Den weekly',
        schedule: { kind: 'daily', time: '08:00' },
        timezone: 'UTC',
        window: { kind: 'fixed', days: 7 },
        scope: { serverIds: [server!.id], libraries: [] },
        sections: DEFAULT_NEWSLETTER_SECTIONS,
        subject: 's',
        recipients: {
          members: true,
          extraAddresses: [{ address: 'friend@example.com' }],
          excludeUserIds: [],
        },
      })
      .returning();
    const marks = async () =>
      Object.fromEntries(
        (await resolveRecipients(newsletter!, newsletter!.id)).recipients.map((r) => [
          r.address,
          r.newSinceLastSend,
        ])
      );
    expect(await marks()).toEqual({
      'regular@example.com': false,
      'newcomer@example.com': false,
      'friend@example.com': false,
    });

    const recordSend = async (
      trigger: 'manual' | 'test',
      outcome: 'sent' | 'failed',
      day: number,
      userIds: (string | null)[]
    ) => {
      const [send] = await db
        .insert(newsletterSends)
        .values({
          newsletterId: newsletter!.id,
          trigger,
          outcome,
          windowStart: new Date('2026-08-26T00:00:00Z'),
          windowEnd: new Date('2026-09-02T00:00:00Z'),
          startedAt: new Date(Date.UTC(2026, 8, day)),
        })
        .returning();
      await db.insert(newsletterSendRecipients).values(
        userIds.map((userId, i) => ({
          sendId: send!.id,
          address: `r${i}@example.com`,
          userId,
          variantKey: '',
          status: outcome,
        }))
      );
    };
    await recordSend('manual', 'sent', 1, [regular!.id, null]);
    await recordSend('manual', 'failed', 2, [regular!.id, newcomer!.id]);
    await recordSend('test', 'sent', 3, [null]);
    expect(await marks()).toEqual({
      'regular@example.com': false,
      'newcomer@example.com': true,
      'friend@example.com': false,
    });
  });

  it('suppressions are lowercased, idempotent, and queryable by set', async () => {
    await addSuppression('Gone@Example.com', 'manual');
    await addSuppression('gone@example.com', 'unsubscribed');
    const [row] = await db
      .insert(newsletters)
      .values({
        name: 'Weekly',
        schedule: { kind: 'daily', time: '08:00' },
        timezone: 'UTC',
        window: { kind: 'fixed', days: 7 },
        scope: { serverIds: [], libraries: [] },
        sections: DEFAULT_NEWSLETTER_SECTIONS,
        subject: 's',
        recipients: { members: true, extraAddresses: [], excludeUserIds: [] },
      })
      .returning();
    const [send] = await db
      .insert(newsletterSends)
      .values({
        newsletterId: row!.id,
        trigger: 'schedule',
        windowStart: new Date('2026-08-26T00:00:00Z'),
        windowEnd: new Date('2026-09-02T00:00:00Z'),
        outcome: 'sent',
      })
      .returning();
    await addSuppression('left@example.com', 'unsubscribed', send!.id);
    const list = await listSuppressions();
    expect(list.map((s) => [s.address, s.reason, s.sourceSendId, s.sourceNewsletterId])).toEqual([
      ['left@example.com', 'unsubscribed', send!.id, row!.id],
      ['gone@example.com', 'manual', null, null],
    ]);
    expect(await suppressedAmong(['GONE@example.com', 'stay@example.com'])).toEqual(
      new Set(['gone@example.com'])
    );
    expect(await removeSuppression('gone@example.com')).toBe(true);
    expect(await removeSuppression('gone@example.com')).toBe(false);
  });
});
