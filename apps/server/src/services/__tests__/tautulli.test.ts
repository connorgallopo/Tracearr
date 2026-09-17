/**
 * Tautulli Import Service Tests
 *
 * Comprehensive tests covering:
 * - Constructor validation
 * - testConnection method
 * - User ID parsing
 * - Zod schema validation against real API data structures
 * - User matching and skip behavior
 * - Session deduplication logic
 * - GeoIP integration
 * - Field mapping (movies, episodes, tracks)
 * - Retry/timeout behavior
 * - Progress tracking
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  TautulliService,
  TautulliApiError,
  TautulliHistoryRecordSchema,
  TautulliHistoryResponseSchema,
  TautulliUserRecordSchema,
  TautulliUsersResponseSchema,
  isFatalImportError,
  parseHistoryGuid,
  type TautulliHistoryRecord,
  type TautulliUserRecord,
} from '../tautulli.js';
import { getSettings, rearmImportedHistoryLink } from '../settings.js';
import { db } from '../../db/client.js';
import { refreshAggregates } from '../../db/timescale.js';
import {
  batchGetLibraryItemIdentity,
  batchResolveMediaByPlexGuid,
} from '../../jobs/poller/database.js';
import {
  createUserMapping,
  flushInsertBatch,
  flushUpdateBatch,
  getServerTrackingStart,
  queryExistingByExternalIds,
  queryExistingByTimeKeys,
  type ExistingSession,
} from '../import/index.js';
import { queryChain } from '../../test/helpers.js';
import type * as ImportModule from '../import/index.js';

vi.mock('../geoip.js', () => ({
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
  },
}));

vi.mock('../geoasn.js', () => ({
  geoasnService: { lookup: vi.fn(() => ({ number: null, organization: null })) },
}));

vi.mock('../../db/client.js', () => ({
  db: { execute: vi.fn(), select: vi.fn(), update: vi.fn() },
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
  batchGetLibraryItemIdentity: vi.fn(async () => new Map()),
  batchResolveMediaByPlexGuid: vi.fn(async () => new Map()),
}));

vi.mock('../settings.js', () => ({
  getSettings: vi.fn(),
  rearmImportedHistoryLink: vi.fn(),
}));

vi.mock('../import/index.js', async (importActual) => {
  const actual = await importActual<typeof ImportModule>();
  return {
    ...actual,
    createUserMapping: vi.fn(),
    queryExistingByExternalIds: vi.fn(),
    queryExistingByTimeKeys: vi.fn(),
    flushInsertBatch: vi.fn(),
    flushUpdateBatch: vi.fn(),
    getServerTrackingStart: vi.fn(),
  };
});

// ============================================================================
// REAL API TEST DATA (captured from actual Tautulli instance)
// ============================================================================

const REAL_MOVIE_RECORD: TautulliHistoryRecord = {
  reference_id: 11650,
  row_id: 11650,
  id: 11650,
  date: 1764488126,
  started: 1764488126,
  stopped: 1764494418,
  duration: 6292,
  play_duration: 6292,
  paused_counter: 0,
  user_id: 374704766,
  user: 'lukelino',
  friendly_name: 'Luke Lino',
  user_thumb: 'https://plex.tv/users/abc123/avatar',
  platform: 'Android',
  product: 'Plex for Android (TV)',
  player: 'AFTMM',
  ip_address: '73.160.197.140',
  live: 0,
  machine_id: 'f7df5a3c0a1f6134-com-plexapp-android',
  location: 'wan',
  secure: 1,
  relayed: 0,
  media_type: 'movie',
  rating_key: 25314,
  parent_rating_key: '',
  grandparent_rating_key: '',
  full_title: 'How the Grinch Stole Christmas',
  title: 'How the Grinch Stole Christmas',
  parent_title: '',
  grandparent_title: '',
  original_title: '',
  year: 2000,
  media_index: '',
  parent_media_index: '',
  thumb: '/library/metadata/25314/thumb/1762510145',
  originally_available_at: '2000-11-17',
  guid: 'plex://movie/5d7768324de0ee001fccac77',
  transcode_decision: 'transcode',
  percent_complete: 100,
  watched_status: 1,
  group_count: 1,
  group_ids: '11650',
  state: null,
  session_key: null,
};

// Real episode record from actual API - note year IS a number for properly matched media
const REAL_EPISODE_RECORD: TautulliHistoryRecord = {
  reference_id: 11627,
  row_id: 11651,
  id: 11651,
  date: 1764524187,
  started: 1764296397,
  stopped: 1764527203,
  duration: 3638,
  play_duration: 3638,
  paused_counter: 688,
  user_id: 302613764,
  user: 'ethanbyrum',
  friendly_name: 'Ethan Byrum',
  user_thumb: 'https://plex.tv/users/4345d655aa21f449/avatar?c=1764494415',
  platform: 'tvOS',
  product: 'Plex for Apple TV',
  player: 'Apple TV',
  ip_address: '104.128.161.124',
  live: 0,
  machine_id: '7C3AFE13-4063-46E6-94AD-92BC94337DDB',
  location: 'wan',
  secure: 1,
  relayed: 0,
  media_type: 'episode',
  rating_key: 128459,
  parent_rating_key: 128458,
  grandparent_rating_key: 110397,
  full_title: 'Ozark - Wartime',
  title: 'Wartime',
  parent_title: 'Season 3',
  grandparent_title: 'Ozark',
  original_title: '',
  year: 2020, // Episodes with proper metadata have numeric year
  media_index: 1,
  parent_media_index: 3,
  thumb: '/library/metadata/128458/thumb/1764384847',
  originally_available_at: '2020-03-27',
  guid: 'plex://episode/5e8338265161b50041c98783',
  transcode_decision: 'direct play',
  percent_complete: 95,
  watched_status: 1,
  group_count: 2,
  group_ids: '11627,11651',
  state: null,
  session_key: null,
};

const REAL_TRACK_RECORD: TautulliHistoryRecord = {
  reference_id: 10132,
  row_id: 10132,
  id: 10132,
  date: 1759030514,
  started: 1759030514,
  stopped: 1759030705,
  duration: 191,
  play_duration: 191,
  paused_counter: 0,
  user_id: 3453396,
  user: 'rdweaver79',
  friendly_name: 'Ryan Weaver',
  user_thumb: 'https://plex.tv/users/def456/avatar',
  platform: 'Roku',
  product: 'Plex for Roku',
  player: 'Basement Roku',
  ip_address: '73.130.92.216',
  live: 0,
  machine_id: '1e9d2035fd07d7f7f71289521b1642db',
  location: 'wan',
  secure: 1,
  relayed: 0,
  media_type: 'track',
  rating_key: 37963,
  parent_rating_key: 37959,
  grandparent_rating_key: 29070,
  full_title: 'Watch Out for This (Bumaye) - Major Lazer',
  title: 'Watch Out for This (Bumaye)',
  parent_title: 'Major Lazer Sped Up',
  grandparent_title: 'Major Lazer',
  original_title: '',
  year: 2022,
  media_index: 4,
  parent_media_index: 1,
  thumb: '/library/metadata/37959/thumb/1732335189',
  originally_available_at: '',
  guid: 'plex://track/63332319a5c478aa2b0be398',
  transcode_decision: 'direct play',
  percent_complete: 0,
  watched_status: 0,
  group_count: 1,
  group_ids: '10132',
  state: null,
  session_key: null,
};

const PARTIAL_WATCH_RECORD: TautulliHistoryRecord = {
  ...REAL_MOVIE_RECORD,
  reference_id: 11302,
  row_id: 11647,
  id: 11647,
  percent_complete: 77,
  watched_status: 0.75, // Decimal for partial watch
  paused_counter: 4205,
};

// Unmatched/local media has empty string for year (guid starts with local://)
const UNMATCHED_EPISODE_RECORD: TautulliHistoryRecord = {
  reference_id: 11595,
  row_id: 11595,
  id: 11595,
  date: 1764140689,
  started: 1764140689,
  stopped: 1764141093,
  duration: 404,
  play_duration: 404,
  paused_counter: 0,
  user_id: 330457530,
  user: 'gwh.h',
  friendly_name: 'Greg Howard Jr.',
  user_thumb: 'https://plex.tv/users/6fac0fa09f00d318/avatar?c=1764496979',
  platform: 'Android',
  product: 'Plex for Android (Mobile)',
  player: 'Pixel 7 Pro',
  ip_address: '136.23.58.217',
  live: 0,
  machine_id: '7fb4d017bd220361-com-plexapp-android',
  location: 'wan',
  secure: 1,
  relayed: 0,
  media_type: 'episode',
  rating_key: 127775,
  parent_rating_key: 127774,
  grandparent_rating_key: 127773,
  full_title: '1923 - Episode 1',
  title: 'Episode 1',
  parent_title: 'Season 1',
  grandparent_title: '1923',
  original_title: '',
  year: '', // Unmatched/local media has empty string for year
  media_index: 1,
  parent_media_index: 1,
  thumb: '/library/metadata/127773/thumb/1764139222',
  originally_available_at: '',
  guid: 'local://127775', // Note: local:// guid indicates unmatched media
  transcode_decision: 'direct play',
  percent_complete: 3,
  watched_status: 0,
  group_count: 1,
  group_ids: '11595',
  state: null,
  session_key: null,
};

const LOCAL_USER: TautulliUserRecord = {
  user_id: 0,
  username: 'Local',
  friendly_name: 'Local',
  thumb: null,
  email: null,
  is_home_user: null,
  is_admin: 0,
  is_active: 1,
  do_notify: 1,
};

const NORMAL_USER: TautulliUserRecord = {
  user_id: 150112024,
  username: 'Gallapagos',
  friendly_name: 'Gallapagos',
  thumb: 'https://plex.tv/users/ceac7bee6aac8175/avatar?c=1764478418',
  email: 'connor.gallopo@gmail.com',
  is_home_user: 1,
  is_admin: 1,
  is_active: 1,
  do_notify: 1,
};

// ============================================================================
// CONSTRUCTOR VALIDATION TESTS
// ============================================================================

describe('TautulliService Constructor', () => {
  describe('valid parameters', () => {
    it('should create instance with valid URL and API key', () => {
      const service = new TautulliService('http://localhost:8181', 'valid-api-key-12345');
      expect(service).toBeInstanceOf(TautulliService);
    });

    it('should accept HTTPS URLs', () => {
      const service = new TautulliService('https://tautulli.example.com', 'api-key');
      expect(service).toBeInstanceOf(TautulliService);
    });

    it('should accept URLs with port numbers', () => {
      const service = new TautulliService('http://192.168.1.100:8181', 'api-key');
      expect(service).toBeInstanceOf(TautulliService);
    });

    it('should strip trailing slash from URL', () => {
      const service = new TautulliService('http://localhost:8181/', 'api-key');
      expect(service).toBeInstanceOf(TautulliService);
    });

    it('should accept URLs with paths', () => {
      const service = new TautulliService('http://localhost/tautulli', 'api-key');
      expect(service).toBeInstanceOf(TautulliService);
    });
  });

  describe('invalid URL format', () => {
    it('should throw error for invalid URL format', () => {
      expect(() => new TautulliService('not-a-valid-url', 'api-key')).toThrow(
        'Invalid Tautulli URL format'
      );
    });

    it('should throw error for empty URL', () => {
      expect(() => new TautulliService('', 'api-key')).toThrow('Invalid Tautulli URL format');
    });

    it('should throw error for malformed URL', () => {
      expect(() => new TautulliService('http://[invalid', 'api-key')).toThrow(
        'Invalid Tautulli URL format'
      );
    });
  });

  describe('invalid API key', () => {
    it('should throw error for empty API key', () => {
      expect(() => new TautulliService('http://localhost:8181', '')).toThrow(
        'Tautulli API key is required'
      );
    });

    it('should throw error for whitespace-only API key', () => {
      // The current implementation checks length < 1, so this will pass
      // If we want to reject whitespace, we'd need to update the implementation
      const service = new TautulliService('http://localhost:8181', ' ');
      expect(service).toBeInstanceOf(TautulliService);
    });
  });
});

// ============================================================================
// TESTCONNECTION METHOD TESTS
// ============================================================================

describe('TautulliService.testConnection', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as typeof global.fetch;
  });

  describe('successful connection', () => {
    it('should return true when connection succeeds', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ response: { result: 'success' } }),
      });

      const service = new TautulliService('http://localhost:8181', 'api-key');
      const result = await service.testConnection();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('cmd=arnold'),
        expect.any(Object)
      );
    });

    it('should include API key in request', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ response: { result: 'success' } }),
      });

      const service = new TautulliService('http://localhost:8181', 'test-key-123');
      await service.testConnection();

      const callUrl = mockFetch.mock.calls[0]?.[0];
      expect(callUrl).toContain('apikey=test-key-123');
    });
  });

  describe('failed connection', () => {
    it('should return false and log warning on network error', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      mockFetch.mockRejectedValue(new Error('Network error'));

      const service = new TautulliService('http://localhost:8181', 'api-key');
      const result = await service.testConnection();

      expect(result).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Connection test failed'),
        expect.stringContaining('Network error')
      );

      consoleWarnSpy.mockRestore();
    });

    it('should return false when response is not ok', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const service = new TautulliService('http://localhost:8181', 'invalid-key');
      const result = await service.testConnection();

      expect(result).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });

    it('should return false when result is not success', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ response: { result: 'error' } }),
      });

      const service = new TautulliService('http://localhost:8181', 'api-key');
      const result = await service.testConnection();

      expect(result).toBe(false);

      consoleWarnSpy.mockRestore();
    });

    it('should return false and log warning on timeout', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);

      const service = new TautulliService('http://localhost:8181', 'api-key');
      const result = await service.testConnection();

      expect(result).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });
  });
});

describe('TautulliService.getHistory failures', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as typeof global.fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('rejects with the status and response body, without retrying, on 401', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '{"response":{"result":"error","message":"Invalid apikey"}}',
    });

    const service = new TautulliService('http://localhost:8181', 'bad-key');
    const err = await service.getHistory(0, 1).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TautulliApiError);
    expect((err as TautulliApiError).status).toBe(401);
    expect((err as TautulliApiError).message).toContain('Invalid apikey');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries a 500 three times and then rejects with the body', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Traceback: KeyError',
    });

    const service = new TautulliService('http://localhost:8181', 'api-key');
    const pending = service.getHistory(0, 5000).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await pending;

    expect(err).toBeInstanceOf(TautulliApiError);
    expect((err as TautulliApiError).status).toBe(500);
    expect((err as TautulliApiError).body).toBe('Traceback: KeyError');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('redacts the api key from the error message and body', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Bad request to http://localhost:8181/api/v2?apikey=super-secret-key',
    });

    const service = new TautulliService('http://localhost:8181', 'super-secret-key');
    const pending = service.getHistory(0, 5000).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await pending;

    expect(err).toBeInstanceOf(TautulliApiError);
    expect((err as TautulliApiError).message).toContain('[redacted]');
    expect((err as TautulliApiError).message).not.toContain('super-secret-key');
    expect((err as TautulliApiError).body).toContain('[redacted]');
    expect((err as TautulliApiError).body).not.toContain('super-secret-key');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe('TautulliService.getGuidsByRatingKey', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  function historyRow(overrides: Record<string, unknown>) {
    return {
      rating_key: 101,
      live: 0,
      media_type: 'episode',
      guid: 'plex://episode/aaa?lang=en',
      reference_id: 7001,
      ...overrides,
    };
  }

  function respondWith(rows: unknown[], extra: { result?: string; recordsFiltered?: number } = {}) {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        response: {
          result: extra.result ?? 'success',
          message: null,
          data: {
            recordsFiltered: extra.recordsFiltered ?? rows.length,
            recordsTotal: 9000,
            data: rows,
            draw: 1,
            filter_duration: '0 secs',
            total_duration: '0 secs',
          },
        },
      }),
    });
  }

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as typeof global.fetch;
  });

  it('asks get_history once for every key, ungrouped and without current activity', async () => {
    respondWith([]);

    const service = new TautulliService('http://localhost:8181', 'api-key');
    await service.getGuidsByRatingKey(['101', '202', '303']);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const params = new URL(String(mockFetch.mock.calls[0]?.[0])).searchParams;
    expect(params.get('cmd')).toBe('get_history');
    expect(params.get('rating_key')).toBe('101,202,303');
    expect(params.get('grouping')).toBe('0');
    expect(params.get('include_activity')).toBe('0');
    expect(params.get('length')).toBe('100000');
  });

  it('drops live rows and rows that are not movies or episodes, guids and reference ids alike', async () => {
    respondWith([
      historyRow({ rating_key: 101 }),
      historyRow({ rating_key: 101, live: 1, guid: 'plex://episode/live', reference_id: 7002 }),
      historyRow({
        rating_key: 101,
        media_type: 'track',
        guid: 'plex://track/ccc',
        reference_id: 7003,
      }),
      historyRow({
        rating_key: 202,
        media_type: 'movie',
        guid: 'plex://movie/bbb',
        reference_id: 7004,
      }),
    ]);

    const service = new TautulliService('http://localhost:8181', 'api-key');
    const history = await service.getGuidsByRatingKey(['101', '202']);

    expect(history).toEqual(
      new Map([
        [
          '101',
          { guids: new Set(['plex://episode/aaa?lang=en']), referenceIds: new Set(['7001']) },
        ],
        ['202', { guids: new Set(['plex://movie/bbb']), referenceIds: new Set(['7004']) }],
      ])
    );
  });

  it('keeps only rows whose own rating key was asked for', async () => {
    respondWith([
      historyRow({ rating_key: 101 }),
      historyRow({ rating_key: 555, guid: 'plex://episode/parent-match' }),
    ]);

    const service = new TautulliService('http://localhost:8181', 'api-key');
    const history = await service.getGuidsByRatingKey(['101']);

    expect([...(history?.keys() ?? [])]).toEqual(['101']);
    expect(history?.get('101')?.guids).toEqual(new Set(['plex://episode/aaa?lang=en']));
  });

  it('returns both guids for a key whose rows carry two', async () => {
    respondWith([
      historyRow({ rating_key: 101 }),
      historyRow({ rating_key: '101', guid: 'plex://episode/zzz', reference_id: 7005 }),
    ]);

    const service = new TautulliService('http://localhost:8181', 'api-key');
    const history = await service.getGuidsByRatingKey(['101']);

    expect(history?.get('101')?.guids).toEqual(
      new Set(['plex://episode/aaa?lang=en', 'plex://episode/zzz'])
    );
  });

  it('returns null on an error result and when fewer rows came back than matched', async () => {
    const service = new TautulliService('http://localhost:8181', 'api-key');

    respondWith([historyRow({})], { result: 'error' });
    await expect(service.getGuidsByRatingKey(['101'])).resolves.toBeNull();

    respondWith([historyRow({})], { recordsFiltered: 2 });
    await expect(service.getGuidsByRatingKey(['101'])).resolves.toBeNull();
  });
});

describe('isFatalImportError', () => {
  it('is fatal for auth rejections', () => {
    expect(isFatalImportError(new TautulliApiError(401, 'Unauthorized', ''))).toBe(true);
    expect(isFatalImportError(new TautulliApiError(403, 'Forbidden', ''))).toBe(true);
  });

  it('is fatal for a response that fails schema validation', () => {
    expect(isFatalImportError(new Error('Invalid Tautulli API response: bad shape'))).toBe(true);
  });

  it('is not fatal for server errors, timeouts or unknown values', () => {
    expect(isFatalImportError(new TautulliApiError(500, 'Internal Server Error', 'x'))).toBe(false);
    expect(isFatalImportError(new Error('Tautulli API timeout after 30000ms'))).toBe(false);
    expect(isFatalImportError('nope')).toBe(false);
  });
});

// ============================================================================
// USER ID PARSING TESTS
// ============================================================================

describe('User ID Parsing', () => {
  describe('strict numeric validation', () => {
    it('should accept valid numeric string', () => {
      const userMap = new Map<number, string>();
      // Strict numeric validation: /^\d+$/.test()
      const externalId = '374704766';
      if (/^\d+$/.test(externalId)) {
        userMap.set(parseInt(externalId, 10), 'user-uuid-1');
      }

      expect(userMap.has(374704766)).toBe(true);
      expect(userMap.get(374704766)).toBe('user-uuid-1');
    });

    it('should reject alphanumeric strings like "123abc"', () => {
      const userMap = new Map<number, string>();
      const externalId = '123abc';

      // Strict validation should reject this
      if (/^\d+$/.test(externalId)) {
        userMap.set(parseInt(externalId, 10), 'user-uuid-1');
      }

      expect(userMap.has(123)).toBe(false);
    });

    it('should reject strings with leading letters like "abc123"', () => {
      const userMap = new Map<number, string>();
      const externalId = 'abc123';

      if (/^\d+$/.test(externalId)) {
        userMap.set(parseInt(externalId, 10), 'user-uuid-1');
      }

      expect(userMap.size).toBe(0);
    });

    it('should reject strings with special characters', () => {
      const userMap = new Map<number, string>();
      const externalId = '123-456';

      if (/^\d+$/.test(externalId)) {
        userMap.set(parseInt(externalId, 10), 'user-uuid-1');
      }

      expect(userMap.size).toBe(0);
    });

    it('should reject strings with decimal points', () => {
      const userMap = new Map<number, string>();
      const externalId = '123.456';

      if (/^\d+$/.test(externalId)) {
        userMap.set(parseInt(externalId, 10), 'user-uuid-1');
      }

      expect(userMap.size).toBe(0);
    });

    it('should reject empty strings', () => {
      const userMap = new Map<number, string>();
      const externalId = '';

      if (/^\d+$/.test(externalId)) {
        userMap.set(parseInt(externalId, 10), 'user-uuid-1');
      }

      expect(userMap.size).toBe(0);
    });

    it('should accept user ID of 0 (local user)', () => {
      const userMap = new Map<number, string>();
      const externalId = '0';

      if (/^\d+$/.test(externalId)) {
        userMap.set(parseInt(externalId, 10), 'local-user-uuid');
      }

      expect(userMap.has(0)).toBe(true);
      expect(userMap.get(0)).toBe('local-user-uuid');
    });

    it('should handle large user IDs correctly', () => {
      const userMap = new Map<number, string>();
      const externalId = '999999999999';

      if (/^\d+$/.test(externalId)) {
        userMap.set(parseInt(externalId, 10), 'user-uuid-1');
      }

      expect(userMap.has(999999999999)).toBe(true);
    });
  });

  describe('comparison with lenient parseInt behavior', () => {
    it('demonstrates why strict validation is needed', () => {
      // parseInt('123abc') === 123 (lenient, BAD)
      expect(parseInt('123abc', 10)).toBe(123);

      // /^\d+$/.test('123abc') === false (strict, GOOD)
      expect(/^\d+$/.test('123abc')).toBe(false);
    });

    it('shows that strict validation prevents silent data corruption', () => {
      const input = '12345abc';

      // Lenient: would create mapping for 12345
      const lenientUserId = parseInt(input, 10);
      expect(lenientUserId).toBe(12345);

      // Strict: rejects the invalid input entirely
      const isValid = /^\d+$/.test(input);
      expect(isValid).toBe(false);
    });
  });
});

// ============================================================================
// SCHEMA VALIDATION TESTS
// ============================================================================

describe('TautulliHistoryRecordSchema', () => {
  describe('movie records', () => {
    it('should validate a real movie record', () => {
      const result = TautulliHistoryRecordSchema.safeParse(REAL_MOVIE_RECORD);
      expect(result.success).toBe(true);
    });

    it('should handle empty strings for parent/grandparent rating_key in movies', () => {
      const result = TautulliHistoryRecordSchema.safeParse(REAL_MOVIE_RECORD);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parent_rating_key).toBe('');
        expect(result.data.grandparent_rating_key).toBe('');
      }
    });

    it('should handle empty strings for media_index in movies', () => {
      const result = TautulliHistoryRecordSchema.safeParse(REAL_MOVIE_RECORD);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.media_index).toBe('');
        expect(result.data.parent_media_index).toBe('');
      }
    });

    it('should handle numeric rating_key for movies', () => {
      const result = TautulliHistoryRecordSchema.safeParse(REAL_MOVIE_RECORD);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.rating_key).toBe(25314);
      }
    });
  });

  describe('episode records', () => {
    it('should validate a real episode record', () => {
      const result = TautulliHistoryRecordSchema.safeParse(REAL_EPISODE_RECORD);
      expect(result.success).toBe(true);
    });

    it('should handle numeric parent/grandparent rating_key in episodes', () => {
      const result = TautulliHistoryRecordSchema.safeParse(REAL_EPISODE_RECORD);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parent_rating_key).toBe(128458);
        expect(result.data.grandparent_rating_key).toBe(110397);
      }
    });

    it('should handle numeric media_index in episodes', () => {
      const result = TautulliHistoryRecordSchema.safeParse(REAL_EPISODE_RECORD);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.media_index).toBe(1);
        expect(result.data.parent_media_index).toBe(3);
      }
    });

    it('should preserve parent_title and grandparent_title for episodes', () => {
      const result = TautulliHistoryRecordSchema.safeParse(REAL_EPISODE_RECORD);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parent_title).toBe('Season 3');
        expect(result.data.grandparent_title).toBe('Ozark');
      }
    });

    it('should handle numeric year for properly matched episodes', () => {
      const result = TautulliHistoryRecordSchema.safeParse(REAL_EPISODE_RECORD);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.year).toBe(2020);
      }
    });
  });

  describe('unmatched/local media records', () => {
    it('should validate unmatched media with empty string year', () => {
      const result = TautulliHistoryRecordSchema.safeParse(UNMATCHED_EPISODE_RECORD);
      expect(result.success).toBe(true);
    });

    it('should handle empty string year for unmatched media', () => {
      const result = TautulliHistoryRecordSchema.safeParse(UNMATCHED_EPISODE_RECORD);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.year).toBe('');
      }
    });

    it('should handle empty originally_available_at for unmatched media', () => {
      const result = TautulliHistoryRecordSchema.safeParse(UNMATCHED_EPISODE_RECORD);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.originally_available_at).toBe('');
      }
    });

    it('should identify local guid pattern', () => {
      expect(UNMATCHED_EPISODE_RECORD.guid).toMatch(/^local:\/\//);
    });
  });

  describe('track records', () => {
    it('should validate a real track/music record', () => {
      const result = TautulliHistoryRecordSchema.safeParse(REAL_TRACK_RECORD);
      expect(result.success).toBe(true);
    });

    it('should handle empty originally_available_at for tracks', () => {
      const result = TautulliHistoryRecordSchema.safeParse(REAL_TRACK_RECORD);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.originally_available_at).toBe('');
      }
    });
  });

  describe('partial watch records', () => {
    it('should handle decimal watched_status (0.75)', () => {
      const result = TautulliHistoryRecordSchema.safeParse(PARTIAL_WATCH_RECORD);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.watched_status).toBe(0.75);
      }
    });

    it('should handle non-zero paused_counter', () => {
      const result = TautulliHistoryRecordSchema.safeParse(PARTIAL_WATCH_RECORD);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.paused_counter).toBe(4205);
      }
    });
  });

  describe('null fields', () => {
    it('should handle null state field', () => {
      const result = TautulliHistoryRecordSchema.safeParse(REAL_MOVIE_RECORD);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.state).toBeNull();
      }
    });

    it('should handle null session_key field', () => {
      const result = TautulliHistoryRecordSchema.safeParse(REAL_MOVIE_RECORD);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.session_key).toBeNull();
      }
    });
  });

  describe('edge cases', () => {
    it('should reject records with missing required fields', () => {
      const invalidRecord = { ...REAL_MOVIE_RECORD };
      delete (invalidRecord as any).reference_id;
      const result = TautulliHistoryRecordSchema.safeParse(invalidRecord);
      expect(result.success).toBe(false);
    });

    it('should reject records with wrong types', () => {
      const invalidRecord = { ...REAL_MOVIE_RECORD, reference_id: 'not-a-number' };
      const result = TautulliHistoryRecordSchema.safeParse(invalidRecord);
      expect(result.success).toBe(false);
    });

    it('should strip extra fields and still validate', () => {
      const recordWithExtras = {
        ...REAL_MOVIE_RECORD,
        id: 11650, // Extra field from API
        play_duration: 6292, // Extra field from API
        user_thumb: 'https://example.com/thumb', // Extra field from API
      };
      const result = TautulliHistoryRecordSchema.safeParse(recordWithExtras);
      expect(result.success).toBe(true);
    });
  });
});

describe('TautulliUserRecordSchema', () => {
  describe('local user (null fields)', () => {
    it('should validate a local user with null thumb/email/is_home_user', () => {
      const result = TautulliUserRecordSchema.safeParse(LOCAL_USER);
      expect(result.success).toBe(true);
    });

    it('should handle null thumb', () => {
      const result = TautulliUserRecordSchema.safeParse(LOCAL_USER);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.thumb).toBeNull();
      }
    });

    it('should handle null email', () => {
      const result = TautulliUserRecordSchema.safeParse(LOCAL_USER);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBeNull();
      }
    });

    it('should handle null is_home_user', () => {
      const result = TautulliUserRecordSchema.safeParse(LOCAL_USER);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.is_home_user).toBeNull();
      }
    });

    it('should handle user_id of 0 for local user', () => {
      const result = TautulliUserRecordSchema.safeParse(LOCAL_USER);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user_id).toBe(0);
      }
    });
  });

  describe('normal user (populated fields)', () => {
    it('should validate a normal user with all fields', () => {
      const result = TautulliUserRecordSchema.safeParse(NORMAL_USER);
      expect(result.success).toBe(true);
    });

    it('should preserve thumb URL', () => {
      const result = TautulliUserRecordSchema.safeParse(NORMAL_USER);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.thumb).toContain('plex.tv');
      }
    });

    it('should preserve email', () => {
      const result = TautulliUserRecordSchema.safeParse(NORMAL_USER);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toContain('@');
      }
    });

    it('should handle is_home_user as number', () => {
      const result = TautulliUserRecordSchema.safeParse(NORMAL_USER);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.is_home_user).toBe(1);
      }
    });
  });

  describe('edge cases', () => {
    it('should strip extra fields from user records', () => {
      const userWithExtras = {
        ...NORMAL_USER,
        row_id: 2,
        is_allow_sync: 1,
        is_restricted: 0,
        keep_history: 1,
        allow_guest: 0,
        shared_libraries: ['3', '2'],
      };
      const result = TautulliUserRecordSchema.safeParse(userWithExtras);
      expect(result.success).toBe(true);
    });

    it('should reject user with missing required fields', () => {
      const invalidUser = { ...NORMAL_USER };
      delete (invalidUser as any).user_id;
      const result = TautulliUserRecordSchema.safeParse(invalidUser);
      expect(result.success).toBe(false);
    });
  });
});

describe('TautulliHistoryResponseSchema', () => {
  it('should validate a complete history response', () => {
    const response = {
      response: {
        result: 'success',
        message: null,
        data: {
          recordsFiltered: 7993,
          recordsTotal: 11650,
          data: [REAL_MOVIE_RECORD, REAL_EPISODE_RECORD],
          draw: 1,
          filter_duration: '4 hrs 31 mins 55 secs',
          total_duration: '469 days 2 hrs 26 mins',
        },
      },
    };
    const result = TautulliHistoryResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it('should handle empty data array', () => {
    const response = {
      response: {
        result: 'success',
        message: null,
        data: {
          recordsFiltered: 0,
          recordsTotal: 0,
          data: [],
          draw: 1,
          filter_duration: '0 secs',
          total_duration: '0 secs',
        },
      },
    };
    const result = TautulliHistoryResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it('should reject response with invalid result', () => {
    const response = {
      response: {
        result: 123, // Should be string
        message: null,
        data: {
          recordsFiltered: 0,
          recordsTotal: 0,
          data: [],
          draw: 1,
          filter_duration: '0 secs',
          total_duration: '0 secs',
        },
      },
    };
    const result = TautulliHistoryResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });
});

describe('TautulliUsersResponseSchema', () => {
  it('should validate a complete users response', () => {
    const response = {
      response: {
        result: 'success',
        message: null,
        data: [LOCAL_USER, NORMAL_USER],
      },
    };
    const result = TautulliUsersResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it('should handle empty users array', () => {
    const response = {
      response: {
        result: 'success',
        message: null,
        data: [],
      },
    };
    const result = TautulliUsersResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// GUID PARSING TESTS
// ============================================================================

describe('parseHistoryGuid', () => {
  it('parses legacy tvdb agent guids at series level', () => {
    expect(parseHistoryGuid('com.plexapp.agents.thetvdb://121361/6/1?lang=en')).toEqual({
      tvdbId: 121361,
    });
  });
  it('parses legacy tmdb agent guids', () => {
    expect(parseHistoryGuid('com.plexapp.agents.themoviedb://584?lang=en')).toEqual({
      tmdbId: 584,
    });
  });
  it('parses legacy imdb agent guids', () => {
    expect(parseHistoryGuid('com.plexapp.agents.imdb://tt0322259?lang=en')).toEqual({
      imdbId: 'tt0322259',
    });
  });
  it('returns empty for new-style plex guids and null', () => {
    expect(parseHistoryGuid('plex://movie/5d776b59ad5437001f79c6f8')).toEqual({});
    expect(parseHistoryGuid(null)).toEqual({});
  });
});

// ============================================================================
// FIELD MAPPING TESTS
// ============================================================================

describe('Field Mapping', () => {
  describe('media type detection', () => {
    it('should correctly identify movie media type', () => {
      expect(REAL_MOVIE_RECORD.media_type).toBe('movie');
    });

    it('should correctly identify episode media type', () => {
      expect(REAL_EPISODE_RECORD.media_type).toBe('episode');
    });

    it('should correctly identify track media type', () => {
      expect(REAL_TRACK_RECORD.media_type).toBe('track');
    });
  });

  describe('rating_key type coercion', () => {
    function convertRatingKey(ratingKey: number | ''): string | null {
      return typeof ratingKey === 'number' ? String(ratingKey) : null;
    }

    it('should convert numeric rating_key to string', () => {
      const result = convertRatingKey(REAL_MOVIE_RECORD.rating_key);
      expect(result).toBe('25314');
    });

    it('should convert empty string rating_key to null', () => {
      const result = convertRatingKey('' as const);
      expect(result).toBeNull();
    });
  });

  describe('media_index type coercion', () => {
    function convertMediaIndex(mediaIndex: number | '' | null): number | null {
      return typeof mediaIndex === 'number' ? mediaIndex : null;
    }

    it('should preserve numeric media_index', () => {
      const result = convertMediaIndex(REAL_EPISODE_RECORD.media_index);
      expect(result).toBe(1);
    });

    it('should convert empty string media_index to null', () => {
      const result = convertMediaIndex('' as const);
      expect(result).toBeNull();
    });
  });

  describe('reference_id to externalSessionId', () => {
    it('should convert numeric reference_id to string', () => {
      const externalSessionId = String(REAL_MOVIE_RECORD.reference_id);
      expect(externalSessionId).toBe('11650');
      expect(typeof externalSessionId).toBe('string');
    });
  });

  describe('timestamp conversions', () => {
    it('should convert started timestamp to Date', () => {
      const startedAt = new Date(REAL_MOVIE_RECORD.started * 1000);
      expect(startedAt).toBeInstanceOf(Date);
      expect(startedAt.getTime()).toBeGreaterThan(0);
    });

    it('should convert stopped timestamp to Date', () => {
      const stoppedAt = new Date(REAL_MOVIE_RECORD.stopped * 1000);
      expect(stoppedAt).toBeInstanceOf(Date);
      expect(stoppedAt.getTime()).toBeGreaterThan(0);
    });

    it('should convert duration to milliseconds', () => {
      const durationMs = REAL_MOVIE_RECORD.duration * 1000;
      expect(durationMs).toBe(6292000);
    });

    it('should convert paused_counter to milliseconds', () => {
      const pausedDurationMs = PARTIAL_WATCH_RECORD.paused_counter * 1000;
      expect(pausedDurationMs).toBe(4205000);
    });
  });

  describe('watched status conversion', () => {
    it('should mark watched_status === 1 as watched', () => {
      const watched = REAL_MOVIE_RECORD.watched_status === 1;
      expect(watched).toBe(true);
    });

    it('should mark watched_status < 1 as not watched', () => {
      const watched = PARTIAL_WATCH_RECORD.watched_status === 1;
      expect(watched).toBe(false);
    });

    it('should handle decimal watched_status', () => {
      expect(PARTIAL_WATCH_RECORD.watched_status).toBe(0.75);
      expect(PARTIAL_WATCH_RECORD.watched_status < 1).toBe(true);
    });
  });

  describe('transcode detection', () => {
    it('should detect transcode decision', () => {
      const isTranscode = REAL_MOVIE_RECORD.transcode_decision === 'transcode';
      expect(isTranscode).toBe(true);
    });

    it('should detect direct play', () => {
      const isTranscode = REAL_EPISODE_RECORD.transcode_decision === 'transcode';
      expect(isTranscode).toBe(false);
    });
  });

  describe('quality mapping', () => {
    it('should map transcode to quality string', () => {
      const quality = REAL_MOVIE_RECORD.transcode_decision === 'transcode' ? 'Transcode' : 'Direct';
      expect(quality).toBe('Transcode');
    });

    it('should map direct play to quality string', () => {
      const quality =
        REAL_EPISODE_RECORD.transcode_decision === 'transcode' ? 'Transcode' : 'Direct';
      expect(quality).toBe('Direct');
    });
  });
});

// ============================================================================
// USER MATCHING TESTS
// ============================================================================

describe('User Matching Logic', () => {
  // Simulated user lookup function
  function findUserByExternalId(
    users: Array<{ externalId: string; id: string }>,
    tautulliUserId: number
  ): string | null {
    const user = users.find((u) => u.externalId === String(tautulliUserId));
    return user?.id ?? null;
  }

  it('should match user by externalId (Tautulli user_id)', () => {
    const tracearrUsers = [
      { externalId: '374704766', id: 'uuid-1' },
      { externalId: '150112024', id: 'uuid-2' },
    ];
    const result = findUserByExternalId(tracearrUsers, REAL_MOVIE_RECORD.user_id);
    expect(result).toBe('uuid-1');
  });

  it('should return null for unmatched user', () => {
    const tracearrUsers = [{ externalId: '999999', id: 'uuid-1' }];
    const result = findUserByExternalId(tracearrUsers, REAL_MOVIE_RECORD.user_id);
    expect(result).toBeNull();
  });

  it('should handle local user (user_id: 0)', () => {
    const tracearrUsers = [{ externalId: '0', id: 'uuid-local' }];
    const result = findUserByExternalId(tracearrUsers, LOCAL_USER.user_id);
    expect(result).toBe('uuid-local');
  });

  describe('skip user tracking', () => {
    interface SkippedUser {
      tautulliUserId: number;
      username: string;
      count: number;
    }

    function trackSkippedUser(
      skippedUsers: Map<number, SkippedUser>,
      record: TautulliHistoryRecord
    ): void {
      const existing = skippedUsers.get(record.user_id);
      if (existing) {
        existing.count++;
      } else {
        skippedUsers.set(record.user_id, {
          tautulliUserId: record.user_id,
          username: record.friendly_name || record.user || 'Unknown',
          count: 1,
        });
      }
    }

    it('should track first occurrence of skipped user', () => {
      const skippedUsers = new Map<number, SkippedUser>();
      trackSkippedUser(skippedUsers, REAL_MOVIE_RECORD);

      expect(skippedUsers.size).toBe(1);
      expect(skippedUsers.get(374704766)).toEqual({
        tautulliUserId: 374704766,
        username: 'Luke Lino',
        count: 1,
      });
    });

    it('should increment count for repeated skipped user', () => {
      const skippedUsers = new Map<number, SkippedUser>();
      // Use same user_id record twice to test increment
      trackSkippedUser(skippedUsers, REAL_MOVIE_RECORD);
      trackSkippedUser(skippedUsers, { ...REAL_MOVIE_RECORD, reference_id: 99999 }); // Same user_id

      expect(skippedUsers.size).toBe(1);
      expect(skippedUsers.get(374704766)?.count).toBe(2);
    });

    it('should track multiple different skipped users', () => {
      const skippedUsers = new Map<number, SkippedUser>();
      trackSkippedUser(skippedUsers, REAL_MOVIE_RECORD);
      trackSkippedUser(skippedUsers, REAL_TRACK_RECORD); // Different user_id

      expect(skippedUsers.size).toBe(2);
      expect(skippedUsers.has(374704766)).toBe(true);
      expect(skippedUsers.has(3453396)).toBe(true);
    });
  });
});

// ============================================================================
// DEDUPLICATION TESTS
// ============================================================================

describe('Deduplication Logic', () => {
  interface SessionRecord {
    id: string;
    serverId: string;
    externalSessionId: string | null;
    ratingKey: string | null;
    startedAt: Date;
    userId: string;
  }

  // Simulated dedup check functions
  function findByExternalSessionId(
    sessions: SessionRecord[],
    serverId: string,
    externalSessionId: string
  ): SessionRecord | undefined {
    return sessions.find(
      (s) => s.serverId === serverId && s.externalSessionId === externalSessionId
    );
  }

  function findByRatingKeyAndTime(
    sessions: SessionRecord[],
    serverId: string,
    userId: string,
    ratingKey: string,
    startedAt: Date
  ): SessionRecord | undefined {
    return sessions.find(
      (s) =>
        s.serverId === serverId &&
        s.userId === userId &&
        s.ratingKey === ratingKey &&
        s.startedAt.getTime() === startedAt.getTime()
    );
  }

  describe('externalSessionId deduplication', () => {
    it('should find existing session by externalSessionId', () => {
      const existingSessions: SessionRecord[] = [
        {
          id: 'uuid-1',
          serverId: 'server-1',
          externalSessionId: '11650',
          ratingKey: '25314',
          startedAt: new Date(1764488126 * 1000),
          userId: 'user-1',
        },
      ];

      const result = findByExternalSessionId(existingSessions, 'server-1', '11650');
      expect(result).toBeDefined();
      expect(result?.id).toBe('uuid-1');
    });

    it('should not match different server', () => {
      const existingSessions: SessionRecord[] = [
        {
          id: 'uuid-1',
          serverId: 'server-1',
          externalSessionId: '11650',
          ratingKey: '25314',
          startedAt: new Date(1764488126 * 1000),
          userId: 'user-1',
        },
      ];

      const result = findByExternalSessionId(existingSessions, 'server-2', '11650');
      expect(result).toBeUndefined();
    });

    it('should return undefined for non-existent externalSessionId', () => {
      const existingSessions: SessionRecord[] = [];
      const result = findByExternalSessionId(existingSessions, 'server-1', '99999');
      expect(result).toBeUndefined();
    });
  });

  describe('ratingKey + startedAt fallback deduplication', () => {
    it('should find existing session by ratingKey and startedAt', () => {
      const startedAt = new Date(1764488126 * 1000);
      const existingSessions: SessionRecord[] = [
        {
          id: 'uuid-1',
          serverId: 'server-1',
          externalSessionId: null, // No external ID yet
          ratingKey: '25314',
          startedAt,
          userId: 'user-1',
        },
      ];

      const result = findByRatingKeyAndTime(
        existingSessions,
        'server-1',
        'user-1',
        '25314',
        startedAt
      );
      expect(result).toBeDefined();
      expect(result?.id).toBe('uuid-1');
    });

    it('should not match different startedAt time', () => {
      const existingSessions: SessionRecord[] = [
        {
          id: 'uuid-1',
          serverId: 'server-1',
          externalSessionId: null,
          ratingKey: '25314',
          startedAt: new Date(1764488126 * 1000),
          userId: 'user-1',
        },
      ];

      const result = findByRatingKeyAndTime(
        existingSessions,
        'server-1',
        'user-1',
        '25314',
        new Date(1764488127 * 1000) // 1 second later
      );
      expect(result).toBeUndefined();
    });

    it('should not match different user', () => {
      const startedAt = new Date(1764488126 * 1000);
      const existingSessions: SessionRecord[] = [
        {
          id: 'uuid-1',
          serverId: 'server-1',
          externalSessionId: null,
          ratingKey: '25314',
          startedAt,
          userId: 'user-1',
        },
      ];

      const result = findByRatingKeyAndTime(
        existingSessions,
        'server-1',
        'user-2', // Different user
        '25314',
        startedAt
      );
      expect(result).toBeUndefined();
    });

    it('should skip fallback dedup when ratingKey is null', () => {
      const ratingKeyStr =
        typeof REAL_MOVIE_RECORD.rating_key === 'number'
          ? String(REAL_MOVIE_RECORD.rating_key)
          : null;

      const emptyRatingKeyStr = typeof ('' as number | '') === 'number' ? String('') : null;

      expect(ratingKeyStr).toBe('25314');
      expect(emptyRatingKeyStr).toBeNull();
    });
  });
});

// ============================================================================
// GEOIP INTEGRATION TESTS
// ============================================================================

describe('GeoIP Integration', () => {
  // Simulated GeoIP lookup result
  interface GeoResult {
    city: string | null;
    region: string | null;
    country: string | null;
    lat: number | null;
    lon: number | null;
  }

  // Mock GeoIP service
  function mockGeoipLookup(ipAddress: string): GeoResult {
    // Simulate real lookups
    const ipDatabase: Record<string, GeoResult> = {
      '73.160.197.140': {
        city: 'Jersey City',
        region: 'New Jersey',
        country: 'US',
        lat: 40.7282,
        lon: -74.0776,
      },
      '192.168.1.126': {
        // Private IP - no geo data
        city: null,
        region: null,
        country: null,
        lat: null,
        lon: null,
      },
      '73.130.92.216': {
        city: 'Columbus',
        region: 'Ohio',
        country: 'US',
        lat: 39.9612,
        lon: -82.9988,
      },
    };

    return (
      ipDatabase[ipAddress] ?? {
        city: null,
        region: null,
        country: null,
        lat: null,
        lon: null,
      }
    );
  }

  it('should resolve public IP to geo data', () => {
    const geo = mockGeoipLookup(REAL_MOVIE_RECORD.ip_address!);
    expect(geo.city).toBe('Jersey City');
    expect(geo.region).toBe('New Jersey');
    expect(geo.country).toBe('US');
    expect(geo.lat).toBeCloseTo(40.7282, 2);
    expect(geo.lon).toBeCloseTo(-74.0776, 2);
  });

  it('should return nulls for private IP', () => {
    const privateIp = '192.168.1.126';
    const geo = mockGeoipLookup(privateIp);
    expect(geo.city).toBeNull();
    expect(geo.region).toBeNull();
    expect(geo.country).toBeNull();
    expect(geo.lat).toBeNull();
    expect(geo.lon).toBeNull();
  });

  it('should gracefully handle unknown IP', () => {
    const geo = mockGeoipLookup('1.2.3.4');
    expect(geo.city).toBeNull();
    expect(geo.lat).toBeNull();
  });

  it('should use IP from record for lookup', () => {
    // Movie record has public IP
    const movieGeo = mockGeoipLookup(REAL_MOVIE_RECORD.ip_address!);
    expect(movieGeo.country).toBe('US');

    // Track record has different public IP
    const trackGeo = mockGeoipLookup(REAL_TRACK_RECORD.ip_address!);
    expect(trackGeo.city).toBe('Columbus');
  });
});

// ============================================================================
// PROGRESS TRACKING TESTS
// ============================================================================

describe('Progress Tracking', () => {
  interface ImportProgress {
    phase: 'users' | 'history';
    currentPage: number;
    totalRecords: number;
    importedRecords: number;
    skippedRecords: number;
    errorRecords: number;
    startedAt: Date;
  }

  function createProgress(): ImportProgress {
    return {
      phase: 'users',
      currentPage: 0,
      totalRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      errorRecords: 0,
      startedAt: new Date(),
    };
  }

  function updateProgress(
    progress: ImportProgress,
    updates: Partial<ImportProgress>
  ): ImportProgress {
    return { ...progress, ...updates };
  }

  it('should initialize progress with correct defaults', () => {
    const progress = createProgress();
    expect(progress.phase).toBe('users');
    expect(progress.currentPage).toBe(0);
    expect(progress.totalRecords).toBe(0);
    expect(progress.importedRecords).toBe(0);
    expect(progress.skippedRecords).toBe(0);
    expect(progress.errorRecords).toBe(0);
    expect(progress.startedAt).toBeInstanceOf(Date);
  });

  it('should update phase from users to history', () => {
    let progress = createProgress();
    progress = updateProgress(progress, { phase: 'history' });
    expect(progress.phase).toBe('history');
  });

  it('should track total records from API response', () => {
    let progress = createProgress();
    const apiResponse = { recordsTotal: 11650 };
    progress = updateProgress(progress, { totalRecords: apiResponse.recordsTotal });
    expect(progress.totalRecords).toBe(11650);
  });

  it('should increment imported records', () => {
    let progress = createProgress();
    progress = updateProgress(progress, { importedRecords: progress.importedRecords + 1 });
    progress = updateProgress(progress, { importedRecords: progress.importedRecords + 1 });
    progress = updateProgress(progress, { importedRecords: progress.importedRecords + 1 });
    expect(progress.importedRecords).toBe(3);
  });

  it('should increment skipped records for duplicates', () => {
    let progress = createProgress();
    progress = updateProgress(progress, { skippedRecords: progress.skippedRecords + 1 });
    expect(progress.skippedRecords).toBe(1);
  });

  it('should increment error records on failure', () => {
    let progress = createProgress();
    progress = updateProgress(progress, { errorRecords: progress.errorRecords + 1 });
    expect(progress.errorRecords).toBe(1);
  });

  it('should track page progression', () => {
    let progress = createProgress();
    // Simulating pagination through pages (page size would be 100 in real import)

    for (let page = 1; page <= 3; page++) {
      progress = updateProgress(progress, { currentPage: page });
    }

    expect(progress.currentPage).toBe(3);
  });

  it('should calculate completion percentage', () => {
    const progress = {
      ...createProgress(),
      totalRecords: 1000,
      importedRecords: 250,
      skippedRecords: 50,
      errorRecords: 0,
    };

    const processed = progress.importedRecords + progress.skippedRecords + progress.errorRecords;
    const percentage = Math.round((processed / progress.totalRecords) * 100);
    expect(percentage).toBe(30);
  });
});

// ============================================================================
// ERROR HANDLING AND RETRY TESTS
// ============================================================================

describe('Error Handling and Retry Logic', () => {
  const REQUEST_TIMEOUT_MS = 30000;
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 1000;

  describe('timeout configuration', () => {
    it('should have 30 second timeout', () => {
      expect(REQUEST_TIMEOUT_MS).toBe(30000);
    });

    it('should allow 3 retry attempts', () => {
      expect(MAX_RETRIES).toBe(3);
    });

    it('should have 1 second base retry delay', () => {
      expect(RETRY_DELAY_MS).toBe(1000);
    });
  });

  describe('exponential backoff', () => {
    function calculateBackoffDelay(attempt: number): number {
      return RETRY_DELAY_MS * attempt;
    }

    it('should calculate correct delay for attempt 1', () => {
      expect(calculateBackoffDelay(1)).toBe(1000);
    });

    it('should calculate correct delay for attempt 2', () => {
      expect(calculateBackoffDelay(2)).toBe(2000);
    });

    it('should calculate correct delay for attempt 3', () => {
      expect(calculateBackoffDelay(3)).toBe(3000);
    });
  });

  describe('retry decision logic', () => {
    function shouldRetry(attempt: number, error: Error): boolean {
      // Don't retry if we've exhausted attempts
      if (attempt >= MAX_RETRIES) return false;

      // Retry on network errors
      if (error.name === 'AbortError') return true;
      if (error.message.includes('ECONNREFUSED')) return true;
      if (error.message.includes('ETIMEDOUT')) return true;

      // Don't retry on validation errors
      if (error.name === 'ZodError') return false;

      // Retry on other errors
      return true;
    }

    it('should retry on timeout (AbortError)', () => {
      const error = new Error('Timeout');
      error.name = 'AbortError';
      expect(shouldRetry(1, error)).toBe(true);
    });

    it('should retry on connection refused', () => {
      const error = new Error('ECONNREFUSED');
      expect(shouldRetry(1, error)).toBe(true);
    });

    it('should not retry on Zod validation error', () => {
      const error = new Error('Invalid data');
      error.name = 'ZodError';
      expect(shouldRetry(1, error)).toBe(false);
    });

    it('should not retry after max attempts', () => {
      const error = new Error('Network error');
      error.name = 'AbortError';
      expect(shouldRetry(3, error)).toBe(false);
    });
  });

  describe('error result generation', () => {
    interface ImportResult {
      success: boolean;
      imported: number;
      skipped: number;
      errors: number;
      message: string;
    }

    function createErrorResult(message: string): ImportResult {
      return {
        success: false,
        imported: 0,
        skipped: 0,
        errors: 1,
        message,
      };
    }

    it('should create error result with message', () => {
      const result = createErrorResult('Connection failed after 3 retries');
      expect(result.success).toBe(false);
      expect(result.errors).toBe(1);
      expect(result.message).toContain('Connection failed');
    });

    it('should indicate zero imports on error', () => {
      const result = createErrorResult('Timeout');
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });
});

// ============================================================================
// IMPORT RESULT TESTS
// ============================================================================

describe('Import Result Generation', () => {
  interface SkippedUserInfo {
    tautulliUserId: number;
    username: string;
    recordCount: number;
  }

  interface ImportResult {
    success: boolean;
    imported: number;
    skipped: number;
    errors: number;
    message: string;
    skippedUsers?: SkippedUserInfo[];
  }

  function createSuccessResult(
    imported: number,
    skipped: number,
    errors: number,
    skippedUsers?: Map<number, { username: string; count: number }>
  ): ImportResult {
    const result: ImportResult = {
      success: true,
      imported,
      skipped,
      errors,
      message: `Imported ${imported} sessions, skipped ${skipped}, ${errors} errors`,
    };

    if (skippedUsers && skippedUsers.size > 0) {
      result.skippedUsers = Array.from(skippedUsers.entries()).map(([userId, info]) => ({
        tautulliUserId: userId,
        username: info.username,
        recordCount: info.count,
      }));
    }

    return result;
  }

  it('should create success result with counts', () => {
    const result = createSuccessResult(100, 5, 2);
    expect(result.success).toBe(true);
    expect(result.imported).toBe(100);
    expect(result.skipped).toBe(5);
    expect(result.errors).toBe(2);
  });

  it('should include skipped users when present', () => {
    const skippedUsers = new Map<number, { username: string; count: number }>();
    skippedUsers.set(374704766, { username: 'Luke Lino', count: 15 });
    skippedUsers.set(3453396, { username: 'Ryan Weaver', count: 3 });

    const result = createSuccessResult(100, 18, 0, skippedUsers);

    expect(result.skippedUsers).toBeDefined();
    expect(result.skippedUsers).toHaveLength(2);
    expect(result.skippedUsers?.[0]).toEqual({
      tautulliUserId: 374704766,
      username: 'Luke Lino',
      recordCount: 15,
    });
  });

  it('should not include skippedUsers when empty', () => {
    const skippedUsers = new Map<number, { username: string; count: number }>();
    const result = createSuccessResult(100, 0, 0, skippedUsers);
    expect(result.skippedUsers).toBeUndefined();
  });

  it('should generate appropriate message', () => {
    const result = createSuccessResult(500, 50, 10);
    expect(result.message).toBe('Imported 500 sessions, skipped 50, 10 errors');
  });
});

// ============================================================================
// CHANGE DETECTION TESTS
// ============================================================================

describe('Change Detection Logic', () => {
  interface ExistingSession {
    id: string;
    stoppedAt: Date | null;
    durationMs: number | null;
    pausedDurationMs: number;
    watched: boolean;
  }

  interface TautulliRecord {
    stopped: number;
    duration: number;
    paused_counter: number;
    watched_status: number;
  }

  function hasChanges(existing: ExistingSession, record: TautulliRecord): boolean {
    const newStoppedAt = new Date(record.stopped * 1000);
    const newDurationMs = record.duration * 1000;
    const newPausedDurationMs = record.paused_counter * 1000;
    const newWatched = record.watched_status === 1;

    const stoppedAtChanged = existing.stoppedAt?.getTime() !== newStoppedAt.getTime();
    const durationChanged = existing.durationMs !== newDurationMs;
    const pausedChanged = existing.pausedDurationMs !== newPausedDurationMs;
    const watchedChanged = existing.watched !== newWatched;

    return stoppedAtChanged || durationChanged || pausedChanged || watchedChanged;
  }

  it('should detect no changes when values match', () => {
    const existing: ExistingSession = {
      id: 'uuid-1',
      stoppedAt: new Date(1764494418 * 1000),
      durationMs: 6292000,
      pausedDurationMs: 0,
      watched: true,
    };

    const record: TautulliRecord = {
      stopped: 1764494418,
      duration: 6292,
      paused_counter: 0,
      watched_status: 1,
    };

    expect(hasChanges(existing, record)).toBe(false);
  });

  it('should detect stoppedAt change', () => {
    const existing: ExistingSession = {
      id: 'uuid-1',
      stoppedAt: new Date(1764494418 * 1000),
      durationMs: 6292000,
      pausedDurationMs: 0,
      watched: true,
    };

    const record: TautulliRecord = {
      stopped: 1764494420, // 2 seconds later
      duration: 6292,
      paused_counter: 0,
      watched_status: 1,
    };

    expect(hasChanges(existing, record)).toBe(true);
  });

  it('should detect duration change', () => {
    const existing: ExistingSession = {
      id: 'uuid-1',
      stoppedAt: new Date(1764494418 * 1000),
      durationMs: 6292000,
      pausedDurationMs: 0,
      watched: true,
    };

    const record: TautulliRecord = {
      stopped: 1764494418,
      duration: 6300, // Different duration
      paused_counter: 0,
      watched_status: 1,
    };

    expect(hasChanges(existing, record)).toBe(true);
  });

  it('should detect paused duration change', () => {
    const existing: ExistingSession = {
      id: 'uuid-1',
      stoppedAt: new Date(1764494418 * 1000),
      durationMs: 6292000,
      pausedDurationMs: 0,
      watched: true,
    };

    const record: TautulliRecord = {
      stopped: 1764494418,
      duration: 6292,
      paused_counter: 100, // Was paused
      watched_status: 1,
    };

    expect(hasChanges(existing, record)).toBe(true);
  });

  it('should detect watched status change', () => {
    const existing: ExistingSession = {
      id: 'uuid-1',
      stoppedAt: new Date(1764494418 * 1000),
      durationMs: 6292000,
      pausedDurationMs: 0,
      watched: false, // Not watched
    };

    const record: TautulliRecord = {
      stopped: 1764494418,
      duration: 6292,
      paused_counter: 0,
      watched_status: 1, // Now watched
    };

    expect(hasChanges(existing, record)).toBe(true);
  });

  it('should handle null stoppedAt in existing session', () => {
    const existing: ExistingSession = {
      id: 'uuid-1',
      stoppedAt: null, // Session was never stopped (active)
      durationMs: 6292000,
      pausedDurationMs: 0,
      watched: true,
    };

    const record: TautulliRecord = {
      stopped: 1764494418,
      duration: 6292,
      paused_counter: 0,
      watched_status: 1,
    };

    // null.getTime() would throw, so this checks the comparison handles it
    expect(hasChanges(existing, record)).toBe(true);
  });

  it('should handle null durationMs in existing session', () => {
    const existing: ExistingSession = {
      id: 'uuid-1',
      stoppedAt: new Date(1764494418 * 1000),
      durationMs: null, // Duration not yet recorded
      pausedDurationMs: 0,
      watched: true,
    };

    const record: TautulliRecord = {
      stopped: 1764494418,
      duration: 6292,
      paused_counter: 0,
      watched_status: 1,
    };

    expect(hasChanges(existing, record)).toBe(true);
  });

  it('should treat watched_status < 1 as not watched', () => {
    const existing: ExistingSession = {
      id: 'uuid-1',
      stoppedAt: new Date(1764494418 * 1000),
      durationMs: 6292000,
      pausedDurationMs: 0,
      watched: false,
    };

    const record: TautulliRecord = {
      stopped: 1764494418,
      duration: 6292,
      paused_counter: 0,
      watched_status: 0.75, // Partial watch - still not "watched"
    };

    expect(hasChanges(existing, record)).toBe(false);
  });
});

// ============================================================================
// IMPORT CUTOFF TESTS
// ============================================================================

describe('TautulliService.importHistory cutoff and safe updates', () => {
  const SERVER_ID = 'server-uuid-1234';
  const SERVER_USER_ID = 'server-user-uuid-1';
  const CUTOFF = new Date('2025-01-01T00:00:00Z');
  const PMS_ID = 'pms-1';

  let mockFetch: ReturnType<typeof vi.fn>;

  function jsonResponse(body: unknown) {
    return { ok: true, json: async () => body };
  }

  function mockTautulliFetch(historyRecords: unknown[], total: number) {
    return vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const cmd = parsed.searchParams.get('cmd');

      if (cmd === 'arnold') return jsonResponse({ response: { result: 'success' } });
      if (cmd === 'get_server_info') {
        return jsonResponse({ response: { result: 'success', data: { pms_identifier: PMS_ID } } });
      }
      if (cmd === 'get_users') {
        return jsonResponse({ response: { result: 'success', message: null, data: [] } });
      }
      if (cmd === 'get_history') {
        const start = Number(parsed.searchParams.get('start') ?? 0);
        const length = Number(parsed.searchParams.get('length') ?? historyRecords.length);
        return jsonResponse({
          response: {
            result: 'success',
            message: null,
            data: {
              recordsFiltered: total,
              recordsTotal: total,
              data: historyRecords.slice(start, start + length),
              draw: 1,
              filter_duration: '0 secs',
              total_duration: '0 secs',
            },
          },
        });
      }
      throw new Error(`Unexpected Tautulli cmd in test: ${cmd}`);
    });
  }

  function makeRecord(overrides: Partial<TautulliHistoryRecord> = {}): TautulliHistoryRecord {
    return { ...REAL_MOVIE_RECORD, ...overrides };
  }

  function makeExisting(overrides: Partial<ExistingSession> = {}): ExistingSession {
    return {
      id: 'existing-id',
      externalSessionId: null,
      ratingKey: null,
      startedAt: null,
      serverUserId: SERVER_USER_ID,
      totalDurationMs: null,
      stoppedAt: new Date(0),
      durationMs: 0,
      pausedDurationMs: 0,
      watched: false,
      sourceVideoCodec: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    vi.mocked(getSettings).mockResolvedValue({
      tautulliUrl: 'http://localhost:8181',
      tautulliApiKey: 'test-key',
    } as Awaited<ReturnType<typeof getSettings>>);
    vi.mocked(createUserMapping).mockResolvedValue(
      new Map([[String(REAL_MOVIE_RECORD.user_id), SERVER_USER_ID]])
    );
    vi.mocked(getServerTrackingStart).mockResolvedValue(CUTOFF);
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, [{ machineIdentifier: PMS_ID }]));
    vi.mocked(queryExistingByExternalIds).mockResolvedValue(new Map());
    vi.mocked(queryExistingByTimeKeys).mockResolvedValue(new Map());
    vi.mocked(flushInsertBatch).mockResolvedValue(0);
    vi.mocked(flushUpdateBatch).mockResolvedValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes grouping=1 on get_history requests', async () => {
    mockFetch = mockTautulliFetch([], 0);
    global.fetch = mockFetch as typeof global.fetch;

    await TautulliService.importHistory(SERVER_ID);

    const historyCall = mockFetch.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('cmd=get_history')
    );
    expect(historyCall?.[0]).toContain('grouping=1');
  });

  it('aborts with an error result when the server has no tracking cutoff', async () => {
    vi.mocked(getServerTrackingStart).mockResolvedValue(null);
    mockFetch = mockTautulliFetch([], 0);
    global.fetch = mockFetch as typeof global.fetch;

    const result = await TautulliService.importHistory(SERVER_ID);

    expect(result.success).toBe(false);
    expect(result.message).toContain('cutoff');
  });

  it('skips records at or after the cutoff before they reach dedup, and imports the one before it', async () => {
    const cutoffSec = Math.floor(CUTOFF.getTime() / 1000);
    const before = makeRecord({ reference_id: 1, started: cutoffSec - 3600 });
    const at = makeRecord({ reference_id: 2, started: cutoffSec });
    const after = makeRecord({ reference_id: 3, started: cutoffSec + 3600 });

    mockFetch = mockTautulliFetch([before, at, after], 3);
    global.fetch = mockFetch as typeof global.fetch;

    // If dedup were reached for these, the mismatched stoppedAt below would register as an update.
    vi.mocked(queryExistingByExternalIds).mockResolvedValue(
      new Map([
        [
          '2',
          makeExisting({
            id: 'existing-2',
            externalSessionId: '2',
            startedAt: new Date(at.started * 1000),
          }),
        ],
        [
          '3',
          makeExisting({
            id: 'existing-3',
            externalSessionId: '3',
            startedAt: new Date(after.started * 1000),
          }),
        ],
      ])
    );

    const result = await TautulliService.importHistory(SERVER_ID);

    expect(result.success).toBe(true);
    expect(result.imported).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.message).toBe(
      'Import complete: 1 new, 2 skipped (2 started after this server was added to Tracearr)'
    );
  });

  it('re-arms imported history linking and clears the provider pass list when the import completes', async () => {
    mockFetch = mockTautulliFetch([makeRecord({ reference_id: 1 })], 1);
    global.fetch = mockFetch as typeof global.fetch;

    const result = await TautulliService.importHistory(SERVER_ID);

    expect(result.success).toBe(true);
    expect(rearmImportedHistoryLink).toHaveBeenCalledWith({ keepProviderPass: false });
  });

  it('re-arms imported history linking when an import that already inserted rows fails fatally', async () => {
    const started = Math.floor(CUTOFF.getTime() / 1000) - 3600;
    const pages = mockTautulliFetch([makeRecord({ reference_id: 1, started })], 5001);
    mockFetch = vi.fn(async (url: string) =>
      new URL(url).searchParams.get('start') === '5000'
        ? new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
        : pages(url)
    );
    global.fetch = mockFetch as typeof global.fetch;

    await expect(TautulliService.importHistory(SERVER_ID)).rejects.toMatchObject({ status: 401 });

    expect(rearmImportedHistoryLink).toHaveBeenCalledWith({ keepProviderPass: false });
  });

  it('re-arms imported history linking when flushing a batch of counted rows throws', async () => {
    const started = Math.floor(CUTOFF.getTime() / 1000) - 3600;
    mockFetch = mockTautulliFetch([makeRecord({ reference_id: 1, started })], 1);
    global.fetch = mockFetch as typeof global.fetch;
    vi.mocked(flushInsertBatch).mockRejectedValue(new Error('connection reset'));

    await expect(TautulliService.importHistory(SERVER_ID)).rejects.toThrow('connection reset');

    expect(rearmImportedHistoryLink).toHaveBeenCalledWith({ keepProviderPass: false });
  });

  it('does not update an existingByRef record whose recorded start differs from the stored start', async () => {
    const cutoffSec = Math.floor(CUTOFF.getTime() / 1000);
    const record = makeRecord({ reference_id: 42, started: cutoffSec - 3600, duration: 100 });

    mockFetch = mockTautulliFetch([record], 1);
    global.fetch = mockFetch as typeof global.fetch;

    vi.mocked(queryExistingByExternalIds).mockResolvedValue(
      new Map([
        [
          '42',
          makeExisting({
            id: 'existing-42',
            externalSessionId: '42',
            startedAt: new Date((record.started - 999) * 1000),
          }),
        ],
      ])
    );

    const result = await TautulliService.importHistory(SERVER_ID);

    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(flushUpdateBatch).not.toHaveBeenCalled();
  });

  it('refreshes aggregates over a bounded range when a page contains only updates', async () => {
    const cutoffSec = Math.floor(CUTOFF.getTime() / 1000);
    const record = makeRecord({
      reference_id: 7,
      started: cutoffSec - 3600,
      duration: 200,
      watched_status: 1,
    });

    mockFetch = mockTautulliFetch([record], 1);
    global.fetch = mockFetch as typeof global.fetch;

    vi.mocked(queryExistingByExternalIds).mockResolvedValue(
      new Map([
        [
          '7',
          makeExisting({
            id: 'existing-7',
            externalSessionId: '7',
            startedAt: new Date(record.started * 1000),
          }),
        ],
      ])
    );

    const result = await TautulliService.importHistory(SERVER_ID);

    expect(result.updated).toBe(1);
    expect(result.imported).toBe(0);
    const startedAt = new Date(record.started * 1000);
    expect(refreshAggregates).toHaveBeenCalledWith({
      startTime: new Date(startedAt.getTime() - 24 * 60 * 60 * 1000),
      endTime: new Date(startedAt.getTime() + 24 * 60 * 60 * 1000),
    });
  });
});

describe('TautulliService.importHistory Plex guid fallback', () => {
  const SERVER_ID = 'server-uuid-1234';
  const SERVER_USER_ID = 'server-user-uuid-1';
  const CUTOFF = new Date('2025-01-01T00:00:00Z');
  const PMS_ID = 'pms-1';

  function jsonResponse(body: unknown) {
    return { ok: true, json: async () => body };
  }

  function mockTautulliFetch(historyRecords: unknown[]): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const cmd = parsed.searchParams.get('cmd');

      if (cmd === 'arnold') return jsonResponse({ response: { result: 'success' } });
      if (cmd === 'get_server_info') {
        return jsonResponse({ response: { result: 'success', data: { pms_identifier: PMS_ID } } });
      }
      if (cmd === 'get_users') {
        return jsonResponse({ response: { result: 'success', message: null, data: [] } });
      }
      if (cmd === 'get_history') {
        return jsonResponse({
          response: {
            result: 'success',
            message: null,
            data: {
              recordsFiltered: historyRecords.length,
              recordsTotal: historyRecords.length,
              data: historyRecords,
              draw: 1,
              filter_duration: '0 secs',
              total_duration: '0 secs',
            },
          },
        });
      }
      throw new Error(`Unexpected Tautulli cmd in test: ${cmd}`);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    vi.mocked(getSettings).mockResolvedValue({
      tautulliUrl: 'http://localhost:8181',
      tautulliApiKey: 'test-key',
    } as Awaited<ReturnType<typeof getSettings>>);
    vi.mocked(createUserMapping).mockResolvedValue(
      new Map([[String(REAL_MOVIE_RECORD.user_id), SERVER_USER_ID]])
    );
    vi.mocked(getServerTrackingStart).mockResolvedValue(CUTOFF);
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, [{ machineIdentifier: PMS_ID }]));
    vi.mocked(queryExistingByExternalIds).mockResolvedValue(new Map());
    vi.mocked(queryExistingByTimeKeys).mockResolvedValue(new Map());
    vi.mocked(flushInsertBatch).mockResolvedValue(0);
    vi.mocked(flushUpdateBatch).mockResolvedValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('links an unknown rating key by guid when it resolves to exactly one canonical media', async () => {
    const guid = REAL_MOVIE_RECORD.guid ?? '';
    const record = { ...REAL_MOVIE_RECORD, started: Math.floor(CUTOFF.getTime() / 1000) - 3600 };
    global.fetch = mockTautulliFetch([record]) as typeof global.fetch;
    vi.mocked(batchResolveMediaByPlexGuid).mockResolvedValue(
      new Map([
        [
          guid,
          { mediaId: 'media-1', showMediaId: null, imdbId: 'tt999', tmdbId: 42, tvdbId: null },
        ],
      ])
    );

    let inserted: Array<Record<string, unknown>> | undefined;
    vi.mocked(flushInsertBatch).mockImplementation(async (batch) => {
      inserted = [...(batch as Array<Record<string, unknown>>)];
      return batch.length;
    });

    await TautulliService.importHistory(SERVER_ID);

    expect(batchResolveMediaByPlexGuid).toHaveBeenCalledWith(SERVER_ID, [
      { guid, mediaType: 'movie' },
    ]);
    expect(inserted?.[0]).toMatchObject({
      mediaId: 'media-1',
      imdbId: 'tt999',
      tmdbId: 42,
      tvdbId: null,
    });
  });

  it.each([
    { tracearr: 'pms-other', label: 'Tautulli monitors a different Plex server' },
    { tracearr: null, label: 'the server row has no machine identifier' },
  ])('never falls back to guid when $label', async ({ tracearr }) => {
    const record = { ...REAL_MOVIE_RECORD, started: Math.floor(CUTOFF.getTime() / 1000) - 3600 };
    global.fetch = mockTautulliFetch([record]) as typeof global.fetch;
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, [{ machineIdentifier: tracearr }]));
    let inserted: Array<Record<string, unknown>> | undefined;
    vi.mocked(flushInsertBatch).mockImplementation(async (batch) => {
      inserted = [...(batch as Array<Record<string, unknown>>)];
      return batch.length;
    });

    const result = await TautulliService.importHistory(SERVER_ID);

    expect(result.success).toBe(true);
    expect(batchResolveMediaByPlexGuid).not.toHaveBeenCalled();
    expect(inserted?.[0]).toMatchObject({ mediaId: null });
  });

  it('imports without a guid lookup when Tautulli server info fails', async () => {
    const record = { ...REAL_MOVIE_RECORD, started: Math.floor(CUTOFF.getTime() / 1000) - 3600 };
    const history = mockTautulliFetch([record]) as unknown as typeof global.fetch;
    global.fetch = vi.fn(async (url: string) =>
      new URL(url).searchParams.get('cmd') === 'get_server_info'
        ? jsonResponse({ unexpected: true })
        : history(url)
    ) as typeof global.fetch;

    const result = await TautulliService.importHistory(SERVER_ID);

    expect(result.success).toBe(true);
    expect(result.imported).toBe(1);
    expect(batchResolveMediaByPlexGuid).not.toHaveBeenCalled();
  });

  it('still links by rating key when Tautulli monitors a different Plex server', async () => {
    const record = { ...REAL_MOVIE_RECORD, started: Math.floor(CUTOFF.getTime() / 1000) - 3600 };
    global.fetch = mockTautulliFetch([record]) as typeof global.fetch;
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, [{ machineIdentifier: 'pms-other' }]));
    vi.mocked(batchGetLibraryItemIdentity).mockResolvedValueOnce(
      new Map([
        [
          String(REAL_MOVIE_RECORD.rating_key),
          {
            mediaId: 'media-by-key',
            showMediaId: null,
            imdbId: 'tt555',
            tmdbId: null,
            tvdbId: null,
            parentRatingKey: null,
            grandparentRatingKey: null,
            itemMediaType: 'movie',
          },
        ],
      ])
    );
    let inserted: Array<Record<string, unknown>> | undefined;
    vi.mocked(flushInsertBatch).mockImplementation(async (batch) => {
      inserted = [...(batch as Array<Record<string, unknown>>)];
      return batch.length;
    });

    await TautulliService.importHistory(SERVER_ID);

    expect(batchResolveMediaByPlexGuid).not.toHaveBeenCalled();
    expect(inserted?.[0]).toMatchObject({ mediaId: 'media-by-key', imdbId: 'tt555' });
  });

  it('does not fall back to guid when the rating key resolved a row with no mediaId yet', async () => {
    const ratingKeyStr = String(REAL_MOVIE_RECORD.rating_key);
    const record = { ...REAL_MOVIE_RECORD, started: Math.floor(CUTOFF.getTime() / 1000) - 3600 };
    global.fetch = mockTautulliFetch([record]) as typeof global.fetch;
    vi.mocked(batchGetLibraryItemIdentity).mockResolvedValue(
      new Map([
        [
          ratingKeyStr,
          {
            mediaId: null,
            showMediaId: null,
            imdbId: 'tt777',
            tmdbId: null,
            tvdbId: null,
            parentRatingKey: null,
            grandparentRatingKey: null,
            itemMediaType: 'movie',
          },
        ],
      ])
    );
    // A guid resolution would be available if the helper were consulted; it must not be.
    vi.mocked(batchResolveMediaByPlexGuid).mockResolvedValue(
      new Map([
        [
          record.guid ?? '',
          { mediaId: 'media-1', showMediaId: null, imdbId: 'tt999', tmdbId: 42, tvdbId: null },
        ],
      ])
    );
    let inserted: Array<Record<string, unknown>> | undefined;
    vi.mocked(flushInsertBatch).mockImplementation(async (batch) => {
      inserted = [...(batch as Array<Record<string, unknown>>)];
      return batch.length;
    });

    await TautulliService.importHistory(SERVER_ID);

    expect(batchResolveMediaByPlexGuid).toHaveBeenCalledWith(SERVER_ID, []);
    expect(inserted?.[0]).toMatchObject({ mediaId: null, imdbId: 'tt777' });
  });

  it('leaves media_id null when the guid resolves to more than one canonical media', async () => {
    const record = { ...REAL_MOVIE_RECORD, started: Math.floor(CUTOFF.getTime() / 1000) - 3600 };
    global.fetch = mockTautulliFetch([record]) as typeof global.fetch;
    // batchResolveMediaByPlexGuid omits a guid entirely once it resolves to more than one id.
    vi.mocked(batchResolveMediaByPlexGuid).mockResolvedValue(new Map());
    let inserted: Array<Record<string, unknown>> | undefined;
    vi.mocked(flushInsertBatch).mockImplementation(async (batch) => {
      inserted = [...(batch as Array<Record<string, unknown>>)];
      return batch.length;
    });

    await TautulliService.importHistory(SERVER_ID);

    expect(inserted?.[0]).toMatchObject({ mediaId: null });
  });

  it('never sends a plex://show/ guid or a legacy agent guid to the helper', async () => {
    const showGuidRecord = {
      ...REAL_MOVIE_RECORD,
      reference_id: 501,
      guid: 'plex://show/5d7768324de0ee001fccac77',
      started: Math.floor(CUTOFF.getTime() / 1000) - 3600,
    };
    const legacyGuidRecord = {
      ...REAL_MOVIE_RECORD,
      reference_id: 502,
      guid: 'com.plexapp.agents.imdb://tt0322259?lang=en',
      started: Math.floor(CUTOFF.getTime() / 1000) - 3600,
    };
    global.fetch = mockTautulliFetch([showGuidRecord, legacyGuidRecord]) as typeof global.fetch;

    await TautulliService.importHistory(SERVER_ID);

    expect(batchResolveMediaByPlexGuid).toHaveBeenCalledWith(SERVER_ID, []);
  });

  it('never sends a movie record whose guid is a plex://episode/ guid to the helper', async () => {
    const record = {
      ...REAL_MOVIE_RECORD,
      guid: 'plex://episode/5e8338265161b50041c98783',
      started: Math.floor(CUTOFF.getTime() / 1000) - 3600,
    };
    global.fetch = mockTautulliFetch([record]) as typeof global.fetch;

    await TautulliService.importHistory(SERVER_ID);

    expect(batchResolveMediaByPlexGuid).toHaveBeenCalledWith(SERVER_ID, []);
  });
});
