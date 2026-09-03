import { describe, expect, it } from 'vitest';
import { DEFAULT_NEWSLETTER_SECTIONS } from '@tracearr/shared';
import { episodeRange, groupDigest, type LibraryItemRow } from '../assemble.js';

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
