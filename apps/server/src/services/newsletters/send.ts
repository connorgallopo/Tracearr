import type { NewsletterSendTrigger, NewsletterSendVariant } from '@tracearr/shared';
import type { PosterRef } from '../../db/schema.js';
import { getDestination } from '../notifications/destinationStore.js';
import { resolveEmailBranding } from '../notifications/emailBranding.js';
import { getNetworkSettings } from '../settings.js';
import type { DigestData } from './assemble.js';
import { announceSendFinished } from './events.js';
import { NO_TRIM } from './fit.js';
import { newViewToken } from './links.js';
import { resolveRecipients } from './recipients.js';
import {
  OpenSendConflict,
  closeStaleSend,
  findOpenSend,
  getNewsletter,
  insertRecipients,
  insertSend,
  insertSnapshots,
  lastWatermark,
  loadServerLinks,
  markSendOutcome,
  markSendSending,
  queuedRecipientIds,
  type NewSnapshot,
  type NewsletterRow,
} from './store.js';
import { assembleVariant, renderVariant, type VariantRenderContext } from './variantRender.js';
import { orderServers, planVariants, testVariantPlan, variantFor } from './variants.js';
import { computeWindow } from './window.js';

export interface RunResult {
  outcome: 'queued' | 'resumed' | 'skipped_empty' | 'failed' | 'busy';
  sendId: string | null;
  queuedRecipientIds: string[];
}

async function transportProblem(newsletter: NewsletterRow): Promise<string | null> {
  if (!newsletter.destinationId) return 'No email destination is set';
  const destination = await getDestination(newsletter.destinationId);
  if (!destination || destination.type !== 'email') return 'The email destination no longer exists';
  if (!destination.enabled) return 'The email destination is disabled';
  if (destination.configStatus !== 'ok') return 'The email destination needs its secret re-entered';
  return null;
}

async function resume(
  newsletterId: string,
  trigger: NewsletterSendTrigger
): Promise<RunResult | null> {
  const open = await findOpenSend(newsletterId);
  if (!open) return null;
  if (await closeStaleSend(open)) {
    await announceSendFinished(open.id);
    return null;
  }
  // A rendering send has no full recipient list yet; handing out the partial one burns those job ids so the run that owns the send can never enqueue them.
  if (trigger === 'test' || open.outcome === 'rendering')
    return { outcome: 'busy', sendId: open.id, queuedRecipientIds: [] };
  return {
    outcome: 'resumed',
    sendId: open.id,
    queuedRecipientIds: await queuedRecipientIds(open.id),
  };
}

interface RecipientRowInput {
  address: string;
  userId: string | null;
  status: 'queued' | 'suppressed';
  variantKey: string;
}

export async function runNewsletter(
  newsletterId: string,
  trigger: NewsletterSendTrigger,
  testAddress?: string,
  testVariantKey?: string
): Promise<RunResult> {
  const newsletter = await getNewsletter(newsletterId);
  if (!newsletter) return { outcome: 'failed', sendId: null, queuedRecipientIds: [] };

  const open = await resume(newsletterId, trigger);
  if (open) return open;

  const now = new Date();
  const window = computeWindow(newsletter.window, await lastWatermark(newsletterId), now);
  const base = {
    newsletterId,
    destinationId: newsletter.destinationId,
    trigger,
    windowStart: window.start,
    windowEnd: window.end,
  };

  const problem = await transportProblem(newsletter);
  if (problem) {
    const send = await insertSend({ ...base, itemCounts: {}, outcome: 'failed', error: problem });
    await announceSendFinished(send.id);
    return { outcome: 'failed', sendId: send.id, queuedRecipientIds: [] };
  }

  const skipEmpty = newsletter.skipWhenEmpty && trigger !== 'test';
  const done = (result: RunResult) => ({ done: result });
  const prepare = async () => {
    const [{ externalUrl }, links, branding] = await Promise.all([
      getNetworkSettings(),
      loadServerLinks(newsletter.scope.serverIds),
      resolveEmailBranding(),
    ]);
    const servers = orderServers(newsletter.scope, links);
    const ctx: VariantRenderContext = {
      newsletter,
      window,
      externalUrl,
      branding,
      servers,
      memberSend: trigger !== 'test',
    };

    // The union (or the one test variant) is assembled first: its counts are the send's, and an empty whole scope skips before anyone is resolved.
    const testPlan = testAddress ? testVariantPlan(servers, testAddress, testVariantKey) : null;
    const primary =
      testPlan?.variants[0] ??
      variantFor(
        servers,
        servers.map((s) => s.id),
        []
      );
    const assembled = new Map<string, { data: DigestData; posters: Record<string, PosterRef> }>();
    const primaryDigest = await assembleVariant(ctx, primary);
    assembled.set(primary.key, primaryDigest);
    if (primaryDigest.data.isEmpty && skipEmpty) {
      const send = await insertSend({
        ...base,
        itemCounts: primaryDigest.data.counts,
        outcome: 'skipped_empty',
      });
      return done({ outcome: 'skipped_empty', sendId: send.id, queuedRecipientIds: [] });
    }

    const plan = testPlan ?? planVariants(servers, await resolveRecipients(newsletter));
    const populated = plan.variants.filter((v) => v.recipients.length > 0);
    if (!populated.some((v) => v.recipients.some((r) => !r.suppressed))) {
      const send = await insertSend({
        ...base,
        itemCounts: primaryDigest.data.counts,
        outcome: 'failed',
        error: 'No deliverable recipients',
      });
      await announceSendFinished(send.id);
      return done({ outcome: 'failed', sendId: send.id, queuedRecipientIds: [] });
    }

    const variants: NewsletterSendVariant[] = [];
    const snapshots: NewSnapshot[] = [];
    const recipientRows: RecipientRowInput[] = [];
    for (const variant of populated) {
      const digest = assembled.get(variant.key) ?? (await assembleVariant(ctx, variant));
      const recipientCount = variant.recipients.filter((r) => !r.suppressed).length;
      const record = {
        key: variant.key,
        serverIds: variant.serverIds,
        serverNames: variant.serverNames,
        recipientCount,
      };
      if (digest.data.isEmpty && skipEmpty) {
        variants.push({ ...record, trimmed: NO_TRIM, bytes: 0, empty: true });
        continue;
      }
      const rendered = await renderVariant(ctx, variant, digest.data, digest.posters);
      variants.push({
        ...record,
        trimmed: rendered.fit.trimmed,
        bytes: rendered.fit.bytes,
        empty: false,
      });
      snapshots.push({
        variantKey: variant.key,
        viewToken: newViewToken(),
        subject: rendered.subject,
        html: rendered.fit.rendered.html,
        text: rendered.fit.rendered.text,
        posters: digest.posters,
      });
      recipientRows.push(
        ...variant.recipients.map((r) => ({
          address: r.address,
          userId: r.userId,
          status: r.suppressed ? ('suppressed' as const) : ('queued' as const),
          variantKey: variant.key,
        }))
      );
    }
    if (snapshots.length === 0) {
      // Something is new somewhere, but nothing on the servers anyone here belongs to.
      const send = await insertSend({
        ...base,
        itemCounts: primaryDigest.data.counts,
        outcome: 'skipped_empty',
        variants,
      });
      return done({ outcome: 'skipped_empty', sendId: send.id, queuedRecipientIds: [] });
    }
    return { counts: primaryDigest.data.counts, variants, snapshots, recipientRows };
  };

  let ready;
  try {
    ready = await prepare();
  } catch (error) {
    try {
      const failed = await insertSend({
        ...base,
        itemCounts: {},
        outcome: 'failed',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
      await announceSendFinished(failed.id);
    } catch {
      // The queue's failure record keeps the original error.
    }
    throw error;
  }
  if ('done' in ready) return ready.done;
  const { counts, variants, snapshots, recipientRows } = ready;

  let send;
  try {
    send = await insertSend({ ...base, itemCounts: counts, outcome: 'rendering', variants });
  } catch (error) {
    if (error instanceof OpenSendConflict) {
      const raced = await resume(newsletterId, trigger);
      if (raced) return raced;
    }
    throw error;
  }

  try {
    await insertSnapshots(send.id, snapshots);
    const rows = await insertRecipients(send.id, recipientRows);
    const queued = rows.filter((r) => r.status === 'queued').map((r) => r.id);
    await markSendSending(send.id, queued.length);
    return { outcome: 'queued', sendId: send.id, queuedRecipientIds: queued };
  } catch (error) {
    await markSendOutcome(
      send.id,
      'failed',
      error instanceof Error ? error.message : String(error)
    );
    await announceSendFinished(send.id);
    throw error;
  }
}
