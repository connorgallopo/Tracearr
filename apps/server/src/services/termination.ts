/**
 * Stream Termination Service
 *
 * Orchestrates stream termination across media servers and logs all termination events.
 * Supports both manual (admin-initiated) and automatic (rule-triggered) terminations.
 */

import { eq, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { terminationLogs, sessions } from '../db/schema.js';
import { createMediaServerClient } from './mediaServer/index.js';
import type { ServerType } from '@tracearr/shared';

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
}

export interface TerminationResult {
  success: boolean;
  terminationLogId: string;
  error?: string;
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

  // Fetch session with server info
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
    with: {
      server: true,
      serverUser: true,
    },
  });

  if (!session) {
    // Don't log when session not found - we have no audit context (no server/user)
    // The route handler validates session exists before calling this service,
    // so this case only happens on race conditions or bugs
    return {
      success: false,
      terminationLogId: '',
      error: 'Session not found in database',
    };
  }

  // Create media server client
  const client = createMediaServerClient({
    type: session.server.type as ServerType,
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
        sessionId: session.id,
        serverId: session.serverId,
        serverUserId: session.serverUserId,
        trigger,
        triggeredByUserId: triggeredByUserId ?? null,
        ruleId: ruleId ?? null,
        violationId: violationId ?? null,
        reason: reason ?? null,
        success: false,
        errorMessage: 'No session ID available for termination',
      })
      .returning({ id: terminationLogs.id });

    return {
      success: false,
      terminationLogId: logEntries[0]?.id ?? '',
      error: 'No session ID available for termination',
    };
  }

  // Attempt to terminate the session
  let success = false;
  let errorMessage: string | null = null;

  try {
    await client.terminateSession(terminationSessionId, reason);
    success = true;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : 'Unknown error during termination';
  }

  // If termination was successful, mark the session as stopped in our database
  if (success) {
    const now = new Date();
    const startedAt = session.startedAt ? new Date(session.startedAt) : now;
    const durationMs = now.getTime() - startedAt.getTime();

    await db
      .update(sessions)
      .set({
        state: 'stopped',
        stoppedAt: now,
        durationMs,
        forceStopped: true,
      })
      .where(eq(sessions.id, session.id));
  }

  // Log the termination attempt
  const logEntries = await db
    .insert(terminationLogs)
    .values({
      sessionId: session.id,
      serverId: session.serverId,
      serverUserId: session.serverUserId,
      trigger,
      triggeredByUserId: triggeredByUserId ?? null,
      ruleId: ruleId ?? null,
      violationId: violationId ?? null,
      reason: reason ?? null,
      success,
      errorMessage,
    })
    .returning({ id: terminationLogs.id });

  return {
    success,
    terminationLogId: logEntries[0]?.id ?? '',
    error: errorMessage ?? undefined,
  };
}

/**
 * Get termination logs for a server
 */
export async function getTerminationLogs(
  serverId: string,
  options?: { limit?: number }
): Promise<(typeof terminationLogs.$inferSelect)[]> {
  return db.query.terminationLogs.findMany({
    where: eq(terminationLogs.serverId, serverId),
    orderBy: [desc(terminationLogs.createdAt)],
    limit: options?.limit ?? 100,
    with: {
      session: true,
      serverUser: true,
      triggeredByUser: true,
      rule: true,
    },
  });
}

/**
 * Get termination logs for a specific session
 */
export async function getSessionTerminationLogs(
  sessionId: string
): Promise<(typeof terminationLogs.$inferSelect)[]> {
  return db.query.terminationLogs.findMany({
    where: eq(terminationLogs.sessionId, sessionId),
    orderBy: [desc(terminationLogs.createdAt)],
    with: {
      triggeredByUser: true,
      rule: true,
    },
  });
}
