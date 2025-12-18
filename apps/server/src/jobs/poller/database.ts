/**
 * Poller Database Operations
 *
 * Database query functions used by the poller.
 * Includes batch loading for performance optimization and rule fetching.
 */

import { eq, and, desc, gte, inArray } from 'drizzle-orm';
import {
  TIME_MS,
  SESSION_LIMITS,
  type Session,
  type Rule,
  type RuleParams,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { sessions, rules } from '../../db/schema.js';
import { mapSessionRow } from './sessionMapper.js';

// ============================================================================
// Session Batch Loading
// ============================================================================

/**
 * Batch load recent sessions for multiple server users (eliminates N+1 in polling loop)
 *
 * This function fetches sessions from the last N hours for a batch of server users
 * in a single query, avoiding the performance penalty of querying per-user.
 *
 * @param serverUserIds - Array of server user IDs to load sessions for
 * @param hours - Number of hours to look back (default: 24)
 * @returns Map of serverUserId -> Session[] for each server user
 *
 * @example
 * const sessionMap = await batchGetRecentUserSessions(['su-1', 'su-2', 'su-3']);
 * const user1Sessions = sessionMap.get('su-1') ?? [];
 */
export async function batchGetRecentUserSessions(
  serverUserIds: string[],
  hours = 24
): Promise<Map<string, Session[]>> {
  if (serverUserIds.length === 0) return new Map();

  const since = new Date(Date.now() - hours * TIME_MS.HOUR);
  const result = new Map<string, Session[]>();

  // Initialize empty arrays for all server users
  for (const serverUserId of serverUserIds) {
    result.set(serverUserId, []);
  }

  // Single query to get recent sessions for all server users using inArray
  const recentSessions = await db
    .select()
    .from(sessions)
    .where(and(inArray(sessions.serverUserId, serverUserIds), gte(sessions.startedAt, since)))
    .orderBy(desc(sessions.startedAt));

  // Group by server user (limit per user to prevent memory issues)
  for (const s of recentSessions) {
    const userSessions = result.get(s.serverUserId) ?? [];
    if (userSessions.length < SESSION_LIMITS.MAX_RECENT_PER_USER) {
      userSessions.push(mapSessionRow(s));
    }
    result.set(s.serverUserId, userSessions);
  }

  return result;
}

// ============================================================================
// Rule Loading
// ============================================================================

/**
 * Get all active rules for evaluation
 *
 * @returns Array of active Rule objects
 *
 * @example
 * const rules = await getActiveRules();
 * // Evaluate each session against these rules
 */
export async function getActiveRules(): Promise<Rule[]> {
  const activeRules = await db.select().from(rules).where(eq(rules.isActive, true));

  return activeRules.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    params: r.params as unknown as RuleParams,
    serverUserId: r.serverUserId,
    isActive: r.isActive,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}
