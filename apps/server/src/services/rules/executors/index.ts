import { TIME_MS } from '@tracearr/shared';
import type {
  Action,
  ActionType,
  LogOnlyAction,
  SendAction,
  AdjustTrustAction,
  SetTrustAction,
  KillStreamAction,
  MessageClientAction,
  ServerUser,
} from '@tracearr/shared';
import { rulesLogger } from '../../../utils/logger.js';
import type { NotificationEvent } from '../../notifications/events.js';
import type { ActionExecutor, EvaluationContext } from '../types.js';
import { resolveTargetSessions } from './targeting.js';

/**
 * Result of executing an action.
 */
export interface ActionResult {
  action: Action;
  success: boolean;
  message?: string;
  skipped?: boolean;
  skipReason?: string;
  /** kill_stream only: target session ids actually handed to the kill queue.
   *  Enqueue, not execution - reverify can still abort before terminating. */
  enqueuedSessionIds?: string[];
}

/**
 * Dependencies for action executors.
 * These are injected to allow for testing and avoid circular dependencies.
 */
export interface ActionExecutorDeps {
  logAudit: (params: {
    /** null for violations with no session, e.g. account inactivity */
    sessionId: string | null;
    serverUserId: string;
    serverId: string;
    ruleId: string;
    ruleName: string;
    message?: string;
    details: Record<string, unknown>;
  }) => Promise<void>;
  /** Resolves the destination ids and returns how many jobs were enqueued. */
  enqueueRuleNotification: (params: {
    to: string[];
    title: string;
    message: string;
    event: NotificationEvent;
  }) => Promise<number>;
  adjustUserTrust: (userId: string, delta: number) => Promise<void>;
  setUserTrust: (userId: string, value: number) => Promise<void>;
  resetUserTrust: (userId: string) => Promise<void>;
  terminateSession: (
    sessionId: string,
    serverId: string,
    ruleId: string,
    violationId: string | null,
    delay?: number,
    message?: string,
    identityServerUserIds?: string[],
    /** Rule's cooldown_minutes at match time, keyed to the triggering
     *  account. Carried through so the kill worker can arm the cooldown
     *  only once the kill actually executes, not at enqueue time. */
    cooldown?: { minutes: number; triggeringServerUserId: string },
    /** The session that matched the rule. Carried alongside the target so the
     *  kill worker re-verifies the condition against the trigger's context, not
     *  the target's (which may be a sibling session/server for multi-target and
     *  enforceAcrossServers kills). */
    triggeringSessionId?: string
    // Returns the kill queue job id when a job was created or already exists,
    // or undefined when the enqueue was dropped (queue not initialized).
  ) => Promise<string | undefined>;
  sendClientMessage: (
    sessionId: string,
    message: string,
    header?: string,
    timeoutMs?: number
  ) => Promise<void>;
  checkCooldown: (ruleId: string, targetId: string, cooldownMinutes: number) => Promise<boolean>;
  setCooldown: (ruleId: string, targetId: string, cooldownMinutes: number) => Promise<void>;
  queueForConfirmation: (params: {
    ruleId: string;
    ruleName: string;
    sessionId: string | null;
    serverUserId: string;
    serverId: string;
    action: Action;
  }) => Promise<void>;
}

// Default no-op dependencies for testing
const noopDeps: ActionExecutorDeps = {
  logAudit: async () => {
    /* no-op */
  },
  enqueueRuleNotification: async () => 0,
  adjustUserTrust: async () => {
    /* no-op */
  },
  setUserTrust: async () => {
    /* no-op */
  },
  resetUserTrust: async () => {
    /* no-op */
  },
  terminateSession: async () => undefined,
  sendClientMessage: async () => {
    /* no-op */
  },
  checkCooldown: async () => false,
  setCooldown: async () => {
    /* no-op */
  },
  queueForConfirmation: async () => {
    /* no-op */
  },
};

let currentDeps: ActionExecutorDeps = noopDeps;

/**
 * Set the dependencies for action executors.
 * Should be called during app initialization.
 */
export function setActionExecutorDeps(deps: ActionExecutorDeps): void {
  currentDeps = deps;
}

/**
 * Get current dependencies (for testing).
 */
export function getActionExecutorDeps(): ActionExecutorDeps {
  return currentDeps;
}

/**
 * Reset dependencies to no-op (for testing).
 */
export function resetActionExecutorDeps(): void {
  currentDeps = noopDeps;
}

// ============================================================================
// Type Guards for Action Properties
// ============================================================================

/**
 * Check if an action has cooldown_minutes property.
 */
function hasCooldown(action: Action): action is Action & { cooldown_minutes?: number } {
  return 'cooldown_minutes' in action;
}

/**
 * Check if an action has require_confirmation property.
 */
function hasConfirmation(action: Action): action is Action & { require_confirmation?: boolean } {
  return 'require_confirmation' in action;
}

/**
 * Get cooldown minutes from action if it exists.
 */
function getCooldownMinutes(action: Action): number | undefined {
  if (hasCooldown(action)) {
    return action.cooldown_minutes;
  }
  return undefined;
}

/**
 * Check if action requires confirmation.
 */
function requiresConfirmation(action: Action): boolean {
  if (hasConfirmation(action)) {
    return action.require_confirmation === true;
  }
  return false;
}

// ============================================================================
// Action Executors
// ============================================================================

/**
 * Log to audit log without creating a violation.
 */
const executeLogOnly: ActionExecutor = async (
  context: EvaluationContext,
  action: Action
): Promise<void> => {
  const { session, serverUser, server, rule } = context;
  const typedAction = action as LogOnlyAction;

  await currentDeps.logAudit({
    sessionId: session?.id ?? null,
    serverUserId: serverUser.id,
    serverId: server.id,
    ruleId: rule.id,
    ruleName: rule.name,
    message: typedAction.message,
    details: session
      ? {
          sessionKey: session.sessionKey,
          mediaTitle: session.mediaTitle,
          ipAddress: session.ipAddress,
        }
      : { lastActivityAt: serverUser.lastActivityAt },
  });
};

function accountInactivityMessage(serverUser: ServerUser): string {
  if (!serverUser.lastActivityAt) return `Account "${serverUser.username}" has never been active`;
  const days = Math.floor(
    (Date.now() - new Date(serverUser.lastActivityAt).getTime()) / TIME_MS.DAY
  );
  return `Account "${serverUser.username}" has been inactive for ${days} days`;
}

/**
 * Send a violation event to the named destinations.
 */
const executeSend: ActionExecutor = async (
  context: EvaluationContext,
  action: Action
): Promise<void> => {
  const { session, serverUser, server, rule } = context;
  const typedAction = action as SendAction;
  const to = typedAction.to;

  if (to.length === 0) {
    return;
  }

  const title = `Rule Triggered: ${rule.name}`;
  const message = session
    ? `User "${serverUser.username}" triggered rule "${rule.name}" while playing "${session.mediaTitle}"`
    : accountInactivityMessage(serverUser);

  // No violation row for this match, so synthesize an id; the json webhook body carries payload.id.
  const event: NotificationEvent = {
    type: 'violation',
    payload: {
      id: context.violationId ?? `rule-send-${rule.id}-${Date.now()}`,
      ruleId: rule.id,
      serverUserId: serverUser.id,
      sessionId: session?.id ?? null,
      severity: rule.severity,
      createdAt: new Date(),
      acknowledgedAt: null,
      data: {
        ruleId: rule.id,
        serverUserId: serverUser.id,
        username: serverUser.username,
        displayName: serverUser.identityName ?? serverUser.username,
        // Image data for rich push notifications
        serverId: server.id,
        userThumbUrl: serverUser.thumbUrl,
        ...(session
          ? { sessionId: session.id, mediaTitle: session.mediaTitle, thumbPath: session.thumbPath }
          : {}),
      },
      rule: { id: rule.id, name: rule.name, type: null },
      session: undefined,
      user: {
        id: serverUser.id,
        username: serverUser.username,
        identityName: serverUser.identityName ?? null,
        thumbUrl: serverUser.thumbUrl,
        serverId: server.id,
      },
    },
  };

  const enqueued = await currentDeps.enqueueRuleNotification({ to, title, message, event });
  if (enqueued === 0) {
    rulesLogger.info('send resolved no enabled destination', { ruleId: rule.id, to });
  }
};

/**
 * Adjust user trust score by adding/subtracting points.
 */
const executeAdjustTrust: ActionExecutor = async (
  context: EvaluationContext,
  action: Action
): Promise<void> => {
  const { serverUser } = context;
  const typedAction = action as AdjustTrustAction;
  const amount = typedAction.amount;

  if (amount !== 0) {
    await currentDeps.adjustUserTrust(serverUser.id, amount);
  }
};

/**
 * Set user trust score to a specific value.
 */
const executeSetTrust: ActionExecutor = async (
  context: EvaluationContext,
  action: Action
): Promise<void> => {
  const { serverUser } = context;
  const typedAction = action as SetTrustAction;

  await currentDeps.setUserTrust(serverUser.id, typedAction.value);
};

/**
 * Reset user trust score to baseline (100).
 */
const executeResetTrust: ActionExecutor = async (context: EvaluationContext): Promise<void> => {
  const { serverUser } = context;
  await currentDeps.resetUserTrust(serverUser.id);
};

/**
 * Terminate the current session.
 */
const executeKillStream: ActionExecutor = async (
  context: EvaluationContext,
  action: Action
): Promise<{ enqueuedSessionIds: string[]; queueFailure: boolean }> => {
  const { session, serverUser, activeSessions, rule, identityServerUserIds } = context;
  if (!session) return { enqueuedSessionIds: [], queueFailure: false };
  const typedAction = action as KillStreamAction;
  const delaySeconds = typedAction.delay_seconds ?? 0;
  const message = typedAction.message;
  const target = typedAction.target ?? 'triggering';
  const cooldownMinutes = typedAction.cooldown_minutes;
  // Cooldown arms once the kill worker reports the kill actually executed
  // (see killQueue.ts), not here at enqueue time - an aborted kill must not
  // start the cooldown. Keyed to the triggering account regardless of which
  // target session ends up killed.
  const cooldown =
    cooldownMinutes && cooldownMinutes > 0
      ? { minutes: cooldownMinutes, triggeringServerUserId: serverUser.id }
      : undefined;

  // Include triggering session in activeSessions if not already present.
  // The triggering session may not be in the cache yet when rules are evaluated,
  // so we ensure it's included for accurate targeting resolution.
  const sessionsForTargeting = activeSessions.some((s) => s.id === session.id)
    ? activeSessions
    : [...activeSessions, session];

  // Detection vs action split: the rule already matched using identity-wide
  // aggregation regardless of this flag (see belongsToIdentity in
  // evaluators/index.ts). enforceAcrossServers only gates ACTION REACH here -
  // whether termination follows the identity onto sibling-server sessions or
  // stays on the triggering account.
  const sessionsToKill = resolveTargetSessions({
    target,
    triggeringSession: session,
    serverUserId: serverUser.id,
    activeSessions: sessionsForTargeting,
    identityServerUserIds: rule.enforceAcrossServers ? identityServerUserIds : undefined,
  });

  const enqueuedSessionIds: string[] = [];
  let anyDropped = false;
  for (const targetSession of sessionsToKill) {
    // Use the target session's own serverId, not the triggering session's -
    // with enforceAcrossServers, these can be different servers. Each target
    // session gets its own terminateSession call (and downstream its own kill
    // queue job, keyed by that session's id), so a multi-target match doesn't
    // collapse into a single job that only kills one session. The triggering
    // session id rides along so the worker re-verifies against the matching
    // session's context, not the target's.
    const jobId = await currentDeps.terminateSession(
      targetSession.id,
      targetSession.serverId,
      rule.id,
      context.violationId ?? null,
      delaySeconds,
      message,
      rule.enforceAcrossServers ? identityServerUserIds : undefined,
      cooldown,
      session.id
    );
    // Only record a target as enqueued when a job genuinely landed - a dropped
    // enqueue (queue down) must not read as queued to wasTriggeringSessionTargetedForKill.
    if (jobId) {
      enqueuedSessionIds.push(targetSession.id);
    } else {
      anyDropped = true;
    }
  }

  const queueFailure = sessionsToKill.length > 0 && enqueuedSessionIds.length === 0 && anyDropped;
  return { enqueuedSessionIds, queueFailure };
};

/**
 * Send a message to the client (if supported by the media server).
 */
const executeMessageClient: ActionExecutor = async (
  context: EvaluationContext,
  action: Action
): Promise<void> => {
  const { session, serverUser, activeSessions, rule, identityServerUserIds } = context;
  if (!session) return;
  const typedAction = action as MessageClientAction;
  const message = typedAction.message;
  const header = typedAction.header;
  const timeoutMs = typedAction.timeout_ms;
  const target = typedAction.target ?? 'triggering';

  if (!message) {
    return;
  }

  // Include triggering session in activeSessions if not already present.
  // The triggering session may not be in the cache yet when rules are evaluated,
  // so we ensure it's included for accurate targeting resolution.
  const sessionsForTargeting = activeSessions.some((s) => s.id === session.id)
    ? activeSessions
    : [...activeSessions, session];

  // Same detection-vs-action split as executeKillStream above: this flag
  // gates action reach only, never whether the rule matched.
  const sessionsToMessage = resolveTargetSessions({
    target,
    triggeringSession: session,
    serverUserId: serverUser.id,
    activeSessions: sessionsForTargeting,
    identityServerUserIds: rule.enforceAcrossServers ? identityServerUserIds : undefined,
  });

  for (const targetSession of sessionsToMessage) {
    await currentDeps.sendClientMessage(targetSession.id, message, header, timeoutMs);
  }
};

// ============================================================================
// Executor Registry
// ============================================================================

export const executorRegistry: Record<ActionType, ActionExecutor> = {
  log_only: executeLogOnly,
  send: executeSend,
  adjust_trust: executeAdjustTrust,
  set_trust: executeSetTrust,
  reset_trust: executeResetTrust,
  kill_stream: executeKillStream,
  message_client: executeMessageClient,
};

// ============================================================================
// Action Execution
// ============================================================================

/**
 * Cooldown keys are scoped per action type so one action's cooldown never
 * suppresses a different action on the same rule (a send cooldown must not
 * swallow the kill_stream). killQueue arms the kill_stream key through this
 * same builder once a kill actually executes.
 */
export function cooldownTargetId(
  ruleId: string,
  serverUserId: string,
  actionType: Action['type']
): string {
  return `${ruleId}:${serverUserId}:${actionType}`;
}

/**
 * Execute a single action, handling cooldowns and confirmation requirements.
 */
export async function executeAction(
  context: EvaluationContext,
  action: Action
): Promise<ActionResult> {
  const { rule, serverUser } = context;
  const executor = executorRegistry[action.type];

  if (!executor) {
    return {
      action,
      success: false,
      message: `Unknown action type: ${action.type}`,
    };
  }

  if (!context.session && (action.type === 'kill_stream' || action.type === 'message_client')) {
    return {
      action,
      success: true,
      skipped: true,
      skipReason: 'No active session for an inactivity violation',
    };
  }

  // Check cooldown
  const cooldownMinutes = getCooldownMinutes(action);
  if (cooldownMinutes && cooldownMinutes > 0) {
    const targetId = cooldownTargetId(rule.id, serverUser.id, action.type);
    const onCooldown = await currentDeps.checkCooldown(rule.id, targetId, cooldownMinutes);

    if (onCooldown) {
      return {
        action,
        success: true,
        skipped: true,
        skipReason: `On cooldown (${cooldownMinutes} minutes)`,
      };
    }
  }

  // Check if confirmation required
  if (requiresConfirmation(action)) {
    await currentDeps.queueForConfirmation({
      ruleId: rule.id,
      ruleName: rule.name,
      sessionId: context.session?.id ?? null,
      serverUserId: serverUser.id,
      serverId: context.server.id,
      action,
    });

    return {
      action,
      success: true,
      skipped: true,
      skipReason: 'Queued for manual confirmation',
    };
  }

  // Execute the action
  try {
    const executorResult = await executor(context, action);

    // Set cooldown after successful execution. kill_stream is excluded: its
    // cooldown arms later, once the queue reports the kill actually executed
    // (see killQueue.ts) - an aborted kill must not start the cooldown.
    if (cooldownMinutes && cooldownMinutes > 0 && action.type !== 'kill_stream') {
      const targetId = cooldownTargetId(rule.id, serverUser.id, action.type);
      await currentDeps.setCooldown(rule.id, targetId, cooldownMinutes);
    }

    // kill_stream only enqueues here; the kill worker's later insert
    // (killed/skipped_condition_cleared/failed) is the authoritative outcome,
    // so this interim row must read as skipped rather than a false success.
    // When the queue was down and nothing enqueued, the kill never happened
    // and no worker row will follow, so record it as failed here instead.
    if (action.type === 'kill_stream') {
      const killResult = executorResult as
        { enqueuedSessionIds?: string[]; queueFailure?: boolean } | undefined;
      if (killResult?.queueFailure) {
        return {
          action,
          success: false,
          message: 'Kill queue unavailable, termination not enqueued',
        };
      }
      return {
        action,
        success: true,
        skipped: true,
        skipReason: 'queued',
        enqueuedSessionIds: killResult?.enqueuedSessionIds ?? [],
      };
    }

    return {
      action,
      success: true,
      message: `Executed ${action.type}`,
    };
  } catch (error) {
    return {
      action,
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Execute all actions for a matched rule.
 */
export async function executeActions(
  context: EvaluationContext,
  actions: Action[]
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];

  for (const action of actions) {
    const result = await executeAction(context, action);
    results.push(result);
  }

  return results;
}
