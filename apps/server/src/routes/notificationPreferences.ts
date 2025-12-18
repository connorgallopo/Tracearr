/**
 * Notification Preferences routes - Per-device notification configuration
 *
 * Mobile device endpoints:
 * - GET /notifications/preferences - Get preferences for current device
 * - PATCH /notifications/preferences - Update preferences for current device
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import type { NotificationPreferences, NotificationPreferencesWithStatus } from '@tracearr/shared';
import { db } from '../db/client.js';
import { mobileSessions, notificationPreferences } from '../db/schema.js';
import { getPushRateLimiter } from '../services/pushRateLimiter.js';

// Update preferences schema
const updatePreferencesSchema = z.object({
  pushEnabled: z.boolean().optional(),
  onViolationDetected: z.boolean().optional(),
  onStreamStarted: z.boolean().optional(),
  onStreamStopped: z.boolean().optional(),
  onConcurrentStreams: z.boolean().optional(),
  onNewDevice: z.boolean().optional(),
  onTrustScoreChanged: z.boolean().optional(),
  onServerDown: z.boolean().optional(),
  onServerUp: z.boolean().optional(),
  violationMinSeverity: z.number().int().min(1).max(3).optional(),
  violationRuleTypes: z.array(z.string()).optional(),
  maxPerMinute: z.number().int().min(1).max(60).optional(),
  maxPerHour: z.number().int().min(1).max(1000).optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietHoursStart: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional()
    .nullable(),
  quietHoursEnd: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional()
    .nullable(),
  quietHoursTimezone: z.string().max(50).optional(),
  quietHoursOverrideCritical: z.boolean().optional(),
});

/**
 * Find mobile session by deviceId from JWT claims
 * Mobile JWTs include deviceId for targeting the correct device session
 */
async function findMobileSessionByDeviceId(deviceId: string): Promise<{ id: string } | null> {
  const session = await db
    .select({ id: mobileSessions.id })
    .from(mobileSessions)
    .where(eq(mobileSessions.deviceId, deviceId))
    .limit(1);

  return session[0] ?? null;
}

/**
 * Find mobile session for user (fallback for legacy tokens without deviceId)
 * Gets the most recently active session for the owner
 */
async function findMobileSessionForUserFallback(_userId: string): Promise<{ id: string } | null> {
  // Get the most recently active session (desc ordering)
  const session = await db
    .select({ id: mobileSessions.id })
    .from(mobileSessions)
    .orderBy(desc(mobileSessions.lastSeenAt))
    .limit(1);

  return session[0] ?? null;
}

/**
 * Transform DB row to API response
 */
function toApiResponse(row: typeof notificationPreferences.$inferSelect): NotificationPreferences {
  return {
    id: row.id,
    mobileSessionId: row.mobileSessionId,
    pushEnabled: row.pushEnabled,
    onViolationDetected: row.onViolationDetected,
    onStreamStarted: row.onStreamStarted,
    onStreamStopped: row.onStreamStopped,
    onConcurrentStreams: row.onConcurrentStreams,
    onNewDevice: row.onNewDevice,
    onTrustScoreChanged: row.onTrustScoreChanged,
    onServerDown: row.onServerDown,
    onServerUp: row.onServerUp,
    violationMinSeverity: row.violationMinSeverity,
    violationRuleTypes: row.violationRuleTypes ?? [],
    maxPerMinute: row.maxPerMinute,
    maxPerHour: row.maxPerHour,
    quietHoursEnabled: row.quietHoursEnabled,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    quietHoursTimezone: row.quietHoursTimezone ?? 'UTC',
    quietHoursOverrideCritical: row.quietHoursOverrideCritical,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const notificationPreferencesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /notifications/preferences - Get preferences for current device
   *
   * Requires mobile authentication. Returns preferences for the device's session,
   * or creates default preferences if none exist.
   */
  app.get('/preferences', { preHandler: [app.requireMobile] }, async (request, reply) => {
    const authUser = request.user;

    // Find mobile session using deviceId (preferred) or fallback to user lookup
    const mobileSession = authUser.deviceId
      ? await findMobileSessionByDeviceId(authUser.deviceId)
      : await findMobileSessionForUserFallback(authUser.userId);
    if (!mobileSession) {
      return reply.notFound('No mobile session found. Please pair the device first.');
    }

    // Get or create preferences
    let prefsRow = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.mobileSessionId, mobileSession.id))
      .limit(1);

    if (prefsRow.length === 0) {
      // Create default preferences
      const inserted = await db
        .insert(notificationPreferences)
        .values({
          mobileSessionId: mobileSession.id,
        })
        .returning();

      prefsRow = inserted;
    }

    const row = prefsRow[0];
    if (!row) {
      return reply.internalServerError('Failed to load notification preferences');
    }

    // Get live rate limit status from Redis
    const prefs = toApiResponse(row);
    const rateLimiter = getPushRateLimiter();

    if (rateLimiter) {
      const status = await rateLimiter.getStatus(mobileSession.id, {
        maxPerMinute: prefs.maxPerMinute,
        maxPerHour: prefs.maxPerHour,
      });

      const response: NotificationPreferencesWithStatus = {
        ...prefs,
        rateLimitStatus: {
          remainingMinute: status.remainingMinute,
          remainingHour: status.remainingHour,
          resetMinuteIn: status.resetMinuteIn,
          resetHourIn: status.resetHourIn,
        },
      };

      return response;
    }

    return prefs;
  });

  /**
   * PATCH /notifications/preferences - Update preferences for current device
   *
   * Requires mobile authentication. Updates notification preferences for the
   * device's session.
   */
  app.patch('/preferences', { preHandler: [app.requireMobile] }, async (request, reply) => {
    const body = updatePreferencesSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const authUser = request.user;

    // Find mobile session using deviceId (preferred) or fallback to user lookup
    const mobileSession = authUser.deviceId
      ? await findMobileSessionByDeviceId(authUser.deviceId)
      : await findMobileSessionForUserFallback(authUser.userId);
    if (!mobileSession) {
      return reply.notFound('No mobile session found. Please pair the device first.');
    }

    // Ensure preferences row exists
    let existing = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.mobileSessionId, mobileSession.id))
      .limit(1);

    if (existing.length === 0) {
      // Create with defaults first
      const inserted = await db
        .insert(notificationPreferences)
        .values({
          mobileSessionId: mobileSession.id,
        })
        .returning();
      existing = inserted;
    }

    const prefsId = existing[0]!.id;

    // Build update object
    const updateData: Partial<typeof notificationPreferences.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (body.data.pushEnabled !== undefined) {
      updateData.pushEnabled = body.data.pushEnabled;
    }
    if (body.data.onViolationDetected !== undefined) {
      updateData.onViolationDetected = body.data.onViolationDetected;
    }
    if (body.data.onStreamStarted !== undefined) {
      updateData.onStreamStarted = body.data.onStreamStarted;
    }
    if (body.data.onStreamStopped !== undefined) {
      updateData.onStreamStopped = body.data.onStreamStopped;
    }
    if (body.data.onConcurrentStreams !== undefined) {
      updateData.onConcurrentStreams = body.data.onConcurrentStreams;
    }
    if (body.data.onNewDevice !== undefined) {
      updateData.onNewDevice = body.data.onNewDevice;
    }
    if (body.data.onTrustScoreChanged !== undefined) {
      updateData.onTrustScoreChanged = body.data.onTrustScoreChanged;
    }
    if (body.data.onServerDown !== undefined) {
      updateData.onServerDown = body.data.onServerDown;
    }
    if (body.data.onServerUp !== undefined) {
      updateData.onServerUp = body.data.onServerUp;
    }
    if (body.data.violationMinSeverity !== undefined) {
      updateData.violationMinSeverity = body.data.violationMinSeverity;
    }
    if (body.data.violationRuleTypes !== undefined) {
      updateData.violationRuleTypes = body.data.violationRuleTypes;
    }
    if (body.data.maxPerMinute !== undefined) {
      updateData.maxPerMinute = body.data.maxPerMinute;
    }
    if (body.data.maxPerHour !== undefined) {
      updateData.maxPerHour = body.data.maxPerHour;
    }
    if (body.data.quietHoursEnabled !== undefined) {
      updateData.quietHoursEnabled = body.data.quietHoursEnabled;
    }
    if (body.data.quietHoursStart !== undefined) {
      updateData.quietHoursStart = body.data.quietHoursStart;
    }
    if (body.data.quietHoursEnd !== undefined) {
      updateData.quietHoursEnd = body.data.quietHoursEnd;
    }
    if (body.data.quietHoursTimezone !== undefined) {
      updateData.quietHoursTimezone = body.data.quietHoursTimezone;
    }
    if (body.data.quietHoursOverrideCritical !== undefined) {
      updateData.quietHoursOverrideCritical = body.data.quietHoursOverrideCritical;
    }

    // Update preferences
    await db
      .update(notificationPreferences)
      .set(updateData)
      .where(eq(notificationPreferences.id, prefsId));

    // Return updated preferences
    const updated = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.id, prefsId))
      .limit(1);

    const row = updated[0];
    if (!row) {
      return reply.internalServerError('Failed to update notification preferences');
    }

    app.log.info(
      { userId: authUser.userId, mobileSessionId: mobileSession.id },
      'Notification preferences updated'
    );

    return toApiResponse(row);
  });
};

/**
 * Get notification preferences for a specific mobile session (internal use)
 */
export async function getPreferencesForSession(
  mobileSessionId: string
): Promise<typeof notificationPreferences.$inferSelect | null> {
  const prefs = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.mobileSessionId, mobileSessionId))
    .limit(1);

  return prefs[0] ?? null;
}

/**
 * Get notification preferences for a push token (internal use by push service)
 */
export async function getPreferencesForPushToken(
  expoPushToken: string
): Promise<typeof notificationPreferences.$inferSelect | null> {
  // Find the mobile session with this push token
  const session = await db
    .select({ id: mobileSessions.id })
    .from(mobileSessions)
    .where(eq(mobileSessions.expoPushToken, expoPushToken))
    .limit(1);

  if (session.length === 0 || !session[0]) {
    return null;
  }

  return getPreferencesForSession(session[0].id);
}
