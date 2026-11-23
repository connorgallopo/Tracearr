import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as HttpModule from '../../../../utils/http.js';

vi.mock('../../../../utils/http.js', async (importActual) => {
  const actual = await importActual<typeof HttpModule>();
  return { ...actual, fetchJson: vi.fn() };
});

import { fetchJson, HttpClientError } from '../../../../utils/http.js';
import silo from '../../../../test/mediaServerResponses/silo.json' with { type: 'json' };
import { NOT_NEEDED } from '../../types.js';
import {
  SILO_MESSAGE_STALE,
  SILO_MESSAGE_UNDELIVERED,
  SILO_STOP_REFUSED,
  SiloClient,
} from '../client.js';

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

function httpError(statusCode: number, retryAfter?: string, headers?: Headers): HttpClientError {
  return new HttpClientError({
    service: 'silo',
    statusCode,
    statusText: 'error',
    url: URL,
    retryAfter,
    headers,
  });
}

function client(url = URL) {
  return new SiloClient({ url: `${url}/`, token: KEY });
}

const requested = (path: string) =>
  mockFetchJson.mock.calls.map(([url]) => url).filter((url) => url.includes(path));

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
const restartedPlay = play('a613750c-52f6-4ef2-b2a8-616135598312', '2026-11-21T04:05:13.480Z');

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

  it("reads a page of playback history at Silo's page size, with the ended_after bound and the cursor", async () => {
    serve({ '/admin/playback-history': silo.history });

    expect(await client().getPlaybackHistoryPage(null, null)).toEqual(silo.history);
    expect(await client().getPlaybackHistoryPage(new Date('2026-11-21T18:00:00Z'), 'c2')).toEqual(
      silo.history
    );

    expect(requested('/admin/playback-history')).toEqual([
      `${URL}/api/v2/admin/playback-history?limit=200`,
      `${URL}/api/v2/admin/playback-history?limit=200&ended_after=2026-11-21T18%3A00%3A00.000Z&cursor=c2`,
    ]);
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

  it('lists a paused leftover and the newer session on its device, as Silo lists them', async () => {
    for (const items of [
      [pausedPlay, restartedPlay],
      [restartedPlay, pausedPlay],
    ]) {
      expect(await poll('http://silo-restart.local:8090', items)).toEqual(
        items.map((row) => [row.session_id, row.is_paused ? 'paused' : 'playing'])
      );
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

  it('names the devices history rows hold, and none for a device the list does not name', async () => {
    serve({ '/admin/devices': silo.devices });

    const names = await client('http://silo-history-devices.local:8090').getDeviceNames([
      'aef454b9-44e6-412f-913b-3e3a5eb0dbee',
      'tracearr-check-device-5',
    ]);

    expect(names.get('aef454b9-44e6-412f-913b-3e3a5eb0dbee')).toBe('iPhone');
    expect(names.has('tracearr-check-device-5')).toBe(false);
  });

  it('reads the device list once for a device it does not name, until the names are read again', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-20T12:00:00Z') });
    serve({ '/admin/devices': silo.devices });
    const devices = client('http://silo-unlisted-device.local:8090');

    await devices.getDeviceNames(['tracearr-check-device-5']);
    await devices.getDeviceNames([
      'tracearr-check-device-5',
      'aef454b9-44e6-412f-913b-3e3a5eb0dbee',
    ]);
    expect(requested('/admin/devices')).toHaveLength(1);

    await devices.getDeviceNames(['b0d6e3f1-new-device']);
    expect(requested('/admin/devices')).toHaveLength(2);
    await devices.getDeviceNames(['tracearr-check-device-5']);
    expect(requested('/admin/devices')).toHaveLength(2);

    vi.advanceTimersByTime(11 * 60_000);
    await devices.getDeviceNames(['tracearr-check-device-5']);
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

  it('mints a socket ticket with the key', async () => {
    const ticket = {
      ticket: 'ticket-1',
      expires_in: 30,
      max_connection_seconds: 14400,
      protocol: 'silo.events.v2',
    };
    serve({ '/events/ws-ticket': ticket });

    expect(await client().getSocketTicket()).toEqual(ticket);
    const [url, init] = mockFetchJson.mock.calls[0] ?? [];
    expect(url).toBe(`${URL}/api/v2/events/ws-ticket`);
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: `Bearer ${KEY}` } });
  });

  it("sends a message once with a fresh command id, the time as its sequence, and Silo's length limits", async () => {
    vi.useFakeTimers({ now: 1795282810496 });
    serve({ '/admin/sessions/session-1/message': { status: 'applied' } });

    await client().sendMessage('session-1', 'x'.repeat(3000), 'Tracearr');

    expect(mockFetchJson).toHaveBeenCalledOnce();
    const [url, init] = mockFetchJson.mock.calls[0] ?? [];
    expect(url).toBe(`${URL}/api/v2/admin/sessions/session-1/message`);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body.command_id).toHaveLength(36);
    expect(body).toMatchObject({ sequence: 1795282810496, title: 'Tracearr' });
    expect(body.message).toBe('x'.repeat(2048));
  });

  it('cuts a message and its title on characters, never inside an emoji', async () => {
    serve({ '/admin/sessions/session-1/message': { status: 'applied' } });

    await client().sendMessage(
      'session-1',
      `${'x'.repeat(2047)}\u{1F600}y`,
      `${'t'.repeat(255)}\u{1F600}\u{1F600}`
    );

    const [, init] = mockFetchJson.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.message).toBe(`${'x'.repeat(2047)}\u{1F600}`);
    expect(body.title).toBe(`${'t'.repeat(255)}\u{1F600}`);
  });

  it('names why a message did not reach the player', async () => {
    serve({ '/admin/sessions/session-1/message': httpError(409) });
    await expect(client().sendMessage('session-1', 'hi')).rejects.toThrow(SILO_MESSAGE_UNDELIVERED);

    serve({
      '/admin/sessions/session-1/message': httpError(
        409,
        undefined,
        new Headers({ 'X-Silo-Latest-Sequence': '1795282810497' })
      ),
    });
    await expect(client().sendMessage('session-1', 'hi')).rejects.toThrow(SILO_MESSAGE_STALE);
    expect(requested('/message')).toHaveLength(2);

    serve({ '/admin/sessions/session-1/message': httpError(404) });
    await expect(client().sendMessage('session-1', 'hi')).rejects.toThrow(
      'Session not found (may have already ended)'
    );

    serve({ '/admin/sessions/session-1/message': httpError(500) });
    await expect(client().sendMessage('session-1', 'hi')).rejects.toThrow(
      'Failed to send the message: 500'
    );
  });

  it('reads downloads created after a time, stopping at the first page that reaches back past it', async () => {
    serve({
      '/admin/downloads/entries': (url: string) =>
        url.includes('cursor=c2')
          ? { items: [], page: { has_more: false } }
          : { ...silo.downloadEntries, page: { has_more: true, next_cursor: 'c2' } },
    });
    const downloadsClient = client('http://silo-downloads-after.local:8090');

    const recent = await downloadsClient.getDownloadsAfter(new Date('2026-11-19T12:00:00Z'));

    expect(recent.map((entry) => entry.title)).toEqual(['Pushpa 2 - The Rule', 'MobLand']);
    expect(requested('/admin/downloads/entries')).toEqual([
      'http://silo-downloads-after.local:8090/api/v2/admin/downloads/entries?limit=200',
    ]);

    await downloadsClient.getDownloadsAfter(new Date('2026-11-01T00:00:00Z'));
    expect(requested('cursor=c2')).toHaveLength(1);
  });

  it("describes a download a device made twice by the newest one's address", async () => {
    vi.useFakeTimers({ now: new Date('2026-11-21T18:00:00Z') });
    const [newest] = silo.downloadEntries.items;
    if (!newest) throw new Error('the fixture has no download entry');
    const earlier = {
      ...newest,
      id: '153034427977439379',
      created_at: '2026-11-21T09:00:00.000Z',
      created_client_ip: '203.0.113.24',
    };
    serve({ '/admin/downloads/entries': { items: [newest, earlier], page: { has_more: false } } });
    const downloadsClient = client('http://silo-downloads-twice.local:8090');
    await downloadsClient.getDownloadsAfter(new Date('2026-11-01T00:00:00Z'));

    const described = await downloadsClient.describeDownloadSource({
      deviceId: newest.device_id,
      itemKey: newest.content_id,
      partId: null,
      userId: newest.user_id,
      app: null,
      device: null,
    });

    expect(described.ipAddress).toBe('192.168.1.50');
  });

  it('describes a listed download without a request, and an unlisted one with no address', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-21T18:00:00Z') });
    serve({ '/admin/downloads/entries': silo.downloadEntries });
    const downloadsClient = client('http://silo-downloads-describe.local:8090');
    await downloadsClient.getDownloadsAfter(new Date('2026-11-01T00:00:00Z'));
    const request = {
      deviceId: 'tracearr-check-device-3',
      itemKey: 'movie-imdb-tt16539454',
      partId: null,
      userId: '34',
      app: null,
      device: null,
    };

    const listed = await downloadsClient.describeDownloadSource(request);
    expect(listed.ipAddress).toBe('192.168.1.50');
    expect(listed.delivered?.bytes).toBe(4456899079);
    expect(mockFetchJson).toHaveBeenCalledOnce();

    expect(
      (await downloadsClient.describeDownloadSource({ ...request, deviceId: 'another-device' }))
        .ipAddress
    ).toBeNull();

    vi.advanceTimersByTime(6 * 60_000);
    expect((await downloadsClient.describeDownloadSource(request)).ipAddress).toBeNull();
  });

  it("describes an episode download by the episode's id, the key its recorded download carries", async () => {
    vi.useFakeTimers({ now: new Date('2026-11-21T18:00:00Z') });
    serve({ '/admin/downloads/entries': silo.downloadEntries });
    const downloadsClient = client('http://silo-downloads-episode.local:8090');
    await downloadsClient.getDownloadsAfter(new Date('2026-11-01T00:00:00Z'));
    const request = {
      deviceId: 'aef454b9-44e6-412f-913b-3e3a5eb0dbee',
      itemKey: 'episode-imdb-tt31510819-1-1',
      partId: null,
      userId: '1',
      app: null,
      device: null,
    };

    expect((await downloadsClient.describeDownloadSource(request)).ipAddress).toBe('203.0.113.24');
    expect(
      (
        await downloadsClient.describeDownloadSource({
          ...request,
          itemKey: 'series-imdb-tt31510819',
        })
      ).ipAddress
    ).toBeNull();
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

  it('lists a season as added since the cursor only when its earliest episode was, dated by it', async () => {
    const listed = silo.catalog['2'].items;
    serve({
      '/admin/catalog/items': (url: string) => {
        const after = new globalThis.URL(url).searchParams.get('added_after');
        return {
          items: after ? listed.filter((item) => item.added_at >= after) : listed,
          page: { has_more: false },
        };
      },
    });
    const since = (iso: string) => ({ kind: 'date' as const, since: new Date(iso) });
    const seasonsSince = async (iso: string) =>
      (await client().getLibrarySeasonsSince('2', since(iso))).items.map((season) => [
        season.ratingKey,
        season.addedAt.toISOString(),
      ]);

    expect(await seasonsSince('2026-11-19T01:06:09.000Z')).toEqual([]);
    expect(await seasonsSince('2026-11-19T01:06:00.000Z')).toEqual([
      ['series-imdb-tt0052520/season/1', '2026-11-19T01:06:08.996Z'],
    ]);
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

  it('remembers for five minutes that the catalog lists no poster for an id', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-20T12:00:00Z') });
    const [movie] = silo.catalog['1'].items;
    let listed: object[] = [];
    serve({ '/admin/catalog/items': () => ({ items: listed }) });
    const posterClient = client('http://silo-poster-negative.local:8090');

    expect(await posterClient.getPosterUrl('movie-imdb-tt0038650')).toBeNull();
    listed = [movie ?? {}];
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(await posterClient.getPosterUrl('movie-imdb-tt0038650')).toBeNull();
    expect(requested('content_ids=')).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(await posterClient.getPosterUrl('movie-imdb-tt0038650')).toBe(movie?.poster_url);
    expect(requested('content_ids=')).toHaveLength(2);
  });

  it('waits at most two seconds on 429s for a poster, which holds an image fetch slot', async () => {
    vi.useFakeTimers();
    serve({ '/admin/catalog/items': httpError(429, '1') });

    const poster = client('http://silo-poster-busy.local:8090').getPosterUrl(
      'movie-imdb-tt0038650'
    );
    const failed = expect(poster).rejects.toMatchObject({ statusCode: 429 });
    await vi.advanceTimersByTimeAsync(2000);

    await failed;
    expect(mockFetchJson).toHaveBeenCalledTimes(3);
  });

  it('reports requests turned off from the counts without listing them', async () => {
    serve({
      '/system/info': silo.systemInfo,
      '/admin/requests/counts': { ...silo.requestCounts, requests_enabled: false },
      '/admin/requests': silo.requests,
    });

    await expect(client().getRequests()).resolves.toEqual({
      requestsOn: false,
      version: '28dd1484',
    });
    expect(requested('/admin/requests?')).toEqual([]);
  });

  it('lists requests when a Silo build too old to report the flag leaves it out', async () => {
    const { requests_enabled: _omitted, ...counts } = silo.requestCounts;
    serve({
      '/system/info': silo.systemInfo,
      '/admin/requests/counts': counts,
      '/admin/users': silo.users,
      '/admin/requests': silo.requests,
    });

    const answer = await client().getRequests();

    expect(answer).toMatchObject({ requestsOn: true, version: '28dd1484' });
    const requests = answer.requestsOn ? answer.requests : [];
    expect(requests.map((r) => r.remoteId)).toEqual(['101', '102', '103', '104', '105']);
  });

  it('walks every page of requests, fifty at a time, with account names', async () => {
    const { items } = silo.requests;
    serve({
      '/system/info': silo.systemInfo,
      '/admin/requests/counts': silo.requestCounts,
      '/admin/users': silo.users,
      '/admin/requests': (url) =>
        url.includes('cursor=c2')
          ? { items: items.slice(3), page: { has_more: false } }
          : { items: items.slice(0, 3), page: { has_more: true, next_cursor: 'c2' } },
    });

    const answer = await client().getRequests();

    expect(requested('/admin/requests?')).toEqual([
      `${URL}/api/v2/admin/requests?limit=50`,
      `${URL}/api/v2/admin/requests?limit=50&cursor=c2`,
    ]);
    expect(answer).toMatchObject({ requestsOn: true, version: '28dd1484' });
    const requests = answer.requestsOn ? answer.requests : [];
    expect(requests.map((r) => r.remoteId)).toEqual(['101', '102', '103', '104', '105']);
    expect(requests.find((r) => r.remoteId === '101')?.remoteUsername).toBe('viewer');
  });

  it('keeps answering NOT_NEEDED for a poster lookup', async () => {
    expect(await client().getRequestPosterPath()).toBe(NOT_NEEDED);
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
        message: expect.stringMatching(
          /admin:monitor:read, admin:sessions:control and libraries:read\. An unscoped admin key does not work/
        ),
      });
    }
  );

  it('logs the build and contract the system info gives when a key is checked', async () => {
    const url = 'http://silo-verify-contract.local:8090';
    serve(verifyAnswers());

    await SiloClient.verifyServerAdmin(KEY, url);

    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining(
        `Silo at ${url}: build 28dd1484, contract ${silo.systemInfo.contract_digest}`
      ),
      ''
    );
  });

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
