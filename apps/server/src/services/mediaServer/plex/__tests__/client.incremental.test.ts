import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlexClient } from '../client.js';

vi.mock('../../../../utils/http.js', () => ({
  fetchJson: vi.fn(),
  fetchText: vi.fn(),
  plexHeaders: vi.fn().mockReturnValue({ 'X-Plex-Token': 'test-token' }),
}));

import { fetchJson } from '../../../../utils/http.js';

const mockFetchJson = vi.mocked(fetchJson);

function makeClient() {
  return new PlexClient({ url: 'http://plex.local:32400', token: 'test-token' });
}

/** Helper: build a Plex API response with items that have updatedAt timestamps */
function makeItemsResponse(
  items: Array<{ ratingKey: string; title: string; updatedAt: number; addedAt?: number }>,
  totalSize?: number,
  type = 'movie'
) {
  return {
    MediaContainer: {
      totalSize: totalSize ?? items.length,
      size: items.length,
      Metadata: items.map((i) => ({
        ratingKey: i.ratingKey,
        title: i.title,
        type,
        updatedAt: i.updatedAt,
        addedAt: i.addedAt ?? i.updatedAt - 86400,
        Media: [{ Part: [{ file: `/movies/${i.title}.mkv`, size: 1000000 }] }],
        Guid: [],
      })),
    },
  };
}

function emptyResponse() {
  return { MediaContainer: { totalSize: 0, size: 0, Metadata: [] } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PlexClient sort-based incremental sync', () => {
  describe('getLibraryItemsSince', () => {
    it('uses sort=updatedAt:desc in the query string', async () => {
      mockFetchJson.mockResolvedValue(emptyResponse());
      const client = makeClient();

      await client.getLibraryItemsSince('3', {
        kind: 'date',
        since: new Date('2024-06-01T00:00:00Z'),
      });

      const url = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(url).toContain('sort=updatedAt%3Adesc');
    });

    it('uses the /library/sections/{id}/all endpoint', async () => {
      mockFetchJson.mockResolvedValue(emptyResponse());
      const client = makeClient();

      await client.getLibraryItemsSince('42', { kind: 'date', since: new Date() });

      const url = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(url).toContain('/library/sections/42/all');
    });

    it('does NOT include addedAt>>= in the query', async () => {
      mockFetchJson.mockResolvedValue(emptyResponse());
      const client = makeClient();

      await client.getLibraryItemsSince('3', { kind: 'date', since: new Date() });

      const url = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(url).not.toContain('addedAt');
    });

    it('includes includeGuids=1', async () => {
      mockFetchJson.mockResolvedValue(emptyResponse());
      const client = makeClient();

      await client.getLibraryItemsSince('3', { kind: 'date', since: new Date() });

      const url = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(url).toContain('includeGuids=1');
    });

    it('returns only items with updatedAt >= since', async () => {
      const since = new Date('2024-06-01T00:00:00Z');
      const sinceUnix = Math.floor(since.getTime() / 1000);

      mockFetchJson.mockResolvedValue(
        makeItemsResponse([
          { ratingKey: '1', title: 'New', updatedAt: sinceUnix + 3600 },
          { ratingKey: '2', title: 'Exactly At', updatedAt: sinceUnix },
          { ratingKey: '3', title: 'Old', updatedAt: sinceUnix - 3600 },
        ])
      );

      const client = makeClient();
      const result = await client.getLibraryItemsSince('3', { kind: 'date', since });

      expect(result.items).toHaveLength(2);
      expect(result.totalCount).toBe(2);
      expect(result.items.map((i) => i.title)).toEqual(['New', 'Exactly At']);
    });

    it('stops paginating when cutoff is reached', async () => {
      const since = new Date('2024-06-01T00:00:00Z');
      const sinceUnix = Math.floor(since.getTime() / 1000);

      mockFetchJson
        .mockResolvedValueOnce(
          makeItemsResponse([
            { ratingKey: '1', title: 'A', updatedAt: sinceUnix + 7200 },
            { ratingKey: '2', title: 'B', updatedAt: sinceUnix + 3600 },
          ])
        )
        .mockResolvedValueOnce(
          makeItemsResponse([
            { ratingKey: '3', title: 'C', updatedAt: sinceUnix - 100 },
            { ratingKey: '4', title: 'D', updatedAt: sinceUnix - 200 },
          ])
        );

      const client = makeClient();
      const result = await client.getLibraryItemsSince('3', { kind: 'date', since });

      expect(result.items).toHaveLength(2);
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });

    it('stops when API returns empty page', async () => {
      mockFetchJson.mockResolvedValue(emptyResponse());

      const client = makeClient();
      const result = await client.getLibraryItemsSince('3', {
        kind: 'date',
        since: new Date('2020-01-01'),
      });

      expect(result.items).toHaveLength(0);
      expect(result.totalCount).toBe(0);
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });

    it('handles items without updatedAt by treating them as too old', async () => {
      const since = new Date('2024-06-01T00:00:00Z');
      const sinceUnix = Math.floor(since.getTime() / 1000);

      mockFetchJson.mockResolvedValue({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: '1',
              title: 'Has updatedAt',
              type: 'movie',
              updatedAt: sinceUnix + 3600,
              addedAt: sinceUnix,
              Media: [{ Part: [{ size: 1000 }] }],
              Guid: [],
            },
            {
              ratingKey: '2',
              title: 'No updatedAt',
              type: 'movie',
              addedAt: sinceUnix,
              Media: [{ Part: [{ size: 2000 }] }],
              Guid: [],
            },
          ],
        },
      });

      const client = makeClient();
      const result = await client.getLibraryItemsSince('3', { kind: 'date', since });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.title).toBe('Has updatedAt');
    });

    it('paginates correctly across multiple full pages', async () => {
      const since = new Date('2024-01-01T00:00:00Z');
      const sinceUnix = Math.floor(since.getTime() / 1000);

      const makePage = (startKey: number, updatedAt: number) =>
        makeItemsResponse(
          Array.from({ length: 100 }, (_, i) => ({
            ratingKey: String(startKey + i),
            title: `Item ${startKey + i}`,
            updatedAt,
          }))
        );

      mockFetchJson
        .mockResolvedValueOnce(makePage(1, sinceUnix + 30000))
        .mockResolvedValueOnce(makePage(101, sinceUnix + 20000))
        .mockResolvedValueOnce(makePage(201, sinceUnix + 10000))
        .mockResolvedValueOnce(
          makeItemsResponse([
            { ratingKey: '301', title: 'Last New', updatedAt: sinceUnix + 100 },
            { ratingKey: '302', title: 'First Old', updatedAt: sinceUnix - 100 },
          ])
        );

      const client = makeClient();
      const result = await client.getLibraryItemsSince('3', { kind: 'date', since });

      expect(result.items).toHaveLength(301);
      expect(mockFetchJson).toHaveBeenCalledTimes(4);

      const urls = mockFetchJson.mock.calls.map((c) => String(c[0]));
      expect(urls[0]).toContain('X-Plex-Container-Start=0');
      expect(urls[1]).toContain('X-Plex-Container-Start=100');
      expect(urls[2]).toContain('X-Plex-Container-Start=200');
      expect(urls[3]).toContain('X-Plex-Container-Start=300');
    });
  });

  describe('getLibraryLeavesSince', () => {
    it('uses the /allLeaves endpoint with sort=updatedAt:desc', async () => {
      mockFetchJson.mockResolvedValue(emptyResponse());
      const client = makeClient();

      await client.getLibraryLeavesSince('7', { kind: 'date', since: new Date() });

      const url = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(url).toContain('/library/sections/7/allLeaves');
      expect(url).toContain('sort=updatedAt%3Adesc');
    });

    it('does NOT include addedAt>>= in the query', async () => {
      mockFetchJson.mockResolvedValue(emptyResponse());
      const client = makeClient();

      await client.getLibraryLeavesSince('7', { kind: 'date', since: new Date() });

      const url = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(url).not.toContain('addedAt');
    });

    it('applies the same cutoff logic as getLibraryItemsSince', async () => {
      const since = new Date('2024-06-01T00:00:00Z');
      const sinceUnix = Math.floor(since.getTime() / 1000);

      mockFetchJson.mockResolvedValue(
        makeItemsResponse([
          { ratingKey: 'ep1', title: 'Recent Episode', updatedAt: sinceUnix + 1000 },
          { ratingKey: 'ep2', title: 'Old Episode', updatedAt: sinceUnix - 1000 },
        ])
      );

      const client = makeClient();
      const result = await client.getLibraryLeavesSince('7', { kind: 'date', since });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.title).toBe('Recent Episode');
    });
  });

  describe('getLibrarySeasons', () => {
    it('requests type=3 and paginates via headers, not query params', async () => {
      mockFetchJson.mockResolvedValue(emptyResponse());
      const client = makeClient();

      await client.getLibrarySeasons('5', { offset: 40, limit: 20 });

      const [url, options] = mockFetchJson.mock.calls[0]! as [string, { headers?: unknown }];
      expect(url).toContain('/library/sections/5/all');
      expect(url).toContain('type=3');
      // The pagination trap: type=3 queries ignore Start/Size as query params
      // (always return the whole result set) but honor them as headers.
      expect(url).not.toContain('X-Plex-Container-Start');
      expect(url).not.toContain('X-Plex-Container-Size');
      expect(options.headers).toMatchObject({
        'X-Plex-Container-Start': '40',
        'X-Plex-Container-Size': '20',
      });
    });

    it('advances the header offset across pages until totalSize is covered', async () => {
      mockFetchJson
        .mockResolvedValueOnce(
          makeItemsResponse([{ ratingKey: 's1', title: 'Season 1', updatedAt: 1 }], 2)
        )
        .mockResolvedValueOnce(
          makeItemsResponse([{ ratingKey: 's2', title: 'Season 2', updatedAt: 1 }], 2)
        );

      const client = makeClient();
      const first = await client.getLibrarySeasons('5', { offset: 0, limit: 1 });
      expect(first.totalCount).toBe(2);
      const second = await client.getLibrarySeasons('5', { offset: 1, limit: 1 });

      const headersA = (mockFetchJson.mock.calls[0]![1] as { headers: Record<string, string> })
        .headers;
      const headersB = (mockFetchJson.mock.calls[1]![1] as { headers: Record<string, string> })
        .headers;
      expect(headersA['X-Plex-Container-Start']).toBe('0');
      expect(headersB['X-Plex-Container-Start']).toBe('1');
      expect(first.items[0]!.ratingKey).toBe('s1');
      expect(second.items[0]!.ratingKey).toBe('s2');
    });
  });

  describe('getLibrarySeasonsSince', () => {
    it('sorts by updatedAt, filters type=3, and paginates via headers', async () => {
      const since = new Date('2024-06-01T00:00:00Z');
      const sinceUnix = Math.floor(since.getTime() / 1000);

      mockFetchJson
        .mockResolvedValueOnce(
          makeItemsResponse([
            { ratingKey: 'season-1', title: 'Season 1', updatedAt: sinceUnix + 100 },
          ])
        )
        .mockResolvedValueOnce(emptyResponse());

      const client = makeClient();
      await client.getLibrarySeasonsSince('5', { kind: 'date', since });

      const [url, options] = mockFetchJson.mock.calls[0]! as [string, { headers?: unknown }];
      expect(url).toContain('type=3');
      expect(url).toContain('sort=updatedAt%3Adesc');
      expect(url).not.toContain('X-Plex-Container-Start');
      expect(options.headers).toMatchObject({
        'X-Plex-Container-Start': '0',
        'X-Plex-Container-Size': '100',
      });
    });

    it('stops at the cutoff like the other since-fetches', async () => {
      const since = new Date('2024-06-01T00:00:00Z');
      const sinceUnix = Math.floor(since.getTime() / 1000);

      mockFetchJson.mockResolvedValue(
        makeItemsResponse([
          { ratingKey: 'new-season', title: 'New', updatedAt: sinceUnix + 100 },
          { ratingKey: 'old-season', title: 'Old', updatedAt: sinceUnix - 100 },
        ])
      );

      const client = makeClient();
      const result = await client.getLibrarySeasonsSince('5', { kind: 'date', since });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.title).toBe('New');
    });
  });

  describe('getLibraryAlbums', () => {
    it('requests type=9 and paginates via headers, not query params', async () => {
      mockFetchJson.mockResolvedValue(emptyResponse());
      const client = makeClient();

      await client.getLibraryAlbums('7', { offset: 40, limit: 20 });

      const [url, options] = mockFetchJson.mock.calls[0]! as [string, { headers?: unknown }];
      expect(url).toContain('/library/sections/7/all');
      expect(url).toContain('type=9');
      expect(url).not.toContain('X-Plex-Container-Start');
      expect(options.headers).toMatchObject({
        'X-Plex-Container-Start': '40',
        'X-Plex-Container-Size': '20',
      });
    });

    it('parses album rows', async () => {
      mockFetchJson.mockResolvedValue(
        makeItemsResponse([{ ratingKey: 'a1', title: 'Blue Lines', updatedAt: 1 }], 1, 'album')
      );

      const client = makeClient();
      const result = await client.getLibraryAlbums('7', { offset: 0, limit: 1 });

      expect(result.totalCount).toBe(1);
      expect(result.items.map((i) => i.mediaType)).toEqual(['album']);
    });
  });

  describe('getLibraryAlbumsSince', () => {
    it('filters type=9, sorts by updatedAt, paginates via headers and stops at the cutoff', async () => {
      const since = new Date('2024-06-01T00:00:00Z');
      const sinceUnix = Math.floor(since.getTime() / 1000);

      mockFetchJson.mockResolvedValue(
        makeItemsResponse(
          [
            { ratingKey: 'new-album', title: 'New', updatedAt: sinceUnix + 100 },
            { ratingKey: 'old-album', title: 'Old', updatedAt: sinceUnix - 100 },
          ],
          undefined,
          'album'
        )
      );

      const client = makeClient();
      const result = await client.getLibraryAlbumsSince('7', { kind: 'date', since });

      const [url, options] = mockFetchJson.mock.calls[0]! as [string, { headers?: unknown }];
      expect(url).toContain('/library/sections/7/all');
      expect(url).toContain('type=9');
      expect(url).toContain('sort=updatedAt%3Adesc');
      expect(url).not.toContain('X-Plex-Container-Start');
      expect(options.headers).toMatchObject({ 'X-Plex-Container-Start': '0' });
      expect(result.items.map((i) => [i.ratingKey, i.mediaType])).toEqual([['new-album', 'album']]);
    });
  });
});

describe('PlexClient sync cursor', () => {
  const cursor = { kind: 'date', since: new Date('2024-06-01T00:00:00Z') } as const;

  it('reads a date cursor with the requests a date always made', async () => {
    mockFetchJson.mockResolvedValue(emptyResponse());
    const client = makeClient();

    await client.getLibraryItemsSince('7', cursor);
    await client.getLibraryLeavesSince('7', cursor);
    await client.getLibrarySeasonsSince('7', cursor);
    await client.getLibraryAlbumsSince('7', cursor);

    expect(mockFetchJson.mock.calls.map(([url]) => url)).toEqual([
      'http://plex.local:32400/library/sections/7/all?includeGuids=1&sort=updatedAt%3Adesc&X-Plex-Container-Start=0&X-Plex-Container-Size=100',
      'http://plex.local:32400/library/sections/7/allLeaves?includeGuids=1&sort=updatedAt%3Adesc&X-Plex-Container-Start=0&X-Plex-Container-Size=100',
      'http://plex.local:32400/library/sections/7/all?includeGuids=1&sort=updatedAt%3Adesc&type=3',
      'http://plex.local:32400/library/sections/7/all?includeGuids=1&sort=updatedAt%3Adesc&type=9',
    ]);
  });

  it('refuses a revision cursor without asking the server', async () => {
    await expect(
      makeClient().getLibraryItemsSince('7', { kind: 'revision', since: 12 })
    ).rejects.toThrow('by date, not by revision');
    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});
