import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryChain } from '../../../test/helpers.js';
import type { DownloadSourceDescription } from '../../mediaServer/types.js';
import type { DownloadSignal } from '../recorder.js';

const { client } = vi.hoisted(() => ({ client: { describeDownloadSource: vi.fn() } }));

vi.mock('../../../db/client.js', () => ({ db: { select: vi.fn() } }));
vi.mock('../../mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(() => fakeJellyfinClient(client)),
}));
vi.mock('../../serverLocations.js', () => ({ resolveSessionGeo: vi.fn() }));
vi.mock('../../settings.js', () => ({
  getGeoIPSettings: vi.fn(async () => ({ usePlexGeoip: false })),
}));

import { db } from '../../../db/client.js';
import { libraryItems, libraryItemVersions, servers, serverUsers } from '../../../db/schema.js';
import { resolveSessionGeo } from '../../serverLocations.js';
import { deliveredFromTranscode, enrichDownload } from '../enrich.js';
import { fakeJellyfinClient } from '../../../test/mediaServerFakes.js';

const SERVER = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const MEDIA = '44444444-4444-4444-8444-444444444444';
const EXTERNAL_USER = '72decdb0b0124b43b9086978ba823d1f';
const T = new Date('2026-10-20T17:05:21.373Z');

const NO_DEVICE = { deviceId: null, playerName: null, product: null, platform: null };

const ALL_NULL = {
  serverVersionKey: null,
  libraryItemVersionId: null,
  videoResolution: null,
  videoCodec: null,
  videoDynamicRange: null,
  container: null,
  fileSizeBytes: null,
  ipAddress: null,
  isLocal: null,
  geo: null,
  delivered: null,
  mediaId: null,
  device: NO_DEVICE,
};

const jellyfinSource: DownloadSourceDescription = {
  version: {
    key: 'bf01da2708ae716a7d2bd441376de12f',
    size: 11980085714,
    container: 'mkv',
    videoResolution: '4k',
    videoCodec: 'HEVC',
    videoDynamicRange: 'hdr10',
  },
  delivered: {
    bytes: 11980085714,
    videoCodec: null,
    audioCodec: null,
    container: null,
    bitrateKbps: null,
    resolution: null,
  },
  device: {
    deviceId: 'probe-device-id',
    playerName: 'Pixel 8',
    product: 'Jellyfin Android',
    platform: 'Android',
  },
  ipAddress: '203.0.113.7',
};

function signal(
  overrides: Partial<DownloadSignal> = {}
): DownloadSignal & { libraryItemId: string | null } {
  return {
    serverId: SERVER,
    serverUserId: USER,
    ratingKey: 'bf01da2708ae716a7d2bd441376de12f',
    title: '(500) Days of Summer',
    app: 'Jellyfin Android',
    device: 'Pixel 8',
    source: 'activity_log',
    seenAt: T,
    libraryItemId: ITEM,
    ...overrides,
  };
}

// Each query resolves by the table it reads, so the order enrichDownload issues them in is free
function tables(
  item: { mediaId: string | null; ratingKey: string },
  versions: Array<{ id: string; serverVersionKey: string }>
) {
  const rows = new Map<unknown, unknown[]>([
    [servers, [{ id: SERVER, type: 'jellyfin', url: 'http://media', token: 't', name: 'Media' }]],
    [libraryItems, [item]],
    [serverUsers, [{ externalId: EXTERNAL_USER }]],
    [libraryItemVersions, versions],
  ]);
  vi.mocked(db.select).mockImplementation(() => {
    const chain = queryChain(vi.fn, undefined);
    let result: unknown[] = [];
    chain.from = vi.fn((table: unknown) => {
      result = rows.get(table) ?? [];
      return chain;
    });
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return chain as never;
  });
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  client.describeDownloadSource.mockReset();
  vi.mocked(resolveSessionGeo).mockReset();
});

describe('enrichDownload', () => {
  it('asks the server about the item and device, then adds the version row, mediaId and geo', async () => {
    tables({ mediaId: MEDIA, ratingKey: 'bf01da2708ae716a7d2bd441376de12f' }, [
      { id: 'ver-0', serverVersionKey: 'other' },
      { id: 'ver-1', serverVersionKey: 'bf01da2708ae716a7d2bd441376de12f' },
    ]);
    client.describeDownloadSource.mockResolvedValueOnce(jellyfinSource);
    vi.mocked(resolveSessionGeo).mockResolvedValueOnce({
      city: 'Lisbon',
      region: 'Lisbon',
      country: 'Portugal',
      countryCode: 'PT',
      lat: 38.7,
      lon: -9.1,
      isLocal: false,
    } as never);

    const result = await enrichDownload(signal());

    expect(client.describeDownloadSource).toHaveBeenCalledWith({
      itemKey: 'bf01da2708ae716a7d2bd441376de12f',
      partId: null,
      deviceId: null,
      userId: EXTERNAL_USER,
      app: 'Jellyfin Android',
      device: 'Pixel 8',
    });
    expect(resolveSessionGeo).toHaveBeenCalledWith('203.0.113.7', SERVER, false, T);
    expect(result).toEqual({
      serverVersionKey: 'bf01da2708ae716a7d2bd441376de12f',
      libraryItemVersionId: 'ver-1',
      videoResolution: '4k',
      videoCodec: 'HEVC',
      videoDynamicRange: 'hdr10',
      container: 'mkv',
      fileSizeBytes: 11980085714,
      ipAddress: '203.0.113.7',
      isLocal: false,
      geo: { city: 'Lisbon', region: 'Lisbon', country: 'PT', lat: 38.7, lon: -9.1 },
      delivered: jellyfinSource.delivered,
      mediaId: MEDIA,
      device: jellyfinSource.device,
    });
  });

  it('looks up an emby title-matched item by its library ratingKey', async () => {
    tables({ mediaId: MEDIA, ratingKey: '78146' }, []);
    client.describeDownloadSource.mockResolvedValueOnce({ ...jellyfinSource, ipAddress: null });

    await enrichDownload(signal({ ratingKey: null }));

    expect(client.describeDownloadSource).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: '78146' })
    );
  });

  it('falls back to the only version and skips geo without an address', async () => {
    tables({ mediaId: MEDIA, ratingKey: 'bf01' }, [{ id: 'ver-only', serverVersionKey: 'old' }]);
    client.describeDownloadSource.mockResolvedValueOnce({
      version: null,
      delivered: null,
      device: NO_DEVICE,
      ipAddress: null,
    });

    const result = await enrichDownload(signal());

    expect(result.libraryItemVersionId).toBe('ver-only');
    expect(result.geo).toBeNull();
    expect(resolveSessionGeo).not.toHaveBeenCalled();
  });

  it('keeps the delivered file a sync item or a transcode brought over the one the server describes', async () => {
    tables({ mediaId: MEDIA, ratingKey: '78146' }, []);
    client.describeDownloadSource.mockResolvedValueOnce({ ...jellyfinSource, ipAddress: null });
    const delivered = {
      bytes: 192015871,
      videoCodec: 'H264',
      audioCodec: 'AAC',
      container: 'mkv',
      bitrateKbps: 592,
      resolution: '720x404',
    };

    const result = await enrichDownload(signal({ source: 'emby_sync', delivered }));

    expect(result.delivered).toEqual(delivered);
    expect(result.fileSizeBytes).toBe(11980085714);
  });

  it('resolves an all-null enrichment when the lookup throws', async () => {
    tables({ mediaId: MEDIA, ratingKey: 'bf01' }, []);
    client.describeDownloadSource.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(enrichDownload(signal())).resolves.toEqual(ALL_NULL);
  });
});

describe('deliveredFromTranscode', () => {
  const transcode = {
    key: '/transcode/sessions/bb37ccc5-08ec-4329-b250-8bb32b0f432a',
    size: 434094245,
    duration: 2888261,
    videoCodec: 'h264',
    audioCodec: 'opus',
    container: 'mkv',
    at: new Date(T.getTime() - 2962),
  };

  it('takes a static transcode that ended 3 s before the download started', () => {
    expect(deliveredFromTranscode(transcode, T)).toEqual({
      bytes: 434094245,
      videoCodec: 'H264',
      audioCodec: 'OPUS',
      container: 'mkv',
      bitrateKbps: 1202,
      resolution: null,
    });
  });

  it('ignores one outside the 15 s window or a download with no start', () => {
    expect(deliveredFromTranscode(transcode, new Date(T.getTime() + 15_000))).toBeNull();
    expect(deliveredFromTranscode(transcode, null)).toBeNull();
  });
});
