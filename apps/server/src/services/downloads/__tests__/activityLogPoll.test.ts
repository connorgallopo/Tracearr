import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS, type JellyfinEmbyServerType } from '@tracearr/shared';
import { createMockRedis, queryChain } from '../../../test/helpers.js';
import type { JellyfinEmbyActivityEntry } from '../../mediaServer/shared/baseMediaServerClient.js';

const { redis, client } = vi.hoisted(() => ({
  redis: { current: null as unknown },
  client: {
    serverType: 'jellyfin' as JellyfinEmbyServerType,
    getActivityLog: vi.fn(),
    resolveUserGuid: vi.fn(),
    getSyncJobs: vi.fn(),
    getSyncJobItems: vi.fn(),
  },
}));

vi.mock('../../../db/client.js', () => ({ db: { select: vi.fn() } }));
vi.mock('../../../lib/redisShared.js', () => ({ getRedis: () => redis.current }));
vi.mock('../../mediaServer/index.js', () => ({ createMediaServerClient: vi.fn(() => client) }));
vi.mock('../../../jobs/poller/database.js', () => ({ getServerUserIdByExternalId: vi.fn() }));
vi.mock('../recorder.js', () => ({ recordDownload: vi.fn() }));

import { db } from '../../../db/client.js';
import { getServerUserIdByExternalId } from '../../../jobs/poller/database.js';
import { recordDownload } from '../recorder.js';
import { pollServerDownloads, pollServerSyncJobs } from '../activityLogPoll.js';

const SERVER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-20T15:00:00Z');
const CURSOR_KEY = REDIS_KEYS.DOWNLOAD_CURSOR(SERVER);

const jellyfinDownload: JellyfinEmbyActivityEntry = {
  id: 547,
  type: 'UserDownloadingContent',
  userId: '72decdb0b0124b43b9086978ba823d1f',
  itemId: 'bf01da2708ae716a7d2bd441376de12f',
  date: '2026-10-20T14:46:04.2137652Z',
  name: 'tracearr-dl-probe is downloading (500) Days of Summer',
  shortOverview: 'App: sse-probe, Device: probe',
  severity: 'Information',
};

const embyDownload: JellyfinEmbyActivityEntry = {
  id: 205,
  type: 'UserDownloadingContent',
  userId: '16',
  date: '2026-10-20T14:46:32.9470000Z',
  name: 'tracearr-dl-probe is Downloading (500) Days of Summer',
  shortOverview: 'From GallopoUNRAID with sse-probe on probe',
  severity: 'Info',
};

function playback(id: number): JellyfinEmbyActivityEntry {
  return {
    id,
    type: 'VideoPlayback',
    userId: '72decdb0b0124b43b9086978ba823d1f',
    date: '2026-10-20T14:40:00Z',
    name: 'tracearr-dl-probe is playing (500) Days of Summer',
    severity: 'Information',
  };
}

function mockRedis() {
  const sets = new Map<string, Set<string>>();
  const store = {
    ...createMockRedis(),
    sismember: async (key: string, member: string) => (sets.get(key)?.has(member) ? 1 : 0),
    sadd: async (key: string, member: string) => {
      sets.set(key, (sets.get(key) ?? new Set()).add(member));
      return 1;
    },
    expire: vi.fn(async () => 1),
    _sets: sets,
  };
  redis.current = store;
  return store;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  vi.mocked(db.select).mockReset();
  vi.mocked(db.select).mockImplementation(
    () =>
      queryChain(vi.fn, [{ id: SERVER, type: client.serverType, url: 'u', token: 't' }]) as never
  );
  client.serverType = 'jellyfin';
  client.getActivityLog.mockReset();
  client.resolveUserGuid.mockReset();
  client.resolveUserGuid.mockImplementation(async (id: string) => id);
  client.getSyncJobs.mockReset();
  client.getSyncJobItems.mockReset();
  vi.mocked(getServerUserIdByExternalId).mockReset();
  vi.mocked(getServerUserIdByExternalId).mockResolvedValue('su-1');
  vi.mocked(recordDownload).mockReset();
  vi.mocked(recordDownload).mockResolvedValue({} as never);
});

describe('pollServerDownloads', () => {
  it('seeds from 24 hours back when no cursor exists, records only UserDownloadingContent entries, and stores the newest id as the cursor', async () => {
    const store = mockRedis();
    client.getActivityLog.mockResolvedValueOnce([playback(548), jellyfinDownload, playback(540)]);

    await pollServerDownloads(SERVER);

    expect(client.getActivityLog).toHaveBeenCalledWith({
      minDate: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      hasUserId: true,
    });
    expect(recordDownload).toHaveBeenCalledTimes(1);
    expect(recordDownload).toHaveBeenCalledWith({
      serverId: SERVER,
      serverUserId: 'su-1',
      ratingKey: 'bf01da2708ae716a7d2bd441376de12f',
      title: '(500) Days of Summer',
      app: 'sse-probe',
      device: 'probe',
      source: 'activity_log',
      seenAt: new Date('2026-10-20T14:46:04.213Z'),
    });
    expect(getServerUserIdByExternalId).toHaveBeenCalledWith(
      SERVER,
      '72decdb0b0124b43b9086978ba823d1f'
    );
    expect(store._store.get(CURSOR_KEY)).toBe('548');
  });

  it('reads from the cursor and advances past an entry that fails to record', async () => {
    const store = mockRedis();
    store._store.set(CURSOR_KEY, '546');
    client.getActivityLog.mockResolvedValue([jellyfinDownload, playback(546), playback(545)]);
    vi.mocked(recordDownload).mockRejectedValueOnce(new Error('value too long'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await pollServerDownloads(SERVER);
    expect(client.getActivityLog).toHaveBeenCalledWith({ limit: 100, hasUserId: true });
    expect(error).toHaveBeenCalledOnce();
    expect(store._store.get(CURSOR_KEY)).toBe('547');

    await pollServerDownloads(SERVER);
    expect(recordDownload).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('falls back to the 24 hour window when a full page lies past the cursor', async () => {
    const store = mockRedis();
    store._store.set(CURSOR_KEY, '100');
    const page = Array.from({ length: 100 }, (_, i) => playback(300 - i));
    client.getActivityLog
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([...page, { ...jellyfinDownload, id: 150 }, playback(99)]);

    await pollServerDownloads(SERVER);

    expect(client.getActivityLog).toHaveBeenLastCalledWith({
      minDate: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      hasUserId: true,
    });
    expect(recordDownload).toHaveBeenCalledTimes(1);
    expect(store._store.get(CURSOR_KEY)).toBe('300');
  });

  it('resolves an emby numeric user id to the guid and maps it to serverUsers.externalId', async () => {
    mockRedis();
    client.serverType = 'emby';
    client.getActivityLog.mockResolvedValueOnce([embyDownload]);
    client.resolveUserGuid.mockResolvedValueOnce('e5c1a0b2d3f44a5b8c9d0e1f2a3b4c5d');

    await pollServerDownloads(SERVER);

    expect(client.resolveUserGuid).toHaveBeenCalledWith('16');
    expect(getServerUserIdByExternalId).toHaveBeenCalledWith(
      SERVER,
      'e5c1a0b2d3f44a5b8c9d0e1f2a3b4c5d'
    );
    expect(recordDownload).toHaveBeenCalledWith({
      serverId: SERVER,
      serverUserId: 'su-1',
      ratingKey: null,
      title: '(500) Days of Summer',
      app: 'sse-probe',
      device: 'probe',
      source: 'activity_log',
      seenAt: new Date('2026-10-20T14:46:32.947Z'),
    });
  });

  it('keeps an emby entry whose user lookup 404s, with serverUserId null', async () => {
    const store = mockRedis();
    client.serverType = 'emby';
    client.getActivityLog.mockResolvedValueOnce([embyDownload]);
    client.resolveUserGuid.mockResolvedValueOnce(null);

    await pollServerDownloads(SERVER);

    expect(getServerUserIdByExternalId).not.toHaveBeenCalled();
    expect(recordDownload).toHaveBeenCalledWith(
      expect.objectContaining({ serverUserId: null, title: '(500) Days of Summer' })
    );
    expect(store._store.get(CURSOR_KEY)).toBe('205');
  });

  it('drops a run while one is in flight for the same server', async () => {
    mockRedis();
    let release: (entries: JellyfinEmbyActivityEntry[]) => void = () => {};
    client.getActivityLog.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    const first = pollServerDownloads(SERVER);
    await vi.waitFor(() => expect(client.getActivityLog).toHaveBeenCalledTimes(1));
    await pollServerDownloads(SERVER);
    release([jellyfinDownload]);
    await first;

    expect(client.getActivityLog).toHaveBeenCalledTimes(1);
    expect(recordDownload).toHaveBeenCalledTimes(1);
  });
});

describe('pollServerSyncJobs', () => {
  const TARGET = '22D01846-6841-432B-9C71-8CF676E49F0E';
  const CURSOR = REDIS_KEYS.SYNC_CURSOR(SERVER);
  const RECORDED = REDIS_KEYS.SYNC_RECORDED(SERVER);
  const job = {
    id: 1,
    userId: '1',
    itemId: '78146',
    name: 'Mentally Divergent',
    targetId: TARGET,
    targetName: 'iPhone (Emby for iOS) - connor@example.com',
    quality: '1500000',
    status: 'Converting',
    dateCreated: '2026-10-20T14:11:31.0000000Z',
    dateLastModified: '2026-10-20T14:13:28.0000000Z',
  };
  const converting = {
    id: 1,
    jobId: 1,
    itemId: '78146',
    status: 'Converting',
    dateCreated: '2026-10-20T14:11:31.0000000Z',
    mediaSource: null,
  };
  const synced = {
    ...converting,
    status: 'Synced',
    mediaSource: {
      size: 192015871,
      bitrate: 591668,
      container: 'mkv',
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 720,
      height: 404,
    },
  };

  beforeEach(() => {
    client.serverType = 'emby';
    client.resolveUserGuid.mockResolvedValue('171eb71d15f048d9bf4757336999d2eb');
    client.getSyncJobs.mockResolvedValue([job]);
  });

  it('records a job item once, when it first reaches Synced', async () => {
    const store = mockRedis();
    client.getSyncJobItems.mockResolvedValueOnce([converting]);

    await pollServerSyncJobs(SERVER);
    expect(recordDownload).not.toHaveBeenCalled();
    expect(store._store.get(CURSOR)).toBe('0');

    client.getSyncJobItems.mockResolvedValue([synced]);
    await pollServerSyncJobs(SERVER);
    await pollServerSyncJobs(SERVER);

    expect(recordDownload).toHaveBeenCalledTimes(1);
    expect(recordDownload).toHaveBeenCalledWith({
      serverId: SERVER,
      serverUserId: 'su-1',
      ratingKey: '78146',
      title: 'Mentally Divergent',
      app: 'Emby for iOS',
      device: 'iPhone',
      source: 'emby_sync',
      // past the seed the poll time stands in: a long job's DateLastModified can predate the item
      seenAt: NOW,
      deviceId: TARGET,
      delivered: {
        bytes: 192015871,
        videoCodec: 'H264',
        audioCodec: 'AAC',
        container: 'mkv',
        bitrateKbps: 592,
        resolution: '720x404',
      },
    });
    expect(client.resolveUserGuid).toHaveBeenCalledWith('1');
    expect(getServerUserIdByExternalId).toHaveBeenCalledWith(
      SERVER,
      '171eb71d15f048d9bf4757336999d2eb'
    );
    expect(store._store.get(CURSOR)).toBe('1');
    expect(store._sets.get(RECORDED)).toEqual(new Set(['1']));
    expect(store.expire).toHaveBeenCalledWith(RECORDED, 30 * 24 * 60 * 60);
  });

  it('records a synced item past one still transferring, once, and holds the cursor below the pending one', async () => {
    const store = mockRedis();
    store._store.set(CURSOR, '0');
    client.getSyncJobItems.mockResolvedValue([
      { ...converting, status: 'Transferring' },
      { ...synced, id: 2 },
    ]);

    await pollServerSyncJobs(SERVER);
    await pollServerSyncJobs(SERVER);

    expect(recordDownload).toHaveBeenCalledTimes(1);
    expect(store._store.get(CURSOR)).toBe('0');

    client.getSyncJobItems.mockResolvedValue([synced, { ...synced, id: 2 }]);
    await pollServerSyncJobs(SERVER);
    expect(recordDownload).toHaveBeenCalledTimes(2);
    expect(store._store.get(CURSOR)).toBe('2');
  });

  it('refreshes the recorded set expiry on every tick while a pending item holds the cursor', async () => {
    const store = mockRedis();
    store._store.set(CURSOR, '0');
    client.getSyncJobItems.mockResolvedValue([
      { ...converting, status: 'ReadyToTransfer' },
      { ...synced, id: 2 },
    ]);

    await pollServerSyncJobs(SERVER);
    await pollServerSyncJobs(SERVER);
    await pollServerSyncJobs(SERVER);

    expect(recordDownload).toHaveBeenCalledTimes(1);
    expect(store.expire).toHaveBeenCalledTimes(3);
    expect(store.expire).toHaveBeenCalledWith(RECORDED, 30 * 24 * 60 * 60);
  });

  it('seeds the first run from the last 24 hours of job items', async () => {
    mockRedis();
    client.getSyncJobItems.mockResolvedValueOnce([
      { ...synced, dateCreated: '2026-10-19T14:00:00.0000000Z' },
      { ...synced, id: 2 },
    ]);

    await pollServerSyncJobs(SERVER);

    expect(recordDownload).toHaveBeenCalledTimes(1);
  });
});
