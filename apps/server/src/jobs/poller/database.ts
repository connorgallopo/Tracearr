/**
 * Poller Database Operations
 *
 * Database query functions used by the poller.
 * Includes batch loading for performance optimization and rule fetching.
 */

import { eq, and, desc, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  TIME_MS,
  SESSION_LIMITS,
  WS_EVENTS,
  type Session,
  type EngineAutomation,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import {
  sessions,
  automations,
  servers,
  serverUserExternalAliases,
  serverUsers,
  terminationLogs,
  libraryItems,
  media,
} from '../../db/schema.js';
import { automationsLogger, createLogger } from '../../utils/logger.js';
import { getPubSubService } from '../../services/cache.js';
import { mapSessionRow } from './sessionMapper.js';

/** Canonical media identity for a library item, stamped onto sessions at insert. */
export interface SessionIdentity {
  mediaId: string | null;
  showMediaId: string | null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  parentRatingKey: string | null;
  grandparentRatingKey: string | null;
}

/**
 * Batch load canonical media identity for a set of rating keys on one server
 * (eliminates a per-session lookup in the polling loop).
 *
 * @param serverId - Server the rating keys belong to
 * @param ratingKeys - Rating keys to resolve identity for
 * @returns Map of ratingKey -> SessionIdentity
 */
export async function batchGetLibraryItemIdentity(
  serverId: string,
  ratingKeys: string[]
): Promise<Map<string, SessionIdentity>> {
  const result = new Map<string, SessionIdentity>();
  if (ratingKeys.length === 0) return result;

  const rows = await db
    .select({
      ratingKey: libraryItems.ratingKey,
      mediaId: libraryItems.mediaId,
      imdbId: libraryItems.imdbId,
      tmdbId: libraryItems.tmdbId,
      tvdbId: libraryItems.tvdbId,
      parentRatingKey: libraryItems.parentRatingKey,
      grandparentRatingKey: libraryItems.grandparentRatingKey,
      showMediaId: media.showMediaId,
      itemMediaType: libraryItems.mediaType,
    })
    .from(libraryItems)
    .leftJoin(media, eq(media.id, libraryItems.mediaId))
    .where(and(eq(libraryItems.serverId, serverId), inArray(libraryItems.ratingKey, ratingKeys)));

  for (const r of rows) {
    result.set(r.ratingKey, {
      mediaId: r.mediaId,
      showMediaId: r.itemMediaType === 'episode' ? r.showMediaId : null,
      imdbId: r.imdbId,
      tmdbId: r.tmdbId,
      tvdbId: r.tvdbId,
      parentRatingKey: r.parentRatingKey,
      grandparentRatingKey: r.grandparentRatingKey,
    });
  }

  return result;
}

// ============================================================================
// Session Batch Loading
// ============================================================================

// Fetch-window ceiling: 7 days keeps the query inside the uncompressed
// chunks of the sessions hypertable and matches the builder's largest window.
const MAX_AUTOMATION_WINDOW_HOURS = 168;

/**
 * Largest window_hours any of the given rules asks for, floored at 24 so
 * evaluators without windows keep their day of context, capped at
 * MAX_AUTOMATION_WINDOW_HOURS.
 */
export function maxWindowHoursFromAutomations(rulesList: EngineAutomation[]): number {
  let max = 24;
  for (const rule of rulesList) {
    for (const group of rule.conditions?.groups ?? []) {
      for (const condition of group.conditions) {
        const windowHours = condition.params?.window_hours;
        if (typeof windowHours === 'number' && windowHours > max) max = windowHours;
      }
    }
  }
  return Math.min(max, MAX_AUTOMATION_WINDOW_HOURS);
}

/** History window implied by the cached active automations; 24h until the cache fills. */
export function defaultRecentSessionWindowHours(): number {
  return automationsCache ? maxWindowHoursFromAutomations(automationsCache.data) : 24;
}

/**
 * Batch load recent sessions for multiple server users (eliminates N+1 in polling loop)
 *
 * This function fetches sessions for a batch of server users in a single
 * query, avoiding the performance penalty of querying per-user.
 *
 * @param serverUserIds - Array of server user IDs to load sessions for
 * @param hours - Number of hours to look back; defaults to the largest
 *   window_hours any active rule uses (at least 24)
 * @returns Map of serverUserId -> Session[] for each server user
 *
 * @example
 * const sessionMap = await batchGetRecentUserSessions(['su-1', 'su-2', 'su-3']);
 * const user1Sessions = sessionMap.get('su-1') ?? [];
 */
export async function batchGetRecentUserSessions(
  serverUserIds: string[],
  hours?: number
): Promise<Map<string, Session[]>> {
  if (serverUserIds.length === 0) return new Map();

  const windowHours = hours ?? defaultRecentSessionWindowHours();
  const since = new Date(Date.now() - windowHours * TIME_MS.HOUR);
  // The per-user cap scales with the window so a longer window doesn't
  // silently truncate at one day's worth of rows
  const perUserCap = Math.ceil(windowHours / 24) * SESSION_LIMITS.MAX_RECENT_PER_USER;
  const result = new Map<string, Session[]>();

  // Initialize empty arrays for all server users
  for (const serverUserId of serverUserIds) {
    result.set(serverUserId, []);
  }

  // Single query to get recent sessions for all server users using inArray.
  // The LIMIT bounds the transfer; per-user fairness comes from the JS cap
  // below (newest-first ordering means a capped-out user loses old rows).
  const recentSessions = await db
    .select()
    .from(sessions)
    .where(and(inArray(sessions.serverUserId, serverUserIds), gte(sessions.startedAt, since)))
    .orderBy(desc(sessions.startedAt))
    .limit(serverUserIds.length * perUserCap);

  // Group by server user (limit per user to prevent memory issues)
  for (const s of recentSessions) {
    const userSessions = result.get(s.serverUserId) ?? [];
    if (userSessions.length < perUserCap) {
      userSessions.push(mapSessionRow(s));
    }
    result.set(s.serverUserId, userSessions);
  }

  return result;
}

/**
 * Merge recent-session lists for a set of server_user ids belonging to one
 * identity into a single deduplicated list (by session id), so windowed rule
 * evaluators (unique_ips_in_window, unique_devices_in_window, travel_speed_kmh)
 * see the identity's cross-server activity exactly once, never twice because
 * a session surfaced under more than one of the given ids.
 *
 * @param recentSessionsMap - Map of serverUserId -> Session[] (as returned by batchGetRecentUserSessions)
 * @param identityServerUserIds - server_user ids belonging to one identity
 * @returns Combined, deduplicated Session[] across all the given ids
 */
export function mergeRecentSessionsForIdentity(
  recentSessionsMap: Map<string, Session[]>,
  identityServerUserIds: string[]
): Session[] {
  const seen = new Set<string>();
  const combined: Session[] = [];
  for (const id of identityServerUserIds) {
    for (const s of recentSessionsMap.get(id) ?? []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      combined.push(s);
    }
  }
  return combined;
}

/**
 * Widen recentSessionsMap in place so every server_user id belonging to a
 * merged identity (an identityServerUserIdsMap entry with more than one id)
 * maps to the combined, deduplicated recent-session list of ALL of that
 * identity's server_user ids. Ids not present in identityServerUserIdsMap,
 * and ids whose identity has only one server_user, are left untouched - this
 * is what keeps sibling data from leaking into an unrelated server_user on
 * the same server.
 *
 * Only issues one supplemental query per poll tick (for whichever sibling ids
 * aren't already in recentSessionsMap), regardless of how many identities are
 * merged, so the poller hot path stays batched.
 *
 * @param recentSessionsMap - Map of serverUserId -> Session[], mutated in place
 * @param identityServerUserIdsMap - Map of identity userId -> that identity's server_user ids
 */
export async function widenRecentSessionsForMergedIdentities(
  recentSessionsMap: Map<string, Session[]>,
  identityServerUserIdsMap: Map<string, string[]>,
  hours?: number
): Promise<void> {
  const siblingIdsNeeded = new Set<string>();
  for (const ids of identityServerUserIdsMap.values()) {
    if (ids.length <= 1) continue;
    for (const id of ids) {
      if (!recentSessionsMap.has(id)) siblingIdsNeeded.add(id);
    }
  }

  if (siblingIdsNeeded.size > 0) {
    const supplemental = await batchGetRecentUserSessions([...siblingIdsNeeded], hours);
    for (const [id, sessionsForId] of supplemental) {
      recentSessionsMap.set(id, sessionsForId);
    }
  }

  for (const ids of identityServerUserIdsMap.values()) {
    if (ids.length <= 1) continue;
    const combined = mergeRecentSessionsForIdentity(recentSessionsMap, ids);
    for (const id of ids) {
      recentSessionsMap.set(id, combined);
    }
  }
}

/**
 * Batch load the sibling server_user ids for a set of identities in a single
 * query (eliminates a per-session/per-poll-tick lookup for cross-server rule
 * aggregation on merged identities).
 *
 * @param userIds - Array of identity (users.id) values to resolve
 * @returns Map of userId -> server_user ids belonging to that identity
 *
 * @example
 * const identityMap = await batchGetIdentityServerUserIds(['u-1', 'u-2']);
 * const idsForUser1 = identityMap.get('u-1') ?? [];
 */
export async function batchGetIdentityServerUserIds(
  userIds: string[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (userIds.length === 0) return result;

  const uniqueUserIds = [...new Set(userIds)];
  for (const userId of uniqueUserIds) {
    result.set(userId, []);
  }

  const rows = await db
    .select({ id: serverUsers.id, userId: serverUsers.userId })
    .from(serverUsers)
    .where(inArray(serverUsers.userId, uniqueUserIds));

  for (const row of rows) {
    const ids = result.get(row.userId) ?? [];
    ids.push(row.id);
    result.set(row.userId, ids);
  }

  return result;
}

/**
 * Resolve the local server_user id for an external account id on a server.
 * Returns null when no matching server user exists.
 *
 * Used to verify that an active session row belongs to the user of an incoming
 * event before reusing it: Plex resets sessionKey counters on PMS restart, so a
 * stale open row can carry the same sessionKey a different user's new play now
 * uses.
 */
export async function getServerUserIdByExternalId(
  serverId: string,
  externalId: string
): Promise<string | null> {
  const rows = await db
    .select({ id: serverUsers.id })
    .from(serverUsers)
    .where(and(eq(serverUsers.serverId, serverId), eq(serverUsers.externalId, externalId)))
    .limit(1);

  if (rows[0]) return rows[0].id;

  // A folded external id still belongs to the surviving account, so the
  // caller's foreign-row check must not treat its events as a stranger's.
  const aliased = await db
    .select({ id: serverUserExternalAliases.serverUserId })
    .from(serverUserExternalAliases)
    .where(
      and(
        eq(serverUserExternalAliases.serverId, serverId),
        eq(serverUserExternalAliases.externalId, externalId)
      )
    )
    .limit(1);

  return aliased[0]?.id ?? null;
}

/**
 * Sessions already terminated (successfully) under a given violation.
 *
 * A multi-target kill_stream match fans out one job per target, all sharing the
 * violation id. As each sibling job terminates its target, that session leaves
 * the active-session cache. Re-verification of the still-pending siblings needs
 * those already-killed sessions back in the count context: a session stopped BY
 * THIS violation is action reach, not the condition clearing, so it must keep
 * counting for its siblings instead of dropping the concurrent total below the
 * threshold. Returns the mapped session rows so callers can fold them back into
 * the evaluation context. Empty when the violation is null or nothing under it
 * has been terminated yet.
 */
export async function getSessionsTerminatedByViolation(violationId: string): Promise<Session[]> {
  const logRows = await db
    .select({ sessionId: terminationLogs.sessionId })
    .from(terminationLogs)
    .where(and(eq(terminationLogs.violationId, violationId), eq(terminationLogs.success, true)));

  const ids = [...new Set(logRows.map((r) => r.sessionId))];
  if (ids.length === 0) return [];

  const sessionRows = await db.select().from(sessions).where(inArray(sessions.id, ids));
  return sessionRows.map(mapSessionRow);
}

// ============================================================================
// Automation Loading
// ============================================================================

// TTL fallback for multi-instance deployments: another instance's invalidation isn't visible here, so an automation change can take up to this long to apply.
const AUTOMATIONS_CACHE_TTL_MS = 10_000;

let automationsCache: { data: EngineAutomation[]; expiresAt: number } | null = null;

/** Invalidate the active automations cache. Call from every automation create/update/delete/toggle path. */
export function invalidateAutomationsCache(): void {
  automationsCache = null;
}

type AutomationsRefillListener = (rules: EngineAutomation[]) => void;
const refillListeners: AutomationsRefillListener[] = [];

/** Called after every automations-cache fill on this instance; listeners must not throw. */
export function onActiveAutomationsRefill(listener: AutomationsRefillListener): void {
  refillListeners.push(listener);
}

// Same TTL story as the automations cache: a server change on another instance can
// take up to this long to reach this instance's poll loop.
const SERVERS_CACHE_TTL_MS = 10_000;

let serversCache: { data: (typeof servers.$inferSelect)[]; expiresAt: number } | null = null;

// The servers cache is the poller's, not the engine's.
const serversLogger = createLogger('servers');

/** Invalidate the servers cache. Call from every server create/update/delete path. */
export function invalidateServersCache(): void {
  serversCache = null;
}

/** Drop this instance's servers cache and tell the others to do the same. */
export async function publishServersChanged(): Promise<void> {
  invalidateServersCache();
  await getPubSubService()
    ?.publish(WS_EVENTS.SERVERS_CHANGED, {})
    .catch((error: unknown) => {
      serversLogger.warn(
        'servers:changed publish failed; other instances fall back to the cache TTL',
        {
          error,
        }
      );
    });
}

/**
 * All servers, cached briefly: the poll tick and the reconciliation poll each
 * read the full list several times a minute and the list almost never changes.
 */
export async function getCachedServers(): Promise<(typeof servers.$inferSelect)[]> {
  const now = Date.now();
  if (serversCache && serversCache.expiresAt > now) {
    return serversCache.data;
  }

  const rows = await db.select().from(servers);
  serversCache = { data: rows, expiresAt: now + SERVERS_CACHE_TTL_MS };
  return rows;
}

// A row the boot migration never stamped matches no trigger, so warn once per id rather than per tick.
const warnedUntriggeredAutomationIds = new Set<string>();

/**
 * Map an `automations` row to the shared EngineAutomation shape. Shared by
 * getActiveAutomations and the kill-queue reverify path so both build an
 * identical EngineAutomation from the same row.
 */
export function mapAutomationRow(
  r: typeof automations.$inferSelect,
  currentVersionId: string | null
): EngineAutomation {
  if (!r.triggers && !warnedUntriggeredAutomationIds.has(r.id)) {
    warnedUntriggeredAutomationIds.add(r.id);
    automationsLogger.warn('Automation has no stored triggers and will never evaluate', {
      automationId: r.id,
      name: r.name,
    });
  }
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    serverId: r.serverId,
    serverUserId: r.serverUserId,
    userId: r.userId,
    enforceAcrossServers: r.enforceAcrossServers,
    isActive: r.isActive,
    severity: r.severity,
    kind: r.kind,
    // Both columns are nullable jsonb; a row that never held either reads as empty.
    conditions: r.conditions ?? { groups: [] },
    actions: r.actions ?? { actions: [] },
    triggers: r.triggers ?? [],
    currentVersionId,
    cooldownMinutes: r.cooldownMinutes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * The version a run records. One index lookup per rule on a 10s cache fill.
 * The outer column is named in full: a table selection renders its columns
 * unqualified, and a bare `id` here would bind to the subquery's own table.
 */
const CURRENT_VERSION_ID = sql<string | null>`(
  SELECT v.id FROM automation_versions v
  WHERE v.automation_id = automations.id
  ORDER BY v.version DESC
  LIMIT 1
)`;

/**
 * Active automations with conditions defined, evaluated by the session
 * lifecycle event system. Cached in-process for AUTOMATIONS_CACHE_TTL_MS.
 */
export async function getActiveAutomations(): Promise<EngineAutomation[]> {
  const now = Date.now();
  if (automationsCache && automationsCache.expiresAt > now) {
    return automationsCache.data;
  }

  // Ordered so every evaluation takes its per-run advisory locks in the same
  // sequence; two dispatches for one subject cannot then deadlock each other.
  const activeRules = await db
    .select({ automation: automations, currentVersionId: CURRENT_VERSION_ID })
    .from(automations)
    .where(and(eq(automations.isActive, true), isNotNull(automations.conditions)))
    .orderBy(automations.id);

  const mapped = activeRules.map((row) => mapAutomationRow(row.automation, row.currentVersionId));

  automationsCache = { data: mapped, expiresAt: now + AUTOMATIONS_CACHE_TTL_MS };
  for (const listener of refillListeners) listener(mapped);
  return mapped;
}
