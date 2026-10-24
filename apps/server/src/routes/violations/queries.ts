import { eq, and, count, gte, lte, isNull, sql, inArray, type SQL } from 'drizzle-orm';
import {
  TIME_MS,
  type ViolationSessionInfo,
  type ViolationSortField,
  type ViolationWithDetails,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import {
  automationRuns,
  automations,
  serverUsers,
  sessions,
  servers,
  users,
  ruleActionResults,
} from '../../db/schema.js';
import { isLocalSession } from '../../db/sessions/rules.js';
import { MAX_AUTOMATION_WINDOW_HOURS } from '../../jobs/poller/database.js';
import { scopeSessions, type Scope } from '../../lib/scope.js';
import { runSession, violationAliasConditions } from '../../services/automations/aliasFilter.js';
import { buildOrderBy, type SortDirection, type SortKey } from '../../utils/listQuery.js';

/**
 * Sort keys, every branch tiebroken on automationRuns.id by buildOrderBy. Without a
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
  user: { key: sql`lower(coalesce(${users.name}, ${serverUsers.username}))`, defaultDir: 'desc' },
  rule: { key: sql`lower(${automations.name})`, defaultDir: 'desc' },
};

/** The run column is nullable; every row this route serves has one, and the wire shape requires it. */
const ROSTER_SEVERITY = sql<
  'low' | 'warning' | 'high'
>`coalesce(${automationRuns.severity}, 'warning')`;

/**
 * The by-id guard the roster's filters cannot supply: same alias, same dismissed
 * exclusion, so a run this surface does not serve 404s instead of being acted on.
 */
export function aliasedRunFilter(match: SQL) {
  return and(
    match,
    isNull(automationRuns.dismissedAt),
    ...violationAliasConditions({ requireUser: true })
  );
}

function fetchRelatedSessions(ids: string[], scope: Scope, window?: { from: Date; to: Date }) {
  return db
    .select({
      id: sessions.id,
      mediaTitle: sessions.mediaTitle,
      mediaType: sessions.mediaType,
      grandparentTitle: sessions.grandparentTitle,
      mediaId: sessions.mediaId,
      showMediaId: sessions.showMediaId,
      seasonNumber: sessions.seasonNumber,
      episodeNumber: sessions.episodeNumber,
      year: sessions.year,
      ipAddress: sessions.ipAddress,
      geoCity: sessions.geoCity,
      geoRegion: sessions.geoRegion,
      geoCountry: sessions.geoCountry,
      isLocal: sessions.isLocal,
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
    .where(
      and(
        inArray(sessions.id, ids),
        scopeSessions(scope),
        window ? gte(sessions.startedAt, window.from) : undefined,
        window ? lte(sessions.startedAt, window.to) : undefined
      )
    );
}

/**
 * Enrich flat violation rows with related sessions, user history, and action results.
 * Works for both single-item and multi-item arrays.
 */
export async function enrichViolations(violationData: ViolationRow[], scope: Scope) {
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
      // A related session existed when its run was evaluated, inside the rule's history
      // window, so that range is searched first and chunks outside it are never opened.
      // Ids it misses (a live stream running for over a week) take the unbounded lookup.
      const createdTimes = violationData.map((v) => v.createdAt.getTime());
      const window = {
        from: new Date(
          Math.min(...createdTimes) - (MAX_AUTOMATION_WINDOW_HOURS + 24) * TIME_MS.HOUR
        ),
        to: new Date(Math.max(...createdTimes)),
      };
      const found = await fetchRelatedSessions([...allRelatedSessionIds], scope, window);
      const missing = [...allRelatedSessionIds].filter((id) => !found.some((s) => s.id === id));
      const fallback = missing.length > 0 ? await fetchRelatedSessions(missing, scope) : [];

      for (const s of [...found, ...fallback]) {
        sessionsById.set(s.id, { ...s, deviceId: s.deviceId ?? null, isLocal: isLocalSession(s) });
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
        mediaId: v.mediaId,
        showMediaId: v.showMediaId,
        seasonNumber: v.seasonNumber,
        episodeNumber: v.episodeNumber,
        year: v.year,
        ipAddress: v.ipAddress,
        geoCity: v.geoCity,
        geoRegion: v.geoRegion,
        geoCountry: v.geoCountry,
        isLocal: isLocalSession(v),
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

// Counted off the same conditions, minus the joins only the select list
// needs. A hand-written copy of these predicates is what let the count
// disagree with the page it was counting.
export async function countViolations(where: SQL | undefined): Promise<number> {
  const countRows = await db
    .select({ total: count() })
    .from(automationRuns)
    .innerJoin(serverUsers, eq(automationRuns.serverUserId, serverUsers.id))
    .where(where);
  return countRows[0]?.total ?? 0;
}

/**
 * The select list shared by the page query and the detail read. `runSessionRow` is the
 * lateral from runSession(), which the caller joins.
 */
export function violationSelect(runSessionRow: ReturnType<typeof runSession>) {
  return {
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
    mediaTitle: runSessionRow.mediaTitle,
    mediaType: runSessionRow.mediaType,
    grandparentTitle: runSessionRow.grandparentTitle,
    mediaId: runSessionRow.mediaId,
    showMediaId: runSessionRow.showMediaId,
    seasonNumber: runSessionRow.seasonNumber,
    episodeNumber: runSessionRow.episodeNumber,
    year: runSessionRow.year,
    ipAddress: runSessionRow.ipAddress,
    geoCity: runSessionRow.geoCity,
    geoRegion: runSessionRow.geoRegion,
    geoCountry: runSessionRow.geoCountry,
    isLocal: runSessionRow.isLocal,
    geoContinent: runSessionRow.geoContinent,
    geoPostal: runSessionRow.geoPostal,
    geoLat: runSessionRow.geoLat,
    geoLon: runSessionRow.geoLon,
    playerName: runSessionRow.playerName,
    device: runSessionRow.device,
    deviceId: runSessionRow.deviceId,
    platform: runSessionRow.platform,
    product: runSessionRow.product,
    quality: runSessionRow.quality,
    startedAt: runSessionRow.startedAt,
    severity: ROSTER_SEVERITY,
    data: automationRuns.data,
    createdAt: automationRuns.createdAt,
    acknowledgedAt: automationRuns.acknowledgedAt,
  };
}

/**
 * The page query. `where` comes from buildViolationRosterConditions, and the
 * count query reuses it unchanged.
 */
export function buildViolationPageQuery(params: {
  where: SQL | undefined;
  orderBy: ViolationSortField;
  orderDir: SortDirection | undefined;
  pageSize: number;
  offset: number;
}) {
  const { where, orderBy, orderDir, pageSize, offset } = params;
  const runSessionRow = runSession();

  return db
    .select(violationSelect(runSessionRow))
    .from(automationRuns)
    .innerJoin(automations, eq(automationRuns.automationId, automations.id))
    .innerJoin(serverUsers, eq(automationRuns.serverUserId, serverUsers.id))
    .leftJoin(users, eq(serverUsers.userId, users.id))
    .innerJoin(servers, eq(serverUsers.serverId, servers.id))
    .leftJoinLateral(runSessionRow, sql`true`)
    .where(where)
    .orderBy(buildOrderBy(VIOLATION_SORT_KEYS, orderBy, orderDir, sql`${automationRuns.id}`))
    .limit(pageSize)
    .offset(offset);
}

/** The flat row the violation select returns; the input to enrichViolations(). */
export type ViolationRow = Awaited<ReturnType<typeof buildViolationPageQuery>>[number];

/** The list row shape, derived so the envelope cannot drift from the mapper. */
export type EnrichedViolation = Awaited<ReturnType<typeof enrichViolations>>[number];
