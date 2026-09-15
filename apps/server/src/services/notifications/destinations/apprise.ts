import { DESTINATION_TYPES } from '@tracearr/shared';
import { formatPluginUpdateMessage } from '../formatters/pluginUpdate.js';
import { formatServerUpdateMessage, formatTracearrUpdateMessage } from '../formatters/updates.js';
import { formatViolationMessage } from '../formatters/violation.js';
import { toNotificationPayload } from '../types.js';
import { deliverFetch } from './fetch.js';
import { ownText, textOf } from './overrides.js';
import { formatDuration, getMediaDisplay, getUserDisplayName } from './sessionText.js';
import type {
  NotificationPayload,
  PluginUpdateContext,
  ServerContext,
  ServerUpdateContext,
  SessionContext,
  TracearrUpdateContext,
  ViolationContext,
} from '../types.js';
import type { DeliverContext, DestinationType } from './types.js';

export interface AppriseConfig {
  url: string;
}

export type AppriseType = 'info' | 'success' | 'warning' | 'failure';

export interface AppriseMessage {
  title: string;
  body: string;
  type: AppriseType;
}

function severityToType(severity: string): AppriseType {
  const map: Record<string, AppriseType> = {
    high: 'failure',
    warning: 'warning',
    low: 'info',
  };
  return map[severity] ?? 'info';
}

function buildViolation(payload: NotificationPayload, ctx: ViolationContext): AppriseMessage {
  const text = textOf(payload, {
    title: payload.title,
    message: formatViolationMessage(ctx.violation),
  });
  return { title: text.title, body: text.message, type: severityToType(ctx.violation.severity) };
}

function buildSessionStarted(payload: NotificationPayload, ctx: SessionContext): AppriseMessage {
  const { session } = ctx;
  const { title: mediaTitle, subtitle } = getMediaDisplay(session);
  const userName = getUserDisplayName(session);
  const mediaDisplay = subtitle ? `${mediaTitle} - ${subtitle}` : mediaTitle;

  const text = textOf(payload, {
    title: 'Stream Started',
    message: `${userName} started watching ${mediaDisplay}`,
  });
  return { title: text.title, body: text.message, type: 'info' };
}

function buildSessionStopped(payload: NotificationPayload, ctx: SessionContext): AppriseMessage {
  const { session } = ctx;
  const { title: mediaTitle, subtitle } = getMediaDisplay(session);
  const userName = getUserDisplayName(session);
  const mediaDisplay = subtitle ? `${mediaTitle} - ${subtitle}` : mediaTitle;
  const durationStr = session.durationMs ? ` (${formatDuration(session.durationMs)})` : '';

  const text = textOf(payload, {
    title: 'Stream Ended',
    message: `${userName} finished watching ${mediaDisplay}${durationStr}`,
  });
  return { title: text.title, body: text.message, type: 'info' };
}

function buildServerDown(payload: NotificationPayload, ctx: ServerContext): AppriseMessage {
  const text = textOf(payload, {
    title: 'Server Offline',
    message: `${ctx.serverName} is not responding`,
  });
  return { title: text.title, body: text.message, type: 'failure' };
}

function buildServerUp(payload: NotificationPayload, ctx: ServerContext): AppriseMessage {
  const text = textOf(payload, {
    title: 'Server Online',
    message: `${ctx.serverName} is back online`,
  });
  return { title: text.title, body: text.message, type: 'success' };
}

function buildPluginUpdate(payload: NotificationPayload, ctx: PluginUpdateContext): AppriseMessage {
  const text = textOf(payload, {
    title: 'Plugin Update Available',
    message: `${ctx.serverName}: ${formatPluginUpdateMessage(ctx)}`,
  });
  return { title: text.title, body: text.message, type: 'warning' };
}

function buildServerUpdate(payload: NotificationPayload, ctx: ServerUpdateContext): AppriseMessage {
  const text = textOf(payload, {
    title: 'Server Update Available',
    message: formatServerUpdateMessage(ctx),
  });
  return { title: text.title, body: text.message, type: 'warning' };
}

function buildTracearrUpdate(
  payload: NotificationPayload,
  ctx: TracearrUpdateContext
): AppriseMessage {
  const text = textOf(payload, {
    title: 'Tracearr Update Available',
    message: formatTracearrUpdateMessage(ctx),
  });
  return { title: text.title, body: text.message, type: 'info' };
}

function buildOwnText(payload: NotificationPayload): AppriseMessage {
  const text = ownText(payload);
  return { title: text.title, body: text.message, type: 'info' };
}

function build(payload: NotificationPayload): AppriseMessage {
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
      return buildOwnText(payload);
  }
}

async function post(url: string, body: AppriseMessage, ctx: DeliverContext): Promise<void> {
  await deliverFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    ctx
  );
}

export const appriseType: DestinationType<AppriseConfig, AppriseMessage> = {
  kind: 'apprise',
  events: DESTINATION_TYPES.apprise.events,
  render: (event, _config, ctx) => build(toNotificationPayload(event, ctx.source)),
  deliver: (body, config, ctx) => post(config.url, body, ctx),
  test: (config, ctx) =>
    post(
      config.url,
      {
        title: 'Test Notification',
        body: 'This is a test notification from Tracearr',
        type: 'info',
      },
      ctx
    ),
};
