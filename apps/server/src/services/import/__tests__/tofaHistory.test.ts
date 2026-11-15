import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import tofa from '../../../test/mediaServerResponses/tofa.json' with { type: 'json' };
import { queryChain } from '../../../test/helpers.js';

const { getWatchHistoryPage } = vi.hoisted(() => ({ getWatchHistoryPage: vi.fn() }));

vi.mock('../../../db/client.js', () => ({ db: { select: vi.fn() } }));
vi.mock('../../mediaServer/tofa/client.js', () => ({
  TofaClient: class {
    getWatchHistoryPage = getWatchHistoryPage;
  },
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
    isPrivateIP: vi.fn(() => false),
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
vi.mock('../batchProcessor.js', () => ({ flushInsertBatch: vi.fn() }));
vi.mock('../../sync.js', () => ({ syncServer: vi.fn() }));

import { db } from '../../../db/client.js';
import { flushInsertBatch } from '../batchProcessor.js';
import { syncServer } from '../../sync.js';
import { createUserMapping } from '../userMapping.js';
import { HttpClientError } from '../../../utils/http.js';
import { importTofaHistory } from '../tofaHistory.js';

const SERVER = {
  id: '7e0f0000-3a1c-4d2e-9b5f-0000000000aa',
  type: 'tofa',
  url: 'http://tofa.local:33333',
  token: 'tofa-key',
  historicalAt: null,
  watchedRulePercent: 90,
};
const [newer, older] = tofa.watchHistoryPages;
const SERVER_USER = 'd7c1e5a9-0b3f-4e62-8a14-5f9c2b6d8e30';

/** The server row, then the plays already in Tracearr for each page in turn */
function rows(...known: { sessionKey: string; externalSessionId: string | null }[][]) {
  const results: unknown[] = [[SERVER], ...known];
  vi.mocked(db.select).mockImplementation(() => queryChain(vi.fn, results.shift() ?? []));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createUserMapping).mockResolvedValue(new Map([[tofa.users[0]?.id ?? '', SERVER_USER]]));
  vi.mocked(syncServer).mockResolvedValue({
    usersAdded: 0,
    usersUpdated: 1,
    usersSkipped: 0,
    usersRemoved: 0,
    usersRestored: 0,
    librariesSynced: 0,
    usersRead: true,
    errors: [],
  });
  getWatchHistoryPage.mockResolvedValueOnce(newer).mockResolvedValueOnce(older);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('importTofaHistory', () => {
  it("syncs the server's users before mapping plays to them", async () => {
    rows([], []);

    await importTofaHistory(SERVER.id);

    expect(syncServer).toHaveBeenCalledWith(SERVER.id, { syncUsers: true, syncLibraries: false });
    expect(vi.mocked(syncServer).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(createUserMapping).mock.invocationCallOrder[0] ?? 0
    );
  });

  it('throws for a retry and imports nothing when the user list cannot be read', async () => {
    rows([], []);
    vi.mocked(syncServer).mockResolvedValueOnce({
      usersAdded: 0,
      usersUpdated: 0,
      usersSkipped: 0,
      usersRemoved: 0,
      usersRestored: 0,
      librariesSynced: 0,
      usersRead: false,
      errors: ['tofa user sync failed: unreachable'],
    });

    const run = importTofaHistory(SERVER.id);

    await expect(run).rejects.toThrow('tofa user sync failed: unreachable');
    await expect(run).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(getWatchHistoryPage).not.toHaveBeenCalled();
  });

  it('fails at once when tofa refuses the key while syncing users', async () => {
    rows([], []);
    vi.mocked(syncServer).mockResolvedValueOnce({
      usersAdded: 0,
      usersUpdated: 0,
      usersSkipped: 0,
      usersRemoved: 0,
      usersRestored: 0,
      librariesSynced: 0,
      usersRead: false,
      usersError: new HttpClientError({
        service: 'tofa',
        statusCode: 401,
        statusText: 'Unauthorized',
        url: '',
      }),
      errors: ['tofa user sync failed: tofa request failed: 401 Unauthorized'],
    });

    await expect(importTofaHistory(SERVER.id)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(getWatchHistoryPage).not.toHaveBeenCalled();
  });

  it('fails at once for a server that keeps no watch history of its own', async () => {
    vi.mocked(db.select).mockImplementation(() => queryChain(vi.fn, [{ ...SERVER, type: 'plex' }]));

    await expect(importTofaHistory(SERVER.id)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(syncServer).not.toHaveBeenCalled();
  });

  it('pages back from the newest play and stops at the oldest', async () => {
    rows([], []);

    const result = await importTofaHistory(SERVER.id);

    expect(getWatchHistoryPage.mock.calls).toEqual([
      [null, 200],
      ['2025-03-02T18:00:00.001Z', 200],
    ]);
    expect(result).toMatchObject({ success: true, imported: 3 });
  });

  it('reads a play that starts when the last page ended, and reads the last page once', async () => {
    const [latest, boundary] = newer?.items ?? [];
    if (!latest || !boundary || !older) throw new Error('fixture has no plays');
    const sameStart = { ...boundary, id: 'tied-play', session_id: null };
    rows([], []);
    getWatchHistoryPage.mockReset();
    getWatchHistoryPage
      .mockResolvedValueOnce({ items: [latest, boundary], has_more: true })
      .mockResolvedValueOnce({ ...older, items: [boundary, sameStart, ...older.items] });

    const result = await importTofaHistory(SERVER.id);

    const inserted = vi.mocked(flushInsertBatch).mock.calls.flatMap(([batch]) => batch);
    expect(inserted.map((row) => row.externalSessionId)).toEqual([
      latest.id,
      boundary.id,
      'tied-play',
      older.items[0]?.id,
    ]);
    expect(result).toMatchObject({ imported: 4, duplicates: 0 });
  });

  it('skips a play Tracearr captured, and times the rest from their start and end', async () => {
    const captured = newer?.items[0];
    rows([{ sessionKey: captured?.session_id ?? '', externalSessionId: null }], []);

    const result = await importTofaHistory(SERVER.id);

    expect(result).toMatchObject({ imported: 2, duplicates: 1 });
    const inserted = vi.mocked(flushInsertBatch).mock.calls.flatMap(([batch]) => batch);
    const movie = newer?.items[1];
    expect(inserted[0]).toMatchObject({
      serverUserId: SERVER_USER,
      sessionKey: `tofa-${movie?.id}`,
      externalSessionId: movie?.id,
      ratingKey: movie?.media_id,
      mediaType: 'movie',
      startedAt: new Date('2025-03-02T18:00:00Z'),
      stoppedAt: new Date('2025-03-02T19:40:00Z'),
      durationMs: 100 * 60 * 1000,
      progressMs: 5200000,
      totalDurationMs: 5400000,
      watched: true,
      isTranscode: true,
      ipAddress: '203.0.113.24',
      deviceId: movie?.device_id,
    });
    expect(inserted[1]).toMatchObject({ durationMs: 10 * 60 * 1000, watched: false });
  });

  it('says so when a full page of plays started in one millisecond and stops there', async () => {
    const [latest, other] = newer?.items ?? [];
    if (!latest || !other) throw new Error('fixture has no plays');
    const tied = { items: [latest, { ...other, started_at: latest.started_at }], has_more: true };
    rows([], []);
    getWatchHistoryPage.mockReset();
    getWatchHistoryPage.mockResolvedValue(tied);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await importTofaHistory(SERVER.id);

    expect(result).toMatchObject({ success: true, imported: 2 });
    expect(warn).toHaveBeenCalledWith(
      '[TofaHistory] Stopped before the oldest plays: a full page started at',
      latest.started_at
    );
    expect(getWatchHistoryPage).toHaveBeenCalledTimes(2);
  });

  it('names each play by the profile its row names, and leaves a play without one unnamed', async () => {
    rows([], []);
    getWatchHistoryPage.mockReset();
    getWatchHistoryPage
      .mockResolvedValueOnce(newer)
      .mockResolvedValueOnce(
        older && { ...older, items: older.items.map((row) => ({ ...row, profile_name: null })) }
      );

    await importTofaHistory(SERVER.id);

    const inserted = vi.mocked(flushInsertBatch).mock.calls.flatMap(([batch]) => batch);
    expect(inserted.map((row) => row.profileName)).toEqual(['Robin', 'Robin', null]);
  });
});
