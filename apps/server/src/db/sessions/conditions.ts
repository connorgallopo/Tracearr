import { sql, type SQL } from 'drizzle-orm';
import type { AuthUser } from '@tracearr/shared';
import { scopeSessionsRaw, type Scope } from '../../lib/scope.js';
import { resolveServerIds, serverIdCondition } from '../../utils/serverFiltering.js';

/**
 * The server, scope and date conditions every sessions read over s starts from. Null when the
 * caller can reach no server.
 */
export function baseSessionConditions(input: {
  authUser: AuthUser;
  serverId?: string;
  serverIds?: string[];
  scope: Scope;
  startDate?: Date;
  endDate?: Date;
}): SQL[] | null {
  const resolvedIds = resolveServerIds(input.authUser, input.serverId, input.serverIds, {
    strict: false,
  });
  if (resolvedIds?.length === 0) return null;

  const conditions: SQL[] = [];
  const servers = serverIdCondition(resolvedIds, 's.server_id');
  if (servers) conditions.push(servers);
  const scoped = scopeSessionsRaw(input.scope, sql`s.server_user_id`);
  if (scoped) conditions.push(scoped);
  if (input.startDate) conditions.push(sql`s.started_at >= ${input.startDate}`);
  if (input.endDate) conditions.push(sql`s.started_at < ${input.endDate}`);
  return conditions;
}
