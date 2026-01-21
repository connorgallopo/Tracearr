/**
 * Library Route Utilities
 *
 * Shared helpers for library statistics routes including server filtering
 * and cache key generation.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { AuthUser } from '@tracearr/shared';

/**
 * Build SQL fragment for filtering by accessible servers.
 * Non-owner users can only see stats for servers they have access to.
 *
 * @param serverId - Optional specific server to filter by
 * @param authUser - Authenticated user making the request
 * @param tableAlias - Optional table alias (e.g., 'li' for library_items)
 * @returns SQL fragment for WHERE clause
 */
export function buildLibraryServerFilter(
  serverId: string | undefined,
  authUser: AuthUser,
  tableAlias?: string
): SQL {
  const column = tableAlias ? sql.raw(`${tableAlias}.server_id`) : sql.raw('server_id');

  if (serverId) {
    return sql`AND ${column} = ${serverId}`;
  }
  if (authUser.role !== 'owner') {
    if (authUser.serverIds.length === 0) {
      return sql`AND false`;
    } else if (authUser.serverIds.length === 1) {
      return sql`AND ${column} = ${authUser.serverIds[0]}`;
    } else {
      const serverIdList = authUser.serverIds.map((id: string) => sql`${id}`);
      return sql`AND ${column} IN (${sql.join(serverIdList, sql`, `)})`;
    }
  }
  return sql``;
}

/**
 * Generate cache key with all varying parameters to prevent cache collisions.
 *
 * @param prefix - Cache key prefix (e.g., REDIS_KEYS.LIBRARY_STATS)
 * @param serverId - Optional server filter
 * @param period - Optional period filter (for growth endpoint)
 * @param timezone - Optional timezone
 * @returns Cache key string
 */
export function buildLibraryCacheKey(
  prefix: string,
  serverId?: string,
  period?: string,
  timezone?: string
): string {
  const parts = [prefix];
  if (serverId) parts.push(serverId);
  if (period) parts.push(period);
  if (timezone) parts.push(timezone);
  return parts.join(':');
}
