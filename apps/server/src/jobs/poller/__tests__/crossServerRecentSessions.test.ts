/**
 * Cross-server recent session widening tests
 *
 * The windowed rule evaluators (unique_ips_in_window, unique_devices_in_window,
 * travel_speed_kmh) read context.recentSessions. The poller and SSE paths
 * populate recentSessions per server_user via batchGetRecentUserSessions,
 * which only ever queries the ids it's given. For a merged identity (more
 * than one server_user), the triggering server_user's own recentSessions
 * never contains its sibling server_user's rows unless something explicitly
 * widens the fetch - these tests pin that widening.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Session, Condition, EngineAutomation, ServerUser, Server } from '@tracearr/shared';
import { synthesizeTriggers } from '../../../services/automations/triggers.js';
import { evaluatorRegistry } from '../../../services/automations/evaluators/index.js';
import type { SessionEvaluationContext } from '../../../services/automations/types.js';

// ============================================================================
// DB mock - only exercised by widenRecentSessionsForMergedIdentities'
// supplemental fetch for sibling ids not already in the map.
// ============================================================================

let supplementalRows: Record<string, unknown>[] = [];

vi.mock('../../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const promise = Promise.resolve(supplementalRows);
          return Object.assign(promise, {
            orderBy: () => Object.assign(promise, { limit: () => promise }),
          });
        },
      }),
    }),
  },
}));

import {
  mergeRecentSessionsForIdentity,
  widenRecentSessionsForMergedIdentities,
} from '../database.js';

// ============================================================================
// Fixtures
// ============================================================================

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

function createCondition(overrides: Partial<Condition>): Condition {
  return {
    field: 'unique_ips_in_window',
    operator: 'eq',
    value: 1,
    ...overrides,
  };
}

function matched(result: ReturnType<(typeof evaluatorRegistry)['unique_ips_in_window']>): boolean {
  if (result instanceof Promise) {
    throw new Error('Use await for async evaluators');
  }
  return result.matched;
}

// ============================================================================
// mergeRecentSessionsForIdentity
// ============================================================================

describe('mergeRecentSessionsForIdentity', () => {
  it('combines sessions from every id, deduplicated by session id', () => {
    const sessionA = createMockSession({ id: 's-a', serverUserId: 'su-1' });
    const sessionB = createMockSession({ id: 's-b', serverUserId: 'su-2' });
    const map = new Map<string, Session[]>([
      ['su-1', [sessionA]],
      ['su-2', [sessionB]],
    ]);

    const combined = mergeRecentSessionsForIdentity(map, ['su-1', 'su-2']);

    expect(combined.map((s) => s.id).sort()).toEqual(['s-a', 's-b']);
  });

  it('never counts the same session twice when it surfaces under two ids', () => {
    const sessionA = createMockSession({ id: 's-a', serverUserId: 'su-1' });
    const map = new Map<string, Session[]>([
      ['su-1', [sessionA]],
      ['su-2', [sessionA]],
    ]);

    const combined = mergeRecentSessionsForIdentity(map, ['su-1', 'su-2']);

    expect(combined).toHaveLength(1);
  });
});

// ============================================================================
// widenRecentSessionsForMergedIdentities (plumbing)
// ============================================================================

describe('widenRecentSessionsForMergedIdentities', () => {
  it('widens a merged identity with one supplemental query, without leaking into an unrelated server_user on the same server', async () => {
    const sessionA = createMockSession({ id: 's-a', serverUserId: 'su-1', ipAddress: '1.1.1.1' });
    const sessionCRow = createMockSession({
      id: 's-c',
      serverUserId: 'su-3',
      ipAddress: '9.9.9.9',
    });

    const recentSessionsMap = new Map<string, Session[]>([
      ['su-1', [sessionA]],
      ['su-3', [sessionCRow]], // unrelated identity, same server
    ]);

    const identityServerUserIdsMap = new Map<string, string[]>([
      ['identity-1', ['su-1', 'su-2']], // merged - su-2 not yet in the map
      ['identity-3', ['su-3']], // unmerged
    ]);

    supplementalRows = [
      createMockSession({
        id: 's-b',
        serverUserId: 'su-2',
        ipAddress: '2.2.2.2',
      }) as unknown as Record<string, unknown>,
    ];

    await widenRecentSessionsForMergedIdentities(recentSessionsMap, identityServerUserIdsMap);

    const su1Sessions = recentSessionsMap.get('su-1') ?? [];
    const su2Sessions = recentSessionsMap.get('su-2') ?? [];
    const su3Sessions = recentSessionsMap.get('su-3') ?? [];

    expect(su1Sessions.map((s) => s.id).sort()).toEqual(['s-a', 's-b']);
    expect(su2Sessions.map((s) => s.id).sort()).toEqual(['s-a', 's-b']);
    // Unrelated same-server identity must be untouched - no sibling leakage.
    expect(su3Sessions.map((s) => s.id)).toEqual(['s-c']);
  });

  it('does not query the database at all when no identity has more than one server_user', async () => {
    const sessionA = createMockSession({ id: 's-a', serverUserId: 'su-1' });
    const recentSessionsMap = new Map<string, Session[]>([['su-1', [sessionA]]]);
    const identityServerUserIdsMap = new Map<string, string[]>([['identity-1', ['su-1']]]);

    supplementalRows = [
      createMockSession({ id: 'should-not-appear', serverUserId: 'su-9' }) as unknown as Record<
        string,
        unknown
      >,
    ];

    await widenRecentSessionsForMergedIdentities(recentSessionsMap, identityServerUserIdsMap);

    expect(recentSessionsMap.get('su-1')?.map((s) => s.id)).toEqual(['s-a']);
  });
});

// ============================================================================
// Full pipeline: widened recentSessions feeding the real evaluators
// ============================================================================

function createTestContext(
  overrides: Partial<SessionEvaluationContext> = {}
): SessionEvaluationContext {
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
    rule: createMockRule(),
    ...overrides,
  };
}

describe('cross-server aggregation feeding the windowed evaluators', () => {
  it('unique_ips_in_window trips a threshold that neither server user reaches alone, only once sibling sessions are merged in', async () => {
    const now = new Date();
    const currentSession = createMockSession({
      id: 'current',
      serverUserId: 'su-1',
      startedAt: now,
      ipAddress: '1.1.1.1',
    });
    const ownHistory = createMockSession({
      id: 'own-history',
      serverUserId: 'su-1',
      startedAt: new Date(now.getTime() - 60 * 60 * 1000),
      ipAddress: '2.2.2.2',
    });
    const siblingHistory = createMockSession({
      id: 'sibling-history',
      serverUserId: 'su-2',
      startedAt: new Date(now.getTime() - 30 * 60 * 1000),
      ipAddress: '3.3.3.3',
    });

    const recentSessionsMap = new Map<string, Session[]>([['su-1', [ownHistory]]]);
    const identityServerUserIdsMap = new Map<string, string[]>([['identity-1', ['su-1', 'su-2']]]);
    supplementalRows = [siblingHistory as unknown as Record<string, unknown>];

    const condition = createCondition({
      field: 'unique_ips_in_window',
      operator: 'eq',
      value: 3,
      params: { window_hours: 24 },
    });

    // Before widening: only su-1's own data is available (the inert case).
    const inertContext = createTestContext({
      session: currentSession,
      serverUser: createMockServerUser({ id: 'su-1' }),
      recentSessions: recentSessionsMap.get('su-1') ?? [],
      identityServerUserIds: ['su-1', 'su-2'],
    });
    expect(matched(evaluatorRegistry.unique_ips_in_window(inertContext, condition))).toBe(false);

    await widenRecentSessionsForMergedIdentities(recentSessionsMap, identityServerUserIdsMap);

    const widenedContext = createTestContext({
      session: currentSession,
      serverUser: createMockServerUser({ id: 'su-1' }),
      recentSessions: recentSessionsMap.get('su-1') ?? [],
      identityServerUserIds: ['su-1', 'su-2'],
    });
    expect(matched(evaluatorRegistry.unique_ips_in_window(widenedContext, condition))).toBe(true);
  });

  it('unique_devices_in_window counts devices across every server of the identity once merged', async () => {
    const now = new Date();
    const currentSession = createMockSession({
      id: 'current',
      serverUserId: 'su-1',
      startedAt: now,
      deviceId: 'device-current',
    });
    const ownHistory = createMockSession({
      id: 'own-history',
      serverUserId: 'su-1',
      startedAt: new Date(now.getTime() - 60 * 60 * 1000),
      deviceId: 'device-a',
    });
    const siblingHistory = createMockSession({
      id: 'sibling-history',
      serverUserId: 'su-2',
      startedAt: new Date(now.getTime() - 30 * 60 * 1000),
      deviceId: 'device-b',
    });

    const recentSessionsMap = new Map<string, Session[]>([['su-1', [ownHistory]]]);
    const identityServerUserIdsMap = new Map<string, string[]>([['identity-1', ['su-1', 'su-2']]]);
    supplementalRows = [siblingHistory as unknown as Record<string, unknown>];

    const condition = createCondition({
      field: 'unique_devices_in_window',
      operator: 'eq',
      value: 3,
      params: { window_hours: 24 },
    });

    const inertContext = createTestContext({
      session: currentSession,
      serverUser: createMockServerUser({ id: 'su-1' }),
      recentSessions: recentSessionsMap.get('su-1') ?? [],
      identityServerUserIds: ['su-1', 'su-2'],
    });
    expect(matched(evaluatorRegistry.unique_devices_in_window(inertContext, condition))).toBe(
      false
    );

    await widenRecentSessionsForMergedIdentities(recentSessionsMap, identityServerUserIdsMap);

    const widenedContext = createTestContext({
      session: currentSession,
      serverUser: createMockServerUser({ id: 'su-1' }),
      recentSessions: recentSessionsMap.get('su-1') ?? [],
      identityServerUserIds: ['su-1', 'su-2'],
    });
    expect(matched(evaluatorRegistry.unique_devices_in_window(widenedContext, condition))).toBe(
      true
    );
  });

  it('travel_speed_kmh only detects impossible travel once the sibling server session is merged in', async () => {
    const now = new Date();
    const currentSession = createMockSession({
      id: 'current',
      serverUserId: 'su-1',
      startedAt: now,
      geoLat: 40.7128, // New York
      geoLon: -74.006,
      deviceId: 'device-current',
    });
    const siblingHistory = createMockSession({
      id: 'sibling-history',
      serverUserId: 'su-2',
      startedAt: new Date(now.getTime() - 60 * 60 * 1000), // 1 hour ago
      geoLat: 51.5074, // London
      geoLon: -0.1278,
      deviceId: 'device-b',
    });

    // su-1 has no other recent history of its own - this is the inert case:
    // there is nothing to compare against without the sibling's session.
    const recentSessionsMap = new Map<string, Session[]>([['su-1', []]]);
    const identityServerUserIdsMap = new Map<string, string[]>([['identity-1', ['su-1', 'su-2']]]);
    supplementalRows = [siblingHistory as unknown as Record<string, unknown>];

    const condition = createCondition({
      field: 'travel_speed_kmh',
      operator: 'gte',
      value: 1000,
    });

    const inertContext = createTestContext({
      session: currentSession,
      serverUser: createMockServerUser({ id: 'su-1' }),
      recentSessions: recentSessionsMap.get('su-1') ?? [],
      identityServerUserIds: ['su-1', 'su-2'],
    });
    expect(matched(evaluatorRegistry.travel_speed_kmh(inertContext, condition))).toBe(false);

    await widenRecentSessionsForMergedIdentities(recentSessionsMap, identityServerUserIdsMap);

    const widenedContext = createTestContext({
      session: currentSession,
      serverUser: createMockServerUser({ id: 'su-1' }),
      recentSessions: recentSessionsMap.get('su-1') ?? [],
      identityServerUserIds: ['su-1', 'su-2'],
    });
    expect(matched(evaluatorRegistry.travel_speed_kmh(widenedContext, condition))).toBe(true);
  });
});
