import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import type { AuthUser } from '@tracearr/shared';
import type * as QueriesModule from '../queries.js';
import { queryChain, renderSql } from '../../../test/helpers.js';

vi.mock('../../../db/client.js', () => ({
  db: { select: vi.fn(), execute: vi.fn() },
}));

vi.mock('../queries.js', async (importActual) => ({
  ...(await importActual<typeof QueriesModule>()),
  resolveIdentityScopedServerUserIds: vi.fn(),
}));

import { db } from '../../../db/client.js';
import { resolveIdentityScopedServerUserIds } from '../queries.js';
import { sessionsRoutes } from '../sessions.js';
import { permissionGuard } from '../../../lib/scope.js';

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

  it('bounds the join back to sessions by the page window', async () => {
    const serverUserId = randomUUID();
    app = await buildTestApp();
    vi.mocked(resolveIdentityScopedServerUserIds).mockResolvedValue({
      ids: [serverUserId],
    } as never);
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, [{ count: 0 }]));
    vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);

    await app.inject({ method: 'GET', url: `/users/${serverUserId}/sessions` });

    const { sql: query } = renderSql(vi.mocked(db.execute).mock.calls.at(-1)![0] as SQL);
    expect(query.replace(/\s+/g, ' ')).toMatch(
      /s\.started_at = gs\.started_at AND s\.started_at >= \$\d+ AND s\.started_at <= \$\d+/
    );
  });
});
