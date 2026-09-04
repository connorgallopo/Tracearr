/**
 * Notification payload types shared by every destination type module.
 */

import { MEDIA_QUALITY_FIELDS } from '../automations/types.js';
import {
  formatMediaAddedMessage,
  formatMediaUpgradedMessage,
  mediaHeadline,
  parentName,
  qualityText,
} from './formatters/media.js';
import type { ViolationWithDetails, ActiveSession, NotificationEventType } from '@tracearr/shared';
import type { MediaQuality } from '../automations/types.js';
import type {
  MediaEventPayload,
  MediaUpgradedPayload,
  NewDevicePayload,
  NewsletterSendPayload,
  NotificationEvent,
  NotificationSource,
  TrustChangedPayload,
} from './events.js';

// Re-export for convenience
export type { ViolationWithDetails, ActiveSession, NotificationEventType };

/**
 * Severity levels for notifications
 */
export type NotificationSeverity = 'low' | 'warning' | 'high';

/**
 * Context provided with violation notifications
 */
export interface ViolationContext {
  type: 'violation_detected';
  violation: ViolationWithDetails;
}

/**
 * Context provided with session notifications
 */
export interface SessionContext {
  type: 'stream_started' | 'stream_stopped';
  session: ActiveSession;
}

/**
 * Context provided with server status notifications
 */
export interface ServerContext {
  type: 'server_down' | 'server_up';
  serverName: string;
  serverType?: 'plex' | 'jellyfin' | 'emby';
}

/**
 * Context provided with plugin update notifications
 */
export interface PluginUpdateContext {
  type: 'plugin_update_available';
  serverId: string;
  serverName: string;
  serverType: string;
  installedVersion: string | null;
  latestVersion: string;
  downloadUrl: string;
}

/**
 * Context provided with media server update notifications
 */
export interface ServerUpdateContext {
  type: 'server_update_available';
  serverId: string;
  serverName: string;
  serverType: string;
  installedVersion: string;
  latestVersion: string;
  releaseUrl: string;
}

/**
 * Context provided with Tracearr release notifications
 */
export interface TracearrUpdateContext {
  type: 'tracearr_update_available';
  current: string;
  latest: string;
  releaseUrl: string;
}

/**
 * Context provided with a library item that just appeared
 */
export interface MediaAddedContext extends MediaEventPayload {
  type: 'media_added';
}

/**
 * Context provided with a library item whose quality signature moved
 */
export interface MediaUpgradedContext extends MediaUpgradedPayload {
  type: 'media_upgraded';
}

/**
 * Context provided with the first session an account ran from a device
 */
export interface NewDeviceContext extends NewDevicePayload {
  type: 'new_device';
}

/**
 * Context provided when a write moved an account's trust score
 */
export interface TrustChangedContext extends TrustChangedPayload {
  type: 'trust_score_changed';
}

/**
 * Context provided when a newsletter send finished
 */
export interface NewsletterSendContext extends NewsletterSendPayload {
  type: 'newsletter_send';
}

/**
 * Union of all notification contexts
 */
export type NotificationContext =
  | ViolationContext
  | SessionContext
  | ServerContext
  | PluginUpdateContext
  | ServerUpdateContext
  | TracearrUpdateContext
  | MediaAddedContext
  | MediaUpgradedContext
  | NewDeviceContext
  | TrustChangedContext
  | NewsletterSendContext;

/**
 * Unified notification payload for all agents
 */
export interface NotificationPayload {
  /** Event type identifier */
  event: NotificationEventType;

  /** Human-readable title */
  title: string;

  /** Human-readable message body */
  message: string;

  /** Severity level (affects priority in some agents) */
  severity: NotificationSeverity;

  /** ISO timestamp */
  timestamp: string;

  /** Additional context based on event type */
  context: NotificationContext;

  /** Optional image URL (e.g., poster) */
  imageUrl?: string;

  /** The automation whose send produced this, with whatever text it overrode already rendered. */
  automation?: { id: string; name: string; title?: string; message?: string };
}

/**
 * Payload builders for creating NotificationPayload from raw data
 */
export const PayloadBuilders = {
  fromViolation(violation: ViolationWithDetails): NotificationPayload {
    const userName = violation.user.identityName ?? violation.user.username;
    return {
      event: 'violation_detected',
      title: 'Violation Detected',
      message: `User ${userName} triggered a rule violation`,
      severity: violation.severity,
      timestamp: new Date().toISOString(),
      context: { type: 'violation_detected', violation },
    };
  },

  fromSessionStarted(session: ActiveSession): NotificationPayload {
    const userName = session.user.identityName ?? session.user.username;
    return {
      event: 'stream_started',
      title: 'Stream Started',
      message: `${userName} started streaming`,
      severity: 'low',
      timestamp: new Date().toISOString(),
      context: { type: 'stream_started', session },
    };
  },

  fromSessionStopped(session: ActiveSession): NotificationPayload {
    const userName = session.user.identityName ?? session.user.username;
    return {
      event: 'stream_stopped',
      title: 'Stream Stopped',
      message: `${userName} stopped streaming`,
      severity: 'low',
      timestamp: new Date().toISOString(),
      context: { type: 'stream_stopped', session },
    };
  },

  fromServerDown(
    serverName: string,
    serverType?: 'plex' | 'jellyfin' | 'emby'
  ): NotificationPayload {
    return {
      event: 'server_down',
      title: 'Server Offline',
      message: `${serverName} is not responding`,
      severity: 'high',
      timestamp: new Date().toISOString(),
      context: { type: 'server_down', serverName, serverType },
    };
  },

  fromServerUp(serverName: string, serverType?: 'plex' | 'jellyfin' | 'emby'): NotificationPayload {
    return {
      event: 'server_up',
      title: 'Server Online',
      message: `${serverName} is back online`,
      severity: 'low',
      timestamp: new Date().toISOString(),
      context: { type: 'server_up', serverName, serverType },
    };
  },

  fromServerUpdate(ctx: Omit<ServerUpdateContext, 'type'>): NotificationPayload {
    return {
      event: 'server_update_available',
      title: 'Server Update Available',
      message: `${ctx.serverName} can update from ${ctx.installedVersion} to ${ctx.latestVersion}`,
      severity: 'low',
      timestamp: new Date().toISOString(),
      context: { type: 'server_update_available', ...ctx },
    };
  },

  fromTracearrUpdate(ctx: Omit<TracearrUpdateContext, 'type'>): NotificationPayload {
    return {
      event: 'tracearr_update_available',
      title: 'Tracearr Update Available',
      message: `Tracearr ${ctx.latest} is out (running ${ctx.current})`,
      severity: 'low',
      timestamp: new Date().toISOString(),
      context: { type: 'tracearr_update_available', ...ctx },
    };
  },

  fromMediaAdded(ctx: MediaEventPayload): NotificationPayload {
    return {
      event: 'media_added',
      title: 'New media added',
      message: formatMediaAddedMessage(ctx),
      severity: 'low',
      timestamp: new Date().toISOString(),
      context: { type: 'media_added', ...ctx },
    };
  },

  fromMediaUpgraded(ctx: MediaUpgradedPayload): NotificationPayload {
    return {
      event: 'media_upgraded',
      title: 'Media upgraded',
      message: formatMediaUpgradedMessage(ctx),
      severity: 'low',
      timestamp: new Date().toISOString(),
      context: { type: 'media_upgraded', ...ctx },
    };
  },

  fromNewDevice(ctx: NewDevicePayload): NotificationPayload {
    const locationStr = ctx.location ? ` from ${ctx.location}` : '';
    return {
      event: 'new_device',
      title: 'New device',
      message: `${ctx.userName} connected from a new device: ${ctx.deviceName}${locationStr}`,
      severity: 'warning',
      timestamp: new Date().toISOString(),
      context: { type: 'new_device', ...ctx },
    };
  },

  fromTrustScoreChanged(ctx: TrustChangedPayload): NotificationPayload {
    const dropped = ctx.newScore < ctx.previousScore;
    const reasonStr = ctx.reason ? `: ${ctx.reason}` : '';
    return {
      event: 'trust_score_changed',
      title: 'Trust score changed',
      message: `${ctx.userName}'s trust score ${dropped ? 'dropped' : 'rose'} from ${String(ctx.previousScore)} to ${String(ctx.newScore)}${reasonStr}`,
      severity: dropped ? 'warning' : 'low',
      timestamp: new Date().toISOString(),
      context: { type: 'trust_score_changed', ...ctx },
    };
  },

  fromNewsletterSend(ctx: NewsletterSendPayload): NotificationPayload {
    const detail = ctx.error ? `: ${ctx.error}` : '';
    const copy = {
      sent: {
        title: 'Newsletter sent',
        message: `${ctx.name} went to ${String(ctx.recipientCount)} recipients`,
        severity: 'low' as const,
      },
      partial: {
        title: 'Newsletter partly sent',
        message: `${ctx.name} reached only part of its ${String(ctx.recipientCount)} recipients${detail}`,
        severity: 'warning' as const,
      },
      failed: {
        title: 'Newsletter failed',
        message: `${ctx.name} reached nobody${detail}`,
        severity: 'high' as const,
      },
    }[ctx.outcome];
    return {
      event: 'newsletter_send',
      ...copy,
      timestamp: new Date().toISOString(),
      context: { type: 'newsletter_send', ...ctx },
    };
  },

  fromPluginUpdate(
    serverId: string,
    serverName: string,
    serverType: string,
    installedVersion: string | null,
    latestVersion: string,
    downloadUrl: string
  ): NotificationPayload {
    const installed = installedVersion ?? 'pre-0.2.0';
    return {
      event: 'plugin_update_available',
      title: 'Plugin Update Available',
      message: `${serverName} plugin is outdated (installed ${installed}, latest ${latestVersion})`,
      severity: 'low',
      timestamp: new Date().toISOString(),
      context: {
        type: 'plugin_update_available',
        serverId,
        serverName,
        serverType,
        installedVersion,
        latestVersion,
        downloadUrl,
      },
    };
  },
};

/** Anything the payload holds that a template can name; objects and nulls render as nothing. */
function scalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function mediaVariables(payload: MediaEventPayload): Record<string, string> {
  return {
    'media.title': payload.title,
    // What a message would call the item: the show and the episode code, not a bare title.
    'media.name': mediaHeadline(payload),
    'media.show': parentName(payload) ?? '',
    'media.season': payload.parentIndex === null ? '' : String(payload.parentIndex),
    'media.episode': payload.itemIndex === null ? '' : String(payload.itemIndex),
    'media.episodeCount':
      payload.addedEpisodeCount === undefined ? '' : String(payload.addedEpisodeCount),
    'media.type': payload.mediaType,
    'media.year': payload.year === null ? '' : String(payload.year),
    'media.library': payload.libraryName,
    'media.server': payload.serverName,
    'server.name': payload.serverName,
    'server.type': payload.serverType,
  };
}

function qualityVariables(side: 'from' | 'to', quality: MediaQuality): Record<string, string> {
  return Object.fromEntries(
    MEDIA_QUALITY_FIELDS.map((field) => [
      `media.${side}.${field}`,
      qualityText(field, quality[field]),
    ])
  );
}

/** The four names every account trigger offers, however the event names the person. */
function accountVariables(payload: {
  username: string;
  identityName: string | null;
  serverName: string;
  serverType: string;
}): Record<string, string> {
  return {
    'user.username': payload.username,
    'user.identityName': payload.identityName ?? payload.username,
    'server.name': payload.serverName,
    'server.type': payload.serverType,
  };
}

/** The TRIGGERS variable vocabulary, read off whatever the event carries. */
function variablesOf(event: NotificationEvent): Record<string, string> {
  switch (event.type) {
    case 'violation': {
      const v = event.payload;
      const data = v.data ?? {};
      return {
        'user.username': v.user.username,
        'user.identityName': v.user.identityName ?? v.user.username,
        'session.mediaTitle': scalar(data.mediaTitle),
        'session.mediaType': scalar(data.mediaType),
        'server.name': v.server?.name ?? scalar(data.serverName),
        'server.type': v.server?.type ?? '',
        durationMinutes: scalar(data.durationMinutes),
        minutes: scalar(data.minutes),
        days: scalar(data.days),
      };
    }
    case 'session_started':
    case 'session_stopped': {
      const s = event.payload;
      return {
        'user.username': s.user.username,
        'user.identityName': s.user.identityName ?? s.user.username,
        'session.mediaTitle': s.mediaTitle,
        'session.mediaType': s.mediaType,
        'server.name': s.server.name,
        'server.type': s.server.type,
        durationMinutes: s.durationMs === null ? '' : String(Math.round(s.durationMs / 60_000)),
      };
    }
    case 'server_down':
    case 'server_up':
      return {
        'server.name': event.payload.serverName,
        'server.type': event.payload.serverType ?? '',
      };
    case 'plugin_update_available': {
      const p = event.payload;
      return {
        'server.name': p.serverName,
        'server.type': p.serverType,
        installedVersion: p.installedVersion ?? '',
        latestVersion: p.latestVersion,
        downloadUrl: p.downloadUrl,
      };
    }
    case 'server_update_available': {
      const p = event.payload;
      return {
        'server.name': p.serverName,
        'server.type': p.serverType,
        installedVersion: p.installedVersion,
        latestVersion: p.latestVersion,
        releaseUrl: p.releaseUrl,
      };
    }
    case 'tracearr_update_available':
      return {
        current: event.payload.current,
        latest: event.payload.latest,
        releaseUrl: event.payload.releaseUrl,
      };
    case 'media_added':
      return mediaVariables(event.payload);
    case 'media_upgraded':
      return {
        ...mediaVariables(event.payload),
        ...qualityVariables('from', event.payload.from),
        ...qualityVariables('to', event.payload.to),
      };
    case 'new_device': {
      const d = event.payload;
      return {
        ...accountVariables(d),
        'session.mediaTitle': d.mediaTitle,
        'session.mediaType': d.mediaType,
        'device.name': d.deviceName,
        'device.platform': d.platform ?? '',
        'device.product': d.product ?? '',
        'device.location': d.location ?? '',
      };
    }
    case 'trust_score_changed': {
      const t = event.payload;
      return {
        ...accountVariables(t),
        'trust.previous': String(t.previousScore),
        'trust.new': String(t.newScore),
        'trust.reason': t.reason ?? '',
      };
    }
    case 'newsletter_send': {
      const n = event.payload;
      return {
        'newsletter.name': n.name,
        'newsletter.outcome': n.outcome,
        'newsletter.recipientCount': String(n.recipientCount),
        'newsletter.error': n.error ?? '',
      };
    }
  }
}

const VARIABLE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** A name the trigger does not offer renders as nothing rather than leaving the braces in. */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(VARIABLE, (_match, name: string) => variables[name] ?? '');
}

/** One NotificationPayload per event; an automation's send may override the text. */
export function toNotificationPayload(
  event: NotificationEvent,
  source: NotificationSource
): NotificationPayload {
  const base = ((): NotificationPayload => {
    switch (event.type) {
      case 'violation':
        return PayloadBuilders.fromViolation(event.payload);
      case 'session_started':
        return PayloadBuilders.fromSessionStarted(event.payload);
      case 'session_stopped':
        return PayloadBuilders.fromSessionStopped(event.payload);
      case 'server_down':
        return PayloadBuilders.fromServerDown(event.payload.serverName, event.payload.serverType);
      case 'server_up':
        return PayloadBuilders.fromServerUp(event.payload.serverName, event.payload.serverType);
      case 'plugin_update_available': {
        const p = event.payload;
        return PayloadBuilders.fromPluginUpdate(
          p.serverId,
          p.serverName,
          p.serverType,
          p.installedVersion,
          p.latestVersion,
          p.downloadUrl
        );
      }
      case 'server_update_available':
        return PayloadBuilders.fromServerUpdate(event.payload);
      case 'tracearr_update_available':
        return PayloadBuilders.fromTracearrUpdate(event.payload);
      case 'media_added':
        return PayloadBuilders.fromMediaAdded(event.payload);
      case 'media_upgraded':
        return PayloadBuilders.fromMediaUpgraded(event.payload);
      case 'new_device':
        return PayloadBuilders.fromNewDevice(event.payload);
      case 'trust_score_changed':
        return PayloadBuilders.fromTrustScoreChanged(event.payload);
      case 'newsletter_send':
        return PayloadBuilders.fromNewsletterSend(event.payload);
    }
  })();
  if (source.kind === 'rule') {
    return { ...base, title: source.title, message: source.message };
  }
  if (source.kind !== 'automation') return base;

  const variables = variablesOf(event);
  const title = source.title === undefined ? undefined : renderTemplate(source.title, variables);
  const message = source.body === undefined ? undefined : renderTemplate(source.body, variables);
  return {
    ...base,
    title: title ?? base.title,
    message: message ?? base.message,
    automation: {
      id: source.automationId,
      name: source.automationName,
      ...(title !== undefined && { title }),
      ...(message !== undefined && { message }),
    },
  };
}
