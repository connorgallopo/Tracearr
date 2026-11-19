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
  conditions.push(...startedAtRange(input.startDate, input.endDate));
  return conditions;
}

/** A half-open started_at filter window over s, as separate conditions. */
export function startedAtRange(startDate: Date | undefined, endDate: Date | undefined): SQL[] {
  const range: SQL[] = [];
  if (startDate) range.push(sql`s.started_at >= ${startDate}`);
  if (endDate) range.push(sql`s.started_at < ${endDate}`);
  return range;
}

/**
 * Plays by any of the profiles over the given alias. The profiles' accounts are matched as well,
 * so the read keeps to the account indexes and compressed segments.
 */
export function profileFilterSql(profileIds: string[], alias = 's'): SQL {
  const a = sql.raw(alias);
  const ids = sql`${sql.param(profileIds)}::uuid[]`;
  return sql`(${a}.profile_id = ANY(${ids}) AND ${a}.server_user_id IN (SELECT server_user_id FROM server_profiles WHERE id = ANY(${ids})))`;
}
