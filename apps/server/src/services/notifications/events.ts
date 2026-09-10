import type {
  ActiveSession,
  NewsletterSendTrigger,
  NotificationEventType,
  ViolationWithDetails,
} from '@tracearr/shared';
import type { MediaQuality } from '../automations/types.js';

/** The SSE fallback's down timer holds only the name and id, so the type is optional. */
export interface ServerEventPayload {
  serverName: string;
  serverId: string;
  serverType?: 'plex' | 'jellyfin' | 'emby';
}

/** One library item, flat, with `to` holding the quality it ends the sync at. */
export interface MediaEventPayload {
  serverId: string;
  serverName: string;
  serverType: string;
  libraryItemId: string;
  ratingKey: string;
  /** Canonical media id, which is what Tracearr's own media page is keyed by. */
  mediaId: string | null;
  title: string;
  /** The show or artist an episode or track belongs to; null for anything standalone. */
  grandparentTitle: string | null;
  /** The season or album. On a season row this holds the show instead, which is what names it. */
  parentTitle: string | null;
  grandparentRatingKey: string | null;
  parentRatingKey: string | null;
  /** Season number on an episode or a season; null elsewhere. */
  parentIndex: number | null;
  /** Episode or track number; null elsewhere. */
  itemIndex: number | null;
  mediaType: string;
  year: number | null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  thumbPath: string | null;
  libraryName: string;
  to: MediaQuality;
  /** Set only on a season that swallowed the episodes one sync run added under it. */
  addedEpisodeCount?: number;
}

export interface MediaUpgradedPayload extends MediaEventPayload {
  from: MediaQuality;
  changed: (keyof MediaQuality)[];
}

/**
 * The account and device a first-seen device announces. 2.1's field names are kept so a
 * webhook written against it still parses; `product` and the session fields are new.
 */
export interface NewDevicePayload {
  serverId: string;
  serverName: string;
  serverType: string;
  serverUserId: string;
  sessionId: string;
  /** identityName ?? username, as 2.1 sent it. */
  userName: string;
  username: string;
  identityName: string | null;
  mediaTitle: string;
  mediaType: string;
  deviceName: string;
  platform: string | null;
  product: string | null;
  location: string | null;
}

export interface TrustChangedPayload {
  serverId: string;
  serverName: string;
  serverType: string;
  serverUserId: string;
  userName: string;
  username: string;
  identityName: string | null;
  previousScore: number;
  newScore: number;
  reason: string | null;
}

/** What a finished newsletter send announces; test sends and skipped windows announce nothing. */
export interface NewsletterSendPayload {
  newsletterId: string;
  sendId: string;
  name: string;
  outcome: 'sent' | 'partial' | 'failed';
  trigger: NewsletterSendTrigger;
  recipientCount: number;
  itemCounts: Record<string, number>;
  error: string | null;
  windowStart: string;
  windowEnd: string;
  /** The newsletter's History tab under the external URL; null when none is set. */
  historyUrl: string | null;
}

export type NotificationEvent =
  | { type: 'violation'; payload: ViolationWithDetails }
  | { type: 'session_started'; payload: ActiveSession }
  | { type: 'session_stopped'; payload: ActiveSession }
  | { type: 'server_down'; payload: ServerEventPayload }
  | { type: 'server_up'; payload: ServerEventPayload }
  | {
      type: 'plugin_update_available';
      payload: {
        serverId: string;
        serverName: string;
        serverType: string;
        installedVersion: string | null;
        latestVersion: string;
        downloadUrl: string;
      };
    }
  | {
      type: 'server_update_available';
      payload: {
        serverId: string;
        serverName: string;
        serverType: string;
        installedVersion: string;
        latestVersion: string;
        releaseUrl: string;
      };
    }
  | {
      type: 'tracearr_update_available';
      payload: { current: string; latest: string; releaseUrl: string };
    }
  | { type: 'media_added'; payload: MediaEventPayload }
  | { type: 'media_upgraded'; payload: MediaUpgradedPayload }
  | { type: 'new_device'; payload: NewDevicePayload }
  | { type: 'trust_score_changed'; payload: TrustChangedPayload }
  | { type: 'newsletter_send'; payload: NewsletterSendPayload };

/** Producers keep their discriminators; rows and the UI use NotificationEventType names. */
export const JOB_TYPE_TO_EVENT_TYPE: Record<NotificationEvent['type'], NotificationEventType> = {
  violation: 'violation_detected',
  session_started: 'stream_started',
  session_stopped: 'stream_stopped',
  server_down: 'server_down',
  server_up: 'server_up',
  plugin_update_available: 'plugin_update_available',
  server_update_available: 'server_update_available',
  tracearr_update_available: 'tracearr_update_available',
  media_added: 'media_added',
  media_upgraded: 'media_upgraded',
  new_device: 'new_device',
  trust_score_changed: 'trust_score_changed',
  newsletter_send: 'newsletter_send',
};

export function eventTypeOf(event: NotificationEvent): NotificationEventType {
  return JOB_TYPE_TO_EVENT_TYPE[event.type];
}

/**
 * An automation's send names itself and may override the text with `{{variable}}` templates;
 * system events are formatted per type from the payload. `rule` is the pre-automation shape,
 * kept one release so jobs already queued at upgrade still render.
 */
export type NotificationSource =
  | { kind: 'system' }
  | { kind: 'rule'; title: string; message: string }
  | {
      kind: 'automation';
      automationId: string;
      automationName: string;
      title?: string;
      body?: string;
    };
