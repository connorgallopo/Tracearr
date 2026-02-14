import type {
  Action,
  ActionType,
  LogOnlyAction,
  NotifyAction,
  AdjustTrustAction,
  SetTrustAction,
  KillStreamAction,
  MessageClientAction,
} from '@tracearr/shared';
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
}

/**
 * Dependencies for action executors.
 * These are injected to allow for testing and avoid circular dependencies.
 */
export interface ActionExecutorDeps {
  logAudit: (params: {
    sessionId: string;
    serverUserId: string;
    serverId: string;
    ruleId: string;
    ruleName: string;
    message?: string;
    details: Record<string, unknown>;
  }) => Promise<void>;
  sendNotification: (params: {
    channels: string[];
    title: string;
    message: string;
    data?: Record<string, unknown>;
  }) => Promise<void>;
  adjustUserTrust: (userId: string, delta: number) => Promise<void>;
  setUserTrust: (userId: string, value: number) => Promise<void>;
  resetUserTrust: (userId: string) => Promise<void>;
  terminateSession: (
    sessionId: string,
    serverId: string,
    delay?: number,
    message?: string
  ) => Promise<void>;
  sendClientMessage: (sessionId: string, message: string) => Promise<void>;
  checkCooldown: (ruleId: string, targetId: string, cooldownMinutes: number) => Promise<boolean>;
  setCooldown: (ruleId: string, targetId: string, cooldownMinutes: number) => Promise<void>;
  queueForConfirmation: (params: {
    ruleId: string;
    ruleName: string;
    sessionId: string;
    serverUserId: string;
    serverId: string;
    action: Action;
  }) => Promise<void>;
  disableUser: (serverUserId: string, serverId: string) => Promise<void>;
  enableUser: (serverUserId: string, serverId: string) => Promise<void>;
}

// Default no-op dependencies for testing
const noopDeps: ActionExecutorDeps = {
  logAudit: async () => {
    /* no-op */
  },
  sendNotification: async () => {
    /* no-op */
  },
  adjustUserTrust: async () => {
    /* no-op */
  },
  setUserTrust: async () => {
    /* no-op */
  },
  resetUserTrust: async () => {
    /* no-op */
  },
  terminateSession: async () => {
    /* no-op */
  },
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
  disableUser: async () => {
    /* no-op */
  },
  enableUser: async () => {
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
    sessionId: session.id,
    serverUserId: serverUser.id,
    serverId: server.id,
    ruleId: rule.id,
    ruleName: rule.name,
    message: typedAction.message,
    details: {
      sessionKey: session.sessionKey,
      mediaTitle: session.mediaTitle,
      ipAddress: session.ipAddress,
    },
  });
};

/**
 * Send notification to specified channels.
 */
const executeNotify: ActionExecutor = async (
  context: EvaluationContext,
  action: Action
): Promise<void> => {
  const { session, serverUser, server, rule } = context;
  const typedAction = action as NotifyAction;
  const channels = typedAction.channels;

  if (channels.length === 0) {
    return;
  }

  const title = `Rule Triggered: ${rule.name}`;
  const message = `User "${serverUser.username}" triggered rule "${rule.name}" while playing "${session.mediaTitle}"`;

  await currentDeps.sendNotification({
    channels,
    title,
    message,
    data: {
      ruleId: rule.id,
      sessionId: session.id,
      userId: serverUser.id,
      mediaTitle: session.mediaTitle,
      // Image data for rich push notifications
      serverId: server.id,
      thumbPath: session.thumbPath,
      userThumbUrl: serverUser.thumbUrl,
    },
  });
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
): Promise<void> => {
  const { session, server, serverUser, activeSessions } = context;
  const typedAction = action as KillStreamAction;
  const delaySeconds = typedAction.delay_seconds ?? 0;
  const message = typedAction.message;
  const target = typedAction.target ?? 'triggering';

  // Include triggering session in activeSessions if not already present.
  // The triggering session may not be in the cache yet when rules are evaluated,
  // so we ensure it's included for accurate targeting resolution.
  const sessionsForTargeting = activeSessions.some((s) => s.id === session.id)
    ? activeSessions
    : [...activeSessions, session];

  const sessionsToKill = resolveTargetSessions({
    target,
    triggeringSession: session,
    serverUserId: serverUser.id,
    activeSessions: sessionsForTargeting,
  });

  for (const targetSession of sessionsToKill) {
    await currentDeps.terminateSession(targetSession.id, server.id, delaySeconds, message);
  }
};

/**
 * Send a message to the client (if supported by the media server).
 */
const executeMessageClient: ActionExecutor = async (
  context: EvaluationContext,
  action: Action
): Promise<void> => {
  const { session, serverUser, activeSessions } = context;
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

  const sessionsToMessage = resolveTargetSessions({
    target,
    triggeringSession: session,
    serverUserId: serverUser.id,
    activeSessions: sessionsForTargeting,
  });

  for (const targetSession of sessionsToMessage) {
    await currentDeps.sendClientMessage(targetSession.id, message);
  }
};

/**
 * Disable the user on the media server.
 */
const executeDisableUser: ActionExecutor = async (
  context: EvaluationContext,
  _action: Action
): Promise<void> => {
  const { serverUser, server } = context;
  await currentDeps.disableUser(serverUser.id, server.id);
};

// ============================================================================
// Executor Registry
// ============================================================================

export const executorRegistry: Record<ActionType, ActionExecutor> = {
  log_only: executeLogOnly,
  notify: executeNotify,
  adjust_trust: executeAdjustTrust,
  set_trust: executeSetTrust,
  reset_trust: executeResetTrust,
  kill_stream: executeKillStream,
  message_client: executeMessageClient,
  disable_user: executeDisableUser,
};

// ============================================================================
// Action Execution
// ============================================================================

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

  // Check cooldown
  const cooldownMinutes = getCooldownMinutes(action);
  if (cooldownMinutes && cooldownMinutes > 0) {
    const targetId = `${rule.id}:${serverUser.id}`;
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
      sessionId: context.session.id,
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
    await executor(context, action);

    // Set cooldown after successful execution
    if (cooldownMinutes && cooldownMinutes > 0) {
      const targetId = `${rule.id}:${serverUser.id}`;
      await currentDeps.setCooldown(rule.id, targetId, cooldownMinutes);
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
