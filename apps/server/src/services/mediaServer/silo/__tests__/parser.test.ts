import { describe, it, expect } from 'vitest';
import { normalizeResolution } from '@tracearr/shared';
import silo from '../../../../test/mediaServerResponses/silo.json' with { type: 'json' };
import { formatQualityString } from '../../../../utils/resolutionNormalizer.js';
import { normalizeStreamDecisions } from '../../../../utils/transcodeNormalizer.js';
import {
  parseSiloDeviceNames,
  parseSiloDownloadSource,
  parseSiloLibraries,
  parseSiloLibraryListing,
  parseSiloPosterPath,
  parseSiloProfiles,
  parseSiloAvatarPath,
  parseSiloResources,
  parseSiloSession,
  parseSiloUsers,
  siloHistoryProfileNaming,
  siloItemPosterPath,
  siloPosterPath,
  siloStreamDecisions,
  siloWatchedSeconds,
} from '../parser.js';
import type { SiloHistoryRow, SiloProfile, SiloSystemResources } from '../types.js';

const MOVIE_POSTER_HASH = '200475196580003a17cdfe2a5f5452208ae0a2c2ece48fba60ca08333146727b';
const EPISODE_POSTER_HASH = '8ca719eb62703cb1e5f46090e8d20cc8c7b9941173d0992d0e6b54b8a8b1b8a6';

function nth<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`the fixture has no item ${index}`);
  return item;
}

const movieRow = nth(silo.sessions.items, 0);
const episodeRow = nth(silo.sessions.items, 1);
const historyRow = (sessionId: string): SiloHistoryRow => {
  const row = silo.history.items.find((item) => item.session_id === sessionId);
  if (!row) throw new Error(`the fixture has no history row ${sessionId}`);
  return row;
};
const tvListing = () => parseSiloLibraryListing(silo.catalog['2'].items, '2');

const KID = '2770043c-2cab-4bb2-a860-6991aa254f29';
const UPLOAD_URL = `/api/v2/artwork/profile-avatars/34/${KID}/w256.webp?exp=1795372200&sig=c2lnbmF0dXJl`;
const DICEBEAR_URL =
  'https://api.dicebear.com/9.x/bottts-neutral/svg?backgroundType=gradientLinear&radius=24&seed=kid&size=128';

/** The viewer's profiles with the Viewer profile's avatar and the Kid profile's set as given */
function viewerProfiles(
  viewer: Partial<SiloProfile>,
  kid: Partial<SiloProfile> = {}
): SiloProfile[] {
  const [primary, second] = silo.profiles['34'].items;
  if (!primary || !second) throw new Error('the fixture has no viewer profiles');
  return [
    { ...primary, ...viewer },
    { ...second, ...kid },
  ];
}

describe('parseSiloUsers', () => {
  it('maps accounts with their email, admin role, join date and the libraries their policy allows', () => {
    const [owner, viewer] = parseSiloUsers(silo.users.items, new Map());

    expect(owner).toMatchObject({
      id: '1',
      username: 'silo-owner',
      isAdmin: true,
      isDisabled: false,
      email: 'owner@example.com',
      sharedLibraries: undefined,
      joinedAt: new Date('2026-11-19T00:54:17.543Z'),
    });
    expect(viewer).toMatchObject({
      id: '34',
      isAdmin: false,
      sharedLibraries: ['1', '2'],
      joinedAt: new Date('2026-11-19T01:12:31.344Z'),
    });
    expect(owner?.lastActivityAt).toBeInstanceOf(Date);
  });

  it("gives an account its primary profile's picture, and none when that profile has none", () => {
    const profiles = new Map([
      ['1', silo.profiles['1'].items],
      [
        '34',
        viewerProfiles(
          { avatar_source: 'preset', avatar_url: '/profile-avatars/avatar-3.svg' },
          { avatar_source: 'upload', avatar_url: UPLOAD_URL }
        ),
      ],
    ]);

    const [owner, viewer] = parseSiloUsers(silo.users.items, profiles);

    expect(owner).toMatchObject({ thumb: null });
    expect(viewer).toMatchObject({ thumb: '/profile-avatars/avatar-3.svg' });
  });

  it('leaves the stored pictures as they are when the profiles could not be read', () => {
    for (const user of parseSiloUsers(silo.users.items, null)) {
      expect(user).toMatchObject({ picturesUnread: true });
      expect(user).not.toHaveProperty('thumb');
    }
  });
});

describe('parseSiloProfiles', () => {
  it("reads an account's profiles, the household parent as primary, with no picture where none is set", () => {
    expect(parseSiloProfiles(silo.profiles['34'].items, '34')).toEqual([
      {
        id: '494983e2-3141-4ccf-a3b6-e6af431e5996',
        name: 'Viewer',
        thumb: null,
        isPrimary: true,
        isChild: false,
      },
      {
        id: KID,
        name: 'Kid',
        thumb: null,
        isPrimary: false,
        isChild: false,
      },
    ]);
  });

  it("keeps a bundled or DiceBear preset as Silo gives it, and files an upload by its account and profile, since Silo's link to it expires", () => {
    const thumbs = (viewer: Partial<SiloProfile>) =>
      parseSiloProfiles(viewerProfiles(viewer), '34').map((profile) => profile.thumb)[0];

    expect(thumbs({ avatar_source: 'preset', avatar_url: '/profile-avatars/avatar-3.svg' })).toBe(
      '/profile-avatars/avatar-3.svg'
    );
    expect(thumbs({ avatar_source: 'preset', avatar_url: DICEBEAR_URL })).toBe(DICEBEAR_URL);
    expect(
      parseSiloProfiles(
        viewerProfiles({}, { avatar_source: 'upload', avatar_url: UPLOAD_URL }),
        '34'
      )[1]?.thumb
    ).toBe(`/users/34/profiles/${KID}/avatar`);
  });

  it('gives no picture for one it could not fetch: another host, an unknown path, or an upload with no link', () => {
    const thumbs = (viewer: Partial<SiloProfile>) =>
      parseSiloProfiles(viewerProfiles(viewer), '34').map((profile) => profile.thumb)[0];

    expect(
      thumbs({ avatar_source: 'preset', avatar_url: 'https://elsewhere.example/a.svg' })
    ).toBeNull();
    expect(thumbs({ avatar_source: 'preset', avatar_url: '/profile-avatars/../x.svg' })).toBeNull();
    expect(thumbs({ avatar_source: 'upload' })).toBeNull();
    expect(
      thumbs({
        avatar_source: 'upload',
        avatar_url: 'https://bucket.example/profile-avatars/w256.webp',
      })
    ).toBeNull();
  });
});

describe('parseSiloAvatarPath', () => {
  it('reads the account and profile of a stored upload path, and nothing else', () => {
    expect(parseSiloAvatarPath(`/users/34/profiles/${KID}/avatar`)).toEqual({
      accountId: '34',
      profileId: KID,
    });
    expect(parseSiloAvatarPath('/users/../profiles/x/avatar')).toBeNull();
    expect(parseSiloAvatarPath('/content/movie-1/poster')).toBeNull();
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

describe('parseSiloSession quality', () => {
  const tierOf = (height: number | undefined) => normalizeResolution({ height });

  it("files a cropped source by Silo's size label, so a 1920x800 film is 1080p", () => {
    const { quality } = parseSiloSession(silo.socket.sessionStarted.data.session, undefined);

    expect(tierOf(quality.videoHeight)).toBe('1080p');
    expect(formatQualityString(quality)).toBe('1080p');
  });

  it('reads a 2160p to 720p transcode as a 4K source sent at 720p, which is a downscale', () => {
    const { quality } = parseSiloSession(episodeRow, 'iPhone');

    expect(tierOf(quality.videoHeight)).toBe('4K');
    expect(tierOf(quality.streamVideoDetails?.height)).toBe('720p');
    expect(formatQualityString(quality)).toBe('720p');
  });

  it('sends copied video at the source size, so an audio-only transcode is no downscale', () => {
    const { quality } = parseSiloSession(movieRow, undefined);

    expect(quality.isTranscode).toBe(true);
    expect(quality.streamVideoDetails?.height).toBe(quality.videoHeight);
    expect(formatQualityString(quality)).toBe('4K');
  });

  it("reads a transcode Silo names by the source's own height as the source's size", () => {
    const fullSize = {
      ...episodeRow,
      source_video_height: 1600,
      target_resolution: '1600p',
    };

    expect(tierOf(parseSiloSession(fullSize, undefined).quality.streamVideoDetails?.height)).toBe(
      '4K'
    );
  });

  it("keeps the source's size for a video transcode Silo gives no target resolution", () => {
    for (const target_resolution of [undefined, '']) {
      const { quality } = parseSiloSession({ ...episodeRow, target_resolution }, undefined);

      expect(tierOf(quality.streamVideoDetails?.height)).toBe('4K');
      expect(formatQualityString(quality)).toBe('4K');
    }
  });

  it('falls back to the pixel height when Silo sends no size label', () => {
    const unlabeled = { ...movieRow, source_video_resolution: undefined, source_video_height: 720 };

    expect(tierOf(parseSiloSession(unlabeled, undefined).quality.videoHeight)).toBe('720p');
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

describe('siloItemPosterPath', () => {
  it("files an item's poster by its content id, unversioned, and none for an unsafe id", () => {
    const path = siloItemPosterPath('episode-imdb-tt31510819-1-1');
    expect(path).toBe('/content/episode-imdb-tt31510819-1-1/poster');
    expect(parseSiloPosterPath(path ?? '')).toBe('episode-imdb-tt31510819-1-1');
    for (const id of ['', '..', 'a/b']) expect(siloItemPosterPath(id)).toBeUndefined();
  });
});

describe('siloStreamDecisions', () => {
  it('reads remux as copy and counts a transcoded stream, for live rows and history alike', () => {
    const decisions = siloStreamDecisions('remux', 'transcode');
    expect(decisions).toEqual(normalizeStreamDecisions('copy', 'transcode'));
    expect(decisions.isTranscode).toBe(true);
    expect(siloStreamDecisions(null, null).isTranscode).toBe(false);
  });
});

describe('siloWatchedSeconds', () => {
  it("times a history play by Silo's measurement, and an unmeasured one as Silo's own page estimates it", () => {
    const zootopia = historyRow('838e94ff-d2ff-44c8-ac63-25299597ef7d');
    const odyssey = historyRow('8415ab73-3647-4e59-9ea0-f627e60333eb');

    expect(siloWatchedSeconds(zootopia)).toBe(70.900083828);
    expect(siloWatchedSeconds(odyssey)).toBeCloseTo(
      (Date.parse('2026-11-19T01:06:58.525Z') - Date.parse('2026-11-19T01:06:42.274Z')) / 1000
    );
    expect(siloWatchedSeconds({ ...odyssey, end_position_seconds: 5 })).toBe(5);
    expect(siloWatchedSeconds({ ...odyssey, ended_at: '2026-11-19T01:06:41.274Z' })).toBe(0);
  });
});

describe('siloHistoryProfileNaming', () => {
  it("names a history play's account and profile, and leaves a profile Silo recorded no name for unnamed", () => {
    const kid = historyRow('838e94ff-d2ff-44c8-ac63-25299597ef7d');

    expect(siloHistoryProfileNaming(kid)).toEqual({
      accountExternalId: '34',
      profileExternalId: '2770043c-2cab-4bb2-a860-6991aa254f29',
      profileName: 'Kid',
    });
    expect(siloHistoryProfileNaming({ ...kid, profile_name: kid.profile_id }).profileName).toBe(
      null
    );
  });
});

describe('parseSiloResources', () => {
  const second = nth(silo.resources, 1);
  const withSystem = (system: Partial<NonNullable<SiloSystemResources['system']>>) => ({
    ...second,
    system: { cpu_pct: 2, cores: 16, mem_used_mb: 1163, mem_total_mb: 12288, ...system },
  });

  it("charts a sample as Silo's dashboard shows it, from the first sample on", () => {
    expect(parseSiloResources(second)).toEqual({
      at: Math.floor(Date.parse('2026-11-21T17:39:52.829Z') / 1000),
      hostCpuUtilization: 2,
      hostMemoryUtilization: (1163 / 12288) * 100,
      processCpuUtilization: null,
      processMemoryUtilization: (1220411392 / 12884901888) * 100,
    });
  });

  it("charts no CPU share for Silo's process, whatever cgroup its counter covers", () => {
    const ancestor = {
      ...second,
      attribution: {
        ...second.attribution,
        cgroup_cpu: { version: 'v2', scope: 'ancestor', usage_seconds: 5000 },
      },
    };

    expect(parseSiloResources(ancestor)?.processCpuUtilization).toBeNull();
  });

  it("does not add Silo's transcoders to its cgroup's working set, which already holds them", () => {
    const transcoding = {
      ...second,
      attribution: {
        ...second.attribution,
        children: { workload: 'ffmpeg', resident_bytes: 1024 * 1024 * 1024, cpu_seconds: 3 },
      },
    };

    expect(parseSiloResources(transcoding)?.processMemoryUtilization).toBeCloseTo(
      (1220411392 / 12884901888) * 100
    );
  });

  it("charts Silo's process memory when the cgroup it can see is shared with other workloads", () => {
    const ancestor = {
      ...second,
      attribution: {
        ...second.attribution,
        cgroup_memory: { scope: 'ancestor', working_set_bytes: 8 * 1024 * 1024 * 1024 },
      },
    };

    expect(parseSiloResources(ancestor)?.processMemoryUtilization).toBeCloseTo(
      (384167936 / 12884901888) * 100
    );
  });

  it("charts Silo's process memory when Silo cannot read its cgroup", () => {
    const point = parseSiloResources({
      ...second,
      attribution: { sample_interval_seconds: 5, process: { resident_bytes: 384167936 } },
    });

    expect(point?.processMemoryUtilization).toBeCloseTo((384167936 / 12884901888) * 100);
  });

  it('adds no point when Silo reports neither its cgroup nor its process memory', () => {
    expect(
      parseSiloResources({ ...second, attribution: { sample_interval_seconds: 5 } })
    ).toBeNull();
  });

  it('leaves out a reading Silo marks unavailable rather than charting it as zero', () => {
    const point = parseSiloResources({
      ...second,
      attribution: {
        sample_interval_seconds: 5,
        process: { resident_bytes: 384167936 },
        cpu: { available: false },
        memory: { available: false },
      },
    });

    expect(point?.hostCpuUtilization).toBeNull();
    expect(point?.hostMemoryUtilization).toBeNull();
    expect(point?.processMemoryUtilization).toBeCloseTo((384167936 / 12884901888) * 100);
  });

  it('adds no point for a stale or unavailable sample, which is not zero load', () => {
    expect(parseSiloResources({ ...second, stale: true })).toBeNull();
    expect(parseSiloResources({ ...second, available: false })).toBeNull();
  });

  it('adds no point when Silo reports no memory total to measure against', () => {
    expect(parseSiloResources(withSystem({ mem_total_mb: 0 }))).toBeNull();
  });

  it('still charts a sample that reports no core count, which nothing is divided by', () => {
    expect(parseSiloResources(withSystem({ cores: 0 }))?.hostCpuUtilization).toBe(2);
  });
});

describe('parseSiloDownloadSource', () => {
  const request = {
    itemKey: 'episode-imdb-tt31510819-1-1',
    partId: null,
    deviceId: 'aef454b9-44e6-412f-913b-3e3a5eb0dbee',
    userId: '1',
    app: null,
    device: 'Silo iPhone',
  };

  it('describes a download by the address it was created from, else its last, with what it sent', () => {
    const mobland = parseSiloDownloadSource(request, nth(silo.downloadEntries.items, 1));

    expect(mobland).toMatchObject({
      version: null,
      ipAddress: '203.0.113.24',
      delivered: { bytes: 6497401574, bitrateKbps: null },
      device: { playerName: 'iPhone' },
    });
    expect(parseSiloDownloadSource(request, nth(silo.downloadEntries.items, 2)).ipAddress).toBe(
      '192.168.1.50'
    );
    expect(parseSiloDownloadSource(request, undefined)).toMatchObject({
      ipAddress: null,
      delivered: null,
      device: { playerName: 'Silo iPhone' },
    });
  });
});
