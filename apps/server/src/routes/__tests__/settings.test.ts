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

// Mock geoip service
vi.mock('../../services/geoip.js', () => ({
  geoipService: {
    isPrivateIP: vi.fn(),
  },
}));

import { getAllSettings, setSettings } from '../../services/settings.js';
import { getImageCacheStatus } from '../../services/imageCacheSweep.js';
import { settingsRoutes } from '../settings.js';

const mockAllSettings: Settings = {
  allowGuestAccess: false,
  unitSystem: 'metric',
  pollerEnabled: true,
  pollerIntervalMs: 15000,
  usePlexGeoip: false,
  tautulliUrl: 'http://localhost:8181',
  tautulliApiKey: 'secret-api-key',
  tautulliBasicAuthUsername: null,
  tautulliBasicAuthPassword: null,
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
};

const mockImageCacheStatus: ImageCacheStatus = {
  bytes: 12345,
  files: 10,
  versionedFiles: 8,
  sweptAt: '2026-08-23T00:00:00.000Z',
  freedBytesLastSweep: 500,
  deletedFilesLastSweep: 2,
  postersWithThumb: 42,
  estimatedNeedBytes: 42 * 18 * 1024,
  freeBytes: 50 * 1024 ** 3,
  totalBytes: 100 * 1024 ** 3,
  minFreePercent: 10,
  maxBytes: null,
  diskLimitedSince: null,
  shortfallBytes: 0,
};

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  app.decorate('authenticate', async (request: unknown) => {
    (request as { user: AuthUser }).user = authUser;
  });

  await app.register(settingsRoutes, { prefix: '/settings' });
  return app;
}

const ownerUser: AuthUser = {
  userId: randomUUID(),
  username: 'admin',
  role: 'owner',
  serverIds: [],
};

const viewerUser: AuthUser = {
  userId: randomUUID(),
  username: 'viewer',
  role: 'viewer',
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
      expect(body.allowGuestAccess).toBe(false);
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

    it('rejects viewer accessing settings', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Only server owners');
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

  describe('PATCH /settings', () => {
    it('updates settings for owner', async () => {
      app = await buildTestApp(ownerUser);

      // After setSettings, getAllSettings returns updated values
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        allowGuestAccess: true,
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { allowGuestAccess: true },
      });

      expect(response.statusCode).toBe(200);
      expect(setSettings).toHaveBeenCalledWith({ allowGuestAccess: true });
      const body = response.json();
      expect(body.allowGuestAccess).toBe(true);
    });

    it('strips provider keys instead of persisting them', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          discordWebhookUrl: 'https://new-discord-webhook.com',
          allowGuestAccess: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(setSettings).toHaveBeenCalledWith({ allowGuestAccess: true });
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

    it('accepts and persists tautulli basic auth credentials', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({
        ...mockAllSettings,
        tautulliBasicAuthUsername: 'proxy-user',
        tautulliBasicAuthPassword: 'proxy-pass',
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          tautulliBasicAuthUsername: 'proxy-user',
          tautulliBasicAuthPassword: 'proxy-pass',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(setSettings).toHaveBeenCalledWith({
        tautulliBasicAuthUsername: 'proxy-user',
        tautulliBasicAuthPassword: 'proxy-pass',
      });
      const body = response.json();
      expect(body.tautulliBasicAuthUsername).toBe('proxy-user');
      expect(body.tautulliBasicAuthPassword).toBe('proxy-pass');
    });

    it('clears tautulli basic auth credentials when sent as empty strings', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getAllSettings).mockResolvedValue({ ...mockAllSettings });

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { tautulliBasicAuthUsername: '', tautulliBasicAuthPassword: '' },
      });

      expect(response.statusCode).toBe(200);
      expect(setSettings).toHaveBeenCalledWith({
        tautulliBasicAuthUsername: null,
        tautulliBasicAuthPassword: null,
      });
    });

    it('rejects viewer updating settings', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { allowGuestAccess: true },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Only server owners');
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

    it('rejects viewer requesting the image cache status', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/settings/image-cache',
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Only server owners');
      expect(getImageCacheStatus).not.toHaveBeenCalled();
    });
  });
});
