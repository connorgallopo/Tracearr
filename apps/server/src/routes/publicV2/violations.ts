/**
 * Public API v2 - GET /violations and GET /violations/{id}
 *
 * A violation is a completed policy run with an account that has not been
 * dismissed: the rows the Violations page shows. The list orders by
 * created_at DESC, id ASC, which automation_runs_violation_alias_idx serves
 * as is. created_at holds microseconds and a poll tick writes several rows in
 * one transaction, so the cursor carries the column's own text form rather
 * than a millisecond Date.
 */

import { booleanStringSchema } from '@tracearr/shared';
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  automationRuns,
  automations,
  ruleActionResults,
  servers,
  serverUsers,
  users,
} from '../../db/schema.js';
import { personNameColumn } from '../../utils/representativeAccount.js';
import { violationAliasConditions } from '../../services/automations/aliasFilter.js';
import { buildAvatarUrl } from '../../services/imageProxy.js';
import { cursorPage, cursorPaginationSchema, type RouteConfig } from './shared.js';

// What timestamptz::text looks like, so a decoded cursor is only ever a literal Postgres parses back exactly
const TIMESTAMPTZ_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

export function encodeViolationCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt, id }), 'utf8').toString('base64url');
}

export function decodeViolationCursor(raw: string): { createdAt: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      t?: unknown;
      id?: unknown;
    };
    if (typeof parsed.t !== 'string' || !TIMESTAMPTZ_TEXT.test(parsed.t)) return null;
    if (typeof parsed.id !== 'string' || !z.uuid().safeParse(parsed.id).success) return null;
    return { createdAt: parsed.t, id: parsed.id };
  } catch {
    return null;
  }
}

const violationColumns = {
  id: automationRuns.id,
  severity: sql<'low' | 'warning' | 'high'>`coalesce(${automationRuns.severity}, 'warning')`,
  createdAt: automationRuns.createdAt,
  createdAtText: sql<string>`${automationRuns.createdAt}::text`,
  acknowledgedAt: automationRuns.acknowledgedAt,
  sessionId: automationRuns.sessionId,
  data: automationRuns.data,
  ruleId: automations.id,
  ruleName: automations.name,
  serverId: servers.id,
  serverName: servers.name,
  serverType: servers.type,
  userId: serverUsers.userId,
  serverUserId: serverUsers.id,
  thumbUrl: serverUsers.thumbUrl,
  identityName: personNameColumn(),
};

function selectViolations() {
  return db
    .select(violationColumns)
    .from(automationRuns)
    .innerJoin(automations, eq(automationRuns.automationId, automations.id))
    .innerJoin(serverUsers, eq(automationRuns.serverUserId, serverUsers.id))
    .innerJoin(servers, eq(serverUsers.serverId, servers.id))
    .innerJoin(users, eq(serverUsers.userId, users.id));
}

type ViolationRow = Awaited<ReturnType<ReturnType<typeof selectViolations>['execute']>>[number];

export function formatViolation(row: ViolationRow) {
  return {
    id: row.id,
    severity: row.severity,
    created_at: row.createdAt.toISOString(),
    acknowledged_at: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
    session_id: row.sessionId,
    rule: { id: row.ruleId, name: row.ruleName },
    server: { id: row.serverId, name: row.serverName, type: row.serverType },
    user: {
      id: row.userId,
      server_user_id: row.serverUserId,
      username: row.identityName,
      thumb_url: row.thumbUrl,
      avatar_url: buildAvatarUrl(row.serverId, row.thumbUrl),
    },
    data: row.data,
  };
}

export type ViolationShape = ReturnType<typeof formatViolation>;

function violationConditions(): SQL[] {
  return [...violationAliasConditions({ requireUser: true }), isNull(automationRuns.dismissedAt)];
}

export function registerViolationsRoutes(app: FastifyInstance, routeConfig: RouteConfig): void {
  app.get(
    '/violations',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const querySchema = cursorPaginationSchema.extend({
        server_id: z.uuid().optional(),
        user_id: z.uuid().optional(),
        server_user_id: z.uuid().optional(),
        rule_id: z.uuid().optional(),
        severity: z.enum(['low', 'warning', 'high']).optional(),
        acknowledged: booleanStringSchema.optional(),
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
      });

      const query = querySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }
      const { cursor, pageSize, since, until, acknowledged, severity } = query.data;
      const {
        server_id: serverId,
        user_id: userId,
        server_user_id: serverUserId,
        rule_id: ruleId,
      } = query.data;

      let cursorValue: { createdAt: string; id: string } | null = null;
      if (cursor) {
        cursorValue = decodeViolationCursor(cursor);
        if (!cursorValue) {
          return reply.badRequest('Invalid cursor');
        }
      }
      if (since && until && since > until) {
        return reply.badRequest('since must be before or equal to until');
      }

      const conditions = violationConditions();
      if (serverId) conditions.push(eq(serverUsers.serverId, serverId));
      if (userId) conditions.push(eq(serverUsers.userId, userId));
      if (serverUserId) conditions.push(eq(automationRuns.serverUserId, serverUserId));
      if (ruleId) conditions.push(eq(automationRuns.automationId, ruleId));
      if (severity) conditions.push(eq(automationRuns.severity, severity));
      if (acknowledged !== undefined) {
        conditions.push(
          acknowledged
            ? isNotNull(automationRuns.acknowledgedAt)
            : isNull(automationRuns.acknowledgedAt)
        );
      }
      if (since) conditions.push(gte(automationRuns.createdAt, since));
      if (until) conditions.push(lte(automationRuns.createdAt, until));
      if (cursorValue) {
        const at = sql`${cursorValue.createdAt}::timestamptz`;
        const keyset = or(
          sql`${automationRuns.createdAt} < ${at}`,
          and(
            sql`${automationRuns.createdAt} = ${at}`,
            sql`${automationRuns.id} > ${cursorValue.id}::uuid`
          )
        );
        if (keyset) conditions.push(lte(automationRuns.createdAt, at), keyset);
      }

      const rows = await selectViolations()
        .where(and(...conditions))
        .orderBy(desc(automationRuns.createdAt), asc(automationRuns.id))
        .limit(pageSize);

      const last = rows.length === pageSize ? rows[rows.length - 1] : undefined;
      return cursorPage(
        rows.map(formatViolation),
        last ? encodeViolationCursor(last.createdAtText, last.id) : null,
        pageSize
      );
    }
  );

  app.get(
    '/violations/:id',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const params = z.object({ id: z.uuid() }).safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid violation id');
      }

      const [row] = await selectViolations()
        .where(and(...violationConditions(), eq(automationRuns.id, params.data.id)))
        .limit(1);
      if (!row) return reply.notFound();

      const actions = await db
        .select({
          actionType: ruleActionResults.actionType,
          success: ruleActionResults.success,
          skipped: ruleActionResults.skipped,
          skipReason: ruleActionResults.skipReason,
          errorMessage: ruleActionResults.errorMessage,
          executedAt: ruleActionResults.executedAt,
        })
        .from(ruleActionResults)
        .where(eq(ruleActionResults.violationId, row.id))
        .orderBy(ruleActionResults.executedAt);

      return {
        ...formatViolation(row),
        actions: actions.map((a) => ({
          type: a.actionType,
          success: a.success,
          skipped: a.skipped ?? false,
          skip_reason: a.skipReason,
          error_message: a.errorMessage,
          executed_at: a.executedAt.toISOString(),
        })),
      };
    }
  );
}
