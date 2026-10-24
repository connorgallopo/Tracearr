/**
 * Violation Handling
 *
 * Broadcasting for violations created inside session lifecycle transactions.
 */

import { eq } from 'drizzle-orm';
import type { RunFinishedEvent, ViolationWithDetails } from '@tracearr/shared';
import { WS_EVENTS } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { servers, serverUsers, sessions, users } from '../../db/schema.js';
import { sessionRowById } from '../../db/sessions/row.js';
import type { automationRuns } from '../../db/schema.js';
import { publishRunFinished, runFinishedOf } from '../../services/automations/runRecorder.js';
import type { PubSubService } from '../../services/cache.js';
import { enqueueNotification } from '../notificationQueue.js';

// ============================================================================
// Transaction-Aware Violation Creation
// ============================================================================

/** Minimal automation info needed for violation broadcasting. */
export interface ViolationRuleInfo {
  id: string;
  name: string;
  // Kept so the broadcast payload matches the v1-era API shape; automations never set it.
  type: null;
}

/**
 * Result of creating a violation within a transaction.
 * Contains data needed for post-transaction broadcasting.
 */
export interface ViolationInsertResult {
  violation: typeof automationRuns.$inferSelect;
  rule: ViolationRuleInfo;
}

/**
 * Broadcast violation events after transaction has committed.
 * Call this AFTER the transaction to ensure data is persisted before broadcasting.
 *
 * @param violationResults - Array of violation insert results
 * @param subject - The session, or { serverUserId } for violations that have no session
 * @param pubSubService - PubSub service for WebSocket broadcast
 */
export async function broadcastViolations(
  violationResults: ViolationInsertResult[],
  subject: Pick<typeof sessions.$inferSelect, 'id' | 'startedAt'> | { serverUserId: string },
  pubSubService: Pick<PubSubService, 'publish'> | null
): Promise<void> {
  if (!pubSubService || violationResults.length === 0) return;

  const detailFields = {
    userId: serverUsers.id,
    identityUserId: users.id,
    username: serverUsers.username,
    thumbUrl: serverUsers.thumbUrl,
    identityName: users.name,
    serverId: servers.id,
    serverName: servers.name,
    serverType: servers.type,
  };
  const [details] =
    'id' in subject
      ? await db
          .select(detailFields)
          .from(sessions)
          .innerJoin(serverUsers, eq(serverUsers.id, sessions.serverUserId))
          .innerJoin(users, eq(serverUsers.userId, users.id))
          .innerJoin(servers, eq(servers.id, sessions.serverId))
          .where(sessionRowById(subject))
          .limit(1)
      : await db
          .select(detailFields)
          .from(serverUsers)
          .innerJoin(users, eq(serverUsers.userId, users.id))
          .innerJoin(servers, eq(servers.id, serverUsers.serverId))
          .where(eq(serverUsers.id, subject.serverUserId))
          .limit(1);

  if (!details) return;

  const finished: RunFinishedEvent[] = [];
  for (const { violation, rule } of violationResults) {
    const violationWithDetails: ViolationWithDetails = {
      id: violation.id,
      ruleId: violation.automationId,
      // Policy runs always carry both; details.userId is the same server user.
      serverUserId: violation.serverUserId ?? details.userId,
      sessionId: violation.sessionId,
      severity: violation.severity ?? 'warning',
      data: violation.data,
      acknowledgedAt: violation.acknowledgedAt,
      createdAt: violation.createdAt,
      user: {
        id: details.userId,
        userId: details.identityUserId,
        username: details.username,
        thumbUrl: details.thumbUrl,
        serverId: details.serverId,
        identityName: details.identityName,
      },
      rule: {
        id: rule.id,
        name: rule.name,
        type: rule.type,
      },
      server: {
        id: details.serverId,
        name: details.serverName,
        type: details.serverType,
      },
    };

    await pubSubService.publish(WS_EVENTS.VIOLATION_NEW, violationWithDetails);
    finished.push(runFinishedOf(violation));
    console.log(`[Poller] Violation broadcast: ${rule.name} for user ${details.username}`);

    // Enqueue notification for async dispatch (Discord, webhooks, push)
    await enqueueNotification({ type: 'violation', payload: violationWithDetails });
  }

  await publishRunFinished(finished, pubSubService);
}
