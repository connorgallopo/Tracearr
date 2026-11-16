import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session, ServerUser, Server, EngineAutomation } from '@tracearr/shared';
import type { EvaluationContext } from '../types.js';
import { synthesizeTriggers } from '../triggers.js';
import { evaluateRuleAsync, evaluateRulesAsync, ruleAppliesTo } from '../engine.js';

// Mock geoipService
vi.mock('../../geoip.js', () => ({
  geoipService: {
    isPrivateIP: (ip: string) => {
      if (!ip) return false;
      return ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('127.');
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// Helper to create a mock session
function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    serverId: 'server-1',
    serverUserId: 'user-1',
    sessionKey: 'sk-1',
    state: 'playing',
    mediaType: 'movie',
    mediaTitle: 'Test Movie',
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    year: 2024,
    thumbPath: null,
    ratingKey: 'rk-1',
    serverVersionKey: null,
    parentRatingKey: null,
    grandparentRatingKey: null,
    mediaId: null,
    showMediaId: null,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    externalSessionId: 'ext-1',
    startedAt: new Date(),
    stoppedAt: null,
    durationMs: null,
    totalDurationMs: 7200000,
    progressMs: 0,
    lastPausedAt: null,
    pausedDurationMs: 0,
    referenceId: null,
    watched: false,
    ipAddress: '192.168.1.100',
    geoCity: 'New York',
    geoRegion: 'NY',
    geoCountry: 'US',
    geoContinent: 'NA',
    geoPostal: '10001',
    geoLat: 40.7128,
    geoLon: -74.006,
    geoAsnNumber: 7922,
    geoAsnOrganization: 'Comcast',
    isLocal: false,
    profileName: null,
    playerName: 'Player 1',
    deviceId: 'device-1',
    product: 'Plex Web',
    device: 'Chrome',
    platform: 'Web',
    quality: '1080p',
    isTranscode: false,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
    bitrate: 20000,
    channelTitle: null,
    channelIdentifier: null,
    channelThumb: null,
    artistName: null,
    albumName: null,
    trackNumber: null,
    discNumber: null,
    sourceVideoCodec: 'hevc',
    sourceAudioCodec: 'ac3',
    sourceAudioChannels: 6,
    sourceVideoWidth: 1920,
    sourceVideoHeight: 1080,
    sourceVideoDetails: null,
    sourceAudioDetails: null,
    streamVideoCodec: null,
    streamAudioCodec: null,
    streamVideoDetails: null,
    streamAudioDetails: null,
    transcodeInfo: null,
    subtitleInfo: null,
    ...overrides,
  };
}

function createMockServerUser(overrides: Partial<ServerUser> = {}): ServerUser {
  return {
    id: 'user-1',
    serverId: 'server-1',
    userId: 'identity-1',
    externalId: 'ext-user-1',
    username: 'testuser',
    email: 'test@example.com',
    thumbUrl: null,
    isServerAdmin: false,
    joinedAt: new Date(),
    lastActivityAt: new Date(),
    trustScore: 100,
    removedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockServer(overrides: Partial<Server> = {}): Server {
  return {
    id: 'server-1',
    name: 'Test Server',
    type: 'plex',
    url: 'http://localhost:32400',
    displayOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockRule(overrides: Partial<EngineAutomation> = {}): EngineAutomation {
  const conditions = overrides.conditions ?? { groups: [] };
  return {
    id: 'rule-1',
    name: 'Test Rule',
    description: null,
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    isActive: true,
    severity: 'warning',
    kind: 'policy',
    conditions,
    actions: { actions: [] },
    currentVersionId: null,
    cooldownMinutes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
    triggers:
      overrides.triggers !== undefined ? overrides.triggers : synthesizeTriggers(conditions),
  };
}

function createTestContext(
  rule: EngineAutomation,
  overrides: Partial<EvaluationContext> = {}
): EvaluationContext {
  const server = createMockServer();
  const serverUser = createMockServerUser({ serverId: server.id });
  const session = createMockSession({ serverId: server.id, serverUserId: serverUser.id });

  return {
    session,
    serverUser,
    server,
    media: null,
    subjectKey: session.id,
    activeSessions: [session],
    recentSessions: [session],
    rule,
    ...overrides,
  };
}

describe('evaluateRuleAsync', () => {
  describe('empty conditions', () => {
    it('matches when rule has no conditions', async () => {
      const rule = createMockRule({
        conditions: { groups: [] },
        actions: { actions: [{ type: 'trust', mode: 'reset' }] },
      });
      const ctx = createTestContext(rule);

      const result = await evaluateRuleAsync(ctx);

      expect(result.matched).toBe(true);
      expect(result.matchedGroups).toEqual([]);
      expect(result.actions).toEqual([{ type: 'trust', mode: 'reset' }]);
      expect(result.evidence).toEqual([]);
    });
  });

  describe('single condition', () => {
    it('matches when condition is true', async () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              conditions: [{ field: 'is_transcoding', operator: 'eq', value: false }],
            },
          ],
        },
        severity: 'warning',
        actions: { actions: [] },
      });

      const ctx = createTestContext(rule, {
        session: createMockSession({ isTranscode: false }),
      });

      const result = await evaluateRuleAsync(ctx);

      expect(result.matched).toBe(true);
      expect(result.matchedGroups).toEqual([0]);
    });

    it('does not match when condition is false', async () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }],
            },
          ],
        },
      });

      const ctx = createTestContext(rule, {
        session: createMockSession({ isTranscode: false }),
      });

      const result = await evaluateRuleAsync(ctx);

      expect(result.matched).toBe(false);
      expect(result.actions).toEqual([]);
    });
  });

  describe('OR logic within groups', () => {
    it('matches when any condition in a group is true', async () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              conditions: [
                { field: 'source_resolution', operator: 'eq', value: '4K' },
                { field: 'source_resolution', operator: 'eq', value: '1080p' },
              ],
            },
          ],
        },
      });

      const ctx = createTestContext(rule, {
        session: createMockSession({ sourceVideoWidth: 1920, sourceVideoHeight: 1080 }),
      });

      const result = await evaluateRuleAsync(ctx);

      expect(result.matched).toBe(true);
    });

    it('does not match when all conditions in a group are false', async () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              conditions: [
                { field: 'source_resolution', operator: 'eq', value: '4K' },
                { field: 'source_resolution', operator: 'eq', value: '720p' },
              ],
            },
          ],
        },
      });

      const ctx = createTestContext(rule, {
        session: createMockSession({ sourceVideoWidth: 1920, sourceVideoHeight: 1080 }),
      });

      const result = await evaluateRuleAsync(ctx);

      expect(result.matched).toBe(false);
    });
  });

  describe('match: all within a group', () => {
    it('requires every enabled condition', async () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              match: 'all',
              conditions: [
                { field: 'source_resolution', operator: 'eq', value: '1080p' },
                { field: 'is_transcoding', operator: 'eq', value: 'video' },
              ],
            },
          ],
        },
      });
      const ctx = createTestContext(rule, {
        session: createMockSession({ sourceVideoWidth: 1920, sourceVideoHeight: 1080 }),
      });

      const result = await evaluateRuleAsync(ctx);

      expect(result.matched).toBe(false);
      expect(result.stoppedBy?.match).toBe('all');
    });

    it('matches when every enabled condition holds', async () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              match: 'all',
              conditions: [
                { field: 'source_resolution', operator: 'eq', value: '1080p' },
                { field: 'is_transcoding', operator: 'eq', value: 'neither' },
              ],
            },
          ],
        },
      });
      const ctx = createTestContext(rule, {
        session: createMockSession({ sourceVideoWidth: 1920, sourceVideoHeight: 1080 }),
      });

      const result = await evaluateRuleAsync(ctx);

      expect(result.matched).toBe(true);
    });
  });

  describe('disabled nodes', () => {
    it('ignores a disabled condition inside a group', async () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              match: 'all',
              conditions: [
                { field: 'source_resolution', operator: 'eq', value: '1080p' },
                { field: 'source_resolution', operator: 'eq', value: '4K', enabled: false },
              ],
            },
          ],
        },
      });
      const ctx = createTestContext(rule, {
        session: createMockSession({ sourceVideoWidth: 1920, sourceVideoHeight: 1080 }),
      });

      const result = await evaluateRuleAsync(ctx);

      expect(result.matched).toBe(true);
      expect(result.evidence?.[0]?.conditions).toHaveLength(1);
    });

    it('passes a group whose conditions are all disabled', async () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              conditions: [
                { field: 'source_resolution', operator: 'eq', value: '4K', enabled: false },
              ],
            },
          ],
        },
      });
      const ctx = createTestContext(rule, {
        session: createMockSession({ sourceVideoWidth: 1920, sourceVideoHeight: 1080 }),
      });

      const result = await evaluateRuleAsync(ctx);

      expect(result.matched).toBe(true);
      expect(result.evidence?.[0]?.conditions).toEqual([]);
    });

    it('skips a disabled group entirely', async () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              enabled: false,
              conditions: [{ field: 'source_resolution', operator: 'eq', value: '4K' }],
            },
          ],
        },
      });
      const ctx = createTestContext(rule, {
        session: createMockSession({ sourceVideoWidth: 1920, sourceVideoHeight: 1080 }),
      });

      const result = await evaluateRuleAsync(ctx);

      expect(result.matched).toBe(true);
      expect(result.evidence).toEqual([]);
    });
  });

  describe('AND logic between groups', () => {
    it('matches when all groups match', async () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            { conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] },
            { conditions: [{ field: 'source_resolution', operator: 'eq', value: '4K' }] },
          ],
        },
      });

      const ctx = createTestContext(rule, {
        session: createMockSession({
          isTranscode: true,
          sourceVideoWidth: 3840,
          sourceVideoHeight: 2160,
        }),
      });

      const result = await evaluateRuleAsync(ctx);

      expect(result.matched).toBe(true);
      expect(result.matchedGroups).toEqual([0, 1]);
    });

    it('does not match when any group fails', async () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            { conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] },
            { conditions: [{ field: 'source_resolution', operator: 'eq', value: '4K' }] },
          ],
        },
      });

      const ctx = createTestContext(rule, {
        session: createMockSession({
          isTranscode: true,
          sourceVideoWidth: 1920,
          sourceVideoHeight: 1080,
        }),
      });

      const result = await evaluateRuleAsync(ctx);

      expect(result.matched).toBe(false);
    });
  });

  describe('stoppedBy', () => {
    it('reports the group that ended the walk and nothing after it', async () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            { conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] },
            { conditions: [{ field: 'source_resolution', operator: 'eq', value: '4K' }] },
            { conditions: [{ field: 'trust_score', operator: 'lt', value: 10 }] },
          ],
        },
      });

      const ctx = createTestContext(rule, {
        session: createMockSession({
          isTranscode: true,
          sourceVideoWidth: 1920,
          sourceVideoHeight: 1080,
        }),
      });

      const result = await evaluateRuleAsync(ctx);

      expect(result.matched).toBe(false);
      expect(result.stoppedBy?.groupIndex).toBe(1);
      expect(result.stoppedBy?.matched).toBe(false);
      expect(result.stoppedBy?.conditions).toEqual([
        expect.objectContaining({ field: 'source_resolution', threshold: '4K', matched: false }),
      ]);
    });

    it('is absent on a match', async () => {
      const rule = createMockRule({
        conditions: {
          groups: [{ conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] }],
        },
      });

      const result = await evaluateRuleAsync(
        createTestContext(rule, { session: createMockSession({ isTranscode: true }) })
      );

      expect(result.matched).toBe(true);
      expect(result).not.toHaveProperty('stoppedBy');
    });
  });

  describe('complex conditions', () => {
    it('evaluates (4K OR 1080p) AND transcoding AND low trust', async () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              conditions: [
                { field: 'source_resolution', operator: 'eq', value: '4K' },
                { field: 'source_resolution', operator: 'eq', value: '1080p' },
              ],
            },
            { conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] },
            { conditions: [{ field: 'trust_score', operator: 'lt', value: 70 }] },
          ],
        },
        severity: 'high',
        actions: { actions: [] },
      });

      const ctx = createTestContext(rule, {
        session: createMockSession({
          isTranscode: true,
          sourceVideoWidth: 3840,
          sourceVideoHeight: 2160,
        }),
        serverUser: createMockServerUser({ trustScore: 50 }),
      });

      const result = await evaluateRuleAsync(ctx);

      expect(result.matched).toBe(true);
      expect(result.matchedGroups).toEqual([0, 1, 2]);
      expect(result.actions).toEqual([]);
    });

    it('user exclusion works (user NOT IN [excluded])', async () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            { conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] },
            {
              conditions: [{ field: 'user_id', operator: 'not_in', value: ['admin-1', 'admin-2'] }],
            },
          ],
        },
      });

      // Regular user should match
      const regularCtx = createTestContext(rule, {
        session: createMockSession({ isTranscode: true }),
        serverUser: createMockServerUser({ id: 'regular-user' }),
      });

      expect((await evaluateRuleAsync(regularCtx)).matched).toBe(true);

      // Admin should not match
      const adminCtx = createTestContext(rule, {
        session: createMockSession({ isTranscode: true }),
        serverUser: createMockServerUser({ id: 'admin-1' }),
      });

      expect((await evaluateRuleAsync(adminCtx)).matched).toBe(false);
    });

    it('4K transcoding rule with user exclusion (issue #382 reproduction)', async () => {
      const excludedUserId = 'owner-uuid-123';
      const rule = createMockRule({
        conditions: {
          groups: [
            // Group 1: is transcoding video
            { conditions: [{ field: 'is_transcoding', operator: 'eq', value: 'video' }] },
            // Group 2: source resolution is 4K
            { conditions: [{ field: 'source_resolution', operator: 'eq', value: '4K' }] },
            // Group 3: user is NOT the excluded user
            {
              conditions: [{ field: 'user_id', operator: 'not_in', value: [excludedUserId] }],
            },
          ],
        },
        actions: {
          actions: [{ type: 'kill_stream', target: 'triggering', message: 'No 4K transcoding' }],
        },
      });

      // Non-excluded user transcoding 4K → should trigger
      const otherUserCtx = createTestContext(rule, {
        session: createMockSession({
          isTranscode: true,
          videoDecision: 'transcode',
          sourceVideoWidth: 3840,
          sourceVideoHeight: 2160,
        }),
        serverUser: createMockServerUser({ id: 'other-user-456' }),
      });

      const otherResult = await evaluateRuleAsync(otherUserCtx);
      expect(otherResult.matched).toBe(true);
      expect(otherResult.matchedGroups).toEqual([0, 1, 2]);

      // Verify evidence for matching rule shows all 3 groups matched
      expect(otherResult.evidence).toHaveLength(3);
      expect(otherResult.evidence![0]!.matched).toBe(true);
      expect(otherResult.evidence![1]!.matched).toBe(true);
      expect(otherResult.evidence![2]!.matched).toBe(true);

      // Excluded user transcoding 4K → should NOT trigger
      const excludedCtx = createTestContext(rule, {
        session: createMockSession({
          isTranscode: true,
          videoDecision: 'transcode',
          sourceVideoWidth: 3840,
          sourceVideoHeight: 2160,
        }),
        serverUser: createMockServerUser({ id: excludedUserId }),
      });

      const excludedResult = await evaluateRuleAsync(excludedCtx);
      expect(excludedResult.matched).toBe(false);
      // Evidence is only returned for matching rules (by design in evaluateRuleAsync)
      expect(excludedResult.evidence).toBeUndefined();

      // Excluded user NOT transcoding → should NOT trigger (group 1 fails)
      const excludedDirectPlayCtx = createTestContext(rule, {
        session: createMockSession({
          isTranscode: false,
          videoDecision: 'directplay',
          sourceVideoWidth: 3840,
          sourceVideoHeight: 2160,
        }),
        serverUser: createMockServerUser({ id: excludedUserId }),
      });

      expect((await evaluateRuleAsync(excludedDirectPlayCtx)).matched).toBe(false);

      // Non-excluded user direct-playing 4K → should NOT trigger (group 1 fails)
      const otherDirectPlayCtx = createTestContext(rule, {
        session: createMockSession({
          isTranscode: false,
          videoDecision: 'directplay',
          sourceVideoWidth: 3840,
          sourceVideoHeight: 2160,
        }),
        serverUser: createMockServerUser({ id: 'other-user-456' }),
      });

      expect((await evaluateRuleAsync(otherDirectPlayCtx)).matched).toBe(false);
    });

    it('not_in with non-array value falls back to neq (defensive)', async () => {
      const excludedUserId = 'owner-uuid-123';
      const rule = createMockRule({
        conditions: {
          groups: [
            {
              conditions: [
                // Value stored as string instead of array (data corruption scenario)
                {
                  field: 'user_id',
                  operator: 'not_in',
                  value: excludedUserId,
                },
              ],
            },
          ],
        },
      });

      // Excluded user → condition should NOT match (defensive fallback to neq)
      const excludedCtx = createTestContext(rule, {
        serverUser: createMockServerUser({ id: excludedUserId }),
      });
      expect((await evaluateRuleAsync(excludedCtx)).matched).toBe(false);

      // Other user → condition SHOULD match
      const otherCtx = createTestContext(rule, {
        serverUser: createMockServerUser({ id: 'other-user-456' }),
      });
      expect((await evaluateRuleAsync(otherCtx)).matched).toBe(true);
    });

    it('mobile bypass works (device NOT IN [mobile])', async () => {
      const rule = createMockRule({
        conditions: {
          groups: [
            { conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 1 }] },
            { conditions: [{ field: 'device_type', operator: 'not_in', value: ['mobile'] }] },
          ],
        },
      });

      // Desktop with 2 streams should match
      const desktopCtx = createTestContext(rule, {
        serverUser: createMockServerUser({ id: 'user-1' }),
        session: createMockSession({ device: 'Chrome', platform: 'Windows', deviceId: 'device-1' }),
        activeSessions: [
          createMockSession({
            serverUserId: 'user-1',
            device: 'Chrome',
            platform: 'Windows',
            deviceId: 'device-1',
          }),
          createMockSession({
            serverUserId: 'user-1',
            device: 'Chrome',
            platform: 'Windows',
            deviceId: 'device-2',
          }),
        ],
      });

      expect((await evaluateRuleAsync(desktopCtx)).matched).toBe(true);

      // Mobile with 2 streams should not match (bypassed)
      const mobileCtx = createTestContext(rule, {
        serverUser: createMockServerUser({ id: 'user-1' }),
        session: createMockSession({ device: 'iPhone', platform: 'iOS', deviceId: 'device-3' }),
        activeSessions: [
          createMockSession({
            serverUserId: 'user-1',
            device: 'iPhone',
            platform: 'iOS',
            deviceId: 'device-3',
          }),
          createMockSession({
            serverUserId: 'user-1',
            device: 'iPhone',
            platform: 'iOS',
            deviceId: 'device-4',
          }),
        ],
      });

      expect((await evaluateRuleAsync(mobileCtx)).matched).toBe(false);
    });
  });
});

describe('session-less context', () => {
  it.each(['concurrent_streams', 'active_session_distance_km', 'travel_speed_kmh'] as const)(
    'never matches a group whose conditions all need a session: %s',
    async (field) => {
      const rule = createMockRule({
        conditions: {
          groups: [
            { conditions: [{ field: 'trust_score', operator: 'lt', value: 50 }] },
            { conditions: [{ field, operator: 'lt', value: 1 }] },
          ],
        },
      });
      const ctx = {
        ...createTestContext(rule),
        session: null,
        serverUser: createMockServerUser({ trustScore: 10 }),
        activeSessions: [],
        recentSessions: [],
      };

      const result = await evaluateRuleAsync(ctx);

      expect(result.matched).toBe(false);
    }
  );

  it('matches on the account condition when a session condition shares the group', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const rule = createMockRule({
      conditions: {
        groups: [
          {
            conditions: [
              { field: 'inactive_days', operator: 'gte', value: 30 },
              { field: 'trust_score', operator: 'lt', value: 50 },
            ],
          },
        ],
      },
    });
    const ctx = {
      ...createTestContext(rule),
      session: null,
      serverUser: createMockServerUser({ trustScore: 30, lastActivityAt: tenDaysAgo }),
      activeSessions: [],
    };

    const result = await evaluateRuleAsync(ctx);

    expect(result.matched).toBe(true);
  });

  it('runs inactive_days through the registry without a session', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const rule = createMockRule({
      conditions: {
        groups: [{ conditions: [{ field: 'inactive_days', operator: 'in', value: [10, 20] }] }],
      },
    });
    const ctx = {
      ...createTestContext(rule),
      session: null,
      serverUser: createMockServerUser({ lastActivityAt: tenDaysAgo }),
      activeSessions: [],
    };

    const result = await evaluateRuleAsync(ctx);

    expect(result.matched).toBe(true);
  });
});

describe('a field the context cannot supply', () => {
  it('is unmatched without evaluating, on a server-only context', async () => {
    const rule = createMockRule({
      conditions: {
        groups: [{ conditions: [{ field: 'trust_score', operator: 'lt', value: 50 }] }],
      },
    });
    const ctx = {
      ...createTestContext(rule),
      session: null,
      serverUser: null,
      subjectKey: 'server:server-1',
      activeSessions: [],
      recentSessions: [],
    };

    const result = await evaluateRuleAsync(ctx);

    expect(result.matched).toBe(false);
    expect(result.stoppedBy?.conditions[0]).toMatchObject({ actual: null, matched: false });
  });

  it('still evaluates server_id on a server-only context', async () => {
    const rule = createMockRule({
      conditions: {
        groups: [{ conditions: [{ field: 'server_id', operator: 'eq', value: 'server-1' }] }],
      },
    });
    const ctx = {
      ...createTestContext(rule),
      session: null,
      serverUser: null,
      subjectKey: 'server:server-1',
      activeSessions: [],
      recentSessions: [],
    };

    const result = await evaluateRuleAsync(ctx);

    expect(result.matched).toBe(true);
  });

  it('reads a media field on a media context and nothing about a session', async () => {
    const mediaContext = (rule: EngineAutomation) => ({
      ...createTestContext(rule),
      session: null,
      serverUser: null,
      subjectKey: 'media:item-1',
      activeSessions: [],
      recentSessions: [],
      media: {
        libraryItemId: 'item-1',
        ratingKey: 'rk-1',
        mediaId: null,
        parentTitle: null,
        grandparentRatingKey: null,
        parentRatingKey: null,
        parentIndex: null,
        itemIndex: null,
        imdbId: null,
        tmdbId: null,
        tvdbId: null,
        thumbPath: null,
        title: 'Cars',
        grandparentTitle: null,
        type: 'movie',
        year: 2006,
        libraryId: '1',
        libraryName: 'Movies',
        quality: {
          resolution: '4k',
          dynamicRange: 'hdr10',
          videoCodec: 'HEVC',
          audioCodec: 'TRUEHD',
          audioChannels: 8,
          fileSize: 42_000_000_000,
        },
      },
    });

    const ranked = createMockRule({
      conditions: {
        groups: [{ conditions: [{ field: 'resolution_after', operator: 'gte', value: '4K' }] }],
      },
    });
    expect((await evaluateRuleAsync(mediaContext(ranked))).matched).toBe(true);

    const tooHigh = createMockRule({
      conditions: {
        groups: [{ conditions: [{ field: 'resolution_after', operator: 'gte', value: '8K' }] }],
      },
    });
    expect((await evaluateRuleAsync(mediaContext(tooHigh))).matched).toBe(false);

    const sessionField = createMockRule({
      conditions: {
        groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'gte', value: 2 }] }],
      },
    });
    const result = await evaluateRuleAsync(mediaContext(sessionField));
    expect(result.matched).toBe(false);
    expect(result.stoppedBy?.conditions[0]).toMatchObject({ actual: null, matched: false });
  });

  it('leaves an install context with nothing to read', async () => {
    const rule = createMockRule({
      conditions: {
        groups: [{ conditions: [{ field: 'server_id', operator: 'eq', value: 'server-1' }] }],
      },
    });
    const ctx = {
      ...createTestContext(rule),
      session: null,
      serverUser: null,
      server: null,
      subjectKey: 'install',
      activeSessions: [],
      recentSessions: [],
    };

    const result = await evaluateRuleAsync(ctx);

    expect(result.matched).toBe(false);
  });
});

describe('evaluateRulesAsync', () => {
  it('returns only matching rules', async () => {
    const rules: EngineAutomation[] = [
      createMockRule({
        id: 'rule-1',
        conditions: {
          groups: [{ conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] }],
        },
        actions: { actions: [{ type: 'trust', mode: 'reset' }] },
      }),
      createMockRule({
        id: 'rule-2',
        conditions: {
          groups: [{ conditions: [{ field: 'is_transcoding', operator: 'eq', value: false }] }],
        },
        actions: { actions: [{ type: 'send', to: ['11111111-1111-4111-8111-111111111111'] }] },
      }),
    ];

    const server = createMockServer();
    const serverUser = createMockServerUser({ serverId: server.id });
    const session = createMockSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      isTranscode: true,
    });

    const results = await evaluateRulesAsync(
      {
        session,
        serverUser,
        server,
        media: null,
        subjectKey: session.id,
        activeSessions: [session],
        recentSessions: [session],
      },
      rules
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.ruleId).toBe('rule-1');
  });

  it('skips inactive rules', async () => {
    const rules: EngineAutomation[] = [
      createMockRule({
        id: 'rule-1',
        isActive: false,
        conditions: { groups: [] },
      }),
      createMockRule({
        id: 'rule-2',
        isActive: true,
        conditions: { groups: [] },
      }),
    ];

    const server = createMockServer();
    const serverUser = createMockServerUser({ serverId: server.id });
    const session = createMockSession({ serverId: server.id, serverUserId: serverUser.id });

    const results = await evaluateRulesAsync(
      {
        session,
        serverUser,
        server,
        media: null,
        subjectKey: session.id,
        activeSessions: [session],
        recentSessions: [session],
      },
      rules
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.ruleId).toBe('rule-2');
  });

  it('respects server scope', async () => {
    const rules: EngineAutomation[] = [
      createMockRule({
        id: 'rule-1',
        serverId: 'server-1',
        conditions: { groups: [] },
      }),
      createMockRule({
        id: 'rule-2',
        serverId: 'server-2',
        conditions: { groups: [] },
      }),
      createMockRule({
        id: 'rule-3',
        serverId: null, // Global rule
        conditions: { groups: [] },
      }),
    ];

    const server = createMockServer({ id: 'server-1' });
    const serverUser = createMockServerUser({ serverId: server.id });
    const session = createMockSession({ serverId: server.id, serverUserId: serverUser.id });

    const results = await evaluateRulesAsync(
      {
        session,
        serverUser,
        server,
        media: null,
        subjectKey: session.id,
        activeSessions: [session],
        recentSessions: [session],
      },
      rules
    );

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.ruleId).sort()).toEqual(['rule-1', 'rule-3']);
  });

  it('respects person (identity) scope', async () => {
    const rules: EngineAutomation[] = [
      createMockRule({
        id: 'rule-person-a',
        userId: 'identity-a',
        conditions: { groups: [] },
      }),
      createMockRule({
        id: 'rule-person-b',
        userId: 'identity-b',
        conditions: { groups: [] },
      }),
      createMockRule({
        id: 'rule-global',
        userId: null,
        conditions: { groups: [] },
      }),
    ];

    const server = createMockServer();
    const serverUser = createMockServerUser({ serverId: server.id, userId: 'identity-a' });
    const session = createMockSession({ serverId: server.id, serverUserId: serverUser.id });

    const results = await evaluateRulesAsync(
      {
        session,
        serverUser,
        server,
        media: null,
        subjectKey: session.id,
        activeSessions: [session],
        recentSessions: [session],
      },
      rules
    );

    expect(results.map((r) => r.ruleId).sort()).toEqual(['rule-global', 'rule-person-a']);
  });

  it('a person-scoped rule applies to a second server_user of the same identity', async () => {
    const rule = createMockRule({
      id: 'rule-person-a',
      userId: 'identity-a',
      conditions: { groups: [] },
    });

    const serverA = createMockServer({ id: 'server-a' });
    const serverB = createMockServer({ id: 'server-b' });
    const serverUserOnA = createMockServerUser({
      id: 'su-a',
      serverId: serverA.id,
      userId: 'identity-a',
    });
    const serverUserOnB = createMockServerUser({
      id: 'su-b',
      serverId: serverB.id,
      userId: 'identity-a',
    });
    const sessionA = createMockSession({ serverId: serverA.id, serverUserId: serverUserOnA.id });
    const sessionB = createMockSession({ serverId: serverB.id, serverUserId: serverUserOnB.id });

    const resultsA = await evaluateRulesAsync(
      {
        session: sessionA,
        serverUser: serverUserOnA,
        server: serverA,
        media: null,
        subjectKey: sessionA.id,
        activeSessions: [sessionA],
        recentSessions: [sessionA],
      },
      [rule]
    );
    const resultsB = await evaluateRulesAsync(
      {
        session: sessionB,
        serverUser: serverUserOnB,
        server: serverB,
        media: null,
        subjectKey: sessionB.id,
        activeSessions: [sessionB],
        recentSessions: [sessionB],
      },
      [rule]
    );

    expect(resultsA.map((r) => r.ruleId)).toEqual(['rule-person-a']);
    expect(resultsB.map((r) => r.ruleId)).toEqual(['rule-person-a']);
  });

  it('returns the unmatched results too under includeUnmatched', async () => {
    const rules: EngineAutomation[] = [
      createMockRule({
        id: 'rule-hit',
        conditions: {
          groups: [{ conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] }],
        },
      }),
      createMockRule({
        id: 'rule-miss',
        conditions: {
          groups: [{ conditions: [{ field: 'is_transcoding', operator: 'eq', value: false }] }],
        },
      }),
      createMockRule({ id: 'rule-out-of-scope', serverId: 'server-2', conditions: { groups: [] } }),
    ];

    const server = createMockServer({ id: 'server-1' });
    const serverUser = createMockServerUser({ serverId: server.id });
    const session = createMockSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      isTranscode: true,
    });
    const context = {
      session,
      serverUser,
      server,
      media: null,
      subjectKey: session.id,
      activeSessions: [session],
      recentSessions: [session],
    };

    const included = await evaluateRulesAsync(context, rules, { includeUnmatched: true });
    const excluded = await evaluateRulesAsync(context, rules);

    expect(included.map((r) => [r.ruleId, r.matched])).toEqual([
      ['rule-hit', true],
      ['rule-miss', false],
    ]);
    expect(excluded.map((r) => r.ruleId)).toEqual(['rule-hit']);
  });

  it('respects account scope', async () => {
    const server = createMockServer();
    const targetAccount = createMockServerUser({
      id: 'su-target',
      serverId: server.id,
      userId: 'identity-a',
    });
    const siblingAccount = createMockServerUser({
      id: 'su-sibling',
      serverId: server.id,
      userId: 'identity-a',
    });
    const unrelatedAccount = createMockServerUser({
      id: 'su-unrelated',
      serverId: server.id,
      userId: 'identity-b',
    });

    const rule = createMockRule({
      id: 'rule-account',
      serverUserId: targetAccount.id,
      conditions: { groups: [] },
    });

    const evaluateFor = (serverUser: ReturnType<typeof createMockServerUser>) => {
      const session = createMockSession({ serverId: server.id, serverUserId: serverUser.id });
      return evaluateRulesAsync(
        {
          session,
          serverUser,
          server,
          media: null,
          subjectKey: session.id,
          activeSessions: [session],
          recentSessions: [session],
        },
        [rule]
      );
    };

    expect((await evaluateFor(targetAccount)).map((r) => r.ruleId)).toEqual(['rule-account']);
    expect(await evaluateFor(siblingAccount)).toHaveLength(0);
    expect(await evaluateFor(unrelatedAccount)).toHaveLength(0);
  });
});

describe('ruleAppliesTo', () => {
  const baseContext = () => {
    const server = createMockServer({ id: 'server-1' });
    const serverUser = createMockServerUser({ id: 'su-1', serverId: server.id, userId: 'ident-1' });
    const session = createMockSession({ serverId: server.id, serverUserId: serverUser.id });
    return {
      session,
      serverUser,
      server,
      media: null,
      subjectKey: session.id,
      activeSessions: [session],
      recentSessions: [session],
    };
  };

  it('rejects an inactive rule', () => {
    expect(ruleAppliesTo(createMockRule({ isActive: false }), baseContext())).toBe(false);
    expect(ruleAppliesTo(createMockRule({ isActive: true }), baseContext())).toBe(true);
  });

  it('rejects another server', () => {
    expect(ruleAppliesTo(createMockRule({ serverId: 'server-2' }), baseContext())).toBe(false);
    expect(ruleAppliesTo(createMockRule({ serverId: 'server-1' }), baseContext())).toBe(true);
  });

  it('rejects another account', () => {
    expect(ruleAppliesTo(createMockRule({ serverUserId: 'su-2' }), baseContext())).toBe(false);
    expect(ruleAppliesTo(createMockRule({ serverUserId: 'su-1' }), baseContext())).toBe(true);
  });

  it('rejects another identity', () => {
    expect(ruleAppliesTo(createMockRule({ userId: 'ident-2' }), baseContext())).toBe(false);
    expect(ruleAppliesTo(createMockRule({ userId: 'ident-1' }), baseContext())).toBe(true);
  });

  describe('without a user', () => {
    const serverContext = () => ({
      ...baseContext(),
      session: null,
      serverUser: null,
      subjectKey: 'server:server-1',
    });

    it('keeps a server-scoped automation and drops account and person scopes', () => {
      expect(ruleAppliesTo(createMockRule({ serverId: 'server-1' }), serverContext())).toBe(true);
      expect(ruleAppliesTo(createMockRule({ serverId: 'server-2' }), serverContext())).toBe(false);
      expect(ruleAppliesTo(createMockRule({ serverUserId: 'su-1' }), serverContext())).toBe(false);
      expect(ruleAppliesTo(createMockRule({ userId: 'ident-1' }), serverContext())).toBe(false);
    });

    it('drops every scope on an install context', () => {
      const install = { ...serverContext(), server: null, subjectKey: 'install' };
      expect(ruleAppliesTo(createMockRule({ serverId: 'server-1' }), install)).toBe(false);
      expect(ruleAppliesTo(createMockRule(), install)).toBe(true);
    });
  });
});
