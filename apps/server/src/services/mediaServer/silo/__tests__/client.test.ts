import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as HttpModule from '../../../../utils/http.js';

vi.mock('../../../../utils/http.js', async (importActual) => {
  const actual = await importActual<typeof HttpModule>();
  return { ...actual, fetchJson: vi.fn() };
});

import { fetchJson, HttpClientError } from '../../../../utils/http.js';
import silo from '../../../../test/mediaServerResponses/silo.json' with { type: 'json' };
import { NOT_NEEDED } from '../../types.js';
import { SILO_STOP_REFUSED, SiloClient } from '../client.js';

const mockFetchJson = vi.mocked(fetchJson);

const URL = 'http://silo.local:8090';
const KEY = 'silo_7c2e9f4a1b6d3e8f';
const PROBE_SESSION = '/admin/sessions/00000000-0000-4000-8000-000000000000/terminate';

type Answer = Error | ((url: string) => unknown) | object;

/** Answers each API path, query left off, with its body; an Error is thrown, any other path fails */
function serve(responses: Record<string, Answer>) {
  mockFetchJson.mockImplementation(async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api\/v2/, '').split('?')[0] ?? '';
    const answer = responses[path];
    if (answer === undefined) throw new Error(`unexpected request ${url}`);
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(url) : answer;
  });
}

function httpError(statusCode: number, retryAfter?: string): HttpClientError {
  return new HttpClientError({
    service: 'silo',
    statusCode,
    statusText: 'error',
    url: URL,
    retryAfter,
  });
}

function client(url = URL) {
  return new SiloClient({ url: `${url}/`, token: KEY });
}

const requested = (path: string) =>
  mockFetchJson.mock.calls.map(([url]) => url).filter((url) => url.includes(path));

const RESTARTED = 'a613750c-52f6-4ef2-b2a8-616135598312';

/** The fixture movie row as another session of the same account, device and item */
const play = (sessionId: string, startedAt: string, fields: object = {}) => ({
  ...silo.sessions.items[0],
  session_id: sessionId,
  started_at: startedAt,
  is_paused: false,
  ...fields,
});
const pausedPlay = play('74bb3687-6a17-4de1-819a-db80c7bac488', '2026-11-21T04:05:10.120Z', {
  is_paused: true,
});
const restartedPlay = play(RESTARTED, '2026-11-21T04:05:13.480Z');

async function poll(url: string, items: object[]) {
  serve({ '/admin/sessions': { items }, '/admin/devices': silo.devices });
  const sessions = await client(url).getSessions();
  return sessions.map((s) => [s.sessionKey, s.playback.state]);
}

const verifyAnswers = (): Record<string, Answer> => ({
  '/system/info': silo.systemInfo,
  '/admin/sessions': silo.sessions,
  '/events/ws-ticket': { ticket: 'ticket-1', expires_in: 30 },
  '/user/libraries': silo.libraries,
  [PROBE_SESSION]: httpError(404),
});

beforeEach(() => {
  mockFetchJson.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SiloClient', () => {
  it('sends the key as a bearer token under /api/v2', async () => {
    serve({ '/admin/users': silo.users });

    await client().getUsers();

    const [url, init] = mockFetchJson.mock.calls[0] ?? [];
    expect(url).toMatch(new RegExp(`^${URL}/api/v2/admin/users\\?`));
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
  });

  it('reads its identity from /system/identity and its version from /system/info, without the key', async () => {
    serve({ '/system/identity': silo.identity, '/system/info': silo.systemInfo });

    expect(await client().getServerIdentity()).toBe('6a0f3e1c-9b7d-4c52-8e14-2d5f7a9b0c31');
    expect(await client().getSoftwareVersion()).toBe('28dd1484');
    for (const [, init] of mockFetchJson.mock.calls) {
      expect(init?.headers).not.toHaveProperty('Authorization');
    }
  });

  it('logs the build and contract when first read, and again only when either changes', async () => {
    const url = 'http://silo-contract.local:8090';
    const digest = silo.systemInfo.contract_digest;
    const reads = [
      silo.systemInfo,
      silo.systemInfo,
      { ...silo.systemInfo, server_version: 'b71f0c2a' },
    ];
    serve({ '/system/info': () => reads.shift() });

    for (let i = 0; i < 3; i++) await client(url).getSoftwareVersion();

    expect(console.info).toHaveBeenCalledOnce();
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining(`Silo at ${url}: build 28dd1484, contract ${digest}`),
      ''
    );
    expect(console.warn).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `Silo at ${url} changed: build 28dd1484 to b71f0c2a, contract ${digest} to ${digest}`
      ),
      ''
    );
  });

  it('connects only when the key reads sessions', async () => {
    serve({ '/system/info': silo.systemInfo, '/admin/sessions': silo.sessions });
    expect(await client().testConnection()).toBe(true);

    serve({ '/system/info': silo.systemInfo, '/admin/sessions': httpError(401) });
    expect(await client().testConnection()).toBe(false);
  });

  it('reads profiles with no query, since Silo refuses parameters the endpoint does not declare', async () => {
    serve({ '/admin/users/34/profiles': silo.profiles['34'] });

    const profiles = await client().getAccountProfiles('34');

    expect(profiles.map((profile) => profile.name)).toEqual(['Viewer', 'Kid']);
    expect(requested('/profiles')).toEqual([`${URL}/api/v2/admin/users/34/profiles`]);
  });

  it('walks every page of a listing by its cursor', async () => {
    const [owner, viewer] = silo.users.items;
    serve({
      '/admin/users': (url: string) =>
        url.includes('cursor=c2')
          ? { items: [viewer], page: { has_more: false } }
          : { items: [owner], page: { has_more: true, next_cursor: 'c2' } },
    });

    const users = await client().getUsers();

    expect(users.map((user) => user.id)).toEqual(['1', '34']);
    const [first, second] = requested('/admin/users');
    expect(first).toContain('limit=200');
    expect(first).not.toContain('cursor=');
    expect(second).toContain('cursor=c2');
  });

  it('waits the Retry-After seconds on a 429, then reads the page again', async () => {
    vi.useFakeTimers();
    let reads = 0;
    serve({
      '/admin/users': () => {
        reads++;
        if (reads === 1) throw httpError(429, '1');
        return silo.users;
      },
    });

    const users = client().getUsers();
    await vi.advanceTimersByTimeAsync(999);
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect((await users).map((user) => user.id)).toEqual(['1', '34']);
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
  });

  it('fails on the fourth 429 in a row', async () => {
    vi.useFakeTimers();
    serve({ '/admin/users': httpError(429, '1') });

    const users = client().getUsers();
    const failed = expect(users).rejects.toMatchObject({ statusCode: 429 });
    await vi.advanceTimersByTimeAsync(3000);

    await failed;
    expect(mockFetchJson).toHaveBeenCalledTimes(4);
  });

  it('fails a 429 whose wait would take the waits of one call past ten seconds', async () => {
    vi.useFakeTimers();
    serve({ '/admin/users': httpError(429, '6') });

    const users = client().getUsers();
    const failed = expect(users).rejects.toMatchObject({ statusCode: 429 });
    await vi.advanceTimersByTimeAsync(6000);

    await failed;
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
  });

  it('names players from the device list, read again only after ten minutes or for an unknown device', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-20T12:00:00Z') });
    const url = 'http://silo-devices.local:8090';
    let sessions: object = silo.sessions;
    serve({ '/admin/sessions': () => sessions, '/admin/devices': silo.devices });

    expect((await client(url).getSessions()).map((s) => s.player.name)).toEqual([
      'Firefox on macOS',
      'iPhone',
    ]);
    vi.advanceTimersByTime(60_000);
    await client(url).getSessions();
    expect(requested('/admin/devices')).toHaveLength(1);

    const [row] = silo.sessions.items;
    sessions = { items: [{ ...row, device_id: 'b0d6e3f1-new-device' }], page: { has_more: false } };
    await client(url).getSessions();
    expect(requested('/admin/devices')).toHaveLength(2);

    sessions = silo.sessions;
    vi.advanceTimersByTime(11 * 60_000);
    await client(url).getSessions();
    expect(requested('/admin/devices')).toHaveLength(3);
  });

  it('lists only the latest started session an account holds on a device for an item', async () => {
    for (const items of [
      [pausedPlay, restartedPlay],
      [restartedPlay, pausedPlay],
    ]) {
      expect(await poll('http://silo-restart.local:8090', items)).toEqual([[RESTARTED, 'playing']]);
    }
  });

  it('drops a paused leftover after the session that replaced it ends, and plays a later start', async () => {
    const url = 'http://silo-leftover.local:8090';
    const later = play('5d1c0f7e-2b8a-4c39-9e61-0a4f7b3c8d12', '2026-11-21T04:20:00.000Z');

    expect(await poll(url, [pausedPlay, restartedPlay])).toEqual([[RESTARTED, 'playing']]);
    expect(await poll(url, [pausedPlay])).toEqual([]);
    expect(await poll(url, [])).toEqual([]);
    expect(await poll(url, [later])).toEqual([[later.session_id, 'playing']]);
  });

  it('never folds a session without a device id into another, nor one account on two devices', async () => {
    const noDevice = [
      play('9a3e5c71-0f2d-4b86-a1c4-7e9d2b6f5a03', '2026-11-21T04:05:10.120Z', { device_id: '' }),
      play('c8f1d2e4-6b7a-4935-8d0c-1e2f3a4b5c6d', '2026-11-21T04:05:13.480Z', { device_id: '' }),
    ];
    const twoDevices = [
      play('1b2c3d4e-5f60-4718-89ab-cdef01234567', '2026-11-21T04:05:10.120Z', {
        device_id: 'device-one',
      }),
      play('7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918', '2026-11-21T04:05:13.480Z', {
        device_id: 'device-two',
      }),
    ];

    for (const items of [noDevice, twoDevices]) {
      expect(await poll('http://silo-devices-apart.local:8090', items)).toHaveLength(2);
    }
  });

  it('lists sessions with client names when the device list cannot be read', async () => {
    serve({ '/admin/sessions': silo.sessions, '/admin/devices': httpError(500) });

    const sessions = await client('http://silo-no-devices.local:8090').getSessions();

    expect(sessions.map((s) => s.player.name)).toEqual(['Silo Web', 'Silo iPhone']);
    expect(console.warn).toHaveBeenCalled();
  });

  it('keeps the names last read through a failed device read, and waits a minute to read again', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-20T12:00:00Z') });
    const url = 'http://silo-devices-outage.local:8090';
    serve({ '/admin/sessions': silo.sessions, '/admin/devices': silo.devices });
    await client(url).getSessions();

    vi.advanceTimersByTime(11 * 60_000);
    serve({ '/admin/sessions': silo.sessions, '/admin/devices': httpError(500) });
    const sessions = await client(url).getSessions();
    expect(sessions.map((s) => s.player.name)).toEqual(['Firefox on macOS', 'iPhone']);
    expect(requested('/admin/devices')).toHaveLength(2);

    vi.advanceTimersByTime(30_000);
    await client(url).getSessions();
    expect(requested('/admin/devices')).toHaveLength(2);

    vi.advanceTimersByTime(31_000);
    await client(url).getSessions();
    expect(requested('/admin/devices')).toHaveLength(3);
  });

  it('narrows the sessions to one session key', async () => {
    serve({ '/admin/sessions': silo.sessions, '/admin/devices': silo.devices });

    const sessions = await client().getSessions('f3ce3512-e1a7-4855-a9f7-e5c022248eea');

    expect(sessions.map((s) => s.media.title)).toEqual(['Stick or Twist']);
  });

  it('stops a session with the reason, and names the key scope when Silo refuses', async () => {
    serve({ '/admin/sessions/session-1/terminate': { accepted: true } });

    await client().terminateSession('session-1', 'Too many streams');

    const [url, init] = mockFetchJson.mock.calls[0] ?? [];
    expect(url).toBe(`${URL}/api/v2/admin/sessions/session-1/terminate`);
    expect(init).toMatchObject({ method: 'POST', body: '{"reason":"Too many streams"}' });

    serve({ '/admin/sessions/session-1/terminate': httpError(403) });
    await expect(client().terminateSession('session-1')).rejects.toThrow(SILO_STOP_REFUSED);

    serve({ '/admin/sessions/session-1/terminate': httpError(404) });
    await expect(client().terminateSession('session-1')).rejects.toThrow(
      'Session not found (may have already ended)'
    );
  });

  it('reads a library once a sync and pages items, episodes and seasons from it', async () => {
    serve({ '/admin/catalog/items': silo.catalog['2'] });
    const syncClient = client();

    const items = await syncClient.getLibraryItems('2', { offset: 0, limit: 1 });
    const leaves = await syncClient.getLibraryLeaves('2');
    const seasons = await syncClient.getLibrarySeasons('2');

    expect(items).toMatchObject({ totalCount: 2, rawCount: 1 });
    expect(items.items).toHaveLength(1);
    expect(leaves.totalCount).toBe(3);
    expect(seasons.totalCount).toBe(2);
    const [listing] = requested('/admin/catalog/items');
    expect(requested('/admin/catalog/items')).toHaveLength(1);
    expect(listing).toContain('library_id=2');
    expect(listing).not.toContain('type=');
  });

  it('lists what was added since the cursor date, with no revision', async () => {
    serve({ '/admin/catalog/items': silo.catalog['2'] });
    const syncClient = client();
    const cursor = { kind: 'date' as const, since: new Date('2026-11-19T01:05:00Z') };

    const changed = await syncClient.getLibraryItemsSince('2', cursor);
    const leaves = await syncClient.getLibraryLeavesSince('2', cursor);

    const [listing = ''] = requested('/admin/catalog/items');
    expect(new globalThis.URL(listing).searchParams.get('added_after')).toBe(
      '2026-11-19T01:05:00.000Z'
    );
    expect(changed.feed).toBe(NOT_NEEDED);
    expect(changed.totalCount).toBe(2);
    expect(leaves.totalCount).toBe(3);
    expect(requested('/admin/catalog/items')).toHaveLength(1);
    expect(await syncClient.getLibraryRevision()).toBe(NOT_NEEDED);
  });

  it('finds which items are still in a library, 200 ids a read, never a season', async () => {
    const [movie] = silo.catalog['1'].items;
    serve({
      '/admin/catalog/items': (url: string) => ({
        items: new globalThis.URL(url).searchParams.getAll('content_ids').map((id) => ({
          ...movie,
          content_id: id,
          library_ids: id === 'movie-0' ? ['9'] : ['1'],
        })),
        page: { has_more: false },
      }),
    });
    const keys = [...Array.from({ length: 201 }, (_, i) => `movie-${i}`), 'series-x/season/1'];

    const found = await client().findExistingRatingKeys(keys, { id: '1', type: 'movies' });

    expect(requested('/admin/catalog/items')).toHaveLength(2);
    expect(requested('season')).toHaveLength(0);
    expect(found.size).toBe(200);
    expect(found.has('movie-0')).toBe(false);
    expect(found.has('movie-200')).toBe(true);
  });

  it('keeps a signed poster URL until ten minutes before it expires', async () => {
    const exp = 1795320000;
    vi.useFakeTimers({ now: (exp - 3600) * 1000 });
    const url = 'http://silo-poster-expiry.local:8090';
    const [movie] = silo.catalog['1'].items;
    serve({
      '/admin/catalog/items': (requestUrl: string) =>
        requestUrl.includes('content_ids=') ? { items: [movie] } : silo.catalog['1'],
    });
    const syncClient = client(url);
    await syncClient.getLibraryItems('1');

    expect(await syncClient.getPosterUrl('movie-imdb-tt0038650')).toBe(movie?.poster_url);
    expect(requested('content_ids=')).toHaveLength(0);

    vi.setSystemTime((exp - 590) * 1000);
    expect(await syncClient.getPosterUrl('movie-imdb-tt0038650')).toBe(movie?.poster_url);
    expect(requested('content_ids=')).toEqual([
      `${url}/api/v2/admin/catalog/items?content_ids=movie-imdb-tt0038650`,
    ]);
  });

  it("files an episode's poster under its series, and a session's under its item", async () => {
    vi.useFakeTimers({ now: (1795147200 - 3600) * 1000 });
    const url = 'http://silo-poster-fill.local:8090';
    serve({
      '/admin/catalog/items': silo.catalog['2'],
      '/admin/sessions': silo.sessions,
      '/admin/devices': silo.devices,
    });
    const syncClient = client(url);

    await syncClient.getLibraryLeaves('2');
    expect(await syncClient.getPosterUrl('series-imdb-tt0103359')).toBe(
      silo.catalog['2'].items.find((item) => item.content_id === 'series-imdb-tt0103359')
        ?.poster_url
    );
    await syncClient.getSessions();
    expect(await syncClient.getPosterUrl('episode-imdb-tt31510819-1-1')).toBe(
      silo.sessions.items[1]?.poster_url
    );

    expect(requested('content_ids=')).toHaveLength(0);
  });

  it('answers no poster for an item the catalog does not list, or a poster URL outside /api/v2/', async () => {
    const [movie] = silo.catalog['1'].items;
    serve({
      '/admin/catalog/items': (requestUrl: string) =>
        requestUrl.includes('movie-public')
          ? {
              items: [
                {
                  ...movie,
                  content_id: 'movie-public',
                  poster_url: `https://silo.example${movie?.poster_url}`,
                },
              ],
            }
          : { items: [] },
    });
    const posterClient = client('http://silo-poster-none.local:8090');

    expect(await posterClient.getPosterUrl('movie-gone')).toBeNull();
    expect(await posterClient.getPosterUrl('movie-public')).toBeNull();
    expect(requested('content_ids=')).toHaveLength(2);
  });

  it('answers requests NOT_NEEDED', async () => {
    expect(await client().getRequests()).toBe(NOT_NEEDED);
    expect(await client().getRequestPosterPath()).toBe(NOT_NEEDED);
    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});

describe('SiloClient.verifyServerAdmin', () => {
  it('accepts a key that reads sessions and libraries, opens a ticket and may stop streams', async () => {
    serve(verifyAnswers());

    expect(await SiloClient.verifyServerAdmin(KEY, URL)).toEqual({ success: true });
    const [, probe] = mockFetchJson.mock.calls.find(([url]) => url.includes(PROBE_SESSION)) ?? [];
    expect(probe).toMatchObject({ method: 'POST', body: '{"reason":"Tracearr key check"}' });
  });

  it.each(['/admin/sessions', '/events/ws-ticket', '/user/libraries', PROBE_SESSION])(
    'refuses a key that %s refuses, naming the three scopes',
    async (path) => {
      serve({ ...verifyAnswers(), [path]: httpError(403) });

      expect(await SiloClient.verifyServerAdmin(KEY, URL)).toEqual({
        success: false,
        code: SiloClient.AdminVerifyError.MISSING_SCOPES,
        message: expect.stringContaining(
          'admin:monitor:read, admin:sessions:control and libraries:read'
        ),
      });
    }
  );

  it('tells an unreachable server and a non-Silo address from a rejected key', async () => {
    serve({ ...verifyAnswers(), '/system/info': new TypeError('fetch failed') });
    expect(await SiloClient.verifyServerAdmin(KEY, URL)).toMatchObject({
      success: false,
      code: SiloClient.AdminVerifyError.CONNECTION_FAILED,
      message: `Cannot reach Silo server at ${URL}. fetch failed`,
    });

    serve({ ...verifyAnswers(), '/system/info': { ...silo.systemInfo, api_major: 1 } });
    expect(await SiloClient.verifyServerAdmin(KEY, URL)).toMatchObject({
      success: false,
      code: SiloClient.AdminVerifyError.CONNECTION_FAILED,
      message: `${URL} does not answer as a Silo server with API version 2.`,
    });

    serve({ ...verifyAnswers(), '/admin/sessions': httpError(401) });
    expect(await SiloClient.verifyServerAdmin(KEY, URL)).toMatchObject({
      success: false,
      code: SiloClient.AdminVerifyError.INVALID_KEY,
    });
  });
});
