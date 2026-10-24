import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockLimit, mockReturning, mockGetUsers, mockGetLibraries } = vi.hoisted(() => ({
  mockLimit: vi.fn(),
  mockReturning: vi.fn(),
  mockGetUsers: vi.fn(),
  mockGetLibraries: vi.fn(),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mockLimit }) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: mockReturning }) }) }),
    transaction: (run: (tx: unknown) => Promise<unknown>) => run({}),
  },
}));
vi.mock('../mediaServer/index.js', () => ({
  createMediaServerClient: () => ({ getUsers: mockGetUsers, getLibraries: mockGetLibraries }),
  PlexClient: class {},
}));
vi.mock('../userService.js', () => ({
  loadServerAccounts: vi.fn(),
  recomputeIdentityAggregates: vi.fn(),
  syncUserFromMediaServer: vi.fn(),
}));
vi.mock('../serverIdentity.js', () => ({ ensureServerIdentifier: vi.fn() }));
vi.mock('../../lib/revoke.js', () => ({ revokeSessionsForServerUsers: vi.fn() }));
vi.mock('../../lib/scope.js', () => ({ clearScope: vi.fn() }));

import { revokeSessionsForServerUsers } from '../../lib/revoke.js';
import { clearScope } from '../../lib/scope.js';
import { syncUserFromMediaServer } from '../userService.js';
import { syncServer } from '../sync.js';

const SERVER = {
  id: 'srv-1',
  type: 'jellyfin',
  url: 'http://jf.local',
  token: 'tok',
  machineIdentifier: 'mid',
  historicalAt: null,
};

function synced(id: string, newlyDisabled: boolean) {
  return { serverUser: { id }, user: {}, created: false, newlyDisabled } as never;
}

describe('syncServer revocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockResolvedValue([SERVER]);
    mockGetUsers.mockResolvedValue([{ id: 'ext-1' }, { id: 'ext-2' }]);
    mockGetLibraries.mockResolvedValue([]);
  });

  it('revokes an account the sync just saw disabled', async () => {
    vi.mocked(syncUserFromMediaServer)
      .mockResolvedValueOnce(synced('su-1', true))
      .mockResolvedValueOnce(synced('su-2', false));
    mockReturning.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await syncServer('srv-1', { syncUsers: true, syncLibraries: false });

    expect(revokeSessionsForServerUsers).toHaveBeenCalledExactlyOnceWith(['su-1']);
  });

  it('revokes an account missing from the server response', async () => {
    vi.mocked(syncUserFromMediaServer).mockResolvedValue(synced('su-1', false));
    mockReturning.mockResolvedValueOnce([{ id: 'su-gone' }]).mockResolvedValueOnce([]);

    await syncServer('srv-1', { syncUsers: true, syncLibraries: false });

    expect(revokeSessionsForServerUsers).toHaveBeenCalledExactlyOnceWith(['su-gone']);
  });

  it('does not revoke a restored account, and widens its owner scope', async () => {
    vi.mocked(syncUserFromMediaServer).mockResolvedValue(synced('su-1', false));
    mockReturning
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ userId: 'u-back' }, { userId: 'u-back' }]);

    await syncServer('srv-1', { syncUsers: true, syncLibraries: false });

    expect(revokeSessionsForServerUsers).toHaveBeenCalledExactlyOnceWith([]);
    expect(clearScope).toHaveBeenCalledExactlyOnceWith('u-back');
  });
});

describe('syncServer library access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockResolvedValue([SERVER]);
    mockReturning.mockResolvedValue([]);
    vi.mocked(syncUserFromMediaServer).mockResolvedValue(synced('su-1', false));
  });

  it('names enabled folders by library id, matching Emby folders by Guid only', async () => {
    mockGetLibraries.mockResolvedValue([
      { id: '3', guid: 'cf6657dae4df49e59f5a67056f48200e', name: 'Movies', type: 'movies' },
      { id: '63851', guid: '0ebdcea572eb4ab6b517d127bb0d54b8', name: 'TV', type: 'tvshows' },
      { id: 'f137a2dd21bbc1b99aa5c0f6bf02a805', name: 'Films', type: 'movies' },
    ]);
    mockGetUsers.mockResolvedValue([
      { id: 'emby', sharedLibraries: ['cf6657dae4df49e59f5a67056f48200e', '63851'] },
      { id: 'jellyfin', sharedLibraries: ['f137a2dd21bbc1b99aa5c0f6bf02a805', 'deleted'] },
      { id: 'everything' },
    ]);

    await syncServer('srv-1', { syncUsers: true, syncLibraries: false });

    expect(
      vi.mocked(syncUserFromMediaServer).mock.calls.map(([, user]) => user.sharedLibraries)
    ).toEqual([['3'], ['f137a2dd21bbc1b99aa5c0f6bf02a805'], undefined]);
  });

  it('still syncs users when the library list fails, mapping limits to no libraries', async () => {
    mockGetLibraries.mockRejectedValue(new Error('403'));
    mockGetUsers.mockResolvedValue([
      { id: 'limited', sharedLibraries: ['f137a2dd21bbc1b99aa5c0f6bf02a805'] },
      { id: 'everything' },
    ]);

    const result = await syncServer('srv-1', { syncUsers: true, syncLibraries: false });

    expect(result.errors).toEqual([]);
    expect(
      vi.mocked(syncUserFromMediaServer).mock.calls.map(([, user]) => user.sharedLibraries)
    ).toEqual([[], undefined]);
  });
});
