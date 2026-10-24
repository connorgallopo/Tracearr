/**
 * The one definition of "which runs are violations".
 *
 * `/violations`, the public v1 endpoints and every rollup that counts violations
 * read `automation_runs`, which also holds notification runs and runs that
 * stopped on a condition or errored. All of them compose this fragment.
 */

import { and, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { automationRuns, sessions } from '../../db/schema.js';

interface ViolationAliasOptions {
  /** Spells out the third condition of the alias definition, even where a join implies it. */
  requireUser?: boolean;
}

export function violationAliasConditions(options: ViolationAliasOptions = {}): SQL[] {
  const conditions: SQL[] = [
    eq(automationRuns.kind, 'policy'),
    eq(automationRuns.outcome, 'completed'),
  ];
  if (options.requireUser) {
    conditions.push(isNotNull(automationRuns.serverUserId));
  }
  return conditions;
}

/** The same filter for raw SQL, where automation_runs is aliased `v`. */
export const VIOLATION_ALIAS_SQL = sql`v.kind = 'policy' AND v.outcome = 'completed'`;

/**
 * A run's session, for `.leftJoinLateral(runSession(), sql\`true\`)`. A plain join on the id
 * alone decompresses every chunk of sessions to fill one page. The start time lets each
 * lookup skip to its chunk, and LIMIT 1 stops the planner flattening it back into that join.
 */
export function runSession() {
  return new QueryBuilder()
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.id, automationRuns.sessionId),
        eq(sessions.startedAt, automationRuns.sessionStartedAt)
      )
    )
    .limit(1)
    .as('run_session');
}
