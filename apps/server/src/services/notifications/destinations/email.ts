import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import {
  DESTINATION_TYPES,
  POSTER_IMAGE_SIZE,
  addressList,
  type EmailBrandingSettings,
} from '@tracearr/shared';
import { renderEvent, renderTest, type EventCard, type EventEmailInput } from '@tracearr/emails';
import { proxyImage } from '../../imageProxy.js';
import { getNetworkSettings } from '../../settings.js';
import { resolveEmailBranding } from '../emailBranding.js';
import { readLogoPng } from '../emailLogo.js';
import { mediaHeadline, mediaSubtitle, qualityMoves, qualityText } from '../formatters/media.js';
import { formatPluginUpdateMessage } from '../formatters/pluginUpdate.js';
import { formatServerUpdateMessage, formatTracearrUpdateMessage } from '../formatters/updates.js';
import { formatViolationMessage, getSeverityInfo } from '../formatters/violation.js';
import { buildMediaLinks } from '../mediaLinks.js';
import { toNotificationPayload } from '../types.js';
import {
  createTransporter,
  describeSmtpError,
  getTransporter,
  smtpExtraHeaders,
  type SmtpConfig,
} from './emailTransport.js';
import { ownText, textOf } from './overrides.js';
import { formatDuration, getMediaDisplay, getUserDisplayName } from './sessionText.js';
import type { NotificationEvent } from '../events.js';
import type { MediaAddedContext, MediaUpgradedContext, NotificationPayload } from '../types.js';
import type { DeliverContext, DestinationType, RenderContext, TestReport } from './types.js';
import type { Transporter } from 'nodemailer';

export interface EmailConfig extends SmtpConfig {
  preset?: string | null;
  fromName?: string | null;
  fromAddress: string;
  to?: string | null;
  replyTo?: string | null;
  messageStream?: string | null;
}

export interface EmailAttachment {
  filename: string;
  cid: string;
  content: Buffer;
  contentType: string;
}

export interface EmailMessage {
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
}

const POSTER_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const NO_ALERT_RECIPIENTS =
  'No alert recipients on this destination. Add one under Settings, Destinations.';

function messageId(fromAddress: string): string {
  const domain = fromAddress.split('@')[1] ?? 'tracearr.local';
  return `<${randomUUID()}@${domain}>`;
}

function logoAttachment(): EmailAttachment | null {
  const png = readLogoPng();
  return png ? { filename: 'logo.png', cid: 'logo', content: png, contentType: 'image/png' } : null;
}

/** The owner's URL needs no attachment; the Tracearr PNG rides along as a cid. */
function eventLogo(setting: EmailBrandingSettings['logo']): {
  ref: string | null;
  attachment: EmailAttachment | null;
} {
  if (setting.mode === 'url') return { ref: setting.url, attachment: null };
  const attachment = setting.mode === 'tracearr' ? logoAttachment() : null;
  return { ref: attachment ? `cid:${attachment.cid}` : null, attachment };
}

/** A placeholder svg or a failed fetch means no poster, never a failed send. */
async function fetchPoster(
  serverId: string,
  thumbPath: string | null
): Promise<EmailAttachment | null> {
  if (thumbPath === null || thumbPath === '') return null;
  try {
    const result = await proxyImage({
      serverId,
      imagePath: thumbPath,
      ...POSTER_IMAGE_SIZE,
      fallback: 'poster',
    });
    if (!result.contentType.startsWith('image/') || result.contentType.includes('svg')) return null;
    const base = result.contentType.split(';')[0]?.trim() ?? '';
    return {
      filename: `poster.${POSTER_EXTENSIONS[base] ?? 'jpg'}`,
      cid: 'poster',
      content: result.data,
      contentType: result.contentType,
    };
  } catch {
    return null;
  }
}

function qualityLines(ctx: MediaAddedContext | MediaUpgradedContext): string[] {
  if (ctx.type === 'media_upgraded') return qualityMoves(ctx).map((m) => `${m.label}: ${m.move}`);
  const video = [
    qualityText('resolution', ctx.to.resolution),
    qualityText('dynamicRange', ctx.to.dynamicRange),
    qualityText('videoCodec', ctx.to.videoCodec),
  ].filter(Boolean);
  const audio = [
    qualityText('audioCodec', ctx.to.audioCodec),
    qualityText('audioChannels', ctx.to.audioChannels),
  ].filter(Boolean);
  const lines: string[] = [];
  if (video.length > 0) lines.push(video.join(' '));
  if (audio.length > 0) lines.push(audio.join(' '));
  return lines;
}

async function mediaCard(
  ctx: MediaAddedContext | MediaUpgradedContext,
  poster: EmailAttachment | null
): Promise<EventCard> {
  const links = await buildMediaLinks(ctx).catch(() => []);
  return {
    kind: 'media',
    headline: mediaHeadline(ctx),
    subtitle: mediaSubtitle(ctx) ?? `${ctx.libraryName} on ${ctx.serverName}`,
    year: ctx.year,
    qualityLines: qualityLines(ctx),
    posterRef: poster ? `cid:${poster.cid}` : null,
    links,
  };
}

/** Title and message per event, mirroring the ntfy destination's copy. */
function textFor(payload: NotificationPayload): { title: string; message: string } {
  switch (payload.context.type) {
    case 'violation_detected':
      return textOf(payload, {
        title: payload.title,
        message: formatViolationMessage(payload.context.violation),
      });
    case 'stream_started': {
      const { session } = payload.context;
      const { title, subtitle } = getMediaDisplay(session);
      return textOf(payload, {
        title: 'Stream Started',
        message: `${getUserDisplayName(session)} started watching ${subtitle ? `${title} - ${subtitle}` : title}`,
      });
    }
    case 'stream_stopped': {
      const { session } = payload.context;
      const { title, subtitle } = getMediaDisplay(session);
      const duration = session.durationMs ? ` (${formatDuration(session.durationMs)})` : '';
      return textOf(payload, {
        title: 'Stream Ended',
        message: `${getUserDisplayName(session)} finished watching ${subtitle ? `${title} - ${subtitle}` : title}${duration}`,
      });
    }
    case 'server_down':
      return textOf(payload, {
        title: 'Server Offline',
        message: `${payload.context.serverName} is not responding`,
      });
    case 'server_up':
      return textOf(payload, {
        title: 'Server Online',
        message: `${payload.context.serverName} is back online`,
      });
    case 'plugin_update_available':
      return textOf(payload, {
        title: 'Plugin Update Available',
        message: `${payload.context.serverName}: ${formatPluginUpdateMessage(payload.context)}`,
      });
    case 'server_update_available':
      return textOf(payload, {
        title: 'Server Update Available',
        message: formatServerUpdateMessage(payload.context),
      });
    case 'tracearr_update_available':
      return textOf(payload, {
        title: 'Tracearr Update Available',
        message: formatTracearrUpdateMessage(payload.context),
      });
    case 'media_added':
    case 'media_upgraded':
    case 'new_device':
    case 'trust_score_changed':
    case 'newsletter_send':
      return ownText(payload);
  }
}

function violationCard(payload: NotificationPayload): EventCard | null {
  if (payload.context.type !== 'violation_detected') return null;
  const { violation } = payload.context;
  return {
    kind: 'facts',
    facts: [
      { label: 'User', value: violation.user.identityName ?? violation.user.username },
      { label: 'Rule', value: violation.rule.name },
      { label: 'Severity', value: getSeverityInfo(violation.severity).label },
      ...(violation.server ? [{ label: 'Server', value: violation.server.name }] : []),
    ],
  };
}

function serverNameOf(payload: NotificationPayload): string {
  const ctx = payload.context;
  if ('serverName' in ctx && typeof ctx.serverName === 'string') return ctx.serverName;
  if (ctx.type === 'violation_detected') return ctx.violation.server?.name ?? 'Tracearr';
  if (ctx.type === 'stream_started' || ctx.type === 'stream_stopped')
    return ctx.session.server.name;
  return 'Tracearr';
}

async function build(event: NotificationEvent, ctx: RenderContext): Promise<EmailMessage> {
  const payload = toNotificationPayload(event, ctx.source);
  const attachments: EmailAttachment[] = [];
  const { branding, logo: logoSetting } = await resolveEmailBranding();
  const logo = eventLogo(logoSetting);
  if (logo.attachment) attachments.push(logo.attachment);

  let card: EventCard | null = violationCard(payload);
  if (payload.context.type === 'media_added' || payload.context.type === 'media_upgraded') {
    const poster = await fetchPoster(payload.context.serverId, payload.context.thumbPath);
    if (poster) attachments.push(poster);
    card = await mediaCard(payload.context, poster);
  }

  const { title, message } = textFor(payload);
  const { externalUrl } = await getNetworkSettings();
  const input: EventEmailInput = {
    subject: card?.kind === 'media' ? `${title}: ${card.headline}` : title,
    title,
    message,
    severity: payload.severity,
    timestamp: payload.timestamp,
    card,
    logoRef: logo.ref,
    appUrl: externalUrl,
  };
  const rendered = await renderEvent(input, { ...branding, senderName: serverNameOf(payload) });
  return { ...rendered, attachments };
}

async function send(
  transporter: Transporter,
  message: EmailMessage,
  config: EmailConfig,
  to: string[]
): Promise<void> {
  const headers = smtpExtraHeaders(config);
  await transporter.sendMail({
    from: { name: config.fromName || 'Tracearr', address: config.fromAddress },
    to,
    ...(config.replyTo ? { replyTo: config.replyTo } : {}),
    subject: message.subject,
    html: message.html,
    text: message.text,
    messageId: messageId(config.fromAddress),
    attachments: message.attachments,
    ...(Object.keys(headers).length ? { headers } : {}),
  });
}

async function deliver(
  message: EmailMessage,
  config: EmailConfig,
  ctx: DeliverContext
): Promise<void> {
  const to = addressList(config.to ?? '');
  // Thrown outside the try so describeSmtpError cannot reword it as an SMTP fault.
  // UnrecoverableError sends a permanent config fault straight to the DLQ instead of retrying it.
  if (to.length === 0) throw new UnrecoverableError(NO_ALERT_RECIPIENTS);
  try {
    await send(getTransporter(ctx.destination.id, config), message, config, to);
  } catch (error) {
    throw new Error(`${ctx.destination.name}: ${describeSmtpError(error, config)}`, {
      cause: error,
    });
  }
}

/** Verify first so a bad password reads as one, then send through a transporter that is not cached. With no alert list the test goes to the sender. */
async function test(config: EmailConfig, ctx: DeliverContext): Promise<TestReport> {
  const listed = addressList(config.to ?? '');
  const to = listed.length > 0 ? listed : [config.fromAddress];
  const transporter = createTransporter(config);
  try {
    await transporter.verify();
    const { branding, logo: logoSetting } = await resolveEmailBranding();
    const logo = eventLogo(logoSetting);
    const rendered = await renderTest(
      { destinationName: ctx.destination.name, logoRef: logo.ref },
      { ...branding, senderName: 'Tracearr' }
    );
    await send(
      transporter,
      { ...rendered, attachments: logo.attachment ? [logo.attachment] : [] },
      config,
      to
    );
    return { sentTo: to.join(', ') };
  } catch (error) {
    throw new Error(describeSmtpError(error, config), { cause: error });
  } finally {
    transporter.close();
  }
}

export const emailType: DestinationType<EmailConfig, EmailMessage> = {
  kind: 'email',
  events: DESTINATION_TYPES.email.events,
  deliverTimeoutMs: 60_000,
  render: (event, _config, ctx) => build(event, ctx),
  deliver,
  test,
};
