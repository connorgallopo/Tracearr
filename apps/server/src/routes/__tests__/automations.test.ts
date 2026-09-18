/**
 * Automation route tests
 *
 * The db is mocked, so what this tier proves is the contract: the list envelope
 * and the predicates the handler passed, which writes take a version row, and
 * that every write sits behind the owner decorator. Assertions render the SQL
 * the handler built rather than counting calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type {
  AuthUser,
  AutomationActions,
  AutomationConditions,
  DryRunSample,
  TriggerNode,
} from '@tracearr/shared';
import { inflateRawSync } from 'node:zlib';
import { decodeShareCode, templateEnvelopeSchema } from '@tracearr/shared';
import { queryChain, renderCall } from '../../test/helpers.js';

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    selectDistinct: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../jobs/poller/database.js', () => ({ invalidateAutomationsCache: vi.fn() }));
vi.mock('../../jobs/inactivityCheckQueue.js', () => ({ scheduleInactivityChecks: vi.fn() }));
vi.mock('../../services/notifications/destinationRefs.js', () => ({
  unknownDestinationIds: vi.fn(),
}));
vi.mock('../../services/userService.js', () => ({
  recomputeIdentityAggregatesForServerUser: vi.fn(),
}));
vi.mock('../../services/automations/dryRun.js', () => ({ dryRun: vi.fn() }));
vi.mock('../../services/cache.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCacheService: vi.fn(),
}));
vi.mock('../../services/automations/templates/store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTemplate: vi.fn(),
  getTemplateVersion: vi.fn(),
}));

import { db } from '../../db/client.js';
import { dryRun } from '../../services/automations/dryRun.js';
import { getCacheService } from '../../services/cache.js';
import { invalidateAutomationsCache } from '../../jobs/poller/database.js';
import { BUILTIN_ENVELOPES } from '../../services/automations/templates/builtin/index.js';
import { getTemplate, getTemplateVersion } from '../../services/automations/templates/store.js';
import { unknownDestinationIds } from '../../services/notifications/destinationRefs.js';
import { recomputeIdentityAggregatesForServerUser } from '../../services/userService.js';
import { automationRoutes } from '../automations.js';

const conditions: AutomationConditions = {
  groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 2 }] }],
};

const actions: AutomationActions = { actions: [{ type: 'kill_stream' }] };

const AUTOMATION_ID = randomUUID();
const OTHER_ID = randomUUID();
const TEMPLATE_ID = randomUUID();
const SERVER_ID = randomUUID();
const DESTINATION_ID = randomUUID();
const TRIGGER_ID = randomUUID();
const SESSION_ID = randomUUID();

function envelopeOf(slug: string) {
  const found = BUILTIN_ENVELOPES.find((envelope) => envelope.slug === slug);
  if (!found) throw new Error(`the ${slug} template is missing`);
  return found;
}

const streamStarted = envelopeOf('stream-started');

/** The pinned version a bound row re-materializes against. */
const templateVersion = (version: number, definition = streamStarted.definition) => ({
  version,
  inputs: streamStarted.inputs,
  definition,
});

/** The same template with a body the version before it did not have. */
function editedDefinition() {
  const definition = structuredClone(streamStarted.definition);
  const action = definition.actions.actions[0];
  if (action?.type !== 'send') throw new Error('stream-started lost its send action');
  action.title = 'Now playing';
  return definition;
}

function automationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AUTOMATION_ID,
    name: 'kill long pauses',
    description: null,
    kind: 'policy',
    severity: 'warning',
    triggers: [{ id: randomUUID(), type: 'session.started', enabled: true }],
    conditions,
    actions,
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    isActive: true,
    cooldownMinutes: null,
    retentionDays: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-02T00:00:00.000Z'),
    ...overrides,
  };
}

/** An instance of the stream-started template, as the joined read hands it back. */
function boundRow(overrides: Record<string, unknown> = {}) {
  return automationRow({
    name: 'Stream started — Plex',
    kind: 'notification',
    conditions: { groups: [] },
    actions: { actions: [{ id: randomUUID(), type: 'send', enabled: true, to: [DESTINATION_ID] }] },
    triggers: [{ id: TRIGGER_ID, type: 'session.started', enabled: true }],
    serverId: SERVER_ID,
    serverName: 'Plex',
    templateId: TEMPLATE_ID,
    templateVersion: 1,
    templateInputs: { to: [DESTINATION_ID], server: SERVER_ID },
    templateSlug: 'stream-started',
    templateName: 'Stream started',
    templateCurrentVersion: 3,
    templateSource: 'builtin',
    templateAuthor: null,
    templateAddedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  });
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
  const redis = {
    lrange: vi.fn().mockResolvedValue([
      JSON.stringify({
        reason: 'cooldown_active',
        subjectKey: 's1',
        trigger: 'session.paused',
        at: '2026-08-20T10:00:00.000Z',
      }),
      'not json',
      JSON.stringify({
        reason: 'gate_blocked',
        subjectKey: 's2',
        trigger: 'session.started',
        at: '2026-08-20T09:00:00.000Z',
      }),
    ]),
  };
  app.decorate('redis', redis as unknown as FastifyInstance['redis']);

  await app.register(automationRoutes, { prefix: '/automations' });
  return app;
}

/** The page query, then its count. */
function setupListMocks(rows: unknown[], total: number) {
  const pageChain = queryChain(vi.fn, rows);
  const countChain = queryChain(vi.fn, [{ total }]);
  vi.mocked(db.select as unknown as ReturnType<typeof vi.fn>)
    .mockReturnValueOnce(pageChain)
    .mockReturnValueOnce(countChain)
    .mockReturnValue(queryChain(vi.fn, []));
  return { pageChain, countChain };
}

/** The distinct server users a delete's cascade would drop counted runs for. */
function setupCountedIdentities(rows: Array<{ serverUserId: string | null }>) {
  const chain = queryChain(vi.fn, rows);
  vi.mocked(db.selectDistinct as unknown as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  return chain;
}

/** One select, for the by-id load a write path does first. */
function setupSelect(...results: unknown[][]) {
  const chains = results.map((rows) => queryChain(vi.fn, rows));
  const select = vi.mocked(db.select as unknown as ReturnType<typeof vi.fn>);
  for (const chain of chains) select.mockReturnValueOnce(chain);
  select.mockReturnValue(queryChain(vi.fn, []));
  return chains;
}

interface TxHarness {
  inserts: unknown[];
  insertedValues: unknown[];
  updateSets: unknown[];
}

/** Records which tables the transaction wrote, so a version row is visible to assertions. */
function setupTransaction(rows: unknown[][]): TxHarness {
  const harness: TxHarness = { inserts: [], insertedValues: [], updateSets: [] };
  let call = 0;
  const next = () => rows[call++] ?? [];
  const tx = {
    insert: (table: unknown) => {
      harness.inserts.push(table);
      return {
        values: (values: unknown) => {
          harness.insertedValues.push(values);
          return { returning: () => Promise.resolve(next()) };
        },
      };
    },
    update: () => ({
      set: (values: unknown) => {
        harness.updateSets.push(values);
        return { where: () => ({ returning: () => Promise.resolve(next()) }) };
      },
    }),
  };
  vi.mocked(db.transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation((async (
    fn: (executor: unknown) => Promise<unknown>
  ) => fn(tx)) as never);
  return harness;
}

/** The driver's error when the version number this save computed is already taken. */
function versionCollision(): Error {
  return Object.assign(
    new Error('duplicate key value violates unique constraint "automation_versions_unique"'),
    { code: '23505' }
  );
}

/** Collides the next `times` transactions; the harness implementation answers the rest. */
function failTransactions(times: number): void {
  const transaction = vi.mocked(db.transaction as unknown as ReturnType<typeof vi.fn>);
  for (let i = 0; i < times; i++) {
    transaction.mockImplementationOnce((() => Promise.reject(versionCollision())) as never);
  }
}

describe('Automation routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    // Reset, not clear: an unconsumed mockReturnValueOnce would answer the next test's query.
    vi.resetAllMocks();
    vi.mocked(unknownDestinationIds).mockResolvedValue([]);
    setupCountedIdentities([]);
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('GET /automations', () => {
    it('returns the list envelope with the wire shape', async () => {
      app = await buildTestApp(ownerUser);
      setupListMocks([automationRow()], 1);

      const response = await app.inject({ method: 'GET', url: '/automations' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
      expect(body.data[0]).toMatchObject({
        id: AUTOMATION_ID,
        name: 'kill long pauses',
        kind: 'policy',
        severity: 'warning',
        isActive: true,
        cooldownMinutes: null,
        retentionDays: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      });
      expect(body.data[0].triggers).toHaveLength(1);
      expect(body.data[0].conditions).toEqual(conditions);
    });

    it('filters on kind, enabled and a search over the name or the description', async () => {
      app = await buildTestApp(ownerUser);
      const { pageChain, countChain } = setupListMocks([], 0);

      const response = await app.inject({
        method: 'GET',
        url: '/automations?kind=notification&enabled=false&search=pause%25',
      });

      expect(response.statusCode).toBe(200);
      const page = renderCall(pageChain);
      expect(page.text).toContain('automations.kind = ');
      expect(page.text).toContain('automations.is_active = ');
      expect(page.text).toContain('automations.name ilike ');
      expect(page.text).toContain('automations.description ilike ');
      // The literal % the caller typed is escaped, never a wildcard.
      expect(page.params).toEqual(['notification', false, '%pause\\%%', '%pause\\%%']);
      // The count counts exactly the page's rows.
      expect(renderCall(countChain).text).toBe(page.text);
    });

    it('narrows to what starts a row, over every trigger type in the group', async () => {
      app = await buildTestApp(ownerUser);
      const { pageChain } = setupListMocks([], 0);

      await app.inject({ method: 'GET', url: '/automations?trigger=updates' });

      const page = renderCall(pageChain);
      expect(page.text).toContain('jsonb_array_elements(automations.triggers)');
      expect(page.params).toEqual([
        'plugin.update_available',
        'server.update_available',
        'tracearr.update_available',
      ]);
    });

    it('narrows on severity, which is a column of its own', async () => {
      app = await buildTestApp(ownerUser);
      const { pageChain } = setupListMocks([], 0);

      await app.inject({ method: 'GET', url: '/automations?severity=high' });

      const page = renderCall(pageChain);
      expect(page.text).toContain('automations.severity = ');
      expect(page.params).toEqual(['high']);
    });

    it('narrows to the library a row came from, counting exactly what it lists', async () => {
      app = await buildTestApp(ownerUser);
      const { pageChain, countChain } = setupListMocks([], 0);

      const response = await app.inject({ method: 'GET', url: '/automations?source=import' });

      expect(response.statusCode).toBe(200);
      const page = renderCall(pageChain);
      expect(page.text).toContain('EXISTS (SELECT 1 FROM automation_templates t');
      expect(page.params).toEqual(['import']);
      // The count query has no template join of its own, so it must read the same EXISTS.
      expect(renderCall(countChain).text).toBe(page.text);
    });

    it('reads the rows no template wrote off the null template id', async () => {
      app = await buildTestApp(ownerUser);
      const { pageChain } = setupListMocks([], 0);

      await app.inject({ method: 'GET', url: '/automations?source=own' });

      const page = renderCall(pageChain);
      expect(page.text).toContain('automations.template_id is null');
      expect(page.text).not.toContain('automation_templates');
    });

    it('narrows to one server on the column the scope already uses', async () => {
      app = await buildTestApp(ownerUser);
      const { pageChain } = setupListMocks([], 0);

      await app.inject({ method: 'GET', url: `/automations?serverId=${SERVER_ID}` });

      const page = renderCall(pageChain);
      expect(page.text).toContain('automations.server_id = ');
      expect(page.params).toEqual([SERVER_ID]);
    });

    it('sorts on a whitelisted field, tiebroken on the id', async () => {
      app = await buildTestApp(ownerUser);
      const { pageChain } = setupListMocks([], 0);

      await app.inject({ method: 'GET', url: '/automations?orderBy=updatedAt&orderDir=asc' });

      expect(renderCall(pageChain, 'orderBy').text).toBe(
        'automations.updated_at ASC, automations.id ASC'
      );
    });

    it('rejects a sort field that is not whitelisted', async () => {
      app = await buildTestApp(ownerUser);
      setupListMocks([], 0);

      const response = await app.inject({ method: 'GET', url: '/automations?orderBy=severity' });

      expect(response.statusCode).toBe(400);
    });

    it('shows a viewer global automations and the ones scoped to servers it can reach', async () => {
      app = await buildTestApp(viewerUser);
      const { pageChain } = setupListMocks([], 0);

      await app.inject({ method: 'GET', url: '/automations' });

      const page = renderCall(pageChain);
      expect(page.text).toContain('automations.server_id is null');
      expect(page.text).toContain('EXISTS (SELECT 1 FROM server_users su');
      expect(page.params).toContain('srv-1');
    });
  });

  describe('GET /automations/:id', () => {
    it('returns the automation', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([automationRow()]);

      const response = await app.inject({ method: 'GET', url: `/automations/${AUTOMATION_ID}` });

      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe(AUTOMATION_ID);
    });

    it('404s when there is no such automation', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([]);

      const response = await app.inject({ method: 'GET', url: `/automations/${AUTOMATION_ID}` });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /automations', () => {
    const body = {
      name: 'pause watch',
      kind: 'policy' as const,
      severity: 'warning' as const,
      triggers: [{ id: TRIGGER_ID, type: 'session.paused' as const, enabled: true }],
      conditions: {
        groups: [{ conditions: [{ field: 'total_pause_minutes', operator: 'gt', value: 30 }] }],
      },
      actions: { actions: [{ type: 'kill_stream' as const }] },
    };

    it('stamps nodes and writes version 1 in the same transaction', async () => {
      app = await buildTestApp(ownerUser);
      const created = automationRow({ id: OTHER_ID, name: 'pause watch' });
      const harness = setupTransaction([[created], [{ id: 'ver-1' }]]);
      setupSelect([created]);

      const response = await app.inject({ method: 'POST', url: '/automations', payload: body });

      expect(response.statusCode).toBe(201);
      expect(response.json().id).toBe(OTHER_ID);

      const values = harness.insertedValues[0] as {
        conditions: AutomationConditions;
        actions: AutomationActions;
      };
      const condition = values.conditions.groups[0]?.conditions[0];
      expect(condition).toMatchObject({ id: expect.any(String), enabled: true });
      expect(values.actions.actions[0]).toMatchObject({ id: expect.any(String), enabled: true });

      const version = harness.insertedValues[1] as { version: unknown; definition: unknown };
      expect(harness.inserts).toHaveLength(2);
      expect(version.definition).toMatchObject({ name: 'pause watch', kind: 'policy' });
      expect(invalidateAutomationsCache).toHaveBeenCalledTimes(1);
    });

    it('preserves ids the builder already assigned', async () => {
      app = await buildTestApp(ownerUser);
      const harness = setupTransaction([[automationRow()], [{ id: 'ver-1' }]]);
      setupSelect([automationRow()]);
      const id = randomUUID();

      await app.inject({
        method: 'POST',
        url: '/automations',
        payload: {
          ...body,
          actions: { actions: [{ type: 'kill_stream', id, enabled: false }] },
        },
      });

      const values = harness.insertedValues[0] as { actions: AutomationActions };
      expect(values.actions.actions[0]).toMatchObject({ id, enabled: false });
    });

    it('names the destinations no row backs', async () => {
      app = await buildTestApp(ownerUser);
      const gone = randomUUID();
      vi.mocked(unknownDestinationIds).mockResolvedValue([gone]);
      setupTransaction([[automationRow()]]);

      const response = await app.inject({
        method: 'POST',
        url: '/automations',
        payload: {
          ...body,
          actions: { actions: [{ type: 'send', to: [gone] }] },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain(gone);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('rejects two scopes at once', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/automations',
        payload: { ...body, serverId: randomUUID(), userId: randomUUID() },
      });

      expect(response.statusCode).toBe(400);
    });

    it('404s on a scope the database does not have', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([]);

      const response = await app.inject({
        method: 'POST',
        url: '/automations',
        payload: { ...body, serverId: randomUUID() },
      });

      expect(response.statusCode).toBe(404);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('is owner only', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({ method: 'POST', url: '/automations', payload: body });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('POST /automations/dry-run', () => {
    const definition = {
      name: 'movies only',
      kind: 'policy',
      severity: 'warning',
      triggers: [{ id: TRIGGER_ID, type: 'session.started', enabled: true }],
      conditions: {
        groups: [{ conditions: [{ field: 'media_type', operator: 'in', value: ['movie'] }] }],
      },
      actions: { actions: [] },
    };

    const sample: DryRunSample = {
      subject: {
        sessionId: SESSION_ID,
        user: { id: 'su1', name: 'Connor' },
        server: { id: SERVER_ID, name: 'Plex' },
      },
      triggers: ['session.started'],
      conditions: [],
      actions: [],
      wouldRun: true,
      summary: 'Would run for Connor on Plex.',
    };

    it('rejects a definition the schema will not take', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/automations/dry-run',
        payload: { definition: { ...definition, kind: 'nonsense' } },
      });

      expect(response.statusCode).toBe(400);
      expect(vi.mocked(dryRun)).not.toHaveBeenCalled();
    });

    it('404s a sample session the caller cannot see', async () => {
      app = await buildTestApp(viewerUser);
      const [chain] = setupSelect([]);

      const response = await app.inject({
        method: 'POST',
        url: '/automations/dry-run',
        payload: { definition, sample: { sessionId: SESSION_ID } },
      });

      expect(response.statusCode).toBe(404);
      expect(vi.mocked(dryRun)).not.toHaveBeenCalled();
      const where = renderCall(chain);
      expect(where.text).toBe('(sessions.id = $1 and sessions.server_id = $2)');
      expect(where.params).toEqual([SESSION_ID, 'srv-1']);
    });

    it('checks only the sampled session', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([{ id: SESSION_ID, serverId: SERVER_ID, serverUserId: 'su1' }]);
      vi.mocked(dryRun).mockResolvedValue({ samples: [sample] });

      const response = await app.inject({
        method: 'POST',
        url: '/automations/dry-run',
        payload: { definition, sample: { sessionId: SESSION_ID } },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ samples: [sample] });
      const args = vi.mocked(dryRun).mock.calls[0]?.[0];
      expect(args?.sessions.map((session) => session.id)).toEqual([SESSION_ID]);
      expect(args?.user).toEqual(ownerUser);
    });

    it('checks the live sessions when no sample is named', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getCacheService).mockReturnValue({
        getAllActiveSessions: () => Promise.resolve([{ id: SESSION_ID }]),
      } as unknown as ReturnType<typeof getCacheService>);
      vi.mocked(dryRun).mockResolvedValue({ samples: [sample] });

      const response = await app.inject({
        method: 'POST',
        url: '/automations/dry-run',
        payload: { definition },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().samples[0].subject.sessionId).toBe(SESSION_ID);
      expect(vi.mocked(dryRun).mock.calls[0]?.[0].sessions).toHaveLength(1);
    });

    it('carries a rate limit of its own', async () => {
      app = await buildTestApp(ownerUser);

      expect(registeredRoutes.get('POST /automations/dry-run')).toEqual({
        rateLimit: { max: 60, timeWindow: '1 minute' },
      });
    });
  });

  describe('PATCH /automations/:id', () => {
    it('versions a condition change and leaves the stored triggers where they are', async () => {
      app = await buildTestApp(ownerUser);
      const stored = automationRow();
      setupSelect([stored]);
      const nextConditions = {
        groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 4 }] }],
      };
      const harness = setupTransaction([
        [automationRow({ conditions: nextConditions })],
        [{ id: 'ver-2' }],
      ]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { conditions: nextConditions },
      });

      expect(response.statusCode).toBe(200);
      expect(harness.updateSets[0]).not.toHaveProperty('triggers');
      expect(harness.inserts).toHaveLength(1);
      expect(invalidateAutomationsCache).toHaveBeenCalledTimes(1);
    });

    it('writes no version for a bare active toggle', async () => {
      app = await buildTestApp(ownerUser);
      const stored = automationRow();
      setupSelect([stored]);
      const harness = setupTransaction([[{ ...stored, isActive: false }]]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { isActive: false },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().isActive).toBe(false);
      expect(harness.inserts).toEqual([]);
      expect(harness.updateSets[0]).not.toHaveProperty('triggers');
    });

    it('writes no version for a retention or cooldown change', async () => {
      app = await buildTestApp(ownerUser);
      const stored = automationRow();
      setupSelect([stored]);
      const harness = setupTransaction([[{ ...stored, retentionDays: 14, cooldownMinutes: 5 }]]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { retentionDays: 14, cooldownMinutes: 5 },
      });

      expect(response.statusCode).toBe(200);
      expect(harness.inserts).toEqual([]);
    });

    it('writes no version when the payload restates the stored definition', async () => {
      app = await buildTestApp(ownerUser);
      const conditionId = randomUUID();
      const actionId = randomUUID();
      // jsonb hands keys back shortest first, so a stored node never reads in payload order.
      const stored = automationRow({
        conditions: {
          groups: [
            {
              conditions: [
                {
                  id: conditionId,
                  field: 'concurrent_streams',
                  value: 2,
                  enabled: true,
                  operator: 'gt',
                },
              ],
            },
          ],
        },
        actions: { actions: [{ id: actionId, type: 'kill_stream', enabled: true }] },
      });
      setupSelect([stored]);
      const harness = setupTransaction([[stored]]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: {
          name: stored.name,
          // The builder resends the stored nodes in its own key order.
          conditions: {
            groups: [
              {
                conditions: [
                  {
                    field: 'concurrent_streams',
                    operator: 'gt',
                    value: 2,
                    id: conditionId,
                    enabled: true,
                  },
                ],
              },
            ],
          },
          actions: { actions: [{ type: 'kill_stream', id: actionId, enabled: true }] },
        },
      });

      expect(response.statusCode).toBe(200);
      // Fresh trigger ids on an unchanged definition would version the automation on every save.
      expect(harness.updateSets[0]).not.toHaveProperty('triggers');
      expect(harness.inserts).toEqual([]);
    });

    it('stamps the action nodes a payload changes', async () => {
      app = await buildTestApp(ownerUser);
      const stored = automationRow();
      setupSelect([stored]);
      const nextActions = { actions: [{ type: 'message_client', message: 'wrap it up' }] };
      const harness = setupTransaction([[{ ...stored, actions: nextActions }], [{ id: 'ver-2' }]]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { actions: nextActions },
      });

      expect(response.statusCode).toBe(200);
      const update = harness.updateSets[0] as { actions: AutomationActions };
      expect(update.actions.actions[0]).toMatchObject({
        type: 'message_client',
        id: expect.any(String),
        enabled: true,
      });
      expect(harness.inserts).toHaveLength(1);
    });

    it('names the destinations no row backs', async () => {
      app = await buildTestApp(ownerUser);
      const gone = randomUUID();
      setupSelect([automationRow()]);
      vi.mocked(unknownDestinationIds).mockResolvedValue([gone]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { actions: { actions: [{ type: 'send', to: [gone] }] } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain(gone);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('retries once when a concurrent save took the version number', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([automationRow()]);
      const harness = setupTransaction([[automationRow({ name: 'renamed' })], [{ id: 'ver-3' }]]);
      failTransactions(1);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { name: 'renamed' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().name).toBe('renamed');
      expect(db.transaction).toHaveBeenCalledTimes(2);
      expect(harness.inserts).toHaveLength(1);
    });

    it('409s when the retry collides too', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([automationRow()]);
      setupTransaction([[automationRow({ name: 'renamed' })], [{ id: 'ver-3' }]]);
      failTransactions(2);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { name: 'renamed' },
      });

      expect(response.statusCode).toBe(409);
      expect(db.transaction).toHaveBeenCalledTimes(2);
      expect(invalidateAutomationsCache).not.toHaveBeenCalled();
    });

    it('rejects a scope that only conflicts once merged with the stored row', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([automationRow({ serverId: 'srv-1' })]);
      setupTransaction([[automationRow()]]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { userId: randomUUID() },
      });

      expect(response.statusCode).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('rejects cross-server enforcement that the merged scope forbids', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([automationRow({ serverId: 'srv-1' })]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { enforceAcrossServers: true },
      });

      expect(response.statusCode).toBe(400);
    });

    it('404s on an automation that is not there', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { isActive: false },
      });

      expect(response.statusCode).toBe(404);
    });

    it('is owner only', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { isActive: false },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('DELETE /automations/:id', () => {
    it('deletes the automation and invalidates the cache', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([automationRow()]);
      const deleteChain = queryChain(vi.fn, []);
      vi.mocked(db.delete as unknown as ReturnType<typeof vi.fn>).mockReturnValue(deleteChain);

      const response = await app.inject({ method: 'DELETE', url: `/automations/${AUTOMATION_ID}` });

      expect(response.statusCode).toBe(204);
      expect(renderCall(deleteChain).params).toEqual([AUTOMATION_ID]);
      expect(invalidateAutomationsCache).toHaveBeenCalledTimes(1);
    });

    it('restates the identities whose violation counts the cascade removed', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([automationRow()]);
      const counted = setupCountedIdentities([
        { serverUserId: 'su-1' },
        { serverUserId: null },
        { serverUserId: 'su-2' },
      ]);
      const deleteChain = queryChain(vi.fn, []);
      vi.mocked(db.delete as unknown as ReturnType<typeof vi.fn>).mockReturnValue(deleteChain);

      const response = await app.inject({ method: 'DELETE', url: `/automations/${AUTOMATION_ID}` });

      expect(response.statusCode).toBe(204);
      // Only completed policy runs are counted, so only they can move the rollup.
      expect(renderCall(counted).text).toContain(
        'automation_runs.kind = $2 and automation_runs.outcome = $3'
      );
      expect(renderCall(counted).params).toEqual([AUTOMATION_ID, 'policy', 'completed']);
      expect(recomputeIdentityAggregatesForServerUser).toHaveBeenCalledTimes(2);
      expect(recomputeIdentityAggregatesForServerUser).toHaveBeenCalledWith('su-1');
      expect(recomputeIdentityAggregatesForServerUser).toHaveBeenCalledWith('su-2');
    });

    it('404s on an automation that is not there', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([]);

      const response = await app.inject({ method: 'DELETE', url: `/automations/${AUTOMATION_ID}` });

      expect(response.statusCode).toBe(404);
    });

    it('is owner only', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({ method: 'DELETE', url: `/automations/${AUTOMATION_ID}` });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('bulk', () => {
    it('toggles every requested automation and reports the count', async () => {
      app = await buildTestApp(ownerUser);
      const updateChain = queryChain(vi.fn, [{ id: AUTOMATION_ID }, { id: OTHER_ID }]);
      vi.mocked(db.update as unknown as ReturnType<typeof vi.fn>).mockReturnValue(updateChain);

      const response = await app.inject({
        method: 'PATCH',
        url: '/automations/bulk',
        payload: { ids: [AUTOMATION_ID, OTHER_ID], isActive: false },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, updated: 2 });
      expect(renderCall(updateChain).params).toEqual([AUTOMATION_ID, OTHER_ID]);
      expect(invalidateAutomationsCache).toHaveBeenCalledTimes(1);
    });

    it('deletes every requested automation and reports the count', async () => {
      app = await buildTestApp(ownerUser);
      const deleteChain = queryChain(vi.fn, [{ id: AUTOMATION_ID }]);
      vi.mocked(db.delete as unknown as ReturnType<typeof vi.fn>).mockReturnValue(deleteChain);

      const response = await app.inject({
        method: 'DELETE',
        url: '/automations/bulk',
        payload: { ids: [AUTOMATION_ID] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, deleted: 1 });
      expect(invalidateAutomationsCache).toHaveBeenCalledTimes(1);
    });

    it('leaves the cache alone when nothing matched', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(db.delete as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
        queryChain(vi.fn, [])
      );

      const response = await app.inject({
        method: 'DELETE',
        url: '/automations/bulk',
        payload: { ids: [AUTOMATION_ID] },
      });

      expect(response.json()).toEqual({ success: true, deleted: 0 });
      expect(invalidateAutomationsCache).not.toHaveBeenCalled();
    });

    it('is owner only', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/automations/bulk',
        payload: { ids: [AUTOMATION_ID], isActive: true },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('GET /automations/:id/runs', () => {
    it('pages the runs of one automation without their steps', async () => {
      app = await buildTestApp(ownerUser);
      const runRow = {
        id: 'run-1',
        automationId: AUTOMATION_ID,
        automationName: 'kill long pauses',
        kind: 'policy',
        outcome: 'completed',
        humanSummary: null,
        severity: 'warning',
        serverUserId: 'su1',
        sessionId: 's1',
        serverId: 'srv-1',
        subjectKey: 's1',
        startedAt: new Date('2026-08-20T10:00:00.000Z'),
        createdAt: new Date('2026-08-20T10:00:00.000Z'),
        finishedAt: new Date('2026-08-20T10:00:01.000Z'),
        acknowledgedAt: null,
        dismissedAt: null,
      };
      const [, pageChain] = setupSelect([automationRow()], [runRow], [{ total: 1 }]);

      const response = await app.inject({
        method: 'GET',
        url: `/automations/${AUTOMATION_ID}/runs`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
      expect(body.data[0]).not.toHaveProperty('steps');
      expect(body.data[0].startedAt).toBe('2026-08-20T10:00:00.000Z');
      expect(renderCall(pageChain).params).toContain(AUTOMATION_ID);
    });

    it('404s when the automation is gone', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([]);

      const response = await app.inject({
        method: 'GET',
        url: `/automations/${AUTOMATION_ID}/runs`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /automations/:id/evaluations', () => {
    it('returns the near-miss ring newest first and skips unreadable entries', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([automationRow()]);

      const response = await app.inject({
        method: 'GET',
        url: `/automations/${AUTOMATION_ID}/evaluations`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(2);
      expect(body.data[0]).toEqual({
        reason: 'cooldown_active',
        subjectKey: 's1',
        trigger: 'session.paused',
        at: '2026-08-20T10:00:00.000Z',
      });
      expect(body.data[1].reason).toBe('gate_blocked');
    });

    it('drops an entry whose shape the ring no longer matches', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([automationRow()]);
      vi.mocked(app.redis.lrange).mockResolvedValueOnce([
        JSON.stringify({ reason: 'retired_reason', subjectKey: 's1', trigger: 'x', at: 'nope' }),
      ]);

      const response = await app.inject({
        method: 'GET',
        url: `/automations/${AUTOMATION_ID}/evaluations`,
      });

      expect(response.json().data).toEqual([]);
    });

    it('logs how many ring entries it dropped', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([automationRow()]);
      const debug = vi.spyOn(app.log, 'debug');

      await app.inject({ method: 'GET', url: `/automations/${AUTOMATION_ID}/evaluations` });

      expect(debug).toHaveBeenCalledWith(
        expect.objectContaining({ automationId: AUTOMATION_ID, dropped: 1 }),
        expect.any(String)
      );
    });

    it('404s when the automation is gone', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([]);

      const response = await app.inject({
        method: 'GET',
        url: `/automations/${AUTOMATION_ID}/evaluations`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('explicit triggers', () => {
    it('stores the trigger set the payload carried', async () => {
      app = await buildTestApp(ownerUser);
      const harness = setupTransaction([[automationRow()], [{ id: 'ver-1' }]]);
      setupSelect([automationRow()]);
      const triggerId = randomUUID();

      const response = await app.inject({
        method: 'POST',
        url: '/automations',
        payload: {
          name: 'pause watch',
          kind: 'policy',
          severity: 'warning',
          triggers: [{ id: triggerId, type: 'session.paused', enabled: true }],
          conditions: {
            groups: [
              { conditions: [{ field: 'current_pause_minutes', operator: 'gt', value: 30 }] },
            ],
          },
          actions: { actions: [{ type: 'kill_stream' }] },
        },
      });

      expect(response.statusCode).toBe(201);
      const values = harness.insertedValues[0] as { triggers: TriggerNode[] };
      expect(values.triggers).toEqual([{ id: triggerId, type: 'session.paused', enabled: true }]);
    });

    it('rejects a create that names no trigger', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/automations',
        payload: {
          name: 'pause watch',
          kind: 'policy',
          severity: 'warning',
          conditions: {
            groups: [
              { conditions: [{ field: 'current_pause_minutes', operator: 'gt', value: 30 }] },
            ],
          },
          actions: { actions: [{ type: 'kill_stream' }] },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('rejects an edit that takes away the last enabled trigger', async () => {
      app = await buildTestApp(ownerUser);
      const stored = automationRow({
        triggers: [{ id: TRIGGER_ID, type: 'session.started', enabled: true }],
      });
      setupSelect([stored]);
      const harness = setupTransaction([[stored]]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { triggers: [] },
      });

      expect(response.statusCode).toBe(400);
      expect(harness.updateSets).toEqual([]);
    });
  });

  describe('names on the wire', () => {
    it('names the server, account and person a scope points at', async () => {
      app = await buildTestApp(ownerUser);
      setupListMocks(
        [
          automationRow({ id: randomUUID(), serverId: SERVER_ID, serverName: 'Plex' }),
          automationRow({
            id: randomUUID(),
            serverUserId: 'su-1',
            accountName: 'ada',
            accountServerId: SERVER_ID,
            accountServerName: 'Plex',
          }),
          automationRow({ id: randomUUID(), userId: 'usr-1', personName: 'Ada' }),
        ],
        3
      );

      const response = await app.inject({ method: 'GET', url: '/automations' });

      expect(response.statusCode).toBe(200);
      const [server, account, person] = response.json().data;
      expect(server.scopeRef).toEqual({ kind: 'server', id: SERVER_ID, name: 'Plex' });
      expect(account.scopeRef).toEqual({
        kind: 'account',
        id: 'su-1',
        name: 'ada',
        serverId: SERVER_ID,
        serverName: 'Plex',
      });
      expect(person.scopeRef).toEqual({ kind: 'person', id: 'usr-1', name: 'Ada' });
    });

    it('carries the template a row is bound to and the origin a detached one kept', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([
        boundRow({
          originTemplateId: OTHER_ID,
          originTemplateVersion: 2,
          originName: 'Stream started',
        }),
      ]);

      const response = await app.inject({ method: 'GET', url: `/automations/${AUTOMATION_ID}` });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.template).toEqual({
        id: TEMPLATE_ID,
        slug: 'stream-started',
        name: 'Stream started',
        version: 1,
        currentVersion: 3,
        source: 'builtin',
        author: null,
        addedAt: '2026-08-01T00:00:00.000Z',
      });
      expect(body.templateInputs).toEqual({ to: [DESTINATION_ID], server: SERVER_ID });
      expect(body.origin).toEqual({
        templateId: OTHER_ID,
        version: 2,
        name: 'Stream started',
      });
    });

    it('leaves the origin of a template that is gone unnamed', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([
        automationRow({ originTemplateId: OTHER_ID, originTemplateVersion: 4, originName: null }),
      ]);

      const response = await app.inject({ method: 'GET', url: `/automations/${AUTOMATION_ID}` });

      expect(response.json().origin).toEqual({ templateId: OTHER_ID, version: 4, name: null });
    });
  });

  describe('template-bound automations', () => {
    it('409s an edit to what the automation does', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([boundRow()]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { conditions: { groups: [] } },
      });

      expect(response.statusCode).toBe(409);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('409s an edit to the scope or the kind the template decides', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([boundRow()]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { serverId: randomUUID(), kind: 'policy' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().message).toContain('kind');
      expect(response.json().message).toContain('serverId');
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('409s a scope edit that rides along with new inputs', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([boundRow()]);
      vi.mocked(getTemplateVersion).mockResolvedValue(templateVersion(1));

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: {
          templateInputs: { to: [DESTINATION_ID], server: SERVER_ID },
          enforceAcrossServers: true,
        },
      });

      expect(response.statusCode).toBe(409);
      expect(getTemplateVersion).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('keeps taking the fields the instance owns', async () => {
      app = await buildTestApp(ownerUser);
      const stored = boundRow();
      setupSelect([stored]);
      const harness = setupTransaction([[{ ...stored, isActive: false, severity: 'high' }]]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { isActive: false, severity: 'high', retentionDays: 14 },
      });

      expect(response.statusCode).toBe(200);
      expect(harness.updateSets[0]).toMatchObject({
        isActive: false,
        severity: 'high',
        retentionDays: 14,
      });
    });

    it('re-materializes new inputs against the pinned version and keeps the instance fields', async () => {
      app = await buildTestApp(ownerUser);
      const stored = boundRow();
      setupSelect([stored], [{ id: SERVER_ID }]);
      vi.mocked(getTemplateVersion).mockResolvedValue(templateVersion(1));
      const nextDestination = randomUUID();
      const harness = setupTransaction([
        [
          {
            ...stored,
            actions: { actions: [{ id: randomUUID(), type: 'send', to: [nextDestination] }] },
          },
        ],
        [{ id: 'ver-2' }],
      ]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { templateInputs: { to: [nextDestination], server: SERVER_ID } },
      });

      expect(response.statusCode).toBe(200);
      expect(getTemplateVersion).toHaveBeenCalledWith(TEMPLATE_ID, 1);
      const update = harness.updateSets[0] as {
        actions: AutomationActions;
        triggers: TriggerNode[];
        templateInputs: Record<string, unknown>;
      };
      const action = update.actions.actions[0];
      expect(action).toMatchObject({ type: 'send', to: [nextDestination] });
      expect(update.templateInputs).toEqual({ to: [nextDestination], server: SERVER_ID });
      // The node id the gate reads survives the rebind.
      expect(update.triggers[0]?.id).toBe(TRIGGER_ID);
      // Instance-owned fields are the instance's, whatever the template says.
      expect(update).not.toHaveProperty('name');
      expect(update).not.toHaveProperty('severity');
      expect(harness.inserts).toHaveLength(1);
    });

    it('400s templateInputs on an automation no template owns', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([automationRow()]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { templateInputs: { to: [randomUUID()] } },
      });

      expect(response.statusCode).toBe(400);
    });

    it('400s a rebind that leaves a required input unbound', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([boundRow()]);
      vi.mocked(getTemplateVersion).mockResolvedValue(templateVersion(1));

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { templateInputs: { server: SERVER_ID } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('to');
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  describe('PATCH definition invariants', () => {
    it('saves a list field compared with eq against one value', async () => {
      app = await buildTestApp(ownerUser);
      const nextConditions = {
        groups: [{ conditions: [{ field: 'country', operator: 'eq', value: 'US' }] }],
      };
      setupSelect([automationRow()]);
      setupTransaction([[automationRow({ conditions: nextConditions })], [{ id: 'ver-2' }]]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { conditions: nextConditions },
      });

      expect(response.statusCode).toBe(200);
    });

    it('400s a patch whose merged definition cannot run', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([automationRow()]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/automations/${AUTOMATION_ID}`,
        payload: { triggers: [{ id: randomUUID(), type: 'server.down', enabled: true }] },
      });

      // A policy is about a user, and a server trigger has none.
      expect(response.statusCode).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  describe('POST /automations/:id/detach', () => {
    it('clears the template columns and records where the automation came from', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([boundRow()]);
      const updateChain = queryChain(vi.fn, [
        { ...boundRow(), templateId: null, templateVersion: null },
      ]);
      vi.mocked(db.update as unknown as ReturnType<typeof vi.fn>).mockReturnValue(updateChain);

      const response = await app.inject({
        method: 'POST',
        url: `/automations/${AUTOMATION_ID}/detach`,
      });

      expect(response.statusCode).toBe(200);
      expect(updateChain.set.mock.calls[0]?.[0]).toMatchObject({
        templateId: null,
        templateVersion: null,
        templateInputs: null,
        originTemplateId: TEMPLATE_ID,
        originTemplateVersion: 1,
      });
      expect(invalidateAutomationsCache).toHaveBeenCalledTimes(1);
    });

    it('409s an automation that never had a template', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([automationRow()]);

      const response = await app.inject({
        method: 'POST',
        url: `/automations/${AUTOMATION_ID}/detach`,
      });

      expect(response.statusCode).toBe(409);
    });

    it('is owner only', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: `/automations/${AUTOMATION_ID}/detach`,
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('POST /automations/:id/upgrade', () => {
    it('rebinds the instance onto the current version, carrying the trigger ids', async () => {
      app = await buildTestApp(ownerUser);
      const stored = boundRow();
      setupSelect([stored], [{ id: SERVER_ID }]);
      vi.mocked(getTemplate).mockResolvedValue({
        id: TEMPLATE_ID,
        name: 'Stream started',
        version: templateVersion(3, editedDefinition()),
      } as never);
      const harness = setupTransaction([
        [
          {
            ...stored,
            templateVersion: 3,
            actions: {
              actions: [
                { id: randomUUID(), type: 'send', to: [DESTINATION_ID], title: 'Now playing' },
              ],
            },
          },
        ],
        [{ id: 'ver-2' }],
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/automations/${AUTOMATION_ID}/upgrade`,
        payload: { inputs: { to: [DESTINATION_ID], server: SERVER_ID } },
      });

      expect(response.statusCode).toBe(200);
      const update = harness.updateSets[0] as {
        templateVersion: number;
        templateInputs: Record<string, unknown>;
        triggers: TriggerNode[];
        actions: AutomationActions;
      };
      expect(update.templateVersion).toBe(3);
      expect(update.templateInputs).toEqual({ to: [DESTINATION_ID], server: SERVER_ID });
      expect(update.triggers[0]?.id).toBe(TRIGGER_ID);
      expect(update.actions.actions[0]).toMatchObject({ title: 'Now playing' });
      expect(harness.inserts).toHaveLength(1);
    });

    it('follows the kind the new version declares', async () => {
      app = await buildTestApp(ownerUser);
      const stored = boundRow();
      setupSelect([stored], [{ id: SERVER_ID }]);
      const definition = { ...editedDefinition(), kind: 'policy' as const };
      vi.mocked(getTemplate).mockResolvedValue({
        id: TEMPLATE_ID,
        name: 'Stream started',
        version: templateVersion(4, definition),
      } as never);
      const harness = setupTransaction([
        [{ ...stored, kind: 'policy', templateVersion: 4 }],
        [{ id: 'ver-2' }],
      ]);

      const response = await app.inject({
        method: 'POST',
        url: `/automations/${AUTOMATION_ID}/upgrade`,
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(harness.updateSets[0]).toMatchObject({ kind: 'policy' });
    });

    it('reuses the bindings the instance already had when the body names none', async () => {
      app = await buildTestApp(ownerUser);
      const stored = boundRow();
      setupSelect([stored], [{ id: SERVER_ID }]);
      vi.mocked(getTemplate).mockResolvedValue({
        id: TEMPLATE_ID,
        name: 'Stream started',
        version: templateVersion(2),
      } as never);
      const harness = setupTransaction([[stored], [{ id: 'ver-2' }]]);

      const response = await app.inject({
        method: 'POST',
        url: `/automations/${AUTOMATION_ID}/upgrade`,
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const update = harness.updateSets[0] as { templateInputs: Record<string, unknown> };
      expect(update.templateInputs).toEqual({ to: [DESTINATION_ID], server: SERVER_ID });
    });

    it('409s an automation that has no template to upgrade', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([automationRow()]);

      const response = await app.inject({
        method: 'POST',
        url: `/automations/${AUTOMATION_ID}/upgrade`,
        payload: {},
      });

      expect(response.statusCode).toBe(409);
    });

    it('is owner only', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: `/automations/${AUTOMATION_ID}/upgrade`,
        payload: {},
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('GET /automations/:id/export', () => {
    it('lifts this install out of the definition and seals it in a code', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([boundRow({ serverName: 'Plex' })]);

      const response = await app.inject({
        method: 'GET',
        url: `/automations/${AUTOMATION_ID}/export`,
      });

      expect(response.statusCode).toBe(200);
      const { envelope, code } = response.json();
      expect(templateEnvelopeSchema.safeParse(envelope).success).toBe(true);
      // The server the instance names is a suffix on screen, never in an export.
      expect(envelope.name).toBe('Stream started');
      expect(envelope.slug).toBe('stream-started');
      expect(envelope.group).toBe('notifications');
      expect(envelope.author).toBeUndefined();
      const [action] = envelope.definition.actions.actions;
      expect(action.to).toEqual({ $input: 'to' });
      expect(envelope.definition.scope.serverId).toEqual({ $input: 'server' });
      expect(
        decodeShareCode(
          code,
          (bytes, maxOut) => new Uint8Array(inflateRawSync(bytes, { maxOutputLength: maxOut }))
        )
      ).toEqual(envelope);
    });

    it('strips a server suffix the name was truncated in the middle of', async () => {
      app = await buildTestApp(ownerUser);
      const serverName = 'Basement rack '.repeat(7).trim();
      // The default instance name is cut at the column cap, taking the tail of the suffix with it.
      const name = `Stream started — ${serverName}`.slice(0, 100);
      expect(name.endsWith(` — ${serverName}`)).toBe(false);
      setupSelect([boundRow({ name, serverName })]);

      const response = await app.inject({
        method: 'GET',
        url: `/automations/${AUTOMATION_ID}/export`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().envelope.name).toBe('Stream started');
    });

    it('carries nothing but the envelope and the code it packs into', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([boundRow({ serverName: 'Plex' })]);

      const response = await app.inject({
        method: 'GET',
        url: `/automations/${AUTOMATION_ID}/export`,
      });

      const body = response.json();
      expect(Object.keys(body).sort()).toEqual(['code', 'envelope']);
      // Nothing this install can be identified by travels. Node ids do: they name
      // steps inside the definition and mean nothing anywhere else.
      const packed = JSON.stringify(body.envelope);
      for (const id of [DESTINATION_ID, SERVER_ID, AUTOMATION_ID, TEMPLATE_ID]) {
        expect(packed).not.toContain(id);
      }
      expect(packed).not.toContain('Plex');
    });

    it('carries the author the caller typed and exports a detached automation too', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([
        boundRow({
          templateId: null,
          templateVersion: null,
          templateInputs: null,
          originTemplateId: TEMPLATE_ID,
          originTemplateVersion: 1,
        }),
      ]);

      const response = await app.inject({
        method: 'GET',
        url: `/automations/${AUTOMATION_ID}/export?author=Ada`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().envelope.author).toBe('Ada');
    });

    it('takes the group the caller picked over the one the kind implies', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([boundRow({ serverName: 'Plex' })]);

      const response = await app.inject({
        method: 'GET',
        url: `/automations/${AUTOMATION_ID}/export?group=housekeeping`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().envelope.group).toBe('housekeeping');
    });

    it('400s a group that is not one of the four', async () => {
      app = await buildTestApp(ownerUser);
      setupSelect([boundRow()]);

      const response = await app.inject({
        method: 'GET',
        url: `/automations/${AUTOMATION_ID}/export?group=misc`,
      });

      expect(response.statusCode).toBe(400);
    });

    it.each([
      ['session.started', '2.2.0'],
      ['newsletter.failed', '2.3.0'],
    ])('stamps an export whose trigger is %s with %s', async (type, minServerVersion) => {
      app = await buildTestApp(ownerUser);
      setupSelect([
        boundRow({ serverId: null, triggers: [{ id: TRIGGER_ID, type, enabled: true }] }),
      ]);

      const response = await app.inject({
        method: 'GET',
        url: `/automations/${AUTOMATION_ID}/export`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().envelope.minServerVersion).toBe(minServerVersion);
    });

    it('404s an automation the caller cannot see', async () => {
      app = await buildTestApp(viewerUser);
      setupSelect([]);

      const response = await app.inject({
        method: 'GET',
        url: `/automations/${AUTOMATION_ID}/export`,
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
