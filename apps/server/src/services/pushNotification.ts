/**
 * Expo Push Notification Service
 *
 * Handles sending push notifications to mobile devices via Expo's push service.
 * Supports chunking for bulk sends, receipt verification, token cleanup,
 * and per-device notification preferences.
 */

import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import { eq, isNotNull } from 'drizzle-orm';
import type { ViolationWithDetails, ActiveSession } from '@tracearr/shared';
import { RULE_DISPLAY_NAMES, SEVERITY_LEVELS, getSeverityPriority } from '@tracearr/shared';
import { db } from '../db/client.js';
import { mobileSessions, notificationPreferences } from '../db/schema.js';
import { getPushRateLimiter } from './pushRateLimiter.js';
import { quietHoursService, type NotificationSeverity } from './quietHours.js';
import { pushEncryptionService } from './pushEncryption.js';
import { getNetworkSettings } from '../routes/settings.js';

// Initialize Expo SDK
const expo = new Expo();

// Store receipt IDs for later verification (token -> receiptId)
const pendingReceipts = new Map<string, string>();

// Invalid tokens that should be removed
const tokensToRemove = new Set<string>();

/**
 * Format media title for notifications
 * Movies: "Movie Title"
 * TV Shows: "Show Name - S01E05 Episode Title" or "Show Name - S01E05"
 */
function formatMediaTitle(session: ActiveSession): string {
  const { mediaType, mediaTitle, grandparentTitle, seasonNumber, episodeNumber } = session;

  // For episodes, format as "Show - S01E05 Episode"
  if (mediaType === 'episode' && grandparentTitle) {
    const seasonStr = seasonNumber != null ? String(seasonNumber).padStart(2, '0') : '00';
    const episodeStr = episodeNumber != null ? String(episodeNumber).padStart(2, '0') : '00';
    const episodeCode = `S${seasonStr}E${episodeStr}`;

    // If episode title is different from show title, include it
    if (mediaTitle && mediaTitle !== grandparentTitle) {
      return `${grandparentTitle} - ${episodeCode} ${mediaTitle}`;
    }
    return `${grandparentTitle} - ${episodeCode}`;
  }

  // For movies and other media, just use the title
  return mediaTitle;
}

/**
 * Build full poster URL for rich notifications
 * Returns null if externalUrl is not configured or thumbPath is missing
 */
async function _buildPosterUrl(session: ActiveSession): Promise<string | null> {
  const { thumbPath, serverId } = session;

  // Need both thumbPath and serverId
  if (!thumbPath || !serverId) {
    return null;
  }

  // Get external URL from settings
  const networkSettings = await getNetworkSettings();
  const { externalUrl } = networkSettings;

  // External URL must be configured for rich notifications
  if (!externalUrl) {
    return null;
  }

  // Build the full URL using image proxy
  // Use smaller dimensions for notification thumbnails
  const width = 150;
  const height = 225;
  const encodedPath = encodeURIComponent(thumbPath);

  return `${externalUrl}/api/v1/images/proxy?server=${serverId}&url=${encodedPath}&width=${width}&height=${height}&fallback=poster`;
}

/**
 * Session with preferences for filtering
 */
interface SessionWithPrefs {
  expoPushToken: string;
  mobileSessionId: string;
  deviceSecret: string | null;
  pushEnabled: boolean;
  onViolationDetected: boolean;
  onStreamStarted: boolean;
  onStreamStopped: boolean;
  onConcurrentStreams: boolean;
  onNewDevice: boolean;
  onTrustScoreChanged: boolean;
  onServerDown: boolean;
  onServerUp: boolean;
  violationMinSeverity: number;
  violationRuleTypes: string[] | null;
  // Rate limiting
  maxPerMinute: number;
  maxPerHour: number;
  // Quiet hours
  quietHoursEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursTimezone: string;
  quietHoursOverrideCritical: boolean;
}

/**
 * Build push message for a device
 * Encrypts the data payload if deviceSecret is provided
 * Supports rich notifications with subtitle and image
 */
function buildPushMessage(
  token: string,
  deviceSecret: string | null,
  notification: {
    title: string;
    subtitle?: string; // iOS subtitle, shown below title
    body: string;
    data?: Record<string, unknown>;
    priority?: 'default' | 'high';
    channelId?: string;
    badge?: number;
    sound?: 'default' | null;
    imageUrl?: string | null; // Rich notification image URL (must be HTTPS)
  }
): ExpoPushMessage {
  // Encrypt data payload if device has a secret
  const data = notification.data
    ? (pushEncryptionService.encryptIfEnabled(notification.data, deviceSecret) as Record<
        string,
        unknown
      >)
    : undefined;

  const message: ExpoPushMessage = {
    to: token,
    title: notification.title,
    body: notification.body,
    data,
    priority: notification.priority ?? 'default',
    channelId: notification.channelId,
    badge: notification.badge,
    sound: notification.sound === undefined ? 'default' : notification.sound,
  };

  // Add subtitle for iOS (Android will show it as part of body)
  if (notification.subtitle) {
    message.subtitle = notification.subtitle;
  }

  // Add rich notification image if URL is HTTPS
  if (notification.imageUrl?.startsWith('https://')) {
    // Note: 'richContent' property holds the image URL in Expo SDK
    // Using type assertion since expo-server-sdk types may not include newer properties
    (message as ExpoPushMessage & { richContent?: { url: string } }).richContent = {
      url: notification.imageUrl,
    };
  }

  return message;
}

/**
 * Get all valid Expo push tokens with their preferences
 */
async function getSessionsWithPreferences(): Promise<SessionWithPrefs[]> {
  // Query sessions with their preferences (left join to handle missing prefs)
  const results = await db
    .select({
      expoPushToken: mobileSessions.expoPushToken,
      mobileSessionId: mobileSessions.id,
      deviceSecret: mobileSessions.deviceSecret,
      pushEnabled: notificationPreferences.pushEnabled,
      onViolationDetected: notificationPreferences.onViolationDetected,
      onStreamStarted: notificationPreferences.onStreamStarted,
      onStreamStopped: notificationPreferences.onStreamStopped,
      onConcurrentStreams: notificationPreferences.onConcurrentStreams,
      onNewDevice: notificationPreferences.onNewDevice,
      onTrustScoreChanged: notificationPreferences.onTrustScoreChanged,
      onServerDown: notificationPreferences.onServerDown,
      onServerUp: notificationPreferences.onServerUp,
      violationMinSeverity: notificationPreferences.violationMinSeverity,
      violationRuleTypes: notificationPreferences.violationRuleTypes,
      maxPerMinute: notificationPreferences.maxPerMinute,
      maxPerHour: notificationPreferences.maxPerHour,
      quietHoursEnabled: notificationPreferences.quietHoursEnabled,
      quietHoursStart: notificationPreferences.quietHoursStart,
      quietHoursEnd: notificationPreferences.quietHoursEnd,
      quietHoursTimezone: notificationPreferences.quietHoursTimezone,
      quietHoursOverrideCritical: notificationPreferences.quietHoursOverrideCritical,
    })
    .from(mobileSessions)
    .leftJoin(
      notificationPreferences,
      eq(mobileSessions.id, notificationPreferences.mobileSessionId)
    )
    .where(isNotNull(mobileSessions.expoPushToken));

  return results
    .filter((s): s is SessionWithPrefs => {
      if (!s.expoPushToken) return false;
      if (tokensToRemove.has(s.expoPushToken)) return false;
      if (!Expo.isExpoPushToken(s.expoPushToken)) return false;
      return true;
    })
    .map((s) => ({
      expoPushToken: s.expoPushToken,
      mobileSessionId: s.mobileSessionId,
      deviceSecret: s.deviceSecret ?? null,
      // Use defaults if no preferences exist
      pushEnabled: s.pushEnabled ?? true,
      onViolationDetected: s.onViolationDetected ?? true,
      onStreamStarted: s.onStreamStarted ?? false,
      onStreamStopped: s.onStreamStopped ?? false,
      onConcurrentStreams: s.onConcurrentStreams ?? true,
      onNewDevice: s.onNewDevice ?? true,
      onTrustScoreChanged: s.onTrustScoreChanged ?? false,
      onServerDown: s.onServerDown ?? true,
      onServerUp: s.onServerUp ?? true,
      violationMinSeverity: s.violationMinSeverity ?? 1,
      violationRuleTypes: s.violationRuleTypes ?? [],
      maxPerMinute: s.maxPerMinute ?? 10,
      maxPerHour: s.maxPerHour ?? 60,
      quietHoursEnabled: s.quietHoursEnabled ?? false,
      quietHoursStart: s.quietHoursStart ?? null,
      quietHoursEnd: s.quietHoursEnd ?? null,
      quietHoursTimezone: s.quietHoursTimezone ?? 'UTC',
      quietHoursOverrideCritical: s.quietHoursOverrideCritical ?? true,
    }));
}

/**
 * Send push notifications in chunks (Expo limit: 100 per request)
 */
async function sendPushNotifications(messages: ExpoPushMessage[]): Promise<void> {
  if (messages.length === 0) return;

  const chunks = expo.chunkPushNotifications(messages);
  const tickets: { token: string; ticket: ExpoPushTicket }[] = [];

  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);

      // Store token -> ticket mapping for receipt handling
      chunk.forEach((msg: ExpoPushMessage, idx: number) => {
        const ticket = ticketChunk[idx];
        if (ticket) {
          tickets.push({ token: msg.to as string, ticket });

          // Store receipt ID for later verification
          if ('id' in ticket) {
            pendingReceipts.set(ticket.id, msg.to as string);
          }

          // Handle immediate errors
          if (ticket.status === 'error') {
            handlePushError(msg.to as string, ticket.message, ticket.details);
          }
        }
      });
    } catch (error) {
      console.error('[Push] Error sending chunk:', error);
    }
  }

  console.log(`[Push] Sent ${messages.length} notifications, ${tickets.length} tickets`);
}

/**
 * Handle push notification error
 */
function handlePushError(token: string, message?: string, details?: { error?: string }): void {
  console.error(`[Push] Error for token ${token.slice(0, 20)}...: ${message}`);

  // Mark invalid tokens for removal
  if (details?.error === 'DeviceNotRegistered') {
    console.log(`[Push] Marking token for removal: ${token.slice(0, 20)}...`);
    tokensToRemove.add(token);
  }
}

/**
 * Process push receipts to verify delivery and clean up invalid tokens
 * Should be called periodically (e.g., every 15 minutes)
 */
export async function processPushReceipts(): Promise<void> {
  if (pendingReceipts.size === 0) return;

  const receiptIds = Array.from(pendingReceipts.keys());
  const receiptIdChunks = expo.chunkPushNotificationReceiptIds(receiptIds);

  for (const chunk of receiptIdChunks) {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(chunk);

      for (const [receiptId, receipt] of Object.entries(receipts)) {
        const token = pendingReceipts.get(receiptId);

        if (receipt.status === 'error') {
          console.error(`[Push] Receipt error: ${receipt.message}`);

          if (token && receipt.details?.error === 'DeviceNotRegistered') {
            tokensToRemove.add(token);
          }
        }

        pendingReceipts.delete(receiptId);
      }
    } catch (error) {
      console.error('[Push] Error fetching receipts:', error);
    }
  }

  // Clean up invalid tokens from database
  await cleanupInvalidTokens();
}

/**
 * Remove invalid tokens from the database
 */
async function cleanupInvalidTokens(): Promise<void> {
  if (tokensToRemove.size === 0) return;

  const tokensArray = Array.from(tokensToRemove);
  console.log(`[Push] Cleaning up ${tokensArray.length} invalid tokens`);

  for (const token of tokensArray) {
    try {
      await db
        .update(mobileSessions)
        .set({ expoPushToken: null })
        .where(eq(mobileSessions.expoPushToken, token));

      tokensToRemove.delete(token);
    } catch (error) {
      console.error(`[Push] Error removing token: ${error}`);
    }
  }
}

/**
 * Apply quiet hours filtering to a list of sessions
 * Returns only sessions that are not in quiet hours (or can bypass)
 */
function applyQuietHours(
  sessions: SessionWithPrefs[],
  severity: NotificationSeverity,
  context: string
): SessionWithPrefs[] {
  return sessions.filter((session) => {
    const shouldSend = quietHoursService.shouldSend(
      {
        quietHoursEnabled: session.quietHoursEnabled,
        quietHoursStart: session.quietHoursStart,
        quietHoursEnd: session.quietHoursEnd,
        quietHoursTimezone: session.quietHoursTimezone,
        quietHoursOverrideCritical: session.quietHoursOverrideCritical,
      },
      severity
    );

    if (!shouldSend) {
      console.log(
        `[Push] Quiet hours active for session ${session.mobileSessionId.slice(0, 8)}... ` +
          `for ${context} (severity: ${severity})`
      );
    }

    return shouldSend;
  });
}

/**
 * Apply quiet hours filtering for event-based notifications (non-severity)
 */
function applyQuietHoursEvent(
  sessions: SessionWithPrefs[],
  eventType: 'session_started' | 'session_stopped' | 'server_down' | 'server_up',
  context: string
): SessionWithPrefs[] {
  return sessions.filter((session) => {
    const shouldSend = quietHoursService.shouldSendEvent(
      {
        quietHoursEnabled: session.quietHoursEnabled,
        quietHoursStart: session.quietHoursStart,
        quietHoursEnd: session.quietHoursEnd,
        quietHoursTimezone: session.quietHoursTimezone,
        quietHoursOverrideCritical: session.quietHoursOverrideCritical,
      },
      eventType
    );

    if (!shouldSend) {
      console.log(
        `[Push] Quiet hours active for session ${session.mobileSessionId.slice(0, 8)}... ` +
          `for ${context}`
      );
    }

    return shouldSend;
  });
}

/**
 * Apply rate limiting to a list of sessions
 * Returns only sessions that pass the rate limit check
 */
async function applyRateLimiting(
  sessions: SessionWithPrefs[],
  context: string
): Promise<SessionWithPrefs[]> {
  const rateLimiter = getPushRateLimiter();
  if (!rateLimiter) {
    return sessions; // No rate limiter, allow all
  }

  const allowed: SessionWithPrefs[] = [];

  for (const session of sessions) {
    const result = await rateLimiter.checkAndRecord(session.mobileSessionId, {
      maxPerMinute: session.maxPerMinute,
      maxPerHour: session.maxPerHour,
    });

    if (result.allowed) {
      allowed.push(session);
    } else {
      console.log(
        `[Push] Rate limited session ${session.mobileSessionId.slice(0, 8)}... ` +
          `for ${context} (${result.exceededLimit} limit exceeded)`
      );
    }
  }

  return allowed;
}

// ============================================================================
// Push Notification Service
// ============================================================================

export class PushNotificationService {
  /**
   * Send violation notification to devices that have enabled violation alerts
   */
  async notifyViolation(violation: ViolationWithDetails): Promise<void> {
    const sessions = await getSessionsWithPreferences();
    if (sessions.length === 0) return;

    const ruleType = violation.rule.type as keyof typeof RULE_DISPLAY_NAMES;
    const severity = violation.severity as keyof typeof SEVERITY_LEVELS;
    const severityNum = getSeverityPriority(severity);

    // Filter sessions based on preferences
    const eligibleSessions = sessions.filter((s) => {
      // Check master toggle
      if (!s.pushEnabled) return false;

      // Check event toggle
      if (!s.onViolationDetected) return false;

      // Check minimum severity
      if (severityNum < s.violationMinSeverity) return false;

      // Check rule type filter (empty array = all types)
      if (s.violationRuleTypes && s.violationRuleTypes.length > 0) {
        if (!s.violationRuleTypes.includes(violation.rule.type)) return false;
      }

      return true;
    });

    if (eligibleSessions.length === 0) {
      console.log(`[Push] No eligible sessions for violation notification`);
      return;
    }

    // Apply rate limiting
    const rateLimitedSessions = await applyRateLimiting(eligibleSessions, 'violation');
    if (rateLimitedSessions.length === 0) {
      console.log(`[Push] All sessions rate limited for violation notification`);
      return;
    }

    // Apply quiet hours filtering (violations use severity for bypass)
    const activeSessions = applyQuietHours(
      rateLimitedSessions,
      severity as NotificationSeverity,
      'violation'
    );
    if (activeSessions.length === 0) {
      console.log(`[Push] All sessions in quiet hours for violation notification`);
      return;
    }

    // Get server name for notification title
    const serverName = violation.server?.name || 'Media Server';

    const messages = activeSessions.map((session) =>
      buildPushMessage(session.expoPushToken, session.deviceSecret, {
        title: serverName,
        subtitle: `${SEVERITY_LEVELS[severity].label} Violation`,
        body: `${violation.user.username}: ${RULE_DISPLAY_NAMES[ruleType]}`,
        data: {
          type: 'violation_detected',
          violationId: violation.id,
          userId: violation.serverUserId,
          ruleType: violation.rule.type,
          severity: violation.severity,
          serverId: violation.server?.id,
        },
        priority: severity === 'high' ? 'high' : 'default',
        channelId: 'violations',
        badge: 1,
        sound: severity === 'high' ? 'default' : undefined,
      })
    );

    await sendPushNotifications(messages);
  }

  /**
   * Send session started notification to devices that have enabled stream alerts
   */
  async notifySessionStarted(session: ActiveSession): Promise<void> {
    const sessions = await getSessionsWithPreferences();
    if (sessions.length === 0) return;

    // Filter sessions based on preferences
    const eligibleSessions = sessions.filter((s) => {
      if (!s.pushEnabled) return false;
      if (!s.onStreamStarted) return false;
      return true;
    });

    if (eligibleSessions.length === 0) {
      console.log(`[Push] No eligible sessions for stream started notification`);
      return;
    }

    // Apply rate limiting
    const rateLimitedSessions = await applyRateLimiting(eligibleSessions, 'session_started');
    if (rateLimitedSessions.length === 0) {
      console.log(`[Push] All sessions rate limited for stream started notification`);
      return;
    }

    // Apply quiet hours filtering
    const activeSessions = applyQuietHoursEvent(
      rateLimitedSessions,
      'session_started',
      'session_started'
    );
    if (activeSessions.length === 0) {
      console.log(`[Push] All sessions in quiet hours for stream started notification`);
      return;
    }

    // Get server name for notification title
    const serverName = session.server?.name || 'Media Server';
    const formattedTitle = formatMediaTitle(session);

    const messages = activeSessions.map((s) =>
      buildPushMessage(s.expoPushToken, s.deviceSecret, {
        title: serverName,
        subtitle: 'Now Playing',
        body: `${session.user.username}: ${formattedTitle}`,
        data: {
          type: 'stream_started',
          sessionId: session.id,
          userId: session.serverUserId,
          mediaTitle: session.mediaTitle,
          mediaType: session.mediaType,
          serverId: session.server.id,
        },
        priority: 'default',
        channelId: 'sessions',
      })
    );

    await sendPushNotifications(messages);
  }

  /**
   * Send session stopped notification to devices that have enabled stream alerts
   */
  async notifySessionStopped(session: ActiveSession): Promise<void> {
    const sessions = await getSessionsWithPreferences();
    if (sessions.length === 0) return;

    // Filter sessions based on preferences
    const eligibleSessions = sessions.filter((s) => {
      if (!s.pushEnabled) return false;
      if (!s.onStreamStopped) return false;
      return true;
    });

    if (eligibleSessions.length === 0) {
      console.log(`[Push] No eligible sessions for stream stopped notification`);
      return;
    }

    // Apply rate limiting
    const rateLimitedSessions = await applyRateLimiting(eligibleSessions, 'session_stopped');
    if (rateLimitedSessions.length === 0) {
      console.log(`[Push] All sessions rate limited for stream stopped notification`);
      return;
    }

    // Apply quiet hours filtering
    const activeSessions = applyQuietHoursEvent(
      rateLimitedSessions,
      'session_stopped',
      'session_stopped'
    );
    if (activeSessions.length === 0) {
      console.log(`[Push] All sessions in quiet hours for stream stopped notification`);
      return;
    }

    // Get server name for notification title
    const serverName = session.server?.name || 'Media Server';
    const formattedTitle = formatMediaTitle(session);

    // Format duration
    const durationMins = Math.round((session.durationMs || 0) / 60000);
    const durationStr =
      durationMins >= 60
        ? `${Math.floor(durationMins / 60)}h ${durationMins % 60}m`
        : `${durationMins}m`;

    const messages = activeSessions.map((s) =>
      buildPushMessage(s.expoPushToken, s.deviceSecret, {
        title: serverName,
        subtitle: 'Stream Ended',
        body: `${session.user.username}: ${formattedTitle} (${durationStr})`,
        data: {
          type: 'stream_stopped',
          sessionId: session.id,
          userId: session.serverUserId,
          mediaTitle: session.mediaTitle,
          durationMs: session.durationMs,
          serverId: session.server.id,
        },
        priority: 'default',
        channelId: 'sessions',
      })
    );

    await sendPushNotifications(messages);
  }

  /**
   * Send server down notification to devices that have enabled server alerts
   */
  async notifyServerDown(serverName: string, serverId: string): Promise<void> {
    const sessions = await getSessionsWithPreferences();
    if (sessions.length === 0) return;

    // Filter sessions based on preferences
    const eligibleSessions = sessions.filter((s) => {
      if (!s.pushEnabled) return false;
      if (!s.onServerDown) return false;
      return true;
    });

    if (eligibleSessions.length === 0) {
      console.log(`[Push] No eligible sessions for server down notification`);
      return;
    }

    // Apply rate limiting
    const rateLimitedSessions = await applyRateLimiting(eligibleSessions, 'server_down');
    if (rateLimitedSessions.length === 0) {
      console.log(`[Push] All sessions rate limited for server down notification`);
      return;
    }

    // Apply quiet hours filtering (server_down is treated as critical)
    const activeSessions = applyQuietHoursEvent(rateLimitedSessions, 'server_down', 'server_down');
    if (activeSessions.length === 0) {
      console.log(`[Push] All sessions in quiet hours for server down notification`);
      return;
    }

    const messages = activeSessions.map((s) =>
      buildPushMessage(s.expoPushToken, s.deviceSecret, {
        title: serverName,
        subtitle: 'Server Alert',
        body: 'Connection lost',
        data: {
          type: 'server_down',
          serverName,
          serverId,
        },
        priority: 'high',
        channelId: 'alerts',
        sound: 'default',
      })
    );

    await sendPushNotifications(messages);
  }

  /**
   * Send silent push notification for background data sync
   * These notifications don't show any UI, just trigger the app's background task
   */
  async sendSilentNotification(
    data: Record<string, unknown>,
    skipPreferences = false
  ): Promise<void> {
    const sessions = await getSessionsWithPreferences();
    if (sessions.length === 0) return;

    // For silent notifications, we only filter by pushEnabled (skip all other prefs)
    const eligibleSessions = skipPreferences
      ? sessions.filter((s) => s.pushEnabled)
      : sessions.filter((s) => {
          if (!s.pushEnabled) return false;
          return true;
        });

    if (eligibleSessions.length === 0) {
      console.log(`[Push] No eligible sessions for silent notification`);
      return;
    }

    // Note: Silent notifications typically skip rate limiting and quiet hours
    // as they're for background data sync, not user-facing alerts

    const messages: ExpoPushMessage[] = eligibleSessions.map((session) => {
      // Encrypt data payload if device has a secret
      const encryptedData = pushEncryptionService.encryptIfEnabled(
        { ...data, type: 'data_sync' },
        session.deviceSecret
      ) as Record<string, unknown>;

      return {
        to: session.expoPushToken,
        data: encryptedData,
        // Silent notification settings
        _contentAvailable: true, // iOS background fetch flag
        priority: 'normal', // Don't wake device aggressively
        // No sound, title, or body = silent
      };
    });

    await sendPushNotifications(messages);
    console.log(`[Push] Sent ${messages.length} silent data_sync notifications`);
  }

  /**
   * Trigger a data sync push for dashboard stats refresh
   */
  async triggerStatsSync(): Promise<void> {
    await this.sendSilentNotification({
      syncType: 'stats',
      timestamp: Date.now(),
    });
  }

  /**
   * Trigger a data sync push for sessions refresh
   */
  async triggerSessionsSync(): Promise<void> {
    await this.sendSilentNotification({
      syncType: 'sessions',
      timestamp: Date.now(),
    });
  }

  /**
   * Send server up notification to devices that have enabled server alerts
   */
  async notifyServerUp(serverName: string, serverId: string): Promise<void> {
    const sessions = await getSessionsWithPreferences();
    if (sessions.length === 0) return;

    // Filter sessions based on preferences
    const eligibleSessions = sessions.filter((s) => {
      if (!s.pushEnabled) return false;
      if (!s.onServerUp) return false;
      return true;
    });

    if (eligibleSessions.length === 0) {
      console.log(`[Push] No eligible sessions for server up notification`);
      return;
    }

    // Apply rate limiting
    const rateLimitedSessions = await applyRateLimiting(eligibleSessions, 'server_up');
    if (rateLimitedSessions.length === 0) {
      console.log(`[Push] All sessions rate limited for server up notification`);
      return;
    }

    // Apply quiet hours filtering
    const activeSessions = applyQuietHoursEvent(rateLimitedSessions, 'server_up', 'server_up');
    if (activeSessions.length === 0) {
      console.log(`[Push] All sessions in quiet hours for server up notification`);
      return;
    }

    const messages = activeSessions.map((s) =>
      buildPushMessage(s.expoPushToken, s.deviceSecret, {
        title: serverName,
        subtitle: 'Server Alert',
        body: 'Back online',
        data: {
          type: 'server_up',
          serverName,
          serverId,
        },
        priority: 'default',
        channelId: 'alerts',
      })
    );

    await sendPushNotifications(messages);
  }
}

// Export singleton instance
export const pushNotificationService = new PushNotificationService();
