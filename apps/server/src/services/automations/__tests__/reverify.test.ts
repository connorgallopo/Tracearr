import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Session } from '@tracearr/shared';
import type * as PollerDatabaseModule from '../../../jobs/poller/database.js';

vi.mock('../../../db/client.js', () => ({
  db: {
    query: {
      sessions: {
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(),
  },
}));

vi.mock('../../cache.js', () => ({
  getCacheService: vi.fn(),
}));

vi.mock('../../../jobs/poller/processor.js', () => ({
  gracePeriodSessionIds: vi.fn().mockReturnValue(new Set()),
}));

vi.mock('../../../jobs/poller/database.js', async (importActual) => {
  const actual = await importActual<typeof PollerDatabaseModule>();
  return {
    ...actual,
    batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
    batchGetIdentityServerUserIds: vi.fn().mockResolvedValue(new Map()),
    getSessionsTerminatedByViolation: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('../../termination.js', () => ({
  terminateSession: vi.fn(),
}));

vi.mock('../engine.js', () => ({
  evaluateRulesAsync: vi.fn(),
}));

import { db } from '../../../db/client.js';
import { getCacheService } from '../../cache.js';
import { terminateSession } from '../../termination.js';
import { evaluateRulesAsync } from '../engine.js';
import { reverifyKillCondition } from '../reverify.js';
import type * as EngineModule from '../engine.js';
import {
  batchGetIdentityServerUserIds,
  batchGetRecentUserSessions,
  getSessionsTerminatedByViolation,
} from '../../../jobs/poller/database.js';

const mockSessionFindFirst = db.query.sessions.findFirst as ReturnType<typeof vi.fn>;
const mockDbSelect = db.select as ReturnType<typeof vi.fn>;
const mockTerminateSession = vi.mocked(terminateSession);
const mockEvaluateRulesAsync = vi.mocked(evaluateRulesAsync);
const mockGetCacheService = vi.mocked(getCacheService);
const mockBatchGetIdentityServerUserIds = vi.mocked(batchGetIdentityServerUserIds);
const mockBatchGetRecentUserSessions = vi.mocked(batchGetRecentUserSessions);
const mockGetSessionsTerminatedByViolation = vi.mocked(getSessionsTerminatedByViolation);

function mockRuleSelect(ruleRow: Record<string, unknown> | undefined) {
  mockDbSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(ruleRow ? [ruleRow] : []),
      }),
    }),
  });
}

function makeSessionRow(overrides: Record<string, unknown> = {}) {
  const serverId = randomUUID();
  const serverUserId = randomUUID();
  return {
    id: randomUUID(),
    serverId,
    serverUserId,
    sessionKey: 'session-key-1',
    state: 'playing',
    mediaType: 'movie',
    mediaTitle: 'Test Movie',
    ratingKey: '123',
    startedAt: new Date(),
    stoppedAt: null,
    ipAddress: '10.0.0.1',
    deviceId: 'device-1',
    server: {
      id: serverId,
      name: 'Test Server',
      type: 'plex',
      url: 'http://localhost:32400',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    serverUser: {
      id: serverUserId,
      userId: randomUUID(),
      serverId,
      externalId: 'ext-1',
      username: 'testuser',
      email: null,
      thumbUrl: null,
      isServerAdmin: false,
      trustScore: 100,
      joinedAt: null,
      lastActivityAt: new Date(),
      removedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    ...overrides,
  };
}

function makeRuleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    name: 'Test Rule',
    description: null,
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    isActive: true,
    severity: 'warning',
    conditions: { groups: [] },
    actions: { actions: [] },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('reverifyKillCondition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCacheService.mockReturnValue({
      getAllActiveSessions: vi.fn().mockResolvedValue([]),
    } as never);
  });

  it('skips with server_historical before reading the rule when the target server is historical', async () => {
    const target = makeSessionRow();
    mockSessionFindFirst.mockResolvedValue({
      ...target,
      server: { ...(target.server as object), historicalAt: new Date('2026-09-01T00:00:00Z') },
    });

    const result = await reverifyKillCondition({
      triggeringSessionId: target.id as string,
      targetSessionId: target.id as string,
      serverId: target.serverId as string,
      ruleId: randomUUID(),
    });

    expect(result).toEqual({
      outcome: 'skipped_condition_cleared',
      skipReason: 'server_historical',
    });
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockTerminateSession).not.toHaveBeenCalled();
  });

  it('skips a retry as server_historical when the switch force-stopped the target meanwhile', async () => {
    const target = makeSessionRow({ stoppedAt: new Date(), forceStopped: true });
    mockSessionFindFirst.mockResolvedValue({
      ...target,
      server: { ...(target.server as object), historicalAt: new Date('2026-09-01T00:00:00Z') },
    });

    const result = await reverifyKillCondition({
      triggeringSessionId: target.id as string,
      targetSessionId: target.id as string,
      serverId: target.serverId as string,
      ruleId: randomUUID(),
      isRetry: true,
    });

    expect(result).toEqual({
      outcome: 'skipped_condition_cleared',
      skipReason: 'server_historical',
    });
  });

  it('returns skipped_already_stopped when the session row is gone', async () => {
    mockSessionFindFirst.mockResolvedValue(undefined);

    const result = await reverifyKillCondition({
      triggeringSessionId: randomUUID(),
      targetSessionId: randomUUID(),
      serverId: randomUUID(),
      ruleId: randomUUID(),
    });

    expect(result.outcome).toBe('skipped_already_stopped');
    expect(mockTerminateSession).not.toHaveBeenCalled();
  });

  it('returns skipped_already_stopped when the session already has stoppedAt set', async () => {
    mockSessionFindFirst.mockResolvedValue(makeSessionRow({ stoppedAt: new Date() }));

    const result = await reverifyKillCondition({
      triggeringSessionId: randomUUID(),
      targetSessionId: randomUUID(),
      serverId: randomUUID(),
      ruleId: randomUUID(),
    });

    expect(result.outcome).toBe('skipped_already_stopped');
    expect(mockTerminateSession).not.toHaveBeenCalled();
  });

  it('returns skipped_already_stopped on a first attempt even when forceStopped is set (some other process stopped it)', async () => {
    mockSessionFindFirst.mockResolvedValue(
      makeSessionRow({ stoppedAt: new Date(), forceStopped: true })
    );

    const result = await reverifyKillCondition({
      triggeringSessionId: randomUUID(),
      targetSessionId: randomUUID(),
      serverId: randomUUID(),
      ruleId: randomUUID(),
      isRetry: false,
    });

    expect(result.outcome).toBe('skipped_already_stopped');
    expect(mockTerminateSession).not.toHaveBeenCalled();
  });

  it('returns skipped_already_stopped on a retry when the session was not force-stopped (a natural stop, not our own kill)', async () => {
    mockSessionFindFirst.mockResolvedValue(
      makeSessionRow({ stoppedAt: new Date(), forceStopped: false })
    );

    const result = await reverifyKillCondition({
      triggeringSessionId: randomUUID(),
      targetSessionId: randomUUID(),
      serverId: randomUUID(),
      ruleId: randomUUID(),
      isRetry: true,
    });

    expect(result.outcome).toBe('skipped_already_stopped');
    expect(mockTerminateSession).not.toHaveBeenCalled();
  });

  it('returns killed (not skipped_already_stopped) on a retry when forceStopped shows this job already terminated it', async () => {
    mockSessionFindFirst.mockResolvedValue(
      makeSessionRow({ stoppedAt: new Date(), forceStopped: true })
    );

    const result = await reverifyKillCondition({
      triggeringSessionId: randomUUID(),
      targetSessionId: randomUUID(),
      serverId: randomUUID(),
      ruleId: randomUUID(),
      isRetry: true,
    });

    // A BullMQ retry only happens after processKillJob threw post-termination
    // (e.g. storeActionResults failing) - re-running reverify must not relabel
    // that earlier success as skipped_already_stopped and re-terminate is
    // neither attempted nor needed.
    expect(result.outcome).toBe('killed');
    expect(mockTerminateSession).not.toHaveBeenCalled();
  });

  it('returns skipped_rule_gone when the rule no longer exists', async () => {
    mockSessionFindFirst.mockResolvedValue(makeSessionRow());
    mockRuleSelect(undefined);

    const result = await reverifyKillCondition({
      triggeringSessionId: randomUUID(),
      targetSessionId: randomUUID(),
      serverId: randomUUID(),
      ruleId: randomUUID(),
    });

    expect(result.outcome).toBe('skipped_rule_gone');
    expect(mockTerminateSession).not.toHaveBeenCalled();
  });

  it('returns skipped_rule_gone when the rule has been disabled', async () => {
    mockSessionFindFirst.mockResolvedValue(makeSessionRow());
    mockRuleSelect(makeRuleRow({ isActive: false }));

    const result = await reverifyKillCondition({
      triggeringSessionId: randomUUID(),
      targetSessionId: randomUUID(),
      serverId: randomUUID(),
      ruleId: randomUUID(),
    });

    expect(result.outcome).toBe('skipped_rule_gone');
    expect(mockTerminateSession).not.toHaveBeenCalled();
  });

  it('returns skipped_condition_cleared when the rule no longer matches current state', async () => {
    mockSessionFindFirst.mockResolvedValue(makeSessionRow());
    const ruleRow = makeRuleRow();
    mockRuleSelect(ruleRow);
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: ruleRow.id,
        ruleName: ruleRow.name,
        matched: false,
        matchedGroups: [],
        actions: [],
      },
    ]);

    const result = await reverifyKillCondition({
      triggeringSessionId: randomUUID(),
      targetSessionId: randomUUID(),
      serverId: randomUUID(),
      ruleId: ruleRow.id,
    });

    expect(result.outcome).toBe('skipped_condition_cleared');
    expect(mockTerminateSession).not.toHaveBeenCalled();
  });

  it('terminates and returns killed when the condition still matches', async () => {
    const sessionRow = makeSessionRow();
    mockSessionFindFirst.mockResolvedValue(sessionRow);
    const ruleRow = makeRuleRow();
    mockRuleSelect(ruleRow);
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: ruleRow.id,
        ruleName: ruleRow.name,
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    mockTerminateSession.mockResolvedValue({
      success: true,
      terminationLogId: randomUUID(),
      outcome: 'terminated',
    });

    const result = await reverifyKillCondition({
      triggeringSessionId: sessionRow.id,
      targetSessionId: sessionRow.id,
      serverId: sessionRow.serverId,
      ruleId: ruleRow.id,
      message: 'Concurrent stream limit exceeded',
    });

    expect(result.outcome).toBe('killed');
    expect(mockTerminateSession).toHaveBeenCalledWith({
      sessionId: sessionRow.id,
      sessionStartedAt: expect.any(Date),
      trigger: 'rule',
      ruleId: ruleRow.id,
      reason: 'Concurrent stream limit exceeded',
    });
  });

  it('widens recentSessions across the identity for enforceAcrossServers rules', async () => {
    const sessionRow = makeSessionRow();
    mockSessionFindFirst.mockResolvedValue(sessionRow);
    const ruleRow = makeRuleRow({ enforceAcrossServers: true });
    mockRuleSelect(ruleRow);

    const siblingServerUserId = randomUUID();
    mockBatchGetIdentityServerUserIds.mockResolvedValue(
      new Map([[sessionRow.serverUser.userId, [sessionRow.serverUserId, siblingServerUserId]]])
    );

    const ownSession = { id: 'own-session', serverUserId: sessionRow.serverUserId } as Session;
    const siblingSession = {
      id: 'sibling-session',
      serverUserId: siblingServerUserId,
    } as Session;
    mockBatchGetRecentUserSessions.mockImplementation(async (ids: string[]) => {
      const map = new Map<string, Session[]>();
      for (const id of ids) {
        if (id === sessionRow.serverUserId) map.set(id, [ownSession]);
        else if (id === siblingServerUserId) map.set(id, [siblingSession]);
        else map.set(id, []);
      }
      return map;
    });

    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: ruleRow.id,
        ruleName: ruleRow.name,
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    mockTerminateSession.mockResolvedValue({
      success: true,
      terminationLogId: randomUUID(),
      outcome: 'terminated',
    });

    await reverifyKillCondition({
      triggeringSessionId: sessionRow.id,
      targetSessionId: sessionRow.id,
      serverId: sessionRow.serverId,
      ruleId: ruleRow.id,
    });

    // The initial fetch already spans the identity, not just the triggering
    // account, so recentSessions matches what live evaluation matched on.
    // The window derives from the rule itself (24h floor here), never from
    // the module default the leader keeps warm.
    expect(mockBatchGetRecentUserSessions).toHaveBeenCalledWith(
      [sessionRow.serverUserId, siblingServerUserId],
      24
    );

    const [context] = mockEvaluateRulesAsync.mock.calls[0]!;
    expect((context.recentSessions as Array<{ id: string }>).map((s) => s.id).sort()).toEqual([
      'own-session',
      'sibling-session',
    ]);
    expect(context.identityServerUserIds).toEqual([sessionRow.serverUserId, siblingServerUserId]);
  });

  it('still derives identity for rules without enforceAcrossServers, but does not widen a single-account identity', async () => {
    const sessionRow = makeSessionRow();
    mockSessionFindFirst.mockResolvedValue(sessionRow);
    const ruleRow = makeRuleRow({ enforceAcrossServers: false });
    mockRuleSelect(ruleRow);
    mockBatchGetIdentityServerUserIds.mockResolvedValue(
      new Map([[sessionRow.serverUser.userId, [sessionRow.serverUserId]]])
    );
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: ruleRow.id,
        ruleName: ruleRow.name,
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    mockTerminateSession.mockResolvedValue({
      success: true,
      terminationLogId: randomUUID(),
      outcome: 'terminated',
    });

    await reverifyKillCondition({
      triggeringSessionId: sessionRow.id,
      targetSessionId: sessionRow.id,
      serverId: sessionRow.serverId,
      ruleId: ruleRow.id,
    });

    // The lookup itself is unconditional - only widening past a single
    // server_user id is skipped, since there's nothing to widen.
    expect(mockBatchGetIdentityServerUserIds).toHaveBeenCalledWith([sessionRow.serverUser.userId]);
    expect(mockBatchGetRecentUserSessions).toHaveBeenCalledWith([sessionRow.serverUserId], 24);
  });

  it('kills a merged-identity user under a rule without enforceAcrossServers when both accounts together clear the condition', async () => {
    const actualEngine = await vi.importActual<typeof EngineModule>('../engine.js');
    mockEvaluateRulesAsync.mockImplementation(actualEngine.evaluateRulesAsync);

    const sessionRow = makeSessionRow();
    mockSessionFindFirst.mockResolvedValue(sessionRow);

    const ruleRow = makeRuleRow({
      enforceAcrossServers: false,
      conditions: {
        groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'eq', value: 2 }] }],
      },
    });
    mockRuleSelect(ruleRow);

    const siblingServerUserId = randomUUID();
    mockBatchGetIdentityServerUserIds.mockResolvedValue(
      new Map([[sessionRow.serverUser.userId, [sessionRow.serverUserId, siblingServerUserId]]])
    );
    mockBatchGetRecentUserSessions.mockImplementation(async (ids: string[]) => {
      const map = new Map<string, Session[]>();
      for (const id of ids) map.set(id, []);
      return map;
    });

    // The triggering session is NOT in the cache here: this is the true
    // post-enqueue production state (wasTerminatedByRule skips adding it),
    // not a stand-in for it. Only the sibling identity account is cached.
    const siblingActiveSession = {
      id: 'sibling-active-session',
      serverUserId: siblingServerUserId,
      deviceId: 'device-b',
      ipAddress: '10.0.0.2',
    } as Session;
    mockGetCacheService.mockReturnValue({
      getAllActiveSessions: vi.fn().mockResolvedValue([siblingActiveSession]),
    } as never);

    mockTerminateSession.mockResolvedValue({
      success: true,
      terminationLogId: randomUUID(),
      outcome: 'terminated',
    });

    // Without unconditional identity aggregation, only the sibling account's
    // session is counted (1), the concurrent_streams == 2 condition clears,
    // and this would wrongly abort as skipped_condition_cleared even though
    // live evaluation (which never gates this on enforceAcrossServers)
    // matched both accounts together.
    const result = await reverifyKillCondition({
      triggeringSessionId: sessionRow.id,
      targetSessionId: sessionRow.id,
      serverId: sessionRow.serverId,
      ruleId: ruleRow.id,
    });

    expect(result.outcome).toBe('killed');
    expect(mockTerminateSession).toHaveBeenCalledWith({
      sessionId: sessionRow.id,
      sessionStartedAt: expect.any(Date),
      trigger: 'rule',
      ruleId: ruleRow.id,
      reason: undefined,
    });
  });

  it('kills the triggering session when it is absent from the cache and only it plus one other session clear concurrent_streams', async () => {
    // This is the actual state reverify runs against at delay_seconds 0 for
    // target: triggering - createSessionWithRulesAtomic's wasTerminatedByRule
    // check keeps the triggering session out of the active-session cache once
    // its kill job is enqueued, so nothing has re-added it by fire time.
    const actualEngine = await vi.importActual<typeof EngineModule>('../engine.js');
    mockEvaluateRulesAsync.mockImplementation(actualEngine.evaluateRulesAsync);

    const sessionRow = makeSessionRow();
    mockSessionFindFirst.mockResolvedValue(sessionRow);

    const ruleRow = makeRuleRow({
      enforceAcrossServers: false,
      conditions: {
        groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'gte', value: 2 }] }],
      },
    });
    mockRuleSelect(ruleRow);

    // No identity widening in play - a single-account identity.
    mockBatchGetIdentityServerUserIds.mockResolvedValue(new Map());
    mockBatchGetRecentUserSessions.mockResolvedValue(new Map());

    const otherActiveSession = {
      id: 'other-active-session',
      serverUserId: sessionRow.serverUserId,
      deviceId: 'device-other',
      ipAddress: '10.0.0.9',
    } as Session;
    mockGetCacheService.mockReturnValue({
      getAllActiveSessions: vi.fn().mockResolvedValue([otherActiveSession]),
    } as never);

    mockTerminateSession.mockResolvedValue({
      success: true,
      terminationLogId: randomUUID(),
      outcome: 'terminated',
    });

    // Cache alone only has the one other session. Unless the triggering
    // session is appended back into the evaluation context, concurrent_streams
    // sees a count of 1 against >= 2 and self-aborts.
    const result = await reverifyKillCondition({
      triggeringSessionId: sessionRow.id,
      targetSessionId: sessionRow.id,
      serverId: sessionRow.serverId,
      ruleId: ruleRow.id,
    });

    expect(result.outcome).toBe('killed');
    expect(mockTerminateSession).toHaveBeenCalledWith({
      sessionId: sessionRow.id,
      sessionStartedAt: expect.any(Date),
      trigger: 'rule',
      ruleId: ruleRow.id,
      reason: undefined,
    });
  });

  it('kills when the triggering session still sits in the cache flagged pending from before its confirmation', async () => {
    // A session that went through the pending phase was cached at first sight
    // with pending: true under the id it keeps. At delay_seconds 0 the job runs
    // before the confirming caller has touched that entry (issue #1308).
    const actualEngine = await vi.importActual<typeof EngineModule>('../engine.js');
    mockEvaluateRulesAsync.mockImplementation(actualEngine.evaluateRulesAsync);

    const sessionRow = makeSessionRow();
    mockSessionFindFirst.mockResolvedValue(sessionRow);

    const ruleRow = makeRuleRow({
      conditions: {
        groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 1 }] }],
      },
    });
    mockRuleSelect(ruleRow);

    mockBatchGetIdentityServerUserIds.mockResolvedValue(new Map());
    mockBatchGetRecentUserSessions.mockResolvedValue(new Map());

    const otherActiveSession = {
      id: 'other-active-session',
      serverUserId: sessionRow.serverUserId,
      deviceId: 'device-other',
      ipAddress: '10.0.0.9',
    } as Session;
    const stalePendingTrigger = { ...sessionRow, pending: true } as unknown as Session;
    mockGetCacheService.mockReturnValue({
      getAllActiveSessions: vi.fn().mockResolvedValue([otherActiveSession, stalePendingTrigger]),
    } as never);

    mockTerminateSession.mockResolvedValue({
      success: true,
      terminationLogId: randomUUID(),
      outcome: 'terminated',
    });

    const result = await reverifyKillCondition({
      triggeringSessionId: sessionRow.id,
      targetSessionId: sessionRow.id,
      serverId: sessionRow.serverId,
      ruleId: ruleRow.id,
    });

    expect(result.outcome).toBe('killed');
    expect(mockTerminateSession).toHaveBeenCalledWith({
      sessionId: sessionRow.id,
      sessionStartedAt: expect.any(Date),
      trigger: 'rule',
      ruleId: ruleRow.id,
      reason: undefined,
    });
  });

  it('R1/R2: evaluates against the TRIGGER context, so a scoped enforceAcrossServers kill of a sibling-server target does not self-abort', async () => {
    const actualEngine = await vi.importActual<typeof EngineModule>('../engine.js');
    mockEvaluateRulesAsync.mockImplementation(actualEngine.evaluateRulesAsync);

    const triggerServerId = randomUUID();
    const targetServerId = randomUUID();
    const identityUserId = randomUUID();

    const triggerRow = makeSessionRow({ serverId: triggerServerId });
    triggerRow.server.id = triggerServerId;
    triggerRow.serverUser.userId = identityUserId;
    const targetRow = makeSessionRow({ serverId: targetServerId });
    targetRow.server.id = targetServerId;
    targetRow.serverUser.userId = identityUserId;

    // target fetched first, trigger second
    mockSessionFindFirst.mockResolvedValueOnce(targetRow).mockResolvedValueOnce(triggerRow);

    const ruleRow = makeRuleRow({
      enforceAcrossServers: true,
      serverId: triggerServerId,
      conditions: {
        groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'gte', value: 1 }] }],
      },
    });
    mockRuleSelect(ruleRow);

    mockBatchGetIdentityServerUserIds.mockResolvedValue(
      new Map([[identityUserId, [triggerRow.serverUserId, targetRow.serverUserId]]])
    );
    // Both identity ids already present so the widen step has nothing to fetch
    // (it would otherwise hit the real db.select).
    mockBatchGetRecentUserSessions.mockResolvedValue(
      new Map([
        [triggerRow.serverUserId, []],
        [targetRow.serverUserId, []],
      ])
    );
    mockTerminateSession.mockResolvedValue({
      success: true,
      terminationLogId: randomUUID(),
      outcome: 'terminated',
    });

    const result = await reverifyKillCondition({
      triggeringSessionId: triggerRow.id,
      targetSessionId: targetRow.id,
      serverId: targetServerId,
      ruleId: ruleRow.id,
      violationId: null,
    });

    expect(result.outcome).toBe('killed');
    expect(mockTerminateSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: targetRow.id })
    );
  });

  it('R3: does not self-compare the context session against its own recent-sessions row in travel_speed', async () => {
    const actualEngine = await vi.importActual<typeof EngineModule>('../engine.js');
    mockEvaluateRulesAsync.mockImplementation(actualEngine.evaluateRulesAsync);

    const sessionRow = makeSessionRow({
      deviceId: null,
      geoLat: 40.7128,
      geoLon: -74.006,
      startedAt: new Date('2024-01-01T10:00:00Z'),
    });
    mockSessionFindFirst.mockResolvedValue(sessionRow);

    const ruleRow = makeRuleRow({
      conditions: {
        groups: [
          {
            conditions: [
              {
                field: 'travel_speed_kmh',
                operator: 'gte',
                value: 1000,
                params: { exclude_same_device: false },
              },
            ],
          },
        ],
      },
    });
    mockRuleSelect(ruleRow);

    // batchGetRecentUserSessions returns the session's OWN row (same id, same
    // coords) alongside a genuinely distant earlier session. With the bug the
    // own row is picked as "previous" (0 km, speed 0) and the rule clears.
    const ownRow = {
      id: sessionRow.id,
      serverUserId: sessionRow.serverUserId,
      deviceId: null,
      geoLat: 40.7128,
      geoLon: -74.006,
      startedAt: new Date('2024-01-01T10:00:00Z'),
    } as unknown as Session;
    const distantEarlier = {
      id: randomUUID(),
      serverUserId: sessionRow.serverUserId,
      deviceId: null,
      geoLat: 51.5074,
      geoLon: -0.1278,
      startedAt: new Date('2024-01-01T09:00:00Z'),
    } as unknown as Session;
    mockBatchGetRecentUserSessions.mockResolvedValue(
      new Map([[sessionRow.serverUserId, [ownRow, distantEarlier]]])
    );
    mockBatchGetIdentityServerUserIds.mockResolvedValue(new Map());
    mockTerminateSession.mockResolvedValue({
      success: true,
      terminationLogId: randomUUID(),
      outcome: 'terminated',
    });

    const result = await reverifyKillCondition({
      triggeringSessionId: sessionRow.id,
      targetSessionId: sessionRow.id,
      serverId: sessionRow.serverId,
      ruleId: ruleRow.id,
      violationId: null,
    });

    expect(result.outcome).toBe('killed');
  });

  it('R6: threads violationId through to terminateSession', async () => {
    const sessionRow = makeSessionRow();
    mockSessionFindFirst.mockResolvedValue(sessionRow);
    const ruleRow = makeRuleRow();
    mockRuleSelect(ruleRow);
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: ruleRow.id,
        ruleName: ruleRow.name,
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    mockTerminateSession.mockResolvedValue({
      success: true,
      terminationLogId: randomUUID(),
      outcome: 'terminated',
    });

    const violationId = randomUUID();
    await reverifyKillCondition({
      triggeringSessionId: sessionRow.id,
      targetSessionId: sessionRow.id,
      serverId: sessionRow.serverId,
      ruleId: ruleRow.id,
      violationId,
    });

    expect(mockTerminateSession).toHaveBeenCalledWith(expect.objectContaining({ violationId }));
  });

  it('returns failed when termination reports failure', async () => {
    const sessionRow = makeSessionRow();
    mockSessionFindFirst.mockResolvedValue(sessionRow);
    const ruleRow = makeRuleRow();
    mockRuleSelect(ruleRow);
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: ruleRow.id,
        ruleName: ruleRow.name,
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    mockTerminateSession.mockResolvedValue({
      success: false,
      terminationLogId: randomUUID(),
      outcome: 'failed',
      error: 'Session not found (may have already ended)',
    });

    const result = await reverifyKillCondition({
      triggeringSessionId: sessionRow.id,
      targetSessionId: sessionRow.id,
      serverId: sessionRow.serverId,
      ruleId: ruleRow.id,
    });

    expect(result.outcome).toBe('failed');
    expect(result.error).toBe('Session not found (may have already ended)');
  });

  it('returns failed when termination throws', async () => {
    const sessionRow = makeSessionRow();
    mockSessionFindFirst.mockResolvedValue(sessionRow);
    const ruleRow = makeRuleRow();
    mockRuleSelect(ruleRow);
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: ruleRow.id,
        ruleName: ruleRow.name,
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    mockTerminateSession.mockRejectedValue(new Error('boom'));

    const result = await reverifyKillCondition({
      triggeringSessionId: sessionRow.id,
      targetSessionId: sessionRow.id,
      serverId: sessionRow.serverId,
      ruleId: ruleRow.id,
    });

    expect(result.outcome).toBe('failed');
    expect(result.error).toBe('boom');
  });

  it('trigger-gone fallback: an enforceAcrossServers identity-wide rule falls back to the target and can still kill', async () => {
    const targetRow = makeSessionRow();
    // Trigger differs from target and is gone by fire time.
    mockSessionFindFirst.mockResolvedValueOnce(targetRow).mockResolvedValueOnce(undefined);

    // Global identity-wide rule (no serverId scope) - the target's own context
    // is coherent, so the fallback proceeds to evaluation rather than aborting.
    const ruleRow = makeRuleRow({ enforceAcrossServers: true, serverId: null });
    mockRuleSelect(ruleRow);
    mockEvaluateRulesAsync.mockResolvedValue([
      {
        ruleId: ruleRow.id,
        ruleName: ruleRow.name,
        matched: true,
        matchedGroups: [0],
        actions: [],
      },
    ]);
    mockTerminateSession.mockResolvedValue({
      success: true,
      terminationLogId: randomUUID(),
      outcome: 'terminated',
    });

    const result = await reverifyKillCondition({
      triggeringSessionId: randomUUID(),
      targetSessionId: targetRow.id,
      serverId: targetRow.serverId,
      ruleId: ruleRow.id,
      violationId: null,
    });

    expect(result.outcome).toBe('killed');
    expect(mockTerminateSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: targetRow.id })
    );
  });

  it('trigger-gone abort: a non-identity rule aborts as skipped_condition_cleared when the trigger is gone', async () => {
    const targetRow = makeSessionRow();
    mockSessionFindFirst.mockResolvedValueOnce(targetRow).mockResolvedValueOnce(undefined);

    const ruleRow = makeRuleRow({ enforceAcrossServers: false });
    mockRuleSelect(ruleRow);

    const result = await reverifyKillCondition({
      triggeringSessionId: randomUUID(),
      targetSessionId: targetRow.id,
      serverId: targetRow.serverId,
      ruleId: ruleRow.id,
      violationId: null,
    });

    expect(result.outcome).toBe('skipped_condition_cleared');
    expect(mockTerminateSession).not.toHaveBeenCalled();
  });

  it('D3: trigger-gone fallback on a serverId-scoped enforceAcrossServers rule reports an unverifiable skipReason, not condition_cleared', async () => {
    const triggerServerId = randomUUID();
    const targetServerId = randomUUID();
    const targetRow = makeSessionRow({ serverId: targetServerId });
    targetRow.server.id = targetServerId;

    // Trigger gone; target sits on a different server than the rule's scope.
    mockSessionFindFirst.mockResolvedValueOnce(targetRow).mockResolvedValueOnce(undefined);

    const ruleRow = makeRuleRow({ enforceAcrossServers: true, serverId: triggerServerId });
    mockRuleSelect(ruleRow);

    const result = await reverifyKillCondition({
      triggeringSessionId: randomUUID(),
      targetSessionId: targetRow.id,
      serverId: targetServerId,
      ruleId: ruleRow.id,
      violationId: null,
    });

    // Outcome stays in the skipped family, but the persisted reason tells the
    // truth: the cross-server condition could not be re-evaluated, it did not
    // "clear". The engine scope check never even runs.
    expect(result.outcome).toBe('skipped_condition_cleared');
    expect(result.skipReason).toBe('trigger_gone_cross_server_unverifiable');
    expect(mockEvaluateRulesAsync).not.toHaveBeenCalled();
    expect(mockTerminateSession).not.toHaveBeenCalled();
  });

  it('D1 (i) trigger-first: a sibling kill still fires when the trigger was already stopped BY THIS violation', async () => {
    const actualEngine = await vi.importActual<typeof EngineModule>('../engine.js');
    mockEvaluateRulesAsync.mockImplementation(actualEngine.evaluateRulesAsync);

    const serverUserId = randomUUID();
    const userId = randomUUID();

    // Trigger already force-stopped by an earlier sibling job of the same match.
    const triggerRow = makeSessionRow({
      deviceId: 'device-trigger',
      stoppedAt: new Date(),
      forceStopped: true,
    });
    triggerRow.serverUserId = serverUserId;
    triggerRow.serverUser.id = serverUserId;
    triggerRow.serverUser.userId = userId;

    // Target is a different, still-playing session of the same user.
    const targetRow = makeSessionRow({ deviceId: 'device-target' });
    targetRow.serverUserId = serverUserId;
    targetRow.serverUser.id = serverUserId;
    targetRow.serverUser.userId = userId;

    // reverify fetches the target first, then the trigger.
    mockSessionFindFirst.mockResolvedValueOnce(targetRow).mockResolvedValueOnce(triggerRow);

    const ruleRow = makeRuleRow({
      enforceAcrossServers: false,
      conditions: {
        groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'gte', value: 2 }] }],
      },
    });
    mockRuleSelect(ruleRow);

    // The termination log for this violation ties the trigger's stop to it.
    mockGetSessionsTerminatedByViolation.mockResolvedValue([
      {
        id: triggerRow.id,
        serverUserId,
        deviceId: 'device-trigger',
        ipAddress: '10.0.0.1',
      } as unknown as Session,
    ]);
    mockBatchGetIdentityServerUserIds.mockResolvedValue(new Map());
    mockBatchGetRecentUserSessions.mockResolvedValue(new Map());
    mockGetCacheService.mockReturnValue({
      getAllActiveSessions: vi.fn().mockResolvedValue([]),
    } as never);
    mockTerminateSession.mockResolvedValue({
      success: true,
      terminationLogId: randomUUID(),
      outcome: 'terminated',
    });

    const result = await reverifyKillCondition({
      triggeringSessionId: triggerRow.id,
      targetSessionId: targetRow.id,
      serverId: targetRow.serverId,
      ruleId: ruleRow.id,
      violationId: randomUUID(),
    });

    // Trigger (counted as still-present) plus the live target reach 2, so
    // concurrent_streams >= 2 still holds and the sibling target is killed.
    // Without the self-inflicted-stop handling this aborts as
    // skipped_condition_cleared and the sibling survives.
    expect(result.outcome).toBe('killed');
    expect(mockTerminateSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: targetRow.id })
    );
  });

  it('D1 (ii) count-drop: a still-pending sibling kill fires even though an earlier sibling already left the cache', async () => {
    const actualEngine = await vi.importActual<typeof EngineModule>('../engine.js');
    mockEvaluateRulesAsync.mockImplementation(actualEngine.evaluateRulesAsync);

    const serverUserId = randomUUID();
    const userId = randomUUID();

    // Trigger (S1) still playing; this job targets a third session (S3).
    const triggerRow = makeSessionRow({ deviceId: 'device-1' });
    triggerRow.serverUserId = serverUserId;
    triggerRow.serverUser.id = serverUserId;
    triggerRow.serverUser.userId = userId;

    const targetRow = makeSessionRow({ deviceId: 'device-3' });
    targetRow.serverUserId = serverUserId;
    targetRow.serverUser.id = serverUserId;
    targetRow.serverUser.userId = userId;

    mockSessionFindFirst.mockResolvedValueOnce(targetRow).mockResolvedValueOnce(triggerRow);

    const ruleRow = makeRuleRow({
      enforceAcrossServers: false,
      conditions: {
        groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'gte', value: 3 }] }],
      },
    });
    mockRuleSelect(ruleRow);

    // The second session (S2) was already killed by an earlier sibling job and
    // has left the cache, so the cache now holds only S1 and S3.
    const s2Id = randomUUID();
    mockGetSessionsTerminatedByViolation.mockResolvedValue([
      { id: s2Id, serverUserId, deviceId: 'device-2', ipAddress: '10.0.0.2' } as unknown as Session,
    ]);
    mockBatchGetIdentityServerUserIds.mockResolvedValue(new Map());
    mockBatchGetRecentUserSessions.mockResolvedValue(new Map());
    mockGetCacheService.mockReturnValue({
      getAllActiveSessions: vi.fn().mockResolvedValue([
        { id: triggerRow.id, serverUserId, deviceId: 'device-1', ipAddress: '10.0.0.1' },
        { id: targetRow.id, serverUserId, deviceId: 'device-3', ipAddress: '10.0.0.3' },
      ]),
    } as never);
    mockTerminateSession.mockResolvedValue({
      success: true,
      terminationLogId: randomUUID(),
      outcome: 'terminated',
    });

    const result = await reverifyKillCondition({
      triggeringSessionId: triggerRow.id,
      targetSessionId: targetRow.id,
      serverId: targetRow.serverId,
      ruleId: ruleRow.id,
      violationId: randomUUID(),
    });

    // Folding the already-killed S2 back into the count restores the total to 3,
    // so concurrent_streams >= 3 still holds. Without it the cache shows only 2
    // and this last sibling would wrongly survive as skipped_condition_cleared.
    expect(result.outcome).toBe('killed');
    expect(mockTerminateSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: targetRow.id })
    );
  });
});
