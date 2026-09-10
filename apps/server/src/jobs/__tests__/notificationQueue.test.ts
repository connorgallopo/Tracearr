/**
 * Notification queue: one job per subscribed destination, delivered by the
 * type registry. Covers subscriber resolution, dedupe ids, the worker's
 * config handling and the DLQ hand-off.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import type * as BullMq from 'bullmq';
import type { ActiveSession, ViolationWithDetails } from '@tracearr/shared';
import type * as NotificationQueue from '../notificationQueue.js';
import type { DestinationRow } from '../../services/notifications/destinationStore.js';
import type { NotificationEvent } from '../../services/notifications/events.js';

interface MockQueue {
  name: string;
  on: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  addBulk: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getWaitingCount: ReturnType<typeof vi.fn>;
  getActiveCount: ReturnType<typeof vi.fn>;
  getCompletedCount: ReturnType<typeof vi.fn>;
  getFailedCount: ReturnType<typeof vi.fn>;
  getDelayedCount: ReturnType<typeof vi.fn>;
}

interface MockWorker {
  name: string;
  processor: (job: unknown) => Promise<void>;
  handlers: Map<string, (...args: any[]) => void>;
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const {
  queueInstances,
  workerInstances,
  mockFindDestinationsForEvent,
  mockGetDestination,
  mockReadConfig,
  mockMarkReencrypt,
  mockRewrapConfig,
  mockGetDestinationType,
  mockRender,
  mockDeliver,
  mockGetServerUserDisplayNames,
} = vi.hoisted(() => ({
  queueInstances: [] as MockQueue[],
  workerInstances: [] as MockWorker[],
  mockFindDestinationsForEvent: vi.fn(),
  mockGetDestination: vi.fn(),
  mockReadConfig: vi.fn(),
  mockMarkReencrypt: vi.fn(),
  mockRewrapConfig: vi.fn(),
  mockGetDestinationType: vi.fn(),
  mockRender: vi.fn(),
  mockDeliver: vi.fn(),
  mockGetServerUserDisplayNames: vi.fn(),
}));

vi.mock('bullmq', async (importOriginal) => ({
  UnrecoverableError: (await importOriginal<typeof BullMq>()).UnrecoverableError,
  Queue: vi.fn(function (name: string) {
    const instance: MockQueue = {
      name,
      on: vi.fn(),
      add: vi.fn(),
      addBulk: vi.fn().mockResolvedValue([]),
      close: vi.fn(),
      getWaitingCount: vi.fn().mockResolvedValue(0),
      getActiveCount: vi.fn().mockResolvedValue(0),
      getCompletedCount: vi.fn().mockResolvedValue(0),
      getFailedCount: vi.fn().mockResolvedValue(0),
      getDelayedCount: vi.fn().mockResolvedValue(0),
    };
    queueInstances.push(instance);
    return instance;
  }),
  Worker: vi.fn(function (name: string, processor: (job: unknown) => Promise<void>) {
    const handlers = new Map<string, (...args: any[]) => void>();
    const instance: MockWorker = {
      name,
      processor,
      handlers,
      on: vi.fn((event: string, fn: (...args: any[]) => void) => {
        handlers.set(event, fn);
        return instance;
      }),
      close: vi.fn(),
    };
    workerInstances.push(instance);
    return instance;
  }),
}));

vi.mock('../queueConnection.js', () => ({
  queueConnectionOptions: (url: string) => ({ url }),
  getBullPrefix: () => 'test:bull',
}));

vi.mock('../../serverState.js', () => ({ isMaintenance: () => false }));

vi.mock('../../services/notifications/destinationStore.js', () => ({
  findDestinationsForEvent: mockFindDestinationsForEvent,
  getDestination: mockGetDestination,
  listDestinations: vi.fn(),
  readConfig: mockReadConfig,
  markReencrypt: mockMarkReencrypt,
  rewrapConfig: mockRewrapConfig,
}));

vi.mock('../../services/notifications/destinations/registry.js', () => ({
  getDestinationType: mockGetDestinationType,
}));

vi.mock('../../services/userService.js', () => ({
  getServerUserDisplayNames: mockGetServerUserDisplayNames,
}));

type QueueModule = typeof NotificationQueue;

async function loadQueue(): Promise<QueueModule> {
  vi.resetModules();
  queueInstances.length = 0;
  workerInstances.length = 0;
  return import('../notificationQueue.js');
}

async function loadInitializedQueue(): Promise<QueueModule> {
  const mod = await loadQueue();
  mod.initNotificationQueue('redis://localhost:6379');
  return mod;
}

function mainQueue(): MockQueue {
  const found = queueInstances.find((q) => q.name === 'notifications-v2');
  if (!found) throw new Error('main queue was not constructed');
  return found;
}

function dlq(): MockQueue {
  const found = queueInstances.find((q) => q.name === 'notifications-v2-dlq');
  if (!found) throw new Error('dlq was not constructed');
  return found;
}

function worker(): MockWorker {
  const found = workerInstances[0];
  if (!found) throw new Error('worker was not constructed');
  return found;
}

function bulkEntries(): Array<{ name: string; data: any; opts: { jobId?: string } }> {
  const call = mainQueue().addBulk.mock.calls[0];
  if (!call) throw new Error('addBulk was not called');
  return call[0] as Array<{ name: string; data: any; opts: { jobId?: string } }>;
}

const destination = (over: Partial<DestinationRow> = {}): DestinationRow => ({
  id: 'd1',
  name: 'Discord',
  type: 'discord',
  config: 'v1:blob',
  events: ['violation_detected'],
  enabled: true,
  builtin: false,
  configStatus: 'ok',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

const violation = (over: Partial<ViolationWithDetails> = {}): NotificationEvent => ({
  type: 'violation',
  payload: {
    id: 'v-1',
    ruleId: 'rule-1',
    serverUserId: 'su-1',
    sessionId: 'sess-1',
    severity: 'warning',
    data: {},
    acknowledgedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    user: {
      id: 'su-1',
      username: 'alice',
      serverId: 'srv-1',
      thumbUrl: null,
      identityName: null,
    },
    rule: { id: 'rule-1', name: 'Sharing', type: null },
    ...over,
  },
});

const sessionStarted: NotificationEvent = {
  type: 'session_started',
  payload: { id: 'sess-1' } as ActiveSession,
};

const serverDown: NotificationEvent = {
  type: 'server_down',
  payload: { serverId: 'srv-1', serverName: 'Plex' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindDestinationsForEvent.mockResolvedValue([]);
  mockGetDestination.mockResolvedValue(null);
  mockReadConfig.mockReturnValue({
    ok: true,
    config: { webhookUrl: 'https://d/hook' },
    rewrap: false,
  });
  mockRender.mockResolvedValue({ body: 'rendered' });
  mockDeliver.mockResolvedValue(undefined);
  mockGetDestinationType.mockReturnValue({
    kind: 'discord',
    events: ['violation_detected'],
    render: mockRender,
    deliver: mockDeliver,
    test: vi.fn(),
  });
});

describe('queue names', () => {
  it('runs on notifications-v2 with a notifications-v2-dlq companion', async () => {
    const mod = await loadInitializedQueue();
    mod.startNotificationWorker();

    expect(queueInstances.map((q) => q.name)).toEqual(['notifications-v2', 'notifications-v2-dlq']);
    expect(worker().name).toBe('notifications-v2');
  });
});

describe('enqueueNotification - subscriber resolution', () => {
  it('enqueues one job per subscribed destination with the event as the job name', async () => {
    const mod = await loadInitializedQueue();
    mockFindDestinationsForEvent.mockResolvedValue([
      destination({ id: 'd1' }),
      destination({ id: 'd2', name: 'Ntfy', type: 'ntfy' }),
    ]);

    const event = violation();
    const count = await mod.enqueueNotification(event);

    expect(mockFindDestinationsForEvent).toHaveBeenCalledWith('violation_detected');
    expect(count).toBe(2);
    expect(mainQueue().addBulk).toHaveBeenCalledTimes(1);
    const entries = bulkEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.name).toBe('violation');
    expect(entries[0]?.data).toMatchObject({
      destinationId: 'd1',
      source: { kind: 'system' },
      event,
    });
    expect(entries[1]?.data.destinationId).toBe('d2');
  });

  it('resolves an explicit to list through getDestination, skipping disabled and reencrypt rows', async () => {
    const mod = await loadInitializedQueue();
    const rows: Record<string, DestinationRow> = {
      ok: destination({ id: 'ok' }),
      off: destination({ id: 'off', enabled: false }),
      stale: destination({ id: 'stale', configStatus: 'reencrypt' }),
    };
    mockGetDestination.mockImplementation((id: string) => Promise.resolve(rows[id] ?? null));

    const count = await mod.enqueueNotification(violation(), {
      to: ['ok', 'off', 'stale', 'gone'],
      source: { kind: 'rule', title: 'Rule Triggered', message: 'alice tripped it' },
    });

    expect(mockFindDestinationsForEvent).not.toHaveBeenCalled();
    expect(mockGetDestination).toHaveBeenCalledTimes(4);
    expect(count).toBe(1);
    const entries = bulkEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.data).toMatchObject({
      destinationId: 'ok',
      source: { kind: 'rule', title: 'Rule Triggered', message: 'alice tripped it' },
    });
  });

  it('returns 0 and skips addBulk when nothing is subscribed', async () => {
    const mod = await loadInitializedQueue();

    expect(await mod.enqueueNotification(violation())).toBe(0);
    expect(mainQueue().addBulk).not.toHaveBeenCalled();
  });

  it('returns 0 and logs when the queue was never initialized', async () => {
    const mod = await loadQueue();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await mod.enqueueNotification(violation())).toBe(0);
    expect(error).toHaveBeenCalled();
    expect(queueInstances).toHaveLength(0);
    error.mockRestore();
  });
});

describe('enqueueNotification - dedupe ids', () => {
  const bucket = (): number => Math.floor(Date.now() / (5 * 60 * 1000));

  it('keys a system violation on the rule, the account and the auto kind', async () => {
    const mod = await loadInitializedQueue();
    mockFindDestinationsForEvent.mockResolvedValue([destination({ id: 'd1' })]);

    await mod.enqueueNotification(violation());

    const jobId = bulkEntries()[0]?.opts.jobId;
    expect(jobId).toBe(`d1|violation-su-1-rule-1-auto-${bucket()}`);
    expect(jobId).not.toMatch(/:/);
  });

  it('keys a rule send as notify so it never collides with the routed violation', async () => {
    const mod = await loadInitializedQueue();
    mockGetDestination.mockResolvedValue(destination({ id: 'd1' }));

    await mod.enqueueNotification(violation(), {
      to: ['d1'],
      source: { kind: 'rule', title: 't', message: 'm' },
    });

    const jobId = bulkEntries()[0]?.opts.jobId;
    expect(jobId).toBe(`d1|violation-su-1-rule-1-notify-${bucket()}`);
    expect(jobId).not.toMatch(/:/);
  });

  it('keys sessions on the internal session id', async () => {
    const mod = await loadInitializedQueue();
    mockFindDestinationsForEvent.mockResolvedValue([destination({ id: 'd1' })]);

    await mod.enqueueNotification(sessionStarted);

    const jobId = bulkEntries()[0]?.opts.jobId;
    expect(jobId).toBe(`d1|session_started-sess-1-${bucket()}`);
    expect(jobId).not.toMatch(/:/);
  });

  it('keys newsletter outcomes on the send, so two newsletters in one bucket both go out', async () => {
    const mod = await loadInitializedQueue();
    mockFindDestinationsForEvent.mockResolvedValue([destination({ id: 'd1' })]);
    const event: NotificationEvent = {
      type: 'newsletter_send',
      payload: {
        newsletterId: 'n-1',
        sendId: 'send-1',
        name: 'Weekly',
        outcome: 'sent',
        trigger: 'schedule',
        recipientCount: 1,
        itemCounts: {},
        error: null,
        windowStart: '2026-08-26T00:00:00.000Z',
        windowEnd: '2026-09-02T00:00:00.000Z',
        historyUrl: null,
      },
    };

    await mod.enqueueNotification(event);

    expect(bulkEntries()[0]?.opts.jobId).toBe(`d1|newsletter_send-send-1-${bucket()}`);
  });

  it('keys server events on the server id', async () => {
    const mod = await loadInitializedQueue();
    mockFindDestinationsForEvent.mockResolvedValue([destination({ id: 'd1' })]);

    await mod.enqueueNotification(serverDown);

    const jobId = bulkEntries()[0]?.opts.jobId;
    expect(jobId).toBe(`d1|server_down-srv-1-${bucket()}`);
    expect(jobId).not.toMatch(/:/);
  });

  it('gives each destination its own id for the same event', async () => {
    const mod = await loadInitializedQueue();
    mockFindDestinationsForEvent.mockResolvedValue([
      destination({ id: 'd1' }),
      destination({ id: 'd2' }),
    ]);

    await mod.enqueueNotification(violation());

    const ids = bulkEntries().map((e) => e.opts.jobId);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) expect(id).not.toMatch(/:/);
  });

  it('keys two automations on the same event apart', async () => {
    const mod = await loadInitializedQueue();
    mockGetDestination.mockResolvedValue(destination({ id: 'd1' }));

    await mod.enqueueNotification(sessionStarted, {
      to: ['d1'],
      source: { kind: 'automation', automationId: 'a-1', automationName: 'One' },
    });
    const first = bulkEntries()[0]?.opts.jobId;

    mainQueue().addBulk.mockClear();
    await mod.enqueueNotification(sessionStarted, {
      to: ['d1'],
      source: { kind: 'automation', automationId: 'a-2', automationName: 'Two' },
    });
    const second = bulkEntries()[0]?.opts.jobId;

    expect(first).toBe(`d1|session_started-sess-1-a-1-${bucket()}`);
    expect(second).toBe(`d1|session_started-sess-1-a-2-${bucket()}`);
    expect(first).not.toBe(second);
  });

  it('keys an automation violation apart from another automation on the same rule', async () => {
    const mod = await loadInitializedQueue();
    mockGetDestination.mockResolvedValue(destination({ id: 'd1' }));

    await mod.enqueueNotification(violation(), {
      to: ['d1'],
      source: { kind: 'automation', automationId: 'a-1', automationName: 'One' },
    });

    expect(bulkEntries()[0]?.opts.jobId).toBe(`d1|violation-su-1-rule-1-a-1-${bucket()}`);
  });

  it('keys media on the library item, so one batch is not one job', async () => {
    const mod = await loadInitializedQueue();
    mockGetDestination.mockResolvedValue(destination({ id: 'd1' }));
    const added = (libraryItemId: string) =>
      ({
        type: 'media_added',
        payload: {
          serverId: 'srv-1',
          serverName: 'Basement',
          serverType: 'plex',
          libraryItemId,
          ratingKey: libraryItemId,
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
          to: {
            resolution: '4k',
            dynamicRange: null,
            videoCodec: 'HEVC',
            audioCodec: 'TRUEHD',
            audioChannels: 8,
            fileSize: 42_000_000_000,
          },
        },
      }) as const;
    const source = { kind: 'automation', automationId: 'a-1', automationName: 'One' } as const;

    await mod.enqueueNotification(added('item-1'), { to: ['d1'], source });
    const first = bulkEntries()[0]?.opts.jobId;
    mainQueue().addBulk.mockClear();
    await mod.enqueueNotification(added('item-2'), { to: ['d1'], source });
    const second = bulkEntries()[0]?.opts.jobId;

    expect(first).toBe(`d1|media_added-item-1-a-1-${bucket()}`);
    expect(second).toBe(`d1|media_added-item-2-a-1-${bucket()}`);
  });

  it('keys a new device on the session, so two accounts are two jobs', async () => {
    const mod = await loadInitializedQueue();
    mockGetDestination.mockResolvedValue(destination({ id: 'd1' }));
    const device = (sessionId: string, serverUserId: string) =>
      ({
        type: 'new_device',
        payload: {
          serverId: 'srv-1',
          serverName: 'Basement',
          serverType: 'plex',
          serverUserId,
          sessionId,
          userName: 'Alice',
          username: 'alice',
          identityName: 'Alice',
          mediaTitle: 'Cars',
          mediaType: 'movie',
          deviceName: 'TV',
          platform: null,
          product: null,
          location: null,
        },
      }) as const;
    const source = { kind: 'automation', automationId: 'a-1', automationName: 'One' } as const;

    await mod.enqueueNotification(device('sess-1', 'su-1'), { to: ['d1'], source });
    const first = bulkEntries()[0]?.opts.jobId;
    mainQueue().addBulk.mockClear();
    await mod.enqueueNotification(device('sess-2', 'su-2'), { to: ['d1'], source });
    const second = bulkEntries()[0]?.opts.jobId;

    expect(first).toBe(`d1|new_device-sess-1-a-1-${bucket()}`);
    expect(second).toBe(`d1|new_device-sess-2-a-1-${bucket()}`);
  });

  it('keys a trust move on the account, so two moves in one bucket collapse', async () => {
    const mod = await loadInitializedQueue();
    mockGetDestination.mockResolvedValue(destination({ id: 'd1' }));
    const moved = (previousScore: number, newScore: number) =>
      ({
        type: 'trust_score_changed',
        payload: {
          serverId: 'srv-1',
          serverName: 'Basement',
          serverType: 'plex',
          serverUserId: 'su-1',
          userName: 'Alice',
          username: 'alice',
          identityName: 'Alice',
          previousScore,
          newScore,
          reason: null,
        },
      }) as const;
    const source = { kind: 'automation', automationId: 'a-1', automationName: 'One' } as const;

    await mod.enqueueNotification(moved(90, 85), { to: ['d1'], source });
    const first = bulkEntries()[0]?.opts.jobId;
    mainQueue().addBulk.mockClear();
    await mod.enqueueNotification(moved(85, 80), { to: ['d1'], source });
    const second = bulkEntries()[0]?.opts.jobId;

    expect(first).toBe(`d1|trust_score_changed-su-1-a-1-${bucket()}`);
    expect(second).toBe(first);
  });

  it('keys an install-wide event that carries no server', async () => {
    const mod = await loadInitializedQueue();
    mockGetDestination.mockResolvedValue(destination({ id: 'd1' }));

    await mod.enqueueNotification(
      {
        type: 'tracearr_update_available',
        payload: { current: '2.0.0', latest: '2.1.0', releaseUrl: 'https://example.com/r' },
      },
      { to: ['d1'], source: { kind: 'automation', automationId: 'a-1', automationName: 'One' } }
    );

    const jobId = bulkEntries()[0]?.opts.jobId;
    expect(jobId).toBe(`d1|tracearr_update_available-install-a-1-${bucket()}`);
    expect(jobId).not.toMatch(/:/);
  });

  it('drops the id when the violation carries neither rule id nor rule type', async () => {
    const mod = await loadInitializedQueue();
    mockFindDestinationsForEvent.mockResolvedValue([destination({ id: 'd1' })]);

    await mod.enqueueNotification(violation({ rule: { id: '', name: 'x', type: null } }));

    expect(bulkEntries()[0]?.opts.jobId).toBeUndefined();
  });
});

describe('enqueueNotification - user name resolution', () => {
  const withEvidence = (): NotificationEvent =>
    violation({
      data: {
        evidence: [
          {
            groupIndex: 0,
            matched: true,
            conditions: [
              {
                field: 'user_id',
                operator: 'not_in',
                threshold: ['su-a', 'su-b'],
                actual: 'alice',
                matched: true,
              },
            ],
          },
        ],
      },
    });

  it('resolves display names once per event, not once per destination', async () => {
    const mod = await loadInitializedQueue();
    mockFindDestinationsForEvent.mockResolvedValue([
      destination({ id: 'd1' }),
      destination({ id: 'd2' }),
    ]);
    mockGetServerUserDisplayNames.mockResolvedValue({ 'su-a': 'Alice', 'su-b': 'Bob' });

    const event = withEvidence();
    await mod.enqueueNotification(event);

    expect(mockGetServerUserDisplayNames).toHaveBeenCalledTimes(1);
    const ids = mockGetServerUserDisplayNames.mock.calls[0]?.[0] as string[];
    expect(ids).toEqual(['su-a', 'su-b']);
    expect(ids).not.toContain('alice');
    if (event.type !== 'violation') throw new Error('expected a violation event');
    expect(event.payload.userNames).toEqual({ 'su-a': 'Alice', 'su-b': 'Bob' });
    expect(bulkEntries()).toHaveLength(2);
  });

  it('still enqueues when the lookup throws', async () => {
    const mod = await loadInitializedQueue();
    mockFindDestinationsForEvent.mockResolvedValue([destination({ id: 'd1' })]);
    mockGetServerUserDisplayNames.mockRejectedValue(new Error('invalid uuid'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await mod.enqueueNotification(withEvidence())).toBe(1);
    expect(bulkEntries()).toHaveLength(1);
    error.mockRestore();
  });
});

describe('worker processing', () => {
  const job = (over: Record<string, unknown> = {}): any => ({
    id: 'job-1',
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: { destinationId: 'd1', source: { kind: 'system' }, event: violation() },
    ...over,
  });

  async function runProcessor(input: unknown): Promise<void> {
    const mod = await loadInitializedQueue();
    mod.startNotificationWorker();
    await worker().processor(input);
  }

  it('renders then delivers with a timeout signal', async () => {
    mockGetDestination.mockResolvedValue(destination({ id: 'd1' }));
    const data = job().data;

    await runProcessor(job());

    expect(mockGetDestinationType).toHaveBeenCalledWith('discord');
    expect(mockRender).toHaveBeenCalledWith(
      data.event,
      { webhookUrl: 'https://d/hook' },
      { destination: { id: 'd1', name: 'Discord' }, source: { kind: 'system' } }
    );
    const deliverCall = mockDeliver.mock.calls[0];
    expect(deliverCall?.[0]).toEqual({ body: 'rendered' });
    expect(deliverCall?.[1]).toEqual({ webhookUrl: 'https://d/hook' });
    expect(deliverCall?.[2].destination).toEqual({ id: 'd1', name: 'Discord' });
    expect(deliverCall?.[2].signal).toBeInstanceOf(AbortSignal);
  });

  it('marks a bad_key row for re-entry and delivers nothing', async () => {
    mockGetDestination.mockResolvedValue(destination({ id: 'd1' }));
    mockReadConfig.mockReturnValue({ ok: false, reason: 'bad_key' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await runProcessor(job());

    expect(mockMarkReencrypt).toHaveBeenCalledWith('d1');
    expect(mockDeliver).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns on a malformed blob without marking it for re-entry', async () => {
    mockGetDestination.mockResolvedValue(destination({ id: 'd1' }));
    mockReadConfig.mockReturnValue({ ok: false, reason: 'malformed' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await runProcessor(job());

    expect(warn).toHaveBeenCalled();
    expect(mockMarkReencrypt).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rewraps a row that opened under the secondary key, then delivers', async () => {
    mockGetDestination.mockResolvedValue(destination({ id: 'd1' }));
    mockReadConfig.mockReturnValue({
      ok: true,
      config: { webhookUrl: 'https://d/hook' },
      rewrap: true,
    });

    await runProcessor(job());

    expect(mockRewrapConfig).toHaveBeenCalledWith('d1', { webhookUrl: 'https://d/hook' });
    expect(mockDeliver).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the destination is gone, disabled or awaiting re-entry', async () => {
    for (const row of [
      null,
      destination({ enabled: false }),
      destination({ configStatus: 'reencrypt' }),
    ]) {
      vi.clearAllMocks();
      mockReadConfig.mockReturnValue({ ok: true, config: {}, rewrap: false });
      mockGetDestination.mockResolvedValue(row);

      await runProcessor(job());

      expect(mockReadConfig).not.toHaveBeenCalled();
      expect(mockDeliver).not.toHaveBeenCalled();
    }
  });

  it('rethrows a delivery failure so BullMQ retries it', async () => {
    mockGetDestination.mockResolvedValue(destination({ id: 'd1' }));
    mockDeliver.mockRejectedValue(new Error('502 from discord'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runProcessor(job())).rejects.toThrow('502 from discord');
    error.mockRestore();
  });
});

describe('failure handler', () => {
  const failedJob = (over: Record<string, unknown> = {}): any => ({
    id: 'job-7',
    attemptsMade: 1,
    opts: { attempts: 3 },
    data: { destinationId: 'd1', source: { kind: 'system' }, event: violation() },
    ...over,
  });

  async function fail(job: unknown, error: Error): Promise<void> {
    const mod = await loadInitializedQueue();
    mod.startNotificationWorker();
    const handler = worker().handlers.get('failed');
    if (!handler) throw new Error('failed handler was not registered');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    handler(job, error);
    spy.mockRestore();
  }

  it('leaves a retryable job on the main queue', async () => {
    await fail(failedJob(), new Error('timeout'));

    expect(dlq().add).not.toHaveBeenCalled();
  });

  it('moves a job to the DLQ once its attempts are exhausted', async () => {
    await fail(failedJob({ attemptsMade: 3 }), new Error('timeout'));

    expect(dlq().add).toHaveBeenCalledWith(
      'dlq-violation',
      expect.objectContaining({ destinationId: 'd1' }),
      { jobId: 'dlq-job-7' }
    );
  });

  it('moves an UnrecoverableError to the DLQ on the first attempt', async () => {
    await fail(failedJob(), new UnrecoverableError('404 webhook gone'));

    expect(dlq().add).toHaveBeenCalledWith('dlq-violation', expect.anything(), {
      jobId: 'dlq-job-7',
    });
  });
});
