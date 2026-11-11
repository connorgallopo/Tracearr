import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectResults, deleteUserSessions, logoutUserToken } = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  deleteUserSessions: vi.fn(),
  logoutUserToken: vi.fn(),
}));

vi.mock('../../db/client.js', () => ({ db: { select: vi.fn() } }));
vi.mock('../auth.js', () => ({
  getAuth: () => ({ $context: Promise.resolve({ internalAdapter: { deleteUserSessions } }) }),
}));
vi.mock('../../websocket/index.js', () => ({ disconnectUserSockets: vi.fn() }));
vi.mock('../scope.js', () => ({ clearScope: vi.fn() }));
vi.mock('../memberLogin.js', () => ({ memberStillValid: vi.fn(async () => false) }));
vi.mock('../../services/mediaServer/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/mediaServer/index.js')>()),
  logoutUserToken,
}));

import { db } from '../../db/client.js';
import { disconnectUserSockets } from '../../websocket/index.js';
import { clearScope } from '../scope.js';
import { memberStillValid } from '../memberLogin.js';
import { revokeSessionsForServerUsers, revokeSessionsForUsers } from '../revoke.js';

// Each db.select() resolves the next queued row set, in call order.
function queueSelects(...results: unknown[][]) {
  selectResults.splice(0, selectResults.length, ...results);
  vi.mocked(db.select).mockImplementation(() => {
    const rows = selectResults.shift() ?? [];
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return chain as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('revokeSessionsForUsers', () => {
  it('no-ops on an empty list', async () => {
    await revokeSessionsForUsers([]);
    expect(db.select).not.toHaveBeenCalled();
    expect(deleteUserSessions).not.toHaveBeenCalled();
  });

  it('deletes sessions and disconnects sockets once per non-owner id', async () => {
    queueSelects([{ id: 'owner' }], []);
    await revokeSessionsForUsers(['u1', 'u2', 'u1', 'owner']);
    expect(deleteUserSessions.mock.calls).toEqual([['u1'], ['u2']]);
    expect(vi.mocked(clearScope).mock.calls).toEqual([['u1'], ['u2']]);
    expect(vi.mocked(disconnectUserSockets).mock.calls).toEqual([['u1'], ['u2']]);
  });

  it('still revokes an id whose users row is already gone, as after a merge', async () => {
    queueSelects([], []);
    await revokeSessionsForUsers(['merged-source']);
    expect(deleteUserSessions).toHaveBeenCalledExactlyOnceWith('merged-source');
    expect(disconnectUserSockets).toHaveBeenCalledExactlyOnceWith('merged-source');
  });

  it('stops when every id is the owner', async () => {
    queueSelects([{ id: 'owner' }]);
    await revokeSessionsForUsers(['owner']);
    expect(deleteUserSessions).not.toHaveBeenCalled();
  });

  it('posts the server-side logout once per jellyfin or emby account', async () => {
    queueSelects(
      [],
      [
        { userId: 'u1', accountId: 'jf-server:ext-1', accessToken: 'jf-token' },
        { userId: 'u1', accountId: 'emby-server:ext-2', accessToken: 'emby-token' },
        { userId: 'u1', accountId: 'emby-server:ext-3', accessToken: null },
      ],
      [{ url: 'http://jf.local:8096', type: 'jellyfin' }],
      [{ url: 'http://emby.local:8096', type: 'emby' }]
    );
    await revokeSessionsForUsers(['u1']);
    expect(logoutUserToken).toHaveBeenCalledTimes(2);
    expect(logoutUserToken).toHaveBeenCalledWith('jellyfin', 'http://jf.local:8096', 'jf-token');
    expect(logoutUserToken).toHaveBeenCalledWith('emby', 'http://emby.local:8096', 'emby-token');
  });

  it('swallows a logout failure and still logs out the next account', async () => {
    logoutUserToken.mockRejectedValueOnce(new Error('server down'));
    queueSelects(
      [],
      [
        { userId: 'u1', accountId: 'jf-server:ext-1', accessToken: 'jf-token' },
        { userId: 'u1', accountId: 'emby-server:ext-2', accessToken: 'emby-token' },
      ],
      [{ url: 'http://jf.local:8096', type: 'jellyfin' }],
      [{ url: 'http://emby.local:8096', type: 'emby' }]
    );
    await expect(revokeSessionsForUsers(['u1'])).resolves.toBeUndefined();
    expect(logoutUserToken).toHaveBeenLastCalledWith(
      'emby',
      'http://emby.local:8096',
      'emby-token'
    );
  });
});

describe('revokeSessionsForServerUsers', () => {
  it('revokes the identities behind the account ids', async () => {
    queueSelects([{ userId: 'u1' }, { userId: 'u1' }], [], []);
    await revokeSessionsForServerUsers(['su-1', 'su-2']);
    expect(deleteUserSessions).toHaveBeenCalledExactlyOnceWith('u1');
  });

  it('no-ops on an empty list', async () => {
    await revokeSessionsForServerUsers([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('keeps the session of anyone a fresh sign-in would still let in', async () => {
    vi.mocked(memberStillValid).mockImplementation(async (id) => id === 'u-still-in');
    queueSelects([{ userId: 'u-still-in' }, { userId: 'u-out' }], [], []);

    await revokeSessionsForServerUsers(['su-1', 'su-2']);

    expect(memberStillValid).toHaveBeenCalledTimes(2);
    expect(deleteUserSessions).toHaveBeenCalledExactlyOnceWith('u-out');
    vi.mocked(memberStillValid).mockImplementation(async () => false);
  });
});
