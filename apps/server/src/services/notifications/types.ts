/**
 * Notification Agent System Types
 *
 * Based on Jellyseerr's agent pattern for extensible notifications.
 */

import type {
  ViolationWithDetails,
  ActiveSession,
  Server,
  ServerUser,
  Settings,
} from '@tracearr/shared';

// Re-export for convenience
export type { ViolationWithDetails, ActiveSession, Server, ServerUser, Settings };

/**
 * Notification event types matching NOTIFICATION_EVENTS from shared
 */
export type NotificationEventType =
  | 'violation_detected'
  | 'stream_started'
  | 'stream_stopped'
  | 'new_device'
  | 'trust_score_changed'
  | 'server_down'
  | 'server_up';

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
 * Context provided with new device notifications
 */
export interface NewDeviceContext {
  type: 'new_device';
  userName: string;
  deviceName: string;
  platform: string | null;
  location: string | null;
  user: Pick<ServerUser, 'id' | 'username' | 'thumbUrl'> & { identityName: string | null };
  server: Pick<Server, 'id' | 'name' | 'type'>;
}

/**
 * Context provided with trust score change notifications
 */
export interface TrustScoreChangedContext {
  type: 'trust_score_changed';
  userName: string;
  user: Pick<ServerUser, 'id' | 'username' | 'thumbUrl'> & { identityName: string | null };
  previousScore: number;
  newScore: number;
  reason: string | null;
  server: Pick<Server, 'id' | 'name' | 'type'>;
}

/**
 * Union of all notification contexts
 */
export type NotificationContext =
  | ViolationContext
  | SessionContext
  | ServerContext
  | NewDeviceContext
  | TrustScoreChangedContext;

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
}

/**
 * Result of a notification send attempt
 */
export interface SendResult {
  success: boolean;
  error?: string;
  /** Agent name for logging/debugging */
  agent: string;
}

/**
 * Result of a test notification
 */
export interface TestResult {
  success: boolean;
  error?: string;
}

/**
 * Settings type with agent-specific fields extracted
 * Agents can pick the fields they need
 */
export type NotificationSettings = Pick<
  Settings,
  | 'discordWebhookUrl'
  | 'customWebhookUrl'
  | 'webhookFormat'
  | 'ntfyTopic'
  | 'ntfyAuthToken'
  | 'pushoverUserKey'
  | 'pushoverApiToken'
>;

/**
 * Interface that all notification agents must implement
 */
export interface NotificationAgent {
  /** Unique agent identifier */
  readonly name: string;

  /** Human-readable display name */
  readonly displayName: string;

  /**
   * Check if this agent should send for the given event and settings
   * @param event The notification event type
   * @param settings Current notification settings
   * @returns true if the agent is configured and should send
   */
  shouldSend(event: NotificationEventType, settings: NotificationSettings): boolean;

  /**
   * Send a notification
   * @param payload The notification payload
   * @param settings Current notification settings
   * @returns Result indicating success or failure
   */
  send(payload: NotificationPayload, settings: NotificationSettings): Promise<SendResult>;

  /**
   * Send a test notification
   * @param settings Current notification settings
   * @returns Result indicating success or failure with optional error message
   */
  sendTest(settings: NotificationSettings): Promise<TestResult>;
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
      severity: violation.severity as NotificationSeverity,
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

  fromNewDevice(
    userName: string,
    deviceName: string,
    platform: string | null,
    location: string | null,
    user: Pick<ServerUser, 'id' | 'username' | 'thumbUrl'> & { identityName: string | null },
    server: Pick<Server, 'id' | 'name' | 'type'>
  ): NotificationPayload {
    const locationStr = location ? ` from ${location}` : '';
    return {
      event: 'new_device',
      title: 'New Device Detected',
      message: `${userName} connected from a new device: ${deviceName}${locationStr}`,
      severity: 'warning',
      timestamp: new Date().toISOString(),
      context: { type: 'new_device', userName, deviceName, platform, location, user, server },
    };
  },

  fromTrustScoreChanged(
    userName: string,
    previousScore: number,
    newScore: number,
    reason: string | null,
    user: Pick<ServerUser, 'id' | 'username' | 'thumbUrl'> & { identityName: string | null },
    server: Pick<Server, 'id' | 'name' | 'type'>
  ): NotificationPayload {
    const direction = newScore < previousScore ? 'decreased' : 'increased';
    const reasonStr = reason ? `: ${reason}` : '';
    return {
      event: 'trust_score_changed',
      title: 'Trust Score Changed',
      message: `${userName}'s trust score ${direction} from ${previousScore} to ${newScore}${reasonStr}`,
      severity: newScore < previousScore ? 'warning' : 'low',
      timestamp: new Date().toISOString(),
      context: {
        type: 'trust_score_changed',
        userName,
        previousScore,
        newScore,
        reason,
        user,
        server,
      },
    };
  },
};
