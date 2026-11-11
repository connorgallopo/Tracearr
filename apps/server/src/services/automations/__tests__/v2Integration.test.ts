/**
 * V2 Integration Tests - Rule notification dependency
 *
 * The send executor already built the event; this dep only resolves the
 * destination ids and reports how many jobs landed, so a rule whose
 * destinations are all disabled can be logged as such.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { automationsLogger } from '../../../utils/logger.js';
import type { NotificationEvent } from '../../notifications/events.js';

const { mockEnqueueNotification, mockApplyTrustChange, mockDispatchTrustChanged, mockFindSession } =
  vi.hoisted(() => ({
    mockEnqueueNotification: vi.fn().mockResolvedValue(2),
    mockApplyTrustChange: vi.fn(),
    mockDispatchTrustChanged: vi.fn().mockResolvedValue(undefined),
    mockFindSession: vi.fn(),
  }));

vi.mock('../../../jobs/notificationQueue.js', () => ({
  enqueueNotification: mockEnqueueNotification,
}));

vi.mock('../../../db/client.js', () => ({
  db: { query: { sessions: { findFirst: mockFindSession } } },
}));

vi.mock('../../../jobs/poller/database.js', () => ({
  invalidateAutomationsCache: vi.fn(),
}));

vi.mock('../../userService.js', () => ({
  recomputeIdentityAggregates: vi.fn(),
  applyTrustChange: mockApplyTrustChange,
}));

vi.mock('../events/producers.js', () => ({
  dispatchTrustChanged: mockDispatchTrustChanged,
}));

import { TOFA_MESSAGE_UNAVAILABLE, createActionExecutorDeps } from '../v2Integration.js';

const event: NotificationEvent = {
  type: 'violation',
  payload: {
    id: 'v1',
    ruleId: 'rule-1',
    serverUserId: 'su-1',
    sessionId: 'sess-1',
    severity: 'warning',
    createdAt: new Date('2026-08-17T00:00:00.000Z'),
    acknowledgedAt: null,
    data: { ruleId: 'rule-1', serverUserId: 'su-1' },
    rule: { id: 'rule-1', name: 'Sharing', type: null },
    session: undefined,
    user: {
      id: 'su-1',
      username: 'alice',
      identityName: 'Alice',
      thumbUrl: null,
      serverId: 'srv-1',
    },
  },
};

describe('createActionExecutorDeps - trust', () => {
  const redis = {} as Redis;
  const applied = {
    previous: 90,
    serverUser: { id: 'su-1', serverId: 'srv-1', trustScore: 85 },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApplyTrustChange.mockResolvedValue(applied);
  });

  it.each([
    ['adjustUserTrust', [-5], { mode: 'adjust', amount: -5 }],
    ['setUserTrust', [20], { mode: 'set', value: 20 }],
    ['resetUserTrust', [], { mode: 'reset' }],
  ] as const)('%s writes once and announces the move once', async (dep, args, change) => {
    const deps = createActionExecutorDeps(redis);

    await (deps[dep] as (...a: unknown[]) => Promise<void>)('su-1', ...args, 'Sharing penalty');

    expect(mockApplyTrustChange).toHaveBeenCalledTimes(1);
    expect(mockApplyTrustChange).toHaveBeenCalledWith('su-1', change);
    expect(mockDispatchTrustChanged).toHaveBeenCalledTimes(1);
    expect(mockDispatchTrustChanged).toHaveBeenCalledWith({
      serverId: 'srv-1',
      serverUserId: 'su-1',
      previous: 90,
      next: 85,
      // The automation's own name is what the notification says moved the score.
      reason: 'Sharing penalty',
    });
  });

  it('announces nothing when the account is already gone', async () => {
    mockApplyTrustChange.mockResolvedValue(null);

    await createActionExecutorDeps(redis).resetUserTrust('su-1', 'Sharing penalty');

    expect(mockDispatchTrustChanged).not.toHaveBeenCalled();
  });
});

describe('createActionExecutorDeps - sendClientMessage', () => {
  it('fails on a tofa session with the reason, since tofa cannot message without stopping', async () => {
    mockFindSession.mockResolvedValue({
      id: 'sess-1',
      sessionKey: 'tofa-session',
      server: { type: 'tofa', url: 'http://tofa.local:33333', token: 'key', historicalAt: null },
    });

    await expect(
      createActionExecutorDeps({} as Redis).sendClientMessage('sess-1', 'Please stop', new Date())
    ).rejects.toThrow(TOFA_MESSAGE_UNAVAILABLE);
  });
});

describe('createActionExecutorDeps - enqueueAutomationNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const source = {
    kind: 'automation',
    automationId: 'rule-1',
    automationName: 'Sharing',
    body: 'over the limit',
  } as const;

  it('hands the event straight to the queue with the destination ids and the source', async () => {
    const deps = createActionExecutorDeps({} as unknown as Redis);

    const count = await deps.enqueueAutomationNotification({ to: ['d1', 'd2'], event, source });

    expect(count).toBe(2);
    expect(mockEnqueueNotification).toHaveBeenCalledWith(event, { to: ['d1', 'd2'], source });
  });

  it('returns the queue count when nothing was enqueued and does not log an enqueue', async () => {
    mockEnqueueNotification.mockResolvedValueOnce(0);
    const info = vi.spyOn(automationsLogger, 'info');
    const deps = createActionExecutorDeps({} as unknown as Redis);

    const count = await deps.enqueueAutomationNotification({ to: ['d1'], event, source });

    expect(count).toBe(0);
    expect(info).not.toHaveBeenCalledWith(
      expect.stringMatching(/^Notification enqueued/),
      expect.anything()
    );
  });
});
