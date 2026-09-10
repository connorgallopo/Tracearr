/**
 * Session subscriber pipeline tests
 *
 * Ports of the transcode/pause re-evaluation suites onto runRulePipeline:
 * - Only the trigger's rule subset is evaluated (no false positives)
 * - Every evaluation records a run through the recorder, with the trigger marker
 * - Actions are gated on a newly inserted run (never on a deduped match)
 * - The event's Session carries the fresh poll/SSE fields
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineAutomation, Session } from '@tracearr/shared';
import type { ProcessedSession } from '../../../jobs/poller/types.js';
import type {
  AccountInactiveForEvent,
  EvaluationInputs,
  EvaluationServer,
  EvaluationServerUser,
  PauseData,
  SessionHeldForEvent,
  SessionPausedEvent,
  SessionRow,
  SessionStartedEvent,
  SessionTranscodeChangedEvent,
} from '../events/types.js';

// ============================================================================
// Module Mocks
// ============================================================================

const mockTransaction = vi.fn();
/** The pipeline batches its run writes; the handle it passes down is a sentinel here. */
const pipelineTx = { batch: true };
vi.mock('../../../db/client.js', () => ({
  db: { transaction: (...args: unknown[]) => mockTransaction(...args) },
}));
const mockEvaluateRulesAsync = vi.fn();
vi.mock('../engine.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  evaluateRulesAsync: (...args: unknown[]) => mockEvaluateRulesAsync(...args),
}));
const mockRecordRun = vi.fn();
const mockAppendRunSteps = vi.fn();
const mockNoteRunFailure = vi.fn();
const mockRecordNearMiss = vi.fn();
const mockCoolingDown = vi.fn();
const mockPublishRunFinished = vi.fn();
vi.mock('../runRecorder.js', () => ({
  recordRun: (...args: unknown[]) => mockRecordRun(...args),
  appendRunSteps: (...args: unknown[]) => mockAppendRunSteps(...args),
  noteRunFailure: (...args: unknown[]) => mockNoteRunFailure(...args),
  recordNearMiss: (...args: unknown[]) => mockRecordNearMiss(...args),
  automationCoolingDown: (...args: unknown[]) => mockCoolingDown(...args),
  publishRunFinished: (...args: unknown[]) => mockPublishRunFinished(...args),
  runFinishedOf: (row: { id: string; automationId: string; kind: string; outcome: string }) => ({
    id: row.id,
    automationId: row.automationId,
    kind: row.kind,
    outcome: row.outcome,
  }),
  subjectKeyOf: (scope: {
    kind: string;
    sessionId?: string;
    serverUserId?: string;
    libraryItemId?: string;
    serverId?: string;
  }) => {
    if (scope.kind === 'session') return scope.sessionId;
    if (scope.kind === 'account') return scope.serverUserId;
    if (scope.kind === 'media') return `media:${scope.libraryItemId ?? ''}`;
    if (scope.kind === 'server') return `server:${scope.serverId ?? ''}`;
    return 'install';
  },
}));
const mockExecuteActions = vi.fn();
vi.mock('../executors/index.js', () => ({
  executeActions: (...args: unknown[]) => mockExecuteActions(...args),
}));
const mockStoreActionResults = vi.fn();
vi.mock('../v2Integration.js', () => ({
  storeActionResults: (...args: unknown[]) => mockStoreActionResults(...args),
}));
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  automationsLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../geoip.js', () => ({
  geoipService: {
    isPrivateIP: (ip: string) =>
      ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('127.'),
  },
}));

import { synthesizeTriggers } from '../triggers.js';
import {
  edgeKeyOf,
  registerRuleSubscribers,
  resetRuleSubscribersForTests,
  runRulePipeline,
} from '../events/subscribers.js';
import { firingNodeFor, type UserEvaluatingEvent } from '../events/evaluate.js';
import type { MediaQuality, MediaSubject } from '../types.js';
import { dispatch, resetDispatcherForTests } from '../events/dispatcher.js';
import { toRuleSession } from '../events/contextAssembly.js';
import { pickLiveSessionFields } from '../../../jobs/poller/sessionMapper.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockExistingSession(overrides: Record<string, unknown> = {}): SessionRow {
  return {
    id: 'session-1',
    serverId: 'server-1',
    serverUserId: 'user-1',
    sessionKey: 'sk-1',
    externalSessionId: 'ext-1',
    state: 'playing',
    mediaType: 'movie',
    mediaTitle: 'Test Movie',
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    year: 2024,
    thumbPath: null,
    ratingKey: 'rk-1',
    mediaId: null,
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
    sourceVideoWidth: 3840,
    sourceVideoHeight: 2160,
    sourceVideoDetails: null,
    sourceAudioDetails: null,
    streamVideoCodec: null,
    streamAudioCodec: null,
    streamVideoDetails: null,
    streamAudioDetails: null,
    transcodeInfo: null,
    subtitleInfo: null,
    ...overrides,
  } as SessionRow;
}

function createMockProcessedSession(overrides: Record<string, unknown> = {}): ProcessedSession {
  return {
    sessionKey: 'sk-1',
    ratingKey: 'rk-1',
    externalUserId: 'ext-user-1',
    username: 'testuser',
    userThumb: '',
    mediaTitle: 'Test Movie',
    mediaType: 'movie' as const,
    grandparentTitle: '',
    seasonNumber: 0,
    episodeNumber: 0,
    year: 2024,
    thumbPath: '',
    channelTitle: null,
    channelIdentifier: null,
    channelThumb: null,
    artistName: null,
    albumName: null,
    trackNumber: null,
    discNumber: null,
    ipAddress: '192.168.1.100',
    playerName: 'Player 1',
    deviceId: 'device-1',
    product: 'Plex Web',
    device: 'Chrome',
    platform: 'Web',
    quality: '4K (H.265) → 1080p (H.264)',
    isTranscode: true,
    videoDecision: 'transcode',
    audioDecision: 'directplay',
    bitrate: 10000,
    state: 'playing' as const,
    totalDurationMs: 7200000,
    progressMs: 360000,
    sourceVideoCodec: 'hevc',
    sourceAudioCodec: 'ac3',
    sourceAudioChannels: 6,
    sourceVideoWidth: 3840,
    sourceVideoHeight: 2160,
    sourceVideoDetails: null,
    sourceAudioDetails: null,
    streamVideoCodec: 'h264',
    streamAudioCodec: null,
    streamVideoDetails: null,
    streamAudioDetails: null,
    transcodeInfo: null,
    subtitleInfo: null,
    ...overrides,
  } as ProcessedSession;
}

function createPausedSession(overrides: Record<string, unknown> = {}): SessionRow {
  return createMockExistingSession({
    state: 'paused',
    progressMs: 600000,
    lastPausedAt: new Date(Date.now() - 20 * 60 * 1000), // 20 minutes ago (stale)
    ...overrides,
  });
}

function createPausedProcessedSession(overrides: Record<string, unknown> = {}): ProcessedSession {
  return createMockProcessedSession({
    quality: '1080p',
    isTranscode: false,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
    bitrate: 20000,
    state: 'paused' as const,
    progressMs: 600000,
    streamVideoCodec: null,
    ...overrides,
  });
}

/** Stamps the triggers the boot migration would synthesize, so fixtures route like stored rules. */
function migrated(
  base: Omit<EngineAutomation, 'triggers' | 'kind' | 'cooldownMinutes' | 'currentVersionId'>,
  overrides: Partial<EngineAutomation> = {}
): EngineAutomation {
  const merged = {
    kind: 'policy' as const,
    cooldownMinutes: null,
    currentVersionId: null,
    ...base,
    ...overrides,
  };
  return {
    ...merged,
    triggers:
      overrides.triggers !== undefined ? overrides.triggers : synthesizeTriggers(merged.conditions),
  };
}

function createTranscodeRule(overrides: Partial<EngineAutomation> = {}): EngineAutomation {
  return migrated(
    {
      id: 'rule-transcode-1',
      name: 'Block 4K Transcoding',
      description: null,
      serverId: null,
      serverUserId: null,
      userId: null,
      enforceAcrossServers: false,
      severity: 'high',
      isActive: true,
      conditions: {
        groups: [
          { conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] },
          { conditions: [{ field: 'source_resolution', operator: 'eq', value: '4K' }] },
        ],
      },
      actions: {
        actions: [{ type: 'kill_stream' }],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    overrides
  );
}

function createConcurrentStreamsRule(overrides: Partial<EngineAutomation> = {}): EngineAutomation {
  return migrated(
    {
      id: 'rule-concurrent-1',
      name: 'Max 2 Concurrent Streams',
      description: null,
      serverId: null,
      serverUserId: null,
      userId: null,
      enforceAcrossServers: false,
      severity: 'warning',
      isActive: true,
      conditions: {
        groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 2 }] }],
      },
      actions: {
        actions: [],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    overrides
  );
}

function createPauseRule(overrides: Partial<EngineAutomation> = {}): EngineAutomation {
  return migrated(
    {
      id: 'rule-pause-1',
      name: 'Kill After 15min Pause',
      description: null,
      serverId: null,
      serverUserId: null,
      userId: null,
      enforceAcrossServers: false,
      severity: 'warning',
      isActive: true,
      conditions: {
        groups: [{ conditions: [{ field: 'current_pause_minutes', operator: 'gte', value: 15 }] }],
      },
      actions: {
        actions: [{ type: 'kill_stream' }],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    overrides
  );
}

function createTotalPauseRule(overrides: Partial<EngineAutomation> = {}): EngineAutomation {
  return migrated(
    {
      id: 'rule-total-pause-1',
      name: 'Warn After 30min Total Pause',
      description: null,
      serverId: null,
      serverUserId: null,
      userId: null,
      enforceAcrossServers: false,
      severity: 'warning',
      isActive: true,
      conditions: {
        groups: [{ conditions: [{ field: 'total_pause_minutes', operator: 'gte', value: 30 }] }],
      },
      actions: {
        actions: [],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    overrides
  );
}

function createInactivityRule(overrides: Partial<EngineAutomation> = {}): EngineAutomation {
  return migrated(
    {
      id: 'rule-inactive-1',
      name: 'Dormant 30 Days',
      description: null,
      serverId: null,
      serverUserId: null,
      userId: null,
      enforceAcrossServers: false,
      severity: 'warning',
      isActive: true,
      conditions: {
        groups: [{ conditions: [{ field: 'inactive_days', operator: 'gte', value: 30 }] }],
      },
      actions: { actions: [] },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    overrides
  );
}

const server: EvaluationServer = { id: 'server-1', name: 'Test Plex', type: 'plex' };
const serverUser: EvaluationServerUser = {
  id: 'user-1',
  userId: 'identity-1',
  username: 'testuser',
  thumbUrl: null,
  identityName: null,
  trustScore: 100,
  lastActivityAt: new Date(),
  createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
  identityServerUserIds: ['user-1'],
};

interface TriggerInput {
  existingSession: SessionRow;
  processed: ProcessedSession;
  server: EvaluationServer;
  serverUser: EvaluationServerUser;
  activeAutomations: EngineAutomation[];
  activeSessions: Session[];
  recentSessions: Session[];
}

interface PauseTriggerInput extends TriggerInput {
  pauseData: PauseData;
}

function createTranscodeInput(overrides: Partial<TriggerInput> = {}): TriggerInput {
  return {
    existingSession: createMockExistingSession(),
    processed: createMockProcessedSession(),
    server,
    serverUser,
    activeAutomations: [createTranscodeRule(), createConcurrentStreamsRule()],
    activeSessions: [],
    recentSessions: [],
    ...overrides,
  };
}

/** Past every threshold the pause fixtures synthesize, so held_for params pass by default. */
const fortyMinutesAgo = new Date(Date.now() - 40 * 60 * 1000);

function createPauseInput(overrides: Partial<PauseTriggerInput> = {}): PauseTriggerInput {
  return {
    existingSession: createPausedSession(),
    processed: createPausedProcessedSession(),
    pauseData: {
      lastPausedAt: fortyMinutesAgo,
      pausedDurationMs: 0,
    },
    server,
    serverUser,
    activeAutomations: [createPauseRule(), createConcurrentStreamsRule()],
    activeSessions: [],
    recentSessions: [],
    ...overrides,
  };
}

function startedEvent(input: TriggerInput): SessionStartedEvent {
  return {
    type: 'session.started',
    at: new Date(),
    server: input.server,
    serverUser: input.serverUser,
    session: toRuleSession(input.existingSession),
  };
}

function transcodeEvent(input: TriggerInput): SessionTranscodeChangedEvent {
  return {
    type: 'session.transcode_changed',
    at: new Date(),
    server: input.server,
    serverUser: input.serverUser,
    session: toRuleSession(input.existingSession, pickLiveSessionFields(input.processed)),
    previous: {
      videoDecision: input.existingSession.videoDecision,
      audioDecision: input.existingSession.audioDecision,
    },
    next: {
      videoDecision: input.processed.videoDecision,
      audioDecision: input.processed.audioDecision,
    },
  };
}

function pauseEvent(input: PauseTriggerInput): SessionPausedEvent {
  return {
    type: 'session.paused',
    at: new Date(),
    server: input.server,
    serverUser: input.serverUser,
    session: toRuleSession(input.existingSession, {
      ...pickLiveSessionFields(input.processed),
      lastPausedAt: input.pauseData.lastPausedAt,
      pausedDurationMs: input.pauseData.pausedDurationMs,
    }),
    pauseData: input.pauseData,
  };
}

function heldForEvent(input: PauseTriggerInput): SessionHeldForEvent {
  return {
    type: 'session.held_for',
    at: new Date(),
    server: input.server,
    serverUser: input.serverUser,
    session: toRuleSession(input.existingSession, {
      ...pickLiveSessionFields(input.processed),
      lastPausedAt: input.pauseData.lastPausedAt,
      pausedDurationMs: input.pauseData.pausedDurationMs,
    }),
    pauseData: input.pauseData,
    heldMinutes: 12,
  };
}

const idleFor = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

function accountInactiveEvent(lastActivityAt: Date | null = idleFor(40)): AccountInactiveForEvent {
  return {
    type: 'account.inactive_for',
    at: new Date(),
    server,
    serverUser: { ...serverUser, lastActivityAt },
    session: null,
  };
}

function inputsOf(input: TriggerInput): EvaluationInputs {
  return {
    activeAutomations: input.activeAutomations,
    activeSessions: input.activeSessions,
    recentSessions: input.recentSessions,
    identityServerUserIds: input.serverUser.identityServerUserIds,
  };
}

function runTranscode(input: TriggerInput) {
  return runRulePipeline(
    transcodeEvent(input),
    inputsOf(input),
    {},
    { kind: 'session', sessionId: input.existingSession.id },
    { transcodeReEval: true }
  );
}

function runPause(input: PauseTriggerInput) {
  return runRulePipeline(
    pauseEvent(input),
    inputsOf(input),
    {},
    { kind: 'session', sessionId: input.existingSession.id },
    { pauseReEval: true }
  );
}

function runHeldFor(input: PauseTriggerInput, heldMinutes: number, triggerNodeId?: string) {
  return runRulePipeline(
    { ...heldForEvent(input), heldMinutes, ...(triggerNodeId ? { triggerNodeId } : {}) },
    inputsOf(input),
    {},
    { kind: 'session', sessionId: input.existingSession.id },
    { heldFor: true }
  );
}

const recordedEdgeKeys = () =>
  mockRecordRun.mock.calls.map(
    (call) => (call[0] as { trigger: { edgeKey: string | null } }).trigger.edgeKey
  );

const transcodeViolation = {
  id: 'violation-1',
  ruleId: 'rule-transcode-1',
  serverUserId: 'user-1',
  sessionId: 'session-1',
  severity: 'high',
  ruleType: null,
  data: {},
  createdAt: new Date(),
  acknowledgedAt: null,
};

const pauseViolation = {
  ...transcodeViolation,
  ruleId: 'rule-pause-1',
  severity: 'warning',
};

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(pipelineTx)
  );
  mockEvaluateRulesAsync.mockResolvedValue([]);
  mockRecordRun.mockResolvedValue(transcodeViolation);
  mockExecuteActions.mockResolvedValue([]);
  mockStoreActionResults.mockResolvedValue(undefined);
  mockAppendRunSteps.mockResolvedValue(undefined);
  mockNoteRunFailure.mockResolvedValue(undefined);
  mockRecordNearMiss.mockResolvedValue(undefined);
  mockCoolingDown.mockResolvedValue(false);
  mockPublishRunFinished.mockResolvedValue(undefined);
});

describe('session.transcode_changed pipeline', () => {
  describe('rule filtering', () => {
    it('only evaluates transcode-related rules, skipping concurrent_streams', async () => {
      const input = createTranscodeInput();
      await runTranscode(input);

      // Should have been called with only the transcode rule, not the concurrent streams rule
      expect(mockEvaluateRulesAsync).toHaveBeenCalledTimes(1);
      const [_baseContext, rules] = mockEvaluateRulesAsync.mock.calls[0] as [
        unknown,
        EngineAutomation[],
      ];
      expect(rules).toHaveLength(1);
      expect(rules[0]?.id).toBe('rule-transcode-1');
      expect(rules[0]?.name).toBe('Block 4K Transcoding');
    });

    it('returns empty array when no rules have transcode conditions', async () => {
      const input = createTranscodeInput({ activeAutomations: [createConcurrentStreamsRule()] });

      const { violations } = await runTranscode(input);

      expect(violations).toEqual([]);
      expect(mockEvaluateRulesAsync).not.toHaveBeenCalled();
    });

    it('returns empty array when there are no active rules', async () => {
      const input = createTranscodeInput({ activeAutomations: [] });

      const { violations } = await runTranscode(input);

      expect(violations).toEqual([]);
      expect(mockEvaluateRulesAsync).not.toHaveBeenCalled();
    });
  });

  describe('violation creation', () => {
    it('creates violation when transcode rule matches', async () => {
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-transcode-1',
          ruleName: 'Block 4K Transcoding',
          matched: true,
          matchedGroups: [0, 1],
          actions: [{ type: 'kill_stream' }],
        },
      ]);

      const input = createTranscodeInput();
      const { violations } = await runTranscode(input);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toEqual({
        violation: transcodeViolation,
        rule: { id: 'rule-transcode-1', name: 'Block 4K Transcoding', type: null },
      });
      expect(mockRecordRun).toHaveBeenCalledTimes(1);
    });

    it('includes transcodeReEval marker in violation data', async () => {
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-transcode-1',
          ruleName: 'Block 4K Transcoding',
          matched: true,
          matchedGroups: [0, 1],
          actions: [],
        },
      ]);

      const input = createTranscodeInput();
      await runTranscode(input);

      expect(mockRecordRun).toHaveBeenCalledWith(
        expect.objectContaining({
          marker: { transcodeReEval: true },
          serverUserId: 'user-1',
          scope: { kind: 'session', sessionId: 'session-1' },
          session: transcodeEvent(input).session,
        })
      );
    });
  });

  describe('deduplication', () => {
    it('skips violation creation when duplicate exists', async () => {
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-transcode-1',
          ruleName: 'Block 4K Transcoding',
          matched: true,
          matchedGroups: [0, 1],
          actions: [],
        },
      ]);

      // Simulate an existing run found (the recorder's gate returns null)
      mockRecordRun.mockResolvedValue(null);

      const { violations } = await runTranscode(createTranscodeInput());

      expect(violations).toHaveLength(0);
    });

    it('does NOT execute side effects when violation is deduplicated', async () => {
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-transcode-1',
          ruleName: 'Block 4K Transcoding',
          matched: true,
          matchedGroups: [0, 1],
          actions: [{ type: 'create_violation', severity: 'high' }, { type: 'kill_stream' }],
        },
      ]);

      // Simulate existing violation — kill_stream must NOT re-fire
      mockRecordRun.mockResolvedValue(null);

      const { violations } = await runTranscode(createTranscodeInput());

      expect(violations).toHaveLength(0);
      expect(mockExecuteActions).not.toHaveBeenCalled();
      expect(mockStoreActionResults).not.toHaveBeenCalled();
    });
  });

  describe('transaction safety', () => {
    it('passes the guarded session scope to the writer', async () => {
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-transcode-1',
          ruleName: 'Block 4K Transcoding',
          matched: true,
          matchedGroups: [0, 1],
          actions: [],
        },
      ]);

      await runTranscode(createTranscodeInput());

      // The guarded (non-fresh) session scope is what selects the lock + gate path;
      // the lock/dedup ordering itself is pinned in runRecorder.test.ts.
      const args = mockRecordRun.mock.calls[0]?.[0] as { scope: unknown };
      expect(args.scope).toEqual({ kind: 'session', sessionId: 'session-1' });
    });

    it('opens one transaction for the dispatch and hands the writer its executor', async () => {
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-transcode-1',
          ruleName: 'Block 4K Transcoding',
          matched: true,
          matchedGroups: [0, 1],
          actions: [],
        },
      ]);

      await runTranscode(createTranscodeInput());

      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockRecordRun).toHaveBeenCalledTimes(1);
      const args = mockRecordRun.mock.calls[0]?.[0] as { tx?: unknown };
      expect(args.tx).toBe(pipelineTx);
    });
  });

  describe('trust score penalty', () => {
    it('records once and runs no actions when the rule has none', async () => {
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-transcode-1',
          ruleName: 'Block 4K Transcoding',
          matched: true,
          matchedGroups: [0, 1],
          actions: [],
        },
      ]);

      await runTranscode(createTranscodeInput());

      // Recording the violation is the pipeline's only write; a rule with no
      // actions produces nothing else.
      expect(mockRecordRun).toHaveBeenCalledTimes(1);
      expect(mockExecuteActions).not.toHaveBeenCalled();
      expect(mockStoreActionResults).not.toHaveBeenCalled();
    });
  });

  describe('side effect actions', () => {
    it('executes kill_stream action alongside violation', async () => {
      const rule = createTranscodeRule();
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-transcode-1',
          ruleName: 'Block 4K Transcoding',
          matched: true,
          matchedGroups: [0, 1],
          actions: [{ type: 'kill_stream' }],
        },
      ]);

      mockExecuteActions.mockResolvedValue([{ action: 'kill_stream', success: true }]);

      const input = createTranscodeInput({
        activeAutomations: [rule, createConcurrentStreamsRule()],
      });
      await runTranscode(input);

      // Should execute side effect actions (kill_stream)
      expect(mockExecuteActions).toHaveBeenCalledTimes(1);
      expect(mockExecuteActions).toHaveBeenCalledWith(
        expect.objectContaining({ violationId: 'violation-1', rule }),
        [{ type: 'kill_stream' }]
      );

      // Should store action results
      expect(mockStoreActionResults).toHaveBeenCalledWith('violation-1', 'rule-transcode-1', [
        { action: 'kill_stream', success: true },
      ]);
    });
  });

  describe('context building', () => {
    it('passes updated transcode fields from processed data to evaluation', async () => {
      const input = createTranscodeInput({
        processed: createMockProcessedSession({
          isTranscode: true,
          videoDecision: 'transcode',
          audioDecision: 'copy',
        }),
        existingSession: createMockExistingSession({
          isTranscode: false,
          videoDecision: 'directplay',
          audioDecision: 'directplay',
        }),
      });

      await runTranscode(input);

      expect(mockEvaluateRulesAsync).toHaveBeenCalledTimes(1);
      const [baseContext] = mockEvaluateRulesAsync.mock.calls[0] as [
        { session: Session },
        EngineAutomation[],
      ];

      // Session should have UPDATED transcode fields from processed
      expect(baseContext.session.isTranscode).toBe(true);
      expect(baseContext.session.videoDecision).toBe('transcode');
      expect(baseContext.session.audioDecision).toBe('copy');

      // But identity fields should come from existing session
      expect(baseContext.session.id).toBe('session-1');
      expect(baseContext.session.serverId).toBe('server-1');
      expect(baseContext.session.serverUserId).toBe('user-1');
    });
  });

  describe('false positive prevention', () => {
    it('does NOT evaluate concurrent_streams rules on transcode change', async () => {
      const input = createTranscodeInput({
        activeAutomations: [
          createConcurrentStreamsRule(),
          createTranscodeRule(),
          // Another non-transcode rule
          migrated({
            id: 'rule-geo-1',
            name: 'Geo Restriction',
            description: null,
            serverId: null,
            serverUserId: null,
            userId: null,
            enforceAcrossServers: false,
            severity: 'warning',
            isActive: true,
            conditions: {
              groups: [
                {
                  conditions: [{ field: 'country', operator: 'not_in', value: ['US', 'CA'] }],
                },
              ],
            },
            actions: { actions: [] },
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ],
      });

      await runTranscode(input);

      // Only the transcode rule should be evaluated
      const [_ctx, rules] = mockEvaluateRulesAsync.mock.calls[0] as [unknown, EngineAutomation[]];
      expect(rules).toHaveLength(1);
      expect(rules[0]?.id).toBe('rule-transcode-1');
    });

    it('evaluates output_resolution rules (they depend on transcode state)', async () => {
      const outputResRule = migrated({
        id: 'rule-output-res-1',
        name: 'Block Low Resolution Output',
        description: null,
        serverId: null,
        serverUserId: null,
        userId: null,
        enforceAcrossServers: false,
        severity: 'warning',
        isActive: true,
        conditions: {
          groups: [{ conditions: [{ field: 'output_resolution', operator: 'eq', value: '480p' }] }],
        },
        actions: { actions: [] },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const input = createTranscodeInput({
        activeAutomations: [outputResRule, createConcurrentStreamsRule()],
      });

      await runTranscode(input);

      const [_ctx, rules] = mockEvaluateRulesAsync.mock.calls[0] as [unknown, EngineAutomation[]];
      expect(rules).toHaveLength(1);
      expect(rules[0]?.id).toBe('rule-output-res-1');
    });

    it('evaluates is_transcode_downgrade rules (they depend on transcode state)', async () => {
      const downgradeRule = migrated({
        id: 'rule-downgrade-1',
        name: 'Detect Transcode Downgrade',
        description: null,
        serverId: null,
        serverUserId: null,
        userId: null,
        enforceAcrossServers: false,
        severity: 'warning',
        isActive: true,
        conditions: {
          groups: [
            { conditions: [{ field: 'is_transcode_downgrade', operator: 'eq', value: true }] },
          ],
        },
        actions: { actions: [] },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const input = createTranscodeInput({ activeAutomations: [downgradeRule] });

      await runTranscode(input);

      const [_ctx, rules] = mockEvaluateRulesAsync.mock.calls[0] as [unknown, EngineAutomation[]];
      expect(rules).toHaveLength(1);
      expect(rules[0]?.id).toBe('rule-downgrade-1');
    });
  });
});

describe('session.paused pipeline', () => {
  beforeEach(() => {
    mockRecordRun.mockResolvedValue(pauseViolation);
  });

  describe('rule filtering', () => {
    it('only evaluates pause-related rules, skipping concurrent_streams', async () => {
      await runPause(createPauseInput());

      expect(mockEvaluateRulesAsync).toHaveBeenCalledTimes(1);
      const [_baseContext, rules] = mockEvaluateRulesAsync.mock.calls[0] as [
        unknown,
        EngineAutomation[],
      ];
      expect(rules).toHaveLength(1);
      expect(rules[0]?.id).toBe('rule-pause-1');
      expect(rules[0]?.name).toBe('Kill After 15min Pause');
    });

    it('evaluates both current_pause and total_pause rules', async () => {
      const input = createPauseInput({
        activeAutomations: [
          createPauseRule(),
          createTotalPauseRule(),
          createConcurrentStreamsRule(),
        ],
      });

      await runPause(input);

      const [_ctx, rules] = mockEvaluateRulesAsync.mock.calls[0] as [unknown, EngineAutomation[]];
      expect(rules).toHaveLength(2);
      expect(rules.map((r) => r.id)).toEqual(['rule-pause-1', 'rule-total-pause-1']);
    });

    it('returns empty array when no rules have pause conditions', async () => {
      const input = createPauseInput({
        activeAutomations: [createConcurrentStreamsRule(), createTranscodeRule()],
      });

      const { violations } = await runPause(input);

      expect(violations).toEqual([]);
      expect(mockEvaluateRulesAsync).not.toHaveBeenCalled();
    });

    it('returns empty array when there are no active rules', async () => {
      const input = createPauseInput({ activeAutomations: [] });

      const { violations } = await runPause(input);

      expect(violations).toEqual([]);
      expect(mockEvaluateRulesAsync).not.toHaveBeenCalled();
    });
  });

  describe('violation creation', () => {
    it('creates violation when pause rule matches', async () => {
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          actions: [{ type: 'kill_stream' }],
        },
      ]);

      const { violations } = await runPause(createPauseInput());

      expect(violations).toHaveLength(1);
      expect(violations[0]).toEqual({
        violation: pauseViolation,
        rule: { id: 'rule-pause-1', name: 'Kill After 15min Pause', type: null },
      });
      expect(mockRecordRun).toHaveBeenCalledTimes(1);
    });

    it('includes pauseReEval marker in violation data', async () => {
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          actions: [],
        },
      ]);

      const input = createPauseInput();
      await runPause(input);

      expect(mockRecordRun).toHaveBeenCalledWith(
        expect.objectContaining({
          marker: { pauseReEval: true },
          serverUserId: 'user-1',
          scope: { kind: 'session', sessionId: 'session-1' },
          session: pauseEvent(input).session,
        })
      );
    });

    it('passes the matched rule object to the writer', async () => {
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          actions: [],
        },
      ]);

      // The writer reads severity off the rule, so it has to be the rule the engine matched
      const rule = createPauseRule();
      await runPause(
        createPauseInput({ activeAutomations: [rule, createConcurrentStreamsRule()] })
      );

      expect(mockRecordRun.mock.calls[0]?.[0]?.automation).toBe(rule);
    });
  });

  describe('deduplication', () => {
    it('skips violation creation when duplicate exists', async () => {
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          actions: [],
        },
      ]);

      // Simulate an existing run found (the recorder's gate returns null)
      mockRecordRun.mockResolvedValue(null);

      const { violations } = await runPause(createPauseInput());

      expect(violations).toHaveLength(0);
    });

    it('does NOT execute side effects when violation is deduplicated', async () => {
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          // On every subsequent poll cycle while paused, the rule matches again
          // but kill_stream must NOT fire again because dedup prevents it.
          actions: [{ type: 'kill_stream' }],
        },
      ]);

      // Simulate existing violation — this is the critical dedup scenario.
      mockRecordRun.mockResolvedValue(null);

      await runPause(createPauseInput());

      // kill_stream should NOT fire on dedup
      expect(mockExecuteActions).not.toHaveBeenCalled();
      expect(mockStoreActionResults).not.toHaveBeenCalled();
    });
  });

  describe('transaction safety', () => {
    it('passes the guarded session scope to the writer', async () => {
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          actions: [],
        },
      ]);

      await runPause(createPauseInput());

      // The guarded (non-fresh) session scope selects the lock + gate path in the writer.
      const args = mockRecordRun.mock.calls[0]?.[0] as { scope: unknown };
      expect(args.scope).toEqual({ kind: 'session', sessionId: 'session-1' });
    });

    it('opens one transaction for the dispatch and hands the writer its executor', async () => {
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          actions: [],
        },
      ]);

      await runPause(createPauseInput());

      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockRecordRun).toHaveBeenCalledTimes(1);
      const args = mockRecordRun.mock.calls[0]?.[0] as { tx?: unknown };
      expect(args.tx).toBe(pipelineTx);
    });
  });

  describe('trust score penalty', () => {
    it('records once and runs no actions when the rule has none', async () => {
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          actions: [],
        },
      ]);

      await runPause(createPauseInput());

      // Trust score is handled elsewhere; recording the violation is the only write
      expect(mockRecordRun).toHaveBeenCalledTimes(1);
      expect(mockExecuteActions).not.toHaveBeenCalled();
      expect(mockStoreActionResults).not.toHaveBeenCalled();
    });
  });

  describe('side effect actions', () => {
    it('executes kill_stream action alongside new violation', async () => {
      const rule = createPauseRule();
      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-pause-1',
          ruleName: 'Kill After 15min Pause',
          matched: true,
          matchedGroups: [0],
          actions: [{ type: 'kill_stream' }],
        },
      ]);

      mockExecuteActions.mockResolvedValue([{ action: 'kill_stream', success: true }]);

      const input = createPauseInput({ activeAutomations: [rule, createConcurrentStreamsRule()] });
      await runPause(input);

      expect(mockExecuteActions).toHaveBeenCalledTimes(1);
      expect(mockExecuteActions).toHaveBeenCalledWith(
        expect.objectContaining({ violationId: 'violation-1', rule }),
        [{ type: 'kill_stream' }]
      );

      expect(mockStoreActionResults).toHaveBeenCalledWith('violation-1', 'rule-pause-1', [
        { action: 'kill_stream', success: true },
      ]);
    });
  });

  describe('context building', () => {
    it('uses fresh pauseData instead of stale existingSession values', async () => {
      const freshPauseStart = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago (fresh)
      const stalePauseStart = new Date(Date.now() - 20 * 60 * 1000); // 20 min ago (stale)

      const input = createPauseInput({
        existingSession: createPausedSession({
          // These are STALE values from the DB (before update)
          lastPausedAt: stalePauseStart,
          pausedDurationMs: 0,
        }),
        pauseData: {
          // These are FRESH values from calculatePauseAccumulation
          lastPausedAt: freshPauseStart,
          pausedDurationMs: 300000, // 5 min accumulated
        },
      });

      await runPause(input);

      expect(mockEvaluateRulesAsync).toHaveBeenCalledTimes(1);
      const [baseContext] = mockEvaluateRulesAsync.mock.calls[0] as [
        { session: Session },
        EngineAutomation[],
      ];

      // Session should use FRESH pause data, not stale existingSession values
      expect(baseContext.session.lastPausedAt).toEqual(freshPauseStart);
      expect(baseContext.session.pausedDurationMs).toBe(300000);

      // But identity fields should come from existingSession
      expect(baseContext.session.id).toBe('session-1');
      expect(baseContext.session.serverId).toBe('server-1');
      expect(baseContext.session.serverUserId).toBe('user-1');
    });

    it('uses paused state from processed data', async () => {
      const input = createPauseInput({
        processed: createPausedProcessedSession({ state: 'paused' }),
        existingSession: createPausedSession({ state: 'playing' }), // Stale
      });

      await runPause(input);

      const [baseContext] = mockEvaluateRulesAsync.mock.calls[0] as [
        { session: Session },
        EngineAutomation[],
      ];
      expect(baseContext.session.state).toBe('paused');
    });
  });

  describe('false positive prevention', () => {
    it('does NOT evaluate concurrent_streams rules on pause re-eval', async () => {
      const input = createPauseInput({
        activeAutomations: [
          createConcurrentStreamsRule(),
          createPauseRule(),
          createTranscodeRule(),
        ],
      });

      await runPause(input);

      const [_ctx, rules] = mockEvaluateRulesAsync.mock.calls[0] as [unknown, EngineAutomation[]];
      expect(rules).toHaveLength(1);
      expect(rules[0]?.id).toBe('rule-pause-1');
    });

    it('evaluates rules with mixed pause + non-pause conditions', async () => {
      const mixedRule = migrated({
        id: 'rule-mixed-1',
        name: 'Pause + Concurrent',
        description: null,
        serverId: null,
        serverUserId: null,
        userId: null,
        enforceAcrossServers: false,
        severity: 'warning',
        isActive: true,
        conditions: {
          groups: [
            { conditions: [{ field: 'current_pause_minutes', operator: 'gte', value: 10 }] },
            { conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 1 }] },
          ],
        },
        actions: { actions: [] },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const input = createPauseInput({
        activeAutomations: [mixedRule, createConcurrentStreamsRule()],
      });

      await runPause(input);

      // The mixed rule has a pause condition, so it should be included
      const [_ctx, rules] = mockEvaluateRulesAsync.mock.calls[0] as [unknown, EngineAutomation[]];
      expect(rules).toHaveLength(1);
      expect(rules[0]?.id).toBe('rule-mixed-1');
    });
  });
});

describe('runRulePipeline', () => {
  it('appends the event session to activeSessions when the grace filter dropped it', async () => {
    const other = { id: 'session-2', serverId: 'server-1', serverUserId: 'user-1' } as Session;
    const input = createTranscodeInput({ activeSessions: [other] });

    await runTranscode(input);

    const [baseContext] = mockEvaluateRulesAsync.mock.calls[0] as [
      { session: Session; activeSessions: Session[] },
      EngineAutomation[],
    ];
    expect(baseContext.activeSessions).toHaveLength(2);
    expect(baseContext.activeSessions[1]).toBe(baseContext.session);
  });

  it('under deferActions records now, acts later, and the closure returns the action results', async () => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'r1',
        ruleName: 'Deferred',
        matched: true,
        matchedGroups: [0],
        actions: [{ type: 'trust', mode: 'reset' }],
      },
    ]);
    mockRecordRun.mockResolvedValue({ id: 'v1' });
    mockExecuteActions.mockResolvedValue([
      { action: { type: 'trust', mode: 'reset' }, success: true },
    ]);

    const input = createTranscodeInput({
      activeAutomations: [createTranscodeRule({ id: 'r1', name: 'Deferred' })],
    });
    const res = await runRulePipeline(
      transcodeEvent(input),
      inputsOf(input),
      { deferActions: true },
      { kind: 'session', sessionId: 'session-1', fresh: true }
    );

    expect(mockRecordRun).toHaveBeenCalledTimes(1);
    expect(mockExecuteActions).not.toHaveBeenCalled();
    if (!res.deferredActions) throw new Error('expected deferredActions');
    const results = await res.deferredActions();
    expect(mockExecuteActions).toHaveBeenCalledTimes(1);
    expect(mockStoreActionResults).toHaveBeenCalledWith('v1', 'r1', results);
    expect(results).toHaveLength(1);
  });

  it('drains the recorder deferred effects in the post-commit phase', async () => {
    const effect = vi.fn().mockResolvedValue(undefined);
    mockRecordRun.mockImplementation(async (call: { defer?: (e: () => Promise<void>) => void }) => {
      call.defer?.(effect);
      return { id: 'run-1' };
    });
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'rule-transcode-1',
        ruleName: 'Block 4K Transcoding',
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);

    const input = createTranscodeInput();
    const res = await runRulePipeline(
      transcodeEvent(input),
      inputsOf(input),
      { tx: {} as never, deferActions: true },
      { kind: 'session', sessionId: 'session-1', fresh: true }
    );

    expect(effect).not.toHaveBeenCalled();
    if (!res.deferredActions) throw new Error('expected deferredActions');
    await res.deferredActions();
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('records every run in one transaction, then acts in rule order', async () => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'r1',
        ruleName: 'First',
        matched: true,
        matchedGroups: [0],
        actions: [{ type: 'kill_stream' }],
      },
      {
        ruleId: 'r2',
        ruleName: 'Second',
        matched: true,
        matchedGroups: [0],
        actions: [{ type: 'kill_stream' }],
      },
    ]);
    mockRecordRun.mockResolvedValueOnce({ id: 'v1' }).mockResolvedValueOnce({ id: 'v2' });

    const input = createTranscodeInput({
      activeAutomations: [
        createTranscodeRule({ id: 'r1', name: 'First' }),
        createTranscodeRule({ id: 'r2', name: 'Second' }),
      ],
    });
    await runTranscode(input);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockRecordRun).toHaveBeenCalledTimes(2);
    expect(mockExecuteActions).toHaveBeenCalledTimes(2);
    // Both runs share the pipeline's executor rather than opening one transaction each.
    const executors = mockRecordRun.mock.calls.map((call) => (call[0] as { tx?: unknown }).tx);
    expect(executors[0]).toBe(executors[1]);

    const [, recordSecond] = mockRecordRun.mock.invocationCallOrder as [number, number];
    const [actFirst] = mockExecuteActions.mock.invocationCallOrder as [number, number];
    expect(recordSecond).toBeLessThan(actFirst);
    expect(mockStoreActionResults.mock.calls.map((call) => call[0])).toEqual(['v1', 'v2']);
  });

  it('announces a dispatch in one frame carrying only the run identifiers', async () => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'r1',
        ruleName: 'First',
        matched: false,
        matchedGroups: [],
        actions: [],
        stoppedBy: { groupIndex: 0, matched: false, conditions: [] },
      },
      {
        ruleId: 'r2',
        ruleName: 'Second',
        matched: false,
        matchedGroups: [],
        actions: [],
        stoppedBy: { groupIndex: 0, matched: false, conditions: [] },
      },
    ]);
    mockRecordRun
      .mockResolvedValueOnce({
        id: 'run-1',
        automationId: 'r1',
        kind: 'policy',
        outcome: 'stopped_by_condition',
        subjectKey: 'session-1',
        humanSummary: 'no condition matched',
      })
      .mockResolvedValueOnce({
        id: 'run-2',
        automationId: 'r2',
        kind: 'policy',
        outcome: 'stopped_by_condition',
        subjectKey: 'session-1',
        humanSummary: 'no condition matched',
      });

    const input = createTranscodeInput({
      activeAutomations: [
        createTranscodeRule({ id: 'r1', name: 'First' }),
        createTranscodeRule({ id: 'r2', name: 'Second' }),
      ],
    });
    await runTranscode(input);

    expect(mockPublishRunFinished).toHaveBeenCalledExactlyOnceWith([
      { id: 'run-1', automationId: 'r1', kind: 'policy', outcome: 'stopped_by_condition' },
      { id: 'run-2', automationId: 'r2', kind: 'policy', outcome: 'stopped_by_condition' },
    ]);
  });

  it('leaves a completed policy run to the violation broadcaster', async () => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'rule-transcode-1',
        ruleName: 'Block 4K Transcoding',
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    mockRecordRun.mockResolvedValue({
      id: 'run-1',
      automationId: 'rule-transcode-1',
      kind: 'policy',
      outcome: 'completed',
    });

    await runTranscode(createTranscodeInput());

    expect(mockPublishRunFinished).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('a throwing post-commit effect costs neither the sibling effects nor the acts', async () => {
    const broken = vi.fn().mockRejectedValue(new Error('redis down'));
    const healthy = vi.fn().mockResolvedValue(undefined);
    mockRecordRun
      .mockImplementationOnce(async (call: { defer?: (e: () => Promise<void>) => void }) => {
        call.defer?.(broken);
        return { id: 'run-1' };
      })
      .mockImplementationOnce(async (call: { defer?: (e: () => Promise<void>) => void }) => {
        call.defer?.(healthy);
        return { id: 'run-2' };
      });
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'r1',
        ruleName: 'First',
        matched: true,
        matchedGroups: [0],
        actions: [{ type: 'kill_stream' }],
      },
      {
        ruleId: 'r2',
        ruleName: 'Second',
        matched: true,
        matchedGroups: [0],
        actions: [{ type: 'kill_stream' }],
      },
    ]);

    const input = createTranscodeInput({
      activeAutomations: [
        createTranscodeRule({ id: 'r1', name: 'First' }),
        createTranscodeRule({ id: 'r2', name: 'Second' }),
      ],
    });
    await runTranscode(input);

    expect(broken).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(mockExecuteActions).toHaveBeenCalledTimes(2);
  });

  it('records the run of a rule whose conditions stopped it and runs no actions', async () => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'rule-transcode-1',
        ruleName: 'Block 4K Transcoding',
        matched: false,
        matchedGroups: [],
        actions: [],
        stoppedBy: { groupIndex: 0, matched: false, conditions: [] },
      },
    ]);

    const { violations } = await runTranscode(createTranscodeInput());

    expect(mockRecordRun).toHaveBeenCalledTimes(1);
    expect(mockEvaluateRulesAsync).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      includeUnmatched: true,
    });
    expect(violations).toEqual([]);
    expect(mockExecuteActions).not.toHaveBeenCalled();
  });

  it('a cooling-down automation is a near miss, not an evaluation', async () => {
    mockCoolingDown.mockResolvedValue(true);

    const { violations } = await runTranscode(createTranscodeInput());

    expect(mockEvaluateRulesAsync).not.toHaveBeenCalled();
    expect(mockRecordRun).not.toHaveBeenCalled();
    expect(violations).toEqual([]);
    expect(mockRecordNearMiss).toHaveBeenCalledWith('rule-transcode-1', {
      reason: 'cooldown_active',
      subjectKey: 'session-1',
      trigger: 'session.transcode_changed',
    });
  });

  it('a notification run acts but never becomes a violation', async () => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'rule-transcode-1',
        ruleName: 'Block 4K Transcoding',
        matched: true,
        matchedGroups: [0],
        actions: [{ type: 'send', to: [] }],
      },
    ]);
    mockRecordRun.mockResolvedValue({ id: 'run-1' });

    const input = createTranscodeInput({
      activeAutomations: [createTranscodeRule({ kind: 'notification' })],
    });
    const { violations } = await runRulePipeline(
      transcodeEvent(input),
      inputsOf(input),
      {},
      {
        kind: 'session',
        sessionId: 'session-1',
      }
    );

    expect(violations).toEqual([]);
    expect(mockExecuteActions).toHaveBeenCalledTimes(1);
  });

  it('passes the matched trigger node and its edge key to the recorder', async () => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'rule-pause-1',
        ruleName: 'Long Pause',
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    const pausedAt = new Date('2026-08-20T10:00:00Z');
    const input = createPauseInput({ pauseData: { lastPausedAt: pausedAt, pausedDurationMs: 0 } });

    await runPause(input);

    const args = mockRecordRun.mock.calls[0]?.[0] as {
      trigger: { type: string; nodeId: string | null; edgeKey: string | null };
    };
    expect(args.trigger.type).toBe('session.paused');
    expect(args.trigger.nodeId).toEqual(expect.any(String));
    expect(args.trigger.edgeKey).toBe(pausedAt.toISOString());
  });

  it('keys a held_for edge on the node threshold so a rehydrated wake replays it', async () => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'rule-total-pause-1',
        ruleName: 'Warn After 30min Total Pause',
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    const input = createPauseInput({ activeAutomations: [createTotalPauseRule()] });

    await runHeldFor(input, 30.4);
    await runHeldFor(input, 47.9);

    expect(recordedEdgeKeys()).toEqual(['total:30', 'total:30']);
  });

  it('keys an account.inactive_for edge on the node days', async () => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'rule-inactive-1',
        ruleName: 'Dormant 30 Days',
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    const inputs: EvaluationInputs = {
      activeAutomations: [createInactivityRule()],
      activeSessions: [],
      recentSessions: [],
      identityServerUserIds: serverUser.identityServerUserIds,
    };

    await runRulePipeline(
      accountInactiveEvent(),
      inputs,
      {},
      {
        kind: 'account',
        serverUserId: 'user-1',
      }
    );

    expect(recordedEdgeKeys()).toEqual(['30']);
  });

  it('appends action results to the run steps', async () => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'rule-transcode-1',
        ruleName: 'Block 4K Transcoding',
        matched: true,
        matchedGroups: [0],
        actions: [{ type: 'kill_stream' }],
      },
    ]);
    mockRecordRun.mockResolvedValue({ id: 'run-1' });
    mockExecuteActions.mockResolvedValue([
      { action: { type: 'kill_stream' }, success: true, skipped: true, skipReason: 'queued' },
    ]);

    await runTranscode(createTranscodeInput());

    expect(mockAppendRunSteps).toHaveBeenCalledWith('run-1', [
      { action: 'kill_stream', success: true, skipped: true, skipReason: 'queued' },
    ]);
  });

  it('records the branch an if took and the path of the leaves under it', async () => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'rule-transcode-1',
        ruleName: 'Block 4K Transcoding',
        matched: true,
        matchedGroups: [0],
        actions: [{ type: 'if', id: 'if-1', conditions: { groups: [] }, then: [], else: [] }],
      },
    ]);
    mockRecordRun.mockResolvedValue({ id: 'run-1' });
    mockExecuteActions.mockResolvedValue([
      {
        action: { type: 'if', id: 'if-1' },
        success: true,
        branch: 'then',
        matched: true,
        evidence: [{ groupIndex: 0, matched: true, match: 'all', conditions: [] }],
      },
      { action: { type: 'trust' }, success: true, path: 'if-1.then.0' },
    ]);

    await runTranscode(createTranscodeInput());

    expect(mockAppendRunSteps).toHaveBeenCalledWith('run-1', [
      {
        action: 'if',
        success: true,
        branch: 'then',
        matched: true,
        evidence: [{ groupIndex: 0, matched: true, match: 'all', conditions: [] }],
      },
      { action: 'trust', success: true, path: 'if-1.then.0' },
    ]);
  });

  it('notes a bookkeeping failure and still acts on the sibling runs', async () => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'r1',
        ruleName: 'First',
        matched: true,
        matchedGroups: [0],
        actions: [{ type: 'kill_stream' }],
      },
      {
        ruleId: 'r2',
        ruleName: 'Second',
        matched: true,
        matchedGroups: [0],
        actions: [{ type: 'kill_stream' }],
      },
    ]);
    mockRecordRun.mockResolvedValueOnce({ id: 'run-1' }).mockResolvedValueOnce({ id: 'run-2' });
    mockStoreActionResults.mockRejectedValueOnce(new Error('results table gone'));

    const input = createTranscodeInput({
      activeAutomations: [
        createTranscodeRule({ id: 'r1', name: 'First' }),
        createTranscodeRule({ id: 'r2', name: 'Second' }),
      ],
    });
    await runTranscode(input);

    expect(mockNoteRunFailure).toHaveBeenCalledWith({
      run: { id: 'run-1' },
      serverId: 'server-1',
      message: 'results table gone',
    });
    expect(mockExecuteActions).toHaveBeenCalledTimes(2);
    expect(mockStoreActionResults).toHaveBeenCalledTimes(2);
  });

  it('a bookkeeping failure on the deferred path notes the run and leaves its siblings acting', async () => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'r1',
        ruleName: 'First',
        matched: true,
        matchedGroups: [0],
        actions: [{ type: 'kill_stream' }],
      },
      {
        ruleId: 'r2',
        ruleName: 'Second',
        matched: true,
        matchedGroups: [0],
        actions: [{ type: 'kill_stream' }],
      },
    ]);
    mockRecordRun.mockResolvedValueOnce({ id: 'run-1' }).mockResolvedValueOnce({ id: 'run-2' });
    mockStoreActionResults.mockRejectedValueOnce(new Error('results table gone'));

    const input = createTranscodeInput({
      activeAutomations: [
        createTranscodeRule({ id: 'r1', name: 'First' }),
        createTranscodeRule({ id: 'r2', name: 'Second' }),
      ],
    });
    const res = await runRulePipeline(
      transcodeEvent(input),
      inputsOf(input),
      { tx: {} as never, deferActions: true },
      { kind: 'session', sessionId: 'session-1', fresh: true }
    );

    // Post-commit there is nothing left to retry into, so the throw stops here.
    if (!res.deferredActions) throw new Error('expected deferredActions');
    await expect(res.deferredActions()).resolves.toBeDefined();
    expect(mockNoteRunFailure).toHaveBeenCalledTimes(1);
    expect(mockExecuteActions).toHaveBeenCalledTimes(2);
  });
});

describe('registerRuleSubscribers', () => {
  beforeEach(() => {
    resetDispatcherForTests();
    resetRuleSubscribersForTests();
    registerRuleSubscribers();
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'rule-transcode-1',
        ruleName: 'Block 4K Transcoding',
        matched: true,
        matchedGroups: [0, 1],
        actions: [],
      },
    ]);
  });

  it('records a dispatched session.started against the fresh scope with no marker', async () => {
    const input = createTranscodeInput();

    const result = await dispatch(startedEvent(input), inputsOf(input));

    expect(mockRecordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: 'session', sessionId: 'session-1', fresh: true },
      })
    );
    expect(mockRecordRun.mock.calls[0]?.[0]?.marker).toBeUndefined();
    expect(result.violations).toEqual([
      {
        violation: transcodeViolation,
        rule: { id: 'rule-transcode-1', name: 'Block 4K Transcoding', type: null },
      },
    ]);
  });

  it('records a dispatched session.transcode_changed against the guarded scope', async () => {
    const input = createTranscodeInput();

    const result = await dispatch(transcodeEvent(input), inputsOf(input));

    expect(mockRecordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: 'session', sessionId: 'session-1' },
        marker: { transcodeReEval: true },
      })
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.violation).toEqual(transcodeViolation);
  });

  it('records a dispatched session.paused against the guarded scope', async () => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'rule-pause-1',
        ruleName: 'Kill After 15min Pause',
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    mockRecordRun.mockResolvedValue(pauseViolation);
    const input = createPauseInput();

    const result = await dispatch(pauseEvent(input), inputsOf(input));

    expect(mockRecordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: 'session', sessionId: 'session-1' },
        marker: { pauseReEval: true },
      })
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.violation).toEqual(pauseViolation);
  });

  it('records a dispatched account.inactive_for against the account scope with no marker', async () => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'rule-inactive-1',
        ruleName: 'Dormant 30 Days',
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);

    const result = await dispatch(accountInactiveEvent(), {
      activeAutomations: [createInactivityRule(), createTranscodeRule()],
      activeSessions: [],
      recentSessions: [],
      identityServerUserIds: serverUser.identityServerUserIds,
    });

    // Only the inactivity rule is in scope for this trigger
    const [_ctx, rules] = mockEvaluateRulesAsync.mock.calls[0] as [unknown, EngineAutomation[]];
    expect(rules.map((r) => r.id)).toEqual(['rule-inactive-1']);
    expect(mockRecordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: 'account', serverUserId: 'user-1' },
        serverUserId: 'user-1',
        session: null,
      })
    );
    expect(mockRecordRun.mock.calls[0]?.[0]?.marker).toBeUndefined();
    expect(result.violations).toHaveLength(1);
  });

  it('records a dispatched session.held_for against the guarded scope', async () => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'rule-pause-1',
        ruleName: 'Kill After 15min Pause',
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    mockRecordRun.mockResolvedValue(pauseViolation);
    const input = createPauseInput();

    const result = await dispatch(heldForEvent(input), inputsOf(input));

    expect(mockRecordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: 'session', sessionId: 'session-1' },
        marker: { heldFor: true },
      })
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.violation).toEqual(pauseViolation);
  });
});

describe('trigger params gate the evaluation', () => {
  const accountInputs = (): EvaluationInputs => ({
    activeAutomations: [createInactivityRule()],
    activeSessions: [],
    recentSessions: [],
    identityServerUserIds: serverUser.identityServerUserIds,
  });

  it('skips a held_for node the pause has not reached and records the near miss', async () => {
    const input = createPauseInput({
      pauseData: { lastPausedAt: new Date(Date.now() - 5 * 60 * 1000), pausedDurationMs: 0 },
      activeAutomations: [createPauseRule()],
    });

    await runHeldFor(input, 5);

    expect(mockEvaluateRulesAsync).not.toHaveBeenCalled();
    expect(mockRecordNearMiss).toHaveBeenCalledWith('rule-pause-1', {
      reason: 'trigger_filter_failed',
      subjectKey: 'session-1',
      trigger: 'session.held_for',
    });
  });

  it('evaluates once the pause clears the node threshold', async () => {
    await runHeldFor(createPauseInput({ activeAutomations: [createPauseRule()] }), 40);

    expect(mockEvaluateRulesAsync).toHaveBeenCalledTimes(1);
    expect(mockRecordNearMiss).not.toHaveBeenCalled();
  });

  it('skips an account that has not been idle for the node days, and stays out of the ring', async () => {
    await runRulePipeline(
      accountInactiveEvent(idleFor(10)),
      accountInputs(),
      {},
      {
        kind: 'account',
        serverUserId: 'user-1',
      }
    );

    expect(mockEvaluateRulesAsync).not.toHaveBeenCalled();
    // The sweep hands every automation the union of the candidates; a miss here is not news.
    expect(mockRecordNearMiss).not.toHaveBeenCalled();
  });

  it('evaluates an account idle past the node days', async () => {
    await runRulePipeline(
      accountInactiveEvent(idleFor(40)),
      accountInputs(),
      {},
      {
        kind: 'account',
        serverUserId: 'user-1',
      }
    );

    expect(mockEvaluateRulesAsync).toHaveBeenCalledTimes(1);
  });
});

describe('a rule with two held_for nodes', () => {
  const twoNodes = () =>
    createPauseRule({
      id: 'rule-two-nodes',
      conditions: {
        groups: [
          { conditions: [{ field: 'total_pause_minutes', operator: 'gte', value: 120 }] },
          { conditions: [{ field: 'current_pause_minutes', operator: 'gte', value: 30 }] },
        ],
      },
    });
  const nodeIdFor = (rule: EngineAutomation, measure: 'current' | 'total') =>
    rule.triggers.find(
      (node) => node.type === 'session.held_for' && node.params.measure === measure
    )?.id;
  const pausedFor = (minutes: number, activeAutomations: EngineAutomation[]) =>
    createPauseInput({
      activeAutomations,
      pauseData: { lastPausedAt: new Date(Date.now() - minutes * 60_000), pausedDurationMs: 0 },
    });

  beforeEach(() => {
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'rule-two-nodes',
        ruleName: 'Kill After 15min Pause',
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
  });

  it('fires the node the wake named, at each of its crossings', async () => {
    const rule = twoNodes();
    const currentNodeId = nodeIdFor(rule, 'current');

    await runHeldFor(pausedFor(30, [rule]), 30, currentNodeId);
    await runHeldFor(pausedFor(120, [rule]), 120, nodeIdFor(rule, 'total'));

    expect(recordedEdgeKeys()).toEqual(['current:30', 'total:120']);
    expect(
      (mockRecordRun.mock.calls[0]?.[0] as { trigger: { nodeId: string } }).trigger.nodeId
    ).toBe(currentNodeId);
    expect(mockRecordNearMiss).not.toHaveBeenCalled();
  });

  it('a wake naming a node this rule does not carry falls back to the one that passes', async () => {
    const rule = twoNodes();

    await runHeldFor(pausedFor(30, [rule]), 30, '3c7e5a9b-1d20-4a2b-8d1f-0f5b8d4a9c6e');

    expect(recordedEdgeKeys()).toEqual(['current:30']);
    expect(mockRecordNearMiss).not.toHaveBeenCalled();
  });

  it('without a node id the first node that passes still fires', async () => {
    const rule = twoNodes();

    await runHeldFor(pausedFor(30, [rule]), 30);

    expect(recordedEdgeKeys()).toEqual(['current:30']);
  });

  it('records the near miss against a node when nothing passes', async () => {
    const rule = twoNodes();

    await runHeldFor(pausedFor(5, [rule]), 5);

    expect(mockEvaluateRulesAsync).not.toHaveBeenCalled();
    expect(mockRecordNearMiss).toHaveBeenCalledWith('rule-two-nodes', {
      reason: 'trigger_filter_failed',
      subjectKey: 'session-1',
      trigger: 'session.held_for',
    });
  });
});

describe('edgeKeyOf', () => {
  const at = new Date('2026-08-21T09:30:00Z');
  const pausedAt = new Date('2026-08-21T09:00:00Z');
  const pauseInput = createPauseInput({
    pauseData: { lastPausedAt: pausedAt, pausedDurationMs: 0 },
  });
  /** The pipeline keys the edge on the node it fired, so the test resolves the same one. */
  const keyFor = (event: UserEvaluatingEvent, automation: EngineAutomation) =>
    edgeKeyOf(event, firingNodeFor(automation, event));

  it('a fresh session has no edge', () => {
    expect(keyFor(startedEvent(pauseInput), createTranscodeRule())).toBeNull();
  });

  it('a transcode edge is the pair of decisions it moved to', () => {
    expect(keyFor(transcodeEvent(createTranscodeInput()), createTranscodeRule())).toBe(
      'transcode/directplay'
    );
  });

  it('a pause edge is the instant the pause started', () => {
    expect(keyFor(pauseEvent(pauseInput), createPauseRule())).toBe(pausedAt.toISOString());
  });

  it('a held_for edge is the node measure and minutes', () => {
    expect(keyFor(heldForEvent(pauseInput), createPauseRule())).toBe('current:15');
    expect(keyFor(heldForEvent(pauseInput), createTotalPauseRule())).toBe('total:30');
  });

  it('an inactivity edge is the node days', () => {
    expect(keyFor(accountInactiveEvent(), createInactivityRule())).toBe('30');
  });

  it('a stop edge is the instant it stopped', () => {
    const stopped = {
      type: 'session.stopped' as const,
      at,
      server,
      serverUser,
      session: toRuleSession(createPausedSession()),
      durationMs: 600_000,
    };
    expect(edgeKeyOf(stopped, null)).toBe(at.toISOString());
  });

  it('server health edges are the instant the state changed', () => {
    expect(edgeKeyOf({ type: 'server.down', at, server }, null)).toBe(at.toISOString());
    expect(edgeKeyOf({ type: 'server.up', at, server }, null)).toBe(at.toISOString());
  });

  it('update edges are the version on offer', () => {
    expect(
      edgeKeyOf(
        {
          type: 'plugin.update_available',
          at,
          server,
          installedVersion: '0.2.0',
          latestVersion: '0.3.1',
          downloadUrl: 'https://example.invalid/plugin',
        },
        null
      )
    ).toBe('0.3.1');
    expect(
      edgeKeyOf(
        {
          type: 'server.update_available',
          at,
          server,
          installedVersion: '10.9.0',
          latestVersion: '10.10.0',
          releaseUrl: 'https://example.invalid/server',
        },
        null
      )
    ).toBe('10.10.0');
    expect(
      edgeKeyOf(
        {
          type: 'tracearr.update_available',
          at,
          current: '2.1.0',
          latest: '2.2.0',
          releaseUrl: 'https://example.invalid/tracearr',
        },
        null
      )
    ).toBe('2.2.0');
  });

  it('an added item has no edge, and an upgrade carries the quality it landed on', () => {
    const media = mediaSubject();
    expect(edgeKeyOf({ type: 'media.added', at, server, media }, null)).toBeNull();
    expect(
      edgeKeyOf(
        {
          type: 'media.upgraded',
          at,
          server,
          media,
          from: mediaQuality({ resolution: '1080p', fileSize: null }),
          changed: ['resolution', 'fileSize'],
        },
        null
      )
    ).toBe('4k|hdr10|HEVC|TRUEHD|8|42000000000');
    expect(
      edgeKeyOf(
        {
          type: 'media.upgraded',
          at,
          server,
          media: mediaSubject({
            quality: mediaQuality({ dynamicRange: null, audioChannels: null }),
          }),
          from: mediaQuality(),
          changed: ['dynamicRange'],
        },
        null
      )
    ).toBe('4k||HEVC|TRUEHD||42000000000');
  });

  it('a first-seen device has no edge, and a trust edge is the transition it made', () => {
    const session = toRuleSession(createPausedSession());
    expect(
      edgeKeyOf(
        {
          type: 'account.new_device',
          at,
          server,
          serverUser,
          session,
          device: { name: 'Living Room TV', platform: null, product: null, location: null },
        },
        null
      )
    ).toBeNull();
    expect(
      edgeKeyOf(
        {
          type: 'account.trust_changed',
          at,
          server,
          serverUser,
          session: null,
          previous: 90,
          next: 85,
          reason: null,
        },
        null
      )
    ).toBe('90->85');
  });

  it('a held_for automation with no enabled node has no edge', () => {
    const unstamped = createPauseRule({ triggers: [] });
    expect(keyFor(heldForEvent(pauseInput), unstamped)).toBeNull();
  });
});

describe('server and install triggers', () => {
  const serverAutomation = (
    id: string,
    type: 'server.down' | 'tracearr.update_available' | 'newsletter.failed',
    overrides: Partial<EngineAutomation> = {}
  ): EngineAutomation =>
    migrated(
      {
        id,
        name: id,
        description: null,
        serverId: null,
        serverUserId: null,
        userId: null,
        enforceAcrossServers: false,
        severity: 'warning',
        isActive: true,
        conditions: { groups: [] },
        actions: { actions: [{ type: 'send', to: ['d1'] }] },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        kind: 'notification',
        triggers: [{ id: `${id}-node`, type, enabled: true }],
        ...overrides,
      }
    );

  const inputs = (activeAutomations: EngineAutomation[]): EvaluationInputs => ({
    activeAutomations,
    activeSessions: [],
    recentSessions: [],
  });

  const downRun = { ...transcodeViolation, id: 'run-down', ruleId: 'down' };

  beforeEach(() => {
    resetDispatcherForTests();
    resetRuleSubscribersForTests();
    registerRuleSubscribers();
    mockRecordRun.mockResolvedValue(downRun);
    mockEvaluateRulesAsync.mockResolvedValue([
      { ruleId: 'down', ruleName: 'down', matched: true, matchedGroups: [], actions: [] },
    ]);
  });

  it('records a server.down run against the server subject with the server on it', async () => {
    const automation = { ...serverAutomation('down', 'server.down'), serverId: 'server-1' };
    const event = { type: 'server.down' as const, at: new Date(), server };

    const result = await dispatch(event, inputs([automation]));

    expect(result.outcomes).toEqual([{ subscriber: 'server-rules', ok: true }]);
    expect(mockRecordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: 'server', serverId: 'server-1' },
        serverUserId: null,
        serverId: 'server-1',
        session: null,
      })
    );
    const [[recorded]] = mockRecordRun.mock.calls as [[{ trigger: { edgeKey: string | null } }]];
    expect(recorded.trigger.edgeKey).toBe(event.at.toISOString());
    // A notification run is nobody's violation.
    expect(result.violations).toEqual([]);
  });

  it('leaves an account-scoped automation out of the candidates', async () => {
    const automation = { ...serverAutomation('down', 'server.down'), serverUserId: 'user-1' };

    await dispatch({ type: 'server.down', at: new Date(), server }, inputs([automation]));

    expect(mockEvaluateRulesAsync).not.toHaveBeenCalled();
    expect(mockRecordRun).not.toHaveBeenCalled();
  });

  it('records a tracearr update against the install subject with no server', async () => {
    const automation = serverAutomation('update', 'tracearr.update_available');
    const event = {
      type: 'tracearr.update_available' as const,
      at: new Date(),
      current: '1.0.0',
      latest: '1.1.0',
      releaseUrl: 'https://example.test',
    };
    mockEvaluateRulesAsync.mockResolvedValue([
      { ruleId: 'update', ruleName: 'update', matched: true, matchedGroups: [], actions: [] },
    ]);

    const result = await dispatch(event, inputs([automation]));

    expect(result.outcomes).toEqual([{ subscriber: 'install-rules', ok: true }]);
    expect(mockRecordRun).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: 'install' }, serverUserId: null, serverId: null })
    );
    const [[recorded]] = mockRecordRun.mock.calls as [[{ trigger: { edgeKey: string | null } }]];
    expect(recorded.trigger.edgeKey).toBe('1.1.0');
  });

  it('records a failed newsletter against the install subject, keyed on the send', async () => {
    const automation = serverAutomation('digest', 'newsletter.failed');
    const event = {
      type: 'newsletter.failed' as const,
      at: new Date(),
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
    mockEvaluateRulesAsync.mockResolvedValue([
      { ruleId: 'digest', ruleName: 'digest', matched: true, matchedGroups: [], actions: [] },
    ]);

    const result = await dispatch(event, inputs([automation]));

    expect(result.outcomes).toEqual([{ subscriber: 'install-rules', ok: true }]);
    expect(mockRecordRun).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: 'install' }, serverUserId: null, serverId: null })
    );
    const [[recorded]] = mockRecordRun.mock.calls as [[{ trigger: { edgeKey: string | null } }]];
    expect(recorded.trigger.edgeKey).toBe('send-1');
  });

  it('evaluates the server context with no user and no history', async () => {
    const automation = serverAutomation('down', 'server.down');

    await dispatch({ type: 'server.down', at: new Date(), server }, inputs([automation]));

    const [context] = mockEvaluateRulesAsync.mock.calls[0] as [Record<string, unknown>];
    expect(context.session).toBeNull();
    expect(context.serverUser).toBeNull();
    expect(context.server).toMatchObject({ id: 'server-1' });
    expect(context.subjectKey).toBe('server:server-1');
  });
});

// ============================================================================
// Media triggers
// ============================================================================

const mediaQuality = (overrides: Partial<MediaQuality> = {}): MediaQuality => ({
  resolution: '4k',
  dynamicRange: 'hdr10',
  videoCodec: 'HEVC',
  audioCodec: 'TRUEHD',
  audioChannels: 8,
  fileSize: 42_000_000_000,
  ...overrides,
});

const mediaSubject = (overrides: Partial<MediaSubject> = {}): MediaSubject => ({
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
  quality: mediaQuality(),
  ...overrides,
});

describe('media triggers', () => {
  const mediaAutomation = (
    type: 'media.added' | 'media.upgraded',
    overrides: Partial<EngineAutomation> = {}
  ): EngineAutomation =>
    migrated(
      {
        id: type,
        name: type,
        description: null,
        serverId: null,
        serverUserId: null,
        userId: null,
        enforceAcrossServers: false,
        severity: 'warning',
        isActive: true,
        conditions: { groups: [] },
        actions: { actions: [{ type: 'send', to: ['d1'] }] },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        kind: 'notification',
        triggers: [{ id: `${type}-node`, type, enabled: true }],
        ...overrides,
      }
    );

  const mediaInputs = (activeAutomations: EngineAutomation[]): EvaluationInputs => ({
    activeAutomations,
    activeSessions: [],
    recentSessions: [],
  });

  beforeEach(() => {
    resetDispatcherForTests();
    resetRuleSubscribersForTests();
    registerRuleSubscribers();
    mockRecordRun.mockResolvedValue({ ...transcodeViolation, id: 'run-media' });
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: 'media.added',
        ruleName: 'media.added',
        matched: true,
        matchedGroups: [],
        actions: [],
      },
    ]);
  });

  it('records an add against the library item with no account behind it', async () => {
    const event = {
      type: 'media.added' as const,
      at: new Date(),
      server,
      media: mediaSubject(),
    };

    const result = await dispatch(event, mediaInputs([mediaAutomation('media.added')]));

    expect(result.outcomes).toEqual([{ subscriber: 'media-rules', ok: true }]);
    expect(mockRecordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: 'media', libraryItemId: 'item-1' },
        serverUserId: null,
        serverId: 'server-1',
        session: null,
      })
    );
    const [[recorded]] = mockRecordRun.mock.calls as [[{ trigger: { edgeKey: string | null } }]];
    expect(recorded.trigger.edgeKey).toBeNull();
    expect(result.violations).toEqual([]);
  });

  it('evaluates the media context with the item on it and no user', async () => {
    const event = {
      type: 'media.added' as const,
      at: new Date(),
      server,
      media: mediaSubject(),
    };

    await dispatch(event, mediaInputs([mediaAutomation('media.added')]));

    const [context] = mockEvaluateRulesAsync.mock.calls[0] as [Record<string, unknown>];
    expect(context.session).toBeNull();
    expect(context.serverUser).toBeNull();
    expect(context.media).toMatchObject({ libraryItemId: 'item-1', libraryName: 'Movies' });
    expect(context.subjectKey).toBe('media:item-1');
  });

  it('leaves an automation scoped to an account out of the candidates', async () => {
    const automation = mediaAutomation('media.added', { serverUserId: 'user-1' });

    await dispatch(
      { type: 'media.added', at: new Date(), server, media: mediaSubject() },
      mediaInputs([automation])
    );

    expect(mockEvaluateRulesAsync).not.toHaveBeenCalled();
    expect(mockRecordRun).not.toHaveBeenCalled();
  });
});
