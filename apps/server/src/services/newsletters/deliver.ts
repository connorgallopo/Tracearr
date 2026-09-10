import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { POSTER_IMAGE_SIZE } from '@tracearr/shared';
import type { PosterRef } from '../../db/schema.js';
import { proxyImage } from '../imageProxy.js';
import { getDestination, readConfig, rewrapConfig } from '../notifications/destinationStore.js';
import type { EmailAttachment, EmailConfig } from '../notifications/destinations/email.js';
import {
  describeSmtpError,
  getTransporter,
  smtpExtraHeaders,
} from '../notifications/destinations/emailTransport.js';
import { getEmailBranding } from '../notifications/emailBranding.js';
import { readLogoPng } from '../notifications/emailLogo.js';
import { getNetworkSettings } from '../settings.js';
import { announceSendFinished } from './events.js';
import { signUnsubscribeToken } from './links.js';
import {
  UNSUBSCRIBE_PLACEHOLDER,
  VIEW_PLACEHOLDER,
  resolveImageMode,
  substitutePosterRefs,
} from './render.js';
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

const CONNECTION_STAGE = /^(Connection timeout|Greeting never received)$/;
const DROPPED_SESSION = /ECONNRESET|EPIPE/;

/** nodemailer reports a session that stopped answering as ETIMEDOUT "Timeout" or ESOCKET; connect and greeting timeouts carry their own messages and never reached DATA. */
function mayHaveAccepted(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  if (code === 'ETIMEDOUT') return !CONNECTION_STAGE.test(error.message);
  if (code === 'ESOCKET') return DROPPED_SESSION.test(error.message);
  return false;
}

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

async function openTransport(ctx: DeliveryContext): Promise<{ id: string; config: EmailConfig }> {
  const destination = ctx.send.destinationId ? await getDestination(ctx.send.destinationId) : null;
  if (!destination || destination.type !== 'email' || !destination.enabled) {
    throw new UnrecoverableError('The email destination is missing or disabled');
  }
  const opened = readConfig(destination);
  if (!opened.ok) throw new UnrecoverableError('The email destination needs its secret re-entered');
  if (opened.rewrap) await rewrapConfig(destination.id, opened.config);
  const config = opened.config as Partial<EmailConfig>;
  if (typeof config.host !== 'string' || typeof config.fromAddress !== 'string') {
    throw new UnrecoverableError('The email destination is missing its host or from address');
  }
  return { id: destination.id, config: config as EmailConfig };
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
  const snapshot = ctx.snapshot;
  if (!snapshot) throw new UnrecoverableError('The send has no rendered snapshot');
  const transport = await openTransport(ctx);
  const { externalUrl } = await getNetworkSettings();
  const base = externalUrl?.replace(/\/$/, '') ?? null;
  const links = base
    ? {
        unsubscribe: `${base}/api/v1/email/unsubscribe/${signUnsubscribeToken(ctx.recipient.id)}`,
        view: `${base}/api/v1/newsletters/view/${snapshot.viewToken}`,
      }
    : null;
  if (
    !links &&
    (snapshot.html.includes(UNSUBSCRIBE_PLACEHOLDER) || snapshot.html.includes(VIEW_PLACEHOLDER))
  ) {
    throw new UnrecoverableError('The external URL was removed after this send was rendered');
  }

  const mode = resolveImageMode(ctx.newsletter.imageMode, externalUrl);
  let html = substitutePosterRefs(snapshot.html, snapshot.posters, mode, externalUrl);
  let text = snapshot.text;
  const cid =
    mode === 'inline'
      ? Object.fromEntries(
          Object.entries(snapshot.posters).filter(([cardId]) => html.includes(`cid:${cardId}`))
        )
      : {};
  if (links) {
    html = html
      .replaceAll(UNSUBSCRIBE_PLACEHOLDER, links.unsubscribe)
      .replaceAll(VIEW_PLACEHOLDER, links.view);
    text = text
      .replaceAll(UNSUBSCRIBE_PLACEHOLDER, links.unsubscribe)
      .replaceAll(VIEW_PLACEHOLDER, links.view);
  }
  const attachments: EmailAttachment[] = [];
  const logo = readLogoPng();
  if (logo && html.includes('cid:logo')) {
    attachments.push({
      filename: 'logo.png',
      cid: 'logo',
      content: logo,
      contentType: 'image/png',
    });
  }
  attachments.push(...(await posterAttachments(cid)));

  const { mailtoUnsubscribe } = await getEmailBranding();
  const listUnsubscribe = links
    ? mailtoUnsubscribe && transport.config.replyTo
      ? `<mailto:${transport.config.replyTo}?subject=unsubscribe>, <${links.unsubscribe}>`
      : `<${links.unsubscribe}>`
    : null;
  // RFC 8058 allows the one-click POST target over https only; an http external URL keeps the link and drops the header.
  const oneClick = base !== null && isHttpsUrl(base);
  const headers = {
    ...(listUnsubscribe
      ? {
          'List-Unsubscribe': listUnsubscribe,
          ...(oneClick ? { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}),
        }
      : {}),
    ...smtpExtraHeaders(transport.config),
  };

  const domain = transport.config.fromAddress.split('@')[1] ?? 'tracearr.local';
  const messageId = `<${randomUUID()}@${domain}>`;
  const attempt = await beginAttempt(ctx.recipient.id, messageId);
  if (attempt.previousMessageId && attempt.previousError === null) {
    await markRecipient(
      ctx.recipient.id,
      'unknown',
      `A previous attempt was cut off after the message went out; it may have been delivered (${attempt.previousMessageId})`
    );
    if (await finalizeSend(ctx.send.id)) await announceSendFinished(ctx.send.id);
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
      subject: snapshot.subject,
      html,
      text,
      messageId,
      attachments,
      ...(Object.keys(headers).length ? { headers } : {}),
    });
  } catch (error) {
    if (mayHaveAccepted(error)) {
      await markRecipient(
        ctx.recipient.id,
        'unknown',
        `The server stopped answering after the message went out; it may have been delivered (${messageId})`
      );
      if (await finalizeSend(ctx.send.id)) await announceSendFinished(ctx.send.id);
      return;
    }
    const message = describeSmtpError(error, transport.config);
    await noteRecipientError(ctx.recipient.id, message);
    throw new Error(message, { cause: error });
  }
  await markRecipient(ctx.recipient.id, 'sent');
  if (await finalizeSend(ctx.send.id)) await announceSendFinished(ctx.send.id);
}

/** Called by the worker once the attempts are spent, so the row and the send both close. */
export async function markRecipientFailed(recipientId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await markRecipient(recipientId, 'failed', message.slice(0, 500));
  const ctx = await loadDelivery(recipientId);
  if (ctx && (await finalizeSend(ctx.send.id))) await announceSendFinished(ctx.send.id);
}
