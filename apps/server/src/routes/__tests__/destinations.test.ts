/**
 * Destination routes tests
 *
 * Covers the owner-only CRUD surface plus the saved and unsaved test endpoints.
 * utils/ssrf.js stays real so the link-local rejection runs end to end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

const { mockTest } = vi.hoisted(() => ({ mockTest: vi.fn() }));

vi.mock('../../services/notifications/destinationStore.js', () => ({
  listDestinations: vi.fn(),
  getDestination: vi.fn(),
  createDestination: vi.fn(),
  updateDestination: vi.fn(),
  deleteDestination: vi.fn(),
  readConfig: vi.fn(),
  toPublicDestination: vi.fn(
    (
      row: { id: string; name: string; type: string },
      automations: number,
      newsletters: number
    ) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      referencedByAutomationCount: automations,
      referencedByNewsletterCount: newsletters,
    })
  ),
}));

vi.mock('../../services/notifications/destinationRefs.js', () => ({
  automationsReferencingDestinations: vi.fn(),
  newslettersReferencingDestinations: vi.fn(),
}));

vi.mock('../../services/notifications/destinations/registry.js', () => ({
  getDestinationType: vi.fn(() => ({ test: mockTest })),
}));

vi.mock('../../jobs/newsletterQueue.js', () => ({
  onDestinationUnavailable: vi.fn(),
  onDestinationChanged: vi.fn(),
}));

import { onDestinationChanged, onDestinationUnavailable } from '../../jobs/newsletterQueue.js';
import {
  automationsReferencingDestinations,
  newslettersReferencingDestinations,
} from '../../services/notifications/destinationRefs.js';
import {
  createDestination,
  deleteDestination,
  getDestination,
  listDestinations,
  readConfig,
  updateDestination,
  type DestinationRow,
} from '../../services/notifications/destinationStore.js';
import { destinationRoutes } from '../destinations.js';

function makeRow(overrides: Partial<DestinationRow> = {}): DestinationRow {
  return {
    id: 'dest-1',
    name: 'Discord',
    type: 'discord',
    config: 'v1:ciphertext',
    events: [],
    enabled: true,
    builtin: false,
    configStatus: 'ok',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const ownerUser: AuthUser = {
  userId: randomUUID(),
  username: 'owner',
  role: 'owner',
  serverIds: [],
};

const adminUser: AuthUser = {
  userId: randomUUID(),
  username: 'admin',
  role: 'admin',
  serverIds: [],
};

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  app.decorate('requireOwner', async (request: unknown, reply: FastifyReply) => {
    (request as { user: AuthUser }).user = authUser;
    if (authUser.role !== 'owner') {
      await reply.forbidden('Owner access required');
    }
  });

  await app.register(destinationRoutes, { prefix: '/destinations' });
  return app;
}

describe('Destination Routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.mocked(automationsReferencingDestinations).mockResolvedValue(new Map());
    vi.mocked(newslettersReferencingDestinations).mockResolvedValue(new Map());
    vi.mocked(readConfig).mockReturnValue({ ok: true, config: {}, rewrap: false });
    mockTest.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  describe('GET /destinations', () => {
    it('returns the public shape with automation and newsletter reference counts', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(listDestinations).mockResolvedValue([
        makeRow(),
        makeRow({ id: 'dest-2', name: 'Ntfy', type: 'ntfy' }),
      ]);
      vi.mocked(automationsReferencingDestinations).mockResolvedValue(
        new Map([
          [
            'dest-1',
            [
              { ruleId: 'r1', ruleName: 'Rule one', isActive: true },
              { ruleId: 'r2', ruleName: 'Rule two', isActive: false },
            ],
          ],
        ])
      );
      vi.mocked(newslettersReferencingDestinations).mockResolvedValue(
        new Map([['dest-2', ['Weekly', 'Monthly']]])
      );

      const response = await app.inject({ method: 'GET', url: '/destinations' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        {
          id: 'dest-1',
          name: 'Discord',
          type: 'discord',
          referencedByAutomationCount: 2,
          referencedByNewsletterCount: 0,
        },
        {
          id: 'dest-2',
          name: 'Ntfy',
          type: 'ntfy',
          referencedByAutomationCount: 0,
          referencedByNewsletterCount: 2,
        },
      ]);
    });

    it('rejects a non-owner', async () => {
      app = await buildTestApp(adminUser);

      const response = await app.inject({ method: 'GET', url: '/destinations' });

      expect(response.statusCode).toBe(403);
      expect(listDestinations).not.toHaveBeenCalled();
    });
  });

  describe('POST /destinations', () => {
    it('creates with the parsed config and returns 201', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(createDestination).mockResolvedValue(makeRow());

      const response = await app.inject({
        method: 'POST',
        url: '/destinations',
        payload: {
          name: 'Discord',
          type: 'discord',
          config: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
          events: ['violation_detected'],
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        id: 'dest-1',
        referencedByAutomationCount: 0,
        referencedByNewsletterCount: 0,
      });
      expect(createDestination).toHaveBeenCalledWith({
        name: 'Discord',
        type: 'discord',
        config: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
        events: ['violation_detected'],
        enabled: true,
      });
    });

    it('rejects an invalid body naming the first issue', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/destinations',
        payload: { name: '', type: 'discord', config: {} },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('name');
      expect(createDestination).not.toHaveBeenCalled();
    });

    it('rejects a config the type schema fails', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/destinations',
        payload: { name: 'Discord', type: 'discord', config: {} },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('Invalid config');
      expect(createDestination).not.toHaveBeenCalled();
    });

    it('rejects a link-local url naming the field', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/destinations',
        payload: {
          name: 'Webhook',
          type: 'json_webhook',
          config: { url: 'http://169.254.1.1/' },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('url:');
      expect(response.json().message).toContain('link-local');
      expect(createDestination).not.toHaveBeenCalled();
    });

    it('rejects a link-local smtp host naming the field', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/destinations',
        payload: {
          name: 'Mail',
          type: 'email',
          config: {
            host: '169.254.169.254',
            port: '25',
            security: 'none',
            fromAddress: 'a@example.com',
            to: 'b@example.com',
          },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('host:');
      expect(response.json().message).toContain('link-local');
      expect(createDestination).not.toHaveBeenCalled();
    });

    it('does not block a LAN smtp host', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(createDestination).mockResolvedValue(makeRow({ id: 'email-1', type: 'email' }));

      const response = await app.inject({
        method: 'POST',
        url: '/destinations',
        payload: {
          name: 'Mail',
          type: 'email',
          config: {
            host: '192.168.1.10',
            port: '25',
            security: 'none',
            fromAddress: 'a@example.com',
            to: 'b@example.com',
          },
        },
      });

      expect(response.statusCode).not.toBe(400);
      expect(createDestination).toHaveBeenCalled();
    });

    it('409s a name the unique index already holds', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(createDestination).mockRejectedValue(
        Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
        })
      );

      const response = await app.inject({
        method: 'POST',
        url: '/destinations',
        payload: {
          name: 'Discord',
          type: 'discord',
          config: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().message).toBe('A destination named "Discord" already exists');
    });

    it('lets a store error that is not a unique violation through', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(createDestination).mockRejectedValue(
        Object.assign(new Error('deadlock detected'), { code: '40P01' })
      );

      const response = await app.inject({
        method: 'POST',
        url: '/destinations',
        payload: {
          name: 'Discord',
          type: 'discord',
          config: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
        },
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('PATCH /destinations/:id', () => {
    it('404s an unknown id', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(null);

      const response = await app.inject({
        method: 'PATCH',
        url: '/destinations/missing',
        payload: { name: 'New name' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('rejects a config patch on a built-in', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(
        makeRow({ id: 'push-1', name: 'Mobile push', type: 'push', builtin: true, config: null })
      );

      const response = await app.inject({
        method: 'PATCH',
        url: '/destinations/push-1',
        payload: { config: { anything: 'x' } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('Built-in destinations have no config');
      expect(updateDestination).not.toHaveBeenCalled();
    });

    it('rejects an event no destination may subscribe to', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(
        makeRow({ id: 'push-1', name: 'Mobile push', type: 'push', builtin: true, config: null })
      );

      const response = await app.inject({
        method: 'PATCH',
        url: '/destinations/push-1',
        payload: { events: ['plugin_update_available'] },
      });

      expect(response.statusCode).toBe(400);
      expect(updateDestination).not.toHaveBeenCalled();
    });

    it('passes an omit-keeps patch through to the store and returns the public shape', async () => {
      app = await buildTestApp(ownerUser);
      const row = makeRow({ id: 'ntfy-1', name: 'Ntfy', type: 'ntfy' });
      vi.mocked(getDestination).mockResolvedValue(row);
      vi.mocked(readConfig).mockReturnValue({
        ok: true,
        config: { url: 'https://ntfy.sh/', topic: 'old', authToken: 'tok' },
        rewrap: false,
      });
      vi.mocked(updateDestination).mockResolvedValue({ ...row, name: 'Ntfy' });
      vi.mocked(automationsReferencingDestinations).mockResolvedValue(
        new Map([['ntfy-1', [{ ruleId: 'r1', ruleName: 'Rule one', isActive: true }]]])
      );
      vi.mocked(newslettersReferencingDestinations).mockResolvedValue(
        new Map([['ntfy-1', ['Weekly']]])
      );

      const response = await app.inject({
        method: 'PATCH',
        url: '/destinations/ntfy-1',
        payload: { config: { topic: 'new' } },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: 'ntfy-1',
        referencedByAutomationCount: 1,
        referencedByNewsletterCount: 1,
      });
      expect(updateDestination).toHaveBeenCalledWith('ntfy-1', { config: { topic: 'new' } });
      expect(onDestinationChanged).toHaveBeenCalledWith('ntfy-1');
    });

    it('rejects clearing a required key', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(
        makeRow({ id: 'ntfy-1', name: 'Ntfy', type: 'ntfy' })
      );
      vi.mocked(readConfig).mockReturnValue({
        ok: true,
        config: { url: 'https://ntfy.sh/', topic: 'old' },
        rewrap: false,
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/destinations/ntfy-1',
        payload: { config: { url: null } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('Invalid config');
      expect(updateDestination).not.toHaveBeenCalled();
    });

    it('rejects a partial config on a reencrypt row and accepts a complete one', async () => {
      app = await buildTestApp(ownerUser);
      const row = makeRow({ id: 'ntfy-1', name: 'Ntfy', type: 'ntfy', configStatus: 'reencrypt' });
      vi.mocked(getDestination).mockResolvedValue(row);
      vi.mocked(readConfig).mockReturnValue({ ok: false, reason: 'bad_key' });
      vi.mocked(updateDestination).mockResolvedValue({ ...row, configStatus: 'ok' });

      const partial = await app.inject({
        method: 'PATCH',
        url: '/destinations/ntfy-1',
        payload: { config: { topic: 'new' } },
      });

      expect(partial.statusCode).toBe(400);
      expect(updateDestination).not.toHaveBeenCalled();

      const complete = await app.inject({
        method: 'PATCH',
        url: '/destinations/ntfy-1',
        payload: { config: { url: 'https://ntfy.sh/', topic: 'new' } },
      });

      expect(complete.statusCode).toBe(200);
      expect(updateDestination).toHaveBeenCalledWith('ntfy-1', {
        config: { url: 'https://ntfy.sh/', topic: 'new' },
      });
    });

    it('rejects a link-local url in a merged config', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(
        makeRow({ id: 'ntfy-1', name: 'Ntfy', type: 'ntfy' })
      );
      vi.mocked(readConfig).mockReturnValue({
        ok: true,
        config: { url: 'https://ntfy.sh/', topic: 'old' },
        rewrap: false,
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/destinations/ntfy-1',
        payload: { config: { url: 'http://169.254.169.254/latest' } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('url:');
      expect(updateDestination).not.toHaveBeenCalled();
    });

    it('rejects a link-local smtp host in a merged config', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(
        makeRow({ id: 'email-1', name: 'Mail', type: 'email' })
      );
      vi.mocked(readConfig).mockReturnValue({
        ok: true,
        config: {
          host: 'smtp.example.com',
          port: '587',
          security: 'starttls',
          fromAddress: 'a@example.com',
          to: 'b@example.com',
        },
        rewrap: false,
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/destinations/email-1',
        payload: { config: { host: '169.254.1.1' } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('host:');
      expect(response.json().message).toContain('link-local');
      expect(updateDestination).not.toHaveBeenCalled();
    });

    it('409s a rename onto a name the unique index already holds', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(makeRow({ id: 'ntfy-1', name: 'Ntfy' }));
      // drizzle wraps the driver error, so the code arrives under cause
      vi.mocked(updateDestination).mockRejectedValue(
        Object.assign(new Error('Failed query'), {
          cause: Object.assign(new Error('duplicate key value violates unique constraint'), {
            code: '23505',
          }),
        })
      );

      const response = await app.inject({
        method: 'PATCH',
        url: '/destinations/ntfy-1',
        payload: { name: 'Discord' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().message).toBe('A destination named "Discord" already exists');
    });

    it('lets a store error that is not a unique violation through', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(makeRow({ id: 'ntfy-1', name: 'Ntfy' }));
      vi.mocked(updateDestination).mockRejectedValue(
        Object.assign(new Error('deadlock detected'), { code: '40P01' })
      );

      const response = await app.inject({
        method: 'PATCH',
        url: '/destinations/ntfy-1',
        payload: { name: 'Discord' },
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('DELETE /destinations/:id', () => {
    it('404s an unknown id', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(null);

      const response = await app.inject({ method: 'DELETE', url: '/destinations/missing' });

      expect(response.statusCode).toBe(404);
    });

    it('refuses a built-in', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(
        makeRow({ id: 'push-1', type: 'push', builtin: true, config: null })
      );

      const response = await app.inject({ method: 'DELETE', url: '/destinations/push-1' });

      expect(response.statusCode).toBe(400);
      expect(deleteDestination).not.toHaveBeenCalled();
    });

    it('409s with the rule names when a rule references it', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(makeRow());
      vi.mocked(automationsReferencingDestinations).mockResolvedValue(
        new Map([
          [
            'dest-1',
            [
              { ruleId: 'r1', ruleName: 'Rule one', isActive: true },
              { ruleId: 'r2', ruleName: 'Rule two', isActive: false },
            ],
          ],
        ])
      );

      const response = await app.inject({ method: 'DELETE', url: '/destinations/dest-1' });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        message: 'Used by 2 rule(s)',
        rules: ['Rule one', 'Rule two'],
      });
      expect(deleteDestination).not.toHaveBeenCalled();
    });

    it('409s with the newsletter names when a newsletter references it', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(makeRow());
      vi.mocked(newslettersReferencingDestinations).mockResolvedValue(
        new Map([['dest-1', ['Weekly', 'Monthly']]])
      );

      const response = await app.inject({ method: 'DELETE', url: '/destinations/dest-1' });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        message: 'Used by 2 newsletter(s)',
        newsletters: ['Weekly', 'Monthly'],
      });
      expect(deleteDestination).not.toHaveBeenCalled();
      expect(onDestinationUnavailable).not.toHaveBeenCalled();
    });

    it('names the automations first when both reference it', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(makeRow());
      vi.mocked(automationsReferencingDestinations).mockResolvedValue(
        new Map([['dest-1', [{ ruleId: 'r1', ruleName: 'Rule one', isActive: true }]]])
      );
      vi.mocked(newslettersReferencingDestinations).mockResolvedValue(
        new Map([['dest-1', ['Weekly']]])
      );

      const response = await app.inject({ method: 'DELETE', url: '/destinations/dest-1' });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ message: 'Used by 1 rule(s)', rules: ['Rule one'] });
    });

    it('deletes an unreferenced destination', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(makeRow());
      vi.mocked(deleteDestination).mockResolvedValue(true);

      const response = await app.inject({ method: 'DELETE', url: '/destinations/dest-1' });

      expect(response.statusCode).toBe(204);
      expect(deleteDestination).toHaveBeenCalledWith('dest-1');
      expect(onDestinationUnavailable).toHaveBeenCalledWith('dest-1');
    });
  });

  describe('POST /destinations/:id/test', () => {
    it('404s an unknown id', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(null);

      const response = await app.inject({ method: 'POST', url: '/destinations/missing/test' });

      expect(response.statusCode).toBe(404);
    });

    it('refuses a built-in', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(
        makeRow({ id: 'push-1', type: 'push', builtin: true, config: null })
      );

      const response = await app.inject({ method: 'POST', url: '/destinations/push-1/test' });

      expect(response.statusCode).toBe(400);
      expect(mockTest).not.toHaveBeenCalled();
    });

    it('409s a row whose config no longer decrypts', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(makeRow({ configStatus: 'reencrypt' }));

      const response = await app.inject({ method: 'POST', url: '/destinations/dest-1/test' });

      expect(response.statusCode).toBe(409);
      expect(response.json().message).toContain('Re-enter');
      expect(mockTest).not.toHaveBeenCalled();
    });

    it('delivers with the stored config', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(makeRow());
      vi.mocked(readConfig).mockReturnValue({
        ok: true,
        config: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
        rewrap: false,
      });

      const response = await app.inject({ method: 'POST', url: '/destinations/dest-1/test' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(mockTest).toHaveBeenCalledWith(
        { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
        expect.objectContaining({ destination: { id: 'test', name: 'Discord' } })
      );
    });

    it('passes back the address a kind reports it sent to', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(makeRow({ id: 'mail-1', type: 'email' }));
      vi.mocked(readConfig).mockReturnValue({
        ok: true,
        config: { host: 'smtp.example.com', fromAddress: 'plex@example.com' },
        rewrap: false,
      });
      mockTest.mockResolvedValue({ sentTo: 'plex@example.com' });

      const response = await app.inject({ method: 'POST', url: '/destinations/mail-1/test' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, sentTo: 'plex@example.com' });
    });

    it('502s a failed delivery with the error truncated to 500 characters', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getDestination).mockResolvedValue(makeRow());
      vi.mocked(readConfig).mockReturnValue({
        ok: true,
        config: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
        rewrap: false,
      });
      mockTest.mockRejectedValue(new Error('x'.repeat(900)));

      const response = await app.inject({ method: 'POST', url: '/destinations/dest-1/test' });

      expect(response.statusCode).toBe(502);
      const body = response.json();
      expect(body.success).toBe(false);
      expect(body.error).toHaveLength(500);
    });
  });

  describe('POST /destinations/test', () => {
    it('rejects an invalid body', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/destinations/test',
        payload: { type: 'discord' },
      });

      expect(response.statusCode).toBe(400);
      expect(mockTest).not.toHaveBeenCalled();
    });

    it('rejects a config the type schema fails', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/destinations/test',
        payload: { type: 'discord', config: {} },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('Invalid config');
      expect(mockTest).not.toHaveBeenCalled();
    });

    it('rejects a link-local url', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/destinations/test',
        payload: { type: 'json_webhook', config: { url: 'http://169.254.1.1/hook' } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('url:');
      expect(mockTest).not.toHaveBeenCalled();
    });

    it('rejects a link-local smtp host', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/destinations/test',
        payload: {
          type: 'email',
          config: {
            host: '169.254.169.254',
            port: '25',
            security: 'none',
            fromAddress: 'a@example.com',
            to: 'b@example.com',
          },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('host:');
      expect(response.json().message).toContain('link-local');
      expect(mockTest).not.toHaveBeenCalled();
    });

    it('delivers an unsaved config without echoing it back', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/destinations/test',
        payload: {
          type: 'discord',
          config: { webhookUrl: 'https://discord.com/api/webhooks/1/secret' },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(response.body).not.toContain('secret');
      expect(mockTest).toHaveBeenCalledWith(
        { webhookUrl: 'https://discord.com/api/webhooks/1/secret' },
        expect.objectContaining({ destination: { id: 'test', name: 'test' } })
      );
    });

    it('502s a failed unsaved delivery without echoing the config', async () => {
      app = await buildTestApp(ownerUser);
      mockTest.mockRejectedValue(new Error('connection refused'));

      const response = await app.inject({
        method: 'POST',
        url: '/destinations/test',
        payload: {
          type: 'discord',
          config: { webhookUrl: 'https://discord.com/api/webhooks/1/secret' },
        },
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ success: false, error: 'connection refused' });
      expect(response.body).not.toContain('secret');
    });
  });
});
