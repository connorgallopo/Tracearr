/**
 * Automation run route tests
 *
 * The db is mocked: what this tier proves is the envelope, the predicates each
 * handler built, and the two-tier serialization — summaries never carry the step
 * log, the detail route always does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';
import { queryChain, renderCall, renderedJoins, renderSql } from '../../test/helpers.js';
import type { SQL } from 'drizzle-orm';

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn() },
}));

import { db } from '../../db/client.js';
import { runRoutes } from '../runs.js';
import { permissionGuard } from '../../lib/scope.js';

const RUN_ID = randomUUID();
const AUTOMATION_ID = randomUUID();

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    automationId: AUTOMATION_ID,
    automationName: 'kill long pauses',
    kind: 'policy',
    outcome: 'completed',
    humanSummary: null,
    severity: 'warning',
    serverUserId: 'su-1',
    sessionId: 's-1',
    serverId: 'srv-1',
    subjectKey: 's-1',
    serverName: 'Basement',
    accountName: 'ada@plex',
    accountThumbUrl: '/library/metadata/1/thumb',
    personName: 'Ada',
    personUsername: 'ada',
    itemTitle: null,
    itemMediaType: null,
    libraryName: null,
    ranActions: null,
    storedMediaTitle: null,
    storedIpAddress: null,
    startedAt: new Date('2026-08-20T10:00:00.000Z'),
    createdAt: new Date('2026-08-20T10:00:00.000Z'),
    finishedAt: new Date('2026-08-20T10:00:02.000Z'),
    acknowledgedAt: null,
    dismissedAt: null,
    ...overrides,
  };
}

/** The session row the detail route reads on its own, keyed off the run's session id. */
const SESSION_CONTEXT = {
  mediaTitle: 'The Bear',
  mediaType: 'episode',
  grandparentTitle: 'The Bear',
  player: 'Living Room TV',
  device: 'Apple TV',
  product: 'Plex for Apple TV',
  platform: 'tvOS',
  ipAddress: '10.0.0.9',
  city: 'Boston',
  country: 'United States',
  isLocal: false,
};

/** The run query, then the session lookup the detail route makes when it has one. */
function setupDetailMocks(row: unknown, session: unknown[] = [SESSION_CONTEXT]) {
  vi.mocked(db.select as unknown as ReturnType<typeof vi.fn>)
    .mockReturnValueOnce(queryChain(vi.fn, row === undefined ? [] : [row]))
    .mockReturnValue(queryChain(vi.fn, session));
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
  role: 'admin',
  serverIds: ['srv-1'],
};

const strandedViewer: AuthUser = {
  userId: randomUUID(),
  username: 'stranded',
  role: 'admin',
  serverIds: [],
};

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: unknown) => {
    (request as { user: AuthUser }).user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));
  await app.register(runRoutes, { prefix: '/runs' });
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

describe('Run routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    // Reset, not clear: an unconsumed mockReturnValueOnce would answer the next test's query.
    vi.resetAllMocks();
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('GET /runs', () => {
    it('returns summaries in the list envelope, with no step log', async () => {
      app = await buildTestApp(ownerUser);
      setupListMocks([runRow()], 1);

      const response = await app.inject({ method: 'GET', url: '/runs' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
      expect(body.data[0]).toEqual({
        id: RUN_ID,
        automationId: AUTOMATION_ID,
        automationName: 'kill long pauses',
        kind: 'policy',
        outcome: 'completed',
        humanSummary: null,
        severity: 'warning',
        serverUserId: 'su-1',
        sessionId: 's-1',
        serverId: 'srv-1',
        subjectKey: 's-1',
        subject: {
          kind: 'session',
          name: 'ada@plex',
          personName: 'Ada',
          thumbUrl: '/library/metadata/1/thumb',
          serverName: 'Basement',
          libraryName: null,
          mediaType: null,
        },
        ranActions: [],
        startedAt: '2026-08-20T10:00:00.000Z',
        finishedAt: '2026-08-20T10:00:02.000Z',
        acknowledgedAt: null,
        dismissedAt: null,
      });
    });

    it('says which actions ran, off a projection that leaves the step log behind', async () => {
      app = await buildTestApp(ownerUser);
      setupListMocks([runRow({ ranActions: ['kill_stream', 'send'] })], 1);

      const body = (await app.inject({ method: 'GET', url: '/runs' })).json();

      expect(body.data[0].ranActions).toEqual(['kill_stream', 'send']);
      expect(body.data[0].steps).toBeUndefined();

      const columns = vi.mocked(db.select as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as Record<string, SQL>;
      const projection = renderSql(columns.ranActions as SQL).sql.replace(/\s+/g, ' ');
      // Only steps that name an action and succeeded, so a failed kill never reads as one.
      expect(projection).toContain("jsonb_exists(step.elem, 'action')");
      expect(projection).toContain("(step.elem->>'success')::boolean");
      // Run order, not alphabetical: a DISTINCT aggregate would sort the words.
      expect(projection).toContain('ORDER BY step.ord');
      expect(projection).not.toContain('DISTINCT');
    });

    it('keeps a repeated action once, in the order the run first took it', async () => {
      app = await buildTestApp(ownerUser);
      setupListMocks([runRow({ ranActions: ['send', 'kill_stream', 'send'] })], 1);

      const body = (await app.inject({ method: 'GET', url: '/runs' })).json();

      expect(body.data[0].ranActions).toEqual(['send', 'kill_stream']);
    });

    it('falls back to the row timestamp for a run written before started_at existed', async () => {
      app = await buildTestApp(ownerUser);
      setupListMocks([runRow({ startedAt: null, finishedAt: null })], 1);

      const response = await app.inject({ method: 'GET', url: '/runs' });

      expect(response.json().data[0].startedAt).toBe('2026-08-20T10:00:00.000Z');
      expect(response.json().data[0].finishedAt).toBeNull();
    });

    it('filters on kind, outcome, automation and the date bounds', async () => {
      app = await buildTestApp(ownerUser);
      const { pageChain, countChain } = setupListMocks([], 0);

      const response = await app.inject({
        method: 'GET',
        url: `/runs?kind=notification&outcome=error&automationId=${AUTOMATION_ID}&startDate=2026-08-01&endDate=2026-08-15`,
      });

      expect(response.statusCode).toBe(200);
      const page = renderCall(pageChain);
      expect(page.text).toContain('automation_runs.kind = ');
      expect(page.text).toContain('automation_runs.outcome = ');
      expect(page.text).toContain('automation_runs.rule_id = ');
      expect(page.text).toContain('automation_runs.started_at >= ');
      expect(page.text).toContain('automation_runs.started_at < ');
      expect(page.params).toEqual([
        'notification',
        'error',
        AUTOMATION_ID,
        '2026-08-01T00:00:00.000Z',
        // The end bound is exclusive, so the day the caller named is included.
        '2026-08-16T00:00:00.000Z',
      ]);
      expect(renderCall(countChain).text).toBe(page.text);
    });

    it('counts over the joins the page selects from', async () => {
      app = await buildTestApp(ownerUser);
      const { pageChain, countChain } = setupListMocks([], 0);

      await app.inject({ method: 'GET', url: '/runs' });

      // A filter on an automations column would throw against a FROM that omits the join.
      expect(renderedJoins(pageChain)).toEqual(['automation_runs.rule_id = automations.id']);
      expect(renderedJoins(countChain)).toEqual(renderedJoins(pageChain));
    });

    it('reads the names off the run ids rather than a second query per row', async () => {
      app = await buildTestApp(ownerUser);
      const { pageChain } = setupListMocks([], 0);

      await app.inject({ method: 'GET', url: '/runs' });

      expect(renderedJoins(pageChain, 'leftJoin')).toEqual([
        'servers.id = automation_runs.server_id',
        'server_users.id = automation_runs.server_user_id',
        'users.id = server_users.user_id',
        'library_items.id = CASE WHEN automation_runs.subject_key LIKE $1 THEN substring(automation_runs.subject_key FROM $2::int)::uuid END',
        '(libraries.server_id = library_items.server_id and libraries.library_id = library_items.library_id)',
      ]);
    });

    it('names the library item a media run was about, and no account behind it', async () => {
      app = await buildTestApp(ownerUser);
      setupListMocks(
        [
          runRow({
            serverUserId: null,
            sessionId: null,
            accountName: null,
            personName: null,
            personUsername: null,
            subjectKey: 'media:11111111-1111-4111-8111-111111111111',
            itemTitle: 'Dune',
            itemMediaType: 'movie',
            libraryName: 'Movies',
          }),
        ],
        1
      );

      const response = await app.inject({ method: 'GET', url: '/runs' });

      expect(response.json().data[0].subject).toEqual({
        kind: 'media',
        name: 'Dune',
        personName: null,
        thumbUrl: null,
        serverName: 'Basement',
        libraryName: 'Movies',
        mediaType: 'movie',
      });
    });

    it('attributes a server run to its server and nobody else', async () => {
      app = await buildTestApp(ownerUser);
      setupListMocks(
        [
          runRow({
            kind: 'notification',
            serverUserId: null,
            sessionId: null,
            accountName: null,
            personName: null,
            personUsername: null,
            accountThumbUrl: null,
            subjectKey: 'server:srv-1',
          }),
        ],
        1
      );

      const response = await app.inject({ method: 'GET', url: '/runs' });

      expect(response.json().data[0].subject).toEqual({
        kind: 'server',
        name: null,
        personName: null,
        thumbUrl: null,
        serverName: 'Basement',
        libraryName: null,
        mediaType: null,
      });
    });

    it('reads an install-wide run as belonging to no server', async () => {
      app = await buildTestApp(ownerUser);
      setupListMocks(
        [
          runRow({
            kind: 'notification',
            serverId: null,
            serverName: null,
            serverUserId: null,
            sessionId: null,
            accountName: null,
            personName: null,
            personUsername: null,
            accountThumbUrl: null,
            subjectKey: 'install',
          }),
        ],
        1
      );

      const response = await app.inject({ method: 'GET', url: '/runs' });

      expect(response.json().data[0].subject).toEqual({
        kind: 'install',
        name: null,
        personName: null,
        thumbUrl: null,
        serverName: null,
        libraryName: null,
        mediaType: null,
      });
    });

    it('reads an hourly account run as being about the account', async () => {
      app = await buildTestApp(ownerUser);
      setupListMocks([runRow({ sessionId: null, subjectKey: 'su-1' })], 1);

      const response = await app.inject({ method: 'GET', url: '/runs' });

      expect(response.json().data[0].subject.kind).toBe('account');
      expect(response.json().data[0].subject.name).toBe('ada@plex');
    });

    it('falls back to the account username when the identity has no display name', async () => {
      app = await buildTestApp(ownerUser);
      setupListMocks([runRow({ personName: null })], 1);

      expect(
        (await app.inject({ method: 'GET', url: '/runs' })).json().data[0].subject
      ).toMatchObject({ personName: 'ada' });
    });

    it('names nobody when the account behind a run has been purged', async () => {
      app = await buildTestApp(ownerUser);
      setupListMocks(
        [
          runRow({
            accountName: null,
            accountThumbUrl: null,
            personName: null,
            personUsername: null,
            serverName: null,
          }),
        ],
        1
      );

      const response = await app.inject({ method: 'GET', url: '/runs' });

      expect(response.json().data[0].subject).toEqual({
        kind: 'session',
        name: null,
        personName: null,
        thumbUrl: null,
        serverName: null,
        libraryName: null,
        mediaType: null,
      });
    });

    it('defaults to newest first, tiebroken on the run id', async () => {
      app = await buildTestApp(ownerUser);
      const { pageChain } = setupListMocks([], 0);

      await app.inject({ method: 'GET', url: '/runs' });

      expect(renderCall(pageChain, 'orderBy').text).toBe(
        'automation_runs.started_at DESC NULLS LAST, automation_runs.id ASC'
      );
    });

    it('rejects a sort field that is not whitelisted', async () => {
      app = await buildTestApp(ownerUser);
      setupListMocks([], 0);

      const response = await app.inject({ method: 'GET', url: '/runs?orderBy=humanSummary' });

      expect(response.statusCode).toBe(400);
    });

    it('scopes a viewer by the server the run was recorded against', async () => {
      app = await buildTestApp(viewerUser);
      const { pageChain } = setupListMocks([], 0);

      await app.inject({ method: 'GET', url: '/runs' });

      const page = renderCall(pageChain);
      expect(page.text).toContain('automation_runs.server_id = ');
      expect(page.params).toContain('srv-1');
    });

    it('leaves an owner unfiltered, so install-wide runs stay readable', async () => {
      app = await buildTestApp(ownerUser);
      const { pageChain } = setupListMocks([], 0);

      await app.inject({ method: 'GET', url: '/runs' });

      expect(pageChain.where.mock.calls[0]?.[0]).toBeUndefined();
    });

    it('answers an empty page for a caller with no servers, without querying', async () => {
      app = await buildTestApp(strandedViewer);

      const response = await app.inject({ method: 'GET', url: '/runs' });

      expect(response.json()).toEqual({ data: [], meta: { page: 1, pageSize: 20, total: 0 } });
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('GET /runs/counts', () => {
    it('groups the outcomes and names the newest run that did something', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(db.select as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
        queryChain(vi.fn, [
          { outcome: 'completed', total: 12, newest: new Date('2026-08-20T10:00:00.000Z') },
          {
            outcome: 'stopped_by_condition',
            total: 340,
            newest: new Date('2026-08-21T09:00:00.000Z'),
          },
        ])
      );

      const response = await app.inject({ method: 'GET', url: '/runs/counts' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        completed: 12,
        stopped_by_condition: 340,
        error: 0,
        total: 352,
        lastRunAt: '2026-08-20T10:00:00.000Z',
      });
    });

    it("takes the same filters as the page, and the caller's own servers", async () => {
      app = await buildTestApp(viewerUser);
      const chain = queryChain(vi.fn, []);
      vi.mocked(db.select as unknown as ReturnType<typeof vi.fn>).mockReturnValue(chain);

      const response = await app.inject({
        method: 'GET',
        url: `/runs/counts?automationId=${AUTOMATION_ID}&startDate=2026-08-01`,
      });

      expect(response.statusCode).toBe(200);
      const where = renderCall(chain);
      expect(where.text).toContain('automation_runs.rule_id = ');
      expect(where.text).toContain('automation_runs.started_at >= ');
      expect(where.text).toContain('automation_runs.server_id = ');
      expect(where.params).toContain('srv-1');
      expect(renderedJoins(chain)).toEqual(['automation_runs.rule_id = automations.id']);
    });

    it('answers zeros for a caller with no servers, without querying', async () => {
      app = await buildTestApp(strandedViewer);

      const response = await app.inject({ method: 'GET', url: '/runs/counts' });

      expect(response.json()).toEqual({
        completed: 0,
        stopped_by_condition: 0,
        error: 0,
        total: 0,
        lastRunAt: null,
      });
      expect(db.select).not.toHaveBeenCalled();
    });

    it('400s on a filter it does not take', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({ method: 'GET', url: '/runs/counts?outcome=nope' });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /runs/:id', () => {
    it('carries the step log and the version the run evaluated', async () => {
      app = await buildTestApp(ownerUser);
      const steps = [{ trigger: { type: 'session.started' } }, { action: 'kill_stream' }];
      setupDetailMocks({ ...runRow(), steps, definitionVersionId: 'ver-2' });

      const response = await app.inject({ method: 'GET', url: `/runs/${RUN_ID}` });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.steps).toEqual(steps);
      expect(body.definitionVersionId).toBe('ver-2');
      expect(body.id).toBe(RUN_ID);
    });

    it('carries what was playing and every condition the run weighed', async () => {
      app = await buildTestApp(ownerUser);
      const evidence = [
        {
          groupIndex: 0,
          matched: true,
          conditions: [
            { field: 'concurrent_streams', operator: 'gt', threshold: 2, actual: 3, matched: true },
          ],
        },
      ];
      setupDetailMocks({ ...runRow(), steps: [], evidence, definitionVersionId: 'ver-2' });

      const body = (await app.inject({ method: 'GET', url: `/runs/${RUN_ID}` })).json();

      expect(body.session).toEqual(SESSION_CONTEXT);
      expect(body.evidence).toEqual(evidence);
    });

    it('carries the media ids of what was playing', async () => {
      app = await buildTestApp(ownerUser);
      setupDetailMocks({ ...runRow(), steps: [], definitionVersionId: null }, [
        { ...SESSION_CONTEXT, mediaId: 'ep-1', showMediaId: 'show-1' },
      ]);

      const body = (await app.inject({ method: 'GET', url: `/runs/${RUN_ID}` })).json();

      expect(vi.mocked(db.select).mock.calls[1]![0]).toMatchObject({
        mediaId: expect.anything(),
        showMediaId: expect.anything(),
      });
      expect(body.session.mediaId).toBe('ep-1');
      expect(body.session.showMediaId).toBe('show-1');
    });

    it('reports no session context for a run that was never about one', async () => {
      app = await buildTestApp(ownerUser);
      setupDetailMocks({
        ...runRow({ sessionId: null, subjectKey: 'install' }),
        steps: [],
        evidence: null,
        definitionVersionId: null,
      });

      const body = (await app.inject({ method: 'GET', url: `/runs/${RUN_ID}` })).json();

      expect(body.session).toBeNull();
      expect(body.evidence).toEqual([]);
      // The run named no session, so nothing went looking for one.
      expect(db.select).toHaveBeenCalledOnce();
    });

    it('falls back to what the run stamped on itself when the session row is gone', async () => {
      app = await buildTestApp(ownerUser);
      setupDetailMocks(
        {
          ...runRow(),
          steps: [],
          storedMediaTitle: 'The Bear',
          storedIpAddress: '10.0.0.9',
          definitionVersionId: null,
        },
        []
      );

      const body = (await app.inject({ method: 'GET', url: `/runs/${RUN_ID}` })).json();

      expect(body.session).toEqual({
        mediaTitle: 'The Bear',
        mediaType: null,
        grandparentTitle: null,
        player: null,
        device: null,
        product: null,
        platform: null,
        ipAddress: '10.0.0.9',
        city: null,
        country: null,
        isLocal: false,
        mediaId: null,
        showMediaId: null,
      });
      expect(body.subject.name).toBe('ada@plex');
    });

    it('reports no session context when neither the row nor the run kept any', async () => {
      app = await buildTestApp(ownerUser);
      setupDetailMocks({ ...runRow(), steps: [], definitionVersionId: null }, []);

      const body = (await app.inject({ method: 'GET', url: `/runs/${RUN_ID}` })).json();

      expect(body.session).toBeNull();
    });

    it('reports no evidence for a run whose data never held an array', async () => {
      app = await buildTestApp(ownerUser);
      setupDetailMocks({ ...runRow(), steps: [], evidence: {}, definitionVersionId: null });

      expect((await app.inject({ method: 'GET', url: `/runs/${RUN_ID}` })).json().evidence).toEqual(
        []
      );
    });

    it('reports an empty step log rather than null', async () => {
      app = await buildTestApp(ownerUser);
      setupDetailMocks({ ...runRow(), steps: null, definitionVersionId: null });

      const response = await app.inject({ method: 'GET', url: `/runs/${RUN_ID}` });

      expect(response.json().steps).toEqual([]);
    });

    it('404s when there is no such run', async () => {
      app = await buildTestApp(ownerUser);
      setupDetailMocks(undefined);

      const response = await app.inject({ method: 'GET', url: `/runs/${RUN_ID}` });

      expect(response.statusCode).toBe(404);
    });

    it('400s on an id that is not a uuid', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({ method: 'GET', url: '/runs/not-a-uuid' });

      expect(response.statusCode).toBe(400);
    });
  });
});
