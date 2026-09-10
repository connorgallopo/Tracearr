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
import { SEVERITY_LEVELS, getSeverityPriority, formatEpisodeLabel } from '@tracearr/shared';
import { db } from '../db/client.js';
import { mobileSessions, notificationPreferences, serverUsers } from '../db/schema.js';
import { getPushRateLimiter } from './pushRateLimiter.js';
import { quietHoursService, type NotificationSeverity } from './quietHours.js';
import { pushEncryptionService } from './pushEncryption.js';
import { getNetworkSettings } from '../routes/settings.js';
import { buildPushPosterUrl, buildPushAvatarUrl, buildLogoUrl } from './imageProxy.js';
import type { NewDevicePayload, TrustChangedPayload } from './notifications/events.js';

// Initialize Expo SDK
const expo = new Expo();

// Store receipt IDs for later verification (receiptId -> { token, timestamp })
// Includes timestamp for stale entry cleanup
/** What an automation's send may replace in an event's builtin push copy. */
export interface PushTextOverride {
  title?: string;
  body?: string;
}

interface PendingReceipt {
  token: string;
  createdAt: number;
}
const pendingReceipts = new Map<string, PendingReceipt>();

// Invalid tokens that should be removed
const tokensToRemove = new Set<string>();

const MAX_PENDING_RECEIPTS = 10000;
const MAX_TOKENS_TO_REMOVE = 1000;
const RECEIPT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour - receipts older than this are stale

/**
 * Format media title for notifications
 * Movies: "Movie Title"
 * TV Shows: "Show Name - S01E05 Episode Title" or "Show Name - S01E05"
 */
function formatMediaTitle(session: ActiveSession): string {
  const { mediaType, mediaTitle, grandparentTitle, seasonNumber, episodeNumber } = session;

  // For episodes, format as "Show - S01E05 Episode"
  if (mediaType === 'episode' && grandparentTitle) {
    // Fall back to 0 for a genuinely missing season/episode so the notification
    // still shows a code (e.g. "S00E00") instead of dropping it entirely.
    const episodeCode = formatEpisodeLabel(seasonNumber ?? 0, episodeNumber ?? 0) ?? 'S00E00';

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
  // Note: Requires Notification Service Extension on iOS to display images
  if (notification.imageUrl?.startsWith('https://')) {
    // Expo richContent format expects { image: url } not { url: url }
    (message as ExpoPushMessage & { richContent?: { image: string } }).richContent = {
      image: notification.imageUrl,
    };
  }

  return message;
}

/**
 * Resolve the identity (users.id) that owns a server account, for push payloads
 * that need to reference the person rather than just their account on one server.
 */
async function getIdentityUserId(serverUserId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: serverUsers.userId })
    .from(serverUsers)
    .where(eq(serverUsers.id, serverUserId))
    .limit(1);
  return row?.userId ?? null;
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
            if (pendingReceipts.size >= MAX_PENDING_RECEIPTS) {
              console.warn(
                `[Push] pendingReceipts reached ${pendingReceipts.size} entries, clearing stale entries`
              );
              const now = Date.now();
              for (const [id, receipt] of pendingReceipts) {
                if (now - receipt.createdAt > RECEIPT_MAX_AGE_MS) {
                  pendingReceipts.delete(id);
                }
              }
              if (pendingReceipts.size >= MAX_PENDING_RECEIPTS) {
                const entries = Array.from(pendingReceipts.entries());
                entries.sort((a, b) => a[1].createdAt - b[1].createdAt);
                const toRemove = entries.slice(0, Math.floor(entries.length / 2));
                for (const [id] of toRemove) {
                  pendingReceipts.delete(id);
                }
                console.warn(`[Push] Cleared ${toRemove.length} oldest pending receipts`);
              }
            }
            pendingReceipts.set(ticket.id, { token: msg.to as string, createdAt: Date.now() });
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
  // First, clean up stale entries that are older than max age
  const now = Date.now();
  let staleCount = 0;
  for (const [id, receipt] of pendingReceipts) {
    if (now - receipt.createdAt > RECEIPT_MAX_AGE_MS) {
      pendingReceipts.delete(id);
      staleCount++;
    }
  }
  if (staleCount > 0) {
    console.log(`[Push] Cleaned up ${staleCount} stale pending receipts`);
  }

  if (pendingReceipts.size === 0) return;

  const receiptIds = Array.from(pendingReceipts.keys());
  const receiptIdChunks = expo.chunkPushNotificationReceiptIds(receiptIds);

  for (const chunk of receiptIdChunks) {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(chunk);

      for (const [receiptId, receipt] of Object.entries(receipts)) {
        const pending = pendingReceipts.get(receiptId);

        if (receipt.status === 'error') {
          console.error(`[Push] Receipt error: ${receipt.message}`);

          if (pending?.token && receipt.details?.error === 'DeviceNotRegistered') {
            tokensToRemove.add(pending.token);
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

  if (tokensToRemove.size > MAX_TOKENS_TO_REMOVE) {
    console.warn(
      `[Push] tokensToRemove exceeded ${MAX_TOKENS_TO_REMOVE} entries (${tokensToRemove.size}), clearing to prevent memory leak`
    );
    tokensToRemove.clear();
    return;
  }

  const tokensArray = Array.from(tokensToRemove);
  console.log(`[Push] Cleaning up ${tokensArray.length} invalid tokens`);

  for (const token of tokensArray) {
    tokensToRemove.delete(token);

    try {
      await db
        .update(mobileSessions)
        .set({ expoPushToken: null })
        .where(eq(mobileSessions.expoPushToken, token));
    } catch (error) {
      if (tokensToRemove.size < MAX_TOKENS_TO_REMOVE) {
        tokensToRemove.add(token);
      }
      console.error(`[Push] Error removing token (will retry): ${error}`);
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

/**
 * The legacy per-device rule-type filter only knows V1 rule types. Every rule
 * is V2 today (type null), so a null type passes; the filter still narrows typed rules.
 */
export function passesViolationRuleTypeFilter(
  violationRuleTypes: string[],
  ruleType: string | null
): boolean {
  if (violationRuleTypes.length === 0) return true;
  if (ruleType === null) return true;
  return violationRuleTypes.includes(ruleType);
}

export class PushNotificationService {
  /**
   * Send violation notification to devices that have enabled violation alerts
   */
  async notifyViolation(
    violation: ViolationWithDetails,
    override?: PushTextOverride
  ): Promise<void> {
    const sessions = await getSessionsWithPreferences();
    if (sessions.length === 0) return;

    const severity = violation.severity;
    const severityNum = getSeverityPriority(severity);

    // Filter sessions based on preferences
    const eligibleSessions = sessions.filter((s) => {
      // Check master toggle
      if (!s.pushEnabled) return false;

      // Check event toggle
      if (!s.onViolationDetected) return false;

      // Check minimum severity
      if (severityNum < s.violationMinSeverity) return false;

      if (!passesViolationRuleTypeFilter(s.violationRuleTypes ?? [], violation.rule.type)) {
        return false;
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
    const activeSessions = applyQuietHours(rateLimitedSessions, severity, 'violation');
    if (activeSessions.length === 0) {
      console.log(`[Push] All sessions in quiet hours for violation notification`);
      return;
    }

    // Get server name for notification title
    const serverName = violation.server?.name || 'Media Server';

    // Get external URL for rich notification image (user avatar)
    const { externalUrl } = await getNetworkSettings();
    const serverId = violation.server?.id;
    const imageUrl = buildPushAvatarUrl(externalUrl, serverId, violation.user?.thumbUrl);

    // The person's identity (users.id), for clients that want to group by
    // person rather than by the single server account that triggered this.
    const identityUserId =
      violation.user.userId ?? (await getIdentityUserId(violation.serverUserId));

    const messages = activeSessions.map((session) =>
      buildPushMessage(session.expoPushToken, session.deviceSecret, {
        title: override?.title ?? serverName,
        subtitle: `${SEVERITY_LEVELS[severity].label} Violation`,
        body:
          override?.body ??
          `${violation.user.identityName ?? violation.user.username}: ${violation.rule.name}`,
        data: {
          type: 'violation_detected',
          violationId: violation.id,
          // Legacy alias: historically the server account id, kept for older mobile clients.
          userId: violation.serverUserId,
          serverUserId: violation.serverUserId,
          identityUserId,
          ruleType: violation.rule.type,
          severity: violation.severity,
          serverId: violation.server?.id,
        },
        priority: severity === 'high' ? 'high' : 'default',
        channelId: 'violations',
        badge: 1,
        sound: severity === 'high' ? 'default' : undefined,
        imageUrl,
      })
    );

    await sendPushNotifications(messages);
  }

  /**
   * Send session started notification to devices that have enabled stream alerts
   */
  async notifySessionStarted(session: ActiveSession, override?: PushTextOverride): Promise<void> {
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

    // Get external URL for rich notification image
    const { externalUrl } = await getNetworkSettings();
    const imageUrl = buildPushPosterUrl(externalUrl, session.server?.id, session.thumbPath);
    const identityUserId = await getIdentityUserId(session.serverUserId);

    const messages = activeSessions.map((s) =>
      buildPushMessage(s.expoPushToken, s.deviceSecret, {
        title: override?.title ?? serverName,
        subtitle: 'Now Playing',
        body:
          override?.body ??
          `${session.user.identityName ?? session.user.username}: ${formattedTitle}`,
        data: {
          type: 'stream_started',
          sessionId: session.id,
          // Legacy alias: historically the server account id, kept for older mobile clients.
          userId: session.serverUserId,
          serverUserId: session.serverUserId,
          identityUserId,
          mediaTitle: session.mediaTitle,
          mediaType: session.mediaType,
          serverId: session.server.id,
        },
        priority: 'default',
        channelId: 'sessions',
        imageUrl,
      })
    );

    await sendPushNotifications(messages);
  }

  /**
   * Send session stopped notification to devices that have enabled stream alerts
   */
  async notifySessionStopped(session: ActiveSession, override?: PushTextOverride): Promise<void> {
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

    // Get external URL for rich notification image
    const { externalUrl } = await getNetworkSettings();
    const imageUrl = buildPushPosterUrl(externalUrl, session.server?.id, session.thumbPath);
    const identityUserId = await getIdentityUserId(session.serverUserId);

    const messages = activeSessions.map((s) =>
      buildPushMessage(s.expoPushToken, s.deviceSecret, {
        title: override?.title ?? serverName,
        subtitle: 'Stream Ended',
        body:
          override?.body ??
          `${session.user.identityName ?? session.user.username}: ${formattedTitle}`,
        data: {
          type: 'stream_stopped',
          sessionId: session.id,
          // Legacy alias: historically the server account id, kept for older mobile clients.
          userId: session.serverUserId,
          serverUserId: session.serverUserId,
          identityUserId,
          mediaTitle: session.mediaTitle,
          serverId: session.server.id,
        },
        priority: 'default',
        channelId: 'sessions',
        imageUrl,
      })
    );

    await sendPushNotifications(messages);
  }

  /**
   * Send server down notification to devices that have enabled server alerts
   */
  async notifyServerDown(
    serverName: string,
    serverId: string,
    override?: PushTextOverride
  ): Promise<void> {
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

    // Get external URL for Tracearr logo
    const { externalUrl } = await getNetworkSettings();
    const imageUrl = buildLogoUrl(externalUrl);

    const messages = activeSessions.map((s) =>
      buildPushMessage(s.expoPushToken, s.deviceSecret, {
        title: override?.title ?? serverName,
        subtitle: 'Server Alert',
        body: override?.body ?? 'Connection lost',
        data: {
          type: 'server_down',
          serverName,
          serverId,
        },
        priority: 'high',
        channelId: 'alerts',
        sound: 'default',
        imageUrl,
      })
    );

    await sendPushNotifications(messages);
  }

  /**
   * Send new device notification to devices that have enabled device alerts.
   * The per-device toggle is the opt-in here, unlike the update and library sends.
   */
  async notifyNewDevice(payload: NewDevicePayload, override?: PushTextOverride): Promise<void> {
    const sessions = await getSessionsWithPreferences();
    if (sessions.length === 0) return;

    const eligibleSessions = sessions.filter((s) => s.pushEnabled && s.onNewDevice);
    if (eligibleSessions.length === 0) {
      console.log(`[Push] No eligible sessions for new device notification`);
      return;
    }

    const rateLimitedSessions = await applyRateLimiting(eligibleSessions, 'new_device');
    if (rateLimitedSessions.length === 0) {
      console.log(`[Push] All sessions rate limited for new device notification`);
      return;
    }

    const activeSessions = applyQuietHours(rateLimitedSessions, 'warning', 'new_device');
    if (activeSessions.length === 0) {
      console.log(`[Push] All sessions in quiet hours for new device notification`);
      return;
    }

    const { externalUrl } = await getNetworkSettings();
    const imageUrl = buildLogoUrl(externalUrl);
    const where = payload.location ? ` from ${payload.location}` : '';

    const messages = activeSessions.map((s) =>
      buildPushMessage(s.expoPushToken, s.deviceSecret, {
        title: override?.title ?? payload.userName,
        subtitle: 'New Device',
        body: override?.body ?? `${payload.deviceName}${where}`,
        data: { ...payload, type: 'new_device' },
        priority: 'high',
        channelId: 'alerts',
        sound: 'default',
        imageUrl,
      })
    );

    await sendPushNotifications(messages);
  }

  /** Send trust score notification to devices that have enabled trust alerts. */
  async notifyTrustChanged(
    payload: TrustChangedPayload,
    override?: PushTextOverride
  ): Promise<void> {
    const sessions = await getSessionsWithPreferences();
    if (sessions.length === 0) return;

    const eligibleSessions = sessions.filter((s) => s.pushEnabled && s.onTrustScoreChanged);
    if (eligibleSessions.length === 0) {
      console.log(`[Push] No eligible sessions for trust score notification`);
      return;
    }

    const rateLimitedSessions = await applyRateLimiting(eligibleSessions, 'trust_score_changed');
    if (rateLimitedSessions.length === 0) {
      console.log(`[Push] All sessions rate limited for trust score notification`);
      return;
    }

    const dropped = payload.newScore < payload.previousScore;
    const activeSessions = applyQuietHours(
      rateLimitedSessions,
      dropped ? 'warning' : 'low',
      'trust_score_changed'
    );
    if (activeSessions.length === 0) {
      console.log(`[Push] All sessions in quiet hours for trust score notification`);
      return;
    }

    const { externalUrl } = await getNetworkSettings();
    const imageUrl = buildLogoUrl(externalUrl);
    const why = payload.reason ? `: ${payload.reason}` : '';
    const move = `${dropped ? 'Dropped' : 'Rose'} from ${String(payload.previousScore)} to ${String(payload.newScore)}`;

    const messages = activeSessions.map((s) =>
      buildPushMessage(s.expoPushToken, s.deviceSecret, {
        title: override?.title ?? payload.userName,
        subtitle: 'Trust Score',
        body: override?.body ?? `${move}${why}`,
        data: { ...payload, type: 'trust_score_changed' },
        priority: dropped ? 'high' : 'default',
        channelId: 'alerts',
        imageUrl,
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
   * Send a test notification to verify push is working for a specific device
   */
  async sendTestNotification(expoPushToken: string): Promise<{ success: boolean; error?: string }> {
    if (!Expo.isExpoPushToken(expoPushToken)) {
      return { success: false, error: 'Invalid push token format' };
    }

    const message: ExpoPushMessage = {
      to: expoPushToken,
      title: 'Tracearr',
      body: 'Test notification received successfully!',
      data: { type: 'test' },
      sound: 'default',
      priority: 'high',
    };

    try {
      const tickets = await expo.sendPushNotificationsAsync([message]);
      const ticket = tickets[0];

      if (!ticket) {
        return { success: false, error: 'No response from Expo' };
      }

      if (ticket.status === 'error') {
        return { success: false, error: ticket.message ?? 'Push failed' };
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Send server up notification to devices that have enabled server alerts
   */
  async notifyServerUp(
    serverName: string,
    serverId: string,
    override?: PushTextOverride
  ): Promise<void> {
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

    // Get external URL for Tracearr logo
    const { externalUrl } = await getNetworkSettings();
    const imageUrl = buildLogoUrl(externalUrl);

    const messages = activeSessions.map((s) =>
      buildPushMessage(s.expoPushToken, s.deviceSecret, {
        title: override?.title ?? serverName,
        subtitle: 'Server Alert',
        body: override?.body ?? 'Back online',
        data: {
          type: 'server_up',
          serverName,
          serverId,
        },
        priority: 'default',
        channelId: 'alerts',
        imageUrl,
      })
    );

    await sendPushNotifications(messages);
  }

  /**
   * Send an update notification (plugin, media server or Tracearr release).
   * No per-device toggle covers updates: subscribing the automation to this
   * destination is the opt-in, so only the master toggle, rate limits and
   * quiet hours filter here.
   */
  async notifyUpdate(title: string, body: string, data: Record<string, unknown>): Promise<void> {
    await this.notifyText('update', 'Update Available', title, body, data);
  }

  /** The same for a library item an automation announced. */
  async notifyLibrary(title: string, body: string, data: Record<string, unknown>): Promise<void> {
    await this.notifyText('media', 'Library', title, body, data);
  }

  /** The same for a newsletter outcome an automation announced; there is no per-device toggle for it. */
  async notifyNewsletter(
    title: string,
    body: string,
    data: Record<string, unknown>
  ): Promise<void> {
    await this.notifyText('newsletter', 'Newsletter', title, body, data);
  }

  private async notifyText(
    context: string,
    subtitle: string,
    title: string,
    body: string,
    data: Record<string, unknown>
  ): Promise<void> {
    const sessions = await getSessionsWithPreferences();
    const eligibleSessions = sessions.filter((s) => s.pushEnabled);
    if (eligibleSessions.length === 0) {
      console.log(`[Push] No eligible sessions for ${context} notification`);
      return;
    }

    const rateLimitedSessions = await applyRateLimiting(eligibleSessions, context);
    if (rateLimitedSessions.length === 0) {
      console.log(`[Push] All sessions rate limited for ${context} notification`);
      return;
    }

    const activeSessions = applyQuietHours(rateLimitedSessions, 'low', context);
    if (activeSessions.length === 0) {
      console.log(`[Push] All sessions in quiet hours for ${context} notification`);
      return;
    }

    const { externalUrl } = await getNetworkSettings();
    const imageUrl = buildLogoUrl(externalUrl);

    const messages = activeSessions.map((s) =>
      buildPushMessage(s.expoPushToken, s.deviceSecret, {
        title,
        subtitle,
        body,
        data,
        priority: 'default',
        channelId: 'alerts',
        imageUrl,
      })
    );

    await sendPushNotifications(messages);
  }
}

// Export singleton instance
export const pushNotificationService = new PushNotificationService();
