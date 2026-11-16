import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

vi.mock('../../../db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));
vi.mock('../../../jobs/poller/database.js', () => ({ invalidateServersCache: vi.fn() }));
vi.mock('../../../services/mediaServer/index.js', () => ({
  JellyfinClient: {
    verifyServerAdmin: vi.fn(),
    AdminVerifyError: {
      CONNECTION_FAILED: 'CONNECTION_FAILED',
      INVALID_KEY: 'INVALID_KEY',
      NOT_ADMIN: 'NOT_ADMIN',
    },
  },
  EmbyClient: {
    verifyServerAdmin: vi.fn(),
    AdminVerifyError: {
      CONNECTION_FAILED: 'CONNECTION_FAILED',
      INVALID_KEY: 'INVALID_KEY',
      NOT_ADMIN: 'NOT_ADMIN',
    },
  },
}));
vi.mock('../../../services/serverCreate.js', () => ({
  startAddedServer: vi.fn().mockResolvedValue(undefined),
  syncReconnectedServer: vi.fn(),
}));

import { db } from '../../../db/client.js';
import { EmbyClient, JellyfinClient } from '../../../services/mediaServer/index.js';
import { startAddedServer, syncReconnectedServer } from '../../../services/serverCreate.js';
import { embyRoutes } from '../emby.js';
import { jellyfinRoutes } from '../jellyfin.js';

const owner: AuthUser = { userId: randomUUID(), username: 'admin', role: 'owner', serverIds: [] };

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('requireOwner', async (request: unknown) => {
    (request as { user: AuthUser }).user = owner;
  });
  await app.register(jellyfinRoutes);
  await app.register(embyRoutes);
  return app;
}

function mockExisting(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  } as never);
}

function mockInsert() {
  const chain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'srv-1' }]),
  };
  vi.mocked(db.insert).mockReturnValue(chain as never);
  return chain;
}

function mockUpdate() {
  const chain = { set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(db.update).mockReturnValue(chain as never);
  return chain;
}

beforeEach(() => {
  vi.mocked(JellyfinClient.verifyServerAdmin).mockResolvedValue({ success: true });
  vi.mocked(EmbyClient.verifyServerAdmin).mockResolvedValue({ success: true });
});

describe('connect-api-key public address', () => {
  it('stores the public address with https prepended when a Jellyfin server is added', async () => {
    const app = await build();
    mockExisting([]);
    const insert = mockInsert();
    const res = await app.inject({
      method: 'POST',
      url: '/jellyfin/connect-api-key',
      payload: {
        serverUrl: 'http://192.168.1.20:8096',
        serverName: 'Attic',
        apiKey: 'key-1',
        publicUrl: 'jellyfin.example.com',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ serverId: 'srv-1' });
    expect(insert.values).toHaveBeenCalledWith({
      name: 'Attic',
      type: 'jellyfin',
      url: 'http://192.168.1.20:8096',
      token: 'key-1',
      publicUrl: 'https://jellyfin.example.com',
    });
  });

  it('writes the public address when an existing Emby server is reconnected with one', async () => {
    const app = await build();
    mockExisting([{ id: 'srv-1', publicUrl: null }]);
    const update = mockUpdate();
    const res = await app.inject({
      method: 'POST',
      url: '/emby/connect-api-key',
      payload: {
        serverUrl: 'http://192.168.1.30:8096',
        serverName: 'Shed',
        apiKey: 'key-2',
        publicUrl: 'https://emby.example.com',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(update.set).toHaveBeenCalledWith({
      name: 'Shed',
      token: 'key-2',
      publicUrl: 'https://emby.example.com',
      updatedAt: expect.any(Date),
    });
  });

  it('leaves the public address alone when a Jellyfin server is reconnected without one', async () => {
    const app = await build();
    mockExisting([{ id: 'srv-1', publicUrl: 'https://jellyfin.example.com' }]);
    const update = mockUpdate();
    const res = await app.inject({
      method: 'POST',
      url: '/jellyfin/connect-api-key',
      payload: { serverUrl: 'http://192.168.1.20:8096', serverName: 'Attic', apiKey: 'key-3' },
    });
    expect(res.statusCode).toBe(200);
    expect(update.set.mock.calls[0]?.[0]).toEqual({
      name: 'Attic',
      token: 'key-3',
      updatedAt: expect.any(Date),
    });
    expect(update.set.mock.calls[0]?.[0]).not.toHaveProperty('publicUrl');
  });
});

describe.each([
  ['jellyfin', JellyfinClient],
  ['emby', EmbyClient],
] as const)('connect-api-key on a %s server', (type, client) => {
  const url = `/${type}/connect-api-key`;
  const payload = { serverUrl: 'http://192.168.1.40:8096', serverName: 'Old', apiKey: 'key-9' };

  it('refuses a historical server before contacting it or writing to it', async () => {
    const app = await build();
    mockExisting([{ id: 'srv-1', historicalAt: new Date('2026-09-01T00:00:00Z') }]);
    vi.mocked(db.update).mockClear();
    vi.mocked(client.verifyServerAdmin).mockClear();
    const res = await app.inject({ method: 'POST', url, payload });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('Resume this server to change its address or key');
    expect(client.verifyServerAdmin).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('starts a new server the way every added server starts', async () => {
    const app = await build();
    mockExisting([]);
    mockInsert();
    vi.mocked(startAddedServer).mockClear();
    vi.mocked(syncReconnectedServer).mockClear();
    const res = await app.inject({ method: 'POST', url, payload });
    expect(res.statusCode).toBe(200);
    expect(startAddedServer).toHaveBeenCalledExactlyOnceWith({ id: 'srv-1', type }, []);
    expect(syncReconnectedServer).not.toHaveBeenCalled();
  });

  it('syncs a reconnected server without starting it again', async () => {
    const app = await build();
    mockExisting([{ id: 'srv-1' }]);
    mockUpdate();
    vi.mocked(startAddedServer).mockClear();
    vi.mocked(syncReconnectedServer).mockClear();
    const res = await app.inject({ method: 'POST', url, payload });
    expect(res.statusCode).toBe(200);
    expect(startAddedServer).not.toHaveBeenCalled();
    expect(syncReconnectedServer).toHaveBeenCalledExactlyOnceWith('srv-1');
  });
});
