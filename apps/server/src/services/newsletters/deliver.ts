import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { POSTER_IMAGE_SIZE } from '@tracearr/shared';
import type { PosterRef } from '../../db/schema.js';
import { proxyImage } from '../imageProxy.js';
import { getDestination, readConfig } from '../notifications/destinationStore.js';
import type { EmailAttachment, EmailConfig } from '../notifications/destinations/email.js';
import { describeSmtpError, getTransporter } from '../notifications/destinations/emailTransport.js';
import { readLogoPng } from '../notifications/emailLogo.js';
import { getNetworkSettings } from '../settings.js';
import { signUnsubscribeToken } from './links.js';
import { resolveImageMode, substitutePosterRefs } from './render.js';
import {
  beginAttempt,
  finalizeSend,
  loadDelivery,
  markRecipient,
  noteRecipientError,
  type DeliveryContext,
} from './store.js';

export interface DeliveryJob {
  sendId: string;
  recipientId: string;
}

const PLACEHOLDER = '{{unsubscribe_url}}';
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKET']);

function isTimeoutClass(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
  if (code && TIMEOUT_CODES.has(code)) return true;
  return error instanceof Error && /timeout/i.test(error.message);
}

async function openTransport(ctx: DeliveryContext): Promise<{ id: string; config: EmailConfig }> {
  const destination = ctx.send.destinationId ? await getDestination(ctx.send.destinationId) : null;
  if (!destination || destination.type !== 'email' || !destination.enabled) {
    throw new UnrecoverableError('The email destination is missing or disabled');
  }
  const opened = readConfig(destination);
  if (!opened.ok) throw new UnrecoverableError('The email destination needs its secret re-entered');
  return { id: destination.id, config: opened.config as unknown as EmailConfig };
}

async function posterAttachments(posters: Record<string, PosterRef>): Promise<EmailAttachment[]> {
  const out: EmailAttachment[] = [];
  for (const [cardId, ref] of Object.entries(posters)) {
    try {
      const result = await proxyImage({
        serverId: ref.serverId,
        imagePath: ref.thumbPath,
        ...POSTER_IMAGE_SIZE,
        fallback: 'poster',
        version: ref.version,
      });
      if (!result.contentType.startsWith('image/') || result.contentType.includes('svg')) continue;
      const ext = result.contentType.includes('png')
        ? 'png'
        : result.contentType.includes('webp')
          ? 'webp'
          : 'jpg';
      out.push({
        filename: `${cardId}.${ext}`,
        cid: cardId,
        content: result.data,
        contentType: result.contentType,
      });
    } catch {
      // A poster that cannot be read now ships as no image, never as a failed delivery.
    }
  }
  return out;
}

export async function deliverRecipient(job: DeliveryJob): Promise<void> {
  const ctx = await loadDelivery(job.recipientId);
  if (!ctx || ctx.recipient.status !== 'queued' || ctx.send.outcome !== 'sending') return;
  if (ctx.send.html === null || ctx.send.text === null) {
    throw new UnrecoverableError('The send has no rendered snapshot');
  }
  const transport = await openTransport(ctx);
  const { externalUrl } = await getNetworkSettings();
  const base = externalUrl?.replace(/\/$/, '') ?? null;
  const unsubscribeUrl = base
    ? `${base}/api/v1/email/unsubscribe/${signUnsubscribeToken(ctx.recipient.id)}`
    : null;

  const mode = resolveImageMode(ctx.newsletter.imageMode, externalUrl);
  const cid = mode === 'inline' ? ctx.send.posters : {};
  let html = substitutePosterRefs(ctx.send.html, ctx.send.posters, mode, externalUrl);
  let text = ctx.send.text;
  if (unsubscribeUrl) {
    html = html.replaceAll(PLACEHOLDER, unsubscribeUrl);
    text = text.replaceAll(PLACEHOLDER, unsubscribeUrl);
  }
  const attachments: EmailAttachment[] = [];
  const logo = readLogoPng();
  // logoRef is set unconditionally by send.ts whenever a logo exists, so
  // Layout always embeds cid:logo when there is one to attach.
  if (logo)
    attachments.push({
      filename: 'logo.png',
      cid: 'logo',
      content: logo,
      contentType: 'image/png',
    });
  attachments.push(...(await posterAttachments(cid)));

  const domain = transport.config.fromAddress.split('@')[1] ?? 'tracearr.local';
  const messageId = `<${randomUUID()}@${domain}>`;
  const attempt = await beginAttempt(ctx.recipient.id, messageId);
  if (
    attempt.previousMessageId &&
    attempt.previousError &&
    isTimeoutClass(new Error(attempt.previousError))
  ) {
    await markRecipient(
      ctx.recipient.id,
      'unknown',
      `A previous attempt timed out after sending; the message may have been delivered (${attempt.previousMessageId})`
    );
    await finalizeSend(ctx.send.id);
    return;
  }

  try {
    await getTransporter(transport.id, transport.config).sendMail({
      from: {
        name: transport.config.fromName || 'Tracearr',
        address: transport.config.fromAddress,
      },
      to: [ctx.recipient.address],
      ...(transport.config.replyTo ? { replyTo: transport.config.replyTo } : {}),
      subject: ctx.send.subject,
      html,
      text,
      messageId,
      attachments,
      ...(unsubscribeUrl
        ? {
            headers: {
              'List-Unsubscribe': `<${unsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          }
        : {}),
    });
  } catch (error) {
    const message = describeSmtpError(error, transport.config);
    await noteRecipientError(ctx.recipient.id, message);
    throw error instanceof Error ? error : new Error(message);
  }
  await markRecipient(ctx.recipient.id, 'sent');
  await finalizeSend(ctx.send.id);
}

/** Called by the worker once the attempts are spent, so the row and the send both close. */
export async function markRecipientFailed(recipientId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await markRecipient(recipientId, 'failed', message.slice(0, 500));
  const ctx = await loadDelivery(recipientId);
  if (ctx) await finalizeSend(ctx.send.id);
}
