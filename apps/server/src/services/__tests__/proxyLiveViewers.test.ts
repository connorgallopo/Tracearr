/**
 * proxyLiveViewers (fork patch): Live TV a shared user watched through the
 * iptvtunerr proxy is listed by Plex under the owner; the proxy's list says
 * who it really was. fetch is stubbed, so nothing here touches the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Decisions are also kept in Redis; an in-memory stand-in.
const redisStore = new Map<string, string>();
vi.mock('../../lib/redisShared.js', () => ({
  getRedis: () => ({
    mget: async (...keys: string[]) => keys.map((k) => redisStore.get(k) ?? null),
    multi: () => {
      const writes: [string, string][] = [];
      const tx = {
        set: (key: string, value: string) => {
          writes.push([key, value]);
          return tx;
        },
        exec: async () => {
          for (const [k, v] of writes) redisStore.set(k, v);
          return [];
        },
      };
      return tx;
    },
  }),
}));

import {
  attributePlexLiveViewers,
  attributeProxyLiveViewers,
  samePlayback,
  trackedPlaybackCheck,
  getProxyLiveViewers,
  resetProxyLiveViewersCache,
  type ProxyLiveViewerList,
} from '../proxyLiveViewers.js';

const URL_ = 'http://127.0.0.1:27198/iptvtunerr/live-viewers';
const MACHINE = 'machine-1';
const plexServer = { id: 'server-1', type: 'plex', machineIdentifier: MACHINE };

let nextSessionKey = 1;

function session(
  overrides: Partial<{
    sessionKey: string;
    mediaType: 'movie' | 'episode' | 'track' | 'live' | 'photo' | 'unknown';
    deviceId: string;
    externalUserId: string;
    username: string;
    userThumb: string;
  }> = {}
) {
  return {
    sessionKey: String(nextSessionKey++),
    mediaType: 'live' as const,
    deviceId: 'friend-client',
    externalUserId: '1',
    username: 'owner',
    userThumb: 'https://plex.tv/users/owner/avatar',
    ...overrides,
  };
}

function viewersResponse(viewers: unknown[], machineIdentifier = MACHINE) {
  return new Response(JSON.stringify({ machineIdentifier, viewers }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const friendList = [
  {
    clientIdentifier: 'friend-client',
    plexAccountId: '6414250',
    username: 'friend',
    lastSeen: '2026-10-16T07:00:00Z',
  },
  {
    clientIdentifier: 'owner-phone',
    plexAccountId: '',
    username: '',
    lastSeen: '2026-10-16T07:00:00Z',
  },
  { clientIdentifier: 'odd', plexAccountId: 'not-a-number', username: 'x' },
  { clientIdentifier: 'nameless', plexAccountId: '77', username: '' },
];

function listOf(...entries: [string, string, string][]): ProxyLiveViewerList {
  return {
    machineIdentifier: MACHINE,
    byClient: new Map(
      entries.map(([clientIdentifier, plexAccountId, username]) => [
        clientIdentifier,
        { clientIdentifier, plexAccountId, username },
      ])
    ),
  };
}

beforeEach(() => {
  resetProxyLiveViewersCache();
  redisStore.clear();
});

describe('attributeProxyLiveViewers', () => {
  const list = listOf(['friend-client', '6414250', 'friend']);

  it("files the owner's Live TV session under the friend behind the client", () => {
    const s = session();
    expect(attributeProxyLiveViewers('server-1', [s], list)).toBe(1);
    expect(s.externalUserId).toBe('6414250');
    expect(s.username).toBe('friend');
    expect(s.userThumb).toBe('');
  });

  it('leaves everything else alone', () => {
    const notLive = session({ mediaType: 'episode' });
    const friendsOwn = session({ externalUserId: '999', username: 'someone' });
    const unknownClient = session({ deviceId: 'owner-phone' });
    const noDevice = session({ deviceId: '' });
    expect(
      attributeProxyLiveViewers('server-1', [notLive, friendsOwn, unknownClient, noDevice], list)
    ).toBe(0);
    expect(notLive.externalUserId).toBe('1');
    expect(friendsOwn.externalUserId).toBe('999');
    expect(unknownClient.externalUserId).toBe('1');
    expect(noDevice.externalUserId).toBe('1');
  });

  it('keeps the first decision for a session, whatever later lists say', () => {
    // First seen while the list didn't have the client: stays under the owner.
    const first = session({ sessionKey: 'k1' });
    attributeProxyLiveViewers('server-1', [first], listOf());
    const later = session({ sessionKey: 'k1' });
    expect(attributeProxyLiveViewers('server-1', [later], list)).toBe(0);
    expect(later.externalUserId).toBe('1');

    // First seen as the friend's: stays theirs even when a later list lacks it.
    const friendFirst = session({ sessionKey: 'k2' });
    attributeProxyLiveViewers('server-1', [friendFirst], list);
    const friendLater = session({ sessionKey: 'k2' });
    expect(attributeProxyLiveViewers('server-1', [friendLater], null)).toBe(1);
    expect(friendLater.externalUserId).toBe('6414250');
  });

  it('decides per server: the same session key elsewhere is a new session', () => {
    attributeProxyLiveViewers('server-1', [session({ sessionKey: 'k3' })], listOf());
    const other = session({ sessionKey: 'k3' });
    expect(attributeProxyLiveViewers('server-2', [other], list)).toBe(1);
  });
});

describe('decision persistence', () => {
  it('persists a new decision, and renews it hourly while the session is seen', () => {
    const persisted: string[] = [];
    const persist = (key: string) => persisted.push(key);
    const list = listOf(['friend-client', '6414250', 'friend']);
    const t0 = 1_800_000_000_000;
    attributeProxyLiveViewers('server-1', [session({ sessionKey: 'long' })], list, t0, persist);
    attributeProxyLiveViewers(
      'server-1',
      [session({ sessionKey: 'long' })],
      list,
      t0 + 30 * 60_000,
      persist
    );
    expect(persisted).toHaveLength(1);
    attributeProxyLiveViewers(
      'server-1',
      [session({ sessionKey: 'long' })],
      list,
      t0 + 61 * 60_000,
      persist
    );
    expect(persisted).toHaveLength(2);
  });
});

describe('getProxyLiveViewers', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('IPTVTUNERR_LIVE_VIEWERS_URL', URL_);
    vi.stubEnv('IPTVTUNERR_LIVE_VIEWERS_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is null and never fetches without IPTVTUNERR_LIVE_VIEWERS_URL', async () => {
    vi.stubEnv('IPTVTUNERR_LIVE_VIEWERS_URL', '');
    expect(await getProxyLiveViewers()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps only clients with a plex.tv account id and a username, and the server it names', async () => {
    fetchMock.mockResolvedValueOnce(viewersResponse(friendList));
    const list = await getProxyLiveViewers(1_000);
    expect(list?.machineIdentifier).toBe(MACHINE);
    expect([...(list?.byClient.keys() ?? [])]).toEqual(['friend-client']);
    expect(list?.byClient.get('friend-client')?.plexAccountId).toBe('6414250');
  });

  it('sends the read-only key as a bearer token', async () => {
    vi.stubEnv('IPTVTUNERR_LIVE_VIEWERS_KEY', 'viewers-key-0123456789abcdef');
    fetchMock.mockResolvedValueOnce(viewersResponse([]));
    await getProxyLiveViewers(1_000);
    expect(fetchMock).toHaveBeenCalledWith(
      URL_,
      expect.objectContaining({ headers: { Authorization: 'Bearer viewers-key-0123456789abcdef' } })
    );
  });

  it('shares one request between concurrent callers', async () => {
    fetchMock.mockResolvedValue(viewersResponse(friendList));
    await Promise.all([getProxyLiveViewers(1_000), getProxyLiveViewers(1_000)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is null when the proxy fails, never an older answer, and warns once per 5 minutes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(viewersResponse(friendList));
    await getProxyLiveViewers(1_000);
    fetchMock.mockRejectedValue(new Error('connection refused'));
    expect(await getProxyLiveViewers(20_000)).toBeNull();
    expect(await getProxyLiveViewers(40_000)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('treats a non-200 answer as a failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    expect(await getProxyLiveViewers(1_000)).toBeNull();
  });
});

describe('attributePlexLiveViewers', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('IPTVTUNERR_LIVE_VIEWERS_URL', URL_);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('attributes sessions from the Plex server the list names', async () => {
    fetchMock.mockResolvedValueOnce(viewersResponse(friendList));
    const s = session();
    expect(await attributePlexLiveViewers(plexServer, [s])).toBe(1);
    expect(s.externalUserId).toBe('6414250');
  });

  it("leaves another server's sessions, and a server without a known machine id, alone", async () => {
    fetchMock.mockImplementation(async () => viewersResponse(friendList));
    const other = session();
    expect(
      await attributePlexLiveViewers({ id: 'server-2', type: 'plex', machineIdentifier: 'other' }, [
        other,
      ])
    ).toBe(0);
    expect(other.externalUserId).toBe('1');
    const unknown = session();
    expect(
      await attributePlexLiveViewers({ id: 'server-3', type: 'plex', machineIdentifier: null }, [
        unknown,
      ])
    ).toBe(0);
    expect(unknown.externalUserId).toBe('1');
  });

  it("doesn't fetch for other server types, when no owner Live TV session is playing, or once decided", async () => {
    expect(await attributePlexLiveViewers({ id: 'j', type: 'jellyfin' }, [session()])).toBe(0);
    expect(await attributePlexLiveViewers(plexServer, [session({ mediaType: 'movie' })])).toBe(0);
    expect(await attributePlexLiveViewers(plexServer, [session({ externalUserId: '42' })])).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(viewersResponse(friendList));
    await attributePlexLiveViewers(plexServer, [session({ sessionKey: 'decided' })]);
    await attributePlexLiveViewers(plexServer, [session({ sessionKey: 'decided' })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches once per new session for the owner's own device, not on every poll", async () => {
    fetchMock.mockResolvedValue(viewersResponse(friendList));
    for (let i = 0; i < 10; i++) {
      await attributePlexLiveViewers(plexServer, [
        session({ sessionKey: 'phone-session', deviceId: 'owner-phone' }),
      ]);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keys decisions on Plex's Session.id, so a session key reused after a PMS restart is a new session", async () => {
    fetchMock.mockResolvedValue(viewersResponse([]));
    await attributePlexLiveViewers(plexServer, [
      { ...session({ sessionKey: '5' }), plexSessionId: 'before-restart' },
    ]);
    fetchMock.mockResolvedValue(viewersResponse(friendList));
    const after = { ...session({ sessionKey: '5' }), plexSessionId: 'after-restart' };
    expect(await attributePlexLiveViewers(plexServer, [after])).toBe(1);
    expect(after.externalUserId).toBe('6414250');
  });

  it("doesn't name a viewer for a new session from an earlier answer when the proxy fails", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(viewersResponse(friendList));
    expect(await attributePlexLiveViewers(plexServer, [session()])).toBe(1);
    fetchMock.mockRejectedValue(new Error('connection refused'));
    const next = session();
    expect(await attributePlexLiveViewers(plexServer, [next])).toBe(0);
    expect(next.externalUserId).toBe('1');
  });

  it('asks again for a new session even right after an answer, so a device that changed hands is seen', async () => {
    fetchMock.mockResolvedValueOnce(viewersResponse(friendList));
    expect(await attributePlexLiveViewers(plexServer, [session()])).toBe(1);
    // Moments later the same device plays for the owner: the proxy no longer lists it.
    fetchMock.mockResolvedValueOnce(viewersResponse([]));
    const next = session();
    expect(await attributePlexLiveViewers(plexServer, [next])).toBe(0);
    expect(next.externalUserId).toBe('1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('leaves a session Tracearr already records (from before the feature) as it was, without fetching', async () => {
    fetchMock.mockResolvedValue(viewersResponse(friendList));
    const existing = session({ sessionKey: 'recorded-before' });
    const recordedUnderOwner = async () => ({ viewer: null });
    const untracked = async () => null;
    expect(await attributePlexLiveViewers(plexServer, [existing], recordedUnderOwner)).toBe(0);
    expect(existing.externalUserId).toBe('1');
    expect(fetchMock).not.toHaveBeenCalled();
    // And that stays its decision.
    const again = session({ sessionKey: 'recorded-before' });
    expect(await attributePlexLiveViewers(plexServer, [again], untracked)).toBe(0);
    expect(again.externalUserId).toBe('1');
    // A new session isn't tracked yet, so it's attributed.
    const fresh = session();
    expect(await attributePlexLiveViewers(plexServer, [fresh], untracked)).toBe(1);
  });

  it('keeps a session recorded under a friend theirs when its decision was lost', async () => {
    fetchMock.mockResolvedValue(viewersResponse([]));
    const recordedUnderFriend = async () => ({
      viewer: { clientIdentifier: 'friend-client', plexAccountId: '6414250', username: 'friend' },
    });
    const ongoing = session({ sessionKey: 'lost-decision' });
    expect(await attributePlexLiveViewers(plexServer, [ongoing], recordedUnderFriend)).toBe(1);
    expect(ongoing.externalUserId).toBe('6414250');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps applying stored decisions when the URL is removed, but looks up no new session', async () => {
    fetchMock.mockResolvedValueOnce(viewersResponse(friendList));
    const before = { ...session({ sessionKey: '11' }), plexSessionId: 'playback-11' };
    expect(await attributePlexLiveViewers(plexServer, [before])).toBe(1);

    resetProxyLiveViewersCache(); // restarted without the URL
    vi.stubEnv('IPTVTUNERR_LIVE_VIEWERS_URL', '');
    const ongoing = { ...session({ sessionKey: '11' }), plexSessionId: 'playback-11' };
    expect(await attributePlexLiveViewers(plexServer, [ongoing])).toBe(1);
    expect(ongoing.externalUserId).toBe('6414250');
    const fresh = session();
    expect(await attributePlexLiveViewers(plexServer, [fresh])).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers a recorded friend session from its row with the URL removed and Redis empty', async () => {
    vi.stubEnv('IPTVTUNERR_LIVE_VIEWERS_URL', '');
    const recordedUnderFriend = async () => ({
      viewer: { clientIdentifier: 'friend-client', plexAccountId: '6414250', username: 'friend' },
    });
    const ongoing = session({ sessionKey: 'no-url-no-redis' });
    expect(await attributePlexLiveViewers(plexServer, [ongoing], recordedUnderFriend)).toBe(1);
    expect(ongoing.externalUserId).toBe('6414250');
    // A session nobody records yet isn't looked up without the URL.
    const fresh = session();
    expect(await attributePlexLiveViewers(plexServer, [fresh], async () => null)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('restores from Redis a decision memory dropped after 6 hours unseen', async () => {
    fetchMock.mockResolvedValueOnce(viewersResponse(friendList));
    const playback = { ...session({ sessionKey: '12' }), plexSessionId: 'playback-12' };
    expect(await attributePlexLiveViewers(plexServer, [playback])).toBe(1);
    // Seven hours unseen (a long Plex outage): memory forgets, Redis still has it.
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 7 * 60 * 60_000);
    fetchMock.mockResolvedValue(viewersResponse([]));
    const back = { ...session({ sessionKey: '12' }), plexSessionId: 'playback-12' };
    expect(await attributePlexLiveViewers(plexServer, [back])).toBe(1);
    expect(back.externalUserId).toBe('6414250');
    vi.restoreAllMocks();
  });

  it('recovers decisions after a Tracearr restart, even when the proxy is down then', async () => {
    fetchMock.mockResolvedValueOnce(viewersResponse(friendList));
    const before = { ...session({ sessionKey: '9' }), plexSessionId: 'playback-9' };
    expect(await attributePlexLiveViewers(plexServer, [before])).toBe(1);

    resetProxyLiveViewersCache(); // the restart: memory gone, Redis kept
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('connection refused'));
    const after = { ...session({ sessionKey: '9' }), plexSessionId: 'playback-9' };
    expect(await attributePlexLiveViewers(plexServer, [after])).toBe(1);
    expect(after.externalUserId).toBe('6414250');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('tracked playbacks', () => {
  const s = { ...session({ sessionKey: '7', deviceId: 'tv' }), plexSessionId: 'now' };

  it('is the same playback only for the same client and Session.id', () => {
    expect(samePlayback({ deviceId: 'tv', plexSessionId: 'now' }, s)).toBe(true);
    expect(samePlayback({ deviceId: 'tv', plexSessionId: null }, s)).toBe(true);
    expect(samePlayback({ deviceId: 'tv', plexSessionId: 'before-restart' }, s)).toBe(false);
    expect(samePlayback({ deviceId: 'phone', plexSessionId: 'now' }, s)).toBe(false);
  });

  it('checks a pending record first, then an active row, and says who it is recorded under', async () => {
    const none = async () => null;
    const friendUser = async () => ({ externalId: '6414250', username: 'friend' });
    const ownerUser = async () => ({ externalId: '1', username: 'owner' });
    expect(await trackedPlaybackCheck('srv', none, none, friendUser)(s)).toBeNull();
    // A pending record under the friend.
    expect(
      await trackedPlaybackCheck(
        'srv',
        async () => ({
          processed: {
            deviceId: 'tv',
            plexSessionId: 'now',
            externalUserId: '6414250',
            username: 'friend',
          },
        }),
        none,
        ownerUser
      )(s)
    ).toEqual({ viewer: { clientIdentifier: 'tv', plexAccountId: '6414250', username: 'friend' } });
    // An active row under the owner.
    expect(
      await trackedPlaybackCheck(
        'srv',
        none,
        async () => ({ deviceId: 'tv', plexSessionId: 'now', serverUserId: 'su-owner' }),
        ownerUser
      )(s)
    ).toEqual({ viewer: null });
    // An active row under the friend.
    expect(
      await trackedPlaybackCheck(
        'srv',
        none,
        async () => ({ deviceId: 'tv', plexSessionId: 'now', serverUserId: 'su-friend' }),
        friendUser
      )(s)
    ).toEqual({ viewer: { clientIdentifier: 'tv', plexAccountId: '6414250', username: 'friend' } });
    // A row left from before a PMS restart, same key, other playback: not tracked.
    expect(
      await trackedPlaybackCheck(
        'srv',
        none,
        async () => ({ deviceId: 'tv', plexSessionId: 'before-restart', serverUserId: 'su-owner' }),
        ownerUser
      )(s)
    ).toBeNull();
  });
});
