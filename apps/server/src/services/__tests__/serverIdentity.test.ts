import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeEmbyClient, fakeJellyfinClient, fakePlexClient } from '../../test/mediaServerFakes.js';

const fakeClients = { plex: fakePlexClient, jellyfin: fakeJellyfinClient, emby: fakeEmbyClient };
const getServerIdentity = vi.fn();
const getUsers = vi.fn();
const createMediaServerClient = vi.fn((opts: { type: keyof typeof fakeClients }) =>
  fakeClients[opts.type]({ getServerIdentity, getUsers })
);
const invalidateServersCache = vi.fn();
const where = vi.fn(async (_cond: unknown) => undefined);
const set = vi.fn((_values: unknown) => ({ where }));
const update = vi.fn((_table: unknown) => ({ set }));

const isLiveServer = vi.fn(async (_id: string) => true);
vi.mock('../liveServers.js', async (importActual) => ({
  ...(await importActual<typeof import('../liveServers.js')>()),
  isLiveServer: (id: string) => isLiveServer(id),
}));
const selectWhere = vi.fn(async (_cond: unknown) => [] as unknown[]);
vi.mock('../../db/client.js', () => ({
  db: {
    update: (arg: unknown) => update(arg),
    select: () => ({ from: () => ({ where: (cond: unknown) => selectWhere(cond) }) }),
  },
}));
vi.mock('../mediaServer/index.js', () => ({
  createMediaServerClient: (arg: Parameters<typeof createMediaServerClient>[0]) =>
    createMediaServerClient(arg),
}));
vi.mock('../../jobs/poller/database.js', () => ({
  invalidateServersCache: () => invalidateServersCache(),
}));

import { renderSql } from '../../test/helpers.js';
import type { SQL } from 'drizzle-orm';

const { backfillMissingServerIdentifiers, ensureServerIdentifier, sharesKnownUsers } =
  await import('../serverIdentity.js');

const server = {
  id: 'srv-1',
  type: 'emby' as const,
  url: 'http://emby.local:8096',
  token: 'tok',
  machineIdentifier: null,
};

describe('ensureServerIdentifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isLiveServer.mockReset().mockResolvedValue(true);
  });

  it('stores the fetched identifier and invalidates the cache', async () => {
    getServerIdentity.mockResolvedValueOnce('a1c97fc391d842678fb3f3a4cb42e185');

    const result = await ensureServerIdentifier(server);

    expect(result).toBe('a1c97fc391d842678fb3f3a4cb42e185');
    expect(createMediaServerClient).toHaveBeenCalledWith({
      type: 'emby',
      url: 'http://emby.local:8096',
      token: 'tok',
      id: 'srv-1',
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ machineIdentifier: 'a1c97fc391d842678fb3f3a4cb42e185' })
    );
    expect(invalidateServersCache).toHaveBeenCalledTimes(1);
  });

  it('makes no request when the row already has an identifier', async () => {
    const result = await ensureServerIdentifier({ ...server, machineIdentifier: 'existing' });

    expect(result).toBe('existing');
    expect(createMediaServerClient).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('reads nothing from a historical server and leaves its identifier alone', async () => {
    isLiveServer.mockResolvedValueOnce(false);

    expect(await ensureServerIdentifier(server)).toBeNull();
    expect(createMediaServerClient).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('still returns a stored identifier for a historical row without a request', async () => {
    isLiveServer.mockResolvedValueOnce(false);

    expect(await ensureServerIdentifier({ ...server, machineIdentifier: 'kept' })).toBe('kept');
    expect(createMediaServerClient).not.toHaveBeenCalled();
  });

  it('writes nothing when the server reports no identifier', async () => {
    getServerIdentity.mockResolvedValueOnce(null);

    expect(await ensureServerIdentifier(server)).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(invalidateServersCache).not.toHaveBeenCalled();
  });

  it('swallows a fetch failure so the caller is unaffected', async () => {
    getServerIdentity.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const log = { debug: vi.fn() };

    expect(await ensureServerIdentifier(server, log)).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'srv-1' }),
      expect.any(String)
    );
  });
});

describe('backfillMissingServerIdentifiers', () => {
  it('sweeps only live rows that still lack an identifier', async () => {
    await backfillMissingServerIdentifiers();

    const rendered = renderSql(selectWhere.mock.calls[0]?.[0] as SQL);
    expect(rendered.sql).toContain('servers.machine_identifier is null');
    expect(rendered.sql).toContain('servers.historical_at is null');
  });
});

describe('sharesKnownUsers', () => {
  const guid = (n: number) => n.toString(16).padStart(32, '0');
  const target = { id: 'srv-1', type: 'jellyfin' as const, url: 'http://jf:8096', token: 'new' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('matches on one known user among hundreds, and not when every id is new', async () => {
    selectWhere.mockResolvedValue(Array.from({ length: 200 }, (_, i) => ({ externalId: guid(i) })));

    getUsers.mockResolvedValueOnce([{ id: guid(9000) }, { id: guid(199) }]);
    expect(await sharesKnownUsers(target)).toBe(true);

    getUsers.mockResolvedValueOnce([{ id: guid(9000) }, { id: guid(9001) }]);
    expect(await sharesKnownUsers(target)).toBe(false);
  });

  it('asks nothing of the server when Tracearr holds no users for it, or it is Plex', async () => {
    selectWhere.mockResolvedValueOnce([]);
    expect(await sharesKnownUsers(target)).toBe(false);

    expect(await sharesKnownUsers({ ...target, type: 'plex' })).toBe(false);
    expect(getUsers).not.toHaveBeenCalled();
  });
});
