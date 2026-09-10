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

const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';

export interface PushoverConfig {
  userKey: string;
  apiToken: string;
}

export interface PushoverMessage {
  title: string;
  message: string;
  priority: string;
}

function severityToPushoverPriority(severity: string): string {
  const map: Record<string, string> = { high: '1', warning: '0', low: '-1' };
  return map[severity] ?? '-1';
}

function buildViolation(payload: NotificationPayload, ctx: ViolationContext): PushoverMessage {
  return {
    ...textOf(payload, {
      title: payload.title,
      message: formatViolationMessage(ctx.violation),
    }),
    priority: severityToPushoverPriority(ctx.violation.severity),
  };
}

function buildSessionStarted(payload: NotificationPayload, ctx: SessionContext): PushoverMessage {
  const { session } = ctx;
  const { title: mediaTitle, subtitle } = getMediaDisplay(session);
  const userName = getUserDisplayName(session);
  const mediaDisplay = subtitle ? `${mediaTitle} - ${subtitle}` : mediaTitle;

  return {
    ...textOf(payload, {
      title: 'Stream Started',
      message: `${userName} started watching ${mediaDisplay}`,
    }),
    priority: '-1',
  };
}

function buildSessionStopped(payload: NotificationPayload, ctx: SessionContext): PushoverMessage {
  const { session } = ctx;
  const { title: mediaTitle, subtitle } = getMediaDisplay(session);
  const userName = getUserDisplayName(session);
  const mediaDisplay = subtitle ? `${mediaTitle} - ${subtitle}` : mediaTitle;
  const durationStr = session.durationMs ? ` (${formatDuration(session.durationMs)})` : '';

  return {
    ...textOf(payload, {
      title: 'Stream Ended',
      message: `${userName} finished watching ${mediaDisplay}${durationStr}`,
    }),
    priority: '-1',
  };
}

function buildServerDown(payload: NotificationPayload, ctx: ServerContext): PushoverMessage {
  return {
    ...textOf(payload, {
      title: 'Server Offline',
      message: `${ctx.serverName} is not responding`,
    }),
    priority: '1',
  };
}

function buildServerUp(payload: NotificationPayload, ctx: ServerContext): PushoverMessage {
  return {
    ...textOf(payload, { title: 'Server Online', message: `${ctx.serverName} is back online` }),
    priority: '1',
  };
}

function buildPluginUpdate(
  payload: NotificationPayload,
  ctx: PluginUpdateContext
): PushoverMessage {
  return {
    ...textOf(payload, {
      title: 'Plugin Update Available',
      message: `${ctx.serverName}: ${formatPluginUpdateMessage(ctx)}`,
    }),
    priority: '-1',
  };
}

function buildServerUpdate(
  payload: NotificationPayload,
  ctx: ServerUpdateContext
): PushoverMessage {
  return {
    ...textOf(payload, {
      title: 'Server Update Available',
      message: formatServerUpdateMessage(ctx),
    }),
    priority: '-1',
  };
}

function buildTracearrUpdate(
  payload: NotificationPayload,
  ctx: TracearrUpdateContext
): PushoverMessage {
  return {
    ...textOf(payload, {
      title: 'Tracearr Update Available',
      message: formatTracearrUpdateMessage(ctx),
    }),
    priority: '-1',
  };
}

function buildOwnText(payload: NotificationPayload): PushoverMessage {
  return { ...ownText(payload), priority: '-1' };
}

function build(payload: NotificationPayload): PushoverMessage {
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

async function post(
  config: PushoverConfig,
  body: PushoverMessage,
  ctx: DeliverContext
): Promise<void> {
  const params = new URLSearchParams({
    token: config.apiToken,
    user: config.userKey,
    title: body.title,
    message: body.message,
    priority: body.priority,
  });

  await deliverFetch(
    PUSHOVER_API_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    },
    ctx
  );
}

export const pushoverType: DestinationType<PushoverConfig, PushoverMessage> = {
  kind: 'pushover',
  events: DESTINATION_TYPES.pushover.events,
  render: (event, _config, ctx) => build(toNotificationPayload(event, ctx.source)),
  deliver: (body, config, ctx) => post(config, body, ctx),
  test: (config, ctx) =>
    post(
      config,
      {
        title: 'Test Notification',
        message: 'This is a test notification from Tracearr',
        priority: '-1',
      },
      ctx
    ),
};
