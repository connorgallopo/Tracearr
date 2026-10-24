/**
 * Automation run factory for test data generation
 *
 * A completed policy run is what the API renders as a violation.
 */

import type { AutomationKind, RunOutcome, ViolationSeverity } from '@tracearr/shared';
import { executeRawSql } from '../db/pool.js';
import { quote } from '../db/sql.js';

export interface RunData {
  id?: string;
  automationId: string;
  serverUserId: string;
  sessionId: string;
  severity?: ViolationSeverity;
  data?: Record<string, unknown>;
  kind?: AutomationKind;
  outcome?: RunOutcome;
  subjectKey?: string;
  startedAt?: Date;
  finishedAt?: Date;
}

export interface CreatedRun {
  id: string;
  automationId: string;
  serverUserId: string;
  sessionId: string;
  severity: ViolationSeverity;
  data: Record<string, unknown>;
  kind: AutomationKind;
  outcome: RunOutcome;
  subjectKey: string;
  startedAt: Date;
  finishedAt: Date;
  createdAt: Date;
  acknowledgedAt: Date | null;
}

/** Generate run data with defaults */
export function buildRun(overrides: RunData): Required<RunData> {
  const now = new Date();

  return {
    id: overrides.id ?? crypto.randomUUID(),
    automationId: overrides.automationId,
    serverUserId: overrides.serverUserId,
    sessionId: overrides.sessionId,
    severity: overrides.severity ?? 'warning',
    data: overrides.data ?? {},
    kind: overrides.kind ?? 'policy',
    outcome: overrides.outcome ?? 'completed',
    // Policy runs dedup on the subject; the session is the subject when there is one.
    subjectKey: overrides.subjectKey ?? overrides.sessionId,
    startedAt: overrides.startedAt ?? now,
    finishedAt: overrides.finishedAt ?? now,
  };
}

/** Create an automation run in the database */
export async function createTestRun(data: RunData): Promise<CreatedRun> {
  const full = buildRun(data);

  const result = await executeRawSql(`
    INSERT INTO automation_runs (
      id, rule_id, server_user_id, session_id, session_started_at, severity, data,
      kind, outcome, subject_key, started_at, finished_at
    )
    VALUES (
      ${quote(full.id)},
      ${quote(full.automationId)},
      ${quote(full.serverUserId)},
      ${quote(full.sessionId)},
      (SELECT started_at FROM sessions WHERE id = ${quote(full.sessionId)} LIMIT 1),
      ${quote(full.severity)},
      ${quote(JSON.stringify(full.data))}::jsonb,
      ${quote(full.kind)},
      ${quote(full.outcome)},
      ${quote(full.subjectKey)},
      ${quote(full.startedAt.toISOString())},
      ${quote(full.finishedAt.toISOString())}
    )
    RETURNING *
  `);

  return mapRunRow(result.rows[0]);
}

/** Map database row to a typed run */
function mapRunRow(row: Record<string, unknown>): CreatedRun {
  return {
    id: row.id as string,
    automationId: row.rule_id as string,
    serverUserId: row.server_user_id as string,
    sessionId: row.session_id as string,
    severity: row.severity as ViolationSeverity,
    data: row.data as Record<string, unknown>,
    kind: row.kind as AutomationKind,
    outcome: row.outcome as RunOutcome,
    subjectKey: row.subject_key as string,
    startedAt: row.started_at as Date,
    finishedAt: row.finished_at as Date,
    createdAt: row.created_at as Date,
    acknowledgedAt: row.acknowledged_at as Date | null,
  };
}
