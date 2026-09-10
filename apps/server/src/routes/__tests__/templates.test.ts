/**
 * Template route tests
 *
 * The store and the db are mocked, so what this tier proves is the contract: the
 * status a decode failure, a fingerprint match and a template still in use get,
 * and that an instantiate validates the materialized definition before it writes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import {
  encodeShareCode,
  fingerprintOf,
  type AuthUser,
  type TemplateEnvelope,
} from '@tracearr/shared';
import { queryChain } from '../../test/helpers.js';

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(), transaction: vi.fn() },
}));

vi.mock('../../jobs/poller/database.js', () => ({ invalidateAutomationsCache: vi.fn() }));
vi.mock('../../jobs/inactivityCheckQueue.js', () => ({ scheduleInactivityChecks: vi.fn() }));
vi.mock('../../services/notifications/destinationRefs.js', () => ({
  unknownDestinationIds: vi.fn(),
}));
vi.mock('../../services/userService.js', () => ({
  recomputeIdentityAggregatesForServerUser: vi.fn(),
}));
vi.mock('../../utils/buildInfo.js', () => ({ getCurrentVersion: vi.fn() }));
vi.mock('../../services/automations/templates/store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
  getTemplateVersion: vi.fn(),
  matchTemplate: vi.fn(),
  createTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  instantiateTemplate: vi.fn(),
}));

import { db } from '../../db/client.js';
import { scheduleInactivityChecks } from '../../jobs/inactivityCheckQueue.js';
import { invalidateAutomationsCache } from '../../jobs/poller/database.js';
import { BUILTIN_ENVELOPES } from '../../services/automations/templates/builtin/index.js';
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  getTemplateVersion,
  instantiateTemplate,
  listTemplates,
  matchTemplate,
} from '../../services/automations/templates/store.js';
import { unknownDestinationIds } from '../../services/notifications/destinationRefs.js';
import { getCurrentVersion } from '../../utils/buildInfo.js';
import { templateRoutes } from '../templates.js';

const TEMPLATE_ID = randomUUID();
const AUTOMATION_ID = randomUUID();
const DESTINATION_ID = randomUUID();
const SERVER_ID = randomUUID();

const envelopeOf = (slug: string): TemplateEnvelope => {
  const found = BUILTIN_ENVELOPES.find((envelope) => envelope.slug === slug);
  if (!found) throw new Error(`${slug} is missing`);
  return structuredClone(found);
};

const shareCode = (envelope: TemplateEnvelope): string =>
  encodeShareCode(envelope, (bytes) => new Uint8Array(deflateRawSync(bytes)));

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: TEMPLATE_ID,
  slug: 'stream-started',
  name: 'Stream started',
  description: 'Tell a destination every time a stream starts.',
  group: 'notifications',
  kind: 'notification',
  builtin: false,
  source: 'import',
  author: null,
  currentVersion: 1,
  usedBy: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

const currentVersion = (envelope: TemplateEnvelope) => ({
  version: 1,
  inputs: envelope.inputs,
  definition: envelope.definition,
});

function automationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AUTOMATION_ID,
    name: 'Stream started',
    description: null,
    kind: 'notification',
    severity: 'warning',
    triggers: [{ id: randomUUID(), type: 'session.started', enabled: true }],
    conditions: { groups: [] },
    actions: { actions: [{ id: randomUUID(), type: 'send', enabled: true, to: [DESTINATION_ID] }] },
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    isActive: true,
    cooldownMinutes: null,
    retentionDays: null,
    templateId: TEMPLATE_ID,
    templateVersion: 1,
    templateInputs: { to: [DESTINATION_ID] },
    originTemplateId: null,
    originTemplateVersion: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

const ownerUser: AuthUser = {
  userId: randomUUID(),
  username: 'owner',
  role: 'owner',
  serverIds: [],
};

const viewerUser: AuthUser = {
  userId: randomUUID(),
  username: 'viewer',
  role: 'viewer',
  serverIds: ['srv-1'],
};

/** What each route registered, so a per-route rate limit is visible without the plugin. */
const registeredRoutes = new Map<string, unknown>();

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registeredRoutes.clear();
  app.addHook('onRoute', (route) => {
    registeredRoutes.set(`${String(route.method)} ${route.url}`, route.config);
  });
  await app.register(sensible);

  app.decorate('authenticate', async (request: unknown) => {
    (request as { user: AuthUser }).user = authUser;
  });
  app.decorate('requireOwner', async (request: unknown, reply: FastifyReply) => {
    (request as { user: AuthUser }).user = authUser;
    if (authUser.role !== 'owner') {
      await reply.forbidden('Owner access required');
    }
  });

  await app.register(templateRoutes, { prefix: '/templates' });
  return app;
}

/** The by-id read the instantiate response is rendered from. */
function setupSelect(...results: unknown[][]) {
  const chains = results.map((rows) => queryChain(vi.fn, rows));
  const select = vi.mocked(db.select as unknown as ReturnType<typeof vi.fn>);
  for (const chain of chains) select.mockReturnValueOnce(chain);
  select.mockReturnValue(queryChain(vi.fn, []));
  return chains;
}

/** Instantiation runs in one transaction; the executor is only passed through. */
function setupTransaction() {
  vi.mocked(db.transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation((async (
    fn: (executor: unknown) => Promise<unknown>
  ) => fn({})) as never);
}

describe('Template routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getCurrentVersion).mockReturnValue('2.2.0');
    vi.mocked(unknownDestinationIds).mockResolvedValue([]);
    vi.mocked(matchTemplate).mockResolvedValue(null);
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('GET /templates', () => {
    it('lists the summaries with their instance counts and current version', async () => {
      app = await buildTestApp(viewerUser);
      const envelope = envelopeOf('stream-started');
      vi.mocked(listTemplates).mockResolvedValue([
        { ...summary({ usedBy: 3 }), version: currentVersion(envelope) },
      ] as never);

      const response = await app.inject({ method: 'GET', url: '/templates' });

      expect(response.statusCode).toBe(200);
      const [row] = response.json().data;
      expect(row).toMatchObject({
        id: TEMPLATE_ID,
        slug: 'stream-started',
        usedBy: 3,
        builtin: false,
      });
      // The gallery writes a sentence per card; one list read has to carry it.
      expect(row.version.version).toBe(1);
      expect(row.version.inputs).toHaveLength(2);
      expect(row.version.definition.kind).toBe('notification');
    });
  });

  describe('GET /templates/:id', () => {
    it('returns the summary with its current version', async () => {
      app = await buildTestApp(viewerUser);
      const envelope = envelopeOf('stream-started');
      vi.mocked(getTemplate).mockResolvedValue({
        ...summary(),
        version: currentVersion(envelope),
      } as never);

      const response = await app.inject({ method: 'GET', url: `/templates/${TEMPLATE_ID}` });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.version.version).toBe(1);
      expect(body.version.inputs).toHaveLength(2);
      expect(body.version.definition.kind).toBe('notification');
    });

    it('404s on a template nothing stored', async () => {
      app = await buildTestApp(viewerUser);
      vi.mocked(getTemplate).mockResolvedValue(null);

      const response = await app.inject({ method: 'GET', url: `/templates/${TEMPLATE_ID}` });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /templates/:id/versions/:version', () => {
    it('returns one stored version', async () => {
      app = await buildTestApp(viewerUser);
      const envelope = envelopeOf('stream-started');
      vi.mocked(getTemplateVersion).mockResolvedValue(currentVersion(envelope));

      const response = await app.inject({
        method: 'GET',
        url: `/templates/${TEMPLATE_ID}/versions/1`,
      });

      expect(response.statusCode).toBe(200);
      expect(getTemplateVersion).toHaveBeenCalledWith(TEMPLATE_ID, 1);
      expect(response.json().definition.kind).toBe('notification');
    });

    it('400s on a version that is not a number', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: `/templates/${TEMPLATE_ID}/versions/latest`,
      });

      expect(response.statusCode).toBe(400);
    });

    it('404s on a version nothing stored', async () => {
      app = await buildTestApp(viewerUser);
      vi.mocked(getTemplateVersion).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: `/templates/${TEMPLATE_ID}/versions/9`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /templates/preview', () => {
    it('caps the two routes that decode a pasted code', async () => {
      app = await buildTestApp(ownerUser);

      const cap = { rateLimit: { max: 60, timeWindow: '1 minute' } };
      expect(registeredRoutes.get('POST /templates/preview')).toEqual(cap);
      expect(registeredRoutes.get('POST /templates')).toEqual(cap);
    });

    it('decodes a share code and writes nothing', async () => {
      app = await buildTestApp(ownerUser);
      const envelope = envelopeOf('stream-started');

      const response = await app.inject({
        method: 'POST',
        url: '/templates/preview',
        payload: { code: shareCode(envelope) },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.envelope).toEqual(envelope);
      expect(body.fingerprint).toBe(envelope.fingerprint);
      expect(body.existing).toBeUndefined();
      expect(body.minServerVersion).toEqual({
        required: '2.2.0',
        current: '2.2.0',
        satisfied: true,
      });
      expect(createTemplate).not.toHaveBeenCalled();
    });

    it('names the template a matching fingerprint already sits in', async () => {
      app = await buildTestApp(ownerUser);
      const envelope = envelopeOf('stream-started');
      vi.mocked(matchTemplate).mockResolvedValue({
        templateId: TEMPLATE_ID,
        version: 2,
        name: 'Stream started',
        builtin: true,
        fingerprintMatch: true,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/templates/preview',
        payload: { envelope },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().existing).toEqual({
        templateId: TEMPLATE_ID,
        version: 2,
        name: 'Stream started',
        builtin: true,
        fingerprintMatch: true,
      });
    });

    it('is owner only', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/templates/preview',
        payload: { envelope: envelopeOf('stream-started') },
      });

      expect(response.statusCode).toBe(403);
    });

    it('reports the version this build cannot run', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getCurrentVersion).mockReturnValue('2.1.9-beta.3');

      const response = await app.inject({
        method: 'POST',
        url: '/templates/preview',
        payload: { envelope: envelopeOf('stream-started') },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().minServerVersion).toEqual({
        required: '2.2.0',
        current: '2.1.9-beta.3',
        satisfied: false,
      });
    });

    it('runs a share code on a tagged prerelease build past the required release', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getCurrentVersion).mockReturnValue('v2.2.4-beta.3');

      const response = await app.inject({
        method: 'POST',
        url: '/templates/preview',
        payload: { envelope: envelopeOf('stream-started') },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().minServerVersion).toEqual({
        required: '2.2.0',
        current: 'v2.2.4-beta.3',
        satisfied: true,
      });
    });

    it('400s with the reason a share code was rejected', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/templates/preview',
        payload: { code: 'not-a-tracearr-code' },
      });

      expect(response.statusCode).toBe(400);
      // A plain sentence for the reader, the reason for the client.
      expect(response.json()).toMatchObject({
        message: 'This is not a Tracearr share code',
        reason: 'prefix',
      });
    });

    it('400s an over-long code with the reason, not a bare length error', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/templates/preview',
        payload: { code: `tracearr1.${'A'.repeat(66_000)}` },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        message: 'This share code is too long',
        reason: 'too_long',
      });
    });

    it('400s on an envelope the schema rejects', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/templates/preview',
        payload: { envelope: { schemaVersion: 1, slug: 'nope' } },
      });

      expect(response.statusCode).toBe(400);
    });

    it('400s a pasted envelope nested past the depth a code is capped at', async () => {
      app = await buildTestApp(ownerUser);
      let nested: unknown = 1;
      for (let level = 0; level < 40; level += 1) nested = [nested];

      const response = await app.inject({
        method: 'POST',
        url: '/templates/preview',
        payload: { envelope: { schemaVersion: 1, definition: nested } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ reason: 'too_deep' });
    });

    it('400s when the body carries neither a code nor an envelope', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({ method: 'POST', url: '/templates/preview', payload: {} });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /templates', () => {
    it('201s a new template and imports it as such', async () => {
      app = await buildTestApp(ownerUser);
      const envelope = envelopeOf('stream-started');
      vi.mocked(createTemplate).mockResolvedValue({ id: TEMPLATE_ID, version: 1, created: true });
      vi.mocked(getTemplate).mockResolvedValue({
        ...summary(),
        version: currentVersion(envelope),
      } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/templates',
        payload: { code: shareCode(envelope) },
      });

      expect(response.statusCode).toBe(201);
      expect(createTemplate).toHaveBeenCalledWith(envelope, { source: 'import' });
      expect(response.json().id).toBe(TEMPLATE_ID);
    });

    it('200s the template a fingerprint match landed on', async () => {
      app = await buildTestApp(ownerUser);
      const envelope = envelopeOf('stream-started');
      vi.mocked(createTemplate).mockResolvedValue({ id: TEMPLATE_ID, version: 1, created: false });
      vi.mocked(getTemplate).mockResolvedValue({
        ...summary(),
        version: currentVersion(envelope),
      } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/templates',
        payload: { envelope },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe(TEMPLATE_ID);
    });

    it('200s the template a matching body already sits in under another slug', async () => {
      app = await buildTestApp(ownerUser);
      const envelope = envelopeOf('stream-started');
      vi.mocked(createTemplate).mockResolvedValue({ id: TEMPLATE_ID, version: 2, created: false });
      vi.mocked(getTemplate).mockResolvedValue({
        ...summary({ slug: 'renamed-elsewhere', currentVersion: 2 }),
        version: currentVersion(envelope),
      } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/templates',
        payload: { envelope },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: TEMPLATE_ID, slug: 'renamed-elsewhere' });
    });

    it('carries a local save and the template it replaces to the store', async () => {
      app = await buildTestApp(ownerUser);
      const envelope = envelopeOf('stream-started');
      const replaceId = randomUUID();
      vi.mocked(createTemplate).mockResolvedValue({ id: replaceId, version: 2, created: false });
      vi.mocked(getTemplate).mockResolvedValue({
        ...summary({ id: replaceId, source: 'local', currentVersion: 2 }),
        version: currentVersion(envelope),
      } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/templates',
        payload: { envelope, source: 'local', replace: replaceId },
      });

      expect(response.statusCode).toBe(200);
      expect(createTemplate).toHaveBeenCalledWith(envelope, { source: 'local', replaceId });
    });

    it('422s a template this build is too old to run', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getCurrentVersion).mockReturnValue('2.1.0');

      const response = await app.inject({
        method: 'POST',
        url: '/templates',
        payload: { envelope: envelopeOf('stream-started') },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().message).toContain('2.2.0');
      expect(createTemplate).not.toHaveBeenCalled();
    });

    it('400s when the body no longer hashes to its fingerprint', async () => {
      app = await buildTestApp(ownerUser);
      const envelope = envelopeOf('stream-started');
      envelope.fingerprint = fingerprintOf({ inputs: [], definition: envelope.definition }, () =>
        'a'.repeat(64)
      );

      const response = await app.inject({
        method: 'POST',
        url: '/templates',
        payload: { envelope },
      });

      expect(response.statusCode).toBe(400);
    });

    it('is owner only', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/templates',
        payload: { envelope: envelopeOf('stream-started') },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('DELETE /templates/:id', () => {
    it('204s a template nothing points at', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(deleteTemplate).mockResolvedValue('deleted');

      const response = await app.inject({ method: 'DELETE', url: `/templates/${TEMPLATE_ID}` });

      expect(response.statusCode).toBe(204);
    });

    it('403s a builtin', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(deleteTemplate).mockResolvedValue('builtin');

      const response = await app.inject({ method: 'DELETE', url: `/templates/${TEMPLATE_ID}` });

      expect(response.statusCode).toBe(403);
    });

    it('409s with what still uses it', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(deleteTemplate).mockResolvedValue({ usedBy: 7, names: ['a', 'b'] });

      const response = await app.inject({ method: 'DELETE', url: `/templates/${TEMPLATE_ID}` });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ usedBy: 7, names: ['a', 'b'] });
    });

    it('is owner only', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({ method: 'DELETE', url: `/templates/${TEMPLATE_ID}` });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('POST /templates/:id/instantiate', () => {
    const bindStreamStarted = () => {
      const envelope = envelopeOf('stream-started');
      vi.mocked(getTemplate).mockResolvedValue({
        ...summary(),
        version: currentVersion(envelope),
      } as never);
      return envelope;
    };

    it('201s the automation the binding produced', async () => {
      app = await buildTestApp(ownerUser);
      bindStreamStarted();
      const created = automationRow();
      vi.mocked(instantiateTemplate).mockResolvedValue(created as never);
      setupTransaction();
      setupSelect([created]);

      const response = await app.inject({
        method: 'POST',
        url: `/templates/${TEMPLATE_ID}/instantiate`,
        payload: { inputs: { to: [DESTINATION_ID] }, name: 'Now playing' },
      });

      expect(response.statusCode).toBe(201);
      expect(instantiateTemplate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: TEMPLATE_ID }),
        {
          definition: expect.objectContaining({ name: 'Now playing' }),
          inputs: { to: [DESTINATION_ID] },
        },
        // Nothing said, and the template was pasted in: it lands paused.
        { isActive: false }
      );
      expect(response.json()).toMatchObject({ id: AUTOMATION_ID, kind: 'notification' });
      expect(invalidateAutomationsCache).toHaveBeenCalledTimes(1);
      expect(scheduleInactivityChecks).not.toHaveBeenCalled();
    });

    it('honours an explicit choice over the paused-on-import default', async () => {
      app = await buildTestApp(ownerUser);
      bindStreamStarted();
      const created = automationRow({ isActive: false });
      vi.mocked(instantiateTemplate).mockResolvedValue(created as never);
      setupTransaction();
      setupSelect([created]);

      await app.inject({
        method: 'POST',
        url: `/templates/${TEMPLATE_ID}/instantiate`,
        payload: { inputs: { to: [DESTINATION_ID] }, isActive: true },
      });

      expect(vi.mocked(instantiateTemplate).mock.calls[0]?.[3]).toEqual({ isActive: true });
    });

    it('leaves a bundled template on by default', async () => {
      app = await buildTestApp(ownerUser);
      const envelope = envelopeOf('stream-started');
      vi.mocked(getTemplate).mockResolvedValue({
        ...summary({ builtin: true, source: 'builtin' }),
        version: currentVersion(envelope),
      } as never);
      const created = automationRow();
      vi.mocked(instantiateTemplate).mockResolvedValue(created as never);
      setupTransaction();
      setupSelect([created]);

      await app.inject({
        method: 'POST',
        url: `/templates/${TEMPLATE_ID}/instantiate`,
        payload: { inputs: { to: [DESTINATION_ID] } },
      });

      expect(vi.mocked(instantiateTemplate).mock.calls[0]?.[3]).toEqual({});
    });

    it('sweeps for inactivity when the instance carries that trigger', async () => {
      app = await buildTestApp(ownerUser);
      const envelope = envelopeOf('account-inactivity');
      vi.mocked(getTemplate).mockResolvedValue({
        ...summary({ slug: 'account-inactivity', kind: 'policy' }),
        version: currentVersion(envelope),
      } as never);
      const created = automationRow({
        kind: 'policy',
        triggers: [
          {
            id: randomUUID(),
            type: 'account.inactive_for',
            enabled: true,
            params: { days: 30 },
          },
        ],
      });
      vi.mocked(instantiateTemplate).mockResolvedValue(created as never);
      setupTransaction();
      setupSelect([created]);

      const response = await app.inject({
        method: 'POST',
        url: `/templates/${TEMPLATE_ID}/instantiate`,
        payload: { inputs: { days: 30 } },
      });

      expect(response.statusCode).toBe(201);
      expect(scheduleInactivityChecks).toHaveBeenCalledTimes(1);
    });

    it('materializes once, with a default name the column can hold', async () => {
      app = await buildTestApp(ownerUser);
      bindStreamStarted();
      const created = automationRow();
      vi.mocked(instantiateTemplate).mockResolvedValue(created as never);
      setupTransaction();
      // The server the binding names, then the ref check, then the reply's read.
      setupSelect([{ name: 'A'.repeat(100) }], [{ id: SERVER_ID }], [created]);

      const response = await app.inject({
        method: 'POST',
        url: `/templates/${TEMPLATE_ID}/instantiate`,
        payload: { inputs: { to: [DESTINATION_ID], server: SERVER_ID } },
      });

      expect(response.statusCode).toBe(201);
      expect(instantiateTemplate).toHaveBeenCalledTimes(1);
      const binding = vi.mocked(instantiateTemplate).mock.calls[0]?.[2];
      expect(binding?.definition.name).toHaveLength(100);
      expect(binding?.definition.name.startsWith('Stream started — AAA')).toBe(true);
    });

    it('400s an input the template never declared', async () => {
      app = await buildTestApp(ownerUser);
      bindStreamStarted();

      const response = await app.inject({
        method: 'POST',
        url: `/templates/${TEMPLATE_ID}/instantiate`,
        payload: { inputs: { to: [DESTINATION_ID], sneaky: 'value' } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toBe('Unknown input(s): sneaky');
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('400s listing the required inputs nothing bound', async () => {
      app = await buildTestApp(ownerUser);
      bindStreamStarted();

      const response = await app.inject({
        method: 'POST',
        url: `/templates/${TEMPLATE_ID}/instantiate`,
        payload: { inputs: {} },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('to');
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('400s the destinations no row backs', async () => {
      app = await buildTestApp(ownerUser);
      bindStreamStarted();
      const gone = randomUUID();
      vi.mocked(unknownDestinationIds).mockResolvedValue([gone]);

      const response = await app.inject({
        method: 'POST',
        url: `/templates/${TEMPLATE_ID}/instantiate`,
        payload: { inputs: { to: [gone] } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain(gone);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('404s a server the binding names that is gone', async () => {
      app = await buildTestApp(ownerUser);
      bindStreamStarted();
      setupSelect([]);

      const response = await app.inject({
        method: 'POST',
        url: `/templates/${TEMPLATE_ID}/instantiate`,
        payload: { inputs: { to: [DESTINATION_ID], server: randomUUID() } },
      });

      expect(response.statusCode).toBe(404);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('404s a template nothing stored', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getTemplate).mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: `/templates/${TEMPLATE_ID}/instantiate`,
        payload: { inputs: {} },
      });

      expect(response.statusCode).toBe(404);
    });

    it('is owner only', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: `/templates/${TEMPLATE_ID}/instantiate`,
        payload: { inputs: {} },
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
