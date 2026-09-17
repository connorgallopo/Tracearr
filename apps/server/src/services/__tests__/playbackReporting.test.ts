import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  BASE_COLUMNS,
  buildSelectColumns,
  importPlaybackReporting,
  parseEpisodeItemName,
  parsePlaybackReportingRows,
  transformPlaybackReportingRow,
  type PlaybackReportingRow,
  type TransformContext,
} from '../playbackReporting.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { refreshAggregates } from '../../db/timescale.js';
import { batchGetLibraryItemIdentity } from '../../jobs/poller/database.js';
import {
  createUserMapping,
  fetchMediaEnrichment,
  flushInsertBatch,
  queryExistingByExternalIds,
} from '../import/index.js';
import type * as ImportModule from '../import/index.js';
import type { PubSubService } from '../cache.js';

const JF_COLUMNS = [...BASE_COLUMNS];
const EMBY_COLUMNS = [...BASE_COLUMNS, 'PauseDuration', 'RemoteAddress', 'TranscodeReasons'];

let mockGetPlaybackReportingInfo = vi.fn();
let mockQueryPlaybackReporting = vi.fn();
let constructedClients: string[] = [];

vi.mock('../geoip.js', () => ({
  geoipService: {
    lookup: vi.fn((ip: string) => ({
      city: ip === '0.0.0.0' ? null : 'Jersey City',
      region: null,
      country: null,
      countryCode: null,
      continent: null,
      postal: null,
      lat: null,
      lon: null,
    })),
  },
}));

vi.mock('../geoasn.js', () => ({
  geoasnService: {
    lookup: vi.fn(() => ({ number: null, organization: null })),
  },
}));

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../../db/timescale.js', () => ({
  refreshAggregates: vi.fn().mockResolvedValue(undefined),
  checkAggregateNeedsRebuild: vi.fn().mockResolvedValue({ needsRebuild: false }),
  uncapDecompressionForTx: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../jobs/maintenanceQueue.js', () => ({
  enqueueMaintenanceJob: vi.fn().mockResolvedValue('job-1'),
}));

vi.mock('../../jobs/poller/database.js', () => ({
  batchGetLibraryItemIdentity: vi.fn(),
}));

vi.mock('../settings.js', async (importActual) => ({
  ...(await importActual<typeof import('../settings.js')>()),
  getWatchedThresholds: vi.fn().mockResolvedValue({ movie: 0.9, episode: 0.9, track: 0.9 }),
}));

vi.mock('../import/index.js', async (importActual) => {
  const actual = await importActual<typeof ImportModule>();
  return {
    ...actual,
    createUserMapping: vi.fn(),
    fetchMediaEnrichment: vi.fn(),
    flushInsertBatch: vi.fn(),
    queryExistingByExternalIds: vi.fn(),
  };
});

vi.mock('../mediaServer/jellyfin/client.js', () => ({
  JellyfinClient: class {
    constructor() {
      constructedClients.push('jellyfin');
    }
    getPlaybackReportingInfo(...args: unknown[]) {
      return mockGetPlaybackReportingInfo(...args);
    }
    queryPlaybackReporting(...args: unknown[]) {
      return mockQueryPlaybackReporting(...args);
    }
  },
}));

vi.mock('../mediaServer/emby/client.js', () => ({
  EmbyClient: class {
    constructor() {
      constructedClients.push('emby');
    }
    getPlaybackReportingInfo(...args: unknown[]) {
      return mockGetPlaybackReportingInfo(...args);
    }
    queryPlaybackReporting(...args: unknown[]) {
      return mockQueryPlaybackReporting(...args);
    }
  },
}));

describe('buildSelectColumns', () => {
  it('selects rowid plus the base columns for the 9 Jellyfin columns', () => {
    expect(buildSelectColumns(JF_COLUMNS)).toEqual(['rowid', ...BASE_COLUMNS]);
  });

  it("includes PauseDuration and RemoteAddress for Emby's 12 columns", () => {
    const result = buildSelectColumns(EMBY_COLUMNS);
    expect(result).toContain('PauseDuration');
    expect(result).toContain('RemoteAddress');
    expect(result).toEqual(['rowid', ...BASE_COLUMNS, 'PauseDuration', 'RemoteAddress']);
  });

  it('throws naming the missing column when PlayDuration is absent', () => {
    const missingPlayDuration = BASE_COLUMNS.filter((c) => c !== 'PlayDuration');
    expect(() => buildSelectColumns(missingPlayDuration)).toThrow(/PlayDuration/);
  });
});

describe('parsePlaybackReportingRows', () => {
  const selectColumns = buildSelectColumns(JF_COLUMNS);

  it('maps a raw row positionally by the select column order', () => {
    const results = [
      [
        '7',
        '2026-01-10 20:00:00',
        'abc123',
        'item9',
        'Movie',
        'Heat',
        'DirectPlay',
        'Jellyfin Web',
        'Chrome',
        '3600',
      ],
    ];

    const rows = parsePlaybackReportingRows(selectColumns, results);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      rowid: 7,
      dateCreated: '2026-01-10 20:00:00',
      userId: 'abc123',
      itemId: 'item9',
      itemType: 'Movie',
      itemName: 'Heat',
      playbackMethod: 'DirectPlay',
      clientName: 'Jellyfin Web',
      deviceName: 'Chrome',
      playDurationSec: 3600,
      pauseDurationSec: 0,
      remoteAddress: null,
    });
  });

  it('clamps a negative PlayDuration string to 0', () => {
    const results = [
      [
        '7',
        '2026-01-10 20:00:00',
        'abc123',
        'item9',
        'Movie',
        'Heat',
        'DirectPlay',
        'Jellyfin Web',
        'Chrome',
        '-5',
      ],
    ];

    const rows = parsePlaybackReportingRows(selectColumns, results);

    expect(rows[0]?.playDurationSec).toBe(0);
  });
});

describe('parseEpisodeItemName', () => {
  it('parses a series - sNNeNN - title formatted name', () => {
    expect(parseEpisodeItemName('Severance - s02e03 - Who Is Alive?')).toEqual({
      series: 'Severance',
      season: 2,
      episode: 3,
      title: 'Who Is Alive?',
    });
  });

  it('returns null for a plain movie title', () => {
    expect(parseEpisodeItemName('Heat')).toBeNull();
  });
});

describe('transformPlaybackReportingRow', () => {
  const mockGeo = {
    city: 'Jersey City',
    region: 'New Jersey',
    country: 'US',
    countryCode: 'US',
    continent: 'North America',
    postal: '07302',
    lat: 40.7282,
    lon: -74.0776,
    asnNumber: 7922,
    asnOrganization: 'Comcast Cable Communications, LLC',
  };

  function makeCtx(overrides: Partial<TransformContext> = {}): TransformContext {
    return {
      serverId: 'server-1',
      serverType: 'jellyfin',
      serverUserId: 'server-user-1',
      timezone: 'America/New_York',
      geo: mockGeo,
      thresholds: { movie: 0.9, episode: 0.9, track: 0.9 },
      ...overrides,
    };
  }

  function makeRow(overrides: Partial<PlaybackReportingRow> = {}): PlaybackReportingRow {
    return {
      rowid: 7,
      dateCreated: '2026-01-10 20:00:00',
      userId: 'user-1',
      itemId: 'item9',
      itemType: 'Movie',
      itemName: 'Heat',
      playbackMethod: 'DirectPlay',
      clientName: 'Jellyfin Web',
      deviceName: 'Chrome',
      playDurationSec: 3600,
      pauseDurationSec: 0,
      remoteAddress: null,
      ...overrides,
    };
  }

  it('transforms a Jellyfin movie row with no enrichment', () => {
    const session = transformPlaybackReportingRow(makeRow(), makeCtx());

    expect(session.startedAt?.toISOString()).toBe('2026-01-11T01:00:00.000Z');
    expect(session.stoppedAt?.toISOString()).toBe('2026-01-11T02:00:00.000Z');
    expect(session.durationMs).toBe(3_600_000);
    expect(session.pausedDurationMs).toBe(0);
    expect(session.state).toBe('stopped');
    expect(session.sessionKey).toBe('pr-7');
    expect(session.externalSessionId).toBe('pr-7');
    expect(session.ratingKey).toBe('item9');
    expect(session.mediaType).toBe('movie');
    expect(session.ipAddress).toBe('0.0.0.0');
    expect(session.watched).toBe(false);
    expect(session.progressMs).toBe(3_600_000);
    expect(session.totalDurationMs).toBeNull();
    expect(session.shortSession).toBe(false);
    expect(session.isTranscode).toBe(false);
    expect(session.videoDecision).toBe('directplay');
    expect(session.quality).toBe('Direct');
  });

  it('marks watched true and fills totalDurationMs/year from enrichment', () => {
    const ctx = makeCtx({
      thresholds: { movie: 0.85, episode: 0.85, track: 0.85 },
      enrichment: { runtimeMs: 4_000_000, year: 1995 },
    });

    const session = transformPlaybackReportingRow(makeRow(), ctx);

    expect(session.totalDurationMs).toBe(4_000_000);
    expect(session.watched).toBe(true);
    expect(session.progressMs).toBe(3_600_000);
    expect(session.year).toBe(1995);
  });

  it('reads the IP and pause duration from an Emby row, and stamps geo from ctx', () => {
    const ctx = makeCtx({ serverType: 'emby' });
    const row = makeRow({ remoteAddress: '203.0.113.9', pauseDurationSec: 120 });

    const session = transformPlaybackReportingRow(row, ctx);

    expect(session.ipAddress).toBe('203.0.113.9');
    expect(session.pausedDurationMs).toBe(120_000);
    expect(session.geoCountry).toBe('US');
  });

  it('parses episode metadata from the item name when there is no enrichment or identity', () => {
    const row = makeRow({
      itemId: 'ep3',
      itemType: 'Episode',
      itemName: 'Severance - s02e03 - Who Is Alive?',
    });

    const session = transformPlaybackReportingRow(row, makeCtx());

    expect(session.mediaType).toBe('episode');
    expect(session.grandparentTitle).toBe('Severance');
    expect(session.seasonNumber).toBe(2);
    expect(session.episodeNumber).toBe(3);
    expect(session.mediaTitle).toBe('Who Is Alive?');
  });

  it('detects transcode from the PlaybackMethod string', () => {
    const row = makeRow({ playbackMethod: 'Transcode (v:h264 a:aac)' });

    const session = transformPlaybackReportingRow(row, makeCtx());

    expect(session.isTranscode).toBe(true);
    expect(session.quality).toBe('Transcode');
  });

  it('marks shortSession true for a 60 second play duration', () => {
    const row = makeRow({ playDurationSec: 60 });

    const session = transformPlaybackReportingRow(row, makeCtx());

    expect(session.shortSession).toBe(true);
  });
});

describe('importPlaybackReporting', () => {
  const SERVER_ID = 'server-uuid-1234';
  const KNOWN_USER_ID = 'a91468af8ed947e0add77f191736dab5';
  const SERVER_USER_ID = 'server-user-uuid-1';
  const PAGE_SIZE = 5000;

  // Later than every row date the existing tests use, so the cutoff itself
  // never interferes unless a test sets it explicitly.
  const SERVER_CREATED_AT = new Date('2030-01-01T00:00:00Z');

  const JF_SERVER = {
    id: SERVER_ID,
    name: 'Test Jellyfin Server',
    type: 'jellyfin',
    url: 'http://jellyfin.local:8096',
    token: 'test-token',
    createdAt: SERVER_CREATED_AT,
  };

  const EMBY_SERVER = {
    id: SERVER_ID,
    name: 'Test Emby Server',
    type: 'emby',
    url: 'http://emby.local:8096',
    token: 'test-token',
    createdAt: SERVER_CREATED_AT,
  };

  function pluginInfo(totalRecords: number) {
    return {
      installed: true,
      columns: [...BASE_COLUMNS],
      totalRecords,
      oldestDate: '2023-01-01 00:00:00',
      newestDate: '2025-12-31 00:00:00',
    };
  }

  function pluginRow(
    rowid: number,
    dateCreated: string,
    userId: string = KNOWN_USER_ID,
    playDuration = '3600'
  ): string[] {
    return [
      String(rowid),
      dateCreated,
      userId,
      `item-${rowid}`,
      'Movie',
      `Movie ${rowid}`,
      'DirectPlay',
      'Jellyfin Web',
      'Chrome',
      playDuration,
    ];
  }

  function fullPage(): string[][] {
    return Array.from({ length: PAGE_SIZE }, (_, i) => pluginRow(i + 1, '2023-05-01 20:00:00'));
  }

  let whereConditions: SQL[];

  function mockDbSelects(...resultSets: Record<string, unknown>[][]): void {
    let call = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const rows = resultSets[call++] ?? [];
      const where = vi.fn((condition: SQL) => {
        whereConditions.push(condition);
        return Object.assign(Promise.resolve(rows), { limit: vi.fn().mockResolvedValue(rows) });
      });
      return { from: vi.fn(() => ({ where })) };
    });
  }

  const defaultOptions = { timezone: 'UTC', enrichMedia: false, importFullRange: false };

  beforeEach(() => {
    vi.clearAllMocks();
    whereConditions = [];
    constructedClients = [];

    mockGetPlaybackReportingInfo = vi.fn().mockResolvedValue(pluginInfo(2));
    mockQueryPlaybackReporting = vi.fn().mockResolvedValue([]);

    vi.mocked(createUserMapping).mockResolvedValue(new Map([[KNOWN_USER_ID, SERVER_USER_ID]]));
    vi.mocked(queryExistingByExternalIds).mockResolvedValue(new Map());
    vi.mocked(fetchMediaEnrichment).mockResolvedValue(new Map());
    vi.mocked(flushInsertBatch).mockResolvedValue(0);
    vi.mocked(batchGetLibraryItemIdentity).mockResolvedValue(new Map());

    mockDbSelects([JF_SERVER], [{ min: new Date('2026-01-01T00:00:00Z') }]);
  });

  it('fails with a plugin-not-installed message and inserts nothing', async () => {
    mockGetPlaybackReportingInfo = vi.fn().mockResolvedValue({ installed: false });

    const result = await importPlaybackReporting(SERVER_ID, defaultOptions);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/plugin is not installed/i);
    expect(result.imported).toBe(0);
    expect(mockQueryPlaybackReporting).not.toHaveBeenCalled();
    expect(flushInsertBatch).not.toHaveBeenCalled();
    expect(refreshAggregates).not.toHaveBeenCalled();
  });

  it('imports a single page of rows, enriching and stamping the pr- namespace', async () => {
    mockQueryPlaybackReporting = vi
      .fn()
      .mockResolvedValueOnce([
        pluginRow(1, '2023-05-01 20:00:00'),
        pluginRow(2, '2023-05-02 20:00:00'),
      ])
      .mockResolvedValue([]);
    vi.mocked(fetchMediaEnrichment).mockResolvedValue(new Map([['item-1', { year: 1999 }]]));

    const publish = vi.fn().mockResolvedValue(undefined);
    const pubSubService = {
      publish,
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    } as unknown as PubSubService;

    const result = await importPlaybackReporting(
      SERVER_ID,
      { ...defaultOptions, enrichMedia: true },
      pubSubService
    );

    expect(result.success).toBe(true);
    expect(result.imported).toBe(2);
    expect(result.duplicates).toBe(0);
    expect(result.overlap).toBe(0);
    expect(result.enriched).toBe(1);
    expect(result.message).toContain('2 imported');

    expect(fetchMediaEnrichment).toHaveBeenCalledWith(expect.anything(), ['item-1', 'item-2']);
    expect(batchGetLibraryItemIdentity).toHaveBeenCalledWith(SERVER_ID, ['item-1', 'item-2']);

    expect(flushInsertBatch).toHaveBeenCalledTimes(1);
    const [batch, batchOptions] = vi.mocked(flushInsertBatch).mock.calls[0]!;
    expect(batch).toHaveLength(2);
    expect(batch[0]?.externalSessionId).toBe('pr-1');
    expect(batch[0]?.sessionKey).toBe('pr-1');
    expect(batch[0]?.serverUserId).toBe(SERVER_USER_ID);
    expect(batch[0]?.ratingKey).toBe('item-1');
    expect(batch[0]?.year).toBe(1999);
    expect(batch[0]?.startedAt?.toISOString()).toBe('2023-05-01T20:00:00.000Z');
    expect(batch[1]?.externalSessionId).toBe('pr-2');
    expect(batchOptions).toEqual({ chunkSize: 500 });

    expect(
      publish.mock.calls.every(([channel]) => channel === 'import:playbackreporting:progress')
    ).toBe(true);
    const lastProgress = publish.mock.calls.at(-1)?.[1] as {
      status: string;
      importedRecords: number;
    };
    expect(lastProgress.status).toBe('complete');
    expect(lastProgress.importedRecords).toBe(2);

    expect(refreshAggregates).toHaveBeenCalledWith({
      startTime: new Date('2023-04-30T20:00:00.000Z'),
      endTime: new Date('2023-05-03T20:00:00.000Z'),
    });
  });

  it('skips rows already present under either the pr- or raw rowid namespace', async () => {
    mockQueryPlaybackReporting = vi
      .fn()
      .mockResolvedValueOnce([
        pluginRow(1, '2023-05-01 20:00:00'),
        pluginRow(2, '2023-05-02 20:00:00'),
      ])
      .mockResolvedValue([]);
    vi.mocked(queryExistingByExternalIds).mockResolvedValue(
      new Map([
        ['pr-1', { id: 'existing-1' }],
        ['2', { id: 'existing-2' }],
      ]) as unknown as Awaited<ReturnType<typeof queryExistingByExternalIds>>
    );

    const result = await importPlaybackReporting(SERVER_ID, defaultOptions);

    expect(result.success).toBe(true);
    expect(result.duplicates).toBe(2);
    expect(result.imported).toBe(0);
    expect(flushInsertBatch).not.toHaveBeenCalled();

    const [lookupServerId, ids, timeBounds] = vi.mocked(queryExistingByExternalIds).mock.calls[0]!;
    expect(lookupServerId).toBe(SERVER_ID);
    expect(ids).toHaveLength(4);
    expect(ids).toEqual(expect.arrayContaining(['pr-1', '1', 'pr-2', '2']));
    expect(timeBounds?.minTime.toISOString()).toBe('2023-05-01T19:00:00.000Z');
    expect(timeBounds?.maxTime.toISOString()).toBe('2023-05-02T20:00:00.000Z');

    expect(refreshAggregates).toHaveBeenCalledWith();
  });

  it('skips rows newer than the tracked-history watermark', async () => {
    mockDbSelects([JF_SERVER], [{ min: new Date('2024-01-01T00:00:00Z') }]);
    mockQueryPlaybackReporting = vi
      .fn()
      .mockResolvedValueOnce([
        pluginRow(1, '2023-05-01 20:00:00'),
        pluginRow(2, '2025-05-01 20:00:00'),
      ])
      .mockResolvedValue([]);

    const result = await importPlaybackReporting(SERVER_ID, defaultOptions);

    expect(result.imported).toBe(1);
    expect(result.overlap).toBe(1);
    expect(result.message).toContain('1 overlapping tracked history');

    const [batch] = vi.mocked(flushInsertBatch).mock.calls[0]!;
    expect(batch).toHaveLength(1);
    expect(batch[0]?.externalSessionId).toBe('pr-1');
  });

  it('scopes the watermark to the server and excludes both import namespaces', async () => {
    mockDbSelects([JF_SERVER], [{ min: new Date('2024-01-01T00:00:00Z') }]);

    await importPlaybackReporting(SERVER_ID, defaultOptions);

    expect(whereConditions).toHaveLength(2);
    const watermarkQuery = new PgDialect().sqlToQuery(whereConditions[1]!);
    expect(watermarkQuery.sql).toContain('"sessions"."server_id" = $1');
    expect(watermarkQuery.sql).toContain('"sessions"."external_session_id" IS NULL');
    expect(watermarkQuery.sql).toContain(`"sessions"."external_session_id" !~ '^(pr-)?[0-9]+$'`);
    expect(watermarkQuery.params).toEqual([SERVER_ID]);
  });

  it('imports the full range without querying the watermark when importFullRange is set', async () => {
    mockDbSelects([JF_SERVER], [{ min: new Date('2024-01-01T00:00:00Z') }]);
    mockQueryPlaybackReporting = vi
      .fn()
      .mockResolvedValueOnce([
        pluginRow(1, '2023-05-01 20:00:00'),
        pluginRow(2, '2025-05-01 20:00:00'),
      ])
      .mockResolvedValue([]);

    const result = await importPlaybackReporting(SERVER_ID, {
      ...defaultOptions,
      importFullRange: true,
    });

    expect(result.imported).toBe(2);
    expect(result.overlap).toBe(0);
    expect((db.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('still skips rows at or after the server cutoff when importFullRange is set', async () => {
    const earlyCutoffServer = { ...JF_SERVER, createdAt: new Date('2023-05-02T00:00:00Z') };
    mockDbSelects([earlyCutoffServer]);
    mockQueryPlaybackReporting = vi
      .fn()
      .mockResolvedValueOnce([
        pluginRow(1, '2023-05-01 20:00:00'),
        pluginRow(2, '2023-05-02 20:00:00'),
      ])
      .mockResolvedValue([]);

    const result = await importPlaybackReporting(SERVER_ID, {
      ...defaultOptions,
      importFullRange: true,
    });

    expect(result.imported).toBe(1);
    expect(result.overlap).toBe(1);
    const [batch] = vi.mocked(flushInsertBatch).mock.calls[0]!;
    expect(batch[0]?.externalSessionId).toBe('pr-1');
  });

  it('uses the earlier of the tracked-history watermark and the server cutoff', async () => {
    const lateCutoffServer = { ...JF_SERVER, createdAt: new Date('2030-01-01T00:00:00Z') };
    mockDbSelects([lateCutoffServer], [{ min: new Date('2023-05-02T00:00:00Z') }]);
    mockQueryPlaybackReporting = vi
      .fn()
      .mockResolvedValueOnce([
        pluginRow(1, '2023-05-01 20:00:00'),
        pluginRow(2, '2023-05-02 20:00:00'),
      ])
      .mockResolvedValue([]);

    const result = await importPlaybackReporting(SERVER_ID, defaultOptions);

    expect(result.imported).toBe(1);
    expect(result.overlap).toBe(1);
    const [batch] = vi.mocked(flushInsertBatch).mock.calls[0]!;
    expect(batch[0]?.externalSessionId).toBe('pr-1');
  });

  it('tracks rows whose user is not in Tracearr as skipped unknown users', async () => {
    vi.mocked(createUserMapping).mockResolvedValue(new Map());
    mockQueryPlaybackReporting = vi
      .fn()
      .mockResolvedValueOnce([
        pluginRow(1, '2023-05-01 20:00:00', 'unknown-user-id'),
        pluginRow(2, '2023-05-02 20:00:00', 'unknown-user-id'),
      ])
      .mockResolvedValue([]);

    const result = await importPlaybackReporting(SERVER_ID, defaultOptions);

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.skippedUsers).toEqual([
      { userId: 'unknown-user-id', username: null, recordCount: 2 },
    ]);
    expect(result.message).toContain('2 unknown user');
  });

  it('pages by rowid cursor, carrying the last rowid of the previous page', async () => {
    const firstPage = fullPage();
    const secondPage = [
      pluginRow(PAGE_SIZE + 1, '2023-05-02 20:00:00'),
      pluginRow(PAGE_SIZE + 2, '2023-05-02 21:00:00'),
    ];
    mockQueryPlaybackReporting = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValue([]);

    const result = await importPlaybackReporting(SERVER_ID, {
      ...defaultOptions,
      importFullRange: true,
    });

    expect(mockQueryPlaybackReporting).toHaveBeenCalledTimes(2);
    const firstSql = mockQueryPlaybackReporting.mock.calls[0]?.[0] as string;
    const secondSql = mockQueryPlaybackReporting.mock.calls[1]?.[0] as string;
    expect(firstSql).toContain('rowid > 0');
    expect(firstSql).toContain(`LIMIT ${PAGE_SIZE}`);
    expect(secondSql).toContain(`rowid > ${PAGE_SIZE}`);
    expect(result.imported).toBe(PAGE_SIZE + 2);
  });

  it('counts a row with an unparseable DateCreated as an error and drops it from the page', async () => {
    mockQueryPlaybackReporting = vi
      .fn()
      .mockResolvedValueOnce([pluginRow(1, 'garbage'), pluginRow(2, '2023-05-02 20:00:00')])
      .mockResolvedValue([]);

    const result = await importPlaybackReporting(SERVER_ID, defaultOptions);

    expect(result.errors).toBe(1);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.message).toContain('1 errors');

    const [, ids, timeBounds] = vi.mocked(queryExistingByExternalIds).mock.calls[0]!;
    expect(ids).toEqual(['pr-2', '2']);
    expect(timeBounds?.minTime.toISOString()).toBe('2023-05-02T19:00:00.000Z');
    expect(timeBounds?.maxTime.toISOString()).toBe('2023-05-02T20:00:00.000Z');

    const [batch] = vi.mocked(flushInsertBatch).mock.calls[0]!;
    expect(batch).toHaveLength(1);
    expect(batch[0]?.externalSessionId).toBe('pr-2');
  });

  it('skips the dedup lookup entirely when every row on a page has a bad DateCreated', async () => {
    mockQueryPlaybackReporting = vi
      .fn()
      .mockResolvedValueOnce([pluginRow(1, 'garbage')])
      .mockResolvedValue([]);

    const result = await importPlaybackReporting(SERVER_ID, defaultOptions);

    expect(result.errors).toBe(1);
    expect(result.imported).toBe(0);
    expect(queryExistingByExternalIds).not.toHaveBeenCalled();
    expect(flushInsertBatch).not.toHaveBeenCalled();
  });

  it('counts enrichment-filtered rows separately from imports', async () => {
    mockQueryPlaybackReporting = vi
      .fn()
      .mockResolvedValueOnce([
        pluginRow(1, '2023-05-01 20:00:00'),
        pluginRow(2, '2023-05-02 20:00:00'),
      ])
      .mockResolvedValue([]);
    vi.mocked(fetchMediaEnrichment).mockResolvedValue(new Map([['item-2', { filtered: true }]]));

    const result = await importPlaybackReporting(SERVER_ID, {
      ...defaultOptions,
      enrichMedia: true,
    });

    expect(result.imported).toBe(1);
    expect(result.filtered).toBe(1);
    expect(result.message).toContain('1 filtered');
  });

  it('refuses a row past the runtime plus 60 s and keeps one exactly on it', async () => {
    mockQueryPlaybackReporting = vi
      .fn()
      .mockResolvedValueOnce([
        pluginRow(1, '2023-05-01 20:00:00', KNOWN_USER_ID, '5461'),
        pluginRow(2, '2023-05-02 20:00:00', KNOWN_USER_ID, '5460'),
      ])
      .mockResolvedValue([]);
    vi.mocked(fetchMediaEnrichment).mockResolvedValue(
      new Map([
        ['item-1', { runtimeMs: 5_400_000 }],
        ['item-2', { runtimeMs: 5_400_000 }],
      ])
    );

    const result = await importPlaybackReporting(SERVER_ID, {
      ...defaultOptions,
      enrichMedia: true,
    });

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.overlong).toBe(1);
    expect(result.message).toContain('1 longer than the media runtime');
    expect(vi.mocked(flushInsertBatch).mock.calls[0]?.[0]).toHaveLength(1);
  });

  it('returns a failed result with partial counters when a later page fetch throws', async () => {
    mockGetPlaybackReportingInfo = vi.fn().mockResolvedValue(pluginInfo(PAGE_SIZE + 2));
    mockQueryPlaybackReporting = vi
      .fn()
      .mockResolvedValueOnce(fullPage())
      .mockRejectedValue(new Error('plugin exploded'));

    const result = await importPlaybackReporting(SERVER_ID, {
      ...defaultOptions,
      importFullRange: true,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('plugin exploded');
    expect(result.imported).toBe(PAGE_SIZE);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(flushInsertBatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(flushInsertBatch).mock.calls[0]?.[0]).toHaveLength(PAGE_SIZE);
  });

  it('imports an Emby row through the EmbyClient with pause duration and IP mapped', async () => {
    mockDbSelects([EMBY_SERVER], [{ min: new Date('2026-01-01T00:00:00Z') }]);
    mockGetPlaybackReportingInfo = vi.fn().mockResolvedValue({
      installed: true,
      columns: EMBY_COLUMNS,
      totalRecords: 1,
      oldestDate: '2023-05-01 20:00:00',
      newestDate: '2023-05-01 20:00:00',
    });
    mockQueryPlaybackReporting = vi
      .fn()
      .mockResolvedValueOnce([
        [
          '1',
          '2023-05-01 20:00:00',
          KNOWN_USER_ID,
          'item-1',
          'Movie',
          'Movie 1',
          'Transcode',
          'Emby Web',
          'Chrome',
          '3600',
          '45',
          '203.0.113.5',
        ],
      ])
      .mockResolvedValue([]);

    const result = await importPlaybackReporting(SERVER_ID, defaultOptions);

    expect(result.success).toBe(true);
    expect(result.imported).toBe(1);
    expect(constructedClients).toEqual(['emby']);

    const sql = mockQueryPlaybackReporting.mock.calls[0]?.[0] as string;
    expect(sql).toContain('PauseDuration');
    expect(sql).toContain('RemoteAddress');
    expect(sql).not.toContain('TranscodeReasons');

    const [batch] = vi.mocked(flushInsertBatch).mock.calls[0]!;
    expect(batch).toHaveLength(1);
    expect(batch[0]?.pausedDurationMs).toBe(45000);
    expect(batch[0]?.ipAddress).toBe('203.0.113.5');
  });
});
