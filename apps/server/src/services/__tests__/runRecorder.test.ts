import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineAutomation, Session } from '@tracearr/shared';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { EvaluationResult } from '../automations/types.js';

const mockExecute = vi.fn();
const mockSelectLimit = vi.fn();
const mockInsertReturning = vi.fn();
const mockTransaction = vi.fn();
const mockRecompute = vi.fn();
const mockUpdateSet = vi.fn();
const mockPublish = vi.fn();
const mockRedisExists = vi.fn();
const mockRedisSetex = vi.fn();
const mockLpush = vi.fn();
const mockLtrim = vi.fn();
const mockExpire = vi.fn();
const mockMultiExec = vi.fn();

let capturedWhere: unknown;
let capturedLockSql: unknown;
let capturedUpdateWhere: unknown;

function makeTx() {
  return {
    execute: (q: unknown) => {
      capturedLockSql = q;
      return mockExecute(q);
    },
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          capturedWhere = w;
          return { limit: mockSelectLimit };
        },
      }),
    }),
    insert: () => ({
      values: () => ({ onConflictDoNothing: () => ({ returning: mockInsertReturning }) }),
    }),
    update: () => ({
      set: (values: unknown) => {
        mockUpdateSet(values);
        return {
          where: (w: unknown) => {
            capturedUpdateWhere = w;
            return { returning: () => Promise.resolve([{ ...inserted, outcome: 'error' }]) };
          },
        };
      },
    }),
  };
}

const render = (q: unknown) => new PgDialect().sqlToQuery(q as SQL);

vi.mock('../../db/client.js', () => ({
  db: {
    transaction: (...args: unknown[]) => mockTransaction(...args),
    update: () => makeTx().update(),
  },
}));
vi.mock('../../db/schema.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
}));
vi.mock('../userService.js', () => ({
  recomputeIdentityAggregatesForServerUser: (...args: unknown[]) => mockRecompute(...args),
}));
vi.mock('../cache.js', () => ({
  getPubSubService: () => ({ publish: (...args: unknown[]) => mockPublish(...args) }),
}));
vi.mock('../../lib/redisShared.js', () => ({
  getRedis: () => ({
    exists: (...args: unknown[]) => mockRedisExists(...args),
    setex: (...args: unknown[]) => mockRedisSetex(...args),
    multi: () => ({
      lpush: (...args: unknown[]) => {
        mockLpush(...args);
        return {
          ltrim: (...trimArgs: unknown[]) => {
            mockLtrim(...trimArgs);
            return {
              expire: (...expireArgs: unknown[]) => {
                mockExpire(...expireArgs);
                return { exec: mockMultiExec };
              },
            };
          },
        };
      },
    }),
  }),
}));
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  automationsLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  appendRunSteps,
  automationCoolingDown,
  buildRunValues,
  noteRunFailure,
  recordNearMiss,
  recordRun,
  publishRunFinished,
  runFinishedOf,
  type RecordRunArgs,
} from '../automations/runRecorder.js';

const automation = {
  id: 'r1',
  name: 'Rule',
  severity: 'high',
  kind: 'policy',
  cooldownMinutes: null,
  currentVersionId: 'ver-1',
  actions: { actions: [] },
  conditions: { groups: [] },
  triggers: [],
} as unknown as EngineAutomation;

const result: EvaluationResult = {
  ruleId: 'r1',
  ruleName: 'Rule',
  matched: true,
  matchedGroups: [0],
  actions: [],
  evidence: [
    {
      groupIndex: 0,
      matched: true,
      conditions: [
        {
          field: 'concurrent_streams',
          operator: 'gte',
          threshold: 2,
          actual: 2,
          matched: true,
          relatedSessionIds: ['s2'],
        },
      ],
    },
  ],
};

const stoppedResult: EvaluationResult = {
  ruleId: 'r1',
  ruleName: 'Rule',
  matched: false,
  matchedGroups: [],
  actions: [],
  stoppedBy: {
    groupIndex: 1,
    matched: false,
    conditions: [
      {
        field: 'concurrent_streams',
        operator: 'gte',
        threshold: 3,
        actual: 1,
        matched: false,
      },
    ],
  },
};

const sessionStartedAt = new Date('2026-08-20T09:58:00Z');
const session = {
  id: 's1',
  sessionKey: 'sk',
  mediaTitle: 'M',
  ipAddress: '1.1.1.1',
  startedAt: sessionStartedAt,
} as Session;
const inserted = {
  id: 'v1',
  automationId: 'r1',
  serverUserId: 'su1',
  serverId: 'srv1',
  sessionId: 's1',
  kind: 'policy',
  outcome: 'completed',
  humanSummary: null,
  severity: 'high',
  subjectKey: 's1',
  startedAt: new Date('2026-08-20T10:00:00Z'),
  finishedAt: new Date('2026-08-20T10:00:00Z'),
  createdAt: new Date('2026-08-20T10:00:00Z'),
  acknowledgedAt: null,
  dismissedAt: null,
};

const eventAt = new Date('2026-08-20T09:59:00Z');
const trigger = { type: 'session.started' as const, nodeId: 'node-1', edgeKey: null, at: eventAt };

function args(overrides: Partial<RecordRunArgs> = {}): RecordRunArgs {
  return {
    automation,
    result,
    serverUserId: 'su1',
    serverId: 'srv1',
    scope: { kind: 'session', sessionId: 's1' },
    session,
    trigger,
    ...overrides,
  };
}

describe('recordRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWhere = undefined;
    capturedLockSql = undefined;
    capturedUpdateWhere = undefined;
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(makeTx())
    );
    mockExecute.mockResolvedValue(undefined);
    mockSelectLimit.mockResolvedValue([]);
    mockInsertReturning.mockResolvedValue([inserted]);
    mockRecompute.mockResolvedValue(undefined);
    mockPublish.mockResolvedValue(undefined);
    mockRedisExists.mockResolvedValue(0);
    mockMultiExec.mockResolvedValue([]);
  });

  describe('policy session scope', () => {
    it('locks, gates, inserts, and recomputes aggregates in its own transaction', async () => {
      const run = await recordRun(args({ marker: { transcodeReEval: true } }));

      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockSelectLimit).toHaveBeenCalledTimes(1);
      expect(mockExecute.mock.invocationCallOrder[0]).toBeLessThan(
        mockSelectLimit.mock.invocationCallOrder[0] ?? Infinity
      );
      const lock = render(capturedLockSql);
      expect(lock.sql).toBe("SELECT pg_advisory_xact_lock(hashtext($1 || '::' || $2))");
      expect(lock.params).toEqual(['s1', 'r1']);
      const gate = render(capturedWhere);
      expect(gate.sql).toBe(
        '("automation_runs"."rule_id" = $1 and "automation_runs"."session_id" = $2 and "automation_runs"."kind" = $3 and ("automation_runs"."acknowledged_at" is null or "automation_runs"."dismissed_at" is not null) and "automation_runs"."outcome" = $4)'
      );
      expect(gate.params).toEqual(['r1', 's1', 'policy', 'completed']);
      expect(mockRecompute).toHaveBeenCalledWith('su1', expect.anything());
      expect(run).toEqual(inserted);
    });

    it('skips and records a near miss when the gate finds an open or dismissed row', async () => {
      mockSelectLimit.mockResolvedValue([{ id: 'existing' }]);

      const run = await recordRun(args());

      expect(run).toBeNull();
      expect(mockInsertReturning).not.toHaveBeenCalled();
      expect(mockUpdateSet).not.toHaveBeenCalled();
      expect(mockRecompute).not.toHaveBeenCalled();
      expect(mockLpush).toHaveBeenCalledTimes(1);
      const [key, entry] = mockLpush.mock.calls[0] as [string, string];
      expect(key).toContain('automation:evals:r1');
      expect(JSON.parse(entry)).toMatchObject({
        reason: 'gate_blocked',
        subjectKey: 's1',
        trigger: 'session.started',
      });
    });

    it('returns null and records a near miss when onConflictDoNothing inserts nothing', async () => {
      mockInsertReturning.mockResolvedValue([]);

      const run = await recordRun(args());

      expect(run).toBeNull();
      expect(mockRecompute).not.toHaveBeenCalled();
      const [, entry] = mockLpush.mock.calls[0] as [string, string];
      expect(JSON.parse(entry)).toMatchObject({ reason: 'gate_blocked', subjectKey: 's1' });
    });

    it('with fresh: true skips the lock and the gate and uses the caller tx', async () => {
      const tx = makeTx();

      const run = await recordRun(
        args({ scope: { kind: 'session', sessionId: 's1', fresh: true }, tx: tx as never })
      );

      expect(mockTransaction).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();
      expect(mockSelectLimit).not.toHaveBeenCalled();
      expect(mockInsertReturning).toHaveBeenCalledTimes(1);
      expect(mockRecompute).toHaveBeenCalledWith('su1', tx);
      expect(run).toEqual(inserted);
    });

    it('leaves violation:new to announce a completed policy run', async () => {
      await recordRun(args());

      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe('policy account scope', () => {
    it('locks on the server user, gates on any completed row, inserts with a null session', async () => {
      const run = await recordRun(
        args({ scope: { kind: 'account', serverUserId: 'su1' }, session: null })
      );

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockSelectLimit).toHaveBeenCalledTimes(1);
      const lock = render(capturedLockSql);
      expect(lock.params).toEqual(['su1', 'r1']);
      const gate = render(capturedWhere);
      expect(gate.sql).toBe(
        '("automation_runs"."rule_id" = $1 and "automation_runs"."server_user_id" = $2 and "automation_runs"."kind" = $3 and "automation_runs"."outcome" = $4)'
      );
      expect(gate.params).toEqual(['r1', 'su1', 'policy', 'completed']);
      expect(run).toEqual(inserted);
    });

    it('skips when any completed row exists for the pair, acknowledged or dismissed included', async () => {
      mockSelectLimit.mockResolvedValue([{ id: 'existing' }]);

      const run = await recordRun(
        args({ scope: { kind: 'account', serverUserId: 'su1' }, session: null })
      );

      expect(run).toBeNull();
      expect(mockInsertReturning).not.toHaveBeenCalled();
    });
  });

  describe('server and install scopes', () => {
    const notify = { ...automation, kind: 'notification' } as EngineAutomation;
    const downEdge = {
      type: 'server.down' as const,
      nodeId: 'node-3',
      edgeKey: '2026-08-20T10:00:00.000Z',
      at: eventAt,
    };
    const userless = {
      automation: notify,
      serverUserId: null,
      trigger: downEdge,
      session: null,
    };

    it('keys a server subject on the server id and writes no account', async () => {
      const values = buildRunValues(
        args({ ...userless, scope: { kind: 'server', serverId: 'srv1' } })
      );

      expect(values.subjectKey).toBe('server:srv1');
      expect(values.serverUserId).toBeNull();
      expect(values.sessionId).toBeNull();
      expect(values.serverId).toBe('srv1');
    });

    it('keys an install subject on the install itself and carries no server', async () => {
      const values = buildRunValues(
        args({ ...userless, scope: { kind: 'install' }, serverId: null })
      );

      expect(values.subjectKey).toBe('install');
      expect(values.serverUserId).toBeNull();
      expect(values.serverId).toBeNull();
    });

    it('gates a server subject per edge, like any other notification', async () => {
      await recordRun(args({ ...userless, scope: { kind: 'server', serverId: 'srv1' } }));

      const lock = render(capturedLockSql);
      expect(lock.params).toEqual(['server:srv1', 'r1']);
      const gate = render(capturedWhere);
      expect(gate.params).toEqual([
        'r1',
        'server:srv1',
        'notification',
        'completed',
        'node-3',
        '2026-08-20T10:00:00.000Z',
      ]);
    });

    it('recomputes no aggregates for a run with no account', async () => {
      await recordRun(args({ ...userless, scope: { kind: 'install' }, serverId: null }));

      expect(mockRecompute).not.toHaveBeenCalled();
    });

    it('refuses a policy run on a user-less subject', async () => {
      await expect(
        recordRun(
          args({
            ...userless,
            automation,
            scope: { kind: 'server', serverId: 'srv1' },
          })
        )
      ).rejects.toThrow(/policy/);
    });
  });

  describe('notification kind', () => {
    const notify = { ...automation, kind: 'notification' } as EngineAutomation;
    const edge = {
      type: 'session.paused' as const,
      nodeId: 'node-2',
      edgeKey: '2026-08-20T10:00:00.000Z',
      at: eventAt,
    };

    it('gates on the automation, subject, trigger node and edge key', async () => {
      await recordRun(args({ automation: notify, trigger: edge }));

      const gate = render(capturedWhere);
      expect(gate.sql).toBe(
        `("automation_runs"."rule_id" = $1 and "automation_runs"."subject_key" = $2 and "automation_runs"."kind" = $3 and "automation_runs"."outcome" = $4 and "automation_runs"."data"->>'triggerId' IS NOT DISTINCT FROM $5 and "automation_runs"."data"->>'edgeKey' IS NOT DISTINCT FROM $6)`
      );
      expect(gate.params).toEqual([
        'r1',
        's1',
        'notification',
        'completed',
        'node-2',
        '2026-08-20T10:00:00.000Z',
      ]);
      expect(mockInsertReturning).toHaveBeenCalledTimes(1);
    });

    it('never lets a policy run of the same automation block the notification gate', async () => {
      await recordRun(args({ automation: notify, trigger: edge }));

      const gate = render(capturedWhere);
      expect(gate.params).toContain('notification');
      expect(gate.params).not.toContain('policy');
    });

    it('treats a replayed edge as a near miss and records nothing', async () => {
      mockSelectLimit.mockResolvedValue([{ id: 'existing' }]);

      const run = await recordRun(args({ automation: notify, trigger: edge }));

      expect(run).toBeNull();
      expect(mockInsertReturning).not.toHaveBeenCalled();
      const [, entry] = mockLpush.mock.calls[0] as [string, string];
      expect(JSON.parse(entry)).toMatchObject({ reason: 'edge_replayed' });
    });

    it('recomputes no aggregates and leaves the announcement to the dispatch', async () => {
      mockInsertReturning.mockResolvedValue([{ ...inserted, kind: 'notification' }]);

      await recordRun(args({ automation: notify, trigger: edge }));

      expect(mockRecompute).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe('stopped by condition', () => {
    it('writes an ungated row naming the failing condition and publishes it', async () => {
      mockInsertReturning.mockResolvedValue([
        { ...inserted, outcome: 'stopped_by_condition', humanSummary: 'x' },
      ]);

      const run = await recordRun(args({ result: stoppedResult }));

      expect(mockExecute).not.toHaveBeenCalled();
      expect(mockSelectLimit).not.toHaveBeenCalled();
      expect(mockRecompute).not.toHaveBeenCalled();
      expect(run).not.toBeNull();
      expect(run?.outcome).toBe('stopped_by_condition');
    });
  });

  describe('transaction path', () => {
    const cooling = {
      ...automation,
      kind: 'notification',
      cooldownMinutes: 15,
    } as EngineAutomation;
    const fresh = { kind: 'session' as const, sessionId: 's1', fresh: true };

    it('holds the cooldown arm and the publish for the caller post-commit phase', async () => {
      const deferred: Array<() => Promise<void>> = [];

      const run = await recordRun(
        args({
          automation: cooling,
          scope: fresh,
          tx: makeTx() as never,
          defer: (effect) => deferred.push(effect),
        })
      );

      expect(run).toEqual(inserted);
      expect(mockRedisSetex).not.toHaveBeenCalled();
      expect(deferred).toHaveLength(1);

      for (const effect of deferred) await effect();

      expect(mockRedisSetex).toHaveBeenCalledTimes(1);
    });

    it('holds the violation recount for the post-commit phase, off the caller executor', async () => {
      const deferred: Array<() => Promise<void>> = [];
      const tx = makeTx();

      await recordRun(
        args({ scope: fresh, tx: tx as never, defer: (effect) => deferred.push(effect) })
      );

      expect(mockRecompute).not.toHaveBeenCalled();

      for (const effect of deferred) await effect();

      expect(mockRecompute).toHaveBeenCalledExactlyOnceWith('su1');
    });

    it('leaves no cooldown behind for a retry when the post-commit phase never runs', async () => {
      let deferred: Array<() => Promise<void>> = [];
      const attempt = () =>
        recordRun(
          args({
            automation: cooling,
            scope: fresh,
            tx: makeTx() as never,
            defer: (effect) => deferred.push(effect),
          })
        );

      await attempt();
      // The serialization conflict discards the transaction; nothing post-commit ran.
      deferred = [];
      await attempt();

      expect(mockRedisSetex).not.toHaveBeenCalled();
      expect(deferred).toHaveLength(1);
    });
  });

  describe('automation cooldown', () => {
    it('arms the subject key on a completed run when the automation sets minutes', async () => {
      await recordRun(args({ automation: { ...automation, cooldownMinutes: 15 } }));

      expect(mockRedisSetex).toHaveBeenCalledWith('tracearr:automation:cooldown:r1:s1', 900, '1');
    });

    it('arms nothing when the automation has no cooldown', async () => {
      await recordRun(args());

      expect(mockRedisSetex).not.toHaveBeenCalled();
    });
  });
});

describe('buildRunValues', () => {
  it('builds the same data payload the writer wrote, plus the marker and the edge', () => {
    const values = buildRunValues(args({ marker: { pauseReEval: true } }));

    expect(values).toEqual({
      automationId: 'r1',
      serverUserId: 'su1',
      sessionId: 's1',
      sessionStartedAt,
      subjectKey: 's1',
      definitionVersionId: 'ver-1',
      kind: 'policy',
      serverId: 'srv1',
      outcome: 'completed',
      humanSummary: null,
      startedAt: expect.any(Date),
      finishedAt: expect.any(Date),
      severity: 'high',
      steps: [
        {
          trigger: { id: 'node-1', type: 'session.started', edgeKey: null },
          sessionId: 's1',
          serverId: 'srv1',
          serverUserId: 'su1',
        },
      ],
      data: {
        evidence: result.evidence,
        relatedSessionIds: ['s2'],
        ruleName: 'Rule',
        matchedGroups: [0],
        triggerId: 'node-1',
        edgeKey: null,
        sessionKey: 'sk',
        mediaTitle: 'M',
        ipAddress: '1.1.1.1',
        pauseReEval: true,
      },
    });
  });

  it('omits session keys and uses a null sessionId for the account scope', () => {
    const values = buildRunValues(
      args({ scope: { kind: 'account', serverUserId: 'su1' }, session: null })
    );

    expect(values.sessionId).toBeNull();
    expect(values.subjectKey).toBe('su1');
    expect(values.serverId).toBe('srv1');
    expect(values.data).not.toHaveProperty('sessionKey');
    expect(values.data).not.toHaveProperty('mediaTitle');
    expect(values.data).not.toHaveProperty('ipAddress');
  });

  it('starts at the trigger event and finishes at the write', () => {
    const values = buildRunValues(args());

    expect(values.startedAt).toEqual(eventAt);
    expect(values.finishedAt).toBeInstanceOf(Date);
    expect(Number(values.finishedAt)).toBeGreaterThan(Number(eventAt));
  });

  it('stamps the version the automation was cached with, and none when it has no version yet', () => {
    expect(buildRunValues(args()).definitionVersionId).toBe('ver-1');
    expect(
      buildRunValues(args({ automation: { ...automation, currentVersionId: null } }))
        .definitionVersionId
    ).toBeNull();
  });

  it('leaves severity null on a notification run', () => {
    const values = buildRunValues(args({ automation: { ...automation, kind: 'notification' } }));

    expect(values.severity).toBeNull();
  });

  it('carries only the failing values of the stopping group into step zero', () => {
    const values = buildRunValues(args({ result: stoppedResult }));

    expect(values.steps?.[0]).toMatchObject({
      stoppedBy: {
        groupIndex: 1,
        conditions: [{ field: 'concurrent_streams', operator: 'gte', threshold: 3, actual: 1 }],
      },
    });
  });

  it('keeps the session evidence out of a diagnostic step', () => {
    const withRelated: EvaluationResult = {
      ...stoppedResult,
      stoppedBy: {
        groupIndex: 0,
        matched: false,
        conditions: [
          {
            field: 'concurrent_streams',
            operator: 'gte',
            threshold: 3,
            actual: 1,
            matched: false,
            relatedSessionIds: ['s2', 's3'],
          },
        ],
      },
    };

    const step = buildRunValues(args({ result: withRelated })).steps?.[0] as {
      stoppedBy: { conditions: Array<Record<string, unknown>> };
    };

    expect(step.stoppedBy.conditions[0]).not.toHaveProperty('relatedSessionIds');
    expect(step.stoppedBy.conditions[0]).not.toHaveProperty('matched');
  });

  it('defaults severity to warning', () => {
    const values = buildRunValues(
      args({ automation: { ...automation, severity: undefined } as unknown as EngineAutomation })
    );

    expect(values.severity).toBe('warning');
  });

  it('says in plain words what an any-of group read', () => {
    const values = buildRunValues(args({ result: stoppedResult }));

    expect(values.outcome).toBe('stopped_by_condition');
    expect(values.humanSummary).toBe('Concurrent streams was not 3 or more.');
  });
});

describe('the summary of a stopped run', () => {
  it('names the failing conditions of an all-of group', () => {
    const values = buildRunValues(
      args({
        result: {
          ...stoppedResult,
          stoppedBy: {
            groupIndex: 0,
            matched: false,
            match: 'all',
            conditions: [
              { field: 'trust_score', operator: 'lt', threshold: 50, actual: 90, matched: false },
              {
                field: 'concurrent_streams',
                operator: 'gte',
                threshold: 2,
                actual: 3,
                matched: true,
              },
            ],
          },
        },
      })
    );

    expect(values.humanSummary).toBe('Trust score was not below 50.');
  });

  it('carries the unit the field is measured in', () => {
    const values = buildRunValues(
      args({
        result: {
          ...stoppedResult,
          stoppedBy: {
            groupIndex: 0,
            matched: false,
            match: 'any',
            conditions: [
              {
                field: 'travel_speed_kmh',
                operator: 'gt',
                threshold: 500,
                actual: 20,
                matched: false,
              },
            ],
          },
        },
      })
    );

    expect(values.humanSummary).toBe('Travel speed was not above 500 km/h.');
  });

  it('joins several failures into one sentence and inverts a negative operator', () => {
    const values = buildRunValues(
      args({
        result: {
          ...stoppedResult,
          stoppedBy: {
            groupIndex: 0,
            matched: false,
            match: 'all',
            conditions: [
              {
                field: 'country',
                operator: 'not_in',
                threshold: ['US', 'CA'],
                actual: 'US',
                matched: false,
              },
              {
                field: 'unique_ips_in_window',
                operator: 'lte',
                threshold: 2,
                actual: 5,
                matched: false,
              },
            ],
          },
        },
      })
    );

    expect(values.humanSummary).toBe('Country was one of US, CA and Unique IPs was not 2 or less.');
  });
});

describe('run finalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends action steps to the stored array', async () => {
    await appendRunSteps('v1', [{ action: 'kill_stream', success: true }]);

    const [values] = mockUpdateSet.mock.calls[0] as [{ steps: unknown }];
    const steps = render(values.steps);
    expect(steps.sql).toContain(`coalesce("automation_runs"."steps", '[]'::jsonb) ||`);
    expect(steps.params).toEqual(['[{"action":"kill_stream","success":true}]']);
    expect(render(capturedUpdateWhere).params).toEqual(['v1']);
  });

  it('writes nothing for an empty step list', async () => {
    await appendRunSteps('v1', []);

    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('records a bookkeeping failure in steps and summary without touching the outcome', async () => {
    await noteRunFailure({ run: inserted as never, serverId: 'srv1', message: 'kill queue down' });

    const [values] = mockUpdateSet.mock.calls[0] as [Record<string, unknown>];
    expect(values).not.toHaveProperty('outcome');
    expect(values).not.toHaveProperty('status');
    expect(values).not.toHaveProperty('acknowledgedAt');
    expect(values).not.toHaveProperty('dismissedAt');
    expect(values.humanSummary).toBe('Action bookkeeping failed: kill queue down');
    const steps = render(values.steps);
    expect(steps.sql).toContain(`coalesce("automation_runs"."steps", '[]'::jsonb) ||`);
    expect(JSON.parse(String(steps.params[0]))).toEqual([
      {
        failure: 'action_bookkeeping',
        runId: 'v1',
        serverId: 'srv1',
        message: 'kill queue down',
      },
    ]);
    expect(render(capturedUpdateWhere).params).toEqual(['v1']);
  });

  it('truncates the failure message so a raw driver error cannot dump its parameters', async () => {
    await noteRunFailure({ run: inserted as never, serverId: 'srv1', message: 'x'.repeat(500) });

    const [values] = mockUpdateSet.mock.calls[0] as [{ humanSummary: string; steps: unknown }];
    expect(values.humanSummary).toBe(`Action bookkeeping failed: ${'x'.repeat(200)}`);
    const entry = JSON.parse(String(render(values.steps).params[0])) as Array<{ message: string }>;
    expect(entry[0]?.message).toHaveLength(200);
  });
});

describe('near misses and cooldown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMultiExec.mockResolvedValue([]);
  });

  it('caps the ring at fifty entries', async () => {
    await recordNearMiss('r1', {
      reason: 'cooldown_active',
      subjectKey: 's1',
      trigger: 'session.started',
    });

    expect(mockLtrim).toHaveBeenCalledWith(expect.any(String), 0, 49);
    expect(mockExpire).toHaveBeenCalled();
    expect(mockMultiExec).toHaveBeenCalledTimes(1);
  });

  it('swallows a redis failure', async () => {
    mockMultiExec.mockRejectedValue(new Error('redis down'));

    await expect(
      recordNearMiss('r1', {
        reason: 'cooldown_active',
        subjectKey: 's1',
        trigger: 'session.started',
      })
    ).resolves.toBeUndefined();
  });

  it('reads the cooldown key only when the automation sets minutes', async () => {
    mockRedisExists.mockResolvedValue(1);

    expect(await automationCoolingDown(automation, 's1')).toBe(false);
    expect(mockRedisExists).not.toHaveBeenCalled();

    expect(await automationCoolingDown({ ...automation, cooldownMinutes: 5 }, 's1')).toBe(true);
    expect(mockRedisExists).toHaveBeenCalledExactlyOnceWith('tracearr:automation:cooldown:r1:s1');
  });
});

describe('run:finished payload', () => {
  it('carries only what tells a client which lists went stale', () => {
    expect(runFinishedOf(inserted as never)).toEqual({
      id: 'v1',
      automationId: 'r1',
      kind: 'policy',
      outcome: 'completed',
    });
  });

  it('publishes one frame for the whole batch and none for an empty one', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const runs = [
      runFinishedOf(inserted as never),
      runFinishedOf({ ...inserted, id: 'v2' } as never),
    ];

    await publishRunFinished(runs, { publish });
    await publishRunFinished([], { publish });

    expect(publish).toHaveBeenCalledExactlyOnceWith('run:finished', runs);
  });
});
