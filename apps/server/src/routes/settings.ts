/**
 * Settings routes - Application configuration
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { updateSettingsSchema, type Settings } from '@tracearr/shared';
import { db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { sendTestWebhook } from '../services/notify.js';

// Default settings row ID (singleton pattern)
const SETTINGS_ID = 1;

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /settings - Get application settings
   */
  app.get('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can view settings
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can view settings');
    }

    // Get or create settings
    // First try to get settings - if primaryAuthMethod column doesn't exist, this will fail
    let settingsRow;
    let primaryAuthMethod: 'jellyfin' | 'local' = 'local';

    try {
      // Try full select including primaryAuthMethod
      settingsRow = await db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).limit(1);

      // If we got here, column exists - extract the value
      const row = settingsRow[0];
      if (row && 'primaryAuthMethod' in row && row.primaryAuthMethod) {
        primaryAuthMethod = row.primaryAuthMethod;
      }
    } catch {
      // Column doesn't exist yet - select without primaryAuthMethod
      // We need to explicitly select each column
      settingsRow = await db
        .select({
          id: settings.id,
          allowGuestAccess: settings.allowGuestAccess,
          unitSystem: settings.unitSystem,
          discordWebhookUrl: settings.discordWebhookUrl,
          customWebhookUrl: settings.customWebhookUrl,
          webhookFormat: settings.webhookFormat,
          ntfyTopic: settings.ntfyTopic,
          ntfyAuthToken: settings.ntfyAuthToken,
          pollerEnabled: settings.pollerEnabled,
          pollerIntervalMs: settings.pollerIntervalMs,
          tautulliUrl: settings.tautulliUrl,
          tautulliApiKey: settings.tautulliApiKey,
          externalUrl: settings.externalUrl,
          basePath: settings.basePath,
          trustProxy: settings.trustProxy,
          mobileEnabled: settings.mobileEnabled,
          updatedAt: settings.updatedAt,
        })
        .from(settings)
        .where(eq(settings.id, SETTINGS_ID))
        .limit(1);
      // Use default since column doesn't exist
      primaryAuthMethod = 'local';
    }

    // Create default settings if not exists
    if (settingsRow.length === 0) {
      try {
        const inserted = await db
          .insert(settings)
          .values({
            id: SETTINGS_ID,
            allowGuestAccess: false,
            primaryAuthMethod: 'local',
          })
          .returning();
        settingsRow = inserted;
      } catch {
        // Column doesn't exist - insert without primaryAuthMethod
        const inserted = await db
          .insert(settings)
          .values({
            id: SETTINGS_ID,
            allowGuestAccess: false,
          })
          .returning();
        settingsRow = inserted;
      }
    }

    const row = settingsRow[0];
    if (!row) {
      return reply.internalServerError('Failed to load settings');
    }

    const result: Settings = {
      allowGuestAccess: row.allowGuestAccess,
      unitSystem: row.unitSystem,
      discordWebhookUrl: row.discordWebhookUrl,
      customWebhookUrl: row.customWebhookUrl,
      webhookFormat: row.webhookFormat,
      ntfyTopic: row.ntfyTopic,
      ntfyAuthToken: row.ntfyAuthToken ? '********' : null, // Mask auth token
      pollerEnabled: row.pollerEnabled,
      pollerIntervalMs: row.pollerIntervalMs,
      tautulliUrl: row.tautulliUrl,
      tautulliApiKey: row.tautulliApiKey ? '********' : null, // Mask API key
      externalUrl: row.externalUrl,
      basePath: row.basePath,
      trustProxy: row.trustProxy,
      mobileEnabled: row.mobileEnabled,
      primaryAuthMethod,
    };

    return result;
  });

  /**
   * PATCH /settings - Update application settings
   */
  app.patch('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = updateSettingsSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const authUser = request.user;

    // Only owners can update settings
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can update settings');
    }

    // Build update object
    const updateData: Partial<{
      allowGuestAccess: boolean;
      unitSystem: 'metric' | 'imperial';
      discordWebhookUrl: string | null;
      customWebhookUrl: string | null;
      webhookFormat: 'json' | 'ntfy' | 'apprise' | null;
      ntfyTopic: string | null;
      ntfyAuthToken: string | null;
      pollerEnabled: boolean;
      pollerIntervalMs: number;
      tautulliUrl: string | null;
      tautulliApiKey: string | null;
      externalUrl: string | null;
      basePath: string;
      trustProxy: boolean;
      primaryAuthMethod: 'jellyfin' | 'local';
      updatedAt: Date;
    }> = {
      updatedAt: new Date(),
    };

    if (body.data.allowGuestAccess !== undefined) {
      updateData.allowGuestAccess = body.data.allowGuestAccess;
    }

    if (body.data.unitSystem !== undefined) {
      updateData.unitSystem = body.data.unitSystem;
    }

    if (body.data.discordWebhookUrl !== undefined) {
      updateData.discordWebhookUrl = body.data.discordWebhookUrl;
    }

    if (body.data.customWebhookUrl !== undefined) {
      updateData.customWebhookUrl = body.data.customWebhookUrl;
    }

    if (body.data.webhookFormat !== undefined) {
      updateData.webhookFormat = body.data.webhookFormat;
    }

    if (body.data.ntfyTopic !== undefined) {
      updateData.ntfyTopic = body.data.ntfyTopic;
    }

    if (body.data.ntfyAuthToken !== undefined) {
      updateData.ntfyAuthToken = body.data.ntfyAuthToken;
    }

    if (body.data.pollerEnabled !== undefined) {
      updateData.pollerEnabled = body.data.pollerEnabled;
    }

    if (body.data.pollerIntervalMs !== undefined) {
      updateData.pollerIntervalMs = body.data.pollerIntervalMs;
    }

    if (body.data.tautulliUrl !== undefined) {
      updateData.tautulliUrl = body.data.tautulliUrl;
    }

    if (body.data.tautulliApiKey !== undefined) {
      // Store API key as-is (could encrypt if needed)
      updateData.tautulliApiKey = body.data.tautulliApiKey;
    }

    if (body.data.externalUrl !== undefined) {
      // Strip trailing slash for consistency
      updateData.externalUrl = body.data.externalUrl?.replace(/\/+$/, '') ?? null;
    }

    if (body.data.basePath !== undefined) {
      // Normalize base path: ensure leading slash, no trailing slash
      let path = body.data.basePath.trim();
      if (path && !path.startsWith('/')) {
        path = '/' + path;
      }
      path = path.replace(/\/+$/, '');
      updateData.basePath = path;
    }

    if (body.data.trustProxy !== undefined) {
      updateData.trustProxy = body.data.trustProxy;
    }

    if (body.data.primaryAuthMethod !== undefined) {
      updateData.primaryAuthMethod = body.data.primaryAuthMethod;
    }

    // Ensure settings row exists
    const existing = await db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).limit(1);

    if (existing.length === 0) {
      // Create with provided values - use full updateData with defaults for required fields
      // Note: mobileEnabled is not in updateData, so it will use the database default (false)
      await db.insert(settings).values({
        id: SETTINGS_ID,
        allowGuestAccess: updateData.allowGuestAccess ?? false,
        discordWebhookUrl: updateData.discordWebhookUrl ?? null,
        customWebhookUrl: updateData.customWebhookUrl ?? null,
        webhookFormat: updateData.webhookFormat ?? null,
        ntfyTopic: updateData.ntfyTopic ?? null,
        ntfyAuthToken: updateData.ntfyAuthToken ?? null,
        pollerEnabled: updateData.pollerEnabled ?? true,
        pollerIntervalMs: updateData.pollerIntervalMs ?? 15000,
        tautulliUrl: updateData.tautulliUrl ?? null,
        tautulliApiKey: updateData.tautulliApiKey ?? null,
        externalUrl: updateData.externalUrl ?? null,
        basePath: updateData.basePath ?? '',
        trustProxy: updateData.trustProxy ?? false,
        primaryAuthMethod: updateData.primaryAuthMethod ?? 'local',
      });
    } else {
      // Update existing
      await db.update(settings).set(updateData).where(eq(settings.id, SETTINGS_ID));
    }

    // Return updated settings
    const updated = await db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).limit(1);

    const row = updated[0];
    if (!row) {
      return reply.internalServerError('Failed to update settings');
    }

    // Handle case where primaryAuthMethod column might not exist yet (before migration)
    let primaryAuthMethod: 'jellyfin' | 'local' = 'local';
    if ('primaryAuthMethod' in row && row.primaryAuthMethod) {
      primaryAuthMethod = row.primaryAuthMethod;
    }

    const result: Settings = {
      allowGuestAccess: row.allowGuestAccess,
      unitSystem: row.unitSystem,
      discordWebhookUrl: row.discordWebhookUrl,
      customWebhookUrl: row.customWebhookUrl,
      webhookFormat: row.webhookFormat,
      ntfyTopic: row.ntfyTopic,
      ntfyAuthToken: row.ntfyAuthToken ? '********' : null, // Mask auth token
      pollerEnabled: row.pollerEnabled,
      pollerIntervalMs: row.pollerIntervalMs,
      tautulliUrl: row.tautulliUrl,
      tautulliApiKey: row.tautulliApiKey ? '********' : null, // Mask API key
      externalUrl: row.externalUrl,
      basePath: row.basePath,
      trustProxy: row.trustProxy,
      mobileEnabled: row.mobileEnabled,
      primaryAuthMethod,
    };

    return result;
  });

  /**
   * POST /settings/test-webhook - Send a test notification to verify webhook configuration
   */
  app.post<{
    Body: {
      type: 'discord' | 'custom';
      url?: string;
      format?: 'json' | 'ntfy' | 'apprise';
      ntfyTopic?: string;
      ntfyAuthToken?: string;
    };
  }>('/test-webhook', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can test webhooks
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can test webhooks');
    }

    const { type, url, format, ntfyTopic, ntfyAuthToken } = request.body;

    if (!type) {
      return reply.badRequest('Missing webhook type');
    }

    // Get current settings to find the URL if not provided
    const settingsRow = await db
      .select()
      .from(settings)
      .where(eq(settings.id, SETTINGS_ID))
      .limit(1);

    const currentSettings = settingsRow[0];

    let webhookUrl: string | null = null;
    let webhookFormat: 'json' | 'ntfy' | 'apprise' = 'json';
    let topic: string | null = null;
    let authToken: string | null = null;

    if (type === 'discord') {
      webhookUrl = url ?? currentSettings?.discordWebhookUrl ?? null;
    } else {
      webhookUrl = url ?? currentSettings?.customWebhookUrl ?? null;
      webhookFormat = format ?? currentSettings?.webhookFormat ?? 'json';
      topic = ntfyTopic ?? currentSettings?.ntfyTopic ?? null;
      authToken = ntfyAuthToken ?? currentSettings?.ntfyAuthToken ?? null;
    }

    if (!webhookUrl) {
      return reply.badRequest(`No ${type} webhook URL configured`);
    }

    const result = await sendTestWebhook(webhookUrl, type, webhookFormat, topic, authToken);

    if (!result.success) {
      return reply.code(502).send({
        success: false,
        error: result.error ?? 'Webhook test failed',
      });
    }

    return { success: true };
  });
};

/**
 * Get poller settings from database (for internal use by poller)
 */
export async function getPollerSettings(): Promise<{ enabled: boolean; intervalMs: number }> {
  const row = await db
    .select({
      pollerEnabled: settings.pollerEnabled,
      pollerIntervalMs: settings.pollerIntervalMs,
    })
    .from(settings)
    .where(eq(settings.id, SETTINGS_ID))
    .limit(1);

  const settingsRow = row[0];
  if (!settingsRow) {
    // Return defaults if settings don't exist yet
    return { enabled: true, intervalMs: 15000 };
  }

  return {
    enabled: settingsRow.pollerEnabled,
    intervalMs: settingsRow.pollerIntervalMs,
  };
}

/**
 * Get network settings from database (for internal use)
 */
export async function getNetworkSettings(): Promise<{
  externalUrl: string | null;
  basePath: string;
  trustProxy: boolean;
}> {
  const row = await db
    .select({
      externalUrl: settings.externalUrl,
      basePath: settings.basePath,
      trustProxy: settings.trustProxy,
    })
    .from(settings)
    .where(eq(settings.id, SETTINGS_ID))
    .limit(1);

  const settingsRow = row[0];
  if (!settingsRow) {
    // Return defaults if settings don't exist yet
    return { externalUrl: null, basePath: '', trustProxy: false };
  }

  return {
    externalUrl: settingsRow.externalUrl,
    basePath: settingsRow.basePath,
    trustProxy: settingsRow.trustProxy,
  };
}

/**
 * Notification settings for internal use by NotificationDispatcher
 */
export interface NotificationSettings {
  discordWebhookUrl: string | null;
  customWebhookUrl: string | null;
  webhookFormat: 'json' | 'ntfy' | 'apprise' | null;
  ntfyTopic: string | null;
  ntfyAuthToken: string | null;
  webhookSecret: string | null;
  mobileEnabled: boolean;
  unitSystem: 'metric' | 'imperial';
}

/**
 * Get notification settings from database (for internal use by notification dispatcher)
 */
export async function getNotificationSettings(): Promise<NotificationSettings> {
  const row = await db
    .select({
      discordWebhookUrl: settings.discordWebhookUrl,
      customWebhookUrl: settings.customWebhookUrl,
      webhookFormat: settings.webhookFormat,
      ntfyTopic: settings.ntfyTopic,
      ntfyAuthToken: settings.ntfyAuthToken,
      mobileEnabled: settings.mobileEnabled,
      unitSystem: settings.unitSystem,
    })
    .from(settings)
    .where(eq(settings.id, SETTINGS_ID))
    .limit(1);

  const settingsRow = row[0];
  if (!settingsRow) {
    // Return defaults if settings don't exist yet
    return {
      discordWebhookUrl: null,
      customWebhookUrl: null,
      webhookFormat: null,
      ntfyTopic: null,
      ntfyAuthToken: null,
      webhookSecret: null,
      mobileEnabled: false,
      unitSystem: 'metric',
    };
  }

  return {
    discordWebhookUrl: settingsRow.discordWebhookUrl,
    customWebhookUrl: settingsRow.customWebhookUrl,
    webhookFormat: settingsRow.webhookFormat,
    ntfyTopic: settingsRow.ntfyTopic,
    ntfyAuthToken: settingsRow.ntfyAuthToken,
    webhookSecret: null, // TODO: Add webhookSecret column to settings table in Phase 4
    mobileEnabled: settingsRow.mobileEnabled,
    unitSystem: settingsRow.unitSystem,
  };
}
