/**
 * Violation management routes
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and, count, gte, lt, isNull, isNotNull, sql, inArray, type SQL } from 'drizzle-orm';
import {
  violationBulkBodySchema,
  violationIdParamSchema,
  violationQuerySchema,
  violationRosterFilterSchema,
  type Action,
  type AuthUser,
  type ListResponse,
  type ViolationBulkBody,
  type ViolationRosterFilters,
  type ViolationSessionInfo,
  type ViolationSortField,
  type ViolationWithDetails,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import {
  automationRuns,
  automations,
  serverUsers,
  sessions,
  servers,
  users,
  ruleActionResults,
} from '../db/schema.js';
import {
  hasServerAccess,
  resolveServerIds,
  buildMultiServerCondition,
} from '../utils/serverFiltering.js';
import { violationAliasConditions } from '../services/automations/aliasFilter.js';
import { dispatchTrustMoves } from '../services/automations/events/producers.js';
import {
  getServerUserDisplayNames,
  moveTrust,
  recomputeIdentityAggregates,
  type TrustMove,
} from '../services/userService.js';
import { resolveAccessibleServerUserIdsForIdentities } from './users/queries.js';
import {
  buildOrderBy,
  utcDayEnd,
  utcDayStart,
  type SortDirection,
  type SortKey,
} from '../utils/listQuery.js';

/** What a trust-score notification says moved the score when a dismissal put it back. */
const DISMISSED_TRUST_REASON = 'a violation was dismissed';

/**
 * Merge the legacy singular `userId` identity filter with the new `userIds`
 * multi-select form into one deduplicated list. Both can be sent together
 * (e.g. a stale client alongside a new one), so this is additive, not either/or.
 */
function collectIdentityUserIds(userId: string | undefined, userIds: string[] | undefined) {
  return Array.from(new Set([...(userIds ?? []), ...(userId ? [userId] : [])]));
}

/**
 * The trust delta a stored action applied, or null when it applied none.
 * Stored rows are not revalidated on read, so the amount is checked at runtime.
 */
function trustAdjustment(action: Action): number | null {
  if (action.type === 'trust' && action.mode === 'adjust' && typeof action.amount === 'number') {
    return action.amount;
  }
  return null;
}

/**
 * Sort keys, every branch tiebroken on violations.id by buildOrderBy. Without a
 * unique tiebreak, offset paging over rows sharing a created_at (a poller tick
 * writes several at once) both repeats and drops rows between pages.
 *
 * The severity CASE ranks high above low so DESC means high-first, which is
 * what the column header's descending state has always shown.
 */
const VIOLATION_SORT_KEYS: Record<ViolationSortField, SortKey> = {
  createdAt: { key: sql`${automationRuns.createdAt}`, defaultDir: 'desc' },
  severity: {
    key: sql`CASE ${automationRuns.severity} WHEN 'high' THEN 3 WHEN 'warning' THEN 2 WHEN 'low' THEN 1 END`,
    defaultDir: 'desc',
  },
  user: { key: sql`${serverUsers.username}`, defaultDir: 'desc' },
  rule: { key: sql`${automations.name}`, defaultDir: 'desc' },
};

/** The run column is nullable; every row this route serves has one, and the wire shape requires it. */
const ROSTER_SEVERITY = sql<
  'low' | 'warning' | 'high'
>`coalesce(${automationRuns.severity}, 'warning')`;

interface ViolationRosterConditions {
  /** Nothing can match, so callers skip the query and answer with an empty set. */
  empty: boolean;
  conditions: SQL[];
}

/**
 * The single definition of "which violations are in this roster".
 *
 * GET /, its count, POST /bulk/acknowledge and DELETE /bulk all build their row
 * set from this. They used to build it four separate ways, and the two bulk
 * copies accepted a narrower filter set: filtering the table by a rule or a
 * date range and hitting "select all" acted on rows the table never showed, and
 * DELETE /bulk reverses trust as it dismisses. Sharing the builder makes that
 * drift a type error rather than silent data loss.
 *
 * Async because the identity filter has to resolve accessible server-user ids
 * before it can become a predicate.
 */
export async function buildViolationRosterConditions(
  filters: ViolationRosterFilters,
  authUser: AuthUser
): Promise<ViolationRosterConditions> {
  const resolvedIds = resolveServerIds(authUser, filters.serverId, filters.serverIds, {
    strict: false,
  });
  if (resolvedIds?.length === 0) {
    return { empty: true, conditions: [] };
  }

  const conditions: SQL[] = violationAliasConditions({ requireUser: true });

  const serverCondition = buildMultiServerCondition(resolvedIds, serverUsers.serverId);
  if (serverCondition) {
    conditions.push(serverCondition);
  }

  if (filters.serverUserId) {
    conditions.push(eq(automationRuns.serverUserId, filters.serverUserId));
  }

  // An identity with no accessible account contributes nothing, and a set that
  // resolves to nothing is an empty result rather than a 403, matching the
  // non-strict server scoping above.
  const identityUserIds = collectIdentityUserIds(filters.userId, filters.userIds);
  if (identityUserIds.length > 0) {
    const identityServerUserIds = await resolveAccessibleServerUserIdsForIdentities(
      db,
      authUser,
      identityUserIds
    );
    if (identityServerUserIds.length === 0) {
      return { empty: true, conditions: [] };
    }
    conditions.push(inArray(automationRuns.serverUserId, identityServerUserIds));
  }

  if (filters.ruleId) {
    conditions.push(eq(automationRuns.automationId, filters.ruleId));
  }

  if (filters.severity) {
    conditions.push(eq(automationRuns.severity, filters.severity));
  }

  if (filters.acknowledged === true) {
    conditions.push(isNotNull(automationRuns.acknowledgedAt));
  } else if (filters.acknowledged === false) {
    conditions.push(isNull(automationRuns.acknowledgedAt));
  }

  conditions.push(isNull(automationRuns.dismissedAt));

  const startDate = utcDayStart(filters.startDate);
  if (startDate) {
    conditions.push(gte(automationRuns.createdAt, startDate));
  }
  const endDate = utcDayEnd(filters.endDate);
  if (endDate) {
    conditions.push(lt(automationRuns.createdAt, endDate));
  }

  return { empty: false, conditions };
}

/**
 * The by-id guard the roster's filters cannot supply: same alias, same dismissed
 * exclusion, so a run this surface does not serve 404s instead of being acted on.
 */
function aliasedRunFilter(match: SQL) {
  return and(
    match,
    isNull(automationRuns.dismissedAt),
    ...violationAliasConditions({ requireUser: true })
  );
}

/**
 * The id set a bulk action operates on: the explicit ids, or every violation the
 * roster filters match. Both bulk endpoints go through here so neither can
 * resolve selectAll differently from the other.
 */
async function resolveBulkViolationIds(
  body: ViolationBulkBody,
  authUser: AuthUser
): Promise<string[]> {
  if (!body.selectAll) {
    return body.ids ?? [];
  }

  const roster = await buildViolationRosterConditions(
    body.filters ?? violationRosterFilterSchema.parse({}),
    authUser
  );
  if (roster.empty) {
    return [];
  }

  const matching = await db
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .innerJoin(serverUsers, eq(automationRuns.serverUserId, serverUsers.id))
    .where(and(...roster.conditions));

  return matching.map((row) => row.id);
}

/**
 * The flat shape returned by the violation select queries (with joins).
 * Used as input to enrichViolations().
 */
interface ViolationRow {
  id: string;
  ruleId: string;
  ruleName: string;
  ruleType: null;
  serverUserId: string;
  username: string;
  userThumb: string | null;
  identityName: string | null;
  identityUserId: string;
  serverId: string;
  serverName: string;
  sessionId: string | null;
  mediaTitle: string | null;
  mediaType: string | null;
  grandparentTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  year: number | null;
  ipAddress: string | null;
  geoCity: string | null;
  geoRegion: string | null;
  geoCountry: string | null;
  geoContinent: string | null;
  geoPostal: string | null;
  geoLat: number | null;
  geoLon: number | null;
  playerName: string | null;
  device: string | null;
  deviceId: string | null;
  platform: string | null;
  product: string | null;
  quality: string | null;
  startedAt: Date | null;
  severity: 'low' | 'warning' | 'high';
  data: Record<string, unknown> | null;
  createdAt: Date;
  acknowledgedAt: Date | null;
}

/**
 * Enrich flat violation rows with related sessions, user history, and action results.
 * Works for both single-item and multi-item arrays.
 */
async function enrichViolations(violationData: ViolationRow[]) {
  if (violationData.length === 0) return [];

  // Sessions the runs recorded as related; the ids come from the run's own data.
  const allRelatedSessionIds = new Set<string>();
  for (const v of violationData) {
    for (const id of (v.data?.relatedSessionIds as string[] | undefined) ?? []) {
      allRelatedSessionIds.add(id);
    }
  }

  const sessionsById = new Map<string, ViolationSessionInfo>();
  if (allRelatedSessionIds.size > 0) {
    try {
      const relatedSessionsResult = await db
        .select({
          id: sessions.id,
          mediaTitle: sessions.mediaTitle,
          mediaType: sessions.mediaType,
          grandparentTitle: sessions.grandparentTitle,
          seasonNumber: sessions.seasonNumber,
          episodeNumber: sessions.episodeNumber,
          year: sessions.year,
          ipAddress: sessions.ipAddress,
          geoCity: sessions.geoCity,
          geoRegion: sessions.geoRegion,
          geoCountry: sessions.geoCountry,
          geoContinent: sessions.geoContinent,
          geoPostal: sessions.geoPostal,
          geoLat: sessions.geoLat,
          geoLon: sessions.geoLon,
          playerName: sessions.playerName,
          device: sessions.device,
          deviceId: sessions.deviceId,
          platform: sessions.platform,
          product: sessions.product,
          quality: sessions.quality,
          startedAt: sessions.startedAt,
        })
        .from(sessions)
        .where(inArray(sessions.id, Array.from(allRelatedSessionIds)));

      for (const s of relatedSessionsResult) {
        sessionsById.set(s.id, { ...s, deviceId: s.deviceId ?? null });
      }
    } catch (error) {
      console.error('[Violations] Failed to batch fetch related sessions by ID:', error);
      // Continue without related sessions rather than failing the whole list
    }
  }

  // Batch fetch action results for all violations
  const actionResultsByViolation = new Map<
    string,
    Array<{
      actionType: string;
      success: boolean;
      skipped: boolean | null;
      skipReason: string | null;
      errorMessage: string | null;
      executedAt: Date;
    }>
  >();

  try {
    const violationIds = violationData.map((v) => v.id);
    if (violationIds.length > 0) {
      const actionResults = await db
        .select({
          violationId: ruleActionResults.violationId,
          actionType: ruleActionResults.actionType,
          success: ruleActionResults.success,
          skipped: ruleActionResults.skipped,
          skipReason: ruleActionResults.skipReason,
          errorMessage: ruleActionResults.errorMessage,
          executedAt: ruleActionResults.executedAt,
        })
        .from(ruleActionResults)
        .where(inArray(ruleActionResults.violationId, violationIds));

      // Group by violation ID
      for (const result of actionResults) {
        if (!result.violationId) continue;
        const existing = actionResultsByViolation.get(result.violationId) ?? [];
        existing.push({
          actionType: result.actionType,
          success: result.success,
          skipped: result.skipped,
          skipReason: result.skipReason,
          errorMessage: result.errorMessage,
          executedAt: result.executedAt,
        });
        actionResultsByViolation.set(result.violationId, existing);
      }
    }
  } catch (error) {
    console.error('[Violations] Failed to batch fetch action results:', error);
  }

  // Transform flat data into nested structure expected by frontend
  return violationData.map((v) => {
    const relatedSessions = ((v.data?.relatedSessionIds as string[] | undefined) ?? [])
      .map((id) => sessionsById.get(id))
      .filter((s): s is ViolationSessionInfo => s !== undefined);

    return {
      id: v.id,
      ruleId: v.ruleId,
      serverUserId: v.serverUserId,
      sessionId: v.sessionId,
      severity: v.severity,
      data: v.data,
      createdAt: v.createdAt,
      acknowledgedAt: v.acknowledgedAt,
      rule: {
        id: v.ruleId,
        name: v.ruleName,
        type: v.ruleType,
      },
      user: {
        id: v.serverUserId,
        username: v.username,
        thumbUrl: v.userThumb,
        serverId: v.serverId,
        identityName: v.identityName,
        userId: v.identityUserId,
      },
      server: {
        id: v.serverId,
        name: v.serverName,
      },
      session: {
        id: v.sessionId,
        mediaTitle: v.mediaTitle,
        mediaType: v.mediaType,
        grandparentTitle: v.grandparentTitle,
        seasonNumber: v.seasonNumber,
        episodeNumber: v.episodeNumber,
        year: v.year,
        ipAddress: v.ipAddress,
        geoCity: v.geoCity,
        geoRegion: v.geoRegion,
        geoCountry: v.geoCountry,
        geoContinent: v.geoContinent,
        geoPostal: v.geoPostal,
        geoLat: v.geoLat,
        geoLon: v.geoLon,
        playerName: v.playerName,
        device: v.device,
        deviceId: v.deviceId ?? null,
        platform: v.platform,
        product: v.product,
        quality: v.quality,
        startedAt: v.startedAt,
      },
      relatedSessions: relatedSessions.length > 0 ? relatedSessions : undefined,
      actionResults: (() => {
        const results = actionResultsByViolation.get(v.id);
        if (!results || results.length === 0) return undefined;
        return results.map((r) => ({
          actionType: r.actionType,
          success: r.success,
          skipped: r.skipped ?? false,
          skipReason: r.skipReason ?? undefined,
          errorMessage: r.errorMessage ?? undefined,
          executedAt: r.executedAt.toISOString(),
        }));
      })(),
      evidence: v.data?.evidence as ViolationWithDetails['evidence'] | undefined,
    };
  });
}

/**
 * The page query. `where` comes from buildViolationRosterConditions, and the
 * count query below reuses it unchanged.
 */
function buildViolationPageQuery(params: {
  where: SQL | undefined;
  orderBy: ViolationSortField;
  orderDir: SortDirection | undefined;
  pageSize: number;
  offset: number;
}) {
  const { where, orderBy, orderDir, pageSize, offset } = params;

  return db
    .select({
      id: automationRuns.id,
      ruleId: automationRuns.automationId,
      ruleName: automations.name,
      // The v1 column is gone; the key stays on the wire, always null.
      ruleType: sql<null>`NULL`,
      serverUserId: serverUsers.id,
      username: serverUsers.username,
      userThumb: serverUsers.thumbUrl,
      identityName: users.name,
      identityUserId: serverUsers.userId,
      serverId: serverUsers.serverId,
      serverName: servers.name,
      sessionId: automationRuns.sessionId,
      // Session details for context
      mediaTitle: sessions.mediaTitle,
      mediaType: sessions.mediaType,
      grandparentTitle: sessions.grandparentTitle,
      seasonNumber: sessions.seasonNumber,
      episodeNumber: sessions.episodeNumber,
      year: sessions.year,
      ipAddress: sessions.ipAddress,
      geoCity: sessions.geoCity,
      geoRegion: sessions.geoRegion,
      geoCountry: sessions.geoCountry,
      geoContinent: sessions.geoContinent,
      geoPostal: sessions.geoPostal,
      geoLat: sessions.geoLat,
      geoLon: sessions.geoLon,
      playerName: sessions.playerName,
      device: sessions.device,
      deviceId: sessions.deviceId,
      platform: sessions.platform,
      product: sessions.product,
      quality: sessions.quality,
      startedAt: sessions.startedAt,
      severity: ROSTER_SEVERITY,
      data: automationRuns.data,
      createdAt: automationRuns.createdAt,
      acknowledgedAt: automationRuns.acknowledgedAt,
    })
    .from(automationRuns)
    .innerJoin(automations, eq(automationRuns.automationId, automations.id))
    .innerJoin(serverUsers, eq(automationRuns.serverUserId, serverUsers.id))
    .leftJoin(users, eq(serverUsers.userId, users.id))
    .innerJoin(servers, eq(serverUsers.serverId, servers.id))
    .leftJoin(sessions, eq(automationRuns.sessionId, sessions.id))
    .where(where)
    .orderBy(buildOrderBy(VIOLATION_SORT_KEYS, orderBy, orderDir, sql`${automationRuns.id}`))
    .limit(pageSize)
    .offset(offset);
}

/** The list row shape, derived so the envelope cannot drift from the mapper. */
type EnrichedViolation = Awaited<ReturnType<typeof enrichViolations>>[number];

export const violationRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /violations - List violations with pagination and filters
   *
   * Violations are filtered by server access. Users only see violations
   * from servers they have access to.
   */
  app.get('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = violationQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { page, pageSize, orderBy, orderDir, ...filters } = query.data;
    const authUser = request.user;
    const offset = (page - 1) * pageSize;

    const roster = await buildViolationRosterConditions(filters, authUser);
    if (roster.empty) {
      return { data: [], meta: { page, pageSize, total: 0 } } satisfies ListResponse<never>;
    }

    const where = and(...roster.conditions);

    const violationData = await buildViolationPageQuery({
      where,
      orderBy,
      orderDir,
      pageSize,
      offset,
    });

    // Counted off the same conditions, minus the joins only the select list
    // needs. A hand-written copy of these predicates is what let the count
    // disagree with the page it was counting.
    const countRows = await db
      .select({ total: count() })
      .from(automationRuns)
      .innerJoin(serverUsers, eq(automationRuns.serverUserId, serverUsers.id))
      .where(where);
    const total = countRows[0]?.total ?? 0;

    const formattedData = await enrichViolations(violationData);

    return {
      data: formattedData,
      meta: { page, pageSize, total },
    } satisfies ListResponse<EnrichedViolation>;
  });

  /**
   * GET /violations/:id - Get a specific violation with full details
   */
  app.get('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = violationIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid violation ID');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Query with server info for access check, including all session fields
    const violationRows = await db
      .select({
        id: automationRuns.id,
        ruleId: automationRuns.automationId,
        ruleName: automations.name,
        // The v1 column is gone; the key stays on the wire, always null.
        ruleType: sql<null>`NULL`,
        serverUserId: serverUsers.id,
        username: serverUsers.username,
        userThumb: serverUsers.thumbUrl,
        identityName: users.name,
        identityUserId: serverUsers.userId,
        serverId: serverUsers.serverId,
        serverName: servers.name,
        sessionId: automationRuns.sessionId,
        mediaTitle: sessions.mediaTitle,
        mediaType: sessions.mediaType,
        grandparentTitle: sessions.grandparentTitle,
        seasonNumber: sessions.seasonNumber,
        episodeNumber: sessions.episodeNumber,
        year: sessions.year,
        ipAddress: sessions.ipAddress,
        geoCity: sessions.geoCity,
        geoRegion: sessions.geoRegion,
        geoCountry: sessions.geoCountry,
        geoContinent: sessions.geoContinent,
        geoPostal: sessions.geoPostal,
        geoLat: sessions.geoLat,
        geoLon: sessions.geoLon,
        playerName: sessions.playerName,
        device: sessions.device,
        deviceId: sessions.deviceId,
        platform: sessions.platform,
        product: sessions.product,
        quality: sessions.quality,
        startedAt: sessions.startedAt,
        severity: ROSTER_SEVERITY,
        data: automationRuns.data,
        createdAt: automationRuns.createdAt,
        acknowledgedAt: automationRuns.acknowledgedAt,
      })
      .from(automationRuns)
      .innerJoin(automations, eq(automationRuns.automationId, automations.id))
      .innerJoin(serverUsers, eq(automationRuns.serverUserId, serverUsers.id))
      .leftJoin(users, eq(serverUsers.userId, users.id))
      .innerJoin(servers, eq(serverUsers.serverId, servers.id))
      .leftJoin(sessions, eq(automationRuns.sessionId, sessions.id))
      .where(aliasedRunFilter(eq(automationRuns.id, id)))
      .limit(1);

    const violation = violationRows[0];
    if (!violation) {
      return reply.notFound('Violation not found');
    }

    // Check server access
    if (!hasServerAccess(authUser, violation.serverId)) {
      return reply.forbidden('You do not have access to this violation');
    }

    // Enrich with related sessions, user history, and action results
    const enriched = await enrichViolations([violation]);
    const enrichedViolation = enriched[0];
    if (!enrichedViolation) {
      return reply.notFound('Violation not found');
    }

    // Resolve display names for user_id array conditions (in/not_in) in evidence
    if (enrichedViolation.evidence && enrichedViolation.evidence.length > 0) {
      const userIdSet = new Set<string>();
      for (const group of enrichedViolation.evidence) {
        for (const cond of group.conditions) {
          // only threshold holds uuids; cond.actual is a display name, not an id
          if (cond.field === 'user_id' && Array.isArray(cond.threshold)) {
            for (const id of cond.threshold) {
              if (typeof id === 'string') userIdSet.add(id);
            }
          }
        }
      }
      if (userIdSet.size > 0) {
        try {
          const userNames = await getServerUserDisplayNames([...userIdSet]);
          return { ...enrichedViolation, userNames };
        } catch (err) {
          request.log.error(
            { err, violationId: id },
            'failed to resolve user display names for violation detail'
          );
        }
      }
    }

    return enrichedViolation;
  });

  /**
   * PATCH /violations/:id - Acknowledge a violation
   */
  app.patch('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = violationIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid violation ID');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Only owners can acknowledge violations
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can acknowledge violations');
    }

    // Check violation exists and get server info for access check
    const violationRows = await db
      .select({
        id: automationRuns.id,
        serverId: serverUsers.serverId,
      })
      .from(automationRuns)
      .innerJoin(serverUsers, eq(automationRuns.serverUserId, serverUsers.id))
      .where(aliasedRunFilter(eq(automationRuns.id, id)))
      .limit(1);

    const violation = violationRows[0];
    if (!violation) {
      return reply.notFound('Violation not found');
    }

    // Check server access
    if (!hasServerAccess(authUser, violation.serverId)) {
      return reply.forbidden('You do not have access to this violation');
    }

    // Update acknowledgment
    const updated = await db
      .update(automationRuns)
      .set({
        acknowledgedAt: new Date(),
      })
      .where(and(eq(automationRuns.id, id), isNull(automationRuns.dismissedAt)))
      .returning({
        id: automationRuns.id,
        acknowledgedAt: automationRuns.acknowledgedAt,
      });

    const updatedViolation = updated[0];
    if (!updatedViolation) {
      return reply.internalServerError('Failed to acknowledge violation');
    }

    return {
      success: true,
      acknowledgedAt: updatedViolation.acknowledgedAt,
    };
  });

  /**
   * DELETE /violations/:id - Dismiss a violation
   *
   * Dismissing a violation:
   * 1. Reverses any trust score changes made by explicit rule actions (see trustAdjustment)
   * 2. Soft-deletes the row (dismissedAt) so dedup keeps blocking re-creation
   *
   * This treats dismiss as "false positive, undo everything".
   * For just marking as seen, use PATCH (acknowledge) instead.
   */
  app.delete('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = violationIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid violation ID');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Only owners can delete violations
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can dismiss violations');
    }

    // Check violation exists and get info needed for trust reversal. A
    // dismissed violation 404s so trust can never be reversed twice.
    const violationRows = await db
      .select({
        id: automationRuns.id,
        ruleId: automationRuns.automationId,
        serverUserId: serverUsers.id,
        serverId: serverUsers.serverId,
        userId: serverUsers.userId,
      })
      .from(automationRuns)
      .innerJoin(serverUsers, eq(automationRuns.serverUserId, serverUsers.id))
      .where(aliasedRunFilter(eq(automationRuns.id, id)))
      .limit(1);

    const violation = violationRows[0];
    if (!violation) {
      return reply.notFound('Violation not found');
    }

    // Check server access
    if (!hasServerAccess(authUser, violation.serverId)) {
      return reply.forbidden('You do not have access to this violation');
    }

    // Calculate trust adjustment to reverse from rule's actions
    let trustAdjustmentToReverse = 0;
    const ruleRows = await db
      .select({ actions: automations.actions })
      .from(automations)
      .where(eq(automations.id, violation.ruleId))
      .limit(1);

    const rule = ruleRows[0];
    const ruleActions = rule?.actions?.actions;
    if (ruleActions && Array.isArray(ruleActions)) {
      for (const action of ruleActions) {
        // Sum up all trust adjustments made by this rule
        trustAdjustmentToReverse += trustAdjustment(action) ?? 0;
      }
    }

    // Dismiss violation and reverse trust score atomically. Soft delete: the
    // row stays so session and inactivity dedup keep blocking re-creation.
    // The dismissedAt guard on the write makes a concurrent dismiss lose the
    // race cleanly instead of reversing trust twice.
    const dismissed = await db.transaction(async (tx) => {
      const stamped = await tx
        .update(automationRuns)
        .set({ dismissedAt: new Date() })
        .where(and(eq(automationRuns.id, id), isNull(automationRuns.dismissedAt)))
        .returning({ id: automationRuns.id });

      if (stamped.length === 0) {
        return null;
      }

      // Reverse trust score adjustment (if any was made). The dismissedAt guard has to
      // stay in this transaction, so the write is moveTrust rather than applyTrustChange.
      const moves =
        trustAdjustmentToReverse === 0
          ? []
          : await moveTrust(
              tx,
              sql`LEAST(100, GREATEST(0, ${serverUsers.trustScore} - ${trustAdjustmentToReverse}))`,
              eq(serverUsers.id, violation.serverUserId)
            );

      // users.totalViolations counts non-dismissed rows, so the rollup must
      // recompute on every dismiss, not only when trust was reversed.
      await recomputeIdentityAggregates(violation.userId, tx);
      return moves;
    });

    if (!dismissed) {
      return reply.notFound('Violation not found');
    }

    await dispatchTrustMoves(dismissed, DISMISSED_TRUST_REASON);

    return { success: true };
  });

  /**
   * POST /violations/bulk/acknowledge - Bulk acknowledge violations
   * Accepts either specific IDs or filter params with selectAll flag
   */
  app.post('/bulk/acknowledge', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can acknowledge violations
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can acknowledge violations');
    }

    const parsedBody = violationBulkBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.badRequest('Invalid request body');
    }
    const body = parsedBody.data;

    if (!body.ids && !body.selectAll) {
      return reply.badRequest('Either ids or selectAll must be provided');
    }

    const violationIds = await resolveBulkViolationIds(body, authUser);

    if (violationIds.length === 0) {
      return { success: true, acknowledged: 0 };
    }

    // Verify access to all violations
    const accessibleViolations = await db
      .select({
        id: automationRuns.id,
        serverId: serverUsers.serverId,
      })
      .from(automationRuns)
      .innerJoin(serverUsers, eq(automationRuns.serverUserId, serverUsers.id))
      .where(aliasedRunFilter(inArray(automationRuns.id, violationIds)));

    // Filter to only accessible violations
    const accessibleIds = accessibleViolations
      .filter((v) => hasServerAccess(authUser, v.serverId))
      .map((v) => v.id);

    if (accessibleIds.length === 0) {
      return { success: true, acknowledged: 0 };
    }

    // Rows already acknowledged keep their original acknowledgedAt, whichever
    // way the ids were chosen, and the count is the rows this request stamped.
    const stamped = await db
      .update(automationRuns)
      .set({ acknowledgedAt: new Date() })
      .where(
        and(
          inArray(automationRuns.id, accessibleIds),
          isNull(automationRuns.dismissedAt),
          isNull(automationRuns.acknowledgedAt)
        )
      )
      .returning({ id: automationRuns.id });

    return { success: true, acknowledged: stamped.length };
  });

  /**
   * DELETE /violations/bulk - Bulk dismiss (delete) violations
   * Accepts either specific IDs or filter params with selectAll flag
   */
  app.delete('/bulk', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can dismiss violations
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can dismiss violations');
    }

    const parsedBody = violationBulkBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.badRequest('Invalid request body');
    }
    const body = parsedBody.data;

    if (!body.ids && !body.selectAll) {
      return reply.badRequest('Either ids or selectAll must be provided');
    }

    const violationIds = await resolveBulkViolationIds(body, authUser);

    if (violationIds.length === 0) {
      return { success: true, dismissed: 0 };
    }

    // Get violation details including rule ID for trust reversal. Dismissed
    // rows are excluded so re-sending their ids cannot re-reverse trust.
    const violationDetails = await db
      .select({
        id: automationRuns.id,
        ruleId: automationRuns.automationId,
        serverUserId: serverUsers.id,
        serverId: serverUsers.serverId,
        userId: serverUsers.userId,
      })
      .from(automationRuns)
      .innerJoin(serverUsers, eq(automationRuns.serverUserId, serverUsers.id))
      .where(aliasedRunFilter(inArray(automationRuns.id, violationIds)));

    // Filter to only accessible violations
    const accessibleViolations = violationDetails.filter((v) =>
      hasServerAccess(authUser, v.serverId)
    );

    if (accessibleViolations.length === 0) {
      return { success: true, dismissed: 0 };
    }

    // Get unique rule IDs to fetch their actions
    const uniqueRuleIds = [...new Set(accessibleViolations.map((v) => v.ruleId))];
    const ruleRows = await db
      .select({ id: automations.id, actions: automations.actions })
      .from(automations)
      .where(inArray(automations.id, uniqueRuleIds));

    // Build map of ruleId -> trust adjustment amount
    const ruleAdjustments = new Map<string, number>();
    for (const rule of ruleRows) {
      let adjustment = 0;
      const ruleActions = rule.actions?.actions;
      if (ruleActions && Array.isArray(ruleActions)) {
        for (const action of ruleActions) {
          adjustment += trustAdjustment(action) ?? 0;
        }
      }
      ruleAdjustments.set(rule.id, adjustment);
    }

    const accessibleIds = accessibleViolations.map((v) => v.id);

    // Dismiss violations and reverse trust scores atomically. Soft delete:
    // the rows stay so session and inactivity dedup keep blocking re-creation.
    // Reversals derive from the rows THIS request stamped, so a concurrent
    // dismiss racing the same ids cannot reverse trust twice.
    const { dismissedCount, moves } = await db.transaction(async (tx) => {
      const stamped = await tx
        .update(automationRuns)
        .set({ dismissedAt: new Date() })
        .where(and(inArray(automationRuns.id, accessibleIds), isNull(automationRuns.dismissedAt)))
        .returning({ id: automationRuns.id });
      const stampedIds = new Set(stamped.map((row) => row.id));
      const stampedViolations = accessibleViolations.filter((v) => stampedIds.has(v.id));

      // Reverse trust scores for each affected user
      const trustReverseByUser = new Map<string, number>();
      for (const v of stampedViolations) {
        const adjustment = ruleAdjustments.get(v.ruleId) ?? 0;
        if (adjustment !== 0) {
          trustReverseByUser.set(
            v.serverUserId,
            (trustReverseByUser.get(v.serverUserId) ?? 0) + adjustment
          );
        }
      }
      const moved: TrustMove[] = [];
      for (const [serverUserId, totalAdjustment] of trustReverseByUser) {
        // Reverse by applying the opposite adjustment
        moved.push(
          ...(await moveTrust(
            tx,
            sql`LEAST(100, GREATEST(0, ${serverUsers.trustScore} - ${totalAdjustment}))`,
            eq(serverUsers.id, serverUserId)
          ))
        );
      }

      // users.totalViolations counts non-dismissed rows, so every affected
      // identity recomputes, not only the trust-reversed ones. Once per
      // identity, since a merged person can have several accounts here.
      const affectedIdentityIds = new Set(stampedViolations.map((v) => v.userId));
      for (const identityId of affectedIdentityIds) {
        await recomputeIdentityAggregates(identityId, tx);
      }

      return { dismissedCount: stamped.length, moves: moved };
    });

    await dispatchTrustMoves(moves, DISMISSED_TRUST_REASON);

    return { success: true, dismissed: dismissedCount };
  });
};
