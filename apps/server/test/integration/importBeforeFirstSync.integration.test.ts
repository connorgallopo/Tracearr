/**
 * Playback Reporting plays take their season and show keys from the library as they are written,
 * so an import asked for while a new Jellyfin server's first library sync is queued waits for it.
 * Each play must point at its library item's media, season and show.
 *
 * Run with: pnpm --filter @tracearr/server test:integration importBeforeFirstSync
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestServer } from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import {
  createJellyfinEmbyClient,
  createMediaServerClient,
  type MediaLibraryItem,
} from '../../src/services/mediaServer/index.js';
import { NOT_NEEDED } from '../../src/services/mediaServer/types.js';
import { librarySyncService } from '../../src/services/librarySync.js';
import { registeredQueue } from '../../src/jobs/jobSafety.js';
import {
  BASE_COLUMNS,
  OPTIONAL_COLUMNS,
  importPlaybackReporting,
} from '../../src/services/playbackReporting.js';
import {
  enqueueLibrarySync,
  hasPendingFirstSync,
  hasPendingLibrarySync,
  initLibrarySyncQueue,
  markFirstSyncOwed,
  obliterateLibrarySyncQueue,
  shutdownLibrarySyncQueue,
  startLibrarySyncWorker,
} from '../../src/jobs/librarySyncQueue.js';
import {
  enqueuePlaybackReportingImport,
  getImportStatus,
  initImportQueue,
  obliterateImportQueue,
  shutdownImportQueue,
  startImportWorker,
} from '../../src/jobs/importQueue.js';

vi.mock('../../src/services/mediaServer/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/mediaServer/index.js')>()),
  createMediaServerClient: vi.fn(),
  createJellyfinEmbyClient: vi.fn(),
}));

vi.mock('../../src/services/automations/events/producers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/automations/events/producers.js')>()),
  mediaListeners: vi.fn().mockResolvedValue({ added: false, upgraded: false }),
}));

vi.mock('../../src/jobs/precachePassPolicy.js', () => ({
  resolvePrecachePass: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/services/imageCacheSweep.js', () => ({ scheduleImageCacheSweep: vi.fn() }));

const USER_ID = 'jf-user-1';
const ADDED_AT = new Date('2024-01-01T00:00:00Z');

const SHOW = 'jf-show-severance';
const SEASON = 'jf-season-severance-1';

const MOVIES: MediaLibraryItem[] = [
  {
    ratingKey: 'jf-movie-arrival',
    title: 'Arrival',
    mediaType: 'movie',
    year: 2016,
    tmdbId: 329865,
    imdbId: 'tt2543164',
    addedAt: ADDED_AT,
  },
  {
    ratingKey: 'jf-movie-sicario',
    title: 'Sicario',
    mediaType: 'movie',
    year: 2015,
    tmdbId: 273481,
    imdbId: 'tt3397884',
    addedAt: ADDED_AT,
  },
];

const TV_SHOWS: MediaLibraryItem[] = [
  {
    ratingKey: SHOW,
    title: 'Severance',
    mediaType: 'show',
    year: 2022,
    tvdbId: 371980,
    addedAt: ADDED_AT,
  },
];
const TV_SEASONS: MediaLibraryItem[] = [
  {
    ratingKey: SEASON,
    title: 'Season 1',
    mediaType: 'season',
    parentRatingKey: SHOW,
    itemIndex: 1,
    addedAt: ADDED_AT,
  },
];
const TV_EPISODES: MediaLibraryItem[] = [
  {
    ratingKey: 'jf-ep-severance-101',
    title: 'Good News About Hell',
    mediaType: 'episode',
    year: 2022,
    tvdbId: 8714310,
    imdbId: 'tt11280740',
    grandparentRatingKey: SHOW,
    grandparentTitle: 'Severance',
    parentRatingKey: SEASON,
    parentTitle: 'Season 1',
    parentIndex: 1,
    itemIndex: 1,
    addedAt: ADDED_AT,
  },
];

const JELLYFIN_ITEMS = [
  {
    Id: 'jf-movie-arrival',
    Type: 'Movie',
    Name: 'Arrival',
    ProductionYear: 2016,
    RunTimeTicks: 69_600_000_000,
  },
  {
    Id: 'jf-movie-sicario',
    Type: 'Movie',
    Name: 'Sicario',
    ProductionYear: 2015,
    RunTimeTicks: 72_000_000_000,
  },
  {
    Id: 'jf-ep-severance-101',
    Type: 'Episode',
    Name: 'Good News About Hell',
    SeriesId: SHOW,
    SeriesName: 'Severance',
    ProductionYear: 2022,
    ParentIndexNumber: 1,
    IndexNumber: 1,
    RunTimeTicks: 34_800_000_000,
  },
];

function wallTime(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
}

const COLUMNS = ['rowid', ...BASE_COLUMNS, ...OPTIONAL_COLUMNS];
const PLAYS: string[][] = [
  [
    '1',
    wallTime(3),
    USER_ID,
    'jf-movie-arrival',
    'Movie',
    'Arrival',
    'DirectPlay',
    'Jellyfin Web',
    'Firefox',
    '6000',
    '0',
    '192.168.1.20',
  ],
  [
    '2',
    wallTime(3),
    USER_ID,
    'jf-movie-sicario',
    'Movie',
    'Sicario',
    'DirectPlay',
    'Jellyfin Web',
    'Firefox',
    '6000',
    '0',
    '192.168.1.20',
  ],
  [
    '3',
    wallTime(2),
    USER_ID,
    'jf-ep-severance-101',
    'Episode',
    'Severance - s01e01 - Good News About Hell',
    'DirectPlay',
    'Jellyfin Web',
    'Firefox',
    '3000',
    '0',
    '192.168.1.20',
  ],
];

function page(items: MediaLibraryItem[], options?: { offset?: number }) {
  return Promise.resolve({
    items: (options?.offset ?? 0) === 0 ? items : [],
    totalCount: items.length,
  });
}

function stubJellyfin() {
  const client = {
    serverType: 'jellyfin',
    testConnection: () => Promise.resolve(true),
    getServerIdentity: () => Promise.resolve('jf-install-1'),
    getUsers: () => Promise.resolve([{ id: USER_ID, username: 'viewer', isAdmin: false }]),
    getLibraries: () =>
      Promise.resolve([
        { id: 'movies', name: 'Movies', type: 'movies' },
        { id: 'tv', name: 'Shows', type: 'tvshows' },
      ]),
    getLibraryItems: (id: string, options?: { offset?: number }) =>
      page(id === 'movies' ? MOVIES : TV_SHOWS, options),
    getLibraryLeaves: (id: string, options?: { offset?: number }) =>
      page(id === 'tv' ? TV_EPISODES : [], options),
    getLibrarySeasons: (id: string, options?: { offset?: number }) =>
      page(id === 'tv' ? TV_SEASONS : [], options),
    findExistingRatingKeys: () => Promise.resolve(new Set<string>()),
    getLibraryRevision: () => Promise.resolve(NOT_NEEDED),
    getItems: (ids: string[]) =>
      Promise.resolve(JELLYFIN_ITEMS.filter((item) => ids.includes(item.Id))),
    getPlaybackReportingInfo: () =>
      Promise.resolve({
        installed: true,
        columns: COLUMNS.slice(1),
        totalRecords: PLAYS.length,
        oldestDate: null,
        newestDate: null,
      }),
    queryPlaybackReporting: (query: string) =>
      Promise.resolve(/rowid > 0 /.test(query) ? PLAYS : []),
  };
  vi.mocked(createMediaServerClient).mockReturnValue(client as never);
  vi.mocked(createJellyfinEmbyClient).mockReturnValue(client as never);
}

async function newServer() {
  const server = await createTestServer({ type: 'jellyfin' });
  stubJellyfin();
  return server.id;
}

async function importPlays(serverId: string) {
  const result = await importPlaybackReporting(serverId, {
    timezone: 'UTC',
    enrichMedia: true,
    importFullRange: false,
  });
  expect(result).toMatchObject({ success: true, imported: PLAYS.length });
}

/** Each play beside what its library item says it should carry */
async function playsAgainstLibrary(serverId: string) {
  const result = await db.execute<Record<string, string | null>>(sql`
    SELECT s.rating_key,
           s.media_id::text AS media_id, li.media_id::text AS item_media_id,
           s.parent_rating_key, li.parent_rating_key AS item_parent_rating_key,
           s.grandparent_rating_key, li.grandparent_rating_key AS item_grandparent_rating_key,
           s.show_media_id::text AS show_media_id, show.media_id::text AS item_show_media_id
    FROM sessions s
    JOIN library_items li ON li.server_id = s.server_id AND li.rating_key = s.rating_key
    LEFT JOIN library_items show
      ON show.server_id = s.server_id AND show.rating_key = li.grandparent_rating_key
    WHERE s.server_id = ${serverId}
      AND s.started_at >= now() - interval '7 days'
    ORDER BY s.rating_key
  `);
  return result.rows;
}

function expectLinked(rows: Record<string, string | null>[]) {
  expect(rows).toHaveLength(PLAYS.length);
  for (const row of rows) {
    expect(row.item_media_id).not.toBeNull();
    expect({
      rating_key: row.rating_key,
      media_id: row.media_id,
      parent_rating_key: row.parent_rating_key,
      grandparent_rating_key: row.grandparent_rating_key,
      show_media_id: row.show_media_id,
    }).toEqual({
      rating_key: row.rating_key,
      media_id: row.item_media_id,
      parent_rating_key: row.item_parent_rating_key,
      grandparent_rating_key: row.item_grandparent_rating_key,
      show_media_id: row.item_show_media_id,
    });
  }
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function importState(jobId: string): Promise<string> {
  return (await getImportStatus(jobId))?.state ?? 'missing';
}

describe('Playback Reporting import and the first library sync', () => {
  // Fresh workers each test: a worker that just ran an import waits out its one-a-minute limit
  beforeEach(async () => {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error('REDIS_URL is not set');
    initLibrarySyncQueue(redisUrl);
    initImportQueue(redisUrl);
    await obliterateLibrarySyncQueue();
    await obliterateImportQueue();
    await registeredQueue('imports')?.removeRateLimitKey();
  });

  afterEach(async () => {
    await obliterateImportQueue();
    await obliterateLibrarySyncQueue();
    await shutdownImportQueue();
    await shutdownLibrarySyncQueue();
  });

  it('links every play when the import runs after the first sync', async () => {
    const serverId = await newServer();
    await librarySyncService.syncServer(serverId, undefined, 'scheduled');
    await importPlays(serverId);

    expectLinked(await playsAgainstLibrary(serverId));
  });

  it('links every play of an import asked for while the first sync is queued', async () => {
    const serverId = await newServer();
    await enqueueLibrarySync(serverId, 'event', { firstSync: true });
    const importId = await enqueuePlaybackReportingImport(serverId, 'owner', 'UTC', true, false);

    // The import worker goes first: an import that does not wait runs before any library item exists
    startImportWorker();
    await until(
      async () => ['delayed', 'completed', 'failed'].includes(await importState(importId)),
      'the import to wait or finish'
    );
    startLibrarySyncWorker();
    await until(async () => !(await hasPendingLibrarySync(serverId)), 'the first sync');
    await until(
      async () => ['completed', 'failed'].includes(await importState(importId)),
      'the import'
    );

    expect(await importState(importId)).toBe('completed');
    expectLinked(await playsAgainstLibrary(serverId));
  });

  it('links every play of an import asked for after the add answers, before the first sync is queued', async () => {
    const serverId = await newServer();
    // What adding the server does before it answers; its user sync then runs before the first sync is queued
    await markFirstSyncOwed(serverId);
    const importId = await enqueuePlaybackReportingImport(serverId, 'owner', 'UTC', true, false);

    startImportWorker();
    startLibrarySyncWorker();
    await until(
      async () => ['delayed', 'completed', 'failed'].includes(await importState(importId)),
      'the import to wait or finish'
    );
    await enqueueLibrarySync(serverId, 'event', { firstSync: true });
    await until(async () => !(await hasPendingLibrarySync(serverId)), 'the first sync');
    await until(
      async () => ['completed', 'failed'].includes(await importState(importId)),
      'the import'
    );

    expect(await hasPendingFirstSync(serverId)).toBe(false);
    expect(await importState(importId)).toBe('completed');
    expectLinked(await playsAgainstLibrary(serverId));
  });
});
