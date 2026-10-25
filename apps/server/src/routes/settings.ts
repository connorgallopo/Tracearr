/**
 * Settings routes - Application configuration
 */

import type { FastifyPluginAsync } from 'fastify';
import { and, eq, ne, sql } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { APIError } from 'better-auth/api';
import {
  CACHE_TTL,
  REDIS_KEYS,
  WS_EVENTS,
  updateSettingsSchema,
  type Settings,
  type SettingsResponse,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { users, sessions } from '../db/schema.js';
import { getPubSubService } from '../services/cache.js';
import { geoipService } from '../services/geoip.js';
import { getImageCacheStatus } from '../services/imageCacheSweep.js';
import {
  getAllSettings,
  getSetting,
  rearmImportedHistoryLink,
  setSettings,
} from '../services/settings.js';
import { dismissStorageWarning, getStorageWarning } from '../services/storageCheck.js';
import { assertOwnerKeepsALoginMethod } from '../lib/authGuards.js';
import { oidcConfigured } from '../lib/oidcEnv.js';
import { revokeSessionsForUsers } from '../lib/revoke.js';

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

async function settingsResponse(): Promise<SettingsResponse> {
  return { ...(await getAllSettings()), oidcConfigured };
}

type IpWarning = { showWarning: boolean; stateHash: string };

async function computeIpWarning(): Promise<IpWarning> {
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
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  const readSettings = { preHandler: [app.requirePermission('settings', 'read')] };
  const writeSettings = { preHandler: [app.requirePermission('settings', 'write')] };
  const readApiToken = { preHandler: [app.requirePermission('apiToken', 'read')] };
  const writeApiToken = { preHandler: [app.requirePermission('apiToken', 'write')] };
  /**
   * GET /settings - Get application settings
   */
  app.get('/', readSettings, async (request, reply) => {
    const authUser = request.user;

    // Only owners can view settings
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can view settings');
    }

    return settingsResponse();
  });

  /**
   * PATCH /settings - Update application settings
   */
  app.patch('/', writeSettings, async (request, reply) => {
    const body = updateSettingsSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const authUser = request.user;

    // Only owners can update settings
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can update settings');
    }

    const { loginMethods: loginMethodsChange, ...fields } = body.data;

    // Build update object from provided fields
    const updates: Partial<Settings> = {};

    if (loginMethodsChange) {
      try {
        await assertOwnerKeepsALoginMethod(loginMethodsChange);
      } catch (err) {
        if (err instanceof APIError) return reply.badRequest(err.message);
        throw err;
      }
      const current = await getSetting('loginMethods');
      updates.loginMethods = { ...current, ...loginMethodsChange };
    }

    for (const [key, value] of Object.entries(fields)) {
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
    // Asked for, not changed: a resend after a revoke that failed must still sign them out.
    if (loginMethodsChange?.member === false) {
      // Every synced account is default, so only those holding a session are worth revoking.
      const members = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.loginAccess, 'default'),
            ne(users.role, 'owner'),
            sql`exists (select 1 from auth_sessions s where s.user_id = ${users.id})`
          )
        );
      await revokeSessionsForUsers(members.map((m) => m.id));
    }
    if (updates.tautulliUrl !== undefined || updates.tautulliApiKey !== undefined) {
      await rearmImportedHistoryLink({ keepProviderPass: true });
    }

    // Return updated settings with masks
    return settingsResponse();
  });

  /**
   * GET /settings/api-key - Get current API key
   * Returns the full API key (retrievable anytime like Sonarr/Radarr)
   */
  app.get('/api-key', readApiToken, async (request, reply) => {
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
  app.post('/api-key/regenerate', writeApiToken, async (request, reply) => {
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

    // The key is already rotated; a failed publish must not turn that into a 500.
    try {
      await getPubSubService()?.publish(WS_EVENTS.PUBLIC_API_KEY_CHANGED, {
        userId: authUser.userId,
      });
    } catch (err) {
      request.log.warn({ err }, 'public API key change publish failed');
    }

    return { token: newToken };
  });

  /**
   * GET /settings/ip-warning - Check if IP configuration warning should be shown
   * Returns whether all users have the same IP or all have local/private IPs
   */
  app.get('/ip-warning', readSettings, async (_request, _reply) => {
    const cached = await app.redis.get(REDIS_KEYS.IP_WARNING);
    if (cached) return JSON.parse(cached) as IpWarning;

    const warning = await computeIpWarning();
    await app.redis.setex(REDIS_KEYS.IP_WARNING, CACHE_TTL.IP_WARNING, JSON.stringify(warning));
    return warning;
  });

  /** GET /settings/image-cache - poster cache size, need, free disk, disk-limited flag */
  app.get('/image-cache', readSettings, async (request, reply) => {
    if (request.user.role !== 'owner') {
      return reply.forbidden('Only server owners can view settings');
    }
    return getImageCacheStatus();
  });

  /** GET /settings/storage-warning - data volumes on a FUSE mount, from this boot's check */
  app.get('/storage-warning', readSettings, async (request, reply) => {
    if (request.user.role !== 'owner') {
      return reply.forbidden('Only server owners can view settings');
    }
    return getStorageWarning();
  });

  /** POST /settings/storage-warning/dismiss - hide the storage warning until the next boot */
  app.post('/storage-warning/dismiss', writeSettings, async (request, reply) => {
    if (request.user.role !== 'owner') {
      return reply.forbidden('Only server owners can update settings');
    }
    dismissStorageWarning();
    return reply.code(204).send();
  });
};
