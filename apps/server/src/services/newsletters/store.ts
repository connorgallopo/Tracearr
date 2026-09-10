import { and, count, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type {
  CreateNewsletterInput,
  Newsletter,
  NewsletterRecipientStatus,
  NewsletterSendOutcome,
  NewsletterSendRecipient,
  NewsletterSendSummary,
  NewsletterSendTrigger,
  NewsletterSendVariant,
  UpdateNewsletterInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { isUniqueViolation } from '../../db/pg.js';
import {
  newsletterSendRecipients,
  newsletterSendSnapshots,
  newsletterSends,
  newsletters,
  servers,
  type PosterRef,
} from '../../db/schema.js';

export type NewsletterRow = typeof newsletters.$inferSelect;
export type SendRow = typeof newsletterSends.$inferSelect;
export type RecipientRow = typeof newsletterSendRecipients.$inferSelect;
export type SnapshotRow = typeof newsletterSendSnapshots.$inferSelect;
/** A send row plus whether any of its snapshots survive retention. */
export type SendView = SendRow & { hasSnapshot: boolean };

const sendColumns = {
  ...getTableColumns(newsletterSends),
  hasSnapshot: sql<boolean>`EXISTS (SELECT 1 FROM ${newsletterSendSnapshots} WHERE ${newsletterSendSnapshots.sendId} = ${newsletterSends.id})`,
};

const OPEN: NewsletterSendOutcome[] = ['rendering', 'sending'];
const COUNTED: NewsletterSendTrigger[] = ['schedule', 'manual'];
const WATERMARK: NewsletterSendOutcome[] = ['sent', 'partial'];
const TERMINAL: NewsletterSendOutcome[] = ['sent', 'partial', 'failed', 'skipped_empty'];

/** A send still rendering this long after it started belongs to a run that died before it queued anything. */
export const RENDERING_STALE_MS = 10 * 60_000;
/** A send still sending this long after it started has lost its delivery jobs; the rate limit bounds a real send well inside this. */
export const SENDING_STALE_MS = 6 * 60 * 60_000;

export class OpenSendConflict extends Error {
  constructor(public readonly newsletterId: string) {
    super('A send for this newsletter is already open');
  }
}

export async function listNewsletters(): Promise<NewsletterRow[]> {
  return db.select().from(newsletters).orderBy(newsletters.name);
}

export async function getNewsletter(id: string): Promise<NewsletterRow | null> {
  const [row] = await db.select().from(newsletters).where(eq(newsletters.id, id)).limit(1);
  return row ?? null;
}

export async function createNewsletter(input: CreateNewsletterInput): Promise<NewsletterRow> {
  const [row] = await db.insert(newsletters).values(input).returning();
  return row as NewsletterRow;
}

export async function updateNewsletter(
  id: string,
  patch: UpdateNewsletterInput
): Promise<NewsletterRow | null> {
  const [row] = await db
    .update(newsletters)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(newsletters.id, id))
    .returning();
  return row ?? null;
}

export async function findOpenSend(newsletterId: string): Promise<SendRow | null> {
  const [row] = await db
    .select()
    .from(newsletterSends)
    .where(
      and(eq(newsletterSends.newsletterId, newsletterId), inArray(newsletterSends.outcome, OPEN))
    )
    .limit(1);
  return row ?? null;
}

/**
 * Closes a send its run abandoned. Returns the outcome it wrote, or null when nothing
 * needed closing or a concurrent writer (another instance, or a schedule beside a manual
 * send) already closed it first - workers start on every instance with no leader gate.
 */
export async function closeStaleSend(
  open: SendRow,
  now = Date.now()
): Promise<NewsletterSendOutcome | null> {
  const age = now - open.startedAt.getTime();
  if (open.outcome === 'rendering' && age > RENDERING_STALE_MS) {
    const [row] = await db
      .update(newsletterSends)
      .set({
        outcome: 'failed',
        error: 'Interrupted before delivery started',
        finishedAt: new Date(),
      })
      .where(and(eq(newsletterSends.id, open.id), eq(newsletterSends.outcome, 'rendering')))
      .returning({ outcome: newsletterSends.outcome });
    return row?.outcome ?? null;
  }
  if (open.outcome === 'sending' && age > SENDING_STALE_MS) {
    await db
      .update(newsletterSendRecipients)
      .set({ status: 'failed', error: 'Delivery job lost' })
      .where(
        and(
          eq(newsletterSendRecipients.sendId, open.id),
          eq(newsletterSendRecipients.status, 'queued')
        )
      );
    return finalizeSend(open.id);
  }
  return null;
}

export async function deleteNewsletter(id: string): Promise<'deleted' | 'missing' | 'open_send'> {
  const open = await findOpenSend(id);
  // No announceSendFinished here: the newsletter is about to be deleted, and the event's historyUrl would 404.
  if (open && !(await closeStaleSend(open))) return 'open_send';
  const rows = await db
    .delete(newsletters)
    .where(eq(newsletters.id, id))
    .returning({ id: newsletters.id });
  return rows.length > 0 ? 'deleted' : 'missing';
}

export async function newslettersUsingDestination(destinationId: string): Promise<NewsletterRow[]> {
  return db.select().from(newsletters).where(eq(newsletters.destinationId, destinationId));
}

/** The end of the last counted window that reached anyone; a failed or test send never moves it. */
export async function lastWatermark(newsletterId: string): Promise<Date | null> {
  const [row] = await db
    .select({ end: sql<Date | null>`MAX(${newsletterSends.windowEnd})` })
    .from(newsletterSends)
    .where(
      and(
        eq(newsletterSends.newsletterId, newsletterId),
        inArray(newsletterSends.trigger, COUNTED),
        inArray(newsletterSends.outcome, WATERMARK)
      )
    );
  return row?.end ? new Date(row.end) : null;
}

export async function lastSend(newsletterId: string): Promise<SendView | null> {
  const [row] = await db
    .select(sendColumns)
    .from(newsletterSends)
    .where(eq(newsletterSends.newsletterId, newsletterId))
    .orderBy(desc(newsletterSends.startedAt))
    .limit(1);
  return row ?? null;
}

export interface NewSend {
  newsletterId: string;
  destinationId: string | null;
  trigger: NewsletterSendTrigger;
  windowStart: Date;
  windowEnd: Date;
  itemCounts: Record<string, number>;
  outcome: NewsletterSendOutcome;
  error?: string | null;
  variants?: NewsletterSendVariant[];
}

/** The partial unique index refuses a second open send; that surfaces as OpenSendConflict. */
export async function insertSend(values: NewSend): Promise<SendRow> {
  try {
    const [row] = await db
      .insert(newsletterSends)
      .values({
        ...values,
        finishedAt: TERMINAL.includes(values.outcome) ? new Date() : null,
      })
      .returning();
    return row as SendRow;
  } catch (error) {
    if (isUniqueViolation(error)) throw new OpenSendConflict(values.newsletterId);
    throw error;
  }
}

export interface NewSnapshot {
  variantKey: string;
  viewToken: string;
  subject: string;
  html: string;
  text: string;
  posters: Record<string, PosterRef>;
}

export async function insertSnapshots(sendId: string, rows: NewSnapshot[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(newsletterSendSnapshots).values(rows.map((r) => ({ ...r, sendId })));
}

export async function insertRecipients(
  sendId: string,
  rows: {
    address: string;
    userId: string | null;
    status: NewsletterRecipientStatus;
    variantKey: string;
  }[]
): Promise<RecipientRow[]> {
  const inserted: RecipientRow[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, sendId }));
    if (chunk.length === 0) continue;
    inserted.push(...(await db.insert(newsletterSendRecipients).values(chunk).returning()));
  }
  return inserted;
}

export async function markSendSending(sendId: string, recipientCount: number): Promise<void> {
  await db
    .update(newsletterSends)
    .set({ outcome: 'sending', recipientCount })
    .where(and(eq(newsletterSends.id, sendId), eq(newsletterSends.outcome, 'rendering')));
}

export async function markSendOutcome(
  sendId: string,
  outcome: NewsletterSendOutcome,
  error: string | null = null
): Promise<void> {
  await db
    .update(newsletterSends)
    .set({ outcome, error, finishedAt: TERMINAL.includes(outcome) ? new Date() : null })
    .where(eq(newsletterSends.id, sendId));
}

export async function queuedRecipientIds(sendId: string): Promise<string[]> {
  const rows = await db
    .select({ id: newsletterSendRecipients.id })
    .from(newsletterSendRecipients)
    .where(
      and(
        eq(newsletterSendRecipients.sendId, sendId),
        eq(newsletterSendRecipients.status, 'queued')
      )
    );
  return rows.map((r) => r.id);
}

export interface DeliveryContext {
  recipient: RecipientRow;
  send: SendRow;
  newsletter: NewsletterRow;
  /** Null once retention pruned it, or when the recipient's variant never rendered. */
  snapshot: SnapshotRow | null;
}

export async function loadDelivery(recipientId: string): Promise<DeliveryContext | null> {
  const [recipient] = await db
    .select()
    .from(newsletterSendRecipients)
    .where(eq(newsletterSendRecipients.id, recipientId))
    .limit(1);
  if (!recipient) return null;
  const [send] = await db
    .select()
    .from(newsletterSends)
    .where(eq(newsletterSends.id, recipient.sendId))
    .limit(1);
  if (!send) return null;
  const newsletter = await getNewsletter(send.newsletterId);
  if (!newsletter) return null;
  const snapshot = await getSnapshot(send.id, recipient.variantKey);
  return { recipient, send, newsletter, snapshot };
}

/** Records the attempt before the send goes out, so a lost reply is distinguishable from a lost connection. */
export async function beginAttempt(
  recipientId: string,
  messageId: string
): Promise<{ previousMessageId: string | null; previousError: string | null; attempts: number }> {
  const [before] = await db
    .select({
      messageId: newsletterSendRecipients.messageId,
      error: newsletterSendRecipients.error,
      attempts: newsletterSendRecipients.attempts,
    })
    .from(newsletterSendRecipients)
    .where(eq(newsletterSendRecipients.id, recipientId))
    .limit(1);
  await db
    .update(newsletterSendRecipients)
    .set({ messageId, attempts: sql`${newsletterSendRecipients.attempts} + 1` })
    .where(eq(newsletterSendRecipients.id, recipientId));
  return {
    previousMessageId: before?.messageId ?? null,
    previousError: before?.error ?? null,
    attempts: (before?.attempts ?? 0) + 1,
  };
}

export async function markRecipient(
  recipientId: string,
  status: NewsletterRecipientStatus,
  error: string | null = null
): Promise<void> {
  await db
    .update(newsletterSendRecipients)
    .set({ status, error, sentAt: status === 'sent' ? new Date() : null })
    .where(eq(newsletterSendRecipients.id, recipientId));
}

export async function noteRecipientError(recipientId: string, error: string): Promise<void> {
  await db
    .update(newsletterSendRecipients)
    .set({ error })
    .where(eq(newsletterSendRecipients.id, recipientId));
}

/** One statement, guarded by "nothing still queued", so concurrent deliveries cannot race the outcome. */
export async function finalizeSend(sendId: string): Promise<NewsletterSendOutcome | null> {
  const result = await db.execute(sql`
    UPDATE newsletter_sends AS s
    SET outcome = CASE
          WHEN c.total = 0 OR c.sent = 0 THEN 'failed'
          WHEN c.sent = c.total THEN 'sent'
          ELSE 'partial'
        END,
        finished_at = now()
    FROM (
      SELECT COUNT(*) FILTER (WHERE status = 'sent') AS sent,
             COUNT(*) FILTER (WHERE status IN ('sent', 'failed', 'unknown')) AS total,
             COUNT(*) FILTER (WHERE status = 'queued') AS queued
      FROM newsletter_send_recipients
      WHERE send_id = ${sendId}
    ) AS c
    WHERE s.id = ${sendId} AND s.outcome = 'sending' AND c.queued = 0
    RETURNING s.outcome
  `);
  const row = result.rows[0] as { outcome?: NewsletterSendOutcome } | undefined;
  return row?.outcome ?? null;
}

export async function listSends(
  newsletterId: string,
  page: number,
  pageSize: number
): Promise<{ rows: SendView[]; total: number }> {
  const [rows, [totalRow]] = await Promise.all([
    db
      .select(sendColumns)
      .from(newsletterSends)
      .where(eq(newsletterSends.newsletterId, newsletterId))
      .orderBy(desc(newsletterSends.startedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ total: count() })
      .from(newsletterSends)
      .where(eq(newsletterSends.newsletterId, newsletterId)),
  ]);
  return { rows, total: Number(totalRow?.total ?? 0) };
}

export async function getSend(sendId: string): Promise<SendView | null> {
  const [row] = await db
    .select(sendColumns)
    .from(newsletterSends)
    .where(eq(newsletterSends.id, sendId))
    .limit(1);
  return row ?? null;
}

export async function getSnapshot(sendId: string, variantKey: string): Promise<SnapshotRow | null> {
  const [row] = await db
    .select()
    .from(newsletterSendSnapshots)
    .where(
      and(
        eq(newsletterSendSnapshots.sendId, sendId),
        eq(newsletterSendSnapshots.variantKey, variantKey)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function getSnapshotByViewToken(token: string): Promise<SnapshotRow | null> {
  const [row] = await db
    .select()
    .from(newsletterSendSnapshots)
    .where(eq(newsletterSendSnapshots.viewToken, token))
    .limit(1);
  return row ?? null;
}

export async function listRecipients(sendId: string): Promise<RecipientRow[]> {
  return db
    .select()
    .from(newsletterSendRecipients)
    .where(eq(newsletterSendRecipients.sendId, sendId))
    .orderBy(newsletterSendRecipients.address);
}

/** Failed rows go back to queued with a fresh attempt budget; the send reopens so finalize can close it again. */
export async function resetFailedRecipients(sendId: string): Promise<string[]> {
  const rows = await db
    .update(newsletterSendRecipients)
    .set({ status: 'queued', attempts: 0, error: null, messageId: null })
    .where(
      and(
        eq(newsletterSendRecipients.sendId, sendId),
        eq(newsletterSendRecipients.status, 'failed')
      )
    )
    .returning({ id: newsletterSendRecipients.id });
  if (rows.length > 0) {
    await db
      .update(newsletterSends)
      .set({ outcome: 'sending', finishedAt: null })
      .where(eq(newsletterSends.id, sendId));
  }
  return rows.map((r) => r.id);
}

export interface ServerLink {
  id: string;
  name: string;
  type: string;
  url: string;
  publicUrl: string | null;
  machineIdentifier: string | null;
}

export async function loadServerLinks(serverIds: string[]): Promise<ServerLink[]> {
  const base = db
    .select({
      id: servers.id,
      name: servers.name,
      type: servers.type,
      url: servers.url,
      publicUrl: servers.publicUrl,
      machineIdentifier: servers.machineIdentifier,
    })
    .from(servers);
  return serverIds.length === 0
    ? base.orderBy(servers.name)
    : base.where(inArray(servers.id, serverIds)).orderBy(servers.name);
}

export function toSendSummary(row: SendView): NewsletterSendSummary {
  return {
    id: row.id,
    trigger: row.trigger,
    outcome: row.outcome,
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    recipientCount: row.recipientCount,
    itemCounts: row.itemCounts,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    hasSnapshot: row.hasSnapshot,
    variants: row.variants,
  };
}

export function toRecipient(row: RecipientRow): NewsletterSendRecipient {
  return {
    id: row.id,
    address: row.address,
    userId: row.userId,
    status: row.status,
    variantKey: row.variantKey,
    attempts: row.attempts,
    error: row.error,
    sentAt: row.sentAt?.toISOString() ?? null,
  };
}

export function toPublicNewsletter(
  row: NewsletterRow,
  last: SendView | null,
  nextRunAt: Date | null
): Newsletter {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    destinationId: row.destinationId,
    schedule: row.schedule,
    timezone: row.timezone,
    window: row.window,
    scope: row.scope,
    sections: row.sections,
    subject: row.subject,
    senderName: row.senderName,
    intro: row.intro,
    outro: row.outro,
    recipients: row.recipients,
    imageMode: row.imageMode,
    skipWhenEmpty: row.skipWhenEmpty,
    links: row.links,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastSend: last ? toSendSummary(last) : null,
    nextRunAt: nextRunAt?.toISOString() ?? null,
  };
}
