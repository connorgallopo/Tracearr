import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { DEFAULT_NEWSLETTER_SECTIONS } from '@tracearr/shared';
import { renderSql } from '../../../test/helpers.js';

const mockExecute = vi.fn();
vi.mock('../../../db/client.js', () => ({
  db: { execute: (...a: unknown[]) => mockExecute(...a) },
}));
const mockProxy = vi.fn();
vi.mock('../../imageProxy.js', () => ({
  proxyImage: (...a: unknown[]) => mockProxy(...a) as unknown,
  posterVersionFor: (path: string) => `v-${path}`,
}));
const mockTopWatched = vi.fn();
vi.mock('../../stats/topContent.js', () => ({
  topWatched: (...a: unknown[]) => mockTopWatched(...a) as unknown,
}));

import {
  assembleDigest,
  collapseMirrors,
  episodeRange,
  groupDigest,
  sectionItemCounts,
  type LibraryItemRow,
} from '../assemble.js';

const at = (h: number) => new Date(Date.UTC(2026, 8, 1, h));
let n = 0;
function row(over: Partial<LibraryItemRow>): LibraryItemRow {
  n += 1;
  return {
    id: `item-${n}`,
    serverId: 'srv-1',
    serverName: 'Basement',
    serverType: 'plex',
    libraryId: '1',
    libraryName: 'Movies',
    ratingKey: `rk-${n}`,
    mediaId: null,
    mediaType: 'movie',
    title: `Title ${n}`,
    year: 2000,
    parentTitle: null,
    parentRatingKey: null,
    parentIndex: null,
    grandparentTitle: null,
    grandparentRatingKey: null,
    itemIndex: null,
    thumbPath: `/thumb/${n}`,
    genres: null,
    imdbId: null,
    addedAt: at(n),
    mirrors: [],
    ...over,
  };
}

describe('episodeRange', () => {
  it('collapses runs and pads to two digits', () => {
    expect(episodeRange([4, 1, 2, 3, 7, 12, 9, 10, 11])).toBe('E01-E04, E07, E09-E12');
    expect(episodeRange([5])).toBe('E05');
    expect(episodeRange([])).toBe('');
    expect(episodeRange([3, 3, 3])).toBe('E03');
  });
});

describe('collapseMirrors', () => {
  it('folds a title mirrored on two servers into the first-ranked copy with the other as a mirror, and leaves null media ids and same-server copies alone', () => {
    const rank = (id: string) => ['srv-1', 'srv-2'].indexOf(id);
    const rows = [
      row({ serverId: 'srv-2', ratingKey: 'b-heat', mediaId: 'media-heat', title: 'Heat' }),
      row({ serverId: 'srv-1', ratingKey: 'a-heat', mediaId: 'media-heat', title: 'Heat' }),
      row({ serverId: 'srv-1', ratingKey: 'a-heat-4k', mediaId: 'media-heat', title: 'Heat' }),
      row({ serverId: 'srv-2', ratingKey: 'b-alien', mediaId: null, title: 'Alien' }),
      row({ serverId: 'srv-1', ratingKey: 'a-alien', mediaId: null, title: 'Alien' }),
    ];
    expect(collapseMirrors(rows, rank).map((r) => [r.serverId, r.ratingKey, r.mirrors])).toEqual([
      ['srv-1', 'a-heat', [{ serverId: 'srv-2', ratingKey: 'b-heat' }]],
      ['srv-1', 'a-heat-4k', []],
      ['srv-2', 'b-alien', []],
      ['srv-1', 'a-alien', []],
    ]);
  });

  it('does not re-record a mirror already carried on the kept row when a second pass sees that server again', () => {
    const rank = (id: string) => ['srv-1', 'srv-2'].indexOf(id);
    const alreadyMirrored = row({
      serverId: 'srv-1',
      ratingKey: 'a-heat',
      mediaId: 'media-heat',
      title: 'Heat',
      mirrors: [{ serverId: 'srv-2', ratingKey: 'b-heat' }],
    });
    const refetchedCopy = row({
      serverId: 'srv-2',
      ratingKey: 'b-heat',
      mediaId: 'media-heat',
      title: 'Heat',
    });
    expect(collapseMirrors([alreadyMirrored, refetchedCopy], rank).map((r) => r.mirrors)).toEqual([
      [{ serverId: 'srv-2', ratingKey: 'b-heat' }],
    ]);
  });

  it('carries the mirrors a dropped copy was holding onto the kept row, once per server', () => {
    const rank = (id: string) => ['srv-1', 'srv-2', 'srv-3'].indexOf(id);
    const rows = [
      row({ serverId: 'srv-1', ratingKey: 'a-heat', mediaId: 'media-heat', title: 'Heat' }),
      row({
        serverId: 'srv-2',
        ratingKey: 'b-heat',
        mediaId: 'media-heat',
        title: 'Heat',
        mirrors: [
          { serverId: 'srv-3', ratingKey: 'c-heat' },
          { serverId: 'srv-1', ratingKey: 'a-heat-4k' },
        ],
      }),
    ];
    expect(collapseMirrors(rows, rank).map((r) => [r.serverId, r.mirrors])).toEqual([
      [
        'srv-1',
        [
          { serverId: 'srv-2', ratingKey: 'b-heat' },
          { serverId: 'srv-3', ratingKey: 'c-heat' },
        ],
      ],
    ]);
  });
});

describe('groupDigest', () => {
  it('sorts movies newest first, applies caps, and counts everything', () => {
    const rows = [
      row({ mediaType: 'movie', title: 'Old', addedAt: at(1) }),
      row({ mediaType: 'movie', title: 'New', addedAt: at(5), genres: ['Drama'] }),
      row({ mediaType: 'movie', title: 'Mid', addedAt: at(3) }),
    ];
    const data = groupDigest(rows, {
      ...DEFAULT_NEWSLETTER_SECTIONS,
      movies: { enabled: true, max: 2 },
    });
    expect(data.movies.map((m) => m.title)).toEqual(['New', 'Mid']);
    expect(data.movies[0]?.genres).toEqual(['Drama']);
    expect(data.counts).toEqual({ movies: 3, shows: 0, episodes: 0, albums: 0, mostWatched: 0 });
    expect(data.isEmpty).toBe(false);
  });

  it('groups episodes into shows and seasons with ranges, caps seasons, and takes the show poster from the show row', () => {
    const ep = (show: string, season: number, e: number) =>
      row({
        mediaType: 'episode',
        title: `Ep ${e}`,
        grandparentTitle: show,
        grandparentRatingKey: `show-${show}`,
        parentTitle: `Season ${season}`,
        parentRatingKey: `s-${show}-${season}`,
        parentIndex: season,
        itemIndex: e,
        thumbPath: null,
      });
    const rows = [
      ep('Wire', 2, 1),
      ep('Wire', 2, 2),
      ep('Wire', 2, 4),
      ep('Wire', 3, 1),
      ep('Wire', 4, 1),
      row({
        mediaType: 'show',
        title: 'Wire',
        ratingKey: 'show-Wire',
        year: 2002,
        thumbPath: '/wire',
      }),
      row({
        mediaType: 'season',
        title: 'Season 1',
        parentTitle: 'Sopranos',
        parentRatingKey: 'show-Sopranos',
        parentIndex: 1,
      }),
    ];
    const data = groupDigest(rows, {
      ...DEFAULT_NEWSLETTER_SECTIONS,
      shows: { enabled: true, max: 12, maxSeasonsPerShow: 2 },
    });
    expect(data.shows).toHaveLength(2);
    const wire = data.shows.find((s) => s.title === 'Wire')!;
    expect(wire.year).toBe(2002);
    expect(wire.thumbPath).toBe('/wire');
    expect(wire.seasons.map((s) => [s.number, s.episodeRange, s.episodeCount])).toEqual([
      [2, 'E01-E02, E04', 3],
      [3, 'E01', 1],
    ]);
    expect(wire.moreSeasons).toBe(1);
    expect(wire.episodeCount).toBe(5);
    const sopranos = data.shows.find((s) => s.title === 'Sopranos')!;
    expect(sopranos.seasons).toEqual([
      { number: 1, title: 'Season 1', episodeRange: '', episodeCount: 0, whole: true },
    ]);
    expect(data.counts.shows).toBe(2);
    expect(data.counts.episodes).toBe(5);
  });

  it('keeps a mirrored show to one card when each server contributed different episodes', () => {
    const ep = (serverId: string, showKey: string, e: number) =>
      row({
        serverId,
        mediaType: 'episode',
        title: `Ep ${e}`,
        grandparentTitle: 'Wire',
        grandparentRatingKey: showKey,
        parentTitle: 'Season 1',
        parentRatingKey: `${showKey}-s1`,
        parentIndex: 1,
        itemIndex: e,
        thumbPath: null,
      });
    const rows = [
      ep('srv-1', 'show-a', 1),
      ep('srv-1', 'show-a', 2),
      ep('srv-2', 'show-b', 3),
      row({
        serverId: 'srv-1',
        mediaType: 'show',
        title: 'Wire',
        ratingKey: 'show-a',
        mediaId: 'media-wire',
        year: 2002,
        thumbPath: '/wire',
        mirrors: [{ serverId: 'srv-2', ratingKey: 'show-b' }],
      }),
    ];
    const data = groupDigest(rows, DEFAULT_NEWSLETTER_SECTIONS);
    expect(data.shows.map((s) => [s.title, s.serverId, s.thumbPath, s.year, s.mirrors])).toEqual([
      ['Wire', 'srv-1', '/wire', 2002, [{ serverId: 'srv-2', ratingKey: 'show-b' }]],
    ]);
    expect(data.shows[0]?.seasons.map((s) => [s.number, s.episodeRange, s.episodeCount])).toEqual([
      [1, 'E01-E03', 3],
    ]);
    expect(data.shows[0]?.episodeCount).toBe(3);
    expect(data.counts.shows).toBe(1);
    expect(data.counts.episodes).toBe(3);
  });

  it('groups tracks and albums under artists and caps by album count', () => {
    const track = (artist: string, album: string, t: number) =>
      row({
        mediaType: 'track',
        title: `T${t}`,
        grandparentTitle: artist,
        grandparentRatingKey: `ar-${artist}`,
        parentTitle: album,
        parentRatingKey: `al-${artist}-${album}`,
        itemIndex: t,
        libraryName: 'Music',
      });
    const rows = [
      track('Portishead', 'Dummy', 1),
      track('Portishead', 'Dummy', 2),
      row({
        mediaType: 'album',
        title: 'Third',
        parentTitle: 'Portishead',
        parentRatingKey: 'ar-Portishead',
        ratingKey: 'al-Portishead-Third',
        year: 2008,
      }),
      track('Massive Attack', 'Mezzanine', 1),
    ];
    const data = groupDigest(rows, {
      ...DEFAULT_NEWSLETTER_SECTIONS,
      music: { enabled: true, max: 2 },
    });
    expect(data.artists.map((a) => a.name)).toEqual(['Portishead']);
    expect(data.artists[0]?.albums.map((a) => [a.title, a.trackCount, a.year])).toEqual([
      ['Dummy', 2, null],
      ['Third', 0, 2008],
    ]);
    expect(data.counts.albums).toBe(3);
  });

  it('drops an artist row with no albums or tracks in the window instead of an empty card', () => {
    const rows = [
      row({ mediaType: 'artist', title: 'Ghost Act', ratingKey: 'ar-ghost' }),
      row({ mediaType: 'artist', title: 'Portishead', ratingKey: 'ar-Portishead' }),
      row({
        mediaType: 'album',
        title: 'Dummy',
        parentTitle: 'Portishead',
        parentRatingKey: 'ar-Portishead',
        ratingKey: 'al-Portishead-Dummy',
      }),
    ];
    const data = groupDigest(rows, {
      ...DEFAULT_NEWSLETTER_SECTIONS,
      music: { enabled: true, max: 12 },
    });
    expect(data.artists.map((a) => a.name)).toEqual(['Portishead']);
    expect(sectionItemCounts(data).albums).toBe(1);
  });

  it('honors disabled sections and reports empty', () => {
    const data = groupDigest([row({ mediaType: 'movie' })], {
      ...DEFAULT_NEWSLETTER_SECTIONS,
      movies: { enabled: false, max: 12 },
    });
    expect(data.movies).toEqual([]);
    expect(data.counts.movies).toBe(0);
    expect(data.isEmpty).toBe(true);
  });
});

describe('assembleDigest poster warming', () => {
  const rawRow = (over: Record<string, unknown>) => ({
    id: 'row',
    server_id: 'srv-1',
    server_name: 'Basement',
    server_type: 'plex',
    library_id: '1',
    library_name: 'Movies',
    rating_key: 'rk',
    media_id: null,
    media_type: 'movie',
    title: 'Title',
    year: 2000,
    parent_title: null,
    parent_rating_key: null,
    parent_index: null,
    grandparent_title: null,
    grandparent_rating_key: null,
    item_index: null,
    thumb_path: null,
    genres: null,
    imdb_id: null,
    added_at: new Date('2026-09-01T00:00:00Z'),
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockProxy.mockResolvedValue({ data: Buffer.from('jpeg'), contentType: 'image/jpeg' });
    mockExecute.mockResolvedValue({
      rows: [
        rawRow({ id: 'movie-1', media_type: 'movie', title: 'Heat', thumb_path: '/movie.jpg' }),
        rawRow({ id: 'show-1', media_type: 'show', title: 'The Wire', thumb_path: '/show.jpg' }),
        rawRow({
          id: 'album-1',
          media_type: 'album',
          title: 'Dummy',
          rating_key: 'album-rk',
          parent_rating_key: 'artist-rk',
          parent_title: 'Portishead',
          thumb_path: '/album.jpg',
        }),
      ],
    });
    mockTopWatched.mockResolvedValue({
      movies: [
        {
          serverId: 'srv-1',
          ratingKey: 'w1',
          title: 'Alien',
          year: 1979,
          plays: 9,
          thumbPath: '/watched.jpg',
        },
      ],
      shows: [],
    });
  });

  it('warms movie, show, first-album and most-watched posters, and nothing else', async () => {
    const { data, posters } = await assembleDigest(
      {
        scope: { serverIds: [], libraries: [] },
        sections: {
          ...DEFAULT_NEWSLETTER_SECTIONS,
          mostWatched: { enabled: true, max: 10 },
        },
      },
      { start: new Date('2026-08-26T00:00:00Z'), end: new Date('2026-09-02T00:00:00Z') }
    );
    expect(data.artists).toHaveLength(1);
    expect(data.mostWatched).toHaveLength(1);
    expect(Object.keys(posters).sort()).toEqual([
      'album-1',
      'movie-1',
      'show-1',
      'watched-movie-0',
    ]);
    expect(posters['album-1']).toEqual({
      serverId: 'srv-1',
      thumbPath: '/album.jpg',
      version: 'v-/album.jpg',
    });
    expect(posters['watched-movie-0']).toEqual({
      serverId: 'srv-1',
      thumbPath: '/watched.jpg',
      version: 'v-/watched.jpg',
    });
    expect(
      mockProxy.mock.calls.map(([arg]) => (arg as { imagePath: string }).imagePath).sort()
    ).toEqual(['/album.jpg', '/movie.jpg', '/show.jpg', '/watched.jpg']);
  });
});

describe('assembleDigest most watched card identity', () => {
  const itemRow = (over: Record<string, unknown>) => ({
    id: 'item',
    server_id: 'srv-1',
    server_name: 'Basement',
    server_type: 'plex',
    library_id: '1',
    library_name: 'Movies',
    rating_key: 'rk',
    media_id: null,
    media_type: 'movie',
    title: 'Title',
    year: 2000,
    parent_title: null,
    parent_rating_key: null,
    parent_index: null,
    grandparent_title: null,
    grandparent_rating_key: null,
    item_index: null,
    thumb_path: null,
    genres: null,
    imdb_id: null,
    added_at: new Date('2026-09-01T00:00:00Z'),
    ...over,
  });

  const sections = { ...DEFAULT_NEWSLETTER_SECTIONS, mostWatched: { enabled: true, max: 10 } };

  it('carries mediaId and imdbId from the matching library row, and leaves both null with no match', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [] }) // loadWindowItems
      .mockResolvedValueOnce({
        rows: [
          itemRow({
            media_type: 'movie',
            rating_key: 'm-42',
            media_id: 'movie-media-id',
            imdb_id: 'tt0113277',
          }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          itemRow({
            media_type: 'show',
            rating_key: 'show-77',
            media_id: 'show-media-id',
            imdb_id: 'tt0290978',
          }),
        ],
      });
    mockTopWatched.mockResolvedValue({
      movies: [
        {
          serverId: 'srv-1',
          ratingKey: 'm-42',
          title: 'Heat',
          year: 1995,
          plays: 9,
          thumbPath: '/movie.jpg',
        },
        {
          serverId: 'srv-1',
          ratingKey: 'no-match',
          title: 'Unknown',
          year: 2001,
          plays: 3,
          thumbPath: null,
        },
      ],
      shows: [
        {
          serverId: 'srv-1',
          ratingKey: 'show-77',
          title: 'The Wire',
          year: 2002,
          plays: 12,
          thumbPath: '/show.jpg',
        },
      ],
    });

    const { data } = await assembleDigest(
      { scope: { serverIds: [], libraries: [] }, sections },
      { start: new Date('2026-08-26T00:00:00Z'), end: new Date('2026-09-02T00:00:00Z') }
    );

    const heat = data.mostWatched.find((w) => w.title === 'Heat');
    expect(heat?.mediaId).toBe('movie-media-id');
    expect(heat?.imdbId).toBe('tt0113277');
    expect(heat?.serverName).toBe('Basement');
    const unknown = data.mostWatched.find((w) => w.title === 'Unknown');
    expect(unknown?.mediaId).toBeNull();
    expect(unknown?.imdbId).toBeNull();
    expect(unknown?.serverName).toBe('');
    const wire = data.mostWatched.find((w) => w.title === 'The Wire');
    expect(wire?.mediaId).toBe('show-media-id');
    expect(wire?.imdbId).toBe('tt0290978');

    const movieParams = renderSql(mockExecute.mock.calls[1]![0] as SQL).params;
    expect(movieParams).toContain('movie');
    expect(movieParams).toContain('srv-1');
    expect(movieParams).toContain('m-42');
    expect(movieParams).toContain('no-match');

    const showParams = renderSql(mockExecute.mock.calls[2]![0] as SQL).params;
    expect(showParams).toContain('show');
    expect(showParams).toContain('srv-1');
    expect(showParams).toContain('show-77');
  });
});
