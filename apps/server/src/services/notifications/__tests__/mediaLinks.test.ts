/**
 * Which links a media notification can offer. Each one needs something that may be
 * absent - an external URL, a machine identifier, an IMDb id - and a missing piece
 * drops that link rather than the whole set.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetNetworkSettings = vi.fn();
vi.mock('../../settings.js', () => ({
  getNetworkSettings: () => mockGetNetworkSettings() as unknown,
}));

const mockLimit = vi.fn();
vi.mock('../../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => mockLimit() as unknown }),
      }),
    }),
  },
}));

import { _resetMediaLinkCacheForTests, buildMediaLinks } from '../mediaLinks.js';
import type { MediaEventPayload } from '../events.js';

const payload = (overrides: Partial<MediaEventPayload> = {}): MediaEventPayload => ({
  serverId: 'server-1',
  serverName: 'Guardian',
  serverType: 'plex',
  libraryItemId: 'item-1',
  ratingKey: '205325',
  mediaId: 'media-1',
  title: 'Cars',
  grandparentTitle: null,
  parentTitle: null,
  grandparentRatingKey: null,
  parentRatingKey: null,
  parentIndex: null,
  itemIndex: null,
  mediaType: 'movie',
  year: 2006,
  imdbId: 'tt0317219',
  tmdbId: null,
  tvdbId: null,
  thumbPath: null,
  libraryName: 'Movies',
  to: {
    resolution: '4k',
    dynamicRange: 'hdr10',
    videoCodec: 'HEVC',
    audioCodec: 'TRUEHD',
    audioChannels: 8,
    fileSize: 42_000_000_000,
  },
  ...overrides,
});

describe('buildMediaLinks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetMediaLinkCacheForTests();
    mockGetNetworkSettings.mockResolvedValue({
      externalUrl: 'https://tracearr.example',
      trustProxy: false,
    });
    mockLimit.mockResolvedValue([
      { url: 'http://plex.local:32400', machineIdentifier: 'machine-1' },
    ]);
  });

  it('offers Tracearr, the media server and IMDb', async () => {
    expect(await buildMediaLinks(payload())).toEqual([
      { label: 'Tracearr', url: 'https://tracearr.example/media/media-1' },
      {
        label: 'Guardian',
        url: 'https://app.plex.tv/desktop/#!/server/machine-1/details?key=%2Flibrary%2Fmetadata%2F205325',
      },
      { label: 'IMDb', url: 'https://www.imdb.com/title/tt0317219/' },
    ]);
  });

  it('drops the Tracearr link when no external URL is configured', async () => {
    mockGetNetworkSettings.mockResolvedValue({ externalUrl: null, trustProxy: false });

    expect((await buildMediaLinks(payload())).map((l) => l.label)).toEqual(['Guardian', 'IMDb']);
  });

  it('drops the Tracearr link when the item resolved to no canonical media', async () => {
    expect((await buildMediaLinks(payload({ mediaId: null }))).map((l) => l.label)).toEqual([
      'Guardian',
      'IMDb',
    ]);
  });

  it('drops the IMDb link for a season, which carries no id of its own', async () => {
    const season = payload({ mediaType: 'season', imdbId: null, parentTitle: 'Ted Lasso' });

    expect((await buildMediaLinks(season)).map((l) => l.label)).toEqual(['Tracearr', 'Guardian']);
  });

  it('drops the server link when Plex never reported a machine identifier', async () => {
    mockLimit.mockResolvedValue([{ url: 'http://plex.local:32400', machineIdentifier: null }]);

    expect((await buildMediaLinks(payload())).map((l) => l.label)).toEqual(['Tracearr', 'IMDb']);
  });

  it('points Emby at its own web client rather than a hosted one', async () => {
    mockLimit.mockResolvedValue([
      { url: 'http://192.168.1.122:8096', machineIdentifier: 'emby-machine' },
    ]);
    const links = await buildMediaLinks(payload({ serverType: 'emby', serverName: 'Emby' }));

    expect(links[1]).toEqual({
      label: 'Emby',
      url: 'http://192.168.1.122:8096/web/index.html#!/item?id=205325&serverId=emby-machine',
    });
  });

  it('opens a tofa episode on its show page, at the season and episode', async () => {
    mockLimit.mockResolvedValue([{ url: 'http://192.168.1.122:33333', machineIdentifier: null }]);
    const links = await buildMediaLinks(
      payload({
        serverType: 'tofa',
        serverName: 'Attic',
        mediaType: 'episode',
        ratingKey: 'episode-9',
        grandparentRatingKey: 'show-4',
        parentRatingKey: 'season-2',
        parentIndex: 29,
        itemIndex: 2,
      })
    );

    expect(links[1]).toEqual({
      label: 'Attic',
      url: 'https://app.tofa.tv/media/show-4?season=29&episode=2',
    });
  });

  it.each([
    ['the public address when set', 'https://emby.example.org', 'https://emby.example.org'],
    ['the configured URL when none is set', null, 'http://192.168.1.122:8096'],
  ])('builds the Emby link from %s', async (_label, publicUrl, base) => {
    mockLimit.mockResolvedValue([
      { url: 'http://192.168.1.122:8096', publicUrl, machineIdentifier: 'emby-machine' },
    ]);
    const links = await buildMediaLinks(payload({ serverType: 'emby', serverName: 'Emby' }));

    expect(links[1]?.url).toBe(`${base}/web/index.html#!/item?id=205325&serverId=emby-machine`);
  });

  it('survives a server row that has gone missing', async () => {
    mockLimit.mockResolvedValue([]);

    expect((await buildMediaLinks(payload())).map((l) => l.label)).toEqual(['Tracearr', 'IMDb']);
  });

  it('reads the server row once for a burst of notifications', async () => {
    await buildMediaLinks(payload());
    await buildMediaLinks(payload());

    expect(mockLimit).toHaveBeenCalledTimes(1);
  });
});
