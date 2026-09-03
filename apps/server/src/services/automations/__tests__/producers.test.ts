/**
 * Producer helper tests
 *
 * The dispatch side of the seam: a stop always cancels wakes but only reads an
 * account context when an automation listens, server events assemble their
 * context from the row (or by id, for the SSE fallback), and a server.down
 * driven the way the poller drives it reaches the recorder as a server subject.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSession, EngineAutomation, Session, TriggerNode } from '@tracearr/shared';
import type { EvaluationServer } from '../events/types.js';

// ============================================================================
// Module Mocks
// ============================================================================

const mockGetActiveAutomations = vi.fn();
vi.mock('../../../jobs/poller/database.js', () => ({
  getActiveAutomations: (...args: unknown[]) => mockGetActiveAutomations(...args),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  mergeRecentSessionsForIdentity: () => [],
  maxWindowHoursFromAutomations: () => 24,
}));

const mockServerRows = vi.fn();
const mockTransaction = vi.fn();
vi.mock('../../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(mockServerRows()) }) }),
    }),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('../../cache.js', () => ({ getPubSubService: () => ({ publish: mockPublish }) }));

const mockLoadEvaluationContext = vi.fn();
vi.mock('../events/contextAssembly.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadEvaluationContext: (...args: unknown[]) => mockLoadEvaluationContext(...args),
}));

const mockEvaluateRulesAsync = vi.fn();
vi.mock('../engine.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  evaluateRulesAsync: (...args: unknown[]) => mockEvaluateRulesAsync(...args),
}));

const mockRecordRun = vi.fn();
vi.mock('../runRecorder.js', () => ({
  recordRun: (...args: unknown[]) => mockRecordRun(...args),
  appendRunSteps: vi.fn(),
  noteRunFailure: vi.fn(),
  recordNearMiss: vi.fn(),
  automationCoolingDown: vi.fn().mockResolvedValue(false),
  publishRunFinished: vi.fn(),
  runFinishedOf: (row: { id: string }) => ({ id: row.id }),
  subjectKeyOf: (scope: {
    kind: string;
    sessionId?: string;
    libraryItemId?: string;
    serverId?: string;
  }) => {
    if (scope.kind === 'session') return scope.sessionId;
    if (scope.kind === 'media') return `media:${scope.libraryItemId ?? ''}`;
    if (scope.kind === 'server') return `server:${scope.serverId ?? ''}`;
    return 'install';
  },
}));

vi.mock('../../userService.js', () => ({
  getIdentityServerUserIds: vi.fn().mockResolvedValue(['su-1']),
}));

vi.mock('../executors/index.js', () => ({ executeActions: vi.fn().mockResolvedValue([]) }));
vi.mock('../v2Integration.js', () => ({ storeActionResults: vi.fn() }));
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  automationsLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setContextAssemblyDeps } from '../events/contextAssembly.js';
import { resetDispatcherForTests, subscribe } from '../events/dispatcher.js';
import {
  dispatchMediaAdded,
  dispatchMediaUpgraded,
  dispatchPluginUpdate,
  dispatchServerHealth,
  dispatchServerHealthById,
  dispatchServerUpdate,
  dispatchSessionFirstSeen,
  dispatchSessionStopped,
  dispatchTracearrUpdate,
  dispatchTrustChanged,
  hasMediaListeners,
} from '../events/producers.js';
import { registerRuleSubscribers, resetRuleSubscribersForTests } from '../events/subscribers.js';
import type { RuleEvent } from '../events/types.js';

// ============================================================================
// Helpers
// ============================================================================

const server: EvaluationServer = { id: 'server-1', name: 'Test Plex', type: 'plex' };

const serverRow = {
  id: 'server-1',
  name: 'Test Plex',
  type: 'plex' as const,
  url: 'http://localhost:32400',
};

function automation(
  triggers: TriggerNode[],
  overrides: Partial<EngineAutomation> = {}
): EngineAutomation {
  return {
    id: 'a1',
    name: 'a1',
    description: null,
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    isActive: true,
    severity: 'warning',
    kind: 'notification',
    cooldownMinutes: null,
    currentVersionId: null,
    conditions: { groups: [] },
    actions: { actions: [] },
    createdAt: new Date(),
    updatedAt: new Date(),
    triggers,
    ...overrides,
  };
}

type ParamlessTrigger = Exclude<TriggerNode['type'], 'session.held_for' | 'account.inactive_for'>;

const node = (type: ParamlessTrigger): TriggerNode => ({ id: `${type}-node`, type, enabled: true });

function stoppedSession(): Session {
  return {
    id: 'session-1',
    serverId: 'server-1',
    serverUserId: 'su-1',
    state: 'stopped',
    mediaTitle: 'Test Movie',
  } as Session;
}

/** Captures what the seam handed each subscriber, with the real dispatcher in place. */
function captureEvents(...types: Array<RuleEvent['type']>) {
  const seen: Array<{ event: RuleEvent; inputs: unknown }> = [];
  for (const type of types) {
    subscribe(type, 'spy', async (event, inputs) => {
      seen.push({ event, inputs });
    });
  }
  return seen;
}

// ============================================================================
// Tests
// ============================================================================

describe('dispatchTrustChanged', () => {
  const trustRules = () => [automation([node('account.trust_changed')])];

  beforeEach(() => {
    vi.clearAllMocks();
    resetDispatcherForTests();
    mockGetActiveAutomations.mockResolvedValue([]);
  });

  it('a write that landed on the stored value is not a change', async () => {
    const seen = captureEvents('account.trust_changed');

    await dispatchTrustChanged({
      serverId: 'server-1',
      serverUserId: 'su-1',
      previous: 100,
      next: 100,
      reason: 'Reset trust',
    });

    expect(seen).toHaveLength(0);
    expect(mockGetActiveAutomations).not.toHaveBeenCalled();
    expect(mockLoadEvaluationContext).not.toHaveBeenCalled();
  });

  it('reads no context when nothing listens', async () => {
    const seen = captureEvents('account.trust_changed');

    await dispatchTrustChanged({
      serverId: 'server-1',
      serverUserId: 'su-1',
      previous: 90,
      next: 40,
      reason: null,
    });

    expect(seen).toHaveLength(0);
    expect(mockLoadEvaluationContext).not.toHaveBeenCalled();
  });

  it('carries both sides and the reason, on a context holding the score the write left', async () => {
    const rules = trustRules();
    mockGetActiveAutomations.mockResolvedValue(rules);
    // The producer loads this fresh, so trustScore is the new value rather than the old one.
    const serverUser = {
      id: 'su-1',
      userId: 'u-1',
      trustScore: 40,
      identityServerUserIds: ['su-1'],
    };
    const inputs = { activeAutomations: rules, activeSessions: [], recentSessions: [] };
    mockLoadEvaluationContext.mockResolvedValue({ server, serverUser, inputs });
    const seen = captureEvents('account.trust_changed');

    await dispatchTrustChanged({
      serverId: 'server-1',
      serverUserId: 'su-1',
      previous: 90,
      next: 40,
      reason: 'Too many devices',
    });

    expect(mockLoadEvaluationContext).toHaveBeenCalledWith('server-1', 'su-1', rules);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toMatchObject({
      type: 'account.trust_changed',
      server,
      serverUser: { id: 'su-1', trustScore: 40 },
      session: null,
      previous: 90,
      next: 40,
      reason: 'Too many devices',
    });
    expect(seen[0]?.inputs).toBe(inputs);
  });

  it('says nothing when the account is gone by the time the context is read', async () => {
    mockGetActiveAutomations.mockResolvedValue(trustRules());
    mockLoadEvaluationContext.mockResolvedValue(null);
    const seen = captureEvents('account.trust_changed');

    await dispatchTrustChanged({
      serverId: 'server-1',
      serverUserId: 'su-1',
      previous: 90,
      next: 40,
      reason: null,
    });

    expect(seen).toHaveLength(0);
  });
});

describe('dispatchSessionStopped', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDispatcherForTests();
    mockGetActiveAutomations.mockResolvedValue([]);
  });

  it('cancels wakes through the ref event and reads no context when nothing listens', async () => {
    const seen = captureEvents('session.ended', 'session.stopped');
    const at = new Date('2026-08-21T10:00:00Z');

    await dispatchSessionStopped(stoppedSession(), 60_000, at);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toEqual({
      type: 'session.ended',
      at,
      sessionId: 'session-1',
      serverId: 'server-1',
    });
    expect(mockLoadEvaluationContext).not.toHaveBeenCalled();
  });

  it('carries server, account, session and durationMs once an automation listens', async () => {
    const rules = [automation([node('session.stopped')])];
    mockGetActiveAutomations.mockResolvedValue(rules);
    const serverUser = { id: 'su-1', userId: 'u-1', identityServerUserIds: ['su-1'] };
    const inputs = { activeAutomations: rules, activeSessions: [], recentSessions: [] };
    mockLoadEvaluationContext.mockResolvedValue({ server, serverUser, inputs });
    const seen = captureEvents('session.ended', 'session.stopped');
    const at = new Date('2026-08-21T10:00:00Z');

    await dispatchSessionStopped(stoppedSession(), 60_000, at);

    expect(mockLoadEvaluationContext).toHaveBeenCalledWith('server-1', 'su-1', rules);
    expect(seen.map(({ event }) => event.type)).toEqual(['session.ended', 'session.stopped']);
    expect(seen[1]?.event).toMatchObject({
      type: 'session.stopped',
      at,
      server,
      serverUser,
      durationMs: 60_000,
      session: { id: 'session-1' },
    });
    expect(seen[1]?.inputs).toBe(inputs);
  });

  it.each(['quality_change', 'media_change'] as const)(
    'a %s continuation cancels the wake and ends no stream',
    async (reason) => {
      mockGetActiveAutomations.mockResolvedValue([automation([node('session.stopped')])]);
      const seen = captureEvents('session.ended', 'session.stopped');
      const at = new Date('2026-08-21T10:00:00Z');

      await dispatchSessionStopped(stoppedSession(), 60_000, at, reason);

      expect(seen.map(({ event }) => event.type)).toEqual(['session.ended']);
      expect(mockLoadEvaluationContext).not.toHaveBeenCalled();
    }
  );

  it('still cancels the wake when the account context is gone', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('session.stopped')])]);
    mockLoadEvaluationContext.mockResolvedValue(null);
    const seen = captureEvents('session.ended', 'session.stopped');

    await dispatchSessionStopped(stoppedSession(), 1_000, new Date());

    expect(seen.map(({ event }) => event.type)).toEqual(['session.ended']);
  });

  it('logs and returns when the context read throws, leaving the caller intact', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('session.stopped')])]);
    mockLoadEvaluationContext.mockRejectedValue(new Error('db down'));
    const seen = captureEvents('session.ended', 'session.stopped');

    await expect(
      dispatchSessionStopped(stoppedSession(), 1_000, new Date())
    ).resolves.toBeUndefined();
    expect(seen.map(({ event }) => event.type)).toEqual(['session.ended']);
  });
});

describe('dispatchSessionFirstSeen', () => {
  const serverUser = {
    id: 'su-1',
    userId: 'u-1',
    username: 'alice',
    thumbUrl: null,
    identityName: null,
    trustScore: 100,
    lastActivityAt: null,
    createdAt: new Date(),
    identityServerUserIds: ['su-1'],
  };

  function pendingSession(): Session {
    return {
      id: 'session-1',
      serverId: 'server-1',
      serverUserId: 'su-1',
      state: 'playing',
      mediaTitle: 'Test Movie',
    } as Session;
  }

  const sessions = vi.fn().mockResolvedValue([]);

  beforeEach(() => {
    vi.clearAllMocks();
    resetDispatcherForTests();
    mockGetActiveAutomations.mockResolvedValue([]);
    sessions.mockResolvedValue([]);
    setContextAssemblyDeps({
      getAllActiveSessions: sessions,
      gracePeriodSessionIds: () => new Set<string>(),
    });
  });

  it('reads no context when nothing listens', async () => {
    const seen = captureEvents('session.first_seen');

    await dispatchSessionFirstSeen({
      session: pendingSession(),
      server,
      serverUser,
      at: new Date(),
    });

    expect(seen).toEqual([]);
    expect(sessions).not.toHaveBeenCalled();
  });

  it('carries server, account and the pending session on freshly assembled inputs', async () => {
    const rules = [automation([node('session.first_seen')])];
    mockGetActiveAutomations.mockResolvedValue(rules);
    const seen = captureEvents('session.first_seen');
    const at = new Date('2026-08-31T10:00:00Z');

    await dispatchSessionFirstSeen({ session: pendingSession(), server, serverUser, at });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toMatchObject({
      type: 'session.first_seen',
      at,
      server,
      serverUser,
      session: { id: 'session-1' },
    });
    const inputs = seen[0]?.inputs as { activeAutomations: EngineAutomation[] };
    expect(inputs.activeAutomations).toBe(rules);
  });

  it('logs and returns when the input assembly throws, leaving the caller intact', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('session.first_seen')])]);
    sessions.mockRejectedValue(new Error('redis down'));
    const seen = captureEvents('session.first_seen');

    await expect(
      dispatchSessionFirstSeen({ session: pendingSession(), server, serverUser, at: new Date() })
    ).resolves.toBeUndefined();
    expect(seen).toEqual([]);
  });
});

describe('a first sight reaches the recorder as a fresh session subject', () => {
  const serverUser = {
    id: 'su-1',
    userId: 'u-1',
    username: 'alice',
    thumbUrl: null,
    identityName: null,
    trustScore: 100,
    lastActivityAt: null,
    createdAt: new Date(),
    identityServerUserIds: ['su-1'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetDispatcherForTests();
    resetRuleSubscribersForTests();
    registerRuleSubscribers();
    setContextAssemblyDeps({
      getAllActiveSessions: async () => [],
      gracePeriodSessionIds: () => new Set<string>(),
    });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => fn({}));
    mockRecordRun.mockResolvedValue({ id: 'run-1', automationId: 'a1' });
    mockEvaluateRulesAsync.mockResolvedValue([
      { ruleId: 'a1', ruleName: 'a1', matched: false, matchedGroups: [], actions: [] },
    ]);
  });

  it('records the run fresh against the pending id, unkeyed on any edge', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('session.first_seen')])]);
    const session = {
      id: 'session-1',
      serverId: 'server-1',
      serverUserId: 'su-1',
      state: 'playing',
    } as Session;

    await dispatchSessionFirstSeen({ session, server, serverUser, at: new Date() });

    expect(mockRecordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: 'session', sessionId: 'session-1', fresh: true },
        trigger: expect.objectContaining({
          type: 'session.first_seen',
          nodeId: 'session.first_seen-node',
          edgeKey: null,
        }),
      })
    );
  });
});

describe('server and install producers', () => {
  const cached: ActiveSession[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    resetDispatcherForTests();
    cached.length = 0;
    mockGetActiveAutomations.mockResolvedValue([]);
    mockServerRows.mockReturnValue([serverRow]);
    setContextAssemblyDeps({
      getAllActiveSessions: async () => cached,
      gracePeriodSessionIds: () => new Set<string>(),
    });
  });

  it('dispatches nothing when no automation listens for the health trigger', async () => {
    const seen = captureEvents('server.down', 'server.up');

    await dispatchServerHealth('server.down', server, new Date());
    await dispatchServerHealth('server.up', server, new Date());

    expect(seen).toEqual([]);
  });

  it('publishes the health banner with no automation listening, from the row and from the id', async () => {
    await dispatchServerHealth('server.down', server, new Date());
    await dispatchServerHealthById('server.up', 'server-1', new Date());

    expect(mockPublish.mock.calls).toEqual([
      ['server:down', { serverId: 'server-1', serverName: 'Test Plex' }],
      ['server:up', { serverId: 'server-1', serverName: 'Test Plex' }],
    ]);
  });

  it('publishes no banner for a server row that is already gone', async () => {
    mockServerRows.mockReturnValue([]);

    await dispatchServerHealthById('server.down', 'server-1', new Date());

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('dispatches the row it holds with this server active sessions', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('server.down')])]);
    cached.push({ id: 'sess-here', serverId: 'server-1' } as ActiveSession);
    cached.push({ id: 'sess-elsewhere', serverId: 'server-2' } as ActiveSession);
    const seen = captureEvents('server.down');
    const at = new Date('2026-08-21T11:00:00Z');

    await dispatchServerHealth('server.down', server, at);

    expect(seen[0]?.event).toEqual({ type: 'server.down', at, server });
    const inputs = seen[0]?.inputs as { activeSessions: Session[] };
    expect(inputs.activeSessions.map((s) => s.id)).toEqual(['sess-here']);
  });

  it('skips automations scoped to another server or to an account', async () => {
    mockGetActiveAutomations.mockResolvedValue([
      automation([node('server.down')], { id: 'elsewhere', serverId: 'server-2' }),
      automation([node('server.down')], { id: 'account', serverUserId: 'su-1' }),
      automation([node('server.down')], { id: 'person', userId: 'u-1' }),
    ]);
    const seen = captureEvents('server.down');

    await dispatchServerHealth('server.down', server, new Date());

    expect(seen).toEqual([]);
  });

  it('keeps the automations scoped to this server', async () => {
    const here = automation([node('server.down')], { id: 'here', serverId: 'server-1' });
    mockGetActiveAutomations.mockResolvedValue([
      here,
      automation([node('server.down')], { id: 'elsewhere', serverId: 'server-2' }),
    ]);
    const seen = captureEvents('server.down');

    await dispatchServerHealth('server.down', server, new Date());

    const inputs = seen[0]?.inputs as { activeAutomations: EngineAutomation[] };
    expect(inputs.activeAutomations.map((rule) => rule.id)).toEqual(['here']);
  });

  it('reads the server row by id for the SSE fallback', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('server.up')])]);
    const seen = captureEvents('server.up');
    const at = new Date('2026-08-21T11:05:00Z');

    await dispatchServerHealthById('server.up', 'server-1', at);

    expect(seen[0]?.event).toEqual({ type: 'server.up', at, server });
  });

  it('dispatches nothing when the server row is already deleted', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('server.down')])]);
    mockServerRows.mockReturnValue([]);
    const seen = captureEvents('server.down');

    await dispatchServerHealthById('server.down', 'server-1', new Date());

    expect(seen).toEqual([]);
  });

  it('carries the plugin versions and the download url', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('plugin.update_available')])]);
    const seen = captureEvents('plugin.update_available');

    await dispatchPluginUpdate({
      server,
      installedVersion: '0.2.0',
      latestVersion: '0.3.0',
      downloadUrl: 'https://example.test/releases',
    });

    expect(seen[0]?.event).toMatchObject({
      type: 'plugin.update_available',
      server,
      installedVersion: '0.2.0',
      latestVersion: '0.3.0',
      downloadUrl: 'https://example.test/releases',
    });
  });

  it('carries the media-server versions and the release page', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('server.update_available')])]);
    const seen = captureEvents('server.update_available');

    await dispatchServerUpdate({
      server,
      installedVersion: '10.11.11',
      latestVersion: '10.11.12',
      releaseUrl: 'https://example.test/releases',
    });

    expect(seen[0]?.event).toMatchObject({
      type: 'server.update_available',
      server,
      installedVersion: '10.11.11',
      latestVersion: '10.11.12',
      releaseUrl: 'https://example.test/releases',
    });
  });

  it('dispatches no media-server update when nothing listens for it', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('server.down')])]);
    const seen = captureEvents('server.update_available');

    await dispatchServerUpdate({
      server,
      installedVersion: '10.11.11',
      latestVersion: '10.11.12',
      releaseUrl: 'https://example.test/releases',
    });

    expect(seen).toEqual([]);
  });

  it('carries the install versions with no server and no sessions', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('tracearr.update_available')])]);
    cached.push({ id: 'sess-here', serverId: 'server-1' } as ActiveSession);
    const seen = captureEvents('tracearr.update_available');

    await dispatchTracearrUpdate({
      current: '2.0.0',
      latest: '2.1.0',
      releaseUrl: 'https://example.test/v2.1.0',
    });

    expect(seen[0]?.event).toMatchObject({
      type: 'tracearr.update_available',
      current: '2.0.0',
      latest: '2.1.0',
      releaseUrl: 'https://example.test/v2.1.0',
    });
    const inputs = seen[0]?.inputs as { activeSessions: Session[] };
    expect(inputs.activeSessions).toEqual([]);
  });

  it('dispatches nothing when no automation listens for the install trigger', async () => {
    const seen = captureEvents('tracearr.update_available');

    await dispatchTracearrUpdate({
      current: '2.0.0',
      latest: '2.1.0',
      releaseUrl: 'https://x.test',
    });

    expect(seen).toEqual([]);
  });
});

describe('a poller server.down reaches the recorder as a server subject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDispatcherForTests();
    resetRuleSubscribersForTests();
    registerRuleSubscribers();
    mockServerRows.mockReturnValue([serverRow]);
    setContextAssemblyDeps({
      getAllActiveSessions: async () => [],
      gracePeriodSessionIds: () => new Set<string>(),
    });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => fn({}));
    mockRecordRun.mockResolvedValue({ id: 'run-1', automationId: 'a1' });
    mockEvaluateRulesAsync.mockResolvedValue([
      { ruleId: 'a1', ruleName: 'a1', matched: false, matchedGroups: [], actions: [] },
    ]);
  });

  it('records the run against server:<id> with the trigger node that fired', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('server.down')])]);
    const at = new Date('2026-08-21T12:00:00Z');

    await dispatchServerHealth('server.down', server, at);

    expect(mockRecordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: 'server', serverId: 'server-1' },
        serverId: 'server-1',
        serverUserId: null,
        session: null,
        trigger: expect.objectContaining({
          type: 'server.down',
          nodeId: 'server.down-node',
          edgeKey: at.toISOString(),
        }),
      })
    );
    const [context] = mockEvaluateRulesAsync.mock.calls[0] as [Record<string, unknown>];
    expect(context).toMatchObject({
      subjectKey: 'server:server-1',
      serverUser: null,
      session: null,
      server: { id: 'server-1' },
    });
  });

  it('records nothing when the only automation listens for another trigger', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('server.up')])]);

    await dispatchServerHealth('server.down', server, new Date());

    expect(mockRecordRun).not.toHaveBeenCalled();
  });
});

describe('media producers', () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
    resetDispatcherForTests();
    mockGetActiveAutomations.mockResolvedValue([]);
    setContextAssemblyDeps({
      getAllActiveSessions: async () => [],
      gracePeriodSessionIds: () => new Set<string>(),
    });
  });

  it('reports no listener until an automation names a media trigger on this server', async () => {
    expect(await hasMediaListeners('server-1')).toBe(false);

    mockGetActiveAutomations.mockResolvedValue([
      automation([node('media.upgraded')], { serverId: 'server-2' }),
    ]);
    expect(await hasMediaListeners('server-1')).toBe(false);

    mockGetActiveAutomations.mockResolvedValue([automation([node('media.upgraded')])]);
    expect(await hasMediaListeners('server-1')).toBe(true);
  });

  it('dispatches nothing when only the other media trigger is listened for', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('media.upgraded')])]);
    const seen = captureEvents('media.added');

    await dispatchMediaAdded({ server, media });

    expect(seen).toEqual([]);
  });

  it('carries the item and the server it landed on', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('media.added')])]);
    const seen = captureEvents('media.added');

    await dispatchMediaAdded({ server, media });

    expect(seen[0]?.event).toMatchObject({ type: 'media.added', server, media });
  });

  it('leaves the active-session cache alone, once per item across a whole sync', async () => {
    mockGetActiveAutomations.mockResolvedValue([
      automation([node('media.added')]),
      automation([node('media.upgraded')], { id: 'a2' }),
    ]);
    const sessions = vi.fn().mockResolvedValue([]);
    setContextAssemblyDeps({
      getAllActiveSessions: sessions,
      gracePeriodSessionIds: () => new Set<string>(),
    });

    await dispatchMediaAdded({ server, media });
    await dispatchMediaUpgraded({ server, media, from: quality, changed: ['resolution'] });

    expect(sessions).not.toHaveBeenCalled();
  });

  it('carries the quality it came from and the fields that moved', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('media.upgraded')])]);
    const seen = captureEvents('media.upgraded');
    const from = { ...quality, resolution: '1080p' };

    await dispatchMediaUpgraded({ server, media, from, changed: ['resolution'] });

    expect(seen[0]?.event).toMatchObject({
      type: 'media.upgraded',
      server,
      media,
      from,
      changed: ['resolution'],
    });
  });
});

describe('a media add reaches the recorder as a library-item subject', () => {
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
    quality: {
      resolution: '4k',
      dynamicRange: null,
      videoCodec: 'HEVC',
      audioCodec: 'TRUEHD',
      audioChannels: 8,
      fileSize: 42_000_000_000,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetDispatcherForTests();
    resetRuleSubscribersForTests();
    registerRuleSubscribers();
    setContextAssemblyDeps({
      getAllActiveSessions: async () => [],
      gracePeriodSessionIds: () => new Set<string>(),
    });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => fn({}));
    mockRecordRun.mockResolvedValue({ id: 'run-1', automationId: 'a1' });
    mockEvaluateRulesAsync.mockResolvedValue([
      { ruleId: 'a1', ruleName: 'a1', matched: false, matchedGroups: [], actions: [] },
    ]);
  });

  it('records one run per item, keyed on the library item and unkeyed on any edge', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('media.added')])]);

    await dispatchMediaAdded({ server, media });

    expect(mockRecordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: 'media', libraryItemId: 'item-1' },
        serverId: 'server-1',
        serverUserId: null,
        session: null,
        trigger: expect.objectContaining({
          type: 'media.added',
          nodeId: 'media.added-node',
          edgeKey: null,
        }),
      })
    );
  });

  it('keys an upgrade on the quality it landed on, so a resync repeats nothing', async () => {
    mockGetActiveAutomations.mockResolvedValue([automation([node('media.upgraded')])]);

    await dispatchMediaUpgraded({
      server,
      media,
      from: { ...media.quality, resolution: '1080p' },
      changed: ['resolution'],
    });

    const [[recorded]] = mockRecordRun.mock.calls as [[{ trigger: { edgeKey: string | null } }]];
    expect(recorded.trigger.edgeKey).toBe('4k||HEVC|TRUEHD|8|42000000000');
  });
});
