import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as HttpModule from '../../../../utils/http.js';
import type * as ParserModule from '../parser.js';

vi.mock('../../../../utils/http.js', async (importActual) => {
  const actual = await importActual<typeof HttpModule>();
  return { ...actual, fetchJson: vi.fn() };
});
vi.mock('../parser.js', async (importActual) => {
  const actual = await importActual<typeof ParserModule>();
  return { ...actual, parseTofaShowChildren: vi.fn(actual.parseTofaShowChildren) };
});

import { fetchJson, HttpClientError } from '../../../../utils/http.js';
import tofa from '../../../../test/mediaServerResponses/tofa.json' with { type: 'json' };
import { FullSyncRequiredError } from '../../types.js';
import { TOFA_STOP_REFUSED, TofaClient } from '../client.js';
import { parseTofaShowChildren } from '../parser.js';

const mockFetchJson = vi.mocked(fetchJson);
const parsedShows = () => vi.mocked(parseTofaShowChildren).mock.calls.map(([detail]) => detail.id);

const URL = 'http://tofa.local:33333';
const ADMIN_KEY = 'tofa_8f2d6a0c1e5b7d9f';
const READ_ONLY_KEY = 'tofa_3b9e1c7a5d2f8e4b';

/** Answers each API path with its recorded response; any other request fails the test. */
function serve(responses: Record<string, unknown>) {
  mockFetchJson.mockImplementation(async (url, init) => {
    const path = url.replace(`${URL}/api/v1`, '');
    if (path === '/media/batch' && responses[path] === undefined) {
      const { ids } = JSON.parse(String(init?.body)) as { ids: string[] };
      return tofa.mediaBatch.filter((detail) => ids.includes(detail.id));
    }
    if (!(path in responses)) throw new Error(`unexpected request ${url}`);
    return responses[path];
  });
}

function httpError(statusCode: number): HttpClientError {
  return new HttpClientError({
    service: 'tofa',
    statusCode,
    statusText: 'error',
    url: `${URL}/api/v1/system/info`,
  });
}

function client(token = ADMIN_KEY) {
  return new TofaClient({ url: `${URL}/`, token });
}

beforeEach(() => {
  mockFetchJson.mockReset();
  vi.mocked(parseTofaShowChildren).mockClear();
});

describe('TofaClient', () => {
  it('sends the API key as a bearer token', async () => {
    serve({ '/system/info': tofa.systemInfo });

    await client().testConnection();

    const headers = mockFetchJson.mock.calls[0]?.[1]?.headers;
    expect(headers).toMatchObject({ Authorization: `Bearer ${ADMIN_KEY}` });
  });

  it('connects when the server answers and not when it rejects the key', async () => {
    serve({ '/system/info': tofa.systemInfo });
    expect(await client().testConnection()).toBe(true);

    mockFetchJson.mockRejectedValue(httpError(401));
    expect(await client().testConnection()).toBe(false);
  });

  it('reads its identity, version and watched rule from the system info', async () => {
    serve({ '/system/info': tofa.systemInfo });

    expect(await client().getServerIdentity()).toBe(tofa.systemInfo.server_id);
    expect(await client().getSoftwareVersion()).toBe('0.13.2');
    expect(await client().getWatchedRulePercent()).toBe(90);
  });

  it('maps users with their own email and the library access the cloud list grants', async () => {
    serve({ '/users': tofa.users, '/cloud/users': tofa.cloudUsers, '/profiles': tofa.profiles });

    expect(await client().getUsers()).toEqual([
      {
        id: 'b1e4c7a2-5d38-4f91-8a6c-2e7f0d3b9c14',
        username: 'morgan',
        email: 'morgan@example.com',
        isAdmin: true,
        isDisabled: false,
        sharedLibraries: undefined,
        cloudIdentityId: '0f8e2d6c-4a1b-4c97-b3e5-9d2a7f1c8e05',
        thumb: '/api/v1/profiles/avatars/astronaut.png',
      },
      {
        id: 'c9a3f6d1-8e24-4b57-a0c8-6d1e5f2a7b38',
        username: 'casey@example.net',
        email: undefined,
        isAdmin: false,
        isDisabled: true,
        sharedLibraries: ['e5b8d2f7-1a4c-4e93-b6d0-8f2a5c7e1b46'],
        cloudIdentityId: '1a7c3e9f-5b2d-4e80-a4f6-0c3b8e2d7a91',
        thumb: null,
      },
    ]);
  });

  it('keeps existing pictures when profiles cannot be read', async () => {
    mockFetchJson.mockImplementation(async (url) => {
      const path = url.replace(`${URL}/api/v1`, '');
      if (path === '/profiles') throw httpError(500);
      return path === '/users' ? tofa.users : tofa.cloudUsers;
    });

    const users = await client().getUsers();

    expect(users.map((u) => u.username)).toEqual(['morgan', 'casey@example.net']);
    expect(users.every((u) => u.thumb === undefined)).toBe(true);
  });

  it('names a tv library a show library', async () => {
    serve({ '/libraries': tofa.libraries });

    expect(await client().getLibraries()).toEqual([
      { id: 'e5b8d2f7-1a4c-4e93-b6d0-8f2a5c7e1b46', name: 'Movies', type: 'movie' },
      { id: 'f3c6a9e2-7b1d-4f85-9c2a-4e8b1d6f3a72', name: 'TV Shows', type: 'show' },
    ]);
  });

  it('reads the scopes of the key it calls with', async () => {
    serve({ '/auth/api-keys': tofa.apiKeys });

    expect(await client(ADMIN_KEY).getKeyScopes()).toEqual({
      readOnly: false,
      canStopStreams: true,
    });
    expect(await client(READ_ONLY_KEY).getKeyScopes()).toEqual({
      readOnly: true,
      canStopStreams: true,
    });
  });

  it('offers the version its update check found, and none while up to date', async () => {
    serve({ '/updates/status': tofa.updatesStatus });
    expect(await client().getUpdateVersion()).toBeNull();

    serve({
      '/updates/status': { ...tofa.updatesStatus, state: 'update_available', version: '0.14.0' },
    });
    expect(await client().getUpdateVersion()).toBe('0.14.0');
  });

  it("takes a requested title's poster as a cache path or a tofa cloud asset only", async () => {
    const detail = '/discovery/detail/tv/900101?local_images=true';
    const cloud =
      'https://api.tofa.tv/v1/metadata/assets/tmdb/title/0d/42/0d4252eba883956b9ec0de5c77520c2536237d76c128228f367b3a81f57f03a6.jpg';
    serve({
      [detail]: {
        poster_url: 'images/cloud/9445b39736f344069814b0ce085be83d_0f0542149027fa84.jpg',
      },
    });
    expect(await client().getRequestPosterPath('tv', 900101)).toBe(
      '/cache/images/cloud/9445b39736f344069814b0ce085be83d_0f0542149027fa84.jpg'
    );

    serve({ [detail]: { poster_url: cloud } });
    expect(await client().getRequestPosterPath('tv', 900101)).toBe(cloud);

    for (const poster_url of [
      'https://image.tmdb.org/t/p/w500/abc.jpg',
      '/abc.jpg',
      'https://example.com/abc.jpg',
      null,
    ]) {
      serve({ [detail]: { poster_url } });
      expect(await client().getRequestPosterPath('tv', 900101)).toBeNull();
    }
  });
});

describe('TofaClient sessions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges the session list with now-playing and the media each session plays', async () => {
    serve({
      '/system/playback/sessions': tofa.playbackSessions,
      '/system/activity/now-playing': tofa.nowPlaying,
      '/media/batch': tofa.mediaBatch,
    });

    const sessions = await client().getSessions();

    expect(sessions.map((s) => [s.media.type, s.player.platform])).toEqual([
      ['movie', 'web'],
      ['episode', 'web'],
      ['episode', 'ios'],
    ]);
    const batch = mockFetchJson.mock.calls.find(([url]) => url.endsWith('/media/batch'));
    expect(batch?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(batch?.[1]?.body))).toEqual({
      ids: [tofa.mediaBatch[0]?.id, tofa.mediaBatch[1]?.id],
    });
  });

  it('gives up on a session list that has not answered in 10 seconds', async () => {
    const { fetchJson: realFetchJson } = await vi.importActual<typeof HttpModule>(
      '../../../../utils/http.js'
    );
    mockFetchJson.mockImplementation(realFetchJson);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))
    );

    await expect(client().getSessions()).rejects.toThrow(
      'tofa request to /api/v1/system/playback/sessions timed out after 10s'
    );
  });

  it('lists sessions, undescribed, when now-playing cannot be read', async () => {
    serve({ '/system/playback/sessions': tofa.playbackSessions });

    const sessions = await client().getSessions();

    expect(sessions.map((s) => [s.sessionKey, s.mediaId, s.media.type])).toEqual(
      tofa.playbackSessions.map((row) => [row.session_id, '', 'unknown'])
    );
  });

  it('logs once why a session is read without its media, not on every read', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const [row] = tofa.playbackSessions;
    const described = {
      '/system/playback/sessions': [row],
      '/system/activity/now-playing': tofa.nowPlaying,
    };
    const omitted = {
      '/system/playback/sessions': [row],
      '/system/activity/now-playing': { ...tofa.nowPlaying, sessions: [] },
    };

    // The log remembers sessions by server URL, which other tests read too
    serve(described);
    await client().getSessions();
    info.mockClear();

    for (const responses of [omitted, omitted, described, described]) {
      serve(responses);
      await client().getSessions();
    }

    expect(info.mock.calls.map(([message]) => message)).toEqual([
      `[tofa-client] session ${row?.session_id} read without its media: now-playing does not list it`,
    ]);
    info.mockRestore();
  });

  it('does not log a session set aside for a newer one on its device as described again', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.stubEnv('LOG_LEVEL', 'debug');
    const [row] = tofa.playbackSessions;
    if (!row) throw new Error('the recording is missing a play');
    const newer = {
      ...row,
      session_id: '7e0f0000-3a1c-4d2e-9b5f-0000000000bb',
      created_at: '2099-01-01T00:00:00.000000000+00:00',
    };
    const nowPlaying = { ...tofa.nowPlaying, sessions: [] };

    serve({ '/system/playback/sessions': [row], '/system/activity/now-playing': nowPlaying });
    await client().getSessions();
    serve({
      '/system/playback/sessions': [row, newer],
      '/system/activity/now-playing': nowPlaying,
    });
    await client().getSessions();

    const logged = [...info.mock.calls, ...debug.mock.calls].map(([message]) => message);
    expect(logged).not.toContain(
      `[tofa-client] session ${row.session_id} read with its media again`
    );
    vi.unstubAllEnvs();
    info.mockRestore();
    debug.mockRestore();
  });

  it('keeps only the newest session a device holds for a file, since tofa lists abandoned ones', async () => {
    const [live] = tofa.playbackSessions;
    const abandoned = {
      ...live,
      session_id: '7e0f0000-3a1c-4d2e-9b5f-0000000000aa',
      created_at: '2025-03-14T19:20:41.120000000+00:00',
      is_paused: true,
    };
    serve({
      '/system/playback/sessions': [abandoned, ...tofa.playbackSessions],
      '/system/activity/now-playing': tofa.nowPlaying,
      '/media/batch': tofa.mediaBatch,
    });

    const sessions = await client().getSessions();

    expect(sessions.map((s) => s.sessionKey)).toEqual(
      tofa.playbackSessions.map((row) => row.session_id)
    );
  });

  it('asks for the live viewers only while a channel plays', async () => {
    serve({
      '/system/playback/sessions': tofa.playbackSessions,
      '/system/activity/now-playing': tofa.nowPlaying,
    });
    await client().getSessions();
    expect(mockFetchJson.mock.calls.map(([url]) => url)).not.toContain(
      `${URL}/api/v1/live/admin/now`
    );

    serve({
      '/system/playback/sessions': tofa.livePlaybackSessions,
      '/system/activity/now-playing': tofa.liveNowPlaying,
      '/live/admin/now': tofa.liveAdminNow,
    });
    const [channel] = await client().getSessions();
    expect(channel).toMatchObject({
      media: { type: 'live' },
      live: { channelTitle: 'Harbor Classics', channelIdentifier: '512' },
    });
  });

  it('lists a live viewer with no playback session from now-playing alone', async () => {
    const [viewer] = tofa.liveAdminNow.sessions;
    serve({
      '/system/playback/sessions': [],
      '/system/activity/now-playing': {
        sessions: [],
        live_sessions: [
          {
            session_id: 'live-session-1',
            viewer,
            platform: 'web',
            source: null,
            sent: null,
            transcode_reason_codes: [],
          },
        ],
      },
    });

    expect(await client().getSessions()).toMatchObject([
      { sessionKey: `viewer:${viewer?.viewer_id}`, media: { type: 'live' } },
    ]);
  });

  it('keeps listing a live viewer with no playback session while now-playing does not answer', async () => {
    const [viewer] = tofa.liveAdminNow.sessions;
    const live = {
      session_id: 'live-session-1',
      viewer,
      platform: 'web',
      source: null,
      sent: null,
      transcode_reason_codes: [],
    };
    serve({
      '/system/playback/sessions': [],
      '/system/activity/now-playing': { sessions: [], live_sessions: [live] },
    });
    await client().getSessions();

    serve({ '/system/playback/sessions': [] });

    expect(await client().getSessions()).toMatchObject([
      { sessionKey: `viewer:${viewer?.viewer_id}` },
    ]);
  });
});

describe('TofaClient.terminateSession', () => {
  const stop = vi.fn<typeof fetch>();

  beforeEach(() => {
    stop.mockReset();
    vi.stubGlobal('fetch', stop);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stops a playback with the message shown to the viewer', async () => {
    stop.mockResolvedValue(new Response(null, { status: 204 }));

    await client().terminateSession('session-1', 'Too many streams');

    const [url, init] = stop.mock.calls[0] ?? [];
    expect(url).toBe(`${URL}/api/v1/system/playback/sessions/session-1`);
    expect(init).toMatchObject({ method: 'DELETE', body: '{"message":"Too many streams"}' });
  });

  it('names the key scope when tofa refuses the stop', async () => {
    stop.mockResolvedValue(new Response(null, { status: 403 }));

    await expect(client().terminateSession('session-1')).rejects.toThrow(TOFA_STOP_REFUSED);
  });
});

describe('TofaClient.verifyServerAdmin', () => {
  it('accepts a key the server answers to', async () => {
    serve({ '/health': { status: 'ok' }, '/system/info': tofa.systemInfo });

    expect(await TofaClient.verifyServerAdmin(READ_ONLY_KEY, URL)).toEqual({ success: true });
  });

  it('tells an unreachable server from a rejected key', async () => {
    mockFetchJson.mockRejectedValue(new TypeError('fetch failed'));
    expect(await TofaClient.verifyServerAdmin(ADMIN_KEY, URL)).toMatchObject({
      success: false,
      code: TofaClient.AdminVerifyError.CONNECTION_FAILED,
    });

    const afterHealth = (error: Error) =>
      mockFetchJson.mockImplementation(async (url) => {
        if (url.endsWith('/health')) return { status: 'ok' };
        throw error;
      });

    afterHealth(httpError(401));
    expect(await TofaClient.verifyServerAdmin(ADMIN_KEY, URL)).toMatchObject({
      success: false,
      code: TofaClient.AdminVerifyError.INVALID_KEY,
    });

    afterHealth(httpError(500));
    expect(await TofaClient.verifyServerAdmin(ADMIN_KEY, URL)).toMatchObject({
      success: false,
      code: TofaClient.AdminVerifyError.CONNECTION_FAILED,
    });
  });
});

describe('TofaClient keys and sessions made through tofa cloud', () => {
  const SESSION = 'session-token-1';
  const call = vi.fn<typeof fetch>();

  beforeEach(() => {
    call.mockReset();
    vi.stubGlobal('fetch', call);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a read-only key that can stop streams with the session token', async () => {
    mockFetchJson.mockResolvedValue({ id: 'key-1', secret: 'tofa_abc123', key_prefix: 'tofa_abc' });

    expect(await TofaClient.createApiKey(`${URL}/`, SESSION)).toEqual({
      id: 'key-1',
      secret: 'tofa_abc123',
    });
    const [url, init] = mockFetchJson.mock.calls[0] ?? [];
    expect(url).toBe(`${URL}/api/v1/auth/api-keys`);
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: `Bearer ${SESSION}` },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'Tracearr',
      read_only: true,
      can_stop_streams: true,
    });
  });

  it('deletes a key by id and fails when tofa refuses', async () => {
    call.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await TofaClient.deleteApiKey(URL, SESSION, 'key-1');

    const [url, init] = call.mock.calls[0] ?? [];
    expect(url).toBe(`${URL}/api/v1/auth/api-keys/key-1`);
    expect(init).toMatchObject({
      method: 'DELETE',
      headers: { Authorization: `Bearer ${SESSION}` },
    });

    call.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(TofaClient.deleteApiKey(URL, SESSION, 'key-1')).rejects.toThrow();
  });

  it('logs the session out and says whether tofa accepted it', async () => {
    call.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await TofaClient.logoutSession(URL, SESSION)).toBe(true);
    expect(call.mock.calls[0]?.[0]).toBe(`${URL}/api/v1/auth/session/logout`);
    expect(call.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: `Bearer ${SESSION}` },
    });

    call.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await TofaClient.logoutSession(URL, SESSION)).toBe(false);
  });

  it('probes an address as reachable when the system info answers with or without a key', async () => {
    call.mockResolvedValueOnce(Response.json({ version: '0.13.3' }));
    expect(await TofaClient.probe(URL)).toBe(true);
    expect(call.mock.calls[0]?.[0]).toBe(`${URL}/api/v1/system/info`);

    call.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await TofaClient.probe(URL)).toBe(true);

    call.mockResolvedValueOnce(new Response('not tofa', { status: 404 }));
    expect(await TofaClient.probe(URL)).toBe(false);

    call.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await TofaClient.probe(URL)).toBe(false);
  });

  it('never probes a link-local address', async () => {
    expect(await TofaClient.probe('http://169.254.169.254:33333')).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('TofaClient downloads', () => {
  it('describes a download the download list just named without reading it again', async () => {
    serve({ '/system/downloads?limit=100': tofa.downloads });
    const [download] = tofa.downloads.items;

    const listed = await client().getDownloadsAfter(new Date(0));
    mockFetchJson.mockClear();
    const description = await client().describeDownloadSource({
      itemKey: null,
      partId: download?.media_file_id ?? null,
      deviceId: download?.device_id ?? null,
      userId: download?.user_id ?? null,
      app: null,
      device: null,
    });

    expect(listed.map(({ media }) => media?.title)).toEqual(['Harbor Lights']);
    expect(description.version?.key).toBe(download?.media_file_id);
    expect(description.delivered?.bitrateKbps).toEqual(expect.any(Number));
    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});

describe('TofaClient library', () => {
  const MOVIES = 'e5b8d2f7-1a4c-4e93-b6d0-8f2a5c7e1b46';
  const SHOWS = 'f3c6a9e2-7b1d-4f85-9c2a-4e8b1d6f3a72';
  const [movie, show] = tofa.mediaBatch;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pages the listing with a page size that divides the offset, reading details in batches', async () => {
    serve({ [`/media?library_id=${MOVIES}&page=2&per_page=100`]: tofa.mediaPages[MOVIES] });

    const page = await client().getLibraryItems(MOVIES, { offset: 100, limit: 300 });

    expect(page).toMatchObject({ totalCount: 1, rawCount: 1 });
    expect(page.items.map((item) => item.ratingKey)).toEqual([movie?.id]);
  });

  it("lists a show library's episodes from its files, with the seasons on the first page", async () => {
    serve({
      [`/media/files?library_id=${SHOWS}&limit=1000`]: tofa.libraryFiles[SHOWS],
    });
    const tofaClient = client();

    const first = await tofaClient.getLibraryLeaves(SHOWS, { offset: 0, limit: 1 });
    const second = await tofaClient.getLibraryLeaves(SHOWS, { offset: 1, limit: 1 });

    expect(first.totalCount).toBe(2);
    expect(first.items.map((item) => [item.mediaType, item.parentIndex])).toEqual([
      ['season', 1],
      ['season', 3],
      ['episode', 1],
    ]);
    expect(second.items.map((item) => [item.mediaType, item.parentIndex])).toEqual([
      ['episode', 3],
    ]);
    const filesReads = mockFetchJson.mock.calls.filter(([url]) => url.includes('/media/files'));
    expect(filesReads).toHaveLength(1);
  });

  it('reads each show once a sync, the episode listing taking the shows the library listing read', async () => {
    serve({
      [`/media?library_id=${SHOWS}&page=1&per_page=200`]: tofa.mediaPages[SHOWS],
      [`/media/files?library_id=${SHOWS}&limit=1000`]: tofa.libraryFiles[SHOWS],
    });
    const tofaClient = client();

    await tofaClient.getLibraryItems(SHOWS, { offset: 0, limit: 200 });
    const first = await tofaClient.getLibraryLeaves(SHOWS, { offset: 0, limit: 1 });
    const second = await tofaClient.getLibraryLeaves(SHOWS, { offset: 1, limit: 1 });

    expect([...first.items, ...second.items].map((item) => item.mediaType)).toEqual([
      'season',
      'season',
      'episode',
      'episode',
    ]);
    const batchReads = mockFetchJson.mock.calls.filter(([url]) => url.endsWith('/media/batch'));
    expect(batchReads).toHaveLength(1);
  });

  it('holds 50,000 episodes from the library listing and reads the shows past them again', async () => {
    const [season] = show?.seasons ?? [];
    const [episode] = season?.episodes ?? [];
    const [file] = show?.files ?? [];
    const [listedFile] = tofa.libraryFiles[SHOWS].items;
    if (!show || !season || !episode || !file || !listedFile) {
      throw new Error('the recording is missing a show');
    }
    const bigId = '7e0f0000-3a1c-4d2e-9b5f-0000000000ff';
    const episodes = Array.from({ length: 50_000 }, (_, i) => ({
      ...episode,
      id: `big-episode-${i}`,
      episode_number: i + 1,
    }));
    const big = {
      ...show,
      id: bigId,
      seasons: [{ ...season, episodes }],
      files: episodes.map((e, i) => ({ ...file, id: `big-file-${i}`, episode_id: e.id })),
    };
    const listedFiles = [
      ...tofa.libraryFiles[SHOWS].items,
      ...big.files.map((f, i) => ({
        ...listedFile,
        media_file_id: f.id,
        media_id: bigId,
        episode_id: f.episode_id,
        season_number: season.season_number,
        episode_number: i + 1,
      })),
    ];
    mockFetchJson.mockImplementation(async (url, init) => {
      const path = url.replace(`${URL}/api/v1`, '');
      if (path.startsWith('/media/files')) return { items: listedFiles, next_after: null };
      if (path === '/media/batch') {
        const { ids } = JSON.parse(String(init?.body)) as { ids: string[] };
        return [big, show].filter((detail) => ids.includes(detail.id));
      }
      return { items: [{ id: bigId }, { id: show.id }], total: 2 };
    });
    const tofaClient = client();

    await tofaClient.getLibraryItems(SHOWS, { offset: 0, limit: 200 });
    const leaves = await tofaClient.getLibraryLeaves(SHOWS, { offset: 0, limit: 50_002 });

    expect(leaves.items.filter((item) => item.mediaType === 'episode')).toHaveLength(50_002);
    const batchIds = mockFetchJson.mock.calls
      .filter(([url]) => url.endsWith('/media/batch'))
      .map(([, init]) => (JSON.parse(String(init?.body)) as { ids: string[] }).ids);
    expect(batchIds).toEqual([[bigId, show.id], [show.id]]);
    expect(parsedShows()).toEqual([bigId, show.id]);
  }, 30_000);

  it('parses a show the count read held once, when the listing lists it again', async () => {
    serve({
      [`/media?library_id=${SHOWS}&page=1&per_page=1`]: tofa.mediaPages[SHOWS],
      [`/media?library_id=${SHOWS}&page=1&per_page=200`]: tofa.mediaPages[SHOWS],
    });
    const tofaClient = client();

    await tofaClient.getLibraryItems(SHOWS, { offset: 0, limit: 1 });
    await tofaClient.getLibraryItems(SHOWS, { offset: 0, limit: 200 });

    expect(parsedShows()).toEqual([show?.id]);
  });

  it('gives a batch of library details two minutes, the time 12 MB takes at 1 Mbit/s', async () => {
    const { fetchJson: realFetchJson } = await vi.importActual<typeof HttpModule>(
      '../../../../utils/http.js'
    );
    mockFetchJson.mockImplementation(async (url, init) =>
      url.endsWith('/media/batch') ? realFetchJson(url, init) : tofa.mediaPages[MOVIES]
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))
    );

    await expect(client().getLibraryItems(MOVIES, { offset: 0, limit: 200 })).rejects.toThrow(
      'tofa request to /api/v1/media/batch timed out after 120s'
    );
  });

  it('reads changes after a revision: changed media whole, deletions by id, the next revision', async () => {
    serve({
      '/media/changes?since_revision=117&limit=10000': tofa.mediaChanges,
      [`/media?library_id=${SHOWS}&page=1&per_page=1`]: tofa.mediaPages[SHOWS],
    });

    const changes = await client().getLibraryItemsSince(SHOWS, { kind: 'revision', since: 117 });

    expect(changes.feed).toEqual({
      deletedIds: ['7e0f0000-3a1c-4d2e-9b5f-000000000010'],
      wholeIds: [show?.id],
      revision: 120,
    });
    expect(changes.totalCount).toBe(1);
    expect(changes.items.map((item) => item.mediaType)).toEqual([
      'show',
      'season',
      'season',
      'episode',
      'episode',
    ]);
  });

  it('asks for a full sync, applying nothing, when tofa no longer holds every change', async () => {
    serve({ '/media/changes?since_revision=3&limit=10000': tofa.mediaChangesFullSync });

    await expect(
      client().getLibraryItemsSince(SHOWS, { kind: 'revision', since: 3 })
    ).rejects.toBeInstanceOf(FullSyncRequiredError);
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });

  it('asks for a full sync, reading no changed media, when more of the library changed than a sync takes', async () => {
    serve({
      '/media/changes?since_revision=117&limit=10000': {
        ...tofa.mediaChanges,
        changes: [1, 2, 3, 4].map((n) => ({
          revision: 117 + n,
          media_id: `7e0f0000-3a1c-4d2e-9b5f-00000000010${n}`,
          library_id: SHOWS,
          change_kind: 'upsert',
        })),
      },
      [`/media?library_id=${SHOWS}&page=1&per_page=1`]: { ...tofa.mediaPages[SHOWS], total: 10 },
    });

    await expect(
      client().getLibraryItemsSince(SHOWS, { kind: 'revision', since: 117 })
    ).rejects.toBeInstanceOf(FullSyncRequiredError);
    expect(mockFetchJson.mock.calls.some(([url]) => url.endsWith('/media/batch'))).toBe(false);
  });

  it('reports whether each file is on disk, keyed by movie or episode', async () => {
    serve({
      '/libraries': tofa.libraries,
      [`/media/files?library_id=${MOVIES}&limit=1000`]: tofa.libraryFiles[MOVIES],
      [`/media/files?library_id=${SHOWS}&limit=1000`]: {
        ...tofa.libraryFiles[SHOWS],
        items: tofa.libraryFiles[SHOWS].items.map((file, i) => ({ ...file, available: i > 0 })),
      },
    });
    const [gone, kept] = tofa.libraryFiles[SHOWS].items;

    const existence = await client().checkFilesExist([
      movie?.id ?? '',
      gone?.episode_id ?? '',
      kept?.episode_id ?? '',
    ]);

    expect(existence.get(movie?.id ?? '')?.get(movie?.files[0]?.id ?? '')).toBe(true);
    expect(existence.get(gone?.episode_id ?? '')?.get(gone?.media_file_id ?? '')).toBe(false);
    expect(existence.get(kept?.episode_id ?? '')?.get(kept?.media_file_id ?? '')).toBe(true);
  });

  it('reads no library past the one that held the last file asked about', async () => {
    serve({
      '/libraries': tofa.libraries,
      [`/media/files?library_id=${MOVIES}&limit=1000`]: tofa.libraryFiles[MOVIES],
    });

    const existence = await client().checkFilesExist([movie?.id ?? '']);

    expect(existence.get(movie?.id ?? '')?.get(movie?.files[0]?.id ?? '')).toBe(true);
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
  });
});
