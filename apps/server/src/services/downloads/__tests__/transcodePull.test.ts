import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@tracearr/shared';
import { createMockRedis, queryChain } from '../../../test/helpers.js';
import type { ServerRow } from '../../liveServers.js';
import type { PluginTranscodePullEvent } from '../../mediaServer/shared/jellyfinEmbyEventSource.js';
import type { DeviceSession } from '../../mediaServer/shared/jellyfinEmbyParser.js';

const { redis, client } = vi.hoisted(() => ({
  redis: { current: null as unknown },
  client: { getTranscodePullSessions: vi.fn() },
}));

vi.mock('../../../db/client.js', () => ({ db: { select: vi.fn(), update: vi.fn() } }));
vi.mock('../../../lib/redisShared.js', () => ({ getRedis: () => redis.current }));
vi.mock('../../mediaServer/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../mediaServer/index.js')>()),
  createJellyfinEmbyClient: vi.fn(() => client),
}));
vi.mock('../../../jobs/poller/database.js', () => ({ getServerUserIdByExternalId: vi.fn() }));
vi.mock('../recorder.js', () => ({ insertDownload: vi.fn(), matchLibraryItem: vi.fn() }));
vi.mock('../enrich.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../enrich.js')>()),
  enrichDownload: vi.fn(),
}));

import { db } from '../../../db/client.js';
import { getServerUserIdByExternalId } from '../../../jobs/poller/database.js';
import { enrichDownload } from '../enrich.js';
import { insertDownload, matchLibraryItem } from '../recorder.js';
import {
  CONVERTED_DOWNLOAD_TITLE,
  TRANSCODE_PULL_MIN_AGE_MS,
  pollServerTranscodePulls,
  recordTranscodePullEvent,
} from '../transcodePull.js';

const SERVER = { id: '11111111-1111-4111-8111-111111111111', type: 'jellyfin' } as ServerRow;
const T = new Date('2026-10-20T15:00:00Z').getTime();
const DEVICE = 'streamyfin-device-1';
const USER_GUID = '72decdb0b0124b43b9086978ba823d1f';

const TRANSCODING = {
  bitrate: 1_500_000,
  width: 1280,
  height: 720,
  videoCodec: 'h264',
  audioCodec: 'aac',
  container: 'mp4',
  completionPercentage: 12.5,
};

function session(overrides: Partial<DeviceSession> = {}): DeviceSession {
  return {
    userId: USER_GUID,
    deviceId: DEVICE,
    client: 'Streamyfin',
    deviceName: 'Pixel 8',
    remoteEndPoint: '100.64.0.7',
    nowPlaying: false,
    transcoding: TRANSCODING,
    ...overrides,
  };
}

const at = (completionPercentage: number | null, deviceId = DEVICE): DeviceSession =>
  session({ deviceId, transcoding: { ...TRANSCODING, completionPercentage } });
const finished = (): DeviceSession => at(null);

async function pollAt(offsetMs: number, sessions: DeviceSession[]) {
  vi.setSystemTime(T + offsetMs);
  client.getTranscodePullSessions.mockResolvedValueOnce(sessions);
  await pollServerTranscodePulls(SERVER);
}

function event(overrides: Partial<PluginTranscodePullEvent> = {}): PluginTranscodePullEvent {
  return {
    phase: 'started',
    userId: USER_GUID,
    deviceId: DEVICE,
    itemId: 'bf01da2708ae716a7d2bd441376de12f',
    bitrate: 1_500_000,
    width: 1280,
    height: 720,
    videoCodec: 'h264',
    audioCodec: 'aac',
    container: 'mp4',
    bytesTranscoded: null,
    completionPercentage: 40,
    ...overrides,
  };
}

function updates() {
  return vi.mocked(db.update).mock.results.map((result) => {
    const chain = result.value as { set: { mock: { calls: unknown[][] } } };
    return chain.set.mock.calls[0]?.[0];
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: T, toFake: ['Date'] });
  redis.current = createMockRedis();
  client.getTranscodePullSessions.mockReset();
  vi.mocked(db.select).mockReset();
  vi.mocked(db.update).mockReset();
  vi.mocked(db.update).mockImplementation(() => queryChain(vi.fn, undefined) as never);
  vi.mocked(getServerUserIdByExternalId).mockReset();
  vi.mocked(getServerUserIdByExternalId).mockResolvedValue('su-1');
  vi.mocked(insertDownload).mockReset();
  vi.mocked(insertDownload).mockImplementation(async () => ({
    id: `row-${vi.mocked(insertDownload).mock.calls.length}`,
    opened: true,
    serverUserId: 'su-1',
    firstSeenAt: new Date(T),
  }));
  vi.mocked(matchLibraryItem).mockReset();
  vi.mocked(matchLibraryItem).mockResolvedValue({ id: 'li-1', title: '(500) Days of Summer' });
  vi.mocked(enrichDownload).mockReset();
  vi.mocked(enrichDownload).mockResolvedValue({
    serverVersionKey: 'bf01da2708ae716a7d2bd441376de12f',
    libraryItemVersionId: 'ver-1',
    videoResolution: '1080p',
    videoCodec: 'HEVC',
    videoDynamicRange: 'sdr',
    container: 'mkv',
    fileSizeBytes: 2_650_000_000,
    ipAddress: '100.64.0.7',
    isLocal: true,
    geo: null,
    delivered: null,
    mediaId: 'media-1',
    device: { deviceId: DEVICE, playerName: 'Pixel 8', product: 'Streamyfin', platform: 'Android' },
  });
});

describe('pollServerTranscodePulls', () => {
  it('opens one converted download once the session has transcoded without playing for 20 s', async () => {
    await pollAt(0, [session()]);
    expect(insertDownload).not.toHaveBeenCalled();

    await pollAt(25_000, [session()]);
    await pollAt(55_000, [session()]);

    expect(insertDownload).toHaveBeenCalledTimes(1);
    expect(insertDownload).toHaveBeenCalledWith(
      {
        serverId: SERVER.id,
        serverUserId: 'su-1',
        ratingKey: null,
        title: CONVERTED_DOWNLOAD_TITLE,
        app: 'Streamyfin',
        device: 'Pixel 8',
        source: 'jellyfin_transcode',
        seenAt: new Date(T),
        deviceId: DEVICE,
        delivered: {
          bytes: null,
          videoCodec: 'H264',
          audioCodec: 'AAC',
          container: 'mp4',
          bitrateKbps: 1500,
          resolution: '1280x720',
        },
      },
      null
    );
    expect(getServerUserIdByExternalId).toHaveBeenCalledWith(SERVER.id, USER_GUID);
  });

  it('opens nothing for a session that is playing', async () => {
    await pollAt(0, [session({ nowPlaying: true })]);
    await pollAt(25_000, [session({ nowPlaying: true })]);
    expect(insertDownload).not.toHaveBeenCalled();
  });

  it('opens nothing for a session that disappears before 20 s', async () => {
    await pollAt(0, [session()]);
    await pollAt(10_000, []);
    await pollAt(25_000, [session()]);
    expect(insertDownload).not.toHaveBeenCalled();
  });

  it('closes the row when completion turns null, ignores the lingering info, and opens a new row when completion returns', async () => {
    await pollAt(0, [session()]);
    await pollAt(25_000, [at(47.6)]);
    await pollAt(55_000, [finished()]);

    expect(updates()).toEqual([{ lastSeenAt: new Date(T + 55_000), completionPercent: 48 }]);

    for (let offset = 85_000; offset <= 3_655_000; offset += 30_000) {
      await pollAt(offset, [finished()]);
    }
    expect(insertDownload).toHaveBeenCalledTimes(1);

    await pollAt(3_685_000, [session()]);
    await pollAt(3_715_000, [session()]);
    expect(insertDownload).toHaveBeenCalledTimes(2);
    expect(vi.mocked(insertDownload).mock.calls[1]?.[0].seenAt).toEqual(new Date(T + 3_685_000));
  });

  it('closes the row when the transcoding info disappears', async () => {
    await pollAt(0, [session()]);
    await pollAt(25_000, [session()]);
    await pollAt(55_000, [session({ transcoding: null })]);
    expect(updates()).toEqual([{ lastSeenAt: new Date(T + 55_000), completionPercent: 13 }]);
  });

  it('closes a pull saved without a completion field and writes no completion', async () => {
    const store = createMockRedis();
    store._store.set(
      REDIS_KEYS.TRANSCODE_PULLS(SERVER.id),
      JSON.stringify({ [DEVICE]: { since: T, rowId: 'row-old' } })
    );
    redis.current = store;

    await pollAt(30_000, []);

    expect(updates()).toEqual([{ lastSeenAt: new Date(T + 30_000) }]);
  });

  it('keeps opening and closing other devices when one device fails to open', async () => {
    vi.mocked(insertDownload).mockImplementation(async (signal) => {
      if (signal.deviceId === 'device-a') throw new Error('insert failed');
      return { id: 'row-b', opened: true, serverUserId: 'su-1', firstSeenAt: new Date(T) };
    });

    await pollAt(0, [at(10, 'device-a'), session()]);
    await pollAt(25_000, [at(10, 'device-a'), session()]);
    await pollAt(55_000, [at(10, 'device-a')]);

    expect(vi.mocked(insertDownload).mock.calls.map(([signal]) => signal.deviceId)).toEqual([
      'device-a',
      DEVICE,
      'device-a',
    ]);
    expect(updates()).toEqual([{ lastSeenAt: new Date(T + 55_000), completionPercent: 13 }]);
  });
});

describe('recordTranscodePullEvent', () => {
  it('attaches the library item, its source file and title to the row the poll opened', async () => {
    await pollAt(0, [session()]);
    await pollAt(25_000, [session()]);

    vi.setSystemTime(T + 30_000);
    await recordTranscodePullEvent(SERVER.id, event());

    expect(insertDownload).toHaveBeenCalledTimes(1);
    expect(matchLibraryItem).toHaveBeenCalledWith({
      serverId: SERVER.id,
      ratingKey: 'bf01da2708ae716a7d2bd441376de12f',
      title: CONVERTED_DOWNLOAD_TITLE,
    });
    expect(enrichDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: SERVER.id,
        serverUserId: 'su-1',
        ratingKey: 'bf01da2708ae716a7d2bd441376de12f',
        libraryItemId: 'li-1',
        deviceId: DEVICE,
      })
    );
    expect(updates()).toEqual([
      {
        ratingKey: 'bf01da2708ae716a7d2bd441376de12f',
        libraryItemId: 'li-1',
        title: '(500) Days of Summer',
        libraryItemVersionId: 'ver-1',
        videoResolution: '1080p',
        videoCodec: 'HEVC',
        videoDynamicRange: 'sdr',
        container: 'mkv',
        fileSizeBytes: 2_650_000_000,
        mediaId: 'media-1',
      },
    ]);
  });

  it('opens a row with the library item, dated 20 s back, when the poll has not seen the pull', async () => {
    await recordTranscodePullEvent(SERVER.id, event());

    expect(insertDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        ratingKey: 'bf01da2708ae716a7d2bd441376de12f',
        title: '(500) Days of Summer',
        source: 'jellyfin_transcode',
        seenAt: new Date(T - TRANSCODE_PULL_MIN_AGE_MS),
        deviceId: DEVICE,
        app: null,
        device: null,
      }),
      'li-1'
    );

    await pollAt(25_000, [session()]);
    expect(insertDownload).toHaveBeenCalledTimes(1);
  });

  it("opens at once with the poll's first sighting when the poll pull is still under 20 s", async () => {
    await pollAt(0, [session()]);
    vi.setSystemTime(T + 10_000);
    await recordTranscodePullEvent(SERVER.id, event());

    expect(insertDownload).toHaveBeenCalledTimes(1);
    expect(vi.mocked(insertDownload).mock.calls[0]?.[0].seenAt).toEqual(new Date(T));

    await pollAt(25_000, [session()]);
    expect(insertDownload).toHaveBeenCalledTimes(1);
  });

  it('fills deliveredBytes and closes the open row on ended', async () => {
    await recordTranscodePullEvent(SERVER.id, event());
    vi.setSystemTime(T + 90_000);
    await recordTranscodePullEvent(
      SERVER.id,
      event({ phase: 'ended', bytesTranscoded: 434_000_000, completionPercentage: 87.6 })
    );

    expect(updates()).toEqual([
      { lastSeenAt: new Date(T + 90_000), deliveredBytes: 434_000_000, completionPercent: 88 },
    ]);
    await pollAt(120_000, [finished()]);
    expect(updates()).toHaveLength(1);
  });

  it('fills deliveredBytes on the newest row for the device when the poll closed it first', async () => {
    await pollAt(0, [session()]);
    await pollAt(25_000, [session()]);
    await pollAt(55_000, [finished()]);
    vi.mocked(db.select).mockReturnValueOnce(queryChain(vi.fn, [{ id: 'row-1' }]) as never);

    await recordTranscodePullEvent(
      SERVER.id,
      event({ phase: 'ended', bytesTranscoded: 434_000_000, completionPercentage: 87.6 })
    );

    expect(updates()).toEqual([
      { lastSeenAt: new Date(T + 55_000), completionPercent: 13 },
      { deliveredBytes: 434_000_000, completionPercent: 88 },
    ]);
  });
});
