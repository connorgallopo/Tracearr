/**
 * Settings routes tests
 *
 * Tests the API endpoints for application settings:
 * - GET /settings - Get application settings (owner only)
 * - PATCH /settings - Update application settings (owner only)
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, ImageCacheStatus, Settings } from '@tracearr/shared';

// Mock the settings service
vi.mock('../../services/settings.js', () => ({
  getAllSettings: vi.fn(),
  setSettings: vi.fn(),
  getSettings: vi.fn(),
  getSetting: vi.fn(),
  rearmImportedHistoryLink: vi.fn(),
  getPollerSettings: vi.fn(),
  getGeoIPSettings: vi.fn(),
  getNetworkSettings: vi.fn(),
  getBackupScheduleSettings: vi.fn(),
}));

// Mock the image cache service
vi.mock('../../services/imageCacheSweep.js', () => ({
  getImageCacheStatus: vi.fn(),
}));

// Mock the database module (still needed for api-key and ip-warning routes)
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    selectDistinct: vi.fn(),
  },
}));

const { mockPublish } = vi.hoisted(() => ({ mockPublish: vi.fn(async () => undefined) }));

vi.mock('../../services/cache.js', () => ({
  getPubSubService: () => ({ publish: mockPublish }),
}));

vi.mock('../../lib/authGuards.js', () => ({ assertOwnerKeepsALoginMethod: vi.fn() }));
vi.mock('../../lib/revoke.js', () => ({ revokeSessionsForUsers: vi.fn() }));
vi.mock('../../lib/oidcEnv.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  oidcConfigured: true,
}));

// Mock geoip service
vi.mock('../../services/geoip.js', () => ({
  geoipService: {
    isPrivateIP: vi.fn(),
  },
}));

import { APIError } from 'better-auth/api';
import type { SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { queryChain, renderSql } from '../../test/helpers.js';
import {
  getAllSettings,
  getSetting,
  rearmImportedHistoryLink,
  setSettings,
} from '../../services/settings.js';
import { assertOwnerKeepsALoginMethod } from '../../lib/authGuards.js';
import { revokeSessionsForUsers } from '../../lib/revoke.js';
import { getImageCacheStatus } from '../../services/imageCacheSweep.js';
import { geoipService } from '../../services/geoip.js';
import { settingsRoutes } from '../settings.js';
import { permissionGuard } from '../../lib/scope.js';

const mockAllSettings: Settings = {
  loginMethods: { local: true, plex: true, oidc: true, member: false },
  unitSystem: 'metric',
  pollerEnabled: true,
  pollerIntervalMs: 15000,
  usePlexGeoip: false,
  tautulliUrl: 'http://localhost:8181',
  tautulliApiKey: 'secret-api-key',
  externalUrl: 'https://tracearr.example.com',
  trustProxy: true,
  mobileEnabled: false,
  tailscaleEnabled: false,
  tailscaleHostname: null,
  backupScheduleType: 'disabled',
  backupScheduleTime: '02:00',
  backupScheduleDayOfWeek: 0,
  backupScheduleDayOfMonth: 1,
  backupRetentionCount: 7,
  pluginUpdateCheckEnabled: true,
  pluginManifestUrl: null,
  serverUpdateCheckEnabled: true,
  watchedThresholdMovie: 85,
  watchedThresholdTv: 85,
  watchedThresholdMusic: 85,
  publicApiRateLimitPerMinute: 240,
  imagePrecacheEnabled: true,
  preferredPosterServerId: null,
  memberServerActivity: false,
};

const mockImageCacheStatus: ImageCacheStatus = {
  bytes: 12345,
  files: 10,
  versionedFiles: 8,
  sweptAt: '2026-08-23T00:00:00.000Z',
  freedBytesLastSweep: 500,
  deletedFilesLastSweep: 2,
  notPersisting: false,
  postersWithThumb: 42,
  estimatedNeedBytes: 42 * 18 * 1024,
  freeBytes: 50 * 1024 ** 3,
  totalBytes: 100 * 1024 ** 3,
  minFreePercent: 10,
  maxBytes: null,
  diskLimitedSince: null,
  shortfallBytes: 0,
};

const redis = { get: vi.fn(), setex: vi.fn() };

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('redis', redis as never);
  app.decorate('authenticate', async (request: unknown) => {
    (request as { user: AuthUser }).user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));

  await app.register(settingsRoutes, { prefix: '/settings' });
  return app;
}

const ownerUser: AuthUser = {
  userId: randomUUID(),
  username: 'admin',
  role: 'owner',
  serverIds: [],
};

const memberUser: AuthUser = {
  userId: randomUUID(),
  username: 'member',
  role: 'member',
  serverIds: [],
};

describe('Settings Routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.mocked(getAllSettings).mockResolvedValue({ ...mockAllSettings });
    vi.mocked(setSettings).mockResolvedValue(undefined);
    vi.mocked(getImageCacheStatus).mockResolvedValue({ ...mockImageCacheStatus });
  });

  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  describe('GET /settings', () => {
    it('returns settings for owner', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.loginMethods).toEqual({ local: true, plex: true, oidc: true, member: false });
      expect(body.pollerEnabled).toBe(true);
      expect(body.pollerIntervalMs).toBe(15000);
      expect(body.externalUrl).toBe('https://tracearr.example.com');
      expect(body.trustProxy).toBe(true);
    });

    it('returns tautulli API key to owners', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.tautulliApiKey).toBe('secret-api-key');
      expect(body.tautulliUrl).toBe('http://localhost:8181');
    });

    it('returns null for tautulliApiKey when not set', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        tautulliApiKey: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.tautulliApiKey).toBe(null);
    });

    it('rejects member accessing settings', async () => {
      app = await buildTestApp(memberUser);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(404);
    });

    it('no longer returns provider keys', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      for (const key of [
        'discordWebhookUrl',
        'customWebhookUrl',
        'webhookFormat',
        'ntfyTopic',
        'ntfyAuthToken',
        'pushoverUserKey',
        'pushoverApiToken',
      ]) {
        expect(body).not.toHaveProperty(key);
      }
    });
  });

  describe('oidcConfigured', () => {
    it('comes back on GET and PATCH, and a PATCH body cannot change it', async () => {
      app = await buildTestApp(ownerUser);

      const read = (await app.inject({ method: 'GET', url: '/settings' })).json();
      const saved = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { usePlexGeoip: true, oidcConfigured: false },
      });

      expect(read.oidcConfigured).toBe(true);
      expect(saved.json().oidcConfigured).toBe(true);
      expect(setSettings).toHaveBeenCalledWith({ usePlexGeoip: true });
    });
  });

  describe('PATCH /settings', () => {
    it('updates settings for owner', async () => {
      app = await buildTestApp(ownerUser);

      // After setSettings, getAllSettings returns updated values
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        usePlexGeoip: true,
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { usePlexGeoip: true },
      });

      expect(response.statusCode).toBe(200);
      expect(setSettings).toHaveBeenCalledWith({ usePlexGeoip: true });
      const body = response.json();
      expect(body.usePlexGeoip).toBe(true);
    });

    it('refuses a login method change that leaves the owner no way in', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(assertOwnerKeepsALoginMethod).mockRejectedValueOnce(
        new APIError('BAD_REQUEST', {
          message: 'That would leave the owner with no way to sign in.',
        })
      );

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { loginMethods: { local: false } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toBe('That would leave the owner with no way to sign in.');
      expect(assertOwnerKeepsALoginMethod).toHaveBeenCalledWith({ local: false });
      expect(setSettings).not.toHaveBeenCalled();
    });

    it('turning member login off merges the change and revokes the default people holding sessions', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getSetting).mockResolvedValue({
        local: true,
        plex: true,
        oidc: false,
        member: true,
      } as never);
      const where = vi.fn().mockResolvedValue([{ id: 'member-1' }, { id: 'admin-1' }]);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      } as never);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { loginMethods: { member: false } },
      });

      expect(response.statusCode).toBe(200);
      expect(setSettings).toHaveBeenCalledWith({
        loginMethods: { local: true, plex: true, oidc: false, member: false },
      });
      expect(revokeSessionsForUsers).toHaveBeenCalledWith(['member-1', 'admin-1']);
      const condition = renderSql(where.mock.calls[0]?.[0] as SQL);
      expect(condition.sql).toContain('users.login_access = $1');
      expect(condition.params).toContain('default');
      expect(condition.sql).toContain('users.role <> $2');
      expect(condition.sql).toContain('exists (select 1 from auth_sessions s');
    });

    it('still revokes when member login off is resent after a revoke that failed', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getSetting).mockResolvedValue({
        local: true,
        plex: true,
        oidc: false,
        member: false,
      } as never);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ id: 'member-1' }]) }),
      } as never);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { loginMethods: { member: false } },
      });

      expect(response.statusCode).toBe(200);
      expect(revokeSessionsForUsers).toHaveBeenCalledWith(['member-1']);
    });

    it('re-arms imported history linking when Tautulli settings are saved', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { tautulliUrl: 'http://tautulli.local:8181', tautulliApiKey: 'new-key' },
      });

      expect(response.statusCode).toBe(200);
      expect(setSettings).toHaveBeenCalledWith({
        tautulliUrl: 'http://tautulli.local:8181',
        tautulliApiKey: 'new-key',
      });
      expect(rearmImportedHistoryLink).toHaveBeenCalledWith({ keepProviderPass: true });
    });

    it('strips provider keys instead of persisting them', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          discordWebhookUrl: 'https://new-discord-webhook.com',
          usePlexGeoip: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(setSettings).toHaveBeenCalledWith({ usePlexGeoip: true });
      expect(response.json()).not.toHaveProperty('discordWebhookUrl');
    });

    it('updates poller settings', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        pollerEnabled: false,
        pollerIntervalMs: 30000,
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { pollerEnabled: false, pollerIntervalMs: 30000 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.pollerEnabled).toBe(false);
      expect(body.pollerIntervalMs).toBe(30000);
    });

    it('normalizes externalUrl by stripping trailing slash', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        externalUrl: 'https://new-url.com',
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { externalUrl: 'https://new-url.com/' },
      });

      expect(response.statusCode).toBe(200);
      expect(setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ externalUrl: 'https://new-url.com' })
      );
    });

    it('returns tautulli API key in PATCH response', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        tautulliApiKey: 'new-api-key',
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { tautulliApiKey: 'new-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.tautulliApiKey).toBe('new-api-key');
    });

    it('rejects member updating settings', async () => {
      app = await buildTestApp(memberUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { usePlexGeoip: true },
      });

      expect(response.statusCode).toBe(404);
    });

    it('rejects invalid request body', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { pollerIntervalMs: 'not-a-number' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('handles empty update body', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
    });

    it('accepts and persists imagePrecacheEnabled', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        imagePrecacheEnabled: false,
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { imagePrecacheEnabled: false },
      });

      expect(response.statusCode).toBe(200);
      expect(setSettings).toHaveBeenCalledWith({ imagePrecacheEnabled: false });
      const body = response.json();
      expect(body.imagePrecacheEnabled).toBe(false);
    });

    it('accepts and persists both update-check toggles', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        pluginUpdateCheckEnabled: false,
        serverUpdateCheckEnabled: false,
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { pluginUpdateCheckEnabled: false, serverUpdateCheckEnabled: false },
      });

      expect(response.statusCode).toBe(200);
      expect(setSettings).toHaveBeenCalledWith({
        pluginUpdateCheckEnabled: false,
        serverUpdateCheckEnabled: false,
      });
      const body = response.json();
      expect(body.pluginUpdateCheckEnabled).toBe(false);
      expect(body.serverUpdateCheckEnabled).toBe(false);
    });
  });

  describe('POST /settings/api-key/regenerate', () => {
    it('writes the new key and announces the change for open event connections', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: () => ({ where: async () => undefined }),
      } as never);
      app = await buildTestApp(ownerUser);

      const res = await app.inject({ method: 'POST', url: '/settings/api-key/regenerate' });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ token: string }>().token).toMatch(/^trr_pub_/);
      expect(mockPublish).toHaveBeenCalledWith('public-api:key-changed', {
        userId: ownerUser.userId,
      });
    });

    it('still returns the new key when the announcement fails', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: () => ({ where: async () => undefined }),
      } as never);
      mockPublish.mockRejectedValueOnce(new Error('redis down'));
      app = await buildTestApp(ownerUser);

      const res = await app.inject({ method: 'POST', url: '/settings/api-key/regenerate' });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ token: string }>().token).toMatch(/^trr_pub_/);
    });

    it('refuses a member', async () => {
      app = await buildTestApp(memberUser);
      const res = await app.inject({ method: 'POST', url: '/settings/api-key/regenerate' });
      expect(res.statusCode).toBe(404);
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe('GET /settings/image-cache', () => {
    it('returns the image cache status for owner', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/settings/image-cache',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(mockImageCacheStatus);
    });

    it('rejects member requesting the image cache status', async () => {
      app = await buildTestApp(memberUser);

      const response = await app.inject({
        method: 'GET',
        url: '/settings/image-cache',
      });

      expect(response.statusCode).toBe(404);
      expect(getImageCacheStatus).not.toHaveBeenCalled();
    });
  });

  describe('GET /settings/ip-warning', () => {
    it('serves a second request within the TTL from the cache', async () => {
      const store = new Map<string, string>();
      redis.get.mockImplementation(async (key: string) => store.get(key) ?? null);
      redis.setex.mockImplementation(async (key: string, _ttl: number, value: string) => {
        store.set(key, value);
      });
      vi.mocked(db.selectDistinct).mockReturnValue(
        queryChain(vi.fn, [{ ipAddress: '10.0.0.5' }]) as never
      );
      vi.mocked(geoipService.isPrivateIP).mockReturnValue(true);
      app = await buildTestApp(ownerUser);

      const first = await app.inject({ method: 'GET', url: '/settings/ip-warning' });
      const second = await app.inject({ method: 'GET', url: '/settings/ip-warning' });

      expect(first.json()).toEqual({ showWarning: true, stateHash: 'single-private-ip' });
      expect(second.json()).toEqual(first.json());
      expect(db.selectDistinct).toHaveBeenCalledTimes(1);
    });
  });
});
