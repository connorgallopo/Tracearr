/**
 * Violation Handling
 *
 * Functions for creating violations, calculating trust score penalties,
 * and determining rule applicability.
 */

import { eq, sql, and, isNull, gte } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import type { Rule, ViolationSeverity, ViolationWithDetails, RuleType } from '@tracearr/shared';
import { WS_EVENTS, TIME_MS } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { servers, serverUsers, sessions, violations, users } from '../../db/schema.js';
import type * as schema from '../../db/schema.js';
import type { RuleEvaluationResult } from '../../services/rules.js';
import type { PubSubService } from '../../services/cache.js';
import { enqueueNotification } from '../notificationQueue.js';

// Type for transaction context
type TransactionContext = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

// ============================================================================
// Trust Score Calculation
// ============================================================================

/**
 * Calculate trust score penalty based on violation severity.
 *
 * @param severity - Violation severity level
 * @returns Trust score penalty (negative value to subtract)
 *
 * @example
 * getTrustScorePenalty('high');    // 20
 * getTrustScorePenalty('warning'); // 10
 * getTrustScorePenalty('low');     // 5
 */
export function getTrustScorePenalty(severity: ViolationSeverity): number {
  return severity === 'high' ? 20 : severity === 'warning' ? 10 : 5;
}

// ============================================================================
// Violation Deduplication
// ============================================================================

// Deduplication window - violations within this time window with overlapping sessions are considered duplicates
const VIOLATION_DEDUP_WINDOW_MS = 5 * TIME_MS.MINUTE;

// Rules that involve multiple sessions (need session overlap deduplication)
const MULTI_SESSION_RULES: RuleType[] = ['concurrent_streams', 'simultaneous_locations'];

// Rules that are user-level (any recent violation for same user = duplicate)
const USER_LEVEL_RULES: RuleType[] = ['device_velocity'];

// Rules that are single-session (need same-session deduplication)
// Each session can independently violate these rules
const SINGLE_SESSION_RULES: RuleType[] = ['impossible_travel', 'geo_restriction'];

// ============================================================================
// Shared Deduplication Logic
// ============================================================================

/**
 * Violation data returned from dedup queries
 */
interface RecentViolation {
  id: string;
  sessionId: string | null;
  data: unknown;
}

/**
 * P1-6: Shared deduplication logic for both transaction and non-transaction contexts.
 * Extracted to avoid code duplication between isDuplicateViolation and isDuplicateViolationInTransaction.
 *
 * @param recentViolations - Recent violations to check against
 * @param ruleType - Type of rule being evaluated
 * @param triggeringSessionId - The session triggering the new violation
 * @param relatedSessionIds - Related session IDs for multi-session rules
 * @returns true if a duplicate exists
 */
function checkDuplicateInViolations(
  recentViolations: RecentViolation[],
  ruleType: RuleType,
  triggeringSessionId: string,
  relatedSessionIds: string[]
): boolean {
  if (recentViolations.length === 0) {
    return false;
  }

  // User-level rules: any recent violation for same user/ruleType = duplicate
  if (USER_LEVEL_RULES.includes(ruleType)) {
    const existing = recentViolations[0];
    if (existing) {
      console.log(
        `[Violations] Skipping duplicate ${ruleType}: user already has recent violation ${existing.id}`
      );
      return true;
    }
  }

  // Single-session rules: duplicate if same triggering session already has a violation
  if (SINGLE_SESSION_RULES.includes(ruleType)) {
    for (const existing of recentViolations) {
      if (existing.sessionId === triggeringSessionId) {
        console.log(
          `[Violations] Skipping duplicate ${ruleType}: session ${triggeringSessionId} already has violation ${existing.id}`
        );
        return true;
      }
    }
    return false;
  }

  // Multi-session rules: duplicate if any session overlap
  for (const existing of recentViolations) {
    const existingData = existing.data as Record<string, unknown> | null;
    const existingRelatedIds = (existingData?.relatedSessionIds as string[]) || [];

    // Case 1: This triggering session is already covered as a related session in an existing violation
    if (existingRelatedIds.includes(triggeringSessionId)) {
      console.log(
        `[Violations] Skipping duplicate: triggering session ${triggeringSessionId} is related to existing violation ${existing.id}`
      );
      return true;
    }

    // Case 2: The existing violation's triggering session is in our related sessions
    if (existing.sessionId && relatedSessionIds.includes(existing.sessionId)) {
      console.log(
        `[Violations] Skipping duplicate: existing violation ${existing.id} triggered by session in our related sessions`
      );
      return true;
    }

    // Case 3: Any overlap in related session IDs
    const hasOverlap = relatedSessionIds.some((id) => existingRelatedIds.includes(id));
    if (hasOverlap) {
      console.log(
        `[Violations] Skipping duplicate: overlapping related sessions with existing violation ${existing.id}`
      );
      return true;
    }
  }

  return false;
}

/**
 * Check if a duplicate violation already exists for the same user/rule type.
 *
 * This prevents creating multiple violations when:
 * - Multiple sessions start simultaneously and each sees the others as active
 * - The same violation event is detected by both SSE and poller
 * - Rapid successive sessions trigger the same rule type
 *
 * Deduplication strategy varies by rule type:
 *
 * **Multi-session rules** (concurrent_streams, simultaneous_locations):
 * A violation is considered a duplicate if any overlap in session IDs.
 *
 * **Single-session rules** (impossible_travel, device_velocity, geo_restriction):
 * A violation is considered a duplicate if same triggering session + rule type.
 *
 * Common criteria for all rules:
 * - Same serverUserId
 * - Same rule type (not just ruleId - any rule of the same type)
 * - Created within the dedup window (5 minutes)
 * - Not yet acknowledged
 *
 * @param serverUserId - Server user who violated the rule
 * @param ruleType - Type of rule (concurrent_streams, simultaneous_locations, etc.)
 * @param triggeringSessionId - The session that triggered this violation
 * @param relatedSessionIds - Session IDs involved in this violation
 * @returns true if a duplicate violation exists
 */
export async function isDuplicateViolation(
  serverUserId: string,
  ruleType: RuleType,
  triggeringSessionId: string,
  relatedSessionIds: string[]
): Promise<boolean> {
  const windowStart = new Date(Date.now() - VIOLATION_DEDUP_WINDOW_MS);

  // P2-9: Use violations.ruleType directly instead of joining rules table
  const recentViolations = await db
    .select({
      id: violations.id,
      sessionId: violations.sessionId,
      data: violations.data,
    })
    .from(violations)
    .where(
      and(
        eq(violations.serverUserId, serverUserId),
        eq(violations.ruleType, ruleType),
        isNull(violations.acknowledgedAt),
        gte(violations.createdAt, windowStart)
      )
    );

  return checkDuplicateInViolations(
    recentViolations,
    ruleType,
    triggeringSessionId,
    relatedSessionIds
  );
}

/**
 * Transaction-aware duplicate violation check.
 * MUST be called within a SERIALIZABLE transaction to prevent race conditions.
 *
 * This version uses the transaction context for reads, ensuring that:
 * - Reads happen within transaction isolation
 * - SERIALIZABLE isolation prevents phantom reads
 * - Concurrent transactions will serialize or retry
 *
 * For multi-session rules (concurrent_streams, simultaneous_locations), an advisory
 * lock is taken to prevent the race condition where both transactions read an empty
 * violations table and insert violations with different sessionIds.
 *
 * @param tx - Transaction context (ensures reads happen within transaction isolation)
 * @param serverUserId - Server user who violated the rule
 * @param ruleType - Type of rule (concurrent_streams, simultaneous_locations, etc.)
 * @param triggeringSessionId - The session that triggered this violation
 * @param relatedSessionIds - Session IDs involved in this violation
 * @returns true if a duplicate violation exists
 */
export async function isDuplicateViolationInTransaction(
  tx: TransactionContext,
  serverUserId: string,
  ruleType: RuleType,
  triggeringSessionId: string,
  relatedSessionIds: string[]
): Promise<boolean> {
  // P0-1: For multi-session rules, take advisory lock to serialize concurrent transactions
  // This prevents the race condition where both transactions read empty table and insert
  // violations with different sessionIds (which bypasses both SERIALIZABLE and unique constraint)
  if (MULTI_SESSION_RULES.includes(ruleType)) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${serverUserId} || '::' || ${ruleType}))`
    );
  }

  const windowStart = new Date(Date.now() - VIOLATION_DEDUP_WINDOW_MS);

  // P2-9: Use violations.ruleType directly instead of joining rules table
  // The ruleType column was added for deduplication and constraint support
  const recentViolations = await tx
    .select({
      id: violations.id,
      sessionId: violations.sessionId,
      data: violations.data,
    })
    .from(violations)
    .where(
      and(
        eq(violations.serverUserId, serverUserId),
        eq(violations.ruleType, ruleType),
        isNull(violations.acknowledgedAt),
        gte(violations.createdAt, windowStart)
      )
    );

  // P1-6: Use shared deduplication logic
  return checkDuplicateInViolations(
    recentViolations,
    ruleType,
    triggeringSessionId,
    relatedSessionIds
  );
}

// ============================================================================
// Rule Applicability
// ============================================================================

/**
 * Check if a rule applies to a specific server user.
 *
 * Global rules (serverUserId=null) apply to all server users.
 * User-specific rules only apply to that server user.
 *
 * @param rule - Rule to check
 * @param serverUserId - Server user ID to check against
 * @returns true if the rule applies to this server user
 *
 * @example
 * doesRuleApplyToUser({ serverUserId: null }, 'su-123');       // true (global rule)
 * doesRuleApplyToUser({ serverUserId: 'su-123' }, 'su-123'); // true (user-specific)
 * doesRuleApplyToUser({ serverUserId: 'su-456' }, 'su-123'); // false (different user)
 */
export function doesRuleApplyToUser(
  rule: { serverUserId: string | null },
  serverUserId: string
): boolean {
  return rule.serverUserId === null || rule.serverUserId === serverUserId;
}

// ============================================================================
// Violation Creation
// ============================================================================

/**
 * Create a violation from rule evaluation result.
 * Uses a transaction to ensure violation insert and trust score update are atomic.
 *
 * @deprecated Use `createViolationInTransaction()` + `broadcastViolations()` instead
 * for proper atomic behavior when creating sessions and violations together.
 * This function creates its own transaction, which cannot be combined with
 * session creation. Only use this for standalone violation creation outside
 * the poller flow.
 *
 * @param ruleId - ID of the rule that was violated
 * @param serverUserId - ID of the server user who violated the rule
 * @param sessionId - ID of the session where violation occurred
 * @param result - Rule evaluation result with severity and data
 * @param rule - Full rule object for broadcast details
 * @param pubSubService - Optional pub/sub service for WebSocket broadcast
 *
 * @example
 * // Preferred pattern (in poller):
 * const violationResults = await db.transaction(async (tx) => {
 *   const session = await tx.insert(sessions).values(data).returning();
 *   return await createViolationInTransaction(tx, ruleId, serverUserId, session.id, result, rule);
 * });
 * await broadcastViolations(violationResults, sessionId, pubSubService);
 *
 * // Legacy pattern (standalone, avoid in new code):
 * await createViolation(ruleId, serverUserId, sessionId, result, rule, pubSubService);
 */
export async function createViolation(
  ruleId: string,
  serverUserId: string,
  sessionId: string,
  result: RuleEvaluationResult,
  rule: Rule,
  pubSubService: PubSubService | null
): Promise<void> {
  // Calculate trust penalty based on severity
  const trustPenalty = getTrustScorePenalty(result.severity);

  // Use transaction to ensure violation creation and trust score update are atomic
  const created = await db.transaction(async (tx) => {
    // Use onConflictDoNothing to handle race conditions at DB level
    // If the unique constraint is violated, the insert is silently skipped
    const insertedRows = await tx
      .insert(violations)
      .values({
        ruleId,
        serverUserId,
        sessionId,
        severity: result.severity,
        ruleType: rule.type,
        data: result.data,
      })
      .onConflictDoNothing()
      .returning();

    const violation = insertedRows[0];

    // Only update trust score if we actually inserted a violation
    if (violation) {
      await tx
        .update(serverUsers)
        .set({
          trustScore: sql`GREATEST(0, ${serverUsers.trustScore} - ${trustPenalty})`,
          updatedAt: new Date(),
        })
        .where(eq(serverUsers.id, serverUserId));
    }

    return violation;
  });

  // Get server user and server details for the violation broadcast (outside transaction - read only)
  const [details] = await db
    .select({
      userId: serverUsers.id,
      username: serverUsers.username,
      thumbUrl: serverUsers.thumbUrl,
      identityName: users.name,
      serverId: servers.id,
      serverName: servers.name,
      serverType: servers.type,
    })
    .from(serverUsers)
    .innerJoin(users, eq(serverUsers.userId, users.id))
    .innerJoin(sessions, eq(sessions.id, sessionId))
    .innerJoin(servers, eq(servers.id, sessions.serverId))
    .where(eq(serverUsers.id, serverUserId))
    .limit(1);

  // Publish violation event for WebSocket broadcast
  if (pubSubService && created && details) {
    const violationWithDetails: ViolationWithDetails = {
      id: created.id,
      ruleId: created.ruleId,
      serverUserId: created.serverUserId,
      sessionId: created.sessionId,
      severity: created.severity,
      data: created.data,
      acknowledgedAt: created.acknowledgedAt,
      createdAt: created.createdAt,
      user: {
        id: details.userId,
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
    console.log(`[Poller] Violation broadcast: ${rule.name} for user ${details.username}`);

    // Enqueue notification for async dispatch (Discord, webhooks, push)
    await enqueueNotification({ type: 'violation', payload: violationWithDetails });
  }
}

// ============================================================================
// Transaction-Aware Violation Creation
// ============================================================================

/**
 * Result of creating a violation within a transaction.
 * Contains data needed for post-transaction broadcasting.
 */
export interface ViolationInsertResult {
  violation: typeof violations.$inferSelect;
  rule: Rule;
  trustPenalty: number;
}

/**
 * Create a violation within an existing transaction context.
 * Use this when session insert + violation creation must be atomic.
 *
 * This function:
 * 1. Inserts the violation record
 * 2. Updates the server user's trust score
 * Both within the provided transaction.
 *
 * Broadcasting/notification must be done AFTER the transaction commits.
 *
 * @param tx - Transaction context
 * @param ruleId - ID of the rule that was violated
 * @param serverUserId - ID of the server user who violated the rule
 * @param sessionId - ID of the session where violation occurred
 * @param result - Rule evaluation result with severity and data
 * @param rule - Full rule object for broadcast details
 * @returns Violation insert result for post-transaction broadcasting
 */
export async function createViolationInTransaction(
  tx: TransactionContext,
  ruleId: string,
  serverUserId: string,
  sessionId: string,
  result: RuleEvaluationResult,
  rule: Rule
): Promise<ViolationInsertResult | null> {
  const trustPenalty = getTrustScorePenalty(result.severity);

  // Use onConflictDoNothing to handle race conditions at DB level
  // If the unique constraint is violated, the insert is silently skipped
  const insertedRows = await tx
    .insert(violations)
    .values({
      ruleId,
      serverUserId,
      sessionId,
      severity: result.severity,
      ruleType: rule.type,
      data: result.data,
    })
    .onConflictDoNothing()
    .returning();

  const violation = insertedRows[0];

  // If insert was skipped due to conflict, return null
  if (!violation) {
    console.log(
      `[Violations] Duplicate prevented by DB constraint: ${rule.type} for session ${sessionId}`
    );
    return null;
  }

  // Decrease server user trust score based on severity
  await tx
    .update(serverUsers)
    .set({
      trustScore: sql`GREATEST(0, ${serverUsers.trustScore} - ${trustPenalty})`,
      updatedAt: new Date(),
    })
    .where(eq(serverUsers.id, serverUserId));

  return { violation, rule, trustPenalty };
}

/**
 * Broadcast violation events after transaction has committed.
 * Call this AFTER the transaction to ensure data is persisted before broadcasting.
 *
 * @param violationResults - Array of violation insert results
 * @param sessionId - Session ID for fetching server details
 * @param pubSubService - PubSub service for WebSocket broadcast
 */
export async function broadcastViolations(
  violationResults: ViolationInsertResult[],
  sessionId: string,
  pubSubService: PubSubService | null
): Promise<void> {
  if (!pubSubService || violationResults.length === 0) return;

  // Get server user and server details for the violation broadcast (single query for all)
  const [details] = await db
    .select({
      userId: serverUsers.id,
      username: serverUsers.username,
      thumbUrl: serverUsers.thumbUrl,
      identityName: users.name,
      serverId: servers.id,
      serverName: servers.name,
      serverType: servers.type,
    })
    .from(sessions)
    .innerJoin(serverUsers, eq(serverUsers.id, sessions.serverUserId))
    .innerJoin(users, eq(serverUsers.userId, users.id))
    .innerJoin(servers, eq(servers.id, sessions.serverId))
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (!details) return;

  for (const { violation, rule } of violationResults) {
    const violationWithDetails: ViolationWithDetails = {
      id: violation.id,
      ruleId: violation.ruleId,
      serverUserId: violation.serverUserId,
      sessionId: violation.sessionId,
      severity: violation.severity,
      data: violation.data,
      acknowledgedAt: violation.acknowledgedAt,
      createdAt: violation.createdAt,
      user: {
        id: details.userId,
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
    console.log(`[Poller] Violation broadcast: ${rule.name} for user ${details.username}`);

    // Enqueue notification for async dispatch (Discord, webhooks, push)
    await enqueueNotification({ type: 'violation', payload: violationWithDetails });
  }
}
