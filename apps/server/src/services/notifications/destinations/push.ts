import { DESTINATION_TYPES } from '@tracearr/shared';
import { pushNotificationService } from '../../pushNotification.js';
import { eventTypeOf } from '../events.js';
import { toNotificationPayload } from '../types.js';
import type { NotificationEvent } from '../events.js';
import type { DestinationType } from './types.js';

export interface PushOverride {
  title?: string;
  body?: string;
}

export type PushRendered =
  | { kind: 'event'; event: NotificationEvent; override?: PushOverride }
  /** These have no per-device toggle, so they carry their resolved text instead. */
  | {
      kind: 'text';
      subject: 'update' | 'library' | 'newsletter';
      title: string;
      body: string;
      data: Record<string, unknown>;
    };

const TEXT_RENDERED_EVENTS: ReadonlySet<NotificationEvent['type']> = new Set([
  'plugin_update_available',
  'server_update_available',
  'tracearr_update_available',
  'media_added',
  'media_upgraded',
  'newsletter_send',
]);

const LIBRARY_EVENTS: ReadonlySet<NotificationEvent['type']> = new Set([
  'media_added',
  'media_upgraded',
]);

export const pushType: DestinationType<Record<string, never>, PushRendered> = {
  kind: 'push',
  events: DESTINATION_TYPES.push.events,
  render(event, _config, ctx) {
    // An automation asking for these is the opt-in; nothing else produces them.
    if (ctx.source.kind === 'automation' && TEXT_RENDERED_EVENTS.has(event.type)) {
      const payload = toNotificationPayload(event, ctx.source);
      return {
        kind: 'text',
        subject:
          event.type === 'newsletter_send'
            ? 'newsletter'
            : LIBRARY_EVENTS.has(event.type)
              ? 'library'
              : 'update',
        title: payload.title,
        body: payload.message,
        // The discriminator goes last: a payload key named `type` must never replace it.
        data: { ...event.payload, type: eventTypeOf(event) },
      };
    }
    if (ctx.source.kind !== 'automation') return { kind: 'event', event };
    const { automation } = toNotificationPayload(event, ctx.source);
    const override: PushOverride = {
      ...(automation?.title !== undefined && { title: automation.title }),
      ...(automation?.message !== undefined && { body: automation.message }),
    };
    return {
      kind: 'event',
      event,
      ...(Object.keys(override).length > 0 && { override }),
    };
  },
  async deliver(rendered) {
    if (rendered.kind === 'text') {
      const { title, body, data } = rendered;
      if (rendered.subject === 'library')
        return pushNotificationService.notifyLibrary(title, body, data);
      if (rendered.subject === 'newsletter')
        return pushNotificationService.notifyNewsletter(title, body, data);
      return pushNotificationService.notifyUpdate(title, body, data);
    }
    const e = rendered.event;
    const override = rendered.override;
    switch (e.type) {
      case 'violation':
        return pushNotificationService.notifyViolation(e.payload, override);
      case 'session_started':
        return pushNotificationService.notifySessionStarted(e.payload, override);
      case 'session_stopped':
        return pushNotificationService.notifySessionStopped(e.payload, override);
      case 'server_down':
        return pushNotificationService.notifyServerDown(
          e.payload.serverName,
          e.payload.serverId,
          override
        );
      case 'server_up':
        return pushNotificationService.notifyServerUp(
          e.payload.serverName,
          e.payload.serverId,
          override
        );
      case 'new_device':
        return pushNotificationService.notifyNewDevice(e.payload, override);
      case 'trust_score_changed':
        return pushNotificationService.notifyTrustChanged(e.payload, override);
      case 'plugin_update_available':
      case 'server_update_available':
      case 'tracearr_update_available':
      case 'media_added':
      case 'media_upgraded':
      case 'newsletter_send':
        return; // an automation routes these as a text render; a system source has nowhere to go
    }
  },
  test: async () => {
    // no config to test; the route returns 400 for built-ins
  },
};
