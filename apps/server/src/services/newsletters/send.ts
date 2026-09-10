import { resolveSenderName, type NewsletterSendTrigger } from '@tracearr/shared';
import { getDestination } from '../notifications/destinationStore.js';
import { resolveEmailBranding } from '../notifications/emailBranding.js';
import { readLogoPng } from '../notifications/emailLogo.js';
import { renderTemplate } from '../notifications/types.js';
import { getNetworkSettings } from '../settings.js';
import { assembleDigest } from './assemble.js';
import { announceSendFinished } from './events.js';
import { renderDigestToFit } from './fit.js';
import { newViewToken } from './links.js';
import { resolveRecipients, type ResolvedRecipient } from './recipients.js';
import {
  UNSUBSCRIBE_PLACEHOLDER,
  VIEW_PLACEHOLDER,
  formatWindowDate,
  logoRefFor,
  resolveImageMode,
} from './render.js';
import {
  OpenSendConflict,
  closeStaleSend,
  findOpenSend,
  getNewsletter,
  insertRecipients,
  insertSend,
  lastWatermark,
  loadServerLinks,
  markSendOutcome,
  markSendSending,
  queuedRecipientIds,
  type NewsletterRow,
} from './store.js';
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

export async function runNewsletter(
  newsletterId: string,
  trigger: NewsletterSendTrigger,
  testAddress?: string
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
    viewToken: newViewToken(),
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

  const done = (result: RunResult) => ({ done: result });
  const prepare = async () => {
    const { externalUrl } = await getNetworkSettings();
    const { data, posters } = await assembleDigest(newsletter, window);

    if (data.isEmpty && newsletter.skipWhenEmpty && trigger !== 'test') {
      const send = await insertSend({
        ...base,
        itemCounts: data.counts,
        outcome: 'skipped_empty',
        html: null,
        text: null,
      });
      return done({ outcome: 'skipped_empty', sendId: send.id, queuedRecipientIds: [] });
    }

    const recipients: ResolvedRecipient[] = testAddress
      ? [
          {
            address: testAddress.trim().toLowerCase(),
            userId: null,
            serverUserId: null,
            name: null,
            suppressed: false,
            serverId: null,
            username: null,
            serverName: null,
            thumbUrl: null,
            serverIds: [],
          },
        ]
      : (await resolveRecipients(newsletter)).recipients;

    const deliverable = recipients.filter((r) => !r.suppressed);
    if (deliverable.length === 0) {
      const send = await insertSend({
        ...base,
        itemCounts: data.counts,
        outcome: 'failed',
        error: 'No deliverable recipients',
      });
      await announceSendFinished(send.id);
      return done({ outcome: 'failed', sendId: send.id, queuedRecipientIds: [] });
    }

    const servers = await loadServerLinks(newsletter.scope.serverIds);
    const serversById = new Map(servers.map((s) => [s.id, s]));
    const senderName = resolveSenderName(
      newsletter.senderName,
      servers.map((s) => s.name)
    );
    const { branding, logo } = await resolveEmailBranding();
    const mode = resolveImageMode(newsletter.imageMode, externalUrl);
    const origin = externalUrl?.replace(/\/$/, '') ?? '';
    const itemCount = data.counts.movies + data.counts.episodes + data.counts.albums;
    const subject = renderTemplate(newsletter.subject, {
      server_name: senderName,
      start_date: formatWindowDate(window.start, newsletter.timezone),
      end_date: formatWindowDate(window.end, newsletter.timezone),
      item_count: String(itemCount),
    });
    const fit = await renderDigestToFit(
      data,
      posters,
      {
        subject,
        intro: newsletter.intro,
        outro: newsletter.outro,
        windowStart: formatWindowDate(window.start, newsletter.timezone),
        windowEnd: formatWindowDate(window.end, newsletter.timezone),
        logoRef: logoRefFor(logo, mode, origin, readLogoPng() !== null),
        unsubscribeUrl: externalUrl ? UNSUBSCRIBE_PLACEHOLDER : null,
        viewUrl: externalUrl ? VIEW_PLACEHOLDER : null,
        externalUrl,
        tracearrLinks: newsletter.links.tracearr,
        serversById,
        memberSend: trigger !== 'test',
      },
      { ...branding, senderName },
      { newsletterId, mode, externalUrl }
    );
    return {
      counts: data.counts,
      posters,
      recipients,
      deliverable,
      subject,
      rendered: fit.rendered,
    };
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
  const { counts, posters, recipients, deliverable, subject, rendered } = ready;

  let send;
  try {
    send = await insertSend({
      ...base,
      itemCounts: counts,
      outcome: 'rendering',
      subject,
      html: rendered.html,
      text: rendered.text,
      posters,
    });
  } catch (error) {
    if (error instanceof OpenSendConflict) {
      const raced = await resume(newsletterId, trigger);
      if (raced) return raced;
    }
    throw error;
  }

  try {
    const rows = await insertRecipients(
      send.id,
      recipients.map((r) => ({
        address: r.address,
        userId: r.userId,
        status: r.suppressed ? 'suppressed' : 'queued',
      }))
    );
    await markSendSending(send.id, deliverable.length);
    return {
      outcome: 'queued',
      sendId: send.id,
      queuedRecipientIds: rows.filter((r) => r.status === 'queued').map((r) => r.id),
    };
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
