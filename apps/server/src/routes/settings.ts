/**
 * Settings routes - Application configuration
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { updateSettingsSchema, type Settings } from '@tracearr/shared';
import { db } from '../db/client.js';
import { users, sessions } from '../db/schema.js';
import { geoipService } from '../services/geoip.js';
import { getImageCacheStatus } from '../services/imageCacheSweep.js';
import { getAllSettings, rearmImportedHistoryLink, setSettings } from '../services/settings.js';

// Re-export service getters so existing import paths still work
export {
  getPollerSettings,
  getGeoIPSettings,
  getNetworkSettings,
  getBackupScheduleSettings,
} from '../services/settings.js';

// API token format: trr_pub_<32 random bytes as base64url>
const API_TOKEN_PREFIX = 'trr_pub_';

function generateApiToken(): string {
  const randomPart = randomBytes(32).toString('base64url');
  return `${API_TOKEN_PREFIX}${randomPart}`;
}

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

    return getAllSettings();
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

    // Build update object from provided fields
    const updates: Partial<Settings> = {};

    for (const [key, value] of Object.entries(body.data)) {
      if (value !== undefined) {
        if (key === 'externalUrl' && typeof value === 'string') {
          // Strip trailing slash for consistency
          updates.externalUrl = value.replace(/\/+$/, '') || null;
        } else {
          (updates as Record<string, unknown>)[key] = value;
        }
      }
    }

    await setSettings(updates);
    if (updates.tautulliUrl !== undefined || updates.tautulliApiKey !== undefined) {
      await rearmImportedHistoryLink({ keepProviderPass: true });
    }

    // Return updated settings with masks
    return getAllSettings();
  });

  /**
   * GET /settings/api-key - Get current API key
   * Returns the full API key (retrievable anytime like Sonarr/Radarr)
   */
  app.get('/api-key', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can manage API keys
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can manage API keys');
    }

    const [user] = await db
      .select({ apiToken: users.apiToken })
      .from(users)
      .where(eq(users.id, authUser.userId))
      .limit(1);

    return { token: user?.apiToken ?? null };
  });

  /**
   * POST /settings/api-key/regenerate - Generate or regenerate API key
   * Creates a new API key, invalidating any previous key
   */
  app.post('/api-key/regenerate', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can manage API keys
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can manage API keys');
    }

    const newToken = generateApiToken();

    await db
      .update(users)
      .set({ apiToken: newToken, updatedAt: new Date() })
      .where(eq(users.id, authUser.userId));

    return { token: newToken };
  });

  /**
   * GET /settings/ip-warning - Check if IP configuration warning should be shown
   * Returns whether all users have the same IP or all have local/private IPs
   */
  app.get('/ip-warning', { preHandler: [app.authenticate] }, async (_request, _reply) => {
    // Get distinct IPs from recent sessions (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const distinctIps = await db
      .selectDistinct({
        ipAddress: sessions.ipAddress,
      })
      .from(sessions)
      .where(sql`${sessions.startedAt} >= ${thirtyDaysAgo}`);

    // If no sessions, don't show warning
    if (distinctIps.length === 0) {
      return { showWarning: false, stateHash: 'no-sessions' };
    }

    // Check if all IPs are the same
    const uniqueIps = distinctIps
      .map((row) => row.ipAddress)
      .filter((ip): ip is string => ip !== null);
    const allSameIp = uniqueIps.length === 1;

    // Check if all IPs are private/local
    const allPrivate = uniqueIps.every((ip) => geoipService.isPrivateIP(ip));

    const showWarning = allSameIp || allPrivate;

    // Generate stateHash based on the situation
    let stateHash: string;
    if (allSameIp && allPrivate) {
      stateHash = 'single-private-ip';
    } else if (allSameIp) {
      stateHash = 'single-ip';
    } else if (allPrivate) {
      stateHash = 'all-private';
    } else {
      stateHash = 'normal';
    }

    return { showWarning, stateHash };
  });

  /** GET /settings/image-cache - poster cache size, need, free disk, disk-limited flag */
  app.get('/image-cache', { preHandler: [app.authenticate] }, async (request, reply) => {
    if (request.user.role !== 'owner') {
      return reply.forbidden('Only server owners can view settings');
    }
    return getImageCacheStatus();
  });
};
