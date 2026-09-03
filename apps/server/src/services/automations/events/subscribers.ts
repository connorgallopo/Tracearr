import type { EngineAutomation, RunFinishedEvent, TriggerNode } from '@tracearr/shared';
import { db } from '../../../db/client.js';
import { automationsLogger } from '../../../utils/logger.js';
import { evaluateRulesAsync } from '../engine.js';
import { executeActions, type ActionResult } from '../executors/index.js';
import {
  appendRunSteps,
  automationCoolingDown,
  noteRunFailure,
  publishRunFinished,
  recordNearMiss,
  recordRun,
  runFinishedOf,
  subjectKeyOf,
  type AutomationRunRow,
  type RunScope,
} from '../runRecorder.js';
import { MEDIA_QUALITY_FIELDS } from '../types.js';
import { storeActionResults } from '../v2Integration.js';
import { subscribe } from './dispatcher.js';
import {
  firingNodeFor,
  paramsPass,
  triggerCandidates,
  type ContextEvaluatingEvent,
  type SessionEvaluatingEvent,
} from './evaluate.js';
import type { ViolationInsertResult } from '../../../jobs/poller/violations.js';
import type { EvaluationContext, EvaluationResult, MediaQuality } from '../types.js';
import type { DbTx, DispatchOptions, EvaluationInputs, SubscriberResult } from './types.js';

/** A rule and the trigger node this event fires it through. */
interface Firing {
  rule: EngineAutomation;
  node: TriggerNode;
}

interface PendingAct {
  context: EvaluationContext;
  result: EvaluationResult;
  rule: EngineAutomation;
  run: AutomationRunRow;
}

function actionStep(result: ActionResult): Record<string, unknown> {
  return {
    action: result.action.type,
    success: result.success,
    ...(result.branch
      ? { branch: result.branch, matched: result.matched ?? false, evidence: result.evidence ?? [] }
      : {}),
    ...(result.path ? { path: result.path } : {}),
    ...(result.skipped ? { skipped: true, skipReason: result.skipReason ?? null } : {}),
    ...(result.success ? {} : { message: result.message ?? null }),
  };
}

/**
 * Acts run once the run rows are committed, so a throw can no longer be a retry
 * signal - it would only mute the siblings that still have work to do.
 */
async function runActs(pending: PendingAct[]): Promise<ActionResult[]> {
  const all: ActionResult[] = [];
  for (const { context, result, rule, run } of pending) {
    try {
      const results = await executeActions(context, result.actions);
      await storeActionResults(run.id, rule.id, results);
      await appendRunSteps(run.id, results.map(actionStep));
      all.push(...results);
    } catch (error) {
      await noteRunFailure({
        run,
        serverId: context.server?.id ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
      automationsLogger.error('Automation actions failed', {
        automation: rule.id,
        run: run.id,
        error,
      });
    }
  }
  return all;
}

/** The quality an upgrade left behind, so a library flapping between two of them re-announces neither. */
function afterSignature(quality: MediaQuality): string {
  return MEDIA_QUALITY_FIELDS.map((field) => quality[field] ?? '').join('|');
}

/** What makes this firing a distinct edge for the notification gate; the node is the one that fired. */
export function edgeKeyOf(event: ContextEvaluatingEvent, node: TriggerNode | null): string | null {
  switch (event.type) {
    case 'session.started':
    case 'session.first_seen':
    case 'media.added':
    case 'account.new_device':
      return null;
    case 'media.upgraded':
      return afterSignature(event.media.quality);
    case 'session.transcode_changed':
      return `${event.next.videoDecision ?? 'none'}/${event.next.audioDecision ?? 'none'}`;
    case 'session.paused':
      return event.pauseData.lastPausedAt?.toISOString() ?? null;
    case 'session.held_for':
      // Never the elapsed value: a rehydrated wake replays the same crossing with a larger number.
      return node?.type === 'session.held_for'
        ? `${node.params.measure}:${String(node.params.minutes)}`
        : null;
    case 'account.inactive_for':
      return node?.type === 'account.inactive_for' ? String(node.params.days) : null;
    // Each transition is news, so a repeated -5 walks a fresh edge and fires again.
    case 'account.trust_changed':
      return `${String(event.previous)}->${String(event.next)}`;
    case 'session.stopped':
    case 'server.down':
    case 'server.up':
      return event.at.toISOString();
    case 'plugin.update_available':
    case 'server.update_available':
      return event.latestVersion;
    case 'tracearr.update_available':
      return event.latest;
  }
}

/**
 * evaluate → record → act. Every evaluation records a run; only a matched one
 * that cleared the gate acts. The records share one transaction and the acts
 * follow it, so nothing acts on a run the database has not kept.
 */
export async function runRulePipeline(
  event: ContextEvaluatingEvent,
  inputs: EvaluationInputs,
  opts: DispatchOptions,
  scope: RunScope,
  marker?: Record<string, true>
): Promise<SubscriberResult> {
  const subjectKey = subjectKeyOf(scope);
  const { rules, baseContext } = triggerCandidates(event, inputs, subjectKey);
  const violations: ViolationInsertResult[] = [];
  const pending: PendingAct[] = [];
  const effects: Array<() => Promise<void>> = [];
  const finished: RunFinishedEvent[] = [];

  // The node's own params are part of the trigger: a threshold not yet reached never evaluates.
  const reached: Firing[] = [];
  for (const rule of rules) {
    const node = firingNodeFor(rule, event);
    if (node && paramsPass(node, event)) {
      reached.push({ rule, node });
      continue;
    }
    // A wake fires for one node, so a miss there is worth showing; the inactivity sweep
    // hands every automation the union of the candidates and would fill the ring with noise.
    if (event.type === 'session.held_for') {
      void recordNearMiss(rule.id, {
        reason: 'trigger_filter_failed',
        subjectKey,
        trigger: event.type,
      });
    }
  }
  if (reached.length === 0) return { violations };

  const cooling = await Promise.all(
    reached.map(({ rule }) => automationCoolingDown(rule, subjectKey))
  );
  const evaluable = reached.filter(({ rule }, index) => {
    if (!cooling[index]) return true;
    void recordNearMiss(rule.id, { reason: 'cooldown_active', subjectKey, trigger: event.type });
    return false;
  });
  if (evaluable.length === 0) return { violations };

  const results = await evaluateRulesAsync(
    baseContext,
    evaluable.map(({ rule }) => rule),
    { includeUnmatched: true }
  );

  const record = async (executor: DbTx): Promise<void> => {
    for (const result of results) {
      const firing = evaluable.find(({ rule }) => rule.id === result.ruleId);
      if (!firing) continue;
      const { rule, node } = firing;

      const run = await recordRun({
        automation: rule,
        result,
        serverUserId: baseContext.serverUser?.id ?? null,
        serverId: baseContext.server?.id ?? null,
        scope,
        session: baseContext.session,
        trigger: {
          type: event.type,
          nodeId: node.id,
          edgeKey: edgeKeyOf(event, node),
          at: event.at,
        },
        marker,
        tx: executor,
        defer: (effect) => effects.push(effect),
      });
      if (!run) continue;
      // Completed policy runs are violations; the violation broadcaster announces
      // those, with the user and server details it already loads.
      if (!(result.matched && rule.kind === 'policy')) finished.push(runFinishedOf(run));
      if (!result.matched) continue;

      if (rule.kind === 'policy') {
        violations.push({ violation: run, rule: { id: rule.id, name: rule.name, type: null } });
      }
      if (result.actions.length === 0) continue;

      pending.push({
        context: { ...baseContext, rule, triggerNode: node, violationId: run.id },
        result,
        rule,
        run,
      });
    }
  };

  // One transaction per dispatch. Each run still takes its own advisory lock and
  // gate inside it, in order; the batch just stops paying BEGIN/COMMIT per row.
  if (opts.tx) await record(opts.tx);
  else await db.transaction(record);

  /** Best-effort, like the publish inside them: a redis blip cannot cost the acts. */
  const drainEffects = async (): Promise<void> => {
    for (const effect of effects) {
      try {
        await effect();
      } catch (error) {
        automationsLogger.warn('Post-commit run effect failed', {
          trigger: event.type,
          subject: subjectKey,
          error,
        });
      }
    }
  };

  // run:finished goes out before the actions run: the row is final, and its steps
  // land on the refetch the event itself triggers.
  const postCommit = async (): Promise<void> => {
    await drainEffects();
    await publishRunFinished(finished);
  };

  if (opts.tx) {
    // The caller can still roll its transaction back, so its post-commit phase owns these.
    if (finished.length > 0 || effects.length > 0 || pending.length > 0) {
      return {
        violations,
        deferredActions: async () => {
          await postCommit();
          return runActs(pending);
        },
      };
    }
    return { violations };
  }

  await postCommit();
  if (opts.deferActions && pending.length > 0) {
    return { violations, deferredActions: () => runActs(pending) };
  }
  await runActs(pending);
  return { violations };
}

function sessionRules(marker?: Record<string, true>, fresh?: boolean) {
  return async (
    event: SessionEvaluatingEvent,
    inputs: EvaluationInputs | undefined,
    opts: DispatchOptions
  ) => {
    if (!inputs) return;
    return runRulePipeline(
      event,
      inputs,
      opts,
      { kind: 'session', sessionId: event.session.id, ...(fresh ? { fresh } : {}) },
      marker
    );
  };
}

const ACCOUNT_TRIGGERS = ['account.inactive_for', 'account.trust_changed'] as const;

const MEDIA_TRIGGERS = ['media.added', 'media.upgraded'] as const;

const SERVER_TRIGGERS = [
  'server.down',
  'server.up',
  'plugin.update_available',
  'server.update_available',
] as const;

let registered = false;

export function registerRuleSubscribers(): void {
  if (registered) return;
  registered = true;

  subscribe('session.started', 'session-rules', sessionRules(undefined, true));
  // Fresh too: the pending id was minted moments ago, so nothing can contend it.
  subscribe('session.first_seen', 'session-rules', sessionRules(undefined, true));
  subscribe('session.stopped', 'session-rules', sessionRules());
  subscribe('session.transcode_changed', 'session-rules', sessionRules({ transcodeReEval: true }));
  subscribe('session.paused', 'session-rules', sessionRules({ pauseReEval: true }));
  subscribe('session.held_for', 'session-rules', sessionRules({ heldFor: true }));
  // Not fresh: the probe runs inside the insert transaction and the dispatch follows the commit.
  subscribe('account.new_device', 'session-rules', sessionRules());
  for (const trigger of ACCOUNT_TRIGGERS) {
    subscribe(trigger, 'account-rules', async (event, inputs, opts) => {
      if (!inputs) return;
      return runRulePipeline(event, inputs, opts, {
        kind: 'account',
        serverUserId: event.serverUser.id,
      });
    });
  }
  for (const trigger of SERVER_TRIGGERS) {
    subscribe(trigger, 'server-rules', async (event, inputs, opts) => {
      if (!inputs) return;
      return runRulePipeline(event, inputs, opts, { kind: 'server', serverId: event.server.id });
    });
  }
  for (const trigger of MEDIA_TRIGGERS) {
    subscribe(trigger, 'media-rules', async (event, inputs, opts) => {
      if (!inputs) return;
      return runRulePipeline(event, inputs, opts, {
        kind: 'media',
        libraryItemId: event.media.libraryItemId,
      });
    });
  }
  subscribe('tracearr.update_available', 'install-rules', async (event, inputs, opts) => {
    if (!inputs) return;
    return runRulePipeline(event, inputs, opts, { kind: 'install' });
  });
}

export function resetRuleSubscribersForTests(): void {
  registered = false;
}
