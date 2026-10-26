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

function movie(ratingKey: string, genres: string[]) {
  return {
    ratingKey,
    title: `Movie ${ratingKey}`,
    type: 'movie',
    updatedAt: 1_700_000_000,
    addedAt: 1_700_000_000,
    Media: [{ Part: [{ file: `/movies/${ratingKey}.mkv`, size: 1000 }] }],
    Guid: [],
    Genre: genres.map((tag) => ({ tag })),
  };
}

function container(items: unknown[]) {
  return { MediaContainer: { totalSize: items.length, size: items.length, Metadata: items } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PlexClient genre fill', () => {
  it('replaces listing genres capped at two with the full list from one batched metadata call', async () => {
    mockFetchJson
      .mockResolvedValueOnce(
        container([
          movie('1', ['Action', 'Crime']),
          movie('2', ['Comedy']),
          movie('3', ['Horror', 'Drama']),
        ])
      )
      .mockResolvedValueOnce(
        container([
          { ratingKey: '1', Genre: [{ tag: 'Action' }, { tag: 'Crime' }, { tag: 'Thriller' }] },
          { ratingKey: '3', Genre: [{ tag: 'Horror' }, { tag: 'Drama' }, { tag: 'Mystery' }] },
        ])
      );

    const { items } = await makeClient().getLibraryItems('3');

    expect(mockFetchJson).toHaveBeenCalledTimes(2);
    expect(String(mockFetchJson.mock.calls[1]?.[0])).toContain('/library/metadata/1,3?');
    expect(items.map((i) => i.genres)).toEqual([
      ['Action', 'Crime', 'Thriller'],
      ['Comedy'],
      ['Horror', 'Drama', 'Mystery'],
    ]);
  });

  it('runs at most three metadata batches at once and lands each genre on its item', async () => {
    const movies = Array.from({ length: 700 }, (_, i) => movie(String(i + 1), ['Action', 'Crime']));
    let inFlight = 0;
    let peak = 0;
    mockFetchJson.mockImplementation(async (url) => {
      const keys = /\/library\/metadata\/([^?]+)\?/.exec(String(url))?.[1];
      if (!keys) return container(movies);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return container(
        keys.split(',').map((key) => ({ ratingKey: key, Genre: [{ tag: `Genre ${key}` }] }))
      );
    });

    const { items } = await makeClient().getLibraryItems('3');

    expect(mockFetchJson).toHaveBeenCalledTimes(8);
    expect(peak).toBe(3);
    expect(items.map((i) => i.ratingKey)).toEqual(movies.map((m) => m.ratingKey));
    expect(items.every((i) => i.genres?.[0] === `Genre ${i.ratingKey}`)).toBe(true);
  });

  it('flags the items of a failed batch on their listing genres and fills the rest', async () => {
    const movies = Array.from({ length: 200 }, (_, i) => movie(String(i + 1), ['Action', 'Crime']));
    mockFetchJson.mockImplementation(async (url) => {
      const keys = /\/library\/metadata\/([^?]+)\?/.exec(String(url))?.[1];
      if (!keys) return container(movies);
      if (keys.startsWith('1,')) throw new Error('plex request timed out');
      return container(
        keys.split(',').map((key) => ({ ratingKey: key, Genre: [{ tag: `Genre ${key}` }] }))
      );
    });

    const { items } = await makeClient().getLibraryItems('3');

    expect(items[0]).toMatchObject({ genres: ['Action', 'Crime'], genresTruncated: true });
    expect(items[99]).toMatchObject({ genresTruncated: true });
    expect(items[100]).toMatchObject({ genres: ['Genre 101'] });
    expect(items[100]?.genresTruncated).toBeUndefined();
  });

  it('makes no metadata call when no item hits the cap', async () => {
    mockFetchJson.mockResolvedValueOnce(container([movie('1', ['Comedy']), movie('2', [])]));

    await makeClient().getLibraryItems('3');

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });

  it('fills incremental results too', async () => {
    mockFetchJson
      .mockResolvedValueOnce(container([movie('9', ['Drama', 'War'])]))
      .mockResolvedValueOnce(container([]))
      .mockResolvedValueOnce(
        container([
          { ratingKey: '9', Genre: [{ tag: 'Drama' }, { tag: 'War' }, { tag: 'History' }] },
        ])
      );

    const { items } = await makeClient().getLibraryItemsSince('3', new Date(0));

    expect(items[0]?.genres).toEqual(['Drama', 'War', 'History']);
  });
});
