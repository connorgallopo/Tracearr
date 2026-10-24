/**
 * Stream Termination Service
 *
 * Orchestrates stream termination across media servers and logs all termination events.
 * Supports both manual (admin-initiated) and automatic (rule-triggered) terminations.
 */

import { db } from '../db/client.js';
import { terminationLogs, sessions } from '../db/schema.js';
import { readSessionRow, sessionRowById } from '../db/sessions/row.js';
import { createMediaServerClient } from './mediaServer/index.js';
import { getCacheService, getPubSubService } from './cache.js';
import { toRuleSession } from './automations/events/contextAssembly.js';
import { dispatchSessionStopped } from './automations/events/producers.js';
import { clearDbWriteTracking } from '../jobs/poller/dbWriteThrottle.js';

// ============================================================================
// Types
// ============================================================================

export interface TerminateSessionOptions {
  /** Database session ID (UUID) */
  sessionId: string;

  /** How the termination was triggered */
  trigger: 'manual' | 'rule';

  /** For manual: user ID who initiated the termination */
  triggeredByUserId?: string;

  /** For rule: the rule that triggered termination */
  ruleId?: string;

  /** For rule: the violation record */
  violationId?: string;

  /** Message to display to user (Plex only, ignored by Jellyfin/Emby) */
  reason?: string;

  /** The session's start when the caller holds it, so the lookup skips the older chunks */
  sessionStartedAt?: Date | string | null;
}

export type TerminationOutcome = 'terminated' | 'already_gone' | 'failed' | 'server_historical';

export interface TerminationResult {
  success: boolean;
  terminationLogId: string;
  error?: string;
  /** Specific outcome of the termination attempt */
  outcome: TerminationOutcome;
}

// ============================================================================
// Service
// ============================================================================

/**
 * Terminate a stream and log the termination
 *
 * @param options - Termination options including session ID and trigger info
 * @returns Result indicating success/failure and the termination log ID
 *
 * @example
 * // Manual termination by admin
 * const result = await terminateSession({
 *   sessionId: 'uuid-123',
 *   trigger: 'manual',
 *   triggeredByUserId: adminUser.id,
 *   reason: 'Admin requested stream stop',
 * });
 *
 * @example
 * // Rule-triggered termination
 * const result = await terminateSession({
 *   sessionId: 'uuid-123',
 *   trigger: 'rule',
 *   ruleId: rule.id,
 *   violationId: violation.id,
 *   reason: 'Concurrent stream limit exceeded',
 * });
 */
export async function terminateSession(
  options: TerminateSessionOptions
): Promise<TerminationResult> {
  const { sessionId, trigger, triggeredByUserId, ruleId, violationId, reason } = options;

  const session = await readSessionRow(sessionId, options.sessionStartedAt, (where) =>
    db.query.sessions.findFirst({ where, with: { server: true, serverUser: true } })
  );

  if (!session) {
    // Don't log when session not found - we have no audit context (no server/user)
    // The route handler validates session exists before calling this service,
    // so this case only happens on race conditions or bugs
    return {
      success: false,
      terminationLogId: '',
      error: 'Session not found in database',
      outcome: 'failed',
    };
  }

  const logBase = {
    sessionId: session.id,
    sessionStartedAt: session.startedAt,
    serverId: session.serverId,
    serverUserId: session.serverUserId,
    trigger,
    triggeredByUserId: triggeredByUserId ?? null,
    ruleId: ruleId ?? null,
    violationId: violationId ?? null,
    reason: reason ?? null,
  };

  // The switch force-stopped the server's streams; anything queued before it ends here.
  if (session.server.historicalAt) {
    const logEntries = await db
      .insert(terminationLogs)
      .values({
        ...logBase,
        success: false,
        errorMessage: 'Server is historical',
      })
      .returning({ id: terminationLogs.id });

    return {
      success: false,
      terminationLogId: logEntries[0]?.id ?? '',
      error: 'Server is historical',
      outcome: 'server_historical',
    };
  }

  // Create media server client
  const client = createMediaServerClient({
    type: session.server.type,
    url: session.server.url,
    token: session.server.token,
  });

  // Get the session ID for termination
  // For Plex: use plexSessionId (Session.id) which is different from sessionKey
  // For Jellyfin/Emby: use sessionKey directly
  const terminationSessionId =
    session.server.type === 'plex' ? session.plexSessionId : session.sessionKey;

  if (!terminationSessionId) {
    const logEntries = await db
      .insert(terminationLogs)
      .values({
        ...logBase,
        success: false,
        errorMessage: 'No session ID available for termination',
      })
      .returning({ id: terminationLogs.id });

    return {
      success: false,
      terminationLogId: logEntries[0]?.id ?? '',
      error: 'No session ID available for termination',
      outcome: 'failed',
    };
  }

  // Attempt to terminate the session
  let success = false;
  let errorMessage: string | null = null;
  let outcome: TerminationOutcome;

  try {
    await client.terminateSession(terminationSessionId, reason);
    success = true;
    outcome = 'terminated';
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error during termination';

    // Treat "not found" as success - session is already gone
    if (errMsg.includes('not found') || errMsg.includes('404')) {
      success = true;
      outcome = 'already_gone';
      errorMessage = null;
    } else {
      errorMessage = errMsg;
      outcome = 'failed';
    }
  }

  // If termination was successful (or session already gone), clean up locally
  if (success) {
    const now = new Date();
    const startedAt = session.startedAt ? new Date(session.startedAt) : now;
    const durationMs = now.getTime() - startedAt.getTime();

    // Update database
    await db
      .update(sessions)
      .set({
        state: 'stopped',
        stoppedAt: now,
        durationMs,
        forceStopped: true,
      })
      .where(sessionRowById(session));

    await dispatchSessionStopped(
      toRuleSession(session, { state: 'stopped', stoppedAt: now, durationMs }),
      durationMs,
      now
    );

    clearDbWriteTracking(session.id);

    // Update cache (remove from active sessions)
    const cacheService = getCacheService();
    if (cacheService) {
      try {
        await cacheService.removeActiveSession(session.id);

        // Cooldown prevents re-creating this session if it reappears in polls
        if (session.ratingKey) {
          if (session.server.type === 'plex') {
            await cacheService.setTerminationCooldown(
              session.serverId,
              session.sessionKey,
              session.ratingKey
            );
          } else {
            await cacheService.setTerminationCooldownComposite(
              session.serverId,
              session.serverUserId,
              session.deviceId || session.sessionKey,
              session.ratingKey
            );
          }
        }
      } catch (cacheErr) {
        // Log but don't fail - DB is source of truth
        console.error('[Termination] Failed to update cache:', cacheErr);
      }
    }

    // Broadcast stop event
    const pubSubService = getPubSubService();
    if (pubSubService) {
      try {
        await pubSubService.publish('session:stopped', session.id);
      } catch (pubSubErr) {
        // Log but don't fail - clients will sync on next poll
        console.error('[Termination] Failed to broadcast stop:', pubSubErr);
      }
    }
  }

  // Log the termination attempt
  const logEntries = await db
    .insert(terminationLogs)
    .values({
      ...logBase,
      success,
      errorMessage,
    })
    .returning({ id: terminationLogs.id });

  return {
    success,
    terminationLogId: logEntries[0]?.id ?? '',
    error: errorMessage ?? undefined,
    outcome,
  };
}
