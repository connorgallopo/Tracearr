import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import type { Redis } from 'ioredis';
import { REDIS_KEYS, type ServerHistoryImportProgress } from '@tracearr/shared';
import silo from '../../../test/mediaServerResponses/silo.json' with { type: 'json' };
import { queryChain } from '../../../test/helpers.js';

const { getPlaybackHistoryPage, getDeviceNames, redis } = vi.hoisted(() => ({
  getPlaybackHistoryPage: vi.fn(),
  getDeviceNames: vi.fn(),
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn(), scanStream: vi.fn() },
}));

vi.mock('../../../db/client.js', () => ({ db: { select: vi.fn() } }));
vi.mock('../../mediaServer/silo/client.js', () => ({
  SiloClient: class {
    getPlaybackHistoryPage = getPlaybackHistoryPage;
    getDeviceNames = getDeviceNames;
  },
}));
vi.mock('../../../lib/redisShared.js', () => ({ getRedis: () => redis }));
vi.mock('../../settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../settings.js')>()),
  getWatchedThreshold: vi.fn().mockResolvedValue(0.85),
}));
vi.mock('../../geoip.js', () => ({
  geoipService: {
    lookup: vi.fn(() => ({
      city: null,
      region: null,
      country: null,
      countryCode: null,
      continent: null,
      postal: null,
      lat: null,
      lon: null,
    })),
    isPrivateIP: vi.fn((ip: string) => ip.startsWith('192.168.')),
  },
}));
vi.mock('../../geoasn.js', () => ({
  geoasnService: { lookup: vi.fn(() => ({ number: null, organization: null })) },
}));
vi.mock('../aggregates.js', () => ({ refreshImportAggregates: vi.fn() }));
vi.mock('../../../jobs/maintenanceQueue.js', () => ({
  enqueueServerLocationSyncIfBehind: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../serverLocations.js', () => ({ markImportedServerLocations: vi.fn() }));
vi.mock('../../../jobs/poller/database.js', () => ({
  batchGetLibraryItemIdentity: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('../userMapping.js', async (importActual) => ({
  ...(await importActual<typeof import('../userMapping.js')>()),
  createUserMapping: vi.fn(),
}));
vi.mock('../batchProcessor.js', async (importActual) => ({
  ...(await importActual<typeof import('../batchProcessor.js')>()),
  flushInsertBatch: vi.fn(),
}));
vi.mock('../../sync.js', () => ({ syncServer: vi.fn() }));
vi.mock('../../profiles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../profiles.js')>()),
  resolveProfiles: vi.fn(),
  storedProfileIds: vi.fn(),
}));

import { db } from '../../../db/client.js';
import { flushInsertBatch, normalizeSessionFields } from '../batchProcessor.js';
import { syncServer } from '../../sync.js';
import { createUserMapping } from '../userMapping.js';
import { resolveProfiles, storedProfileIds } from '../../profiles.js';
import { getWatchedThreshold } from '../../settings.js';
import { parseSiloDeviceNames, parseSiloSession } from '../../mediaServer/silo/parser.js';
import { mapMediaSession } from '../../../jobs/poller/sessionMapper.js';
import { normalizeClient } from '../../../utils/platformNormalizer.js';
import { clearHistoryCursor, importSiloHistory } from '../siloHistory.js';

const SERVER = {
  id: '5c1d0000-3a1c-4d2e-9b5f-0000000000bb',
  type: 'silo',
  url: 'http://silo.local:8080',
  token: 'silo-key',
  historicalAt: null,
  watchedRulePercent: null,
};
const OWNER = 'a1b2c3d4-0000-4000-8000-000000000001';
const VIEWER = 'a1b2c3d4-0000-4000-8000-000000000034';
const OWNER_PROFILE = '8581c93e-0798-41e4-ba29-cb7cf3acced0';
const VIEWER_PROFILE = '494983e2-3141-4ccf-a3b6-e6af431e5996';
const KID_PROFILE = '2770043c-2cab-4bb2-a860-6991aa254f29';

type Row = (typeof silo.history.items)[number];

function historyRow(sessionId: string): Row {
  const row = silo.history.items.find((item) => item.session_id.startsWith(sessionId));
  if (!row) throw new Error(`fixture has no play ${sessionId}`);
  return row;
}

const ZOOTOPIA = historyRow('838e94ff');

/** The server row, then the plays already in Tracearr for each page in turn */
function rows(...known: { sessionKey: string; externalSessionId: string | null }[][]) {
  const results: unknown[] = [[SERVER], ...known];
  vi.mocked(db.select).mockImplementation(() => queryChain(vi.fn, results.shift() ?? []));
}

function onePage(items: unknown[]) {
  getPlaybackHistoryPage.mockReset();
  getPlaybackHistoryPage.mockResolvedValueOnce({ items, page: { has_more: false } });
}

function inserted() {
  return vi.mocked(flushInsertBatch).mock.calls.flatMap(([batch]) => batch);
}

function insertOf(sessionId: string) {
  return inserted().find((row) => row.externalSessionId === sessionId);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createUserMapping).mockResolvedValue(
    new Map([
      ['1', OWNER],
      ['34', VIEWER],
    ])
  );
  vi.mocked(syncServer).mockResolvedValue({
    usersAdded: 0,
    usersUpdated: 2,
    usersSkipped: 0,
    usersRemoved: 0,
    usersRestored: 0,
    librariesSynced: 0,
    usersRead: true,
    errors: [],
  });
  getDeviceNames.mockResolvedValue(parseSiloDeviceNames(silo.devices.items));
  getPlaybackHistoryPage.mockReset();
  getPlaybackHistoryPage.mockResolvedValueOnce(silo.history);
  redis.get.mockResolvedValue(null);
  vi.mocked(resolveProfiles).mockResolvedValue(new Map());
  vi.mocked(storedProfileIds).mockResolvedValue(new Map());
});

describe('importSiloHistory', () => {
  it('imports each finished Silo play once, under its session id', async () => {
    rows([]);

    const result = await importSiloHistory(SERVER.id);

    expect(inserted()).toHaveLength(7);
    for (const row of inserted()) {
      expect(row).toMatchObject({
        sessionKey: `silo-${row.externalSessionId}`,
        state: 'stopped',
      });
    }
    expect(inserted().map((row) => row.externalSessionId)).toEqual(
      silo.history.items.map((item) => item.session_id)
    );
    expect(result).toMatchObject({ success: true, imported: 7 });
  });

  it('skips a play Tracearr captured live under its session id, and one an earlier import brought in', async () => {
    rows([
      { sessionKey: 'ea42dd3a-aa1c-457e-bf21-569516e4c183', externalSessionId: null },
      {
        sessionKey: 'silo-933eeb86-3768-4d4c-823a-136637cc667a',
        externalSessionId: '933eeb86-3768-4d4c-823a-136637cc667a',
      },
    ]);

    const result = await importSiloHistory(SERVER.id);

    expect(result).toMatchObject({ imported: 5, duplicates: 2 });
    const ids = inserted().map((row) => row.externalSessionId);
    expect(ids).not.toContain('ea42dd3a-aa1c-457e-bf21-569516e4c183');
    expect(ids).not.toContain('933eeb86-3768-4d4c-823a-136637cc667a');
  });

  it("times a play by Silo's measurement, and an unmeasured play as Silo's own page estimates it", async () => {
    rows([]);

    await importSiloHistory(SERVER.id);

    expect(insertOf(ZOOTOPIA.session_id)).toMatchObject({
      startedAt: new Date('2026-11-19T01:14:54.188Z'),
      stoppedAt: new Date('2026-11-19T01:16:16.037Z'),
      durationMs: 70900,
      pausedDurationMs: 0,
      progressMs: 4565352,
      totalDurationMs: 6512000,
      shortSession: true,
    });
    expect(insertOf(historyRow('ea42dd3a').session_id)).toMatchObject({
      durationMs: 6000,
      pausedDurationMs: 3031,
      progressMs: 10000,
    });
    expect(insertOf(historyRow('8415ab73').session_id)).toMatchObject({
      durationMs: 16251,
      pausedDurationMs: 0,
      progressMs: 2491558,
    });
  });

  it("counts a play watched by Tracearr's threshold on how far it got, never by Silo's completed flag", async () => {
    rows([]);
    onePage([
      ZOOTOPIA,
      { ...ZOOTOPIA, session_id: 'far', end_position_seconds: 5600 },
      { ...ZOOTOPIA, session_id: 'flagged', completed: true },
      { ...ZOOTOPIA, session_id: 'no-length', duration_seconds: null },
    ]);

    await importSiloHistory(SERVER.id);

    expect(inserted().map((row) => row.watched)).toEqual([false, true, false, false]);
    expect(insertOf('no-length')).toMatchObject({ totalDurationMs: null });
    expect(getWatchedThreshold).toHaveBeenCalledWith('movie');
  });

  it("names an episode by its series and files its poster under the episode's content id", async () => {
    rows([]);

    await importSiloHistory(SERVER.id);

    expect(insertOf(historyRow('0b9c9dc6').session_id)).toMatchObject({
      ratingKey: 'episode-imdb-tt31510819-1-1',
      mediaType: 'episode',
      mediaTitle: 'Stick or Twist',
      grandparentTitle: 'MobLand',
      seasonNumber: 1,
      episodeNumber: 1,
      thumbPath: '/content/episode-imdb-tt31510819-1-1/poster',
      serverVersionKey: '5925',
    });
    expect(insertOf(ZOOTOPIA.session_id)).toMatchObject({
      grandparentTitle: null,
      seasonNumber: null,
    });
  });

  it("names a play of an item gone from Silo's catalog by its content id, as Silo's history page does", async () => {
    rows([]);
    onePage([{ ...ZOOTOPIA, media_title: '', media_type: '' }]);

    await importSiloHistory(SERVER.id);

    expect(insertOf(ZOOTOPIA.session_id)).toMatchObject({ mediaTitle: ZOOTOPIA.media_item_id });
  });

  it("names the player as a live play is named: the device's name, else the app", async () => {
    rows([]);

    await importSiloHistory(SERVER.id);

    expect(insertOf(historyRow('f3ce3512').session_id)).toMatchObject({
      playerName: 'iPhone',
      product: 'Silo iPhone',
      deviceId: 'aef454b9-44e6-412f-913b-3e3a5eb0dbee',
      ipAddress: '203.0.113.24',
      isLocal: false,
      isTranscode: true,
      quality: 'Transcode',
    });
    expect(insertOf(historyRow('ea42dd3a').session_id)).toMatchObject({
      playerName: 'Tracearr check',
      deviceId: 'tracearr-check-device-5',
      isLocal: true,
      isTranscode: false,
      quality: 'Direct',
    });
    for (const item of silo.history.items) {
      const client = normalizeClient(item.client_name || item.device_platform || '', '', 'silo');
      expect(insertOf(item.session_id)).toMatchObject({
        device: client.device,
        platform: client.platform,
      });
    }
  });

  it('stores the device a live play of the same app-less row stores', async () => {
    rows([]);
    const appless = { client_name: null, device_platform: 'iOS', device_id: 'unlisted-device' };
    onePage([{ ...ZOOTOPIA, ...appless }]);
    const [liveRow] = silo.sessions.items;
    if (!liveRow) throw new Error('fixture has no live session');
    const live = mapMediaSession(
      parseSiloSession({ ...liveRow, ...appless, client_name: undefined }, undefined),
      'silo'
    );

    await importSiloHistory(SERVER.id);

    const [stored] = inserted().map(normalizeSessionFields);
    expect(stored).toMatchObject({ device: live.device, platform: live.platform });
  });

  it('links each play to the profile its row names, adding a missing one, and adds none named by its id', async () => {
    rows([]);
    const kid = historyRow('838e94ff');
    onePage([
      ...silo.history.items,
      { ...kid, session_id: 'nameless', profile_id: 'p-nameless', profile_name: 'p-nameless' },
    ]);

    await importSiloHistory(SERVER.id);

    expect(resolveProfiles).toHaveBeenCalledOnce();
    const [serverId, sightings, mode] = vi.mocked(resolveProfiles).mock.calls[0] ?? [];
    expect(serverId).toBe(SERVER.id);
    expect(mode).toBe('insertMissing');
    const distinct = new Map(sightings?.map((sighting) => [sighting.externalId, sighting]));
    expect([...distinct.values()].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { externalId: KID_PROFILE, serverUserId: VIEWER, name: 'Kid' },
      { externalId: OWNER_PROFILE, serverUserId: OWNER, name: 'silo-owner' },
      { externalId: VIEWER_PROFILE, serverUserId: VIEWER, name: 'Viewer' },
    ]);
    expect(insertOf('nameless')).toMatchObject({ profileName: null, profileId: null });
  });

  it('inserts a named profile, links an unnamed one to the profile already stored under its id, and leaves an unstored unnamed one unlinked', async () => {
    rows([]);
    const kid = historyRow('838e94ff');
    const viewer = historyRow('ea42dd3a');
    onePage([
      kid,
      { ...viewer, session_id: 'unnamed-stored', profile_name: viewer.profile_id },
      { ...kid, session_id: 'unnamed-unstored', profile_id: 'p-gone', profile_name: 'p-gone' },
    ]);
    vi.mocked(resolveProfiles).mockResolvedValue(new Map([[KID_PROFILE, { id: 'profile-kid' }]]));
    vi.mocked(storedProfileIds).mockResolvedValue(new Map([[VIEWER_PROFILE, 'profile-viewer']]));

    await importSiloHistory(SERVER.id);

    expect(vi.mocked(resolveProfiles).mock.calls).toEqual([
      [
        SERVER.id,
        [{ externalId: KID_PROFILE, serverUserId: VIEWER, name: 'Kid' }],
        'insertMissing',
      ],
    ]);
    expect(vi.mocked(storedProfileIds).mock.calls).toEqual([
      [SERVER.id, [VIEWER_PROFILE, 'p-gone']],
    ]);
    expect(insertOf(kid.session_id)).toMatchObject({ profileId: 'profile-kid' });
    expect(insertOf('unnamed-stored')).toMatchObject({
      profileId: 'profile-viewer',
      profileName: null,
    });
    expect(insertOf('unnamed-unstored')).toMatchObject({ profileId: null });
  });

  it('skips the plays of an account Tracearr does not know, and names the account', async () => {
    rows([]);
    vi.mocked(createUserMapping).mockResolvedValue(new Map([['1', OWNER]]));
    const progress: ServerHistoryImportProgress[] = [];

    const result = await importSiloHistory(SERVER.id, undefined, async (update) => {
      progress.push({ ...update });
    });

    expect(progress.at(-1)).toMatchObject({ unknownUserRecords: 4 });
    expect(result.skippedUsers).toEqual([{ userId: '34', username: 'viewer', recordCount: 4 }]);
  });

  it("reads every page by Silo's cursor, repeating the same bound", async () => {
    rows([], []);
    getPlaybackHistoryPage.mockReset();
    getPlaybackHistoryPage
      .mockResolvedValueOnce({
        items: silo.history.items.slice(0, 4),
        page: { has_more: true, next_cursor: 'c2' },
      })
      .mockResolvedValueOnce({ items: silo.history.items.slice(4), page: { has_more: false } });

    const result = await importSiloHistory(SERVER.id);

    expect(getPlaybackHistoryPage.mock.calls).toEqual([
      [null, null],
      [null, 'c2'],
    ]);
    expect(result).toMatchObject({ imported: 7 });
  });

  it('reads all history on a first run, and from an hour before the newest play read on later runs', async () => {
    rows([]);

    await importSiloHistory(SERVER.id);

    expect(getPlaybackHistoryPage.mock.calls[0]).toEqual([null, null]);
    expect(redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.SERVER_HISTORY_CURSOR(SERVER.id),
      '2026-11-21T19:50:39.525Z'
    );

    rows([]);
    getPlaybackHistoryPage.mockReset();
    getPlaybackHistoryPage.mockResolvedValueOnce(silo.history);
    redis.get.mockResolvedValue('2026-11-21T19:50:39.525Z');

    await importSiloHistory(SERVER.id);

    expect(getPlaybackHistoryPage.mock.calls[0]).toEqual([
      new Date(Date.parse('2026-11-21T19:50:39.525Z') - 3_600_000),
      null,
    ]);
  });

  it('keeps the cursor after a run that skipped an unknown account, or read nothing', async () => {
    rows([]);
    vi.mocked(createUserMapping).mockResolvedValue(new Map([['1', OWNER]]));

    await importSiloHistory(SERVER.id);

    expect(redis.set).not.toHaveBeenCalled();

    rows();
    onePage([]);

    await importSiloHistory(SERVER.id);

    expect(redis.set).not.toHaveBeenCalled();
  });

  it("fails at once for a server whose history is not Silo's", async () => {
    vi.mocked(db.select).mockImplementation(() => queryChain(vi.fn, [{ ...SERVER, type: 'tofa' }]));

    await expect(importSiloHistory(SERVER.id)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(syncServer).not.toHaveBeenCalled();
  });
});

describe('clearHistoryCursor', () => {
  it("forgets one server's history cursor", async () => {
    await clearHistoryCursor(redis as unknown as Redis, SERVER.id);

    expect(redis.del).toHaveBeenCalledExactlyOnceWith(REDIS_KEYS.SERVER_HISTORY_CURSOR(SERVER.id));
  });

  it("forgets every server's history cursor", async () => {
    const keys = [REDIS_KEYS.SERVER_HISTORY_CURSOR('a'), REDIS_KEYS.SERVER_HISTORY_CURSOR('b')];
    redis.scanStream.mockReturnValue(Readable.from([keys]));

    await clearHistoryCursor(redis as unknown as Redis);

    expect(redis.scanStream).toHaveBeenCalledWith({
      match: REDIS_KEYS.SERVER_HISTORY_CURSOR('*'),
      count: 100,
    });
    expect(redis.del).toHaveBeenCalledExactlyOnceWith(...keys);
  });
});
