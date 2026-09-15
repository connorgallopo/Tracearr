import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories run before this module's own top-level statements (ESM
// dependency evaluation order), so the classes they reference must come from
// vi.hoisted rather than a plain class declaration below them.
const { queues, workers, FakeQueue, FakeWorker } = vi.hoisted(() => {
  const queues = new Map<string, FakeQueue>();
  const workers = new Map<string, FakeWorker>();
  class FakeQueue {
    name: string;
    opts: unknown;
    upsertJobScheduler = vi.fn(async () => ({}));
    removeJobScheduler = vi.fn(async () => true);
    getJobSchedulers = vi.fn(async () => [] as { key: string; id: string }[]);
    getJobScheduler = vi.fn(async () => null as { next?: number } | null);
    add = vi.fn(async () => ({ id: 'job' }));
    addBulk = vi.fn(async (jobs: unknown[]) => jobs);
    getWaitingCount = vi.fn(async () => 0);
    getActiveCount = vi.fn(async () => 0);
    getCompletedCount = vi.fn(async () => 0);
    getFailedCount = vi.fn(async () => 0);
    getDelayedCount = vi.fn(async () => 0);
    on = vi.fn();
    close = vi.fn(async () => undefined);
    constructor(name: string, opts?: unknown) {
      this.name = name;
      this.opts = opts;
      queues.set(name, this);
    }
  }
  class FakeWorker {
    name: string;
    processor: (job: unknown) => unknown;
    opts: unknown;
    on = vi.fn();
    close = vi.fn(async () => undefined);
    constructor(name: string, processor: (job: unknown) => unknown, opts?: unknown) {
      this.name = name;
      this.processor = processor;
      this.opts = opts;
      workers.set(name, this);
    }
  }
  return { queues, workers, FakeQueue, FakeWorker };
});
vi.mock('bullmq', () => ({
  Queue: FakeQueue,
  Worker: FakeWorker,
  UnrecoverableError: class extends Error {},
}));
vi.mock('../queueConnection.js', () => ({
  queueConnectionOptions: () => ({ host: 'x' }),
  getBullPrefix: () => 'test',
}));
vi.mock('../../services/newsletters/send.js', () => ({ runNewsletter: vi.fn() }));
vi.mock('../../services/newsletters/deliver.js', () => ({
  deliverRecipient: vi.fn(),
  markRecipientFailed: vi.fn(),
}));
const mockUsing = vi.fn();
vi.mock('../../services/newsletters/store.js', () => ({
  newslettersUsingDestination: (...args: unknown[]) => mockUsing(...args) as unknown,
}));
const mockGetDestination = vi.fn();
vi.mock('../../services/notifications/destinationStore.js', () => ({
  getDestination: (...args: unknown[]) => mockGetDestination(...args) as unknown,
}));

import {
  InvalidScheduleError,
  enqueueDeliveries,
  enqueueNewsletterRun,
  initNewsletterQueues,
  onDestinationChanged,
  onDestinationUnavailable,
  removeNewsletterSchedule,
  resyncNewsletterSchedules,
  shutdownNewsletterQueues,
  startNewsletterWorkers,
  upsertNewsletterSchedule,
} from '../newsletterQueue.js';
import { deliverRecipient, markRecipientFailed } from '../../services/newsletters/deliver.js';

const row = {
  id: '11111111-1111-4111-8111-111111111111',
  enabled: true,
  destinationId: '22222222-2222-4222-8222-222222222222',
  schedule: { kind: 'weekly' as const, dayOfWeek: 5, time: '18:00' },
  timezone: 'America/New_York',
};

const usableDestination = {
  id: row.destinationId,
  type: 'email' as const,
  enabled: true,
  configStatus: 'ok' as const,
};

beforeEach(() => {
  queues.clear();
  workers.clear();
  mockGetDestination.mockReset().mockResolvedValue(usableDestination);
  vi.mocked(deliverRecipient).mockReset();
  vi.mocked(markRecipientFailed).mockReset();
  initNewsletterQueues('redis://localhost:6379');
  startNewsletterWorkers();
});
afterEach(async () => {
  await shutdownNewsletterQueues();
});

const runQueue = () => queues.get('newsletters')!;
const deliveryQueue = () => queues.get('newsletter-deliveries')!;
const deliveryWorker = () => workers.get('newsletter-deliveries')!;

describe('schedulers', () => {
  it('upserts one scheduler per enabled newsletter with the derived cron and its timezone', async () => {
    await upsertNewsletterSchedule(row);
    expect(runQueue().upsertJobScheduler).toHaveBeenCalledWith(
      `newsletter-${row.id}`,
      { pattern: '0 18 * * 5', tz: 'America/New_York' },
      { name: 'scheduled-run', data: { newsletterId: row.id, trigger: 'schedule' } }
    );
  });

  it('removes the scheduler when disabled or without a destination', async () => {
    await upsertNewsletterSchedule({ ...row, enabled: false });
    await upsertNewsletterSchedule({ ...row, destinationId: null });
    expect(runQueue().upsertJobScheduler).not.toHaveBeenCalled();
    expect(runQueue().removeJobScheduler).toHaveBeenCalledTimes(2);
    expect(runQueue().removeJobScheduler).toHaveBeenCalledWith(`newsletter-${row.id}`);
  });

  it('removes the scheduler when the destination is disabled, not an email kind, or awaiting re-entry', async () => {
    mockGetDestination.mockResolvedValueOnce({ ...usableDestination, enabled: false });
    await upsertNewsletterSchedule(row);
    mockGetDestination.mockResolvedValueOnce({ ...usableDestination, type: 'discord' });
    await upsertNewsletterSchedule(row);
    mockGetDestination.mockResolvedValueOnce({ ...usableDestination, configStatus: 'reencrypt' });
    await upsertNewsletterSchedule(row);

    expect(runQueue().upsertJobScheduler).not.toHaveBeenCalled();
    expect(runQueue().removeJobScheduler).toHaveBeenCalledTimes(3);
    expect(runQueue().removeJobScheduler).toHaveBeenCalledWith(`newsletter-${row.id}`);
  });

  it('wraps a parser rejection as InvalidScheduleError', async () => {
    runQueue().upsertJobScheduler.mockRejectedValueOnce(new Error('bad cron'));
    await expect(
      upsertNewsletterSchedule({ ...row, schedule: { kind: 'cron', expression: '99 99 * * *' } })
    ).rejects.toBeInstanceOf(InvalidScheduleError);
  });

  it('resync upserts every row and drops schedulers that no longer match a newsletter', async () => {
    runQueue().getJobSchedulers.mockResolvedValueOnce([
      { key: 'newsletter-stale', id: 'newsletter-stale' },
      { key: `newsletter-${row.id}`, id: `newsletter-${row.id}` },
    ]);
    await resyncNewsletterSchedules([row]);
    expect(runQueue().upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(runQueue().removeJobScheduler).toHaveBeenCalledWith('newsletter-stale');
    expect(runQueue().removeJobScheduler).not.toHaveBeenCalledWith(`newsletter-${row.id}`);
  });

  it('a destination going away removes the schedulers of the newsletters that used it', async () => {
    mockUsing.mockResolvedValueOnce([row, { ...row, id: '33333333-3333-4333-8333-333333333333' }]);
    await onDestinationUnavailable(row.destinationId);
    expect(mockUsing).toHaveBeenCalledWith(row.destinationId);
    expect(runQueue().removeJobScheduler).toHaveBeenCalledWith(`newsletter-${row.id}`);
    expect(runQueue().removeJobScheduler).toHaveBeenCalledWith(
      'newsletter-33333333-3333-4333-8333-333333333333'
    );
  });

  it('a destination change re-evaluates the schedule of every newsletter that uses it', async () => {
    mockUsing.mockResolvedValueOnce([row, { ...row, id: '33333333-3333-4333-8333-333333333333' }]);
    await onDestinationChanged(row.destinationId);
    expect(mockUsing).toHaveBeenCalledWith(row.destinationId);
    expect(runQueue().upsertJobScheduler).toHaveBeenCalledTimes(2);
  });
});

describe('jobs', () => {
  it('enqueues a run with its trigger and optional test address', async () => {
    await enqueueNewsletterRun({
      newsletterId: row.id,
      trigger: 'test',
      testAddress: 'me@example.com',
    });
    expect(runQueue().add).toHaveBeenCalledWith(
      'run',
      { newsletterId: row.id, trigger: 'test', testAddress: 'me@example.com' },
      expect.objectContaining({ jobId: expect.stringMatching(/^run-[0-9a-f-]{36}$/) })
    );
  });

  it('enqueues one delivery per recipient keyed by the recipient id with three attempts', async () => {
    const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    const n = await enqueueDeliveries('send-1', ids);
    expect(n).toBe(2);
    expect(deliveryQueue().addBulk).toHaveBeenCalledWith(
      ids.map((recipientId) => ({
        name: 'deliver',
        data: { sendId: 'send-1', recipientId },
        opts: { jobId: recipientId, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
      }))
    );
  });

  it('removeNewsletterSchedule targets the derived id', async () => {
    await removeNewsletterSchedule(row.id);
    expect(runQueue().removeJobScheduler).toHaveBeenCalledWith(`newsletter-${row.id}`);
  });
});

describe('delivery worker', () => {
  it('the delivery queue keeps no record of a failed job on its own', () => {
    expect(deliveryQueue().opts).toMatchObject({
      defaultJobOptions: expect.objectContaining({ removeOnFail: true }),
    });
  });

  it('records the terminal failure and rethrows on the last attempt', async () => {
    const error = new Error('smtp down');
    vi.mocked(deliverRecipient).mockRejectedValueOnce(error);
    const job = {
      data: { sendId: 's', recipientId: 'r1' },
      attemptsMade: 2,
      opts: { attempts: 3 },
    };

    await expect(deliveryWorker().processor(job) as Promise<unknown>).rejects.toBe(error);
    expect(markRecipientFailed).toHaveBeenCalledWith('r1', error);
  });

  it('moves an exhausted delivery to the dlq under a job id that a later retry cannot collide with', () => {
    const dlq = queues.get('newsletter-deliveries-dlq')!;
    const onFailed = deliveryWorker().on.mock.calls.find(([event]) => event === 'failed')?.[1] as (
      job: unknown,
      error: unknown
    ) => void;
    const job = {
      id: 'job-7',
      data: { sendId: 's', recipientId: 'r1' },
      attemptsMade: 3,
      opts: { attempts: 3 },
    };

    onFailed(job, new Error('smtp down'));
    expect(dlq.add).toHaveBeenCalledWith('dlq-delivery', job.data, {
      jobId: expect.stringMatching(/^dlq-job-7-\d+$/),
    });
  });

  it('does not record the failure before the last attempt', async () => {
    const error = new Error('smtp down');
    vi.mocked(deliverRecipient).mockRejectedValueOnce(error);
    const job = {
      data: { sendId: 's', recipientId: 'r1' },
      attemptsMade: 0,
      opts: { attempts: 3 },
    };

    await expect(deliveryWorker().processor(job) as Promise<unknown>).rejects.toBe(error);
    expect(markRecipientFailed).not.toHaveBeenCalled();
  });
});
