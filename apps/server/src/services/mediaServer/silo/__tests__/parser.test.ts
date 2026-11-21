import { describe, it, expect } from 'vitest';
import silo from '../../../../test/mediaServerResponses/silo.json' with { type: 'json' };
import {
  parseSiloDeviceNames,
  parseSiloLibraries,
  parseSiloLibraryListing,
  parseSiloPosterPath,
  parseSiloProfiles,
  parseSiloSession,
  parseSiloUsers,
  siloPosterPath,
} from '../parser.js';

const MOVIE_POSTER_HASH = '200475196580003a17cdfe2a5f5452208ae0a2c2ece48fba60ca08333146727b';
const EPISODE_POSTER_HASH = '8ca719eb62703cb1e5f46090e8d20cc8c7b9941173d0992d0e6b54b8a8b1b8a6';

function nth<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`the fixture has no item ${index}`);
  return item;
}

const movieRow = nth(silo.sessions.items, 0);
const episodeRow = nth(silo.sessions.items, 1);
const tvListing = () => parseSiloLibraryListing(silo.catalog['2'].items, '2');

describe('parseSiloUsers', () => {
  it('maps accounts with their email, admin role and the libraries their policy allows', () => {
    const [owner, viewer] = parseSiloUsers(silo.users.items);

    expect(owner).toMatchObject({
      id: '1',
      username: 'silo-owner',
      isAdmin: true,
      isDisabled: false,
      email: 'owner@example.com',
      sharedLibraries: undefined,
    });
    expect(viewer).toMatchObject({ id: '34', isAdmin: false, sharedLibraries: ['1', '2'] });
    expect(owner?.lastActivityAt).toBeInstanceOf(Date);
    expect(owner).not.toHaveProperty('thumb');
  });
});

describe('parseSiloProfiles', () => {
  it("reads an account's profiles, the household parent as primary, with no picture", () => {
    expect(parseSiloProfiles(silo.profiles['34'].items)).toEqual([
      {
        id: '494983e2-3141-4ccf-a3b6-e6af431e5996',
        name: 'Viewer',
        thumb: null,
        isPrimary: true,
        isChild: false,
      },
      {
        id: '2770043c-2cab-4bb2-a860-6991aa254f29',
        name: 'Kid',
        thumb: null,
        isPrimary: false,
        isChild: false,
      },
    ]);
  });
});

describe('parseSiloLibraries', () => {
  it('names a series library a show library and keeps the others as Silo names them', () => {
    expect(parseSiloLibraries(silo.libraries.items).map((library) => library.type)).toEqual([
      'movies',
      'show',
      'mixed',
    ]);
  });
});

describe('parseSiloSession', () => {
  it('reads a browser movie session: player named by its device, local, remux video and transcoded audio, sidecar subtitle', () => {
    const names = parseSiloDeviceNames(silo.devices.items);
    const session = parseSiloSession(movieRow, names.get(movieRow.device_id));

    expect(session).toMatchObject({
      sessionKey: '2e64135f-a235-4b3c-b722-ab103395de87',
      mediaId: 'movie-imdb-tt33764258',
      serverVersionKey: '1404',
      user: { id: '1', username: 'silo-owner', profileName: 'silo-owner' },
      media: {
        title: 'The Odyssey',
        type: 'movie',
        durationMs: 10355000,
        thumbPath: `/content/movie-imdb-tt33764258/poster?v=${MOVIE_POSTER_HASH}`,
      },
      playback: { state: 'playing', positionMs: 2568506 },
      player: { name: 'Firefox on macOS', product: 'Silo Web', platform: 'macOS Web' },
      network: { ipAddress: '192.168.1.50', isLocal: true },
      quality: {
        videoDecision: 'copy',
        audioDecision: 'transcode',
        isTranscode: true,
        bitrate: 68232,
        streamVideoCodec: 'HEVC',
        streamAudioCodec: 'AAC',
        subtitleInfo: { codec: 'SUBRIP', language: 'en-US', decision: undefined },
      },
    });
    expect(session.episode).toBeUndefined();
  });

  it('reads an episode session with its show, season and number, and the show poster under the episode id', () => {
    const session = parseSiloSession(episodeRow, 'iPhone');
    const poster = `/content/episode-imdb-tt31510819-1-1/poster?v=${EPISODE_POSTER_HASH}`;

    expect(session).toMatchObject({
      media: { type: 'episode', title: 'Stick or Twist', thumbPath: poster },
      episode: {
        showTitle: 'MobLand',
        seasonNumber: 1,
        episodeNumber: 1,
        showThumbPath: poster,
      },
      network: { ipAddress: '203.0.113.24', isLocal: false },
      quality: { bitrate: 2000, transcodeInfo: { hwEncoding: 'qsv' } },
    });
  });

  it('names the player after the client when its device is unknown', () => {
    expect(parseSiloSession(movieRow, undefined).player.name).toBe('Silo Web');
  });
});

describe('parseSiloLibraryListing', () => {
  it('lists movies and shows as items and episodes as leaves, with one season per show and number', () => {
    const { items, episodes, seasons } = tvListing();

    expect(items.map((item) => item.mediaType)).toEqual(['show', 'show']);
    expect(episodes).toHaveLength(3);
    expect(episodes[0]).toMatchObject({
      mediaType: 'episode',
      parentRatingKey: 'series-imdb-tt0052520/season/1',
      parentTitle: 'Season 1',
      grandparentRatingKey: 'series-imdb-tt0052520',
      grandparentTitle: 'The Twilight Zone',
      parentIndex: 1,
      itemIndex: 1,
    });
    expect(seasons).toHaveLength(2);
    expect(seasons.find((season) => season.parentRatingKey === 'series-imdb-tt0052520')).toEqual(
      expect.objectContaining({
        ratingKey: 'series-imdb-tt0052520/season/1',
        title: 'Season 1',
        mediaType: 'season',
        parentTitle: 'The Twilight Zone',
        parentIndex: 1,
        addedAt: new Date('2026-11-19T01:06:08.996Z'),
      })
    );

    const reversed = parseSiloLibraryListing(silo.catalog['2'].items.toReversed(), '2');
    expect(
      reversed.seasons.find((season) => season.parentRatingKey === 'series-imdb-tt0052520')?.addedAt
    ).toEqual(new Date('2026-11-19T01:06:08.996Z'));
  });

  it("gives an episode its series poster path, so a show's episodes share one cached poster", () => {
    const { items, episodes } = tvListing();

    for (const episode of episodes) {
      const series = items.find((item) => item.ratingKey === episode.grandparentRatingKey);
      expect(episode.thumbPath).toBeDefined();
      expect(episode.thumbPath).toBe(series?.thumbPath);
    }
  });

  it("keeps only the listed library's files on an item two libraries hold", () => {
    const movie = nth(silo.catalog['1'].items, 0);
    const file = nth(movie.versions, 0);
    const shared = { ...movie, versions: [file, { ...file, file_id: '9001', library_id: '9' }] };

    const [item] = parseSiloLibraryListing([shared], '1').items;

    expect(item?.versions).toHaveLength(1);
    expect(item?.fileSize).toBe(file.file_size);
  });

  it('leaves out a provider id that is not a number', () => {
    const movie = nth(silo.catalog['1'].items, 0);

    const [item] = parseSiloLibraryListing(
      [{ ...movie, tmdb_id: 'tt-unknown', tvdb_id: '' }],
      '1'
    ).items;

    expect(item?.tmdbId).toBeUndefined();
    expect(item?.tvdbId).toBeUndefined();
    expect(item?.imdbId).toBe('tt0038650');
  });

  it("reads a file's resolution, codecs, dynamic range and size", () => {
    const item = parseSiloLibraryListing(silo.catalog['1'].items, '1').items.find(
      (movie) => movie.title === "It's a Wonderful Life"
    );

    expect(item?.versions).toEqual([
      expect.objectContaining({
        serverVersionKey: '615',
        videoResolution: '4k',
        videoCodec: 'HEVC',
        videoDynamicRange: 'dolby vision',
        audioCodec: 'FLAC',
        audioChannels: 2,
        container: 'mkv',
        bitrate: 51176,
        fileSize: 50104359697,
      }),
    ]);
    expect(item).toMatchObject({ imdbId: 'tt0038650', tmdbId: 1585, videoResolution: '4k' });
  });
});

describe('siloPosterPath', () => {
  it("stores the poster's content hash in the path, no hash for an unhashed link, and no path for a URL outside Silo", () => {
    const hashed = siloPosterPath('movie-imdb-tt33764258', movieRow.poster_url);
    expect(hashed).toBe(`/content/movie-imdb-tt33764258/poster?v=${MOVIE_POSTER_HASH}`);
    expect(siloPosterPath('movie-x', '/api/v2/item-posters/movie-x?exp=1&sig=a')).toBe(
      '/content/movie-x/poster'
    );
    expect(siloPosterPath('movie-x', 'https://image.tmdb.org/t/p/w300/a.jpg')).toBeUndefined();
    expect(siloPosterPath('movie-x', undefined)).toBeUndefined();

    expect(
      parseSiloPosterPath(`/content/movie-imdb-tt33764258/poster?v=${MOVIE_POSTER_HASH}`)
    ).toBe('movie-imdb-tt33764258');
    expect(parseSiloPosterPath('/content/movie-x/poster')).toBe('movie-x');
    expect(parseSiloPosterPath('/content/../poster')).toBeNull();
    expect(parseSiloPosterPath('/content/a/poster?v=XYZ')).toBeNull();
    expect(parseSiloPosterPath('/api/v2/artwork/x')).toBeNull();
  });
});
