import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JellyfinClient } from '../../jellyfin/client.js';

vi.mock('../../../../utils/http.js', () => ({
  fetchJson: vi.fn(),
  jellyfinEmbyHeaders: vi.fn().mockReturnValue({}),
}));

import { fetchJson } from '../../../../utils/http.js';

const mockFetchJson = vi.mocked(fetchJson);

function makeClient() {
  return new JellyfinClient({ url: 'http://jellyfin.local:8096', token: 'test-api-key' });
}

function makeItem(id: string, dateCreated: string) {
  return {
    Id: id,
    Name: `Item ${id}`,
    Type: 'Movie',
    DateCreated: dateCreated,
    ProviderIds: {},
  };
}

/** A Movie-typed item that the extras filter drops (ExtraType set), matching
 *  how a page full of trailers/behind-the-scenes items parses to zero. */
function makeExtraItem(id: string, dateCreated: string) {
  return { ...makeItem(id, dateCreated), ExtraType: 'Trailer' };
}

function makeItemsResponse(items: unknown[] = [], totalRecordCount?: number) {
  return { Items: items, TotalRecordCount: totalRecordCount ?? items.length };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BaseMediaServerClient incremental fetch methods', () => {
  describe('getLibraryItemsSince', () => {
    it('includes ParentId and Recursive=true in the query', async () => {
      mockFetchJson.mockResolvedValue(makeItemsResponse());

      const client = makeClient();
      await client.getLibraryItemsSince('abc-123', new Date());

      const calledUrl = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('ParentId=abc-123');
      expect(calledUrl).toContain('Recursive=true');
    });

    it('includes SortBy=DateCreated and SortOrder=Descending', async () => {
      mockFetchJson.mockResolvedValue(makeItemsResponse());

      const client = makeClient();
      await client.getLibraryItemsSince('lib-1', new Date());

      const calledUrl = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('SortBy=DateCreated');
      expect(calledUrl).toContain('SortOrder=Descending');
    });

    it('includes minDateLastSaved for forward-compatibility', async () => {
      mockFetchJson.mockResolvedValue(makeItemsResponse());

      const since = new Date('2024-06-01T12:00:00.000Z');
      const client = makeClient();
      await client.getLibraryItemsSince('lib-1', since);

      const calledUrl = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain(`minDateLastSaved=${encodeURIComponent(since.toISOString())}`);
    });

    it('includes the expected IncludeItemTypes (no Episode)', async () => {
      mockFetchJson.mockResolvedValue(makeItemsResponse());

      const client = makeClient();
      await client.getLibraryItemsSince('lib-1', new Date());

      const calledUrl = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('IncludeItemTypes=Movie%2CSeries%2CMusicAlbum%2CAudio');
    });

    it('narrows IncludeItemTypes to the library type and keeps collection members listed', async () => {
      mockFetchJson.mockResolvedValue(makeItemsResponse());

      const client = makeClient();
      await client.getLibraryItemsSince('lib-1', new Date(), { libraryType: 'movies' });
      await client.getLibraryItemsSince('lib-2', new Date(), { libraryType: 'music' });

      const [moviesUrl, musicUrl] = mockFetchJson.mock.calls.map((call) => call[0] as string);
      expect(moviesUrl).toContain('IncludeItemTypes=Movie&');
      expect(moviesUrl).toContain('CollapseBoxSetItems=false');
      expect(musicUrl).toContain('IncludeItemTypes=MusicArtist%2CMusicAlbum%2CAudio');
    });

    it('includes IsMissing=false', async () => {
      mockFetchJson.mockResolvedValue(makeItemsResponse());

      const client = makeClient();
      await client.getLibraryItemsSince('lib-1', new Date());

      const calledUrl = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('IsMissing=false');
    });

    it('includes Fields parameter with ProviderIds', async () => {
      mockFetchJson.mockResolvedValue(makeItemsResponse());

      const client = makeClient();
      await client.getLibraryItemsSince('lib-1', new Date());

      const calledUrl = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('Fields=');
      expect(calledUrl).toContain('ProviderIds');
    });

    it('filters items client-side by addedAt >= since', async () => {
      const since = new Date('2024-06-01T00:00:00Z');
      mockFetchJson.mockResolvedValue(
        makeItemsResponse([
          makeItem('1', '2024-07-01T00:00:00Z'), // after since
          makeItem('2', '2024-06-15T00:00:00Z'), // after since
          makeItem('3', '2024-05-01T00:00:00Z'), // before since
        ])
      );

      const client = makeClient();
      const result = await client.getLibraryItemsSince('lib-1', since);

      expect(result.items).toHaveLength(2);
      expect(result.totalCount).toBe(2);
    });

    it('returns 0 items when all items predate the since date', async () => {
      const since = new Date('2024-06-01T00:00:00Z');
      mockFetchJson.mockResolvedValue(
        makeItemsResponse([
          makeItem('1', '2024-05-01T00:00:00Z'),
          makeItem('2', '2024-04-01T00:00:00Z'),
        ])
      );

      const client = makeClient();
      const result = await client.getLibraryItemsSince('lib-1', since);

      expect(result.items).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });

    it('stops paginating when a page has items older than since', async () => {
      const since = new Date('2024-06-01T00:00:00Z');

      // First page: all new items
      mockFetchJson
        .mockResolvedValueOnce(
          makeItemsResponse(
            Array.from({ length: 200 }, (_, i) => makeItem(`new-${i}`, '2024-07-01T00:00:00Z')),
            500
          )
        )
        // Second page: mix of new and old → should stop here
        .mockResolvedValueOnce(
          makeItemsResponse([
            makeItem('new-200', '2024-06-15T00:00:00Z'),
            makeItem('old-1', '2024-05-01T00:00:00Z'),
          ])
        );

      const client = makeClient();
      const result = await client.getLibraryItemsSince('lib-1', since);

      expect(result.items).toHaveLength(201);
      expect(result.totalCount).toBe(201);
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });

    it('stops paginating when the server returns an empty page', async () => {
      mockFetchJson.mockResolvedValue(makeItemsResponse([]));

      const client = makeClient();
      const result = await client.getLibraryItemsSince('lib-1', new Date());

      expect(result.items).toHaveLength(0);
      expect(result.totalCount).toBe(0);
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });

    it('returns empty result when TotalRecordCount is 0 and no items', async () => {
      mockFetchJson.mockResolvedValue({ Items: [] });

      const client = makeClient();
      const result = await client.getLibraryItemsSince('lib-1', new Date());

      expect(result.totalCount).toBe(0);
      expect(result.items).toEqual([]);
    });

    it('does not end the scan on an all-extras page and advances past it by the raw count', async () => {
      const since = new Date('2024-06-01T00:00:00Z');
      const extrasPage = Array.from({ length: 200 }, (_, i) =>
        makeExtraItem(`extra-${i}`, '2024-07-01T00:00:00Z')
      );

      mockFetchJson
        .mockResolvedValueOnce(makeItemsResponse(extrasPage, 201))
        .mockResolvedValueOnce(makeItemsResponse([makeItem('real-1', '2024-07-02T00:00:00Z')], 201))
        .mockResolvedValueOnce(makeItemsResponse([]));

      const client = makeClient();
      const result = await client.getLibraryItemsSince('lib-1', since);

      expect(result.items).toHaveLength(1);
      expect(mockFetchJson).toHaveBeenCalledTimes(3);
      const secondUrl = mockFetchJson.mock.calls[1]?.[0] as string;
      expect(secondUrl).toContain('StartIndex=200');
    });
  });

  describe('getLibraryLeavesSince', () => {
    it('includes ParentId and Recursive=true', async () => {
      mockFetchJson.mockResolvedValue(makeItemsResponse());

      const client = makeClient();
      await client.getLibraryLeavesSince('lib-2', new Date());

      const calledUrl = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('/Items?');
      expect(calledUrl).toContain('ParentId=lib-2');
      expect(calledUrl).toContain('Recursive=true');
    });

    it('includes SortBy=DateCreated and SortOrder=Descending', async () => {
      mockFetchJson.mockResolvedValue(makeItemsResponse());

      const client = makeClient();
      await client.getLibraryLeavesSince('lib-2', new Date());

      const calledUrl = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('SortBy=DateCreated');
      expect(calledUrl).toContain('SortOrder=Descending');
    });

    it('includes minDateLastSaved for forward-compatibility', async () => {
      mockFetchJson.mockResolvedValue(makeItemsResponse());

      const since = new Date('2024-03-20T08:30:00.000Z');
      const client = makeClient();
      await client.getLibraryLeavesSince('lib-2', since);

      const calledUrl = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain(`minDateLastSaved=${encodeURIComponent(since.toISOString())}`);
    });

    it('uses IncludeItemTypes=Episode', async () => {
      mockFetchJson.mockResolvedValue(makeItemsResponse());

      const client = makeClient();
      await client.getLibraryLeavesSince('lib-2', new Date());

      const calledUrl = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('IncludeItemTypes=Episode');
    });

    it('includes IsMissing=false', async () => {
      mockFetchJson.mockResolvedValue(makeItemsResponse());

      const client = makeClient();
      await client.getLibraryLeavesSince('lib-2', new Date());

      const calledUrl = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('IsMissing=false');
    });

    it('includes Fields parameter with episode metadata fields', async () => {
      mockFetchJson.mockResolvedValue(makeItemsResponse());

      const client = makeClient();
      await client.getLibraryLeavesSince('lib-2', new Date());

      const calledUrl = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('Fields=');
      expect(calledUrl).toContain('SeriesId');
      expect(calledUrl).toContain('ParentIndexNumber');
    });

    it('filters items client-side by addedAt >= since', async () => {
      const since = new Date('2024-06-01T00:00:00Z');
      mockFetchJson.mockResolvedValue(
        makeItemsResponse([
          {
            Id: '1',
            Name: 'New Episode',
            Type: 'Episode',
            DateCreated: '2024-07-01T00:00:00Z',
            SeriesName: 'Test Show',
            SeriesId: 'series-1',
            ParentIndexNumber: 1,
            IndexNumber: 1,
          },
          {
            Id: '2',
            Name: 'Old Episode',
            Type: 'Episode',
            DateCreated: '2024-05-01T00:00:00Z',
            SeriesName: 'Test Show',
            SeriesId: 'series-1',
            ParentIndexNumber: 1,
            IndexNumber: 2,
          },
        ])
      );

      const client = makeClient();
      const result = await client.getLibraryLeavesSince('lib-2', since);

      expect(result.items).toHaveLength(1);
      expect(result.totalCount).toBe(1);
    });

    it('stops paginating when hitting old items', async () => {
      const since = new Date('2024-06-01T00:00:00Z');
      mockFetchJson.mockResolvedValue(
        makeItemsResponse([
          makeItem('old-1', '2024-03-01T00:00:00Z'),
          makeItem('old-2', '2024-02-01T00:00:00Z'),
        ])
      );

      const client = makeClient();
      const result = await client.getLibraryLeavesSince('lib-2', since);

      expect(result.items).toHaveLength(0);
      expect(result.totalCount).toBe(0);
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });

    it('returns empty result when server returns no items', async () => {
      mockFetchJson.mockResolvedValue({ Items: [] });

      const client = makeClient();
      const result = await client.getLibraryLeavesSince('lib-2', new Date());

      expect(result.totalCount).toBe(0);
      expect(result.items).toEqual([]);
    });

    it('does not end the scan on an all-extras page and advances past it by the raw count', async () => {
      const since = new Date('2024-06-01T00:00:00Z');
      const extrasPage = Array.from({ length: 200 }, (_, i) => ({
        Id: `extra-${i}`,
        Name: `Extra ${i}`,
        Type: 'Episode',
        DateCreated: '2024-07-01T00:00:00Z',
        SeriesName: 'Test Show',
        SeriesId: 'series-1',
        ExtraType: 'BehindTheScenes',
      }));
      const realEpisode = {
        Id: 'real-1',
        Name: 'Real Episode',
        Type: 'Episode',
        DateCreated: '2024-07-02T00:00:00Z',
        SeriesName: 'Test Show',
        SeriesId: 'series-1',
        ParentIndexNumber: 1,
        IndexNumber: 1,
      };

      mockFetchJson
        .mockResolvedValueOnce(makeItemsResponse(extrasPage, 201))
        .mockResolvedValueOnce(makeItemsResponse([realEpisode], 201))
        .mockResolvedValueOnce(makeItemsResponse([]));

      const client = makeClient();
      const result = await client.getLibraryLeavesSince('lib-2', since);

      expect(result.items).toHaveLength(1);
      expect(mockFetchJson).toHaveBeenCalledTimes(3);
      const secondUrl = mockFetchJson.mock.calls[1]?.[0] as string;
      expect(secondUrl).toContain('StartIndex=200');
    });
  });

  describe('getLibraryItems', () => {
    it('lists only the library type and keeps collection members listed', async () => {
      mockFetchJson.mockResolvedValue(makeItemsResponse());

      const client = makeClient();
      await client.getLibraryItems('lib-1', { offset: 0, limit: 200, libraryType: 'tvshows' });

      const calledUrl = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('IncludeItemTypes=Series&');
      expect(calledUrl).toContain('CollapseBoxSetItems=false');
    });
  });

  describe('findExistingRatingKeys', () => {
    it('returns the ids the server still has, dropping virtual items', async () => {
      mockFetchJson.mockResolvedValue({
        Items: [
          { Id: 'a', LocationType: 'FileSystem' },
          { Id: 'b', LocationType: 'Virtual' },
        ],
      });

      const client = makeClient();
      const existing = await client.findExistingRatingKeys(['a', 'b', 'c'], {
        id: 'lib-1',
        type: 'tvshows',
      });

      expect([...existing]).toEqual(['a']);
      const calledUrl = mockFetchJson.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('Ids=a%2Cb%2Cc');
      expect(calledUrl).toContain('IncludeItemTypes=Series%2CSeason%2CEpisode');
      expect(calledUrl).toContain('IsMissing=false');
    });

    it('looks ids up in batches of 100 without dropping any', async () => {
      mockFetchJson.mockResolvedValue({ Items: [] });
      const keys = Array.from({ length: 150 }, (_, i) => String(i));

      const client = makeClient();
      await client.findExistingRatingKeys(keys, { id: 'lib-1', type: 'movies' });

      const sentIds = mockFetchJson.mock.calls.map((call) =>
        new URL(call[0] as string).searchParams.get('Ids')?.split(',')
      );
      expect(sentIds).toEqual([keys.slice(0, 100), keys.slice(100)]);
    });
  });
});
