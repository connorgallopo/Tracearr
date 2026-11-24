import {
  escapeFor,
  type DestinationTextProfile,
  type NotificationPriority,
} from '@tracearr/shared';
import { formatPluginUpdateMessage } from '../formatters/pluginUpdate.js';
import { formatServerUpdateMessage, formatTracearrUpdateMessage } from '../formatters/updates.js';
import { formatViolationMessage } from '../formatters/violation.js';
import { buildMediaLinks } from '../mediaLinks.js';
import { toNotificationPayload } from '../types.js';
import { fitted, ownText, textOf } from './overrides.js';
import {
  formatDuration,
  getMediaDisplay,
  getUserDisplayName,
  nameWithProfile,
} from './sessionText.js';
import type { NotificationEvent, NotificationSource } from '../events.js';
import type { MediaLink } from '../mediaLinks.js';
import type {
  NotificationPayload,
  NotificationSeverity,
  PluginUpdateContext,
  ServerContext,
  ServerUpdateContext,
  SessionContext,
  TracearrUpdateContext,
  ViolationContext,
} from '../types.js';

export interface TextMessage {
  title: string;
  message: string;
}

export const TEST_TEXT: TextMessage = {
  title: 'Test Notification',
  message: 'This is a test notification from Tracearr',
};

const SEVERITY_PRIORITY: Record<NotificationSeverity, NotificationPriority> = {
  low: 'low',
  warning: 'normal',
  high: 'high',
};

function buildViolation(payload: NotificationPayload, ctx: ViolationContext): TextMessage {
  return textOf(payload, {
    title: payload.title,
    message: formatViolationMessage(ctx.violation),
  });
}

function buildSessionStarted(payload: NotificationPayload, ctx: SessionContext): TextMessage {
  const { session } = ctx;
  const { title: mediaTitle, subtitle } = getMediaDisplay(session);
  const userName = nameWithProfile(getUserDisplayName(session), session.nonMainProfile);
  const mediaDisplay = subtitle ? `${mediaTitle} - ${subtitle}` : mediaTitle;

  return textOf(payload, {
    title: 'Stream Started',
    message: `${userName} started watching ${mediaDisplay}`,
  });
}

function buildSessionStopped(payload: NotificationPayload, ctx: SessionContext): TextMessage {
  const { session } = ctx;
  const { title: mediaTitle, subtitle } = getMediaDisplay(session);
  const userName = nameWithProfile(getUserDisplayName(session), session.nonMainProfile);
  const mediaDisplay = subtitle ? `${mediaTitle} - ${subtitle}` : mediaTitle;
  const durationStr = session.durationMs ? ` (${formatDuration(session.durationMs)})` : '';

  return textOf(payload, {
    title: 'Stream Ended',
    message: `${userName} finished watching ${mediaDisplay}${durationStr}`,
  });
}

function buildServerDown(payload: NotificationPayload, ctx: ServerContext): TextMessage {
  return textOf(payload, {
    title: 'Server Offline',
    message: `${ctx.serverName} is not responding`,
  });
}

function buildServerUp(payload: NotificationPayload, ctx: ServerContext): TextMessage {
  return textOf(payload, { title: 'Server Online', message: `${ctx.serverName} is back online` });
}

function buildPluginUpdate(payload: NotificationPayload, ctx: PluginUpdateContext): TextMessage {
  return textOf(payload, {
    title: 'Plugin Update Available',
    message: `${ctx.serverName}: ${formatPluginUpdateMessage(ctx)}`,
  });
}

function buildServerUpdate(payload: NotificationPayload, ctx: ServerUpdateContext): TextMessage {
  return textOf(payload, {
    title: 'Server Update Available',
    message: formatServerUpdateMessage(ctx),
  });
}

function buildTracearrUpdate(
  payload: NotificationPayload,
  ctx: TracearrUpdateContext
): TextMessage {
  return textOf(payload, {
    title: 'Tracearr Update Available',
    message: formatTracearrUpdateMessage(ctx),
  });
}

export function textFor(payload: NotificationPayload): TextMessage {
  switch (payload.context.type) {
    case 'violation_detected':
      return buildViolation(payload, payload.context);
    case 'stream_started':
      return buildSessionStarted(payload, payload.context);
    case 'stream_stopped':
      return buildSessionStopped(payload, payload.context);
    case 'server_down':
      return buildServerDown(payload, payload.context);
    case 'server_up':
      return buildServerUp(payload, payload.context);
    case 'plugin_update_available':
      return buildPluginUpdate(payload, payload.context);
    case 'server_update_available':
      return buildServerUpdate(payload, payload.context);
    case 'tracearr_update_available':
      return buildTracearrUpdate(payload, payload.context);
    case 'media_added':
    case 'media_upgraded':
    case 'new_device':
    case 'trust_score_changed':
    case 'newsletter_send':
      return ownText(payload);
  }
}

export function priorityOf(payload: NotificationPayload): NotificationPriority {
  return payload.automation?.priority ?? SEVERITY_PRIORITY[payload.severity];
}

export async function renderText(
  event: NotificationEvent,
  source: NotificationSource,
  profile: DestinationTextProfile,
  options: { links?: boolean } = {}
): Promise<{
  text: TextMessage;
  priority: NotificationPriority;
  links: MediaLink[];
  payload: NotificationPayload;
}> {
  const payload = toNotificationPayload(event, source, escapeFor(profile));
  const { context } = payload;
  const links =
    options.links !== false && (context.type === 'media_added' || context.type === 'media_upgraded')
      ? await buildMediaLinks(context).catch(() => [])
      : [];
  return { text: fitted(textFor(payload), profile), priority: priorityOf(payload), links, payload };
}
