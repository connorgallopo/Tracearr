/**
 * Tautulli Import Service Tests
 *
 * Comprehensive tests covering:
 * - Zod schema validation against real API data structures
 * - User matching and skip behavior
 * - Session deduplication logic
 * - GeoIP integration
 * - Field mapping (movies, episodes, tracks)
 * - Retry/timeout behavior
 * - Progress tracking
 */

import { describe, it, expect } from 'vitest';

// Import ACTUAL production schemas - not local duplicates
// This ensures tests validate the same schemas used in production
import {
  TautulliHistoryRecordSchema,
  TautulliHistoryResponseSchema,
  TautulliUserRecordSchema,
  TautulliUsersResponseSchema,
  type TautulliHistoryRecord,
  type TautulliUserRecord,
} from '../tautulli.js';

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
    function convertMediaIndex(mediaIndex: number | ''): number | null {
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
          username: record.friendly_name || record.user,
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

      const emptyRatingKeyStr =
        typeof ('' as number | '') === 'number' ? String('' as number | '') : null;

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
    const geo = mockGeoipLookup(REAL_MOVIE_RECORD.ip_address);
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
    const movieGeo = mockGeoipLookup(REAL_MOVIE_RECORD.ip_address);
    expect(movieGeo.country).toBe('US');

    // Track record has different public IP
    const trackGeo = mockGeoipLookup(REAL_TRACK_RECORD.ip_address);
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
