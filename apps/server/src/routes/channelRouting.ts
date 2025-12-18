/**
 * Notification Channel Routing routes - Controls which channels receive which events
 *
 * Web admin endpoints:
 * - GET /settings/notifications/routing - Get all routing configuration
 * - PATCH /settings/notifications/routing/:eventType - Update routing for specific event
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { NotificationChannelRouting, NotificationEventType } from '@tracearr/shared';
import { db } from '../db/client.js';
import { notificationChannelRouting, notificationEventTypeEnum } from '../db/schema.js';

// Valid event types for validation
const validEventTypes = notificationEventTypeEnum as readonly string[];

// Update routing schema
const updateRoutingSchema = z.object({
  discordEnabled: z.boolean().optional(),
  webhookEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
  webToastEnabled: z.boolean().optional(),
});

/**
 * Transform DB row to API response
 */
function toApiResponse(
  row: typeof notificationChannelRouting.$inferSelect
): NotificationChannelRouting {
  return {
    id: row.id,
    eventType: row.eventType,
    discordEnabled: row.discordEnabled,
    webhookEnabled: row.webhookEnabled,
    pushEnabled: row.pushEnabled,
    webToastEnabled: row.webToastEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const channelRoutingRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /settings/notifications/routing - Get all routing configuration
   *
   * Requires owner authentication. Returns routing configuration for all event types.
   */
  app.get('/routing', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can view routing settings
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can view notification routing');
    }

    // Get all routing configuration
    const rows = await db
      .select()
      .from(notificationChannelRouting)
      .orderBy(notificationChannelRouting.eventType);

    // If no rows exist (shouldn't happen due to seed), create defaults
    if (rows.length === 0) {
      const defaultRouting = notificationEventTypeEnum.map((eventType) => ({
        eventType,
        discordEnabled: !['stream_started', 'stream_stopped', 'trust_score_changed'].includes(
          eventType
        ),
        webhookEnabled: !['stream_started', 'stream_stopped', 'trust_score_changed'].includes(
          eventType
        ),
        pushEnabled: !['stream_started', 'stream_stopped', 'trust_score_changed'].includes(
          eventType
        ),
        webToastEnabled: !['stream_started', 'stream_stopped', 'trust_score_changed'].includes(
          eventType
        ),
      }));

      const inserted = await db
        .insert(notificationChannelRouting)
        .values(defaultRouting)
        .returning();

      return inserted.map(toApiResponse);
    }

    return rows.map(toApiResponse);
  });

  /**
   * PATCH /settings/notifications/routing/:eventType - Update routing for specific event
   *
   * Requires owner authentication. Updates channel routing for a specific event type.
   */
  app.patch<{ Params: { eventType: string } }>(
    '/routing/:eventType',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { eventType } = request.params;

      // Validate event type
      if (!validEventTypes.includes(eventType)) {
        return reply.badRequest(`Invalid event type: ${eventType}`);
      }

      const body = updateRoutingSchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('Invalid request body');
      }

      const authUser = request.user;

      // Only owners can update routing settings
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can update notification routing');
      }

      // Find existing routing
      const existing = await db
        .select()
        .from(notificationChannelRouting)
        .where(eq(notificationChannelRouting.eventType, eventType as NotificationEventType))
        .limit(1);

      let routingId: string;

      if (existing.length === 0) {
        // Create new routing record
        const inserted = await db
          .insert(notificationChannelRouting)
          .values({
            eventType: eventType as NotificationEventType,
            discordEnabled: body.data.discordEnabled ?? true,
            webhookEnabled: body.data.webhookEnabled ?? true,
            pushEnabled: body.data.pushEnabled ?? true,
            webToastEnabled: body.data.webToastEnabled ?? true,
          })
          .returning();

        if (!inserted[0]) {
          return reply.internalServerError('Failed to create routing configuration');
        }

        routingId = inserted[0].id;
      } else {
        routingId = existing[0]!.id;

        // Build update object
        const updateData: Partial<typeof notificationChannelRouting.$inferInsert> = {
          updatedAt: new Date(),
        };

        if (body.data.discordEnabled !== undefined) {
          updateData.discordEnabled = body.data.discordEnabled;
        }
        if (body.data.webhookEnabled !== undefined) {
          updateData.webhookEnabled = body.data.webhookEnabled;
        }
        if (body.data.pushEnabled !== undefined) {
          updateData.pushEnabled = body.data.pushEnabled;
        }
        if (body.data.webToastEnabled !== undefined) {
          updateData.webToastEnabled = body.data.webToastEnabled;
        }

        await db
          .update(notificationChannelRouting)
          .set(updateData)
          .where(eq(notificationChannelRouting.id, routingId));
      }

      // Return updated routing
      const updated = await db
        .select()
        .from(notificationChannelRouting)
        .where(eq(notificationChannelRouting.id, routingId))
        .limit(1);

      const row = updated[0];
      if (!row) {
        return reply.internalServerError('Failed to update routing configuration');
      }

      app.log.info({ userId: authUser.userId, eventType }, 'Notification channel routing updated');

      return toApiResponse(row);
    }
  );
};

/**
 * Channel routing for a specific event type (internal use by notification services)
 */
export interface ChannelRoutingConfig {
  discordEnabled: boolean;
  webhookEnabled: boolean;
  pushEnabled: boolean;
  webToastEnabled: boolean;
}

/**
 * Get channel routing for a specific event type (internal use)
 */
export async function getChannelRouting(
  eventType: NotificationEventType
): Promise<ChannelRoutingConfig> {
  const row = await db
    .select({
      discordEnabled: notificationChannelRouting.discordEnabled,
      webhookEnabled: notificationChannelRouting.webhookEnabled,
      pushEnabled: notificationChannelRouting.pushEnabled,
      webToastEnabled: notificationChannelRouting.webToastEnabled,
    })
    .from(notificationChannelRouting)
    .where(eq(notificationChannelRouting.eventType, eventType))
    .limit(1);

  const routing = row[0];
  if (!routing) {
    // Return defaults if no routing exists
    // Most events default to enabled, except stream started/stopped
    const isLowPriorityEvent = ['stream_started', 'stream_stopped', 'trust_score_changed'].includes(
      eventType
    );
    return {
      discordEnabled: !isLowPriorityEvent,
      webhookEnabled: !isLowPriorityEvent,
      pushEnabled: !isLowPriorityEvent,
      webToastEnabled: !isLowPriorityEvent,
    };
  }

  return routing;
}

/**
 * Get all channel routing configuration (internal use for caching)
 */
export async function getAllChannelRouting(): Promise<
  Map<NotificationEventType, ChannelRoutingConfig>
> {
  const rows = await db
    .select({
      eventType: notificationChannelRouting.eventType,
      discordEnabled: notificationChannelRouting.discordEnabled,
      webhookEnabled: notificationChannelRouting.webhookEnabled,
      pushEnabled: notificationChannelRouting.pushEnabled,
      webToastEnabled: notificationChannelRouting.webToastEnabled,
    })
    .from(notificationChannelRouting);

  const routingMap = new Map<NotificationEventType, ChannelRoutingConfig>();

  for (const row of rows) {
    routingMap.set(row.eventType, {
      discordEnabled: row.discordEnabled,
      webhookEnabled: row.webhookEnabled,
      pushEnabled: row.pushEnabled,
      webToastEnabled: row.webToastEnabled,
    });
  }

  return routingMap;
}
