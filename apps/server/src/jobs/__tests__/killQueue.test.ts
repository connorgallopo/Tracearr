import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

const { mockReverifyKillCondition, mockStoreActionResults } = vi.hoisted(() => ({
  mockReverifyKillCondition: vi.fn(),
  mockStoreActionResults: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/automations/reverify.js', () => ({
  reverifyKillCondition: mockReverifyKillCondition,
}));

vi.mock('../../services/automations/v2Integration.js', () => ({
  storeActionResults: mockStoreActionResults,
}));

vi.mock('../../serverState.js', () => ({
  isMaintenance: vi.fn().mockReturnValue(false),
}));

const mockQueueAdd = vi.fn();
const mockQueueClose = vi.fn();
const mockWorkerClose = vi.fn();

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function MockQueue() {
    return {
      add: mockQueueAdd,
      close: mockQueueClose,
      on: vi.fn(),
    };
  }),
  Worker: vi.fn().mockImplementation(function MockWorker() {
    return {
      on: vi.fn(),
      close: mockWorkerClose,
    };
  }),
}));

import {
  initKillQueue,
  enqueueKill,
  processKillJob,
  shutdownKillQueue,
  type KillJobData,
} from '../killQueue.js';
import {
  setActionExecutorDeps,
  resetActionExecutorDeps,
  type ActionExecutorDeps,
} from '../../services/automations/executors/index.js';
import type { Job } from 'bullmq';

function makeJob(data: KillJobData, attemptsMade = 0, attempts = 3): Job<KillJobData> {
  return { data, attemptsMade, opts: { attempts } } as unknown as Job<KillJobData>;
}

/** A single-target (target: 'triggering') kill payload: trigger and target
 *  are the same session. */
function makeData(overrides: Partial<KillJobData> = {}): KillJobData {
  const sessionId = randomUUID();
  return {
    targetSessionId: sessionId,
    triggeringSessionId: sessionId,
    serverId: randomUUID(),
    ruleId: randomUUID(),
    violationId: randomUUID(),
    ...overrides,
  };
}

describe('killQueue', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockQueueAdd.mockReset();
    await shutdownKillQueue();
    initKillQueue('redis://localhost:6379');
    resetActionExecutorDeps();
  });

  describe('enqueueKill', () => {
    it('carries delay_seconds through as milliseconds', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'job-1' });

      const data = makeData();

      await enqueueKill(data, 30);

      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const [, jobData, opts] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual(data);
      expect(opts.delay).toBe(30000);
    });

    it('uses zero delay when delaySeconds is 0', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'job-2' });

      await enqueueKill(makeData({ violationId: null }), 0);

      const [, , opts] = mockQueueAdd.mock.calls[0]!;
      expect(opts.delay).toBe(0);
    });

    it('returns undefined and does not enqueue when the queue is not initialized', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'job-x' });
      await shutdownKillQueue();

      const result = await enqueueKill(makeData(), 5);

      expect(result).toBeUndefined();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('builds jobId from violationId and targetSessionId for dedup', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'job-3' });

      const targetSessionId = randomUUID();
      const violationId = randomUUID();

      await enqueueKill(
        makeData({ targetSessionId, triggeringSessionId: targetSessionId, violationId }),
        10
      );

      const [, , opts] = mockQueueAdd.mock.calls[0]!;
      expect(opts.jobId).toBe(`kill:${violationId}:${targetSessionId}`);
    });

    it('builds a colon-safe, time-bucketed fallback jobId when violationId is null', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'job-3b' });

      const targetSessionId = randomUUID();
      const ruleId = randomUUID();

      await enqueueKill(
        makeData({
          targetSessionId,
          triggeringSessionId: targetSessionId,
          ruleId,
          violationId: null,
        }),
        10
      );

      const [, , opts] = mockQueueAdd.mock.calls[0]!;
      // BullMQ rejects a custom jobId with ':' unless it splits into exactly
      // three segments, so the fallback keeps exactly two colons.
      expect(opts.jobId.split(':')).toHaveLength(3);
      expect(opts.jobId).toMatch(new RegExp(`^kill:${targetSessionId}:rule_${ruleId}_\\d+$`));
    });

    it('gives distinct fallback jobIds to distinct rules matching the same session', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'job-3c' });

      const targetSessionId = randomUUID();
      const ruleIdA = randomUUID();
      const ruleIdB = randomUUID();

      await enqueueKill(
        makeData({
          targetSessionId,
          triggeringSessionId: targetSessionId,
          ruleId: ruleIdA,
          violationId: null,
        }),
        10
      );
      await enqueueKill(
        makeData({
          targetSessionId,
          triggeringSessionId: targetSessionId,
          ruleId: ruleIdB,
          violationId: null,
        }),
        10
      );

      const jobIdA = mockQueueAdd.mock.calls[0]![2].jobId;
      const jobIdB = mockQueueAdd.mock.calls[1]![2].jobId;
      expect(jobIdA).not.toBe(jobIdB);
      expect(jobIdA).toContain(`rule_${ruleIdA}_`);
      expect(jobIdB).toContain(`rule_${ruleIdB}_`);
    });

    it('gives distinct jobIds to each target when a multi-target match kills several sessions', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'job-3d' });

      const violationId = randomUUID();
      const ruleId = randomUUID();
      const triggeringSessionId = randomUUID();
      const targetA = randomUUID();
      const targetB = randomUUID();

      await enqueueKill(
        makeData({ targetSessionId: targetA, triggeringSessionId, ruleId, violationId }),
        0
      );
      await enqueueKill(
        makeData({ targetSessionId: targetB, triggeringSessionId, ruleId, violationId }),
        0
      );

      expect(mockQueueAdd).toHaveBeenCalledTimes(2);
      const jobIdA = mockQueueAdd.mock.calls[0]![2].jobId;
      const jobIdB = mockQueueAdd.mock.calls[1]![2].jobId;
      expect(jobIdA).not.toBe(jobIdB);
      expect(jobIdA).toBe(`kill:${violationId}:${targetA}`);
      expect(jobIdB).toBe(`kill:${violationId}:${targetB}`);
    });

    it('carries the trigger, target, and identity snapshot through to the job payload', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'job-3e' });

      const data = makeData({
        triggeringSessionId: randomUUID(),
        identityServerUserIds: ['su-1', 'su-2'],
      });

      await enqueueKill(data, 0);

      const [, jobData] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual(data);
    });

    it('returns the existing job id when BullMQ dedupes a repeat jobId server-side', async () => {
      // BullMQ 5.x add() does not throw on a duplicate jobId; it returns the
      // existing job. A deduped enqueue still means a job is queued, so
      // enqueueKill returns its id rather than undefined.
      mockQueueAdd.mockResolvedValue({ id: 'existing-job' });

      const result = await enqueueKill(makeData(), 5);

      expect(result).toBe('existing-job');
    });

    it('rethrows unexpected queue errors', async () => {
      mockQueueAdd.mockRejectedValue(new Error('redis connection lost'));

      await expect(enqueueKill(makeData(), 5)).rejects.toThrow('redis connection lost');
    });
  });

  describe('processKillJob', () => {
    it('stores a killed outcome as a successful, non-skipped action result', async () => {
      mockReverifyKillCondition.mockResolvedValue({ outcome: 'killed' });

      const data = makeData({ message: 'bye' });

      await processKillJob(makeJob(data));

      expect(mockReverifyKillCondition).toHaveBeenCalledWith({
        triggeringSessionId: data.triggeringSessionId,
        targetSessionId: data.targetSessionId,
        serverId: data.serverId,
        ruleId: data.ruleId,
        violationId: data.violationId,
        message: 'bye',
        isRetry: false,
      });
      expect(mockStoreActionResults).toHaveBeenCalledWith(data.violationId, data.ruleId, [
        expect.objectContaining({ success: true, skipped: false }),
      ]);
    });

    it('marks isRetry true when the job has a prior failed attempt', async () => {
      mockReverifyKillCondition.mockResolvedValue({ outcome: 'killed' });

      await processKillJob(makeJob(makeData({ violationId: null }), 1));

      expect(mockReverifyKillCondition).toHaveBeenCalledWith(
        expect.objectContaining({ isRetry: true })
      );
    });

    it('stores each skipped outcome with the exact skipReason literal', async () => {
      for (const outcome of [
        'skipped_already_stopped',
        'skipped_rule_gone',
        'skipped_condition_cleared',
      ] as const) {
        mockStoreActionResults.mockClear();
        mockReverifyKillCondition.mockResolvedValue({ outcome });

        const data = makeData();

        await processKillJob(makeJob(data));

        expect(mockStoreActionResults).toHaveBeenCalledWith(data.violationId, data.ruleId, [
          expect.objectContaining({ success: true, skipped: true, skipReason: outcome }),
        ]);
      }
    });

    it('stores a failed outcome as unsuccessful on the final attempt', async () => {
      mockReverifyKillCondition.mockResolvedValue({ outcome: 'failed', error: 'boom' });

      const data = makeData();

      await processKillJob(makeJob(data, 2, 3));

      expect(mockStoreActionResults).toHaveBeenCalledWith(data.violationId, data.ruleId, [
        expect.objectContaining({ success: false }),
      ]);
    });

    it('R4: throws without storing a result when a non-final attempt fails, so BullMQ retries', async () => {
      mockReverifyKillCondition.mockResolvedValue({ outcome: 'failed', error: 'boom' });

      await expect(processKillJob(makeJob(makeData(), 0, 3))).rejects.toThrow();

      expect(mockStoreActionResults).not.toHaveBeenCalled();
    });

    it('R4: stores exactly one failed row and does not throw on the final attempt', async () => {
      mockReverifyKillCondition.mockResolvedValue({ outcome: 'failed', error: 'boom' });

      const data = makeData();

      await expect(processKillJob(makeJob(data, 2, 3))).resolves.toBeUndefined();

      expect(mockStoreActionResults).toHaveBeenCalledTimes(1);
      expect(mockStoreActionResults).toHaveBeenCalledWith(data.violationId, data.ruleId, [
        expect.objectContaining({ success: false }),
      ]);
    });

    it('stores a refused kill once on its first attempt, without a retry', async () => {
      mockReverifyKillCondition.mockResolvedValue({
        outcome: 'refused',
        error: 'this tofa API key cannot stop streams',
      });
      const data = makeData();

      await expect(processKillJob(makeJob(data, 0, 3))).resolves.toBeUndefined();

      expect(mockReverifyKillCondition).toHaveBeenCalledTimes(1);
      expect(mockStoreActionResults).toHaveBeenCalledTimes(1);
      expect(mockStoreActionResults).toHaveBeenCalledWith(data.violationId, data.ruleId, [
        {
          action: { type: 'kill_stream' },
          success: false,
          message: 'this tofa API key cannot stop streams',
        },
      ]);
    });

    it('passes a null violationId through to storeActionResults unchanged', async () => {
      mockReverifyKillCondition.mockResolvedValue({ outcome: 'killed' });

      const data = makeData({ violationId: null });

      await processKillJob(makeJob(data));

      expect(mockStoreActionResults).toHaveBeenCalledWith(null, data.ruleId, expect.any(Array));
    });

    describe('cooldown arming', () => {
      function depsWith(setCooldown: ActionExecutorDeps['setCooldown']) {
        setActionExecutorDeps({
          enqueueAutomationNotification: vi.fn().mockResolvedValue(0),
          adjustUserTrust: vi.fn(),
          setUserTrust: vi.fn(),
          resetUserTrust: vi.fn(),
          terminateSession: vi.fn().mockResolvedValue(undefined),
          sendClientMessage: vi.fn(),
          checkCooldown: vi.fn().mockResolvedValue(false),
          setCooldown,
        });
      }

      it('arms the rule cooldown when the kill executed', async () => {
        mockReverifyKillCondition.mockResolvedValue({ outcome: 'killed' });
        const setCooldown = vi.fn().mockResolvedValue(undefined);
        depsWith(setCooldown);

        const ruleId = randomUUID();
        const triggeringServerUserId = randomUUID();

        await processKillJob(
          makeJob(makeData({ ruleId, cooldownMinutes: 10, triggeringServerUserId }))
        );

        expect(setCooldown).toHaveBeenCalledWith(
          ruleId,
          `${ruleId}:${triggeringServerUserId}:kill_stream`,
          10
        );
      });

      it('does not arm the cooldown when the kill was aborted (skipped outcome)', async () => {
        mockReverifyKillCondition.mockResolvedValue({ outcome: 'skipped_condition_cleared' });
        const setCooldown = vi.fn().mockResolvedValue(undefined);
        depsWith(setCooldown);

        await processKillJob(
          makeJob(makeData({ cooldownMinutes: 10, triggeringServerUserId: randomUUID() }))
        );

        expect(setCooldown).not.toHaveBeenCalled();
      });

      it('does not arm the cooldown when the kill failed on the final attempt', async () => {
        mockReverifyKillCondition.mockResolvedValue({ outcome: 'failed', error: 'boom' });
        const setCooldown = vi.fn().mockResolvedValue(undefined);
        depsWith(setCooldown);

        await processKillJob(
          makeJob(makeData({ cooldownMinutes: 10, triggeringServerUserId: randomUUID() }), 2, 3)
        );

        expect(setCooldown).not.toHaveBeenCalled();
      });

      it('does not arm the cooldown when the action had no cooldown_minutes configured', async () => {
        mockReverifyKillCondition.mockResolvedValue({ outcome: 'killed' });
        const setCooldown = vi.fn().mockResolvedValue(undefined);
        depsWith(setCooldown);

        await processKillJob(makeJob(makeData()));

        expect(setCooldown).not.toHaveBeenCalled();
      });
    });
  });
});
