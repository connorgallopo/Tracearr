/**
 * Server filtering utilities for multi-server access control
 *
 * These utilities help enforce server-level access control across API routes.
 * Users can only see data from servers they have access to (listed in serverIds).
 * Owners bypass server filtering and see all servers.
 */

import { sql, inArray, eq, type SQL, type Column } from 'drizzle-orm';
import type { AuthUser } from '@tracearr/shared';
import { ForbiddenError } from './errors.js';

/**
 * Build a SQL condition for filtering by server access.
 *
 * @param authUser - The authenticated user with serverIds array
 * @param serverIdColumn - The column to filter on (e.g., sessions.serverId)
 * @returns SQL condition or undefined (owners see all)
 *
 * @example
 * ```ts
 * const serverCondition = buildServerAccessCondition(authUser, sessions.serverId);
 * if (serverCondition) {
 *   conditions.push(serverCondition);
 * }
 * ```
 */
export function buildServerAccessCondition(
  authUser: AuthUser,
  serverIdColumn: Column
): SQL | undefined {
  // Owners see all servers
  if (authUser.role === 'owner') {
    return undefined;
  }

  // No server access - return impossible condition
  if (authUser.serverIds.length === 0) {
    return sql`false`;
  }

  // Single server - use equality for simpler query plan
  if (authUser.serverIds.length === 1) {
    return eq(serverIdColumn, authUser.serverIds[0]);
  }

  // Multiple servers - use IN clause
  return inArray(serverIdColumn, authUser.serverIds);
}

/**
 * Filter an array of items by server access.
 * Use this for post-query filtering when the query can't be easily modified.
 *
 * @param items - Array of items with serverId property
 * @param authUser - The authenticated user
 * @returns Filtered array containing only accessible items
 *
 * @example
 * ```ts
 * const allSessions = await cache.getAllActiveSessions();
 * const userSessions = filterByServerAccess(allSessions, authUser);
 * ```
 */
export function filterByServerAccess<T extends { serverId: string }>(
  items: T[],
  authUser: AuthUser
): T[] {
  // Owners see all
  if (authUser.role === 'owner') {
    return items;
  }

  // Filter by accessible servers
  return items.filter((item) => authUser.serverIds.includes(item.serverId));
}

/**
 * Check if user has access to a specific server.
 *
 * @param authUser - The authenticated user
 * @param serverId - The server ID to check
 * @returns true if user has access
 */
export function hasServerAccess(authUser: AuthUser, serverId: string): boolean {
  return authUser.role === 'owner' || authUser.serverIds.includes(serverId);
}

/**
 * Validate server access and return error message if denied.
 * Convenience function for route handlers.
 *
 * @param authUser - The authenticated user
 * @param serverId - The server ID to validate
 * @returns Error message or null if access granted
 *
 * @example
 * ```ts
 * const error = validateServerAccess(authUser, serverId);
 * if (error) {
 *   return reply.forbidden(error);
 * }
 * ```
 */
export function validateServerAccess(authUser: AuthUser, serverId: string): string | null {
  if (hasServerAccess(authUser, serverId)) {
    return null;
  }
  return 'You do not have access to this server';
}

/**
 * Resolve the effective server IDs from query params, intersected with user access.
 *
 * Returns:
 * - undefined: owner with no filter (all servers, skip WHERE clause)
 * - string[]: specific servers to filter by (may be empty if no access)
 *
 * By default (strict) this is the single enforcement point for explicit server access:
 * a non-owner explicitly requesting a single serverId they cannot access gets a
 * ForbiddenError (403), so routes no longer need their own validateServerAccess guard.
 * A serverIds[] array (multi-server fan-out) is always silently intersected, never rejected.
 *
 * Pass `{ strict: false }` for endpoints that intentionally return empty results instead
 * of 403 for an inaccessible serverId (e.g. dashboard/locations/sessions/violations, which
 * behaved that way before multi-server support).
 */
export function resolveServerIds(
  authUser: AuthUser,
  serverId: string | undefined,
  serverIds: string[] | undefined,
  { strict = true }: { strict?: boolean } = {}
): string[] | undefined {
  if (strict && serverId && !hasServerAccess(authUser, serverId)) {
    throw new ForbiddenError('You do not have access to this server');
  }

  // serverIds takes precedence over serverId
  const requested = serverIds ?? (serverId ? [serverId] : undefined);

  if (authUser.role === 'owner') {
    return requested ?? undefined;
  }

  // Non-owners: intersect with accessible servers
  if (!requested) {
    return authUser.serverIds;
  }
  return requested.filter((id) => authUser.serverIds.includes(id));
}

/**
 * Build a SQL condition for multi-server filtering.
 * Returns undefined when no filtering needed (owner, all servers).
 */
export function buildMultiServerCondition(
  resolvedIds: string[] | undefined,
  serverIdColumn: Column
): SQL | undefined {
  if (resolvedIds === undefined) return undefined;
  if (resolvedIds.length === 0) return sql`false`;
  if (resolvedIds.length === 1) return eq(serverIdColumn, resolvedIds[0]);
  return inArray(serverIdColumn, resolvedIds);
}

/**
 * Raw SQL fragment version of multi-server filtering for template literal queries.
 */
export function buildMultiServerFragment(
  resolvedIds: string[] | undefined,
  columnRef = 'server_id'
): SQL {
  const col = sql.raw(columnRef);
  if (resolvedIds === undefined) return sql``;
  if (resolvedIds.length === 0) return sql`AND false`;
  if (resolvedIds.length === 1) return sql`AND ${col} = ${resolvedIds[0]}`;
  const ids = resolvedIds.map((id) => sql`${id}`);
  return sql`AND ${col} IN (${sql.join(ids, sql`, `)})`;
}
