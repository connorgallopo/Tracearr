/**
 * Settings routes tests
 *
 * Tests the API endpoints for application settings:
 * - GET /settings - Get application settings (owner only)
 * - PATCH /settings - Update application settings (owner only)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

// Mock the database module before importing routes
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

// Import mocked modules
import { db } from '../../db/client.js';
import { settingsRoutes } from '../settings.js';

// Helper to create DB chain mocks
function mockDbSelectLimit(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

function mockDbInsert(result: unknown[]) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.insert).mockReturnValue(chain as never);
  return chain;
}

function mockDbUpdate() {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(db.update).mockReturnValue(chain as never);
  return chain;
}

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

const mockSettingsRow = {
  id: 1,
  allowGuestAccess: false,
  discordWebhookUrl: 'https://discord.com/api/webhooks/123',
  customWebhookUrl: 'https://example.com/webhook',
  webhookFormat: 'json' as const,
  ntfyTopic: null,
  ntfyAuthToken: null,
  pollerEnabled: true,
  pollerIntervalMs: 15000,
  tautulliUrl: 'http://localhost:8181',
  tautulliApiKey: 'secret-api-key',
  externalUrl: 'https://tracearr.example.com',
  basePath: '/app',
  trustProxy: true,
  mobileEnabled: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('Settings Routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  describe('GET /settings', () => {
    it('returns settings for owner', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([mockSettingsRow]);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.allowGuestAccess).toBe(false);
      expect(body.discordWebhookUrl).toBe('https://discord.com/api/webhooks/123');
      expect(body.pollerEnabled).toBe(true);
      expect(body.pollerIntervalMs).toBe(15000);
      expect(body.externalUrl).toBe('https://tracearr.example.com');
      expect(body.basePath).toBe('/app');
      expect(body.trustProxy).toBe(true);
    });

    it('masks tautulli API key in response', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([mockSettingsRow]);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.tautulliApiKey).toBe('********');
      expect(body.tautulliUrl).toBe('http://localhost:8181');
    });

    it('returns null for tautulliApiKey when not set', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([{ ...mockSettingsRow, tautulliApiKey: null }]);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.tautulliApiKey).toBe(null);
    });

    it('creates default settings when none exist', async () => {
      app = await buildTestApp(ownerUser);

      // First select returns empty (no settings)
      mockDbSelectLimit([]);

      // Then insert creates defaults
      const defaultSettings = {
        id: 1,
        allowGuestAccess: false,
        discordWebhookUrl: null,
        customWebhookUrl: null,
        pollerEnabled: true,
        pollerIntervalMs: 15000,
        tautulliUrl: null,
        tautulliApiKey: null,
        externalUrl: null,
        basePath: '',
        trustProxy: false,
        mobileEnabled: false,
      };
      mockDbInsert([defaultSettings]);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.allowGuestAccess).toBe(false);
    });

    it('rejects guest accessing settings', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Only server owners');
    });

    it('returns webhook format settings', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([{ ...mockSettingsRow, webhookFormat: 'ntfy', ntfyTopic: 'my-topic' }]);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.webhookFormat).toBe('ntfy');
      expect(body.ntfyTopic).toBe('my-topic');
    });
  });

  describe('PATCH /settings', () => {
    it('updates settings for owner', async () => {
      app = await buildTestApp(ownerUser);

      // First check existing settings
      mockDbSelectLimit([mockSettingsRow]);
      mockDbUpdate();

      // Return updated settings on final select
      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi
            .fn()
            .mockResolvedValue(
              selectCount === 1
                ? [mockSettingsRow]
                : [{ ...mockSettingsRow, allowGuestAccess: true }]
            ),
        };
        return chain as never;
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          allowGuestAccess: true,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.allowGuestAccess).toBe(true);
    });

    it('updates webhook URLs', async () => {
      app = await buildTestApp(ownerUser);

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [mockSettingsRow]
              : [
                  {
                    ...mockSettingsRow,
                    discordWebhookUrl: 'https://new-discord-webhook.com',
                    customWebhookUrl: 'https://new-custom-webhook.com',
                  },
                ]
          ),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          discordWebhookUrl: 'https://new-discord-webhook.com',
          customWebhookUrl: 'https://new-custom-webhook.com',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.discordWebhookUrl).toBe('https://new-discord-webhook.com');
      expect(body.customWebhookUrl).toBe('https://new-custom-webhook.com');
    });

    it('updates poller settings', async () => {
      app = await buildTestApp(ownerUser);

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [mockSettingsRow]
              : [
                  {
                    ...mockSettingsRow,
                    pollerEnabled: false,
                    pollerIntervalMs: 30000,
                  },
                ]
          ),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          pollerEnabled: false,
          pollerIntervalMs: 30000,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.pollerEnabled).toBe(false);
      expect(body.pollerIntervalMs).toBe(30000);
    });

    it('updates tautulli settings', async () => {
      app = await buildTestApp(ownerUser);

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [mockSettingsRow]
              : [
                  {
                    ...mockSettingsRow,
                    tautulliUrl: 'http://tautulli:8181',
                    tautulliApiKey: 'new-api-key',
                  },
                ]
          ),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          tautulliUrl: 'http://tautulli:8181',
          tautulliApiKey: 'new-api-key',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.tautulliUrl).toBe('http://tautulli:8181');
      expect(body.tautulliApiKey).toBe('********'); // Should be masked
    });

    it('updates network settings and normalizes externalUrl', async () => {
      app = await buildTestApp(ownerUser);

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [mockSettingsRow]
              : [
                  {
                    ...mockSettingsRow,
                    externalUrl: 'https://new-url.com', // Should strip trailing slash
                    trustProxy: false,
                  },
                ]
          ),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          externalUrl: 'https://new-url.com/', // With trailing slash
          trustProxy: false,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.externalUrl).toBe('https://new-url.com');
      expect(body.trustProxy).toBe(false);
    });

    it('normalizes basePath by adding leading slash', async () => {
      app = await buildTestApp(ownerUser);

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [mockSettingsRow]
              : [
                  {
                    ...mockSettingsRow,
                    basePath: '/custom-path', // Should have leading slash
                  },
                ]
          ),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          basePath: 'custom-path', // Without leading slash
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.basePath).toBe('/custom-path');
    });

    it('creates settings when none exist', async () => {
      app = await buildTestApp(ownerUser);

      // First select returns empty (no settings)
      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [] // No existing settings
              : [{ ...mockSettingsRow, allowGuestAccess: true }] // After insert
          ),
        };
        return chain as never;
      });

      const insertChain = {
        values: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(db.insert).mockReturnValue(insertChain as never);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          allowGuestAccess: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(db.insert).toHaveBeenCalled();
    });

    it('rejects guest updating settings', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          allowGuestAccess: true,
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Only server owners');
    });

    it('rejects invalid request body', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          pollerIntervalMs: 'not-a-number', // Should be number
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('handles empty update body', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(db.select).mockImplementation(() => {
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([mockSettingsRow]),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      // Should still update the updatedAt timestamp
      expect(db.update).toHaveBeenCalled();
    });

    it('clears webhook URLs when set to null', async () => {
      app = await buildTestApp(ownerUser);

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [mockSettingsRow]
              : [
                  {
                    ...mockSettingsRow,
                    discordWebhookUrl: null,
                    customWebhookUrl: null,
                  },
                ]
          ),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          discordWebhookUrl: null,
          customWebhookUrl: null,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.discordWebhookUrl).toBe(null);
      expect(body.customWebhookUrl).toBe(null);
    });

    it('updates webhook format to ntfy', async () => {
      app = await buildTestApp(ownerUser);

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [mockSettingsRow]
              : [
                  {
                    ...mockSettingsRow,
                    webhookFormat: 'ntfy',
                    ntfyTopic: 'tracearr-alerts',
                  },
                ]
          ),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          webhookFormat: 'ntfy',
          ntfyTopic: 'tracearr-alerts',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.webhookFormat).toBe('ntfy');
      expect(body.ntfyTopic).toBe('tracearr-alerts');
    });

    it('updates webhook format to apprise', async () => {
      app = await buildTestApp(ownerUser);

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [mockSettingsRow]
              : [
                  {
                    ...mockSettingsRow,
                    webhookFormat: 'apprise',
                  },
                ]
          ),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          webhookFormat: 'apprise',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.webhookFormat).toBe('apprise');
    });

    it('rejects invalid webhook format', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          webhookFormat: 'invalid-format',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('clears ntfy topic when set to null', async () => {
      app = await buildTestApp(ownerUser);

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [{ ...mockSettingsRow, ntfyTopic: 'old-topic' }]
              : [
                  {
                    ...mockSettingsRow,
                    ntfyTopic: null,
                  },
                ]
          ),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          ntfyTopic: null,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ntfyTopic).toBe(null);
    });

    it('updates ntfy auth token', async () => {
      app = await buildTestApp(ownerUser);

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [mockSettingsRow]
              : [
                  {
                    ...mockSettingsRow,
                    webhookFormat: 'ntfy',
                    ntfyTopic: 'tracearr',
                    ntfyAuthToken: 'tk_secret_token_123',
                  },
                ]
          ),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          webhookFormat: 'ntfy',
          ntfyTopic: 'tracearr',
          ntfyAuthToken: 'tk_secret_token_123',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.webhookFormat).toBe('ntfy');
      expect(body.ntfyTopic).toBe('tracearr');
      // Auth token should be masked in response
      expect(body.ntfyAuthToken).toBe('********');
    });

    it('masks ntfy auth token in GET response', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([
        {
          ...mockSettingsRow,
          webhookFormat: 'ntfy',
          ntfyTopic: 'my-topic',
          ntfyAuthToken: 'tk_secret_token_456',
        },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ntfyAuthToken).toBe('********');
    });

    it('returns null for ntfy auth token when not set', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([
        {
          ...mockSettingsRow,
          webhookFormat: 'ntfy',
          ntfyTopic: 'my-topic',
          ntfyAuthToken: null,
        },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/settings',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ntfyAuthToken).toBe(null);
    });

    it('clears ntfy auth token when set to null', async () => {
      app = await buildTestApp(ownerUser);

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [{ ...mockSettingsRow, ntfyAuthToken: 'tk_old_token' }]
              : [
                  {
                    ...mockSettingsRow,
                    ntfyAuthToken: null,
                  },
                ]
          ),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: {
          ntfyAuthToken: null,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.ntfyAuthToken).toBe(null);
    });
  });
});
