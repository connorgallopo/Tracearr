import { dispatchNewsletterSend } from '../automations/events/producers.js';
import { getNetworkSettings } from '../settings.js';
import { getNewsletter, getSend } from './store.js';

const ANNOUNCED = new Set(['sent', 'partial', 'failed']);

/** Called after a terminal outcome is written; test sends and skipped windows stay quiet. */
export async function announceSendFinished(sendId: string): Promise<void> {
  const send = await getSend(sendId);
  if (!send || send.trigger === 'test' || !ANNOUNCED.has(send.outcome)) return;
  const newsletter = await getNewsletter(send.newsletterId);
  if (!newsletter) return;
  const { externalUrl } = await getNetworkSettings();
  const base = externalUrl?.replace(/\/$/, '') ?? null;
  await dispatchNewsletterSend({
    newsletterId: newsletter.id,
    sendId: send.id,
    name: newsletter.name,
    outcome: send.outcome as 'sent' | 'partial' | 'failed',
    trigger: send.trigger,
    recipientCount: send.recipientCount,
    itemCounts: send.itemCounts,
    error: send.error,
    windowStart: send.windowStart.toISOString(),
    windowEnd: send.windowEnd.toISOString(),
    historyUrl: base ? `${base}/settings/notifications/newsletters/${newsletter.id}` : null,
  });
}
