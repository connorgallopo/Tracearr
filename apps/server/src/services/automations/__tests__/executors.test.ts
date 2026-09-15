import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  ActiveSession,
  Action,
  EngineAutomation,
  LeafAction,
  ViolationWithDetails,
  Session,
  Server,
  ServerUser,
  SendAction,
  TrustAction,
  KillStreamAction,
  MessageClientAction,
} from '@tracearr/shared';
import { automationsLogger } from '../../../utils/logger.js';
import type { NotificationEvent, NotificationSource } from '../../notifications/events.js';
import { synthesizeTriggers } from '../triggers.js';
import {
  setActionExecutorDeps,
  resetActionExecutorDeps,
  getActionExecutorDeps,
  executeAction,
  executeActions,
  executorRegistry,
  type ActionExecutorDeps,
} from '../executors/index.js';
import type {
  AccountEvaluationContext,
  EvaluationContext,
  SessionEvaluationContext,
} from '../types.js';

// Mock factories for testing - matching actual types from @tracearr/shared
function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    sessionKey: 'abc123',
    serverId: 'server-1',
    serverUserId: 'user-1',
    state: 'playing',
    mediaType: 'movie',
    mediaTitle: 'Test Movie',
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    year: 2024,
    thumbPath: null,
    ratingKey: '12345',
    serverVersionKey: null,
    parentRatingKey: null,
    grandparentRatingKey: null,
    mediaId: null,
    showMediaId: null,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    externalSessionId: null,
    startedAt: new Date(),
    stoppedAt: null,
    durationMs: null,
    totalDurationMs: 7200000,
    progressMs: 3600000,
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
    playerName: 'Living Room TV',
    deviceId: 'device-123',
    product: 'Plex Web',
    device: 'Chrome',
    platform: 'Windows',
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
    // StreamDetailFields
    sourceVideoCodec: 'h264',
    sourceAudioCodec: 'aac',
    sourceAudioChannels: 2,
    sourceVideoWidth: 1920,
    sourceVideoHeight: 1080,
    sourceVideoDetails: null,
    sourceAudioDetails: null,
    streamVideoCodec: 'h264',
    streamAudioCodec: 'aac',
    streamVideoDetails: null,
    streamAudioDetails: null,
    transcodeInfo: null,
    subtitleInfo: null,
    ...overrides,
  };
}

function createMockServer(overrides: Partial<Server> = {}): Server {
  return {
    id: 'server-1',
    name: 'Test Server',
    type: 'plex',
    url: 'http://localhost:32400',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockServerUser(overrides: Partial<ServerUser> = {}): ServerUser {
  return {
    id: 'server-user-1',
    userId: 'user-1',
    serverId: 'server-1',
    externalId: 'plex-user-1',
    username: 'testuser',
    email: 'test@example.com',
    thumbUrl: null,
    isServerAdmin: false,
    trustScore: 100,
    joinedAt: new Date(),
    lastActivityAt: new Date(),
    removedAt: null,
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
    description: 'A test rule',
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

function createMockContext(
  overrides: Partial<SessionEvaluationContext> = {}
): SessionEvaluationContext {
  const session = createMockSession();
  return {
    session,
    server: createMockServer(),
    serverUser: createMockServerUser(),
    media: null,
    subjectKey: session.id,
    rule: createMockRule(),
    activeSessions: [session],
    recentSessions: [session],
    ...overrides,
  };
}

/** The eight-column account shape the event seam carries, from the context's ServerUser. */
function evaluationServerUser(serverUser: ServerUser) {
  return {
    id: serverUser.id,
    userId: serverUser.userId,
    username: serverUser.username,
    thumbUrl: serverUser.thumbUrl,
    identityName: serverUser.identityName ?? null,
    trustScore: serverUser.trustScore,
    lastActivityAt: serverUser.lastActivityAt,
    createdAt: serverUser.createdAt,
    identityServerUserIds: [serverUser.id],
  };
}

function createMockDeps(): ActionExecutorDeps {
  return {
    enqueueAutomationNotification: vi.fn().mockResolvedValue(1),
    adjustUserTrust: vi.fn().mockResolvedValue(undefined),
    setUserTrust: vi.fn().mockResolvedValue(undefined),
    resetUserTrust: vi.fn().mockResolvedValue(undefined),
    terminateSession: vi.fn().mockResolvedValue('kill-job-id'),
    sendClientMessage: vi.fn().mockResolvedValue(undefined),
    checkCooldown: vi.fn().mockResolvedValue(false),
    setCooldown: vi.fn().mockResolvedValue(undefined),
  };
}

/** The single enqueue the send under test made. */
function enqueueCall(): { to: string[]; event: NotificationEvent; source: NotificationSource } {
  const mock = getActionExecutorDeps().enqueueAutomationNotification as ReturnType<typeof vi.fn>;
  const call = mock.mock.calls[0];
  if (!call) throw new Error('nothing was enqueued');
  return call[0] as { to: string[]; event: NotificationEvent; source: NotificationSource };
}

describe('Action Executor Registry', () => {
  describe('Dependency Injection', () => {
    beforeEach(() => {
      resetActionExecutorDeps();
    });

    it('should use no-op dependencies by default', () => {
      const deps = getActionExecutorDeps();
      expect(deps).toBeDefined();
      // Default deps should not throw
      expect(async () => await deps.resetUserTrust('user-1', 'rule')).not.toThrow();
    });

    it('should allow setting custom dependencies', () => {
      const mockDeps = createMockDeps();
      setActionExecutorDeps(mockDeps);
      expect(getActionExecutorDeps()).toBe(mockDeps);
    });

    it('should reset to no-op dependencies', () => {
      const mockDeps = createMockDeps();
      setActionExecutorDeps(mockDeps);
      resetActionExecutorDeps();
      expect(getActionExecutorDeps()).not.toBe(mockDeps);
    });
  });

  describe('Executor Registry', () => {
    it('should have executors for all action types', () => {
      const expectedTypes = ['send', 'trust', 'kill_stream', 'message_client'];

      for (const type of expectedTypes) {
        expect(executorRegistry[type as keyof typeof executorRegistry]).toBeDefined();
        expect(typeof executorRegistry[type as keyof typeof executorRegistry]).toBe('function');
      }
    });
  });

  describe('executeAction', () => {
    let mockDeps: ActionExecutorDeps;

    beforeEach(() => {
      mockDeps = createMockDeps();
      setActionExecutorDeps(mockDeps);
    });

    afterEach(() => {
      resetActionExecutorDeps();
    });

    it('should return error for unknown action type', async () => {
      const context = createMockContext();
      const action = { type: 'unknown_type' } as unknown as LeafAction;

      const result = await executeAction(context, action);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown action type');
    });

    describe('send', () => {
      it('builds a violation event with the rule severity and real ids and names the automation', async () => {
        const context = createMockContext({ violationId: 'v1' });
        const action: SendAction = { type: 'send', to: ['d1', 'd2'], body: 'over the limit' };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.enqueueAutomationNotification).toHaveBeenCalledWith(
          expect.objectContaining({
            to: ['d1', 'd2'],
            source: {
              kind: 'automation',
              automationId: context.rule.id,
              automationName: context.rule.name,
              body: 'over the limit',
            },
            event: {
              type: 'violation',
              payload: expect.objectContaining({
                id: 'v1',
                ruleId: context.rule.id,
                serverUserId: context.serverUser.id,
                sessionId: context.session.id,
                severity: context.rule.severity,
                acknowledgedAt: null,
                rule: { id: context.rule.id, name: context.rule.name, type: null },
                session: undefined,
                user: expect.objectContaining({
                  id: context.serverUser.id,
                  username: context.serverUser.username,
                  serverId: context.server.id,
                }),
                data: expect.objectContaining({
                  ruleId: context.rule.id,
                  serverId: context.server.id,
                  sessionId: context.session.id,
                  mediaTitle: context.session.mediaTitle,
                  thumbPath: context.session.thumbPath,
                }),
              }),
            },
          })
        );
      });

      it('prefers the identity name over the account username for display', async () => {
        const context = createMockContext();
        context.serverUser.identityName = 'Alice Smith';
        const action: SendAction = { type: 'send', to: ['d1'] };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.enqueueAutomationNotification).toHaveBeenCalledWith(
          expect.objectContaining({
            event: expect.objectContaining({
              payload: expect.objectContaining({
                data: expect.objectContaining({
                  username: context.serverUser.username,
                  displayName: 'Alice Smith',
                }),
                user: expect.objectContaining({ identityName: 'Alice Smith' }),
              }),
            }),
          })
        );
      });

      it('sends the native stream event for a notification automation', async () => {
        const context = createMockContext({
          rule: createMockRule({ kind: 'notification' }),
        });
        context.trigger = {
          type: 'session.started',
          at: new Date(),
          server: { id: 'server-1', name: 'Test Server', type: 'plex' },
          serverUser: evaluationServerUser(context.serverUser),
          session: context.session,
        };

        await executeAction(context, { type: 'send', to: ['d1'], title: 'Playing' });

        const call = enqueueCall();
        expect(call.event.type).toBe('session_started');
        expect(call.source).toEqual({
          kind: 'automation',
          automationId: context.rule.id,
          automationName: context.rule.name,
          title: 'Playing',
        });
        const payload = call.event.payload as ActiveSession;
        expect(payload.id).toBe(context.session.id);
        expect(payload.canTerminate).toBe(false);
        expect(payload.user).toEqual({
          id: context.serverUser.id,
          username: context.serverUser.username,
          thumbUrl: null,
          identityName: null,
        });
        expect(payload.server).toEqual({ id: 'server-1', name: 'Test Server', type: 'plex' });
      });

      it('sends the account events natively, not the violation shape their account would allow', async () => {
        const context = createMockContext({ rule: createMockRule({ kind: 'notification' }) });
        context.trigger = {
          type: 'account.new_device',
          at: new Date(),
          server: { id: 'server-1', name: 'Test Server', type: 'plex' },
          serverUser: evaluationServerUser(context.serverUser),
          session: context.session,
          device: {
            name: 'Living Room TV',
            platform: 'tvOS',
            product: 'Plex for Apple TV',
            location: 'Boston',
          },
        };

        await executeAction(context, { type: 'send', to: ['d1'] });

        const device = enqueueCall();
        expect(device.event.type).toBe('new_device');
        expect(device.event.payload).toMatchObject({
          serverUserId: context.serverUser.id,
          sessionId: context.session.id,
          username: context.serverUser.username,
          deviceName: 'Living Room TV',
          product: 'Plex for Apple TV',
          location: 'Boston',
        });
      });

      it('sends a trust move natively, with both scores and the reason', async () => {
        const context = createMockContext({ rule: createMockRule({ kind: 'notification' }) });
        context.trigger = {
          type: 'account.trust_changed',
          at: new Date(),
          server: { id: 'server-1', name: 'Test Server', type: 'plex' },
          serverUser: evaluationServerUser(context.serverUser),
          session: null,
          previous: 90,
          next: 40,
          reason: 'Sharing penalty',
        };

        await executeAction(context, { type: 'send', to: ['d1'] });

        const trust = enqueueCall();
        expect(trust.event.type).toBe('trust_score_changed');
        expect(trust.event.payload).toMatchObject({
          serverUserId: context.serverUser.id,
          previousScore: 90,
          newScore: 40,
          reason: 'Sharing penalty',
        });
      });

      it('carries the stop duration onto the native stream_stopped event', async () => {
        const context = createMockContext({ rule: createMockRule({ kind: 'notification' }) });
        context.trigger = {
          type: 'session.stopped',
          at: new Date(),
          server: { id: 'server-1', name: 'Test Server', type: 'plex' },
          serverUser: evaluationServerUser(context.serverUser),
          session: context.session,
          durationMs: 1_800_000,
        };

        await executeAction(context, { type: 'send', to: ['d1'] });

        const call = enqueueCall();
        expect(call.event.type).toBe('session_stopped');
        expect((call.event.payload as ActiveSession).durationMs).toBe(1_800_000);
      });

      it('sends server_down for a user-less server context', async () => {
        const context: EvaluationContext = {
          ...createMockContext({ rule: createMockRule({ kind: 'notification' }) }),
          session: null,
          serverUser: null,
          subjectKey: 'server:server-1',
          activeSessions: [],
          recentSessions: [],
          trigger: {
            type: 'server.down',
            at: new Date(),
            server: { id: 'server-1', name: 'Test Server', type: 'plex' },
          },
        };

        const result = await executeAction(context, { type: 'send', to: ['d1'] });

        expect(result.skipped).toBeUndefined();
        expect(enqueueCall().event).toEqual({
          type: 'server_down',
          payload: { serverName: 'Test Server', serverId: 'server-1', serverType: 'plex' },
        });
      });

      it('sends the tracearr release from an install context', async () => {
        const context: EvaluationContext = {
          ...createMockContext({ rule: createMockRule({ kind: 'notification' }) }),
          session: null,
          serverUser: null,
          server: null,
          subjectKey: 'install',
          activeSessions: [],
          recentSessions: [],
          trigger: {
            type: 'tracearr.update_available',
            at: new Date(),
            current: '2.0.0',
            latest: '2.1.0',
            releaseUrl: 'https://example.com/r',
          },
        };

        await executeAction(context, { type: 'send', to: ['d1'] });

        expect(enqueueCall().event).toEqual({
          type: 'tracearr_update_available',
          payload: { current: '2.0.0', latest: '2.1.0', releaseUrl: 'https://example.com/r' },
        });
      });

      it('sends newsletter_send from an install context with the trigger fields as the payload', async () => {
        const fields = {
          newsletterId: 'n-1',
          sendId: 'send-1',
          name: 'Weekly',
          outcome: 'failed' as const,
          trigger: 'schedule' as const,
          recipientCount: 0,
          itemCounts: {},
          error: 'No deliverable recipients',
          windowStart: '2026-08-26T00:00:00.000Z',
          windowEnd: '2026-09-02T00:00:00.000Z',
          historyUrl: null,
        };
        const context: EvaluationContext = {
          ...createMockContext({ rule: createMockRule({ kind: 'notification' }) }),
          session: null,
          serverUser: null,
          server: null,
          subjectKey: 'install',
          activeSessions: [],
          recentSessions: [],
          trigger: { type: 'newsletter.failed', at: new Date(), ...fields },
        };

        await executeAction(context, { type: 'send', to: ['d1'] });

        expect(enqueueCall().event).toEqual({ type: 'newsletter_send', payload: fields });
      });

      it('sends media_upgraded from a media context, which has no account to fall back on', async () => {
        const quality = {
          resolution: '4k',
          dynamicRange: 'hdr10',
          videoCodec: 'HEVC',
          audioCodec: 'TRUEHD',
          audioChannels: 8,
          fileSize: 42_000_000_000,
        };
        const media = {
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
          quality,
        };
        const context: EvaluationContext = {
          ...createMockContext({ rule: createMockRule({ kind: 'notification' }) }),
          session: null,
          serverUser: null,
          media,
          subjectKey: 'media:item-1',
          activeSessions: [],
          recentSessions: [],
          trigger: {
            type: 'media.upgraded',
            at: new Date(),
            server: { id: 'server-1', name: 'Test Server', type: 'plex' },
            media,
            from: { ...quality, resolution: '1080p' },
            changed: ['resolution'],
          },
        };

        const result = await executeAction(context, { type: 'send', to: ['d1'] });

        expect(result.skipped).toBeUndefined();
        expect(enqueueCall().event).toEqual({
          type: 'media_upgraded',
          payload: {
            serverId: 'server-1',
            serverName: 'Test Server',
            serverType: 'plex',
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
            mediaType: 'movie',
            year: 2006,
            libraryName: 'Movies',
            to: quality,
            from: { ...quality, resolution: '1080p' },
            changed: ['resolution'],
          },
        });
      });

      it('keeps the violation shape for a policy run on a native trigger', async () => {
        const context = createMockContext({ rule: createMockRule({ kind: 'policy' }) });
        context.trigger = {
          type: 'session.started',
          at: new Date(),
          server: { id: 'server-1', name: 'Test Server', type: 'plex' },
          serverUser: evaluationServerUser(context.serverUser),
          session: context.session,
        };

        await executeAction(context, { type: 'send', to: ['d1'] });

        expect(enqueueCall().event.type).toBe('violation');
      });

      it('names the server on the violation shape so {{server.type}} resolves', async () => {
        const context = createMockContext();

        await executeAction(context, { type: 'send', to: ['d1'] });

        const payload = enqueueCall().event.payload as ViolationWithDetails;
        expect(payload.server).toEqual({ id: 'server-1', name: 'Test Server', type: 'plex' });
      });

      it('keeps the violation shape for a trigger with no native event', async () => {
        const context = createMockContext({ rule: createMockRule({ kind: 'notification' }) });
        context.trigger = {
          type: 'session.paused',
          at: new Date(),
          server: { id: 'server-1', name: 'Test Server', type: 'plex' },
          serverUser: evaluationServerUser(context.serverUser),
          session: context.session,
          pauseData: { lastPausedAt: new Date(), pausedDurationMs: 0 },
        };

        await executeAction(context, { type: 'send', to: ['d1'] });

        expect(enqueueCall().event.type).toBe('violation');
      });

      it('skips a user-less run that has no native event to send', async () => {
        const context: EvaluationContext = {
          ...createMockContext({ rule: createMockRule({ kind: 'policy' }) }),
          session: null,
          serverUser: null,
          subjectKey: 'server:server-1',
          activeSessions: [],
          recentSessions: [],
        };

        const result = await executeAction(context, { type: 'send', to: ['d1'] });

        expect(result).toMatchObject({ skipped: true, skipReason: 'No account to notify about' });
        expect(mockDeps.enqueueAutomationNotification).not.toHaveBeenCalled();
      });

      it('with empty to is a no-op', async () => {
        const context = createMockContext();
        const action: SendAction = { type: 'send', to: [] };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.enqueueAutomationNotification).not.toHaveBeenCalled();
      });

      it('logs when no enabled destination resolves', async () => {
        (mockDeps.enqueueAutomationNotification as ReturnType<typeof vi.fn>).mockResolvedValue(0);
        const info = vi.spyOn(automationsLogger, 'info').mockImplementation(() => undefined);
        const context = createMockContext();

        await executeAction(context, { type: 'send', to: ['d1'] });

        expect(info).toHaveBeenCalledWith(
          'send resolved no enabled destination',
          expect.objectContaining({ ruleId: context.rule.id, to: ['d1'] })
        );
        info.mockRestore();
      });
    });

    describe('trust', () => {
      it('should adjust user trust by amount in adjust mode', async () => {
        const context = createMockContext();
        const action: TrustAction = { type: 'trust', mode: 'adjust', amount: -10 };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.adjustUserTrust).toHaveBeenCalledWith(
          context.serverUser.id,
          -10,
          context.rule.name
        );
      });

      it('should not adjust if amount is 0', async () => {
        const context = createMockContext();
        const action: TrustAction = { type: 'trust', mode: 'adjust', amount: 0 };

        await executeAction(context, action);

        expect(mockDeps.adjustUserTrust).not.toHaveBeenCalled();
      });

      it('should set user trust in set mode', async () => {
        const context = createMockContext();
        const action: TrustAction = { type: 'trust', mode: 'set', value: 30 };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.setUserTrust).toHaveBeenCalledWith(
          context.serverUser.id,
          30,
          context.rule.name
        );
      });

      it('should reset user trust in reset mode', async () => {
        const context = createMockContext();
        const action: TrustAction = { type: 'trust', mode: 'reset' };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.resetUserTrust).toHaveBeenCalledWith(
          context.serverUser.id,
          context.rule.name
        );
      });
    });

    describe('kill_stream', () => {
      it('should record the interim result as queued, not a false success', async () => {
        const context = createMockContext();
        const action: KillStreamAction = { type: 'kill_stream' };

        const result = await executeAction(context, action);

        // The kill worker inserts the authoritative outcome (killed/skipped_*/failed)
        // later; this interim row must not claim success/skipped:false.
        expect(result).toEqual({
          action,
          success: true,
          skipped: true,
          skipReason: 'queued',
          enqueuedSessionIds: [context.session.id],
        });
      });

      it('records the action as failed (not queued) when the queue drops every target', async () => {
        (mockDeps.terminateSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
        const context = createMockContext();
        const action: KillStreamAction = { type: 'kill_stream' };

        const result = await executeAction(context, action);

        // No job landed, so no worker row will follow: the interim row is the
        // only record and must read as failed rather than queued.
        expect(result.success).toBe(false);
        expect(result.skipped).toBeFalsy();
      });

      it('should terminate session silently when no message provided', async () => {
        const context = createMockContext();
        const action: KillStreamAction = { type: 'kill_stream' };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.terminateSession).toHaveBeenCalledWith(
          context.session.id,
          context.server.id,
          context.rule.id,
          null,
          0,
          undefined,
          undefined,
          undefined,
          context.session.id
        );
      });

      it('should terminate session with delay', async () => {
        const context = createMockContext();
        const action: KillStreamAction = { type: 'kill_stream', delay_seconds: 30 };

        await executeAction(context, action);

        expect(mockDeps.terminateSession).toHaveBeenCalledWith(
          context.session.id,
          context.server.id,
          context.rule.id,
          null,
          30,
          undefined,
          undefined,
          undefined,
          context.session.id
        );
      });

      it('should terminate session with custom message', async () => {
        const context = createMockContext();
        const action: KillStreamAction = {
          type: 'kill_stream',
          message: 'You violated the concurrent streams policy',
        };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.terminateSession).toHaveBeenCalledWith(
          context.session.id,
          context.server.id,
          context.rule.id,
          null,
          0,
          'You violated the concurrent streams policy',
          undefined,
          undefined,
          context.session.id
        );
      });

      it('should terminate session with delay and message', async () => {
        const context = createMockContext();
        const action: KillStreamAction = {
          type: 'kill_stream',
          delay_seconds: 15,
          message: 'Stream will be terminated in 15 seconds',
        };

        await executeAction(context, action);

        expect(mockDeps.terminateSession).toHaveBeenCalledWith(
          context.session.id,
          context.server.id,
          context.rule.id,
          null,
          15,
          'Stream will be terminated in 15 seconds',
          undefined,
          undefined,
          context.session.id
        );
      });

      it('should not set cooldown at enqueue time - arming moves to the kill worker', async () => {
        const context = createMockContext();
        const action: KillStreamAction = { type: 'kill_stream', cooldown_minutes: 10 };

        await executeAction(context, action);

        expect(mockDeps.setCooldown).not.toHaveBeenCalled();
      });

      it('should carry cooldown_minutes and the cooldown account through to terminateSession', async () => {
        const context = createMockContext();
        const action: KillStreamAction = { type: 'kill_stream', cooldown_minutes: 10 };

        await executeAction(context, action);

        expect(mockDeps.terminateSession).toHaveBeenCalledWith(
          context.session.id,
          context.server.id,
          context.rule.id,
          null,
          0,
          undefined,
          undefined,
          { minutes: 10, triggeringServerUserId: context.serverUser.id },
          context.session.id
        );
      });

      describe('with targeting', () => {
        it('should terminate only triggering session by default', async () => {
          const triggeringSession = createMockSession({ id: 'triggering' });
          const otherSession = createMockSession({
            id: 'other',
            serverUserId: triggeringSession.serverUserId,
            startedAt: new Date(Date.now() - 60000),
          });
          const context = createMockContext({
            session: triggeringSession,
            activeSessions: [otherSession, triggeringSession],
          });
          const action: KillStreamAction = { type: 'kill_stream' };

          await executeAction(context, action);

          expect(mockDeps.terminateSession).toHaveBeenCalledTimes(1);
          expect(mockDeps.terminateSession).toHaveBeenCalledWith(
            'triggering',
            context.server.id,
            context.rule.id,
            null,
            0,
            undefined,
            undefined,
            undefined,
            'triggering'
          );
        });

        it('should terminate oldest session but re-verify against the triggering session', async () => {
          const oldestSession = createMockSession({
            id: 'oldest',
            serverUserId: 'user-1',
            startedAt: new Date('2024-01-01T08:00:00Z'),
          });
          const newestSession = createMockSession({
            id: 'newest',
            serverUserId: 'user-1',
            startedAt: new Date('2024-01-01T10:00:00Z'),
          });
          const context = createMockContext({
            session: newestSession,
            serverUser: createMockServerUser({ id: 'user-1' }),
            activeSessions: [oldestSession, newestSession],
          });
          const action: KillStreamAction = { type: 'kill_stream', target: 'oldest' };

          await executeAction(context, action);

          expect(mockDeps.terminateSession).toHaveBeenCalledTimes(1);
          // Target is the oldest session, but the trigger passed through is the
          // session that matched (newest), so the worker re-verifies against it.
          expect(mockDeps.terminateSession).toHaveBeenCalledWith(
            'oldest',
            context.server.id,
            context.rule.id,
            null,
            0,
            undefined,
            undefined,
            undefined,
            'newest'
          );
        });

        it('should terminate all except oldest when target is all_except_one', async () => {
          const session1 = createMockSession({
            id: 's1',
            serverUserId: 'user-1',
            startedAt: new Date('2024-01-01T08:00:00Z'),
          });
          const session2 = createMockSession({
            id: 's2',
            serverUserId: 'user-1',
            startedAt: new Date('2024-01-01T09:00:00Z'),
          });
          const session3 = createMockSession({
            id: 's3',
            serverUserId: 'user-1',
            startedAt: new Date('2024-01-01T10:00:00Z'),
          });
          const context = createMockContext({
            session: session3,
            serverUser: createMockServerUser({ id: 'user-1' }),
            activeSessions: [session1, session2, session3],
          });
          const action: KillStreamAction = { type: 'kill_stream', target: 'all_except_one' };

          await executeAction(context, action);

          expect(mockDeps.terminateSession).toHaveBeenCalledTimes(2);
          expect(mockDeps.terminateSession).toHaveBeenCalledWith(
            's2',
            context.server.id,
            context.rule.id,
            null,
            0,
            undefined,
            undefined,
            undefined,
            's3'
          );
          expect(mockDeps.terminateSession).toHaveBeenCalledWith(
            's3',
            context.server.id,
            context.rule.id,
            null,
            0,
            undefined,
            undefined,
            undefined,
            's3'
          );
        });

        it('should terminate all user sessions when target is all_user', async () => {
          const session1 = createMockSession({ id: 's1', serverUserId: 'user-1' });
          const session2 = createMockSession({ id: 's2', serverUserId: 'user-1' });
          const otherUserSession = createMockSession({ id: 'other', serverUserId: 'user-2' });
          const context = createMockContext({
            session: session1,
            serverUser: createMockServerUser({ id: 'user-1' }),
            activeSessions: [session1, session2, otherUserSession],
          });
          const action: KillStreamAction = { type: 'kill_stream', target: 'all_user' };

          await executeAction(context, action);

          expect(mockDeps.terminateSession).toHaveBeenCalledTimes(2);
          expect(mockDeps.terminateSession).toHaveBeenCalledWith(
            's1',
            context.server.id,
            context.rule.id,
            null,
            0,
            undefined,
            undefined,
            undefined,
            's1'
          );
          expect(mockDeps.terminateSession).toHaveBeenCalledWith(
            's2',
            context.server.id,
            context.rule.id,
            null,
            0,
            undefined,
            undefined,
            undefined,
            's1'
          );
          expect(mockDeps.terminateSession).not.toHaveBeenCalledWith(
            'other',
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything()
          );
        });

        it('should give each target its own terminateSession call keyed by that session id', async () => {
          const session1 = createMockSession({ id: 's1', serverUserId: 'user-1' });
          const session2 = createMockSession({ id: 's2', serverUserId: 'user-1' });
          const context = createMockContext({
            session: session1,
            serverUser: createMockServerUser({ id: 'user-1' }),
            activeSessions: [session1, session2],
            violationId: 'violation-1',
          });
          const action: KillStreamAction = { type: 'kill_stream', target: 'all_user' };

          const result = await executeAction(context, action);

          const calledSessionIds = (
            mockDeps.terminateSession as ReturnType<typeof vi.fn>
          ).mock.calls.map((call) => call[0]);
          // Multi-target: each resolved session is its own terminateSession call
          // (and, downstream, its own kill queue job) rather than one call for
          // the whole target set.
          expect(calledSessionIds).toEqual(['s1', 's2']);
          expect(new Set(calledSessionIds).size).toBe(2);
          // wasTerminatedByRule derives from this, so every enqueued target
          // (not just the triggering session) must be reported.
          expect(result.enqueuedSessionIds).toEqual(['s1', 's2']);
        });

        it('should carry identityServerUserIds only when the rule enforces across servers', async () => {
          const session1 = createMockSession({ id: 's1', serverUserId: 'user-1' });
          const crossServerContext = createMockContext({
            session: session1,
            serverUser: createMockServerUser({ id: 'user-1' }),
            activeSessions: [session1],
            rule: createMockRule({ enforceAcrossServers: true }),
            identityServerUserIds: ['user-1', 'user-1-sibling'],
          });
          const action: KillStreamAction = { type: 'kill_stream' };

          await executeAction(crossServerContext, action);

          expect(mockDeps.terminateSession).toHaveBeenCalledWith(
            's1',
            crossServerContext.server.id,
            crossServerContext.rule.id,
            null,
            0,
            undefined,
            ['user-1', 'user-1-sibling'],
            undefined,
            's1'
          );
        });
      });
    });

    describe('message_client', () => {
      it('should send message to client', async () => {
        const context = createMockContext();
        const action: MessageClientAction = { type: 'message_client', message: 'Please stop!' };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.sendClientMessage).toHaveBeenCalledWith(context.session.id, 'Please stop!');
      });

      it('should not send if message is empty', async () => {
        const context = createMockContext();
        const action: MessageClientAction = { type: 'message_client', message: '' };

        await executeAction(context, action);

        expect(mockDeps.sendClientMessage).not.toHaveBeenCalled();
      });

      describe('with targeting', () => {
        it('should message all user sessions when target is all_user', async () => {
          const session1 = createMockSession({ id: 's1', serverUserId: 'user-1' });
          const session2 = createMockSession({ id: 's2', serverUserId: 'user-1' });
          const context = createMockContext({
            session: session1,
            serverUser: createMockServerUser({ id: 'user-1' }),
            activeSessions: [session1, session2],
          });
          const action: MessageClientAction = {
            type: 'message_client',
            message: 'Warning!',
            target: 'all_user',
          };

          await executeAction(context, action);

          expect(mockDeps.sendClientMessage).toHaveBeenCalledTimes(2);
          expect(mockDeps.sendClientMessage).toHaveBeenCalledWith('s1', 'Warning!');
          expect(mockDeps.sendClientMessage).toHaveBeenCalledWith('s2', 'Warning!');
        });
      });
    });

    describe('Cooldown Handling', () => {
      it('should skip action if on cooldown', async () => {
        (mockDeps.checkCooldown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
        const context = createMockContext();
        const action: SendAction = { type: 'send', to: ['d1'], cooldown_minutes: 5 };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(result.skipped).toBe(true);
        expect(result.skipReason).toContain('cooldown');
        expect(mockDeps.enqueueAutomationNotification).not.toHaveBeenCalled();
      });

      it('should execute and set cooldown if not on cooldown', async () => {
        (mockDeps.checkCooldown as ReturnType<typeof vi.fn>).mockResolvedValue(false);
        const context = createMockContext();
        const action: SendAction = { type: 'send', to: ['d1'], cooldown_minutes: 5 };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(result.skipped).toBeUndefined();
        expect(mockDeps.enqueueAutomationNotification).toHaveBeenCalled();
        expect(mockDeps.setCooldown).toHaveBeenCalled();
      });

      it('should not check cooldown if cooldown_minutes is not set', async () => {
        const context = createMockContext();
        const action: SendAction = { type: 'send', to: ['d1'] };

        await executeAction(context, action);

        expect(mockDeps.checkCooldown).not.toHaveBeenCalled();
      });

      it('scopes cooldown keys per action type so a send cooldown cannot suppress kill_stream', async () => {
        (mockDeps.checkCooldown as ReturnType<typeof vi.fn>).mockImplementation(
          (_ruleId: string, targetId: string) => targetId.endsWith(':send')
        );
        const context = createMockContext();
        const actions: Action[] = [
          { type: 'send', to: ['d1'], cooldown_minutes: 5 },
          { type: 'kill_stream', cooldown_minutes: 10 },
        ];

        const results = await executeActions(context, actions);

        expect(results[0]?.skipped).toBe(true);
        expect(results[0]?.skipReason).toContain('cooldown');
        expect(mockDeps.checkCooldown).toHaveBeenCalledWith(
          context.rule.id,
          `${context.rule.id}:${context.serverUser.id}:send`,
          5
        );
        expect(mockDeps.checkCooldown).toHaveBeenCalledWith(
          context.rule.id,
          `${context.rule.id}:${context.serverUser.id}:kill_stream`,
          10
        );
        expect(mockDeps.terminateSession).toHaveBeenCalledWith(
          context.session.id,
          context.server.id,
          context.rule.id,
          null,
          0,
          undefined,
          undefined,
          { minutes: 10, triggeringServerUserId: context.serverUser.id },
          context.session.id
        );
      });

      it('arms the cooldown key with the action type', async () => {
        (mockDeps.checkCooldown as ReturnType<typeof vi.fn>).mockResolvedValue(false);
        const context = createMockContext();
        const action: SendAction = { type: 'send', to: ['d1'], cooldown_minutes: 5 };

        await executeAction(context, action);

        expect(mockDeps.setCooldown).toHaveBeenCalledWith(
          context.rule.id,
          `${context.rule.id}:${context.serverUser.id}:send`,
          5
        );
      });

      it('falls back to the run subject when the context has no account', async () => {
        const context: EvaluationContext = {
          ...createMockContext(),
          session: null,
          serverUser: null,
          subjectKey: 'server:server-1',
          activeSessions: [],
          recentSessions: [],
        };

        await executeAction(context, { type: 'send', to: ['d1'], cooldown_minutes: 5 });

        expect(mockDeps.checkCooldown).toHaveBeenCalledWith(
          context.rule.id,
          `${context.rule.id}:server:server-1:send`,
          5
        );
      });
    });

    describe('Error Handling', () => {
      it('should return error result if executor throws', async () => {
        (mockDeps.enqueueAutomationNotification as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('Network error')
        );
        const context = createMockContext();
        const action: SendAction = { type: 'send', to: ['d1'] };

        const result = await executeAction(context, action);

        expect(result.success).toBe(false);
        expect(result.message).toBe('Network error');
      });
    });
  });

  describe('executeActions', () => {
    let mockDeps: ActionExecutorDeps;

    beforeEach(() => {
      mockDeps = createMockDeps();
      setActionExecutorDeps(mockDeps);
    });

    afterEach(() => {
      resetActionExecutorDeps();
    });

    it('should execute all actions in sequence', async () => {
      const context = createMockContext();
      const actions: Action[] = [
        { type: 'message_client', message: 'Test' },
        { type: 'trust', mode: 'adjust', amount: -10 },
        { type: 'send', to: ['d1'] },
      ];

      const results = await executeActions(context, actions);

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.success)).toBe(true);
      expect(mockDeps.sendClientMessage).toHaveBeenCalled();
      expect(mockDeps.adjustUserTrust).toHaveBeenCalled();
      expect(mockDeps.enqueueAutomationNotification).toHaveBeenCalled();
    });

    it('should continue executing after an action fails', async () => {
      (mockDeps.adjustUserTrust as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('trust write failed')
      );
      const context = createMockContext();
      const actions: Action[] = [
        { type: 'trust', mode: 'adjust', amount: -10 },
        { type: 'send', to: ['d1'] },
      ];

      const results = await executeActions(context, actions);

      expect(results).toHaveLength(2);
      expect(results[0]?.success).toBe(false);
      expect(results[1]?.success).toBe(true);
      expect(mockDeps.enqueueAutomationNotification).toHaveBeenCalled();
    });

    it('should return empty array for empty actions', async () => {
      const context = createMockContext();

      const results = await executeActions(context, []);

      expect(results).toEqual([]);
    });
  });

  describe('disabled nodes', () => {
    let mockDeps: ActionExecutorDeps;

    beforeEach(() => {
      mockDeps = createMockDeps();
      setActionExecutorDeps(mockDeps);
    });

    afterEach(() => {
      resetActionExecutorDeps();
    });

    it('records a disabled action as skipped and runs nothing', async () => {
      const context = createMockContext();
      const actions: Action[] = [
        { type: 'send', to: ['d1'], cooldown_minutes: 5, enabled: false },
        { type: 'trust', mode: 'reset' },
      ];

      const results = await executeActions(context, actions);

      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ success: true, skipped: true, skipReason: 'disabled' });
      expect(mockDeps.enqueueAutomationNotification).not.toHaveBeenCalled();
      expect(mockDeps.checkCooldown).not.toHaveBeenCalled();
      expect(mockDeps.setCooldown).not.toHaveBeenCalled();
      expect(mockDeps.resetUserTrust).toHaveBeenCalled();
    });

    it('skips a disabled if with one step and leaves both branches alone', async () => {
      const context = createMockContext();
      const actions: Action[] = [
        {
          type: 'if',
          id: 'if-1',
          enabled: false,
          conditions: {
            groups: [{ conditions: [{ field: 'media_type', operator: 'eq', value: 'movie' }] }],
          },
          then: [{ type: 'trust', mode: 'reset' }],
          else: [{ type: 'send', to: ['d1'] }],
        },
      ];

      const results = await executeActions(context, actions);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ success: true, skipped: true, skipReason: 'disabled' });
      expect(mockDeps.resetUserTrust).not.toHaveBeenCalled();
      expect(mockDeps.enqueueAutomationNotification).not.toHaveBeenCalled();
    });
  });

  describe('if', () => {
    let mockDeps: ActionExecutorDeps;

    beforeEach(() => {
      mockDeps = createMockDeps();
      setActionExecutorDeps(mockDeps);
    });

    afterEach(() => {
      resetActionExecutorDeps();
    });

    const ifAction = (value: string): Action => ({
      type: 'if',
      id: 'if-1',
      conditions: {
        groups: [{ conditions: [{ field: 'media_type', operator: 'eq', value }] }],
      },
      then: [{ type: 'trust', mode: 'reset' }],
      else: [
        { type: 'send', to: ['d1'] },
        { type: 'message_client', message: 'stop' },
      ],
    });

    it('runs the then branch and paths its leaves under the node', async () => {
      const context = createMockContext();

      const results = await executeActions(context, [ifAction('movie')]);

      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ success: true, branch: 'then', matched: true });
      expect(results[0]?.evidence?.[0]).toMatchObject({ groupIndex: 0, matched: true });
      expect(results[0]?.path).toBeUndefined();
      expect(results[1]).toMatchObject({ success: true, path: 'if-1.then.0' });
      expect(results[1]?.action.type).toBe('trust');
      expect(mockDeps.resetUserTrust).toHaveBeenCalled();
      expect(mockDeps.enqueueAutomationNotification).not.toHaveBeenCalled();
    });

    it('runs the else branch when the conditions fail', async () => {
      const context = createMockContext();

      const results = await executeActions(context, [ifAction('episode')]);

      expect(results).toHaveLength(3);
      expect(results[0]).toMatchObject({ branch: 'else', matched: false });
      expect(results.map((r) => r.path)).toEqual([undefined, 'if-1.else.0', 'if-1.else.1']);
      expect(mockDeps.resetUserTrust).not.toHaveBeenCalled();
      expect(mockDeps.enqueueAutomationNotification).toHaveBeenCalled();
      expect(mockDeps.sendClientMessage).toHaveBeenCalled();
    });

    it('skips a disabled leaf inside a branch and keeps its path', async () => {
      const context = createMockContext();
      const action: Action = {
        type: 'if',
        id: 'if-1',
        conditions: {
          groups: [{ conditions: [{ field: 'media_type', operator: 'eq', value: 'movie' }] }],
        },
        then: [{ type: 'trust', mode: 'reset', enabled: false }],
        else: [],
      };

      const results = await executeActions(context, [action]);

      expect(results[1]).toMatchObject({
        skipped: true,
        skipReason: 'disabled',
        path: 'if-1.then.0',
      });
      expect(mockDeps.resetUserTrust).not.toHaveBeenCalled();
    });

    it('paths an if with no id by its place in the action list', async () => {
      const context = createMockContext();
      const unstamped = (): Action => ({
        type: 'if',
        conditions: {
          groups: [{ conditions: [{ field: 'media_type', operator: 'eq', value: 'movie' }] }],
        },
        then: [{ type: 'trust', mode: 'reset' }],
        else: [],
      });

      const results = await executeActions(context, [unstamped(), unstamped()]);

      expect(results.map((r) => r.path)).toEqual([
        undefined,
        'if@0.then.0',
        undefined,
        'if@1.then.0',
      ]);
    });

    it('runs a branch leaf through the same cooldown and skip rules', async () => {
      (mockDeps.checkCooldown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const context = createMockContext();
      const action: Action = {
        type: 'if',
        id: 'if-1',
        conditions: {
          groups: [{ conditions: [{ field: 'media_type', operator: 'eq', value: 'movie' }] }],
        },
        then: [{ type: 'send', to: ['d1'], cooldown_minutes: 5 }],
        else: [],
      };

      const results = await executeActions(context, [action]);

      expect(mockDeps.checkCooldown).toHaveBeenCalledWith(
        context.rule.id,
        `${context.rule.id}:${context.serverUser.id}:send`,
        5
      );
      expect(results[1]).toMatchObject({ skipped: true, path: 'if-1.then.0' });
    });
  });

  describe('without a session (account violations)', () => {
    let mockDeps: ActionExecutorDeps;
    const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);

    function createAccountContext(serverUser: ServerUser): AccountEvaluationContext {
      return {
        ...createMockContext(),
        session: null,
        serverUser,
        subjectKey: serverUser.id,
        activeSessions: [],
        recentSessions: [],
      };
    }

    /** An account context the inactivity sweep would hand the engine. */
    function inactivityContext(serverUser: ServerUser): EvaluationContext {
      return {
        ...createAccountContext(serverUser),
        trigger: {
          type: 'account.inactive_for',
          at: new Date(),
          server: { id: 'server-1', name: 'Test Server', type: 'plex' },
          serverUser: evaluationServerUser(serverUser),
          session: null,
        },
      };
    }

    beforeEach(() => {
      mockDeps = createMockDeps();
      setActionExecutorDeps(mockDeps);
    });

    afterEach(() => {
      resetActionExecutorDeps();
    });

    it('uses the account-inactivity wording and a synthetic id when no violation was recorded', async () => {
      const context = createAccountContext(
        createMockServerUser({ lastActivityAt: fortyFiveDaysAgo })
      );
      const actions: Action[] = [
        { type: 'send', to: ['d1', 'd2'] },
        { type: 'kill_stream' },
        { type: 'message_client', message: 'stop' },
      ];

      const results = await executeActions(context, actions);

      expect(mockDeps.enqueueAutomationNotification).toHaveBeenCalledWith({
        to: ['d1', 'd2'],
        source: {
          kind: 'automation',
          automationId: context.rule.id,
          automationName: context.rule.name,
        },
        event: {
          type: 'violation',
          payload: expect.objectContaining({
            id: expect.stringMatching(new RegExp(`^rule-send-${context.rule.id}-\\d+$`)),
            ruleId: context.rule.id,
            serverUserId: context.serverUser.id,
            sessionId: null,
            severity: context.rule.severity,
            createdAt: expect.any(Date),
            acknowledgedAt: null,
            session: undefined,
            data: {
              ruleId: context.rule.id,
              serverUserId: context.serverUser.id,
              username: 'testuser',
              displayName: 'testuser',
              serverId: context.server.id,
              serverName: context.server.name,
              userThumbUrl: null,
            },
          }),
        },
      });
      expect(mockDeps.terminateSession).not.toHaveBeenCalled();
      expect(mockDeps.sendClientMessage).not.toHaveBeenCalled();
      expect(results[0]).toMatchObject({ success: true, message: 'Executed send' });
      expect(results[1]).toMatchObject({
        success: true,
        skipped: true,
        skipReason: 'No session to act on',
      });
      expect(results[2]).toMatchObject({
        success: true,
        skipped: true,
        skipReason: 'No session to act on',
      });
    });

    it('keeps the inactivity wording as the default body an override can replace', async () => {
      const serverUser = createMockServerUser({ lastActivityAt: fortyFiveDaysAgo });
      const context = inactivityContext(serverUser);

      await executeActions(context, [{ type: 'send', to: ['d1'] }]);
      expect(enqueueCall().source).toMatchObject({
        body: 'Account "testuser" has been inactive for 45 days',
      });

      (mockDeps.enqueueAutomationNotification as ReturnType<typeof vi.fn>).mockClear();
      await executeActions(context, [{ type: 'send', to: ['d1'], body: 'come back {{days}}' }]);
      expect(enqueueCall().source).toMatchObject({ body: 'come back {{days}}' });
    });

    it('words the default body for a never-active account', async () => {
      const context = inactivityContext(createMockServerUser({ lastActivityAt: null }));

      await executeActions(context, [{ type: 'send', to: ['d1'] }]);

      expect(enqueueCall().source).toMatchObject({
        body: 'Account "testuser" has never been active',
      });
    });

    it('stamps the days an inactivity trigger measured so {{days}} renders', async () => {
      const context = inactivityContext(createMockServerUser({ lastActivityAt: fortyFiveDaysAgo }));

      await executeActions(context, [{ type: 'send', to: ['d1'] }]);

      expect(mockDeps.enqueueAutomationNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            payload: expect.objectContaining({ data: expect.objectContaining({ days: 45 }) }),
          }),
        })
      );
    });

    it('renders {{minutes}} as whole minutes, of the pause the firing node measures', async () => {
      // The wake fires a second past the threshold, so the raw reading is 30.0166 minutes.
      const at = new Date('2026-08-21T12:00:01.000Z');
      const pauseData = {
        lastPausedAt: new Date('2026-08-21T11:30:00.000Z'),
        pausedDurationMs: 10 * 60_000,
      };
      const heldFor = (measure: 'current' | 'total'): EvaluationContext => ({
        ...createAccountContext(createMockServerUser({ lastActivityAt: fortyFiveDaysAgo })),
        triggerNode: {
          id: 'node-1',
          type: 'session.held_for',
          enabled: true,
          params: { minutes: 30, measure },
        },
        trigger: {
          type: 'session.held_for',
          at,
          server: { id: 'server-1', name: 'Test Server', type: 'plex' },
          serverUser: evaluationServerUser(createMockServerUser()),
          session: createMockSession(),
          pauseData,
          heldMinutes: (at.getTime() - pauseData.lastPausedAt.getTime()) / 60_000,
        },
      });

      const minutesOf = async (measure: 'current' | 'total'): Promise<unknown> => {
        (mockDeps.enqueueAutomationNotification as ReturnType<typeof vi.fn>).mockClear();
        await executeActions(heldFor(measure), [{ type: 'send', to: ['d1'] }]);
        const payload = enqueueCall().event.payload as { data: Record<string, unknown> };
        return payload.data.minutes;
      };

      expect(await minutesOf('current')).toBe(30);
      expect(await minutesOf('total')).toBe(40);
    });

    it('keys cooldowns per action type and lets other actions run', async () => {
      (mockDeps.checkCooldown as ReturnType<typeof vi.fn>).mockImplementation(
        (_ruleId: string, targetId: string) => targetId.endsWith(':send')
      );
      const context = createAccountContext(
        createMockServerUser({ lastActivityAt: fortyFiveDaysAgo })
      );
      const actions: Action[] = [
        { type: 'send', to: ['d1'], cooldown_minutes: 60 },
        { type: 'trust', mode: 'adjust', amount: -10 },
      ];

      const results = await executeActions(context, actions);

      expect(mockDeps.checkCooldown).toHaveBeenCalledWith(
        context.rule.id,
        `${context.rule.id}:${context.serverUser.id}:send`,
        60
      );
      expect(mockDeps.enqueueAutomationNotification).not.toHaveBeenCalled();
      expect(mockDeps.adjustUserTrust).toHaveBeenCalledWith(
        context.serverUser.id,
        -10,
        context.rule.name
      );
      expect(results[0]).toMatchObject({ skipped: true, skipReason: 'On cooldown (60 minutes)' });
      expect(results[1]).toMatchObject({ success: true, message: 'Executed trust' });
    });

    it('arms the cooldown with the action-type key after executing', async () => {
      const context = createAccountContext(
        createMockServerUser({ lastActivityAt: fortyFiveDaysAgo })
      );

      await executeActions(context, [{ type: 'send', to: ['d1'], cooldown_minutes: 30 }]);

      expect(mockDeps.setCooldown).toHaveBeenCalledWith(
        context.rule.id,
        `${context.rule.id}:${context.serverUser.id}:send`,
        30
      );
    });

    it('runs every trust mode against the account', async () => {
      const context = createAccountContext(
        createMockServerUser({ lastActivityAt: fortyFiveDaysAgo })
      );
      const actions: Action[] = [
        { type: 'trust', mode: 'adjust', amount: -5 },
        { type: 'trust', mode: 'set', value: 20 },
        { type: 'trust', mode: 'reset' },
      ];

      await executeActions(context, actions);

      expect(mockDeps.adjustUserTrust).toHaveBeenCalledWith(
        context.serverUser.id,
        -5,
        context.rule.name
      );
      expect(mockDeps.setUserTrust).toHaveBeenCalledWith(
        context.serverUser.id,
        20,
        context.rule.name
      );
      expect(mockDeps.resetUserTrust).toHaveBeenCalledWith(
        context.serverUser.id,
        context.rule.name
      );
    });

    it('records a failure without aborting later actions', async () => {
      (mockDeps.enqueueAutomationNotification as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('discord webhook 500')
      );
      const context = createAccountContext(
        createMockServerUser({ lastActivityAt: fortyFiveDaysAgo })
      );
      const actions: Action[] = [
        { type: 'send', to: ['d1'] },
        { type: 'trust', mode: 'adjust', amount: -5 },
      ];

      const results = await executeActions(context, actions);

      expect(mockDeps.adjustUserTrust).toHaveBeenCalledWith(
        context.serverUser.id,
        -5,
        context.rule.name
      );
      expect(results[0]).toMatchObject({ success: false, message: 'discord webhook 500' });
      expect(results[1]).toMatchObject({ success: true });
    });

    it('skips trust when there is no account to adjust', async () => {
      const context: EvaluationContext = {
        ...createMockContext(),
        session: null,
        serverUser: null,
        subjectKey: 'server:server-1',
        activeSessions: [],
        recentSessions: [],
      };

      const results = await executeActions(context, [{ type: 'trust', mode: 'reset' }]);

      expect(results[0]).toMatchObject({
        success: true,
        skipped: true,
        skipReason: 'No account to adjust',
      });
      expect(mockDeps.resetUserTrust).not.toHaveBeenCalled();
    });

    it('does nothing when the rule has no actions', async () => {
      const context = createAccountContext(
        createMockServerUser({ lastActivityAt: fortyFiveDaysAgo })
      );

      const results = await executeActions(context, []);

      expect(results).toEqual([]);
      expect(mockDeps.enqueueAutomationNotification).not.toHaveBeenCalled();
      expect(mockDeps.adjustUserTrust).not.toHaveBeenCalled();
    });
  });
});
