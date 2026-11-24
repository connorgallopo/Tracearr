/**
 * Create-path dispatch contract
 *
 * createSessionWithRulesAtomic dispatches session.started with { tx, deferActions }.
 * The real dispatcher, subscribers, evaluate and contextAssembly modules run here:
 * an unregistered subscriber would silently return no violations, so these pin
 * that violations are recorded inside the transaction and actions run after it.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineAutomation, NonMainProfile } from '@tracearr/shared';
import type { sessions } from '../../../db/schema.js';
import type { SessionGeo } from '../../../services/serverLocations.js';
import type { PendingSessionData, ProcessedSession } from '../types.js';

// ============================================================================
// Module Mocks
// ============================================================================

const insertedRow = {
  id: 'sess-1',
  serverId: 'srv1',
  serverUserId: 'su1',
  sessionKey: 'sk',
  plexSessionId: null,
  externalSessionId: null,
  state: 'playing',
  mediaType: 'movie',
  mediaTitle: 'M',
  grandparentTitle: null,
  seasonNumber: null,
  episodeNumber: null,
  year: null,
  thumbPath: null,
  ratingKey: '',
  serverVersionKey: null,
  parentRatingKey: null,
  grandparentRatingKey: null,
  mediaId: null,
  showMediaId: null,
  imdbId: null,
  tmdbId: null,
  tvdbId: null,
  startedAt: new Date('2026-08-16T10:00:00Z'),
  lastSeenAt: new Date('2026-08-16T10:00:00Z'),
  stoppedAt: null,
  durationMs: null,
  totalDurationMs: null,
  progressMs: null,
  lastPausedAt: null,
  pausedDurationMs: 0,
  referenceId: null,
  watched: false,
  shortSession: false,
  forceStopped: false,
  ipAddress: '1.1.1.1',
  geoCity: null,
  geoRegion: null,
  geoCountry: null,
  geoContinent: null,
  geoPostal: null,
  geoLat: null,
  geoLon: null,
  geoAsnNumber: null,
  geoAsnOrganization: null,
  playerName: 'P',
  deviceId: null,
  product: null,
  device: null,
  platform: null,
  quality: null,
  isTranscode: false,
  videoDecision: null,
  audioDecision: null,
  bitrate: null,
  sourceVideoCodec: null,
  sourceAudioCodec: null,
  sourceAudioChannels: null,
  sourceVideoDetails: null,
  sourceAudioDetails: null,
  streamVideoCodec: null,
  streamAudioCodec: null,
  streamVideoDetails: null,
  streamAudioDetails: null,
  transcodeInfo: null,
  subtitleInfo: null,
  channelTitle: null,
  channelIdentifier: null,
  channelThumb: null,
  artistName: null,
  albumName: null,
  trackNumber: null,
  discNumber: null,
} as unknown as typeof sessions.$inferSelect;

/** What the device probe finds: a row means this account has streamed from it before. */
let deviceProbeRows: Array<{ id: string }> = [];

const insertValues = vi.fn((_values: Record<string, unknown>) => ({
  returning: vi.fn().mockResolvedValue([{ ...insertedRow }]),
}));

const fakeTx = {
  execute: vi.fn(),
  insert: vi.fn(() => ({ values: insertValues })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  })),
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(deviceProbeRows) })),
      })),
    })),
  })),
};

// How many times executeActions had run at the moment the transaction callback
// resolved: the deferred contract means this must be 0.
let executeActionsCallsAtCommit = -1;

const mockTransaction = vi.fn(async (cb: (tx: typeof fakeTx) => Promise<unknown>) => {
  const out = await cb(fakeTx);
  executeActionsCallsAtCommit = mockExecuteActions.mock.calls.length;
  return out;
});

vi.mock('../../../db/client.js', () => ({
  db: {
    transaction: (...args: unknown[]) => mockTransaction(...(args as [never])),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));

vi.mock('../../../db/schema.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
}));

const mockEvaluateRulesAsync = vi.fn();
vi.mock('../../../services/automations/engine.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  evaluateRulesAsync: (...args: unknown[]) => mockEvaluateRulesAsync(...args),
}));

const mockRecordRun = vi.fn();
vi.mock('../../../services/automations/runRecorder.js', () => ({
  recordRun: (...args: unknown[]) => mockRecordRun(...args),
  appendRunSteps: vi.fn(),
  noteRunFailure: vi.fn(),
  recordNearMiss: vi.fn(),
  automationCoolingDown: vi.fn().mockResolvedValue(false),
  publishRunFinished: vi.fn(),
  runFinishedOf: (row: { id: string; automationId: string; kind: string; outcome: string }) => ({
    id: row.id,
    automationId: row.automationId,
    kind: row.kind,
    outcome: row.outcome,
  }),
  subjectKeyOf: (scope: { kind: string; sessionId?: string; serverUserId?: string }) =>
    scope.kind === 'session' ? scope.sessionId : scope.serverUserId,
}));

const mockExecuteActions = vi.fn();
vi.mock('../../../services/automations/executors/index.js', () => ({
  executeActions: (...args: unknown[]) => mockExecuteActions(...args),
}));

const mockStoreActionResults = vi.fn();
vi.mock('../../../services/automations/v2Integration.js', () => ({
  storeActionResults: (...args: unknown[]) => mockStoreActionResults(...args),
}));

vi.mock('../../../services/settings.js', () => ({
  getWatchedThreshold: vi.fn().mockResolvedValue(0.85),
}));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  automationsLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../services/geoip.js', () => ({
  geoipService: { isPrivateIP: (ip: string) => ip.startsWith('192.168.') },
}));

const mockResolveSessionGeo = vi.fn();
vi.mock('../../../services/serverLocations.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSessionGeo: (...args: unknown[]) => mockResolveSessionGeo(...args) as unknown,
}));

import { confirmAndPersistSession, createSessionWithRulesAtomic } from '../sessionLifecycle.js';
import { resetDispatcherForTests } from '../../../services/automations/events/dispatcher.js';
import {
  registerRuleSubscribers,
  resetRuleSubscribersForTests,
} from '../../../services/automations/events/subscribers.js';

// ============================================================================
// Fixtures
// ============================================================================

const processed = {
  sessionKey: 'sk',
  ratingKey: undefined,
  state: 'playing',
  mediaType: 'movie',
  mediaTitle: 'M',
  ipAddress: '1.1.1.1',
  playerName: 'P',
} as unknown as ProcessedSession;

const server = { id: 'srv1', name: 'S', type: 'plex' as const };

const KIDS: NonMainProfile = { name: 'Kids', thumbUrl: null, removed: false };

const serverUser = {
  id: 'su1',
  userId: 'u1',
  username: 'x',
  thumbUrl: null,
  identityName: null,
  trustScore: 100,
  lastActivityAt: null,
  createdAt: new Date('2026-01-01'),
  identityServerUserIds: ['su1'],
};

const geo: SessionGeo = {
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
  isLocal: false,
};

const rule: EngineAutomation = {
  id: 'r1',
  name: 'Kill on start',
  description: null,
  serverId: null,
  serverUserId: null,
  userId: null,
  enforceAcrossServers: false,
  severity: 'high',
  isActive: true,
  kind: 'policy',
  cooldownMinutes: null,
  currentVersionId: null,
  conditions: {
    groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 1 }] }],
  },
  actions: { actions: [{ type: 'kill_stream' }] },
  triggers: [{ id: randomUUID(), type: 'session.started', enabled: true }],
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const newDeviceRule: EngineAutomation = {
  ...rule,
  id: 'r2',
  name: 'New device',
  kind: 'notification',
  conditions: { groups: [] },
  actions: { actions: [] },
  triggers: [{ id: randomUUID(), type: 'account.new_device', enabled: true }],
};

const violationRow = { id: 'v1', ruleId: 'r1', serverUserId: 'su1', sessionId: 'sess-1' };

/** The recordRun calls a trigger type produced, in order. */
const runsFor = (trigger: string) =>
  mockRecordRun.mock.calls
    .map(([args]) => args as { scope: unknown; trigger: { type: string } })
    .filter((args) => args.trigger.type === trigger);

function killResults(enqueuedSessionIds: string[]) {
  return [
    {
      action: { type: 'kill_stream' },
      success: true,
      skipped: true,
      skipReason: 'queued',
      enqueuedSessionIds,
    },
  ];
}

function create(activeAutomations: EngineAutomation[] = [rule]) {
  return createSessionWithRulesAtomic({
    processed,
    server,
    serverUser,
    geo,
    activeAutomations,
    activeSessions: [],
    recentSessions: [],
  });
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  deviceProbeRows = [];
  executeActionsCallsAtCommit = -1;
  resetDispatcherForTests();
  resetRuleSubscribersForTests();
  registerRuleSubscribers();
  mockEvaluateRulesAsync.mockResolvedValue([
    {
      ruleId: rule.id,
      ruleName: rule.name,
      matched: true,
      matchedGroups: [0],
      actions: rule.actions.actions,
      evidence: [],
    },
  ]);
  mockRecordRun.mockResolvedValue(violationRow);
  mockExecuteActions.mockResolvedValue(killResults(['sess-1']));
  mockStoreActionResults.mockResolvedValue(undefined);
});

describe('createSessionWithRulesAtomic dispatch contract', () => {
  it('records inside the transaction and defers actions until after commit', async () => {
    const result = await create();

    expect(mockRecordRun).toHaveBeenCalledTimes(1);
    expect(mockRecordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: fakeTx,
        scope: { kind: 'session', sessionId: 'sess-1', fresh: true },
      })
    );

    // Nothing acted before the transaction callback resolved.
    expect(executeActionsCallsAtCommit).toBe(0);
    expect(mockExecuteActions).toHaveBeenCalledTimes(1);
    expect(mockExecuteActions).toHaveBeenCalledWith(
      expect.objectContaining({ violationId: 'v1', rule }),
      rule.actions.actions
    );
    expect(mockStoreActionResults).toHaveBeenCalledWith('v1', rule.id, killResults(['sess-1']));

    expect(result.violationResults).toHaveLength(1);
    expect(result.violationResults[0]?.violation.id).toBe('v1');
    expect(result.violationResults[0]?.rule).toEqual({
      id: 'r1',
      name: 'Kill on start',
      type: null,
    });
    expect(result.wasTerminatedByRule).toBe(true);
  });

  it('wasTerminatedByRule is false when the kill did not target the new session', async () => {
    mockExecuteActions.mockResolvedValue(killResults(['someone-else']));

    const result = await create();

    expect(mockExecuteActions).toHaveBeenCalledTimes(1);
    expect(result.wasTerminatedByRule).toBe(false);
  });

  it('evaluates nothing and acts nothing when there are no active rules', async () => {
    const result = await create([]);

    expect(mockEvaluateRulesAsync).not.toHaveBeenCalled();
    expect(mockRecordRun).not.toHaveBeenCalled();
    expect(mockExecuteActions).not.toHaveBeenCalled();
    expect(result.violationResults).toEqual([]);
    expect(result.wasTerminatedByRule).toBe(false);
  });

  it('never probes for a device when no automation listens for one', async () => {
    await create();

    expect(fakeTx.select).not.toHaveBeenCalled();
    expect(runsFor('account.new_device')).toHaveLength(0);
  });

  it('announces a device this account has no session for, after the commit', async () => {
    mockEvaluateRulesAsync.mockImplementation((_context: unknown, rules: EngineAutomation[]) =>
      Promise.resolve(
        rules.map((r) => ({
          ruleId: r.id,
          ruleName: r.name,
          matched: true,
          matchedGroups: [],
          actions: r.actions.actions,
          evidence: [],
        }))
      )
    );

    await create([rule, newDeviceRule]);

    expect(fakeTx.select).toHaveBeenCalledTimes(1);
    const runs = runsFor('account.new_device');
    expect(runs).toHaveLength(1);
    // Not fresh: the row was committed before the dispatch, so the gate applies.
    expect(runs[0]?.scope).toEqual({ kind: 'session', sessionId: 'sess-1' });
  });

  it('stays quiet when a session for the device is already on file', async () => {
    deviceProbeRows = [{ id: 'sess-0' }];

    await create([rule, newDeviceRule]);

    expect(fakeTx.select).toHaveBeenCalledTimes(1);
    expect(runsFor('account.new_device')).toHaveLength(0);
  });

  it('propagates a subscriber failure out of the transaction and retries a serialization error', async () => {
    mockEvaluateRulesAsync.mockRejectedValue(
      Object.assign(new Error('could not serialize access'), { code: '40001' })
    );

    await expect(create()).rejects.toThrow('could not serialize access');

    expect(mockTransaction).toHaveBeenCalledTimes(3);
    expect(mockRecordRun).not.toHaveBeenCalled();
    expect(mockExecuteActions).not.toHaveBeenCalled();
  });

  it('writes the local flag from the geo onto the row', async () => {
    await createSessionWithRulesAtomic({
      processed,
      server,
      serverUser,
      geo: { ...geo, isLocal: true },
      activeAutomations: [],
      activeSessions: [],
      recentSessions: [],
    });

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ isLocal: true }));
  });

  it('hands session.started the non-main profile the poll resolved', async () => {
    await createSessionWithRulesAtomic({
      processed: { ...processed, nonMainProfile: KIDS },
      server,
      serverUser,
      geo,
      activeAutomations: [rule],
      activeSessions: [],
      recentSessions: [],
    });

    const [context] = mockExecuteActions.mock.calls[0] ?? [];
    expect(context?.session.nonMainProfile).toEqual(KIDS);
  });
});

describe('confirmAndPersistSession geo', () => {
  const startedAt = Date.now() - 45_000;

  const pending = (overrides: Partial<PendingSessionData>): PendingSessionData => ({
    id: 'sess-1',
    confirmation: {
      confirmedPlayback: true,
      firstSeenAt: startedAt,
      maxViewOffset: 0,
      initialViewOffset: null,
    },
    processed,
    server,
    serverUser,
    geo,
    startedAt,
    lastSeenAt: Date.now(),
    currentState: 'playing',
    pausedDurationMs: 0,
    lastPausedAt: null,
    ...overrides,
  });

  it('inserts a local session with the placement in effect when it started, not the cached one', async () => {
    const placed: SessionGeo = {
      ...geo,
      city: 'Chicago',
      region: 'Illinois',
      country: 'US',
      countryCode: 'US',
      lat: 41.88,
      lon: -87.63,
      isLocal: true,
    };
    mockResolveSessionGeo.mockResolvedValue(placed);

    const result = await confirmAndPersistSession({
      pendingData: pending({
        processed: { ...processed, ipAddress: '192.168.1.20' },
        geo: { ...geo, country: 'Local Network', isLocal: true },
      }),
      activeAutomations: [],
      activeSessions: [],
      recentSessions: [],
    });

    expect(mockResolveSessionGeo).toHaveBeenCalledWith(
      '192.168.1.20',
      'srv1',
      false,
      new Date(startedAt)
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        geoCity: 'Chicago',
        geoCountry: 'US',
        geoLat: 41.88,
        isLocal: true,
      })
    );
    expect(result.geo).toEqual(placed);
  });

  it('keeps the geo a remote pending session was seen with', async () => {
    const seen: SessionGeo = {
      ...geo,
      city: 'Boston',
      country: 'US',
      countryCode: 'US',
      lat: 42.36,
      lon: -71.06,
    };

    await confirmAndPersistSession({
      pendingData: pending({ geo: seen }),
      activeAutomations: [],
      activeSessions: [],
      recentSessions: [],
    });

    expect(mockResolveSessionGeo).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ geoCity: 'Boston', geoCountry: 'US', isLocal: false })
    );
  });
});
