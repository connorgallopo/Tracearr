import { TIME_MS } from '@tracearr/shared';
import type {
  ActiveSession,
  Action,
  GroupEvidence,
  IfAction,
  KillStreamAction,
  LeafAction,
  LeafActionType,
  MessageClientAction,
  SendAction,
  Server,
  ServerUser,
  TrustAction,
} from '@tracearr/shared';
import { automationsLogger } from '../../../utils/logger.js';
import { evaluateAllGroupsAsync } from '../engine.js';
import { pauseMinutes } from '../wakes/crossings.js';
import { resolveTargetSessions } from './targeting.js';
import type {
  NotificationEvent,
  NotificationSource,
  ServerEventPayload,
} from '../../notifications/events.js';
import type { ActionExecutor, EvaluationContext } from '../types.js';

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
  /** `if` only: which branch ran, whether its conditions matched, and what they read. */
  branch?: 'then' | 'else';
  matched?: boolean;
  evidence?: GroupEvidence[];
  /** A leaf inside a branch: `<ifNodeId>.<then|else>.<index>`. */
  path?: string;
}

/**
 * Dependencies for action executors.
 * These are injected to allow for testing and avoid circular dependencies.
 */
export interface ActionExecutorDeps {
  /** Resolves the destination ids and returns how many jobs were enqueued. */
  enqueueAutomationNotification: (params: {
    to: string[];
    event: NotificationEvent;
    source: NotificationSource;
  }) => Promise<number>;
  /** `reason` is what a trust notification says moved the score: the automation's own name. */
  adjustUserTrust: (userId: string, delta: number, reason: string) => Promise<void>;
  setUserTrust: (userId: string, value: number, reason: string) => Promise<void>;
  resetUserTrust: (userId: string, reason: string) => Promise<void>;
  terminateSession: (
    sessionId: string,
    serverId: string,
    ruleId: string,
    violationId: string | null,
    delay?: number,
    message?: string,
    identityServerUserIds?: string[],
    /** Rule's cooldown_minutes at match time, keyed like every other action
     *  cooldown. Carried through so the kill worker can arm the cooldown only
     *  once the kill actually executes, not at enqueue time. */
    cooldown?: { minutes: number; triggeringServerUserId: string },
    /** The session that matched the rule. Carried alongside the target so the
     *  kill worker re-verifies the condition against the trigger's context, not
     *  the target's (which may be a sibling session/server for multi-target and
     *  enforceAcrossServers kills). */
    triggeringSessionId?: string
    // Returns the kill queue job id when a job was created or already exists,
    // or undefined when the enqueue was dropped (queue not initialized).
  ) => Promise<string | undefined>;
  sendClientMessage: (sessionId: string, message: string) => Promise<void>;
  checkCooldown: (ruleId: string, targetId: string, cooldownMinutes: number) => Promise<boolean>;
  setCooldown: (ruleId: string, targetId: string, cooldownMinutes: number) => Promise<void>;
}

// Default no-op dependencies for testing
const noopDeps: ActionExecutorDeps = {
  enqueueAutomationNotification: async () => 0,
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
 * Get cooldown minutes from action if it exists.
 */
function getCooldownMinutes(action: Action): number | undefined {
  if (hasCooldown(action)) {
    return action.cooldown_minutes;
  }
  return undefined;
}

// ============================================================================
// Action Executors
// ============================================================================

/** Whole days since the account last did anything; null when it never has. */
function inactiveDays(serverUser: ServerUser): number | null {
  if (!serverUser.lastActivityAt) return null;
  return Math.floor((Date.now() - new Date(serverUser.lastActivityAt).getTime()) / TIME_MS.DAY);
}

/** An inactivity run has no other words for itself; the send's own body still wins. */
function accountInactivityMessage(serverUser: ServerUser): string {
  const days = inactiveDays(serverUser);
  if (days === null) return `Account "${serverUser.username}" has never been active`;
  return `Account "${serverUser.username}" has been inactive for ${days} days`;
}

/** The numbers a trigger measured, so `{{minutes}}` and friends render off a violation shape. */
function triggerNumbers(context: EvaluationContext): Record<string, number> {
  const { trigger, triggerNode, serverUser } = context;
  if (!trigger) return {};
  switch (trigger.type) {
    case 'session.held_for': {
      // heldMinutes is this pause alone; a node measuring the total renders what it read.
      const measure =
        triggerNode?.type === 'session.held_for' ? triggerNode.params.measure : 'current';
      const pausedAt = trigger.pauseData.lastPausedAt;
      const minutes =
        measure === 'total' && pausedAt
          ? pauseMinutes(measure, {
              lastPausedAt: pausedAt.getTime(),
              pausedDurationMs: trigger.pauseData.pausedDurationMs,
              now: trigger.at.getTime(),
            })
          : trigger.heldMinutes;
      return { minutes: Math.round(minutes) };
    }
    case 'session.stopped':
      return { durationMinutes: Math.round(trigger.durationMs / TIME_MS.MINUTE) };
    case 'account.inactive_for': {
      const days = serverUser ? inactiveDays(serverUser) : null;
      return days === null ? {} : { days };
    }
    default:
      return {};
  }
}

/** The ActiveSession the stream events carry, assembled from the context the trigger built. */
function activeSessionOf(context: EvaluationContext, durationMs?: number): ActiveSession | null {
  const { session, serverUser, server } = context;
  if (!session || !serverUser || !server) return null;
  return {
    ...session,
    ...(durationMs !== undefined && { durationMs }),
    user: {
      id: serverUser.id,
      username: serverUser.username,
      thumbUrl: serverUser.thumbUrl,
      identityName: serverUser.identityName ?? null,
    },
    server: { id: server.id, name: server.name, type: server.type },
    canTerminate: false,
  };
}

function serverPayload(server: Server): ServerEventPayload {
  return { serverName: server.name, serverId: server.id, serverType: server.type };
}

/**
 * The notification event the trigger speaks natively. Triggers with none - transcode
 * changes, pauses, held_for and inactivity - fall through to the violation shape.
 */
function nativeEventFor(context: EvaluationContext): NotificationEvent | null {
  const { trigger, server } = context;
  if (!trigger) return null;
  switch (trigger.type) {
    case 'session.started':
    // Same wire event as a confirmed start: integrators asked for the same
    // stream_started payload earlier, not a second shape to parse.
    case 'session.first_seen': {
      const payload = activeSessionOf(context);
      return payload ? { type: 'session_started', payload } : null;
    }
    case 'session.stopped': {
      const payload = activeSessionOf(context, trigger.durationMs);
      return payload ? { type: 'session_stopped', payload } : null;
    }
    case 'server.down':
      return server ? { type: 'server_down', payload: serverPayload(server) } : null;
    case 'server.up':
      return server ? { type: 'server_up', payload: serverPayload(server) } : null;
    case 'plugin.update_available':
      return {
        type: 'plugin_update_available',
        payload: {
          serverId: trigger.server.id,
          serverName: trigger.server.name,
          serverType: trigger.server.type,
          installedVersion: trigger.installedVersion,
          latestVersion: trigger.latestVersion,
          downloadUrl: trigger.downloadUrl,
        },
      };
    case 'server.update_available':
      return {
        type: 'server_update_available',
        payload: {
          serverId: trigger.server.id,
          serverName: trigger.server.name,
          serverType: trigger.server.type,
          installedVersion: trigger.installedVersion,
          latestVersion: trigger.latestVersion,
          releaseUrl: trigger.releaseUrl,
        },
      };
    case 'tracearr.update_available':
      return {
        type: 'tracearr_update_available',
        payload: {
          current: trigger.current,
          latest: trigger.latest,
          releaseUrl: trigger.releaseUrl,
        },
      };
    case 'newsletter.sent':
    case 'newsletter.failed': {
      const { type: _type, at: _at, ...payload } = trigger;
      return { type: 'newsletter_send', payload };
    }
    // Both carry an account, so the violation shape would succeed and send the wrong thing.
    case 'account.new_device': {
      const { session, serverUser } = context;
      if (!session || !serverUser || !server) return null;
      return {
        type: 'new_device',
        payload: {
          serverId: server.id,
          serverName: server.name,
          serverType: server.type,
          serverUserId: serverUser.id,
          sessionId: session.id,
          userName: serverUser.identityName ?? serverUser.username,
          username: serverUser.username,
          identityName: serverUser.identityName ?? null,
          mediaTitle: session.mediaTitle,
          mediaType: session.mediaType,
          deviceName: trigger.device.name,
          platform: trigger.device.platform,
          product: trigger.device.product,
          location: trigger.device.location,
        },
      };
    }
    case 'account.trust_changed': {
      const { serverUser } = context;
      if (!serverUser || !server) return null;
      return {
        type: 'trust_score_changed',
        payload: {
          serverId: server.id,
          serverName: server.name,
          serverType: server.type,
          serverUserId: serverUser.id,
          userName: serverUser.identityName ?? serverUser.username,
          username: serverUser.username,
          identityName: serverUser.identityName ?? null,
          previousScore: trigger.previous,
          newScore: trigger.next,
          reason: trigger.reason,
        },
      };
    }
    case 'media.added':
    case 'media.upgraded': {
      // A media context has no account, so the violation shape would skip the send entirely.
      const { media } = context;
      if (!media || !server) return null;
      const payload = {
        serverId: server.id,
        serverName: server.name,
        serverType: server.type,
        libraryItemId: media.libraryItemId,
        ratingKey: media.ratingKey,
        mediaId: media.mediaId,
        title: media.title,
        grandparentTitle: media.grandparentTitle,
        parentTitle: media.parentTitle,
        grandparentRatingKey: media.grandparentRatingKey,
        parentRatingKey: media.parentRatingKey,
        parentIndex: media.parentIndex,
        itemIndex: media.itemIndex,
        mediaType: media.type,
        year: media.year,
        imdbId: media.imdbId,
        tmdbId: media.tmdbId,
        tvdbId: media.tvdbId,
        thumbPath: media.thumbPath,
        libraryName: media.libraryName,
        to: media.quality,
        ...(media.addedEpisodeCount !== undefined && {
          addedEpisodeCount: media.addedEpisodeCount,
        }),
      };
      return trigger.type === 'media.added'
        ? { type: 'media_added', payload }
        : {
            type: 'media_upgraded',
            payload: { ...payload, from: trigger.from, changed: trigger.changed },
          };
    }
    default:
      return null;
  }
}

/** What a policy run - and any trigger with no native event - sends: the match itself. */
function violationEventFor(context: EvaluationContext): NotificationEvent | null {
  const { session, serverUser, server, rule } = context;
  if (!serverUser || !server) return null;

  // No violation row for this match, so synthesize an id; the json webhook body carries payload.id.
  return {
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
        serverName: server.name,
        userThumbUrl: serverUser.thumbUrl,
        ...(session
          ? {
              sessionId: session.id,
              mediaTitle: session.mediaTitle,
              mediaType: session.mediaType,
              thumbPath: session.thumbPath,
            }
          : {}),
        ...triggerNumbers(context),
      },
      rule: { id: rule.id, name: rule.name, type: null },
      server: { id: server.id, name: server.name, type: server.type },
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
}

/** Only inactivity carries copy the violation shape cannot express on its own. */
function defaultBodyFor(context: EvaluationContext): string | undefined {
  const { trigger, serverUser } = context;
  if (!serverUser || trigger?.type !== 'account.inactive_for') return undefined;
  return accountInactivityMessage(serverUser);
}

/**
 * Send the trigger's own notification event to the named destinations, with whatever
 * title and body the action overrode.
 */
const executeSend: ActionExecutor = async (
  context: EvaluationContext,
  action: Action
): Promise<{ skipReason: string } | void> => {
  const { rule } = context;
  const typedAction = action as SendAction;
  const to = typedAction.to;

  if (to.length === 0) return;

  const native = rule.kind === 'notification' ? nativeEventFor(context) : null;
  const event = native ?? violationEventFor(context);
  if (!event) return { skipReason: 'No account to notify about' };

  const body = typedAction.body ?? defaultBodyFor(context);
  const source: NotificationSource = {
    kind: 'automation',
    automationId: rule.id,
    automationName: rule.name,
    ...(typedAction.title !== undefined && { title: typedAction.title }),
    ...(body !== undefined && { body }),
  };

  const enqueued = await currentDeps.enqueueAutomationNotification({ to, event, source });
  if (enqueued === 0) {
    automationsLogger.info('send resolved no enabled destination', { ruleId: rule.id, to });
  }
};

/**
 * Change user trust, the mode picking which of the three trust deps runs.
 */
const executeTrust: ActionExecutor = async (
  context: EvaluationContext,
  action: Action
): Promise<{ skipReason: string } | void> => {
  const { serverUser, rule } = context;
  if (!serverUser) return { skipReason: 'No account to adjust' };
  const typedAction = action as TrustAction;

  switch (typedAction.mode) {
    case 'adjust': {
      // Stored rows are not revalidated on read, so a missing parameter falls through quietly.
      const amount = typedAction.amount ?? 0;
      if (amount !== 0) {
        await currentDeps.adjustUserTrust(serverUser.id, amount, rule.name);
      }
      break;
    }
    case 'set':
      if (typedAction.value !== undefined) {
        await currentDeps.setUserTrust(serverUser.id, typedAction.value, rule.name);
      }
      break;
    case 'reset':
      await currentDeps.resetUserTrust(serverUser.id, rule.name);
      break;
  }
};

/**
 * Terminate the current session.
 */
const executeKillStream: ActionExecutor = async (
  context: EvaluationContext,
  action: Action
): Promise<{ enqueuedSessionIds: string[]; queueFailure: boolean }> => {
  const { session, activeSessions, rule, identityServerUserIds } = context;
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
      ? { minutes: cooldownMinutes, triggeringServerUserId: cooldownTargetOf(context) }
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
    serverUserId: session.serverUserId,
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
  const { session, activeSessions, rule, identityServerUserIds } = context;
  if (!session) return;
  const typedAction = action as MessageClientAction;
  const message = typedAction.message;
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
    serverUserId: session.serverUserId,
    activeSessions: sessionsForTargeting,
    identityServerUserIds: rule.enforceAcrossServers ? identityServerUserIds : undefined,
  });

  for (const targetSession of sessionsToMessage) {
    await currentDeps.sendClientMessage(targetSession.id, message);
  }
};

// ============================================================================
// Executor Registry
// ============================================================================

export const executorRegistry: Record<LeafActionType, ActionExecutor> = {
  send: executeSend,
  trust: executeTrust,
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
  target: string,
  actionType: Action['type']
): string {
  return `${ruleId}:${target}:${actionType}`;
}

/**
 * Per-action cooldowns stay account-level wherever there is an account, so a
 * send cooldown still spans that user's sessions; server and install runs have
 * no account and key on the run's subject instead.
 */
function cooldownTargetOf(context: EvaluationContext): string {
  return context.serverUser?.id ?? context.subjectKey;
}

/** One shape for every node the executor declines to run. */
function skippedResult(action: Action, skipReason: string): ActionResult {
  return { action, success: true, skipped: true, skipReason };
}

/**
 * Execute a single action, handling cooldowns.
 */
export async function executeAction(
  context: EvaluationContext,
  action: LeafAction
): Promise<ActionResult> {
  const { rule } = context;
  // A stored type this build never knew is not in the registry.
  const executor: ActionExecutor | undefined = executorRegistry[action.type];

  if (!executor) {
    return {
      action,
      success: false,
      message: `Unknown action type: ${action.type}`,
    };
  }

  if (!context.session && (action.type === 'kill_stream' || action.type === 'message_client')) {
    return skippedResult(action, 'No session to act on');
  }

  // Check cooldown
  const cooldownMinutes = getCooldownMinutes(action);
  if (cooldownMinutes && cooldownMinutes > 0) {
    const targetId = cooldownTargetId(rule.id, cooldownTargetOf(context), action.type);
    const onCooldown = await currentDeps.checkCooldown(rule.id, targetId, cooldownMinutes);

    if (onCooldown) {
      return skippedResult(action, `On cooldown (${cooldownMinutes} minutes)`);
    }
  }

  // Execute the action
  try {
    const executorResult = await executor(context, action);
    if (executorResult?.skipReason) return skippedResult(action, executorResult.skipReason);

    // Set cooldown after successful execution. kill_stream is excluded: its
    // cooldown arms later, once the queue reports the kill actually executed
    // (see killQueue.ts) - an aborted kill must not start the cooldown.
    if (cooldownMinutes && cooldownMinutes > 0 && action.type !== 'kill_stream') {
      const targetId = cooldownTargetId(rule.id, cooldownTargetOf(context), action.type);
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
 * Run an `if` node: its conditions read the same context the automation's own
 * did, and the branch it picks runs through the same leaf executor.
 */
async function executeIfAction(
  context: EvaluationContext,
  action: IfAction,
  position: number
): Promise<ActionResult[]> {
  const { matchedGroups, evidence } = await evaluateAllGroupsAsync(context, action.conditions);
  const matched = matchedGroups !== null;
  const branch = matched ? 'then' : 'else';
  const results: ActionResult[] = [{ action, success: true, branch, matched, evidence }];

  // An unstamped node is addressed by its place in the list; two of them must not collide.
  const node = action.id ?? `if@${position}`;
  const leaves = matched ? action.then : action.else;
  for (const [index, leaf] of leaves.entries()) {
    const [result] = await runAction(context, leaf, index);
    if (result) results.push({ ...result, path: `${node}.${branch}.${index}` });
  }
  return results;
}

/** The one entry point every action node goes through, branch leaves included. */
async function runAction(
  context: EvaluationContext,
  action: Action,
  position: number
): Promise<ActionResult[]> {
  if (action.enabled === false) return [skippedResult(action, 'disabled')];
  if (action.type === 'if') return executeIfAction(context, action, position);
  return [await executeAction(context, action)];
}

/**
 * Execute all actions for a matched rule, flattening each `if` into its own
 * step followed by the leaves of the branch it took.
 */
export async function executeActions(
  context: EvaluationContext,
  actions: Action[]
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];

  for (const [index, action] of actions.entries()) {
    results.push(...(await runAction(context, action, index)));
  }

  return results;
}
