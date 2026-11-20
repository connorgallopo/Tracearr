import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import type { AuthUser } from '@tracearr/shared';
import type * as QueriesModule from '../queries/index.js';
import { PROFILE_TEST_SERVERS, queryChain, renderCall, renderSql } from '../../../test/helpers.js';

vi.mock('../../../db/client.js', () => ({
  db: { select: vi.fn(), execute: vi.fn() },
}));

vi.mock('../../../jobs/poller/database.js', async (importOriginal) =>
  (await import('../../../test/helpers.js')).withProfileTestServerTypes(importOriginal)
);

vi.mock('../queries/index.js', async (importActual) => ({
  ...(await importActual<typeof QueriesModule>()),
  resolveIdentityScopedServerUserIds: vi.fn(),
}));

import { db } from '../../../db/client.js';
import { resolveIdentityScopedServerUserIds } from '../queries/index.js';
import { sessionsRoutes } from '../sessions.js';
import { permissionGuard } from '../../../lib/scope.js';

const { plex: PLEX_SERVER, tofa: TOFA_SERVER } = PROFILE_TEST_SERVERS;

async function buildTestApp(): Promise<FastifyInstance> {
  const authUser: AuthUser = {
    userId: randomUUID(),
    username: 'owner',
    role: 'owner',
    serverIds: [],
  };
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: any) => {
    request.user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));
  await app.register(sessionsRoutes, { prefix: '/users' });
  return app;
}

describe('GET /users/:id/sessions', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('returns the media ids on each row', async () => {
    const serverUserId = randomUUID();
    const mediaId = randomUUID();
    const showMediaId = randomUUID();
    app = await buildTestApp();

    vi.mocked(resolveIdentityScopedServerUserIds).mockResolvedValue({
      ids: [serverUserId],
      serverIds: [PLEX_SERVER],
    } as never);
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, [{ count: 1 }]));
    vi.mocked(db.execute).mockResolvedValue({
      rows: [
        { id: randomUUID(), segment_count: '1', media_id: mediaId, show_media_id: showMediaId },
      ],
    } as never);

    const response = await app.inject({ method: 'GET', url: `/users/${serverUserId}/sessions` });

    const { sql: query } = renderSql(vi.mocked(db.execute).mock.calls[0]![0] as SQL);
    expect(query).toContain('s.media_id,');
    expect(query).toContain('s.show_media_id,');
    const [row] = response.json().data;
    expect(row.mediaId).toBe(mediaId);
    expect(row.showMediaId).toBe(showMediaId);
  });

  it("counts and pages only the profiles' plays, on their accounts", async () => {
    const serverUserId = randomUUID();
    const profileId = randomUUID();
    app = await buildTestApp();
    vi.mocked(resolveIdentityScopedServerUserIds).mockResolvedValue({
      serverUser: { id: serverUserId, serverId: TOFA_SERVER, userId: randomUUID() },
      ids: [serverUserId],
      serverIds: [TOFA_SERVER],
    });
    const totals = queryChain(vi.fn, [{ totalSessions: 0, totalWatchTime: 0 }]);
    vi.mocked(db.select).mockReturnValue(totals);
    vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);

    await app.inject({
      method: 'GET',
      url: `/users/${serverUserId}/sessions?profileIds=${profileId}`,
    });

    const page = renderSql(vi.mocked(db.execute).mock.calls[0]?.[0] as SQL);
    const pair = (alias: string) =>
      `${alias}.profile_id = ANY($#::uuid[]) AND ${alias}.server_user_id IN (SELECT server_user_id FROM server_profiles WHERE id = ANY($#::uuid[]))`;
    expect(renderCall(totals).text.replace(/\$\d+/g, '$#')).toContain(pair('sessions'));
    expect(page.sql.replace(/\$\d+/g, '$#')).toContain(pair('s'));
    expect(page.params).toContainEqual([profileId]);
  });

  it('bounds the join back to sessions by the page window', async () => {
    const serverUserId = randomUUID();
    app = await buildTestApp();
    vi.mocked(resolveIdentityScopedServerUserIds).mockResolvedValue({
      ids: [serverUserId],
      serverIds: [PLEX_SERVER],
    } as never);
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, [{ count: 0 }]));
    vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);

    await app.inject({ method: 'GET', url: `/users/${serverUserId}/sessions` });

    const { sql: query } = renderSql(vi.mocked(db.execute).mock.calls.at(-1)![0] as SQL);
    const join = query
      .replace(/\s+/g, ' ')
      .match(/JOIN sessions s ON s\.id = gs\.first_session_id.*?JOIN servers/)?.[0];
    expect(join).toMatch(/s\.started_at >= \$\d+/);
    expect(join).toMatch(/s\.started_at <= \$\d+/);
  });

  it('reads the profile columns only for accounts on a server with profiles', async () => {
    const serverUserId = randomUUID();
    app = await buildTestApp();
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, [{ count: 0 }]));
    vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);
    const pageFor = async (serverId: string) => {
      vi.mocked(resolveIdentityScopedServerUserIds).mockResolvedValue({
        serverUser: { id: serverUserId, serverId, userId: randomUUID() },
        ids: [serverUserId],
        serverIds: [serverId],
      });
      await app.inject({ method: 'GET', url: `/users/${serverUserId}/sessions` });
      return renderSql(vi.mocked(db.execute).mock.calls.at(-1)?.[0] as SQL).sql;
    };

    const plex = await pageFor(PLEX_SERVER);
    expect(plex).toContain('NULL::uuid AS profile_id, NULL::text AS profile_name');
    expect(plex).not.toContain('s.profile_id');

    expect(await pageFor(TOFA_SERVER)).toContain('s.profile_id, s.profile_name');
  });
});
