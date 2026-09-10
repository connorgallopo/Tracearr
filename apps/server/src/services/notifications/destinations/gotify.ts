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

export interface GotifyConfig {
  url: string;
}

export interface GotifyMessage {
  title: string;
  message: string;
  priority: number;
}

function severityToPriority(severity: string): number {
  const map: Record<string, number> = { high: 5, warning: 4, low: 3 };
  return map[severity] ?? 3;
}

function buildViolation(payload: NotificationPayload, ctx: ViolationContext): GotifyMessage {
  return {
    ...textOf(payload, {
      title: payload.title,
      message: formatViolationMessage(ctx.violation),
    }),
    priority: severityToPriority(ctx.violation.severity),
  };
}

function buildSessionStarted(payload: NotificationPayload, ctx: SessionContext): GotifyMessage {
  const { session } = ctx;
  const { title: mediaTitle, subtitle } = getMediaDisplay(session);
  const userName = getUserDisplayName(session);
  const mediaDisplay = subtitle ? `${mediaTitle} - ${subtitle}` : mediaTitle;

  return {
    ...textOf(payload, {
      title: 'Stream Started',
      message: `${userName} started watching ${mediaDisplay}`,
    }),
    priority: 3,
  };
}

function buildSessionStopped(payload: NotificationPayload, ctx: SessionContext): GotifyMessage {
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
    priority: 3,
  };
}

function buildServerDown(payload: NotificationPayload, ctx: ServerContext): GotifyMessage {
  return {
    ...textOf(payload, {
      title: 'Server Offline',
      message: `${ctx.serverName} is not responding`,
    }),
    priority: 5,
  };
}

function buildServerUp(payload: NotificationPayload, ctx: ServerContext): GotifyMessage {
  return {
    ...textOf(payload, { title: 'Server Online', message: `${ctx.serverName} is back online` }),
    priority: 4,
  };
}

function buildPluginUpdate(payload: NotificationPayload, ctx: PluginUpdateContext): GotifyMessage {
  return {
    ...textOf(payload, {
      title: 'Plugin Update Available',
      message: `${ctx.serverName}: ${formatPluginUpdateMessage(ctx)}`,
    }),
    priority: 3,
  };
}

function buildServerUpdate(payload: NotificationPayload, ctx: ServerUpdateContext): GotifyMessage {
  return {
    ...textOf(payload, {
      title: 'Server Update Available',
      message: formatServerUpdateMessage(ctx),
    }),
    priority: 3,
  };
}

function buildTracearrUpdate(
  payload: NotificationPayload,
  ctx: TracearrUpdateContext
): GotifyMessage {
  return {
    ...textOf(payload, {
      title: 'Tracearr Update Available',
      message: formatTracearrUpdateMessage(ctx),
    }),
    priority: 3,
  };
}

function buildOwnText(payload: NotificationPayload): GotifyMessage {
  return { ...ownText(payload), priority: 3 };
}

function build(payload: NotificationPayload): GotifyMessage {
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

async function post(url: string, body: GotifyMessage, ctx: DeliverContext): Promise<void> {
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

export const gotifyType: DestinationType<GotifyConfig, GotifyMessage> = {
  kind: 'gotify',
  events: DESTINATION_TYPES.gotify.events,
  render: (event, _config, ctx) => build(toNotificationPayload(event, ctx.source)),
  deliver: (body, config, ctx) => post(config.url, body, ctx),
  test: (config, ctx) =>
    post(
      config.url,
      {
        title: 'Test Notification',
        message: 'This is a test notification from Tracearr',
        priority: 3,
      },
      ctx
    ),
};
