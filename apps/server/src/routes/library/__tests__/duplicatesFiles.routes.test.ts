/**
 * Duplicate file existence route tests
 *
 * db.execute and the media server client are both mocked: what matters here is
 * the scope filter on the lookup, the shape handed back to the page, and that
 * a server which cannot answer never produces a "missing" verdict.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, DuplicateFilesResponse } from '@tracearr/shared';

vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
  },
}));

vi.mock('../../../services/mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(),
}));

import { db } from '../../../db/client.js';
import { createMediaServerClient } from '../../../services/mediaServer/index.js';
import { libraryDuplicateFilesRoute } from '../duplicatesFiles.js';
import { permissionGuard } from '../../../lib/scope.js';
import { fakeJellyfinClient, fakePlexClient } from '../../../test/mediaServerFakes.js';

const mockCreateClient = vi.mocked(createMediaServerClient);

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
  await app.register(libraryDuplicateFilesRoute, { prefix: '/library' });
  return app;
}

const SERVER_A = randomUUID();
const ITEM_A = randomUUID();

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_A,
    rating_key: '2733',
    server_id: SERVER_A,
    server_type: 'plex',
    server_url: 'http://plex.local:32400',
    server_token: 'tok',
    server_historical_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /library/duplicates/files', () => {
  it('reports each version the server answered for', async () => {
    vi.mocked(db.execute).mockResolvedValue({ rows: [itemRow()] } as never);
    const checkFilesExist = vi.fn().mockResolvedValue(
      new Map([
        [
          '2733',
          new Map([
            ['42858', true],
            ['42859', false],
          ]),
        ],
      ])
    );
    mockCreateClient.mockReturnValue(fakePlexClient({ checkFilesExist }));

    const app = await buildTestApp(
      { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] },
      createSpyRedis()
    );
    const res = await app.inject({ url: `/library/duplicates/files?itemIds=${ITEM_A}` });

    expect(res.statusCode).toBe(200);
    expect(checkFilesExist).toHaveBeenCalledWith(['2733']);
    expect(res.json<DuplicateFilesResponse>()).toEqual({
      checked: true,
      files: [
        { itemId: ITEM_A, serverVersionKey: '42858', exists: true },
        { itemId: ITEM_A, serverVersionKey: '42859', exists: false },
      ],
    });
  });

  it('scopes the lookup to the servers the caller can see', async () => {
    vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);

    const app = await buildTestApp(
      { userId: randomUUID(), username: 'viewer', role: 'admin', serverIds: [SERVER_A] },
      createSpyRedis()
    );
    await app.inject({ url: `/library/duplicates/files?itemIds=${ITEM_A}` });

    const [statement] = vi.mocked(db.execute).mock.calls[0] ?? [];
    expect(JSON.stringify(statement)).toContain(SERVER_A);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('reports a historical server as not checked and never probes it', async () => {
    vi.mocked(db.execute).mockResolvedValue({
      rows: [itemRow({ server_historical_at: '2026-09-01T00:00:00.000Z' })],
    } as never);

    const app = await buildTestApp(
      { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] },
      createSpyRedis()
    );
    const res = await app.inject({ url: `/library/duplicates/files?itemIds=${ITEM_A}` });

    expect(res.statusCode).toBe(200);
    expect(res.json<DuplicateFilesResponse>()).toEqual({ checked: false, files: [] });
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('answers unchecked for a server that cannot report file existence', async () => {
    vi.mocked(db.execute).mockResolvedValue({
      rows: [itemRow({ server_type: 'jellyfin' })],
    } as never);
    mockCreateClient.mockReturnValue(fakeJellyfinClient());

    const app = await buildTestApp(
      { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] },
      createSpyRedis()
    );
    const res = await app.inject({ url: `/library/duplicates/files?itemIds=${ITEM_A}` });

    expect(res.json<DuplicateFilesResponse>()).toEqual({ checked: false, files: [] });
  });

  it('answers unchecked when the probe throws instead of failing the request', async () => {
    vi.mocked(db.execute).mockResolvedValue({ rows: [itemRow()] } as never);
    mockCreateClient.mockReturnValue(
      fakePlexClient({ checkFilesExist: vi.fn().mockRejectedValue(new Error('ECONNRESET')) })
    );

    const app = await buildTestApp(
      { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] },
      createSpyRedis()
    );
    const res = await app.inject({ url: `/library/duplicates/files?itemIds=${ITEM_A}` });

    expect(res.statusCode).toBe(200);
    expect(res.json<DuplicateFilesResponse>()).toEqual({ checked: false, files: [] });
  });

  it('rejects an id list past the cap', async () => {
    const app = await buildTestApp(
      { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] },
      createSpyRedis()
    );
    const ids = Array.from({ length: 51 }, () => randomUUID())
      .map((id) => `itemIds=${id}`)
      .join('&');
    const res = await app.inject({ url: `/library/duplicates/files?${ids}` });

    expect(res.statusCode).toBe(400);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('serves a repeat request from cache without probing again', async () => {
    vi.mocked(db.execute).mockResolvedValue({ rows: [itemRow()] } as never);
    const checkFilesExist = vi
      .fn()
      .mockResolvedValue(new Map([['2733', new Map([['42858', false]])]]));
    mockCreateClient.mockReturnValue(fakePlexClient({ checkFilesExist }));

    const redis = createSpyRedis();
    const app = await buildTestApp(
      { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] },
      redis
    );
    const url = `/library/duplicates/files?itemIds=${ITEM_A}`;
    const first = await app.inject({ url });
    const second = await app.inject({ url });

    expect(checkFilesExist).toHaveBeenCalledTimes(1);
    expect(second.json<DuplicateFilesResponse>()).toEqual(first.json<DuplicateFilesResponse>());
  });
});
