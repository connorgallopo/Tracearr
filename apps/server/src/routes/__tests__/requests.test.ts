import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';
import type { SQL } from 'drizzle-orm';
import type { RequestsAnalyticsData } from '../../services/requests/analytics.js';
import type * as WatchedLenses from '../../services/requests/watchedLenses.js';
import { queryChain, renderSql } from '../../test/helpers.js';

const { scopeRedis } = vi.hoisted(() => ({ scopeRedis: { get: vi.fn(), set: vi.fn() } }));

vi.mock('../../services/requests/analytics.js', () => ({ getRequestsAnalytics: vi.fn() }));
vi.mock('../../services/requests/store.js', () => ({ anyRequestServiceLinked: vi.fn() }));
vi.mock('../../db/client.js', () => ({ db: { execute: vi.fn(), select: vi.fn() } }));
vi.mock('../../lib/redisShared.js', () => ({ getRedis: () => scopeRedis }));
vi.mock('../../services/settings.js', () => ({ getSetting: vi.fn(async () => null) }));
vi.mock('../../services/requests/watchedLenses.js', async (importOriginal) => ({
  ...(await importOriginal<typeof WatchedLenses>()),
  watchedStatesFor: vi.fn(async () => new Map()),
}));

import { db } from '../../db/client.js';

import { getRequestsAnalytics } from '../../services/requests/analytics.js';
import { anyRequestServiceLinked } from '../../services/requests/store.js';
import { requestRoutes } from '../requests.js';
import { permissionGuard } from '../../lib/scope.js';

const SERVER_ID = '0c1f1c5a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_SERVER_ID = '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a';

function emptyData(): RequestsAnalyticsData {
  return {
    funnel: { requested: 0, landed: 0, watched: 0 },
    unplayed: [],
    unplayedBytes: 0,
    requesters: [],
  };
}

function createSpyRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _seconds: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
  };
}

async function buildTestApp(
  authUser: AuthUser,
  redis: ReturnType<typeof createSpyRedis>
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('redis', redis as never);
  await app.register(requestRoutes, { prefix: '/requests' });
  return app;
}

function owner(): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
}

function admin(serverIds: string[]): AuthUser {
  return { userId: randomUUID(), username: 'admin', role: 'admin', serverIds };
}

describe('GET /requests/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports no Seerr when nothing is linked', async () => {
    vi.mocked(anyRequestServiceLinked).mockResolvedValue(false);
    const app = await buildTestApp(owner(), createSpyRedis());

    const response = await app.inject({ method: 'GET', url: '/requests/status' });

    expect(response.json()).toEqual({ configured: false });
  });

  it('answers a non-owner too, since the nav entry depends on it', async () => {
    vi.mocked(anyRequestServiceLinked).mockResolvedValue(true);
    const app = await buildTestApp(admin([SERVER_ID]), createSpyRedis());

    const response = await app.inject({ method: 'GET', url: '/requests/status' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: true });
  });
});

function outcome(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    mediaId: `media-${id}`,
    mediaType: 'movie' as const,
    title: id,
    year: 2024,
    requestedAt: '2026-01-01T00:00:00.000Z',
    availableAt: '2026-01-01T01:00:00.000Z',
    waitMs: 3_600_000,
    seasons: null,
    fileSizeBytes: 0,
    requester: {
      serverUserId: null,
      userId: null,
      serverId: SERVER_ID,
      username: id,
      identityName: null,
      thumb: null,
      thumbServerId: null,
    },
    ...over,
  };
}

function requester(username: string, over: Record<string, unknown> = {}) {
  return {
    requester: {
      serverUserId: null,
      userId: null,
      serverId: SERVER_ID,
      username,
      identityName: null,
      thumb: null,
      thumbServerId: null,
    },
    requested: 1,
    landed: 1,
    watched: 0,
    watchedByOthers: 0,
    medianWaitMs: null,
    ...over,
  };
}

describe('GET /requests/unplayed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sorts the whole set, not just the page it returns', async () => {
    vi.mocked(getRequestsAnalytics).mockResolvedValue({
      ...emptyData(),
      unplayed: [
        outcome('small', { fileSizeBytes: 1 }),
        outcome('big', { fileSizeBytes: 900 }),
        outcome('mid', { fileSizeBytes: 50 }),
      ],
    });
    const app = await buildTestApp(owner(), createSpyRedis());

    const response = await app.inject({
      method: 'GET',
      url: '/requests/unplayed?pageSize=1&sortBy=fileSizeBytes&sortOrder=desc',
    });

    const body = response.json() as { data: { id: string }[]; total: number };
    expect(body.data.map((row) => row.id)).toEqual(['big']);
    expect(body.total).toBe(3);
  });

  it('returns the second page of the sorted set', async () => {
    vi.mocked(getRequestsAnalytics).mockResolvedValue({
      ...emptyData(),
      unplayed: [
        outcome('small', { fileSizeBytes: 1 }),
        outcome('big', { fileSizeBytes: 900 }),
        outcome('mid', { fileSizeBytes: 50 }),
      ],
    });
    const app = await buildTestApp(owner(), createSpyRedis());

    const response = await app.inject({
      method: 'GET',
      url: '/requests/unplayed?page=2&pageSize=1&sortBy=fileSizeBytes&sortOrder=desc',
    });

    expect((response.json() as { data: { id: string }[] }).data.map((r) => r.id)).toEqual(['mid']);
  });

  it('rejects a sort field that is not in the contract', async () => {
    const app = await buildTestApp(owner(), createSpyRedis());

    const response = await app.inject({ method: 'GET', url: '/requests/unplayed?sortBy=secrets' });

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /requests/requesters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to the people who watched the most of what they asked for', async () => {
    vi.mocked(getRequestsAnalytics).mockResolvedValue({
      ...emptyData(),
      requesters: [
        requester('quiet', { watched: 0 }),
        requester('popular', { watched: 9 }),
        requester('middling', { watched: 4 }),
      ],
    });
    const app = await buildTestApp(owner(), createSpyRedis());

    const response = await app.inject({ method: 'GET', url: '/requests/requesters' });

    const body = response.json() as { data: { requester: { username: string } }[] };
    expect(body.data.map((row) => row.requester.username)).toEqual([
      'popular',
      'middling',
      'quiet',
    ]);
  });

  it('puts a person with no median wait last whichever way the column is sorted', async () => {
    vi.mocked(getRequestsAnalytics).mockResolvedValue({
      ...emptyData(),
      requesters: [
        requester('nowait', { medianWaitMs: null }),
        requester('fast', { medianWaitMs: 10 }),
        requester('slow', { medianWaitMs: 900 }),
      ],
    });
    const app = await buildTestApp(owner(), createSpyRedis());

    const asc = await app.inject({
      method: 'GET',
      url: '/requests/requesters?sortBy=medianWaitMs&sortOrder=asc',
    });
    const desc = await app.inject({
      method: 'GET',
      url: '/requests/requesters?sortBy=medianWaitMs&sortOrder=desc',
    });

    const names = (r: typeof asc) =>
      (r.json() as { data: { requester: { username: string } }[] }).data.map(
        (row) => row.requester.username
      );
    expect(names(asc)).toEqual(['fast', 'slow', 'nowait']);
    expect(names(desc)).toEqual(['slow', 'fast', 'nowait']);
  });
});

describe('GET /requests/analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRequestsAnalytics).mockResolvedValue(emptyData());
  });

  it('rejects a serverIds value that is not a uuid', async () => {
    const app = await buildTestApp(owner(), createSpyRedis());

    const response = await app.inject({ method: 'GET', url: '/requests/analytics?serverIds=nope' });

    expect(response.statusCode).toBe(400);
    expect(getRequestsAnalytics).not.toHaveBeenCalled();
  });

  it('narrows an admin to their own servers even when they ask for another', async () => {
    const app = await buildTestApp(admin([SERVER_ID]), createSpyRedis());

    const response = await app.inject({
      method: 'GET',
      url: `/requests/analytics?serverIds=${OTHER_SERVER_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(getRequestsAnalytics).toHaveBeenCalledWith([], 'all', true);
  });

  it('serves the second request from cache', async () => {
    const redis = createSpyRedis();
    const app = await buildTestApp(owner(), redis);

    await app.inject({ method: 'GET', url: '/requests/analytics' });
    const second = await app.inject({ method: 'GET', url: '/requests/analytics' });

    expect(second.statusCode).toBe(200);
    expect(getRequestsAnalytics).toHaveBeenCalledTimes(1);
  });

  it('caches each server scope separately', async () => {
    const redis = createSpyRedis();
    const app = await buildTestApp(owner(), redis);

    await app.inject({ method: 'GET', url: '/requests/analytics' });
    await app.inject({ method: 'GET', url: `/requests/analytics?serverIds=${SERVER_ID}` });

    expect(getRequestsAnalytics).toHaveBeenCalledTimes(2);
  });
});

describe('GET /requests/mine', () => {
  const OWN = '22222222-2222-4222-8222-222222222222';
  const member: AuthUser = { userId: 'u-member', username: 'mia', role: 'member', serverIds: [] };
  const requestRow = {
    id: 'req-1',
    server_id: SERVER_ID,
    media_id: 'media-1',
    media_type: 'movie',
    title: 'Arrival',
    year: 2016,
    status: 'completed',
    requested_at: '2026-10-01T00:00:00.000Z',
    available_at: '2026-10-05T00:00:00.000Z',
    deleted_at: null,
    seasons: null,
    is_4k: false,
    is_auto_request: false,
    lens_user_id: 'u-member',
    poster_server_id: SERVER_ID,
    poster_thumb_path: '/library/metadata/1/thumb/1',
  };
  const summaryRow = {
    total: 1,
    completed: 1,
    approved_or_completed: 1,
    decided: 1,
    median_wait_ms: 345_600_000,
    available_this_week: 1,
  };
  // uuidArraySql inlines the account ids into the text, so the text is what names them.
  const sentQueries = () =>
    vi.mocked(db.execute).mock.calls.map((call) => renderSql(call[0] as SQL).sql);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [requestRow] } as never)
      .mockResolvedValueOnce({ rows: [summaryRow] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
  });

  it("lists only a member's own requests, with the poster through the image proxy", async () => {
    scopeRedis.get.mockResolvedValue(
      JSON.stringify({ serverUserIds: [OWN], serverIds: [SERVER_ID] })
    );
    const app = await buildTestApp(member, createSpyRedis());

    const body = (await app.inject({ url: '/requests/mine?page=1&pageSize=4' })).json();

    expect(sentQueries()).toHaveLength(3);
    for (const text of sentQueries()) expect(text).toContain(`'${OWN}'::uuid`);
    expect(body.data[0].media.posterUrl).toMatch(/^\/api\/v1\/images\/proxy\?/);
    expect(body.data[0].media.posterUrl).toContain(`server=${SERVER_ID}`);
    expect(body.summary.availableThisWeek).toBe(1);
  });

  it("lists the owner's own accounts, not everyone's", async () => {
    const ownerAccount = '33333333-3333-4333-8333-333333333333';
    vi.mocked(db.select).mockReturnValue(
      queryChain(vi.fn, [{ id: ownerAccount, serverId: SERVER_ID }])
    );
    const app = await buildTestApp(owner(), createSpyRedis());

    await app.inject({ url: '/requests/mine' });

    expect(sentQueries()).toHaveLength(3);
    for (const text of sentQueries()) expect(text).toContain(`'${ownerAccount}'::uuid`);
  });

  it('answers zeros without a query for a member with no accounts', async () => {
    scopeRedis.get.mockResolvedValue(JSON.stringify({ serverUserIds: [], serverIds: [] }));
    const app = await buildTestApp(member, createSpyRedis());

    const body = (await app.inject({ url: '/requests/mine' })).json();

    expect(body.total).toBe(0);
    expect(body.summary.availableThisWeek).toBe(0);
    expect(db.execute).not.toHaveBeenCalled();
  });
});
