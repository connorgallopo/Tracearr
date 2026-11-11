import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as HttpModule from '../../../../utils/http.js';

vi.mock('../../../../utils/http.js', async (importActual) => {
  const actual = await importActual<typeof HttpModule>();
  return { ...actual, fetchJson: vi.fn() };
});
vi.mock('../../../../lib/redisShared.js', () => {
  const store = new Map<string, string>();
  const redis = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => store.set(key, value),
  };
  return { getRedis: () => redis };
});

import { fetchJson, HttpClientError } from '../../../../utils/http.js';
import { EmbyClient } from '../client.js';

const mockFetchJson = vi.mocked(fetchJson);

const URL = 'http://emby.local:8096';

function httpError(statusCode: number): HttpClientError {
  return new HttpClientError({
    service: 'emby',
    statusCode,
    statusText: 'error',
    url: `${URL}/x`,
  });
}

function sequence(...steps: Array<{ resolve?: unknown; reject?: Error }>) {
  let call = 0;
  mockFetchJson.mockImplementation(async () => {
    const step = steps[call++];
    if (!step) throw new Error('unexpected fetchJson call');
    if (step.reject) throw step.reject;
    return step.resolve;
  });
}

describe('EmbyClient.verifyServerAdmin', () => {
  beforeEach(() => {
    mockFetchJson.mockReset();
  });

  it('sends the Emby authorization header and probes the public info endpoint first', async () => {
    sequence(
      { resolve: {} },
      { resolve: { Id: 'u1', Name: 'a', Policy: { IsAdministrator: true } } }
    );

    await EmbyClient.verifyServerAdmin('key', URL);

    expect(mockFetchJson.mock.calls[0]?.[0]).toBe(`${URL}/System/Info/Public`);
    const usersMeCall = mockFetchJson.mock.calls[1];
    const headers = (usersMeCall?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Emby-Authorization']).toContain('MediaBrowser');
  });

  it('succeeds for an admin user token via /Users/Me', async () => {
    sequence(
      { resolve: {} },
      { resolve: { Id: 'u1', Name: 'a', Policy: { IsAdministrator: true } } }
    );

    expect(await EmbyClient.verifyServerAdmin('key', URL)).toEqual({ success: true });
  });

  it('returns NOT_ADMIN for a non-admin user token', async () => {
    sequence(
      { resolve: {} },
      { resolve: { Id: 'u1', Name: 'a', Policy: { IsAdministrator: false } } }
    );

    expect(await EmbyClient.verifyServerAdmin('key', URL)).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.NOT_ADMIN,
    });
  });

  it('succeeds for an admin API key via /Auth/Keys after /Users/Me answers 500', async () => {
    sequence({ resolve: {} }, { reject: httpError(500) }, { resolve: {} });

    expect(await EmbyClient.verifyServerAdmin('key', URL)).toEqual({ success: true });
  });

  it('returns INVALID_KEY when /Users/Me answers 401', async () => {
    sequence({ resolve: {} }, { reject: httpError(401) });

    expect(await EmbyClient.verifyServerAdmin('bad', URL)).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.INVALID_KEY,
    });
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
  });

  it('returns INVALID_KEY when /Auth/Keys answers 401', async () => {
    sequence({ resolve: {} }, { reject: httpError(500) }, { reject: httpError(401) });

    expect(await EmbyClient.verifyServerAdmin('bad', URL)).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.INVALID_KEY,
    });
  });

  it('returns NOT_ADMIN when /Auth/Keys answers 403', async () => {
    sequence({ resolve: {} }, { reject: httpError(500) }, { reject: httpError(403) });

    expect(await EmbyClient.verifyServerAdmin('key', URL)).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.NOT_ADMIN,
    });
  });

  it('returns CONNECTION_FAILED when the server is unreachable', async () => {
    sequence({ reject: new Error('ECONNREFUSED') });

    expect(await EmbyClient.verifyServerAdmin('key', URL)).toMatchObject({
      success: false,
      code: EmbyClient.AdminVerifyError.CONNECTION_FAILED,
    });
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });
});

describe('EmbyClient member sign-in', () => {
  beforeEach(() => {
    mockFetchJson.mockReset();
  });

  it('posts Pw with the Emby authorization header', async () => {
    sequence({ resolve: { User: { Id: 'ext-1' }, AccessToken: 'member-token' } });

    const auth = await EmbyClient.authenticateByName(URL, 'alice', 'pw', 'tracearr-u1', '');

    expect(auth).toEqual({ externalId: 'ext-1', token: 'member-token' });
    const [, options] = mockFetchJson.mock.calls[0] ?? [];
    const headers = (options?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Emby-Authorization']).toMatch(/^Emby /);
    expect(headers['X-Emby-Authorization']).toContain('DeviceId="tracearr-u1"');
    expect(JSON.parse(String(options?.body))).toEqual({ Username: 'alice', Pw: 'pw' });
  });

  it('checks a member token against the user it was issued to', async () => {
    sequence({ resolve: { Id: 'ext-1', Policy: { IsDisabled: false } } });

    await expect(EmbyClient.fetchSelf(URL, 'tok', 'ext-1')).resolves.toEqual({
      id: 'ext-1',
      isDisabled: false,
    });
    const [url, options] = mockFetchJson.mock.calls[0] ?? [];
    expect(url).toBe(`${URL}/Users/ext-1`);
    expect(options?.headers).toMatchObject({ 'X-Emby-Token': 'tok' });
  });
});

describe('EmbyClient.resolveUserGuid', () => {
  beforeEach(() => {
    mockFetchJson.mockReset();
  });

  it('caches the guid and caches a 404 as null', async () => {
    const client = new EmbyClient({ url: URL, token: 'key', id: 'srv-guid' });
    sequence({ resolve: { Id: 'e5c1a0b2d3f44a5b8c9d0e1f2a3b4c5d' } }, { reject: httpError(404) });

    expect(await client.resolveUserGuid('16')).toBe('e5c1a0b2d3f44a5b8c9d0e1f2a3b4c5d');
    expect(await client.resolveUserGuid('16')).toBe('e5c1a0b2d3f44a5b8c9d0e1f2a3b4c5d');
    expect(await client.resolveUserGuid('17')).toBeNull();
    expect(await client.resolveUserGuid('17')).toBeNull();

    expect(mockFetchJson).toHaveBeenCalledTimes(2);
    expect(mockFetchJson.mock.calls[0]?.[0]).toBe(`${URL}/Users/16`);
  });
});

describe('EmbyClient sync cursor', () => {
  it('reads a date cursor with the requests a date always made', async () => {
    mockFetchJson.mockResolvedValue({ Items: [], TotalRecordCount: 0 });
    const cursor = { kind: 'date', since: new Date('2024-06-01T00:00:00Z') } as const;
    const client = new EmbyClient({ url: URL, token: 'key' });

    await client.getLibraryItemsSince('7', cursor, { libraryType: 'movie' });
    await client.getLibraryLeavesSince('7', cursor);

    expect(mockFetchJson.mock.calls.map(([url]) => url)).toEqual([
      'http://emby.local:8096/Items?ParentId=7&Recursive=true&IncludeItemTypes=Movie%2CSeries%2CMusicAlbum%2CAudio&CollapseBoxSetItems=false&IsMissing=false&Fields=ProviderIds%2CPath%2CMediaSources%2CDateCreated%2CProductionYear%2CSeriesName%2CSeriesId%2CParentIndexNumber%2CIndexNumber%2CAlbum%2CAlbumArtist%2CArtists%2CAlbumId%2CAlbumPrimaryImageTag%2CGenres%2CImageTags&StartIndex=0&Limit=200&SortBy=DateCreated&SortOrder=Descending&minDateLastSaved=2024-06-01T00%3A00%3A00.000Z',
      'http://emby.local:8096/Items?ParentId=7&Recursive=true&IncludeItemTypes=Episode%2CSeason&IsMissing=false&Fields=ProviderIds%2CPath%2CMediaSources%2CDateCreated%2CProductionYear%2CSeriesName%2CSeriesId%2CParentIndexNumber%2CIndexNumber%2CGenres%2CImageTags&StartIndex=0&Limit=200&SortBy=DateCreated&SortOrder=Descending&minDateLastSaved=2024-06-01T00%3A00%3A00.000Z',
    ]);
  });
});
