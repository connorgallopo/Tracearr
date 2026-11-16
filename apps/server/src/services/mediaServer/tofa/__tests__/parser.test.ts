import { describe, it, expect } from 'vitest';
import tofa from '../../../../test/mediaServerResponses/tofa.json' with { type: 'json' };
import {
  parseKeyScopes,
  parseTofaDownloadSource,
  parseTofaLibraryItem,
  parseTofaLiveSession,
  parseTofaMedia,
  parseTofaMetrics,
  parseTofaSession,
  parseTofaShowChildren,
  parseAccountLinks,
  parseUsers,
} from '../parser.js';
import type { TofaLiveNowPlayingSession, TofaProfile } from '../types.js';

const TOKEN = 'tofa_5c1e9a4f7b2d8e0a';

function key(fields: { read_only?: boolean; can_stop_streams?: boolean }) {
  return { key_prefix: 'tofa_5c1e9a', revoked_at: null, ...fields };
}

describe('parseKeyScopes', () => {
  it.each([
    ['a full-admin key', { read_only: false, can_stop_streams: false }, false, true],
    ['a read-only key allowed to stop', { read_only: true, can_stop_streams: true }, true, true],
    ['a read-only key', { read_only: true, can_stop_streams: false }, true, false],
    ['a key from before scopes existed', {}, false, true],
  ])('%s', (_name, fields, readOnly, canStopStreams) => {
    expect(parseKeyScopes([key(fields)], TOKEN)).toEqual({ readOnly, canStopStreams });
  });

  it('skips a revoked key that shares the prefix', () => {
    const revoked = { ...key({ read_only: true }), revoked_at: '2025-03-01T00:00:00Z' };
    expect(parseKeyScopes([revoked, key({ read_only: false })], TOKEN).readOnly).toBe(false);
  });

  it('fails when the server does not list the key', () => {
    expect(() => parseKeyScopes([], TOKEN)).toThrow('tofa did not list the API key');
  });
});

describe('parseUsers', () => {
  it('gives a user missing from the cloud list no libraries', () => {
    const [user] = parseUsers(
      [{ id: 'u1', username: 'sam', email: null, is_admin: null, disabled: false }],
      [],
      []
    );
    expect(user).toMatchObject({ isAdmin: false, sharedLibraries: [] });
  });

  it('carries the cloud identity, and none for revoked access', () => {
    const user = (id: string) => ({ id, username: id, disabled: false });
    const cloud = (localUserId: string, revokedAt: string | null) => ({
      local_user_id: localUserId,
      cloud_identity_id: `identity-${localUserId}`,
      revoked_at: revokedAt,
      library_ids: [],
      unrestricted_libraries: true,
    });

    const parsed = parseUsers(
      [user('member'), user('revoked'), user('local-only')],
      [cloud('member', null), cloud('revoked', '2026-11-01T00:00:00Z')],
      []
    );

    expect(parsed.map((u) => u.cloudIdentityId)).toEqual(['identity-member', null, null]);
  });

  describe('pictures', () => {
    const user = { id: 'u1', username: 'sam', disabled: false };
    const profile = (fields: Partial<TofaProfile>): TofaProfile => ({
      id: 'p1',
      user_id: 'u1',
      name: 'sam',
      is_primary: true,
      ...fields,
    });
    const thumbOf = (profiles: TofaProfile[] | null) => parseUsers([user], [], profiles)[0]?.thumb;

    it("uses the primary profile's uploaded picture", () => {
      expect(
        thumbOf([
          profile({
            avatar_image_url: 'https://cdn.example.com/a.png',
            avatar_ref: 'preset:astronaut',
          }),
        ])
      ).toBe('https://cdn.example.com/a.png');
    });

    it('falls back to the preset image for a preset avatar', () => {
      expect(thumbOf([profile({ avatar_ref: 'preset:astronaut' })])).toBe(
        '/api/v1/profiles/avatars/astronaut.png'
      );
    });

    it('gives no picture when the primary profile has neither', () => {
      expect(thumbOf([profile({})])).toBeNull();
      expect(thumbOf([])).toBeNull();
    });

    it("ignores pictures on profiles that are not the user's primary", () => {
      expect(
        thumbOf([
          profile({ is_primary: false, avatar_ref: 'preset:astronaut' }),
          profile({ user_id: 'u2', avatar_ref: 'preset:robot' }),
        ])
      ).toBeNull();
    });

    it('says pictures were not read when profiles were not read', () => {
      const [unread] = parseUsers([user], [], null);
      expect(unread?.picturesUnread).toBe(true);
      expect(unread?.thumb).toBeUndefined();
      expect(parseUsers([user], [], [])[0]?.picturesUnread).toBeUndefined();
    });
  });
});

describe('parseAccountLinks', () => {
  it('keeps the links that name the account and its server', () => {
    const link = { user_id: 'u1', provider: 'plex' };
    expect(
      parseAccountLinks([
        { ...link, external_user_id: '308951159', external_server_id: 'machine-1' },
        { ...link, external_user_id: null, external_server_id: 'machine-1' },
        link,
      ])
    ).toEqual([
      {
        userId: 'u1',
        provider: 'plex',
        externalUserId: '308951159',
        externalServerId: 'machine-1',
      },
    ]);
  });
});

describe('parseTofaSession', () => {
  const media = new Map(tofa.mediaBatch.map((detail) => [detail.id, parseTofaMedia(detail)]));

  /** A recorded session row, with its now-playing row and its media */
  function recorded(index: number) {
    const row = tofa.playbackSessions[index];
    if (!row) throw new Error(`no recorded session ${index}`);
    const nowPlaying = tofa.nowPlaying.sessions.find((s) => s.session_id === row.session_id);
    return { row, nowPlaying, media: media.get(row.media_id) };
  }

  it('maps a web transcode of a movie', () => {
    const { row, nowPlaying, media } = recorded(0);
    const session = parseTofaSession(row, nowPlaying, media);

    expect(session).toMatchObject({
      sessionKey: row.session_id,
      mediaId: row.media_id,
      serverVersionKey: row.media_file_id,
      user: {
        id: 'b1e4c7a2-5d38-4f91-8a6c-2e7f0d3b9c14',
        username: 'morgan',
        profileName: 'Morgan',
      },
      media: { title: 'The Paper Kite', type: 'movie', durationMs: 5826000, year: 2019 },
      playback: { state: 'playing', positionMs: 162749 },
      player: {
        name: 'Firefox on macOS',
        product: 'tofa Web',
        device: 'Firefox 159',
        platform: 'web',
      },
      network: { ipAddress: '192.168.1.20' },
      quality: {
        bitrate: 54210,
        isTranscode: true,
        videoDecision: 'transcode',
        audioDecision: 'transcode',
        sourceVideoCodec: 'HEVC',
        sourceAudioCodec: 'DTS',
        streamVideoCodec: 'H264',
        streamAudioCodec: 'AAC',
        sourceVideoDetails: { dynamicRange: 'Dolby Vision' },
        transcodeInfo: {
          hwEncoding: 'qsv',
          speed: row.transcode_speed,
          reasons: ['AudioCodecNotSupported', 'ContainerNotSupported', 'HdrRequiresToneMapping'],
        },
      },
    });
    expect(session.quality.sourceVideoDetails?.bitrate).toBeUndefined();
    expect(session.quality.streamVideoDetails?.bitrate).toBeUndefined();
  });

  it('carries the subtitle track the player shows', () => {
    const { row, nowPlaying, media } = recorded(0);
    // Built from the server's SelectedSubtitle schema: no client has reported one yet
    const subtitled = {
      ...row,
      selected_subtitle: { codec: 'subrip', language: 'eng', forced: false, burned_in: true },
    };

    expect(parseTofaSession(row, nowPlaying, media).quality.subtitleInfo).toBeUndefined();
    expect(parseTofaSession(subtitled, nowPlaying, media).quality.subtitleInfo).toEqual({
      codec: 'SUBRIP',
      language: 'eng',
      decision: 'burn',
    });
  });

  it('carries playback health only from a player that measured it', () => {
    const web = recorded(0);
    const ios = recorded(2);
    const webInfo = parseTofaSession(web.row, web.nowPlaying, web.media).quality.transcodeInfo;
    const iosInfo = parseTofaSession(ios.row, ios.nowPlaying, ios.media).quality.transcodeInfo;

    expect(webInfo?.rebufferCount).toBeUndefined();
    expect(webInfo?.droppedFrames).toBeUndefined();
    expect(iosInfo).toMatchObject({ rebufferCount: 0, droppedFrames: 0 });
  });

  it('maps an episode, keyed by the episode its file holds, with copied video', () => {
    const { row, nowPlaying, media } = recorded(1);

    expect(parseTofaSession(row, nowPlaying, media)).toMatchObject({
      mediaId: '7e0f0000-3a1c-4d2e-9b5f-00000000000b',
      media: { title: 'The Night Ferry', type: 'episode', year: 2012 },
      episode: {
        showTitle: 'Harbor Lights',
        showId: row.media_id,
        seasonNumber: 3,
        episodeNumber: 2,
      },
      quality: { isTranscode: true, videoDecision: 'copy', audioDecision: 'transcode' },
    });
  });

  it('reads the output size from resolution and the source size from source_resolution', () => {
    const { row, nowPlaying, media } = recorded(2);

    expect(parseTofaSession(row, nowPlaying, media).quality).toMatchObject({
      videoWidth: 3840,
      videoHeight: 2152,
      streamVideoDetails: { width: 1920, height: 1080 },
    });
  });

  it('keeps the title the session carried and no item key when its media is unknown', () => {
    const { row, nowPlaying } = recorded(2);

    expect(parseTofaSession(row, nowPlaying, undefined)).toMatchObject({
      mediaId: '',
      media: { title: 'Harbor Lights - S03E02 - The Night Ferry', type: 'unknown' },
    });
  });

  it('gives a relayed session no address', () => {
    const { row, nowPlaying, media } = recorded(2);
    const relayed = { ...row, connection_mode: 'relay' };

    expect(parseTofaSession(relayed, nowPlaying, media).network).toEqual({
      ipAddress: '',
      isLocal: false,
      relayed: true,
    });
  });

  it('records a channel play as live TV on its channel, with no position to read', () => {
    const [row] = tofa.livePlaybackSessions;
    const [nowPlaying] = tofa.liveNowPlaying.sessions;
    const [viewer] = tofa.liveAdminNow.sessions;
    if (!row) throw new Error('no recorded channel play');

    expect(parseTofaSession(row, nowPlaying, media.get(row.media_id), viewer)).toMatchObject({
      sessionKey: row.session_id,
      mediaId: nowPlaying?.live_channel_id,
      media: { title: 'The Paper Kite', type: 'live', durationMs: 0, year: 2019 },
      live: {
        channelTitle: 'Harbor Classics',
        channelIdentifier: '512',
        channelThumb: viewer?.logo_image_url,
      },
      playback: { state: 'playing', positionMs: 0, progressPercent: 0 },
      network: { ipAddress: '203.0.113.44' },
    });
  });

  it('names the show, season and episode of an episode on a channel', () => {
    const [live] = tofa.livePlaybackSessions;
    const [nowPlaying] = tofa.liveNowPlaying.sessions;
    const episode = recorded(1);
    if (!live) throw new Error('no recorded channel play');
    const row = {
      ...live,
      media_id: episode.row.media_id,
      media_file_id: episode.row.media_file_id,
    };

    expect(parseTofaSession(row, nowPlaying, episode.media)).toMatchObject({
      mediaId: nowPlaying?.live_channel_id,
      media: { title: 'The Night Ferry', type: 'live' },
      episode: { showTitle: 'Harbor Lights' },
    });
  });

  it('records a channel play as live TV without channel details when tofa lists no viewer for it', () => {
    const [row] = tofa.livePlaybackSessions;
    const [nowPlaying] = tofa.liveNowPlaying.sessions;
    if (!row) throw new Error('no recorded channel play');

    const session = parseTofaSession(row, nowPlaying, undefined);
    expect(session).toMatchObject({
      mediaId: nowPlaying?.live_channel_id,
      media: { title: 'The Paper Kite', type: 'live' },
    });
    expect(session.live).toBeUndefined();
  });
});

describe('parseTofaLiveSession', () => {
  // Built from the server's LiveNowPlayingSession schema: no live TV play has been recorded
  const live: TofaLiveNowPlayingSession = {
    session_id: 'live-session-1',
    viewer: {
      viewer_id: 'viewer-1',
      channel_id: 'channel-7',
      channel_name: 'Harbor News',
      channel_number: { display: '7.1' },
      logo_image_url: null,
      programme_title: 'Evening Report',
      user_id: 'b1e4c7a2-5d38-4f91-8a6c-2e7f0d3b9c14',
      user_name: 'morgan',
      profile_name: null,
      device_name: 'Living Room TV',
      client_name: 'tofa Android TV',
      device_model: 'Shield',
    },
    platform: 'android_tv',
    source: { bitrate_kbps: 8000 },
    sent: {
      video_copied: true,
      video_codec: 'h264',
      audio_codec: 'aac',
      audio_converted: true,
      width: 1920,
      height: 1080,
      bitrate_kbps: 7600,
    },
    transcode_reason_codes: [],
  };

  it('keys a live viewer by its viewer id, marked as no playback session', () => {
    expect(parseTofaLiveSession(live)).toMatchObject({
      sessionKey: 'viewer:viewer-1',
      mediaId: 'channel-7',
      media: { title: 'Evening Report', type: 'live' },
      live: { channelTitle: 'Harbor News', channelIdentifier: '7.1' },
      quality: { videoDecision: 'copy', audioDecision: 'transcode', bitrate: 7600 },
    });
  });
});

describe('parseTofaLibraryItem', () => {
  const [movie, show] = tofa.mediaBatch;
  if (!movie || !show) throw new Error('fixture lacks a movie and a show');

  it('maps a movie with its file as one version and the quality rolled up from it', () => {
    const item = parseTofaLibraryItem(movie);

    expect(item).toMatchObject({
      ratingKey: movie.id,
      title: 'The Paper Kite',
      mediaType: 'movie',
      addedAt: new Date('2025-03-01T12:00:00Z'),
      imdbId: movie.imdb_id,
      tmdbId: movie.tmdb_id,
      thumbPath: `/api/v1/artwork/${movie.id}/poster`,
      videoResolution: '4k',
      videoCodec: 'HEVC',
      videoDynamicRange: 'dolby vision',
      audioCodec: 'DTS',
      audioChannels: 6,
      container: 'mkv',
      fileSize: 41237765120,
    });
    expect(item.versions).toEqual([
      expect.objectContaining({ serverVersionKey: movie.files[0]?.id, bitrate: 54440 }),
    ]);
  });

  it('maps a show by its tvdb id, without files of its own', () => {
    const item = parseTofaLibraryItem(show);

    expect(item).toMatchObject({ mediaType: 'show', tvdbId: 100001, imdbId: 'tt0000001' });
    expect(item.versions).toBeUndefined();
  });
});

describe('parseTofaShowChildren', () => {
  const show = tofa.mediaBatch[1];
  if (!show) throw new Error('fixture lacks a show');

  it('lists each episode with a file under its season and show, and the seasons holding them', () => {
    const { seasons, episodes } = parseTofaShowChildren(show);

    expect(seasons.map((s) => [s.title, s.parentIndex, s.parentRatingKey])).toEqual([
      ['Season 1', 1, show.id],
      ['Season 3', 3, show.id],
    ]);
    expect(seasons[0]?.thumbPath).toMatch(/^\/cache\/images\/posters\//);
    const episode = episodes.find((e) => e.parentIndex === 3);
    expect(episode).toMatchObject({
      mediaType: 'episode',
      itemIndex: 2,
      grandparentTitle: 'Harbor Lights',
      grandparentRatingKey: show.id,
      parentRatingKey: seasons[1]?.ratingKey,
      addedAt: new Date('2025-03-01T12:00:00Z'),
      videoResolution: '4k',
    });
    expect(episode?.thumbPath).toBeUndefined();
  });

  it('dates a file by its modified time from the episode air day until tofa saw it', () => {
    const dated = {
      ...show,
      files: show.files.map((file) => ({ ...file, file_modified_at: '2014-09-26T03:00:00Z' })),
    };
    const airDay = new Date('2014-09-26T03:00:00Z');
    const { seasons, episodes } = parseTofaShowChildren(dated);

    expect(parseTofaLibraryItem(dated).addedAt).toEqual(airDay);
    expect([...seasons, ...episodes].map((item) => item.addedAt)).toEqual(
      Array.from({ length: 4 }, () => airDay)
    );
  });

  it('dates a file by when tofa saw it when its modified time is missing, before release or later', () => {
    const seen = new Date('2025-03-01T12:00:00Z');
    const early = {
      ...show,
      added_at: '2005-04-18T10:00:00Z',
      files: show.files.map((file) => ({ ...file, file_modified_at: '2005-04-18T10:00:00Z' })),
    };
    const late = {
      ...show,
      files: show.files.map((file) => ({ ...file, file_modified_at: '2026-01-01T00:00:00Z' })),
    };
    const undated = {
      ...show,
      files: show.files.map((file) => ({ ...file, file_modified_at: null })),
    };

    for (const detail of [early, late, undated]) {
      const { seasons, episodes } = parseTofaShowChildren(detail);
      expect(parseTofaLibraryItem(detail).addedAt).toEqual(seen);
      expect([...seasons, ...episodes].map((item) => item.addedAt)).toEqual(
        Array.from({ length: 4 }, () => seen)
      );
    }
  });
});

describe('parseTofaMetrics', () => {
  it('maps the recent samples to host load, counting transcodes and previews as the server', () => {
    expect(parseTofaMetrics(tofa.metrics, 120)[1]).toEqual({
      at: 1740873602,
      timespan: 2,
      hostCpuUtilization: 20,
      processCpuUtilization: 7.5,
      hostMemoryUtilization: 50,
      processMemoryUtilization: expect.closeTo(10, 3),
    });
  });

  it('keeps only the samples inside the window', () => {
    expect(parseTofaMetrics(tofa.metrics, 2).map((point) => point.at)).toEqual([
      1740873602, 1740873604,
    ]);
  });
});

describe('parseTofaDownloadSource', () => {
  const download = tofa.downloads.items[0];
  const file = tofa.mediaBatch[1]?.files[0];
  const request = {
    itemKey: null,
    partId: file?.id ?? null,
    deviceId: download?.device_id ?? null,
    userId: download?.user_id ?? null,
    app: null,
    device: null,
  };

  it('describes a converted download by the quality it was converted to, size unknown', () => {
    expect(parseTofaDownloadSource(request, download, file)).toEqual({
      version: expect.objectContaining({ key: file?.id, videoCodec: 'HEVC' }),
      delivered: {
        bytes: null,
        videoCodec: null,
        audioCodec: null,
        container: null,
        bitrateKbps: 3160,
        resolution: null,
      },
      device: {
        deviceId: download?.device_id,
        playerName: download?.device_name,
        product: null,
        platform: null,
      },
      ipAddress: null,
    });
  });

  it('describes an original download as the file itself', () => {
    const original = download && { ...download, quality_key: 'original' };
    expect(parseTofaDownloadSource(request, original, file).delivered).toMatchObject({
      bytes: file?.file_size,
      container: 'mkv',
    });
  });
});
