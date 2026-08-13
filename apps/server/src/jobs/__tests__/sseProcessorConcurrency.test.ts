/**
 * SSE Processor Tests - Concurrent Session Creation
 *
 * Two concurrent 'playing' events for the same session key create exactly
 * one session. Uses the real cache service (in-memory Redis) so
 * withSessionCreateLock's NX lock does the enforcing, not a mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'events';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { createCacheService } from '../../services/cache.js';
import type { CacheService, PubSubService } from '../../services/cache.js';
import type { GeoLocation } from '../../services/geoip.js';

/** Deferred promise helper for controlling when a mocked async call resolves. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const {
  mockSseManager,
  mockEnqueueNotification,
  mockFindActiveSession,
  mockBuildPendingActiveSession,
  mockGetIdentityServerUserIds,
  mockLookupGeoIP,
  mockMapMediaSession,
  mockCreateMediaServerClient,
  mockDb,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events');
  return {
    mockSseManager: new EE() as EventEmitter,
    mockEnqueueNotification: vi.fn().mockResolvedValue('job-id'),
    mockFindActiveSession: vi.fn().mockResolvedValue(null),
    mockBuildPendingActiveSession: vi.fn().mockImplementation((data) => ({
      id: data.id,
      serverId: data.server.id,
      sessionKey: data.processed.sessionKey,
      mediaTitle: data.processed.mediaTitle,
      state: data.currentState,
    })),
    mockGetIdentityServerUserIds: vi.fn().mockResolvedValue(['server-user-1']),
    mockLookupGeoIP: vi.fn(),
    mockMapMediaSession: vi.fn(),
    mockCreateMediaServerClient: vi.fn().mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([{ sessionKey: 'test-session-key' }]),
    }),
    mockDb: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: 'server-1',
                name: 'Test Server',
                type: 'plex',
                url: 'http://localhost:32400',
                token: 'test-token',
              },
            ]),
          }),
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: 'server-user-1',
                  userId: 'identity-1',
                  username: 'alice',
                  thumbUrl: null,
                  identityName: 'Alice',
                  trustScore: 100,
                  lastActivityAt: new Date(),
                  createdAt: new Date(),
                },
              ]),
            }),
          }),
        }),
      }),
    },
  };
});

vi.mock('../../services/sseManager.js', () => ({ sseManager: mockSseManager }));
vi.mock('../notificationQueue.js', () => ({ enqueueNotification: mockEnqueueNotification }));
vi.mock('../../db/client.js', () => ({ db: mockDb }));
vi.mock('../../services/mediaServer/index.js', () => ({
  createMediaServerClient: mockCreateMediaServerClient,
}));
vi.mock('../../services/plexGeoip.js', () => ({ lookupGeoIP: mockLookupGeoIP }));
vi.mock('../../services/userService.js', () => ({
  getIdentityServerUserIds: mockGetIdentityServerUserIds,
  canonicalPlexExternalUserId: vi.fn(async (id: string) => id),
}));
vi.mock('../../routes/settings.js', () => ({
  getGeoIPSettings: vi.fn().mockResolvedValue({ usePlexGeoip: false }),
}));
vi.mock('../poller/index.js', () => ({ triggerReconciliationPoll: vi.fn() }));
vi.mock('../poller/sessionMapper.js', () => ({
  mapMediaSession: mockMapMediaSession,
  pickStreamDetailFields: vi.fn().mockImplementation((s) => s),
}));
vi.mock('../poller/stateTracker.js', () => ({
  calculatePauseAccumulation: vi.fn(),
  checkWatchCompletion: vi.fn(),
  detectMediaChange: vi.fn().mockReturnValue(false),
  isPlaybackConfirmed: vi.fn().mockReturnValue(false),
  createInitialConfirmationState: vi.fn().mockReturnValue({
    confirmedPlayback: false,
    firstSeenAt: Date.now(),
    maxViewOffset: 0,
  }),
  updateConfirmationState: vi.fn().mockImplementation((state) => state),
}));
vi.mock('../poller/database.js', () => ({
  getServerUserIdByExternalId: vi.fn(() => {
    throw new Error('getServerUserIdByExternalId not configured in this test');
  }),
  getActiveRulesV2: vi.fn().mockResolvedValue([]),
  batchGetLibraryItemIdentity: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  mergeRecentSessionsForIdentity: vi.fn().mockReturnValue([]),
}));
vi.mock('../poller/dbWriteThrottle.js', () => ({
  clearDbWriteTracking: vi.fn(),
  recordDbWrite: vi.fn(),
  shouldFlushDbWrite: vi.fn().mockReturnValue(false),
}));
vi.mock('../poller/violations.js', () => ({ broadcastViolations: vi.fn() }));
vi.mock('../poller/sessionLifecycle.js', () => ({
  stopSessionAtomic: vi.fn(),
  findActiveSession: mockFindActiveSession,
  findActiveSessionsAll: vi.fn().mockResolvedValue([]),
  buildActiveSession: vi.fn(),
  buildPendingActiveSession: mockBuildPendingActiveSession,
  handleMediaChangeAtomic: vi.fn(),
  handleQualityChangeFallout: vi.fn(),
  reEvaluateRulesOnPauseState: vi.fn(),
  reEvaluateRulesOnTranscodeChange: vi.fn(),
  confirmAndPersistSession: vi.fn(),
}));
vi.mock('../../services/serviceTracker.js', () => ({
  registerService: vi.fn(),
  unregisterService: vi.fn(),
}));

import { initializeSSEProcessor, startSSEProcessor, stopSSEProcessor } from '../sseProcessor.js';

const mockGeo: GeoLocation = {
  city: null,
  region: null,
  country: null,
  countryCode: null,
  continent: null,
  postal: null,
  lat: null,
  lon: null,
  asnNumber: null,
  asnOrganization: null,
};

const mockPubSubService: PubSubService = {
  publish: vi.fn(),
  subscribe: vi.fn(),
} as unknown as PubSubService;

describe('SSE Processor - Concurrent Session Creation', () => {
  let cacheService: CacheService;
  let addActiveSessionSpy: ReturnType<typeof vi.fn<CacheService['addActiveSession']>>;
  let setPendingSessionSpy: ReturnType<typeof vi.fn<CacheService['setPendingSession']>>;

  beforeEach(() => {
    vi.clearAllMocks();

    const realCacheService = createCacheService(createMockRedis());
    addActiveSessionSpy = vi.fn<CacheService['addActiveSession']>((session) =>
      realCacheService.addActiveSession(session)
    );
    setPendingSessionSpy = vi.fn<CacheService['setPendingSession']>((...args) =>
      realCacheService.setPendingSession(...args)
    );
    cacheService = {
      ...realCacheService,
      addActiveSession: addActiveSessionSpy,
      setPendingSession: setPendingSessionSpy,
    };

    mockMapMediaSession.mockReturnValue({
      sessionKey: 'test-session-key',
      ratingKey: '12345',
      externalUserId: 'user-123',
      username: 'alice',
      ipAddress: '1.2.3.4',
      mediaTitle: 'Test Movie',
      mediaType: 'movie',
      state: 'playing',
    });

    initializeSSEProcessor(cacheService, mockPubSubService);
    startSSEProcessor();
  });

  afterEach(() => {
    stopSSEProcessor();
  });

  it('two concurrent playing events for the same key create exactly one session', async () => {
    const geoGate = deferred<GeoLocation>();
    mockLookupGeoIP.mockReturnValue(geoGate.promise);

    mockSseManager.emit('plex:session:playing', {
      serverId: 'server-1',
      notification: { sessionKey: 'test-session-key', viewOffset: 0 },
    });
    mockSseManager.emit('plex:session:playing', {
      serverId: 'server-1',
      notification: { sessionKey: 'test-session-key', viewOffset: 0 },
    });

    // Both calls are parked here, before either has written anything.
    await vi.waitFor(() => expect(mockLookupGeoIP).toHaveBeenCalledTimes(2));

    geoGate.resolve(mockGeo);

    await vi.waitFor(() => expect(addActiveSessionSpy).toHaveBeenCalled());

    expect(addActiveSessionSpy).toHaveBeenCalledTimes(1);
    expect(setPendingSessionSpy).toHaveBeenCalledTimes(1);

    const startedNotifications = mockEnqueueNotification.mock.calls.filter(
      (call) => call[0]?.type === 'session_started'
    );
    expect(startedNotifications).toHaveLength(1);

    const pendingKeys = await cacheService.getAllPendingSessionKeys();
    expect(pendingKeys).toHaveLength(1);
  });
});
