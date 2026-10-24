/**
 * GET /library/status with db.execute mocked: which item and snapshot predicates reach the
 * SQL for a member limited to some libraries, and for an owner.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { SQL } from 'drizzle-orm';
import type { AuthUser } from '@tracearr/shared';
import { renderSql } from '../../../test/helpers.js';

const { scopeRedis } = vi.hoisted(() => ({ scopeRedis: { get: vi.fn(), set: vi.fn() } }));

vi.mock('../../../db/client.js', () => ({ db: { execute: vi.fn() } }));
vi.mock('../../../lib/redisShared.js', () => ({ getRedis: () => scopeRedis }));
vi.mock('../../../jobs/maintenanceQueue.js', () => ({
  isMaintenanceJobRunning: vi.fn(async () => ({ isRunning: false, state: null })),
}));
vi.mock('../../../jobs/librarySyncQueue.js', () => ({
  getLibrarySyncStatus: vi.fn(async () => null),
}));

import { db } from '../../../db/client.js';
import { permissionGuard } from '../../../lib/scope.js';
import { libraryStatusRoute } from '../status.js';

const SERVER = '33333333-3333-4333-8333-333333333333';

async function statusSql(user: AuthUser, url: string): Promise<string[]> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = user;
  });
  app.decorate('requirePermission', permissionGuard(app));
  await app.register(libraryStatusRoute, { prefix: '/library' });
  const response = await app.inject({ method: 'GET', url });
  await app.close();
  expect(response.statusCode).toBe(200);
  return vi
    .mocked(db.execute)
    .mock.calls.map((call) => renderSql(call[0] as SQL).sql)
    .filter((text) => text.includes('library_stats_daily'));
}

describe('GET /library/status', () => {
  beforeEach(() => {
    vi.mocked(db.execute).mockReset();
    vi.mocked(db.execute).mockResolvedValue({ rows: [{}] } as never);
    scopeRedis.get.mockResolvedValue(
      JSON.stringify({
        serverUserIds: [randomUUID()],
        serverIds: [SERVER],
        libraryIds: { [SERVER]: ['lib-1'] },
      })
    );
  });

  it.each([`/library/status?serverId=${SERVER}`, '/library/status'])(
    "limits %s to the member's libraries",
    async (url) => {
      const member: AuthUser = {
        userId: randomUUID(),
        username: 'mia',
        role: 'member',
        serverIds: [],
      };
      const [text] = await statusSql(member, url);
      expect(text).toContain('li.library_id IN');
      expect(text).toContain('lsd.library_id IN');
    }
  );

  it.each([`/library/status?serverId=${SERVER}`, '/library/status'])(
    'scopes %s by server only for an owner',
    async (url) => {
      const owner: AuthUser = {
        userId: randomUUID(),
        username: 'owner',
        role: 'owner',
        serverIds: [],
      };
      const [text] = await statusSql(owner, url);
      expect(text).toContain('library_stats_daily');
      expect(text).not.toContain('library_id');
    }
  );
});
