import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { queryChain, renderCall, renderSql } from '../../../test/helpers.js';

vi.mock('../../../db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));

const mockDispatchMediaDownloaded = vi.fn();
vi.mock('../../automations/events/producers.js', () => ({
  dispatchMediaDownloaded: (...args: unknown[]) => mockDispatchMediaDownloaded(...args),
}));

vi.mock('../enrich.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../enrich.js')>()),
  enrichDownload: vi.fn(),
}));

import { db } from '../../../db/client.js';
import { enrichDownload, type DownloadEnrichment } from '../enrich.js';
import { DOWNLOAD_COLLAPSE_MS, isTrack, recordDownload, type DownloadSignal } from '../recorder.js';

const SERVER = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const T = new Date('2026-10-20T14:46:04Z');

const NO_ENRICHMENT: DownloadEnrichment = {
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
  device: { deviceId: null, playerName: null, product: null, platform: null },
};

function signal(overrides: Partial<DownloadSignal> = {}): DownloadSignal {
  return {
    serverId: SERVER,
    serverUserId: USER,
    ratingKey: 'bf01da2708ae716a7d2bd441376de12f',
    title: '(500) Days of Summer',
    app: 'sse-probe',
    device: 'probe',
    source: 'activity_log',
    seenAt: T,
    ...overrides,
  };
}

function selects(...results: unknown[]) {
  const chains = results.map((r) => queryChain(vi.fn, r));
  for (const chain of chains) vi.mocked(db.select).mockReturnValueOnce(chain as never);
  return chains;
}

function insertReturning(row: unknown) {
  const chain = queryChain(vi.fn, [row]);
  vi.mocked(db.insert).mockReturnValueOnce(chain as never);
  return chain;
}

function updateChain() {
  const chain = queryChain(vi.fn, undefined);
  vi.mocked(db.update).mockReturnValueOnce(chain as never);
  return chain;
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  vi.mocked(db.insert).mockReset();
  vi.mocked(db.update).mockReset();
  vi.mocked(enrichDownload).mockReset();
  vi.mocked(enrichDownload).mockResolvedValue(NO_ENRICHMENT);
});

describe('recordDownload', () => {
  it('opens a row on the first signal and collapses the next two within an hour', async () => {
    selects([], [{ id: 'lib-1' }]);
    const insert = insertReturning({ id: 'dl-1', firstSeenAt: T });
    const first = await recordDownload(signal());

    const open = { id: 'dl-1', firstSeenAt: T };
    selects([open]);
    const update1 = updateChain();
    const second = await recordDownload(signal({ seenAt: new Date(T.getTime() + 20_000) }));

    selects([open]);
    const update2 = updateChain();
    const third = await recordDownload(signal({ seenAt: new Date(T.getTime() + 40_000) }));

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledTimes(2);
    expect(insert.values.mock.calls[0]?.[0]).toMatchObject({
      libraryItemId: 'lib-1',
      firstSeenAt: T,
      lastSeenAt: T,
    });
    expect(insert.values.mock.calls[0]?.[0]).not.toHaveProperty('requestCount');
    for (const [chain, offset] of [
      [update1, 20_000],
      [update2, 40_000],
    ] as const) {
      const set = chain.set.mock.calls[0]?.[0] as { lastSeenAt: Date; requestCount: SQL };
      expect(set.lastSeenAt).toEqual(new Date(T.getTime() + offset));
      expect(renderSql(set.requestCount).sql).toBe('media_downloads.request_count + 1');
    }
    expect([first.opened, second.opened, third.opened]).toEqual([true, false, false]);
    expect(third).toEqual({ id: 'dl-1', opened: false, serverUserId: USER, firstSeenAt: T });
    expect(enrichDownload).toHaveBeenCalledTimes(1);
    expect(enrichDownload).toHaveBeenCalledWith({ ...signal(), libraryItemId: 'lib-1' });
  });

  it('inserts the enrichment of an opened row, filling a plex app and device from the resolved client', async () => {
    vi.mocked(enrichDownload).mockResolvedValueOnce({
      serverVersionKey: '110988',
      libraryItemVersionId: 'ver-b',
      videoResolution: '1080p',
      videoCodec: 'H264',
      videoDynamicRange: 'sdr',
      container: 'mkv',
      fileSizeBytes: 3181199596,
      ipAddress: '203.0.113.7',
      isLocal: false,
      geo: { city: 'Lisbon', region: 'Lisbon', country: 'PT', lat: 38.7, lon: -9.1 },
      delivered: {
        bytes: 434094245,
        videoCodec: 'H264',
        audioCodec: 'OPUS',
        container: 'mkv',
        bitrateKbps: 1202,
        resolution: null,
      },
      mediaId: 'media-1',
      device: {
        deviceId: 'o2wsbz6wagpn4g7e8g9kqge9',
        playerName: 'iPhone',
        product: 'Plex for iOS',
        platform: 'iOS',
      },
    });
    selects([], [{ id: 'lib-1' }]);
    const insert = insertReturning({ id: 'dl-1', firstSeenAt: T });

    await recordDownload(signal({ app: null, device: null, source: 'plex', partId: '111093' }));

    expect(insert.values.mock.calls[0]?.[0]).toMatchObject({
      app: 'Plex for iOS',
      device: 'iPhone',
      libraryItemVersionId: 'ver-b',
      videoResolution: '1080p',
      videoCodec: 'H264',
      videoDynamicRange: 'sdr',
      container: 'mkv',
      fileSizeBytes: 3181199596,
      ipAddress: '203.0.113.7',
      isLocal: false,
      geoCity: 'Lisbon',
      geoRegion: 'Lisbon',
      geoCountry: 'PT',
      geoLat: 38.7,
      geoLon: -9.1,
      deliveredBytes: 434094245,
      deliveredVideoCodec: 'H264',
      deliveredAudioCodec: 'OPUS',
      deliveredContainer: 'mkv',
      deliveredBitrateKbps: 1202,
      deliveredResolution: null,
      mediaId: 'media-1',
      deviceId: 'o2wsbz6wagpn4g7e8g9kqge9',
      playerName: 'iPhone',
      product: 'Plex for iOS',
      platform: 'iOS',
    });
    expect(mockDispatchMediaDownloaded).toHaveBeenCalledWith(
      expect.objectContaining({ app: 'Plex for iOS', device: 'iPhone' })
    );
  });

  it("keeps a sync item's delivered file when the enrichment came back empty", async () => {
    selects([], [{ id: 'lib-1' }]);
    const insert = insertReturning({ id: 'dl-1', firstSeenAt: T });

    await recordDownload(
      signal({
        source: 'emby_sync',
        deviceId: '22D01846-6841-432B-9C71-8CF676E49F0E',
        delivered: {
          bytes: 192015871,
          videoCodec: 'H264',
          audioCodec: 'AAC',
          container: 'mkv',
          bitrateKbps: 592,
          resolution: '720x404',
        },
      })
    );

    expect(insert.values.mock.calls[0]?.[0]).toMatchObject({
      deliveredBytes: 192015871,
      deliveredResolution: '720x404',
      fileSizeBytes: null,
      deviceId: '22D01846-6841-432B-9C71-8CF676E49F0E',
    });
  });

  it('never collapses into a converted pull of the same item', async () => {
    const [collapse] = selects([], [{ id: 'lib-1' }]);
    insertReturning({ id: 'dl-5', firstSeenAt: T });

    const result = await recordDownload(signal());

    const where = renderCall(collapse, 'where');
    expect(where.text).toContain('media_downloads.source <>');
    expect(where.params).toContain('jellyfin_transcode');
    expect(result.opened).toBe(true);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('opens a second row when the newest row is older than the collapse window', async () => {
    const later = new Date(T.getTime() + DOWNLOAD_COLLAPSE_MS + 1000);
    const [collapse] = selects([], [{ id: 'lib-1' }]);
    insertReturning({ id: 'dl-2', firstSeenAt: later });

    const result = await recordDownload(signal({ seenAt: later }));

    expect(result).toEqual({ id: 'dl-2', opened: true, serverUserId: USER, firstSeenAt: later });
    const where = renderCall(collapse, 'where');
    expect(where.text).toContain('media_downloads.last_seen_at >=');
    expect(where.params).toContain(new Date(later.getTime() - DOWNLOAD_COLLAPSE_MS).toISOString());
    expect(db.update).not.toHaveBeenCalled();
  });

  it('matches a jellyfin item by ratingKey and an emby item by title, and leaves libraryItemId null on zero or several title matches', async () => {
    const [, jellyfinMatch] = selects([], [{ id: 'lib-1' }]);
    const jellyfinInsert = insertReturning({ id: 'dl-1', firstSeenAt: T });
    await recordDownload(signal());
    expect(renderCall(jellyfinMatch, 'where').params).toContain('bf01da2708ae716a7d2bd441376de12f');
    expect(jellyfinInsert.values.mock.calls[0]?.[0]).toMatchObject({ libraryItemId: 'lib-1' });

    const emby = signal({ ratingKey: null });
    const [embyCollapse, embyMatch] = selects([], [{ id: 'lib-2' }]);
    const embyInsert = insertReturning({ id: 'dl-2', firstSeenAt: T });
    await recordDownload(emby);
    expect(renderCall(embyCollapse, 'where').params).toContain('(500) Days of Summer');
    const match = renderCall(embyMatch, 'where');
    expect(match.text).toContain('library_items.title =');
    expect(match.params).toContain('(500) Days of Summer');
    expect(embyMatch.limit).toHaveBeenCalledWith(2);
    expect(embyInsert.values.mock.calls[0]?.[0]).toMatchObject({
      libraryItemId: 'lib-2',
      ratingKey: null,
    });

    for (const matches of [[], [{ id: 'lib-2' }, { id: 'lib-3' }]]) {
      selects([], matches);
      const insert = insertReturning({ id: 'dl-3', firstSeenAt: T });
      await recordDownload(emby);
      expect(insert.values.mock.calls[0]?.[0]).toMatchObject({
        libraryItemId: null,
        title: '(500) Days of Summer',
      });
    }
  });

  it('announces an opened row for a known account and never a collapsed one', async () => {
    selects([], [{ id: 'lib-1' }]);
    insertReturning({ id: 'dl-1', firstSeenAt: T });
    await recordDownload(signal());
    expect(mockDispatchMediaDownloaded).toHaveBeenCalledTimes(1);
    expect(mockDispatchMediaDownloaded).toHaveBeenCalledWith({
      serverId: SERVER,
      serverUserId: USER,
      title: '(500) Days of Summer',
      app: 'sse-probe',
      device: 'probe',
      firstSeenAt: T,
    });

    selects([{ id: 'dl-1', firstSeenAt: T }]);
    updateChain();
    await recordDownload(signal({ seenAt: new Date(T.getTime() + 20_000) }));
    expect(mockDispatchMediaDownloaded).toHaveBeenCalledTimes(1);
  });

  it('stores a signal with no serverUserId', async () => {
    const [collapse] = selects([], []);
    const insert = insertReturning({ id: 'dl-4', firstSeenAt: T });

    const result = await recordDownload(signal({ serverUserId: null }));

    expect(result).toEqual({ id: 'dl-4', opened: true, serverUserId: null, firstSeenAt: T });
    expect(mockDispatchMediaDownloaded).not.toHaveBeenCalled();
    expect(renderCall(collapse, 'where').text).toContain('media_downloads.server_user_id is null');
    expect(insert.values.mock.calls[0]?.[0]).toMatchObject({
      serverUserId: null,
      source: 'activity_log',
    });
  });
});

describe('isTrack', () => {
  it('is true only when the server has a track under the rating key', async () => {
    const [found] = selects([{ id: 'lib-1' }]);
    expect(await isTrack(SERVER, '29969')).toBe(true);
    const where = renderCall(found, 'where');
    expect(where.text).toContain('library_items.media_type =');
    expect(where.params).toEqual([SERVER, '29969', 'track']);

    selects([]);
    expect(await isTrack(SERVER, '206208')).toBe(false);
  });
});
