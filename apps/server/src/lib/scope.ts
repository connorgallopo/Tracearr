/**
 * Row scope and role permissions. Owner and admin see every row; a member sees the rows of
 * their own non-removed server accounts, on every server they have one, whether or not that
 * server allows member login, and on each server only the libraries that account can open.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, inArray, isNull, sql, type Column, type SQL } from 'drizzle-orm';
import {
  REDIS_KEYS,
  getRedisPrefix,
  isStaff,
  selfQuerySchema,
  type UserRole,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { serverUsers, sessions } from '../db/schema.js';
import { getCacheService } from '../services/cache.js';
import { getSetting } from '../services/settings.js';
import { ValidationError } from '../utils/errors.js';
import { buildMultiServerFragment } from '../utils/serverFiltering.js';
import { roles, type Action, type Resource } from './access.js';
import { getRedis } from './redisShared.js';

export type Scope =
  | 'all'
  | {
      userId: string;
      serverUserIds: string[];
      serverIds: string[];
      /** Library ids per server, for the servers where the account can't open every library */
      libraryIds?: Record<string, string[]>;
    };

// One window for every cached access fact: the server list in sessionResolver and the scope here.
export const ACCESS_CACHE_TTL_MS = 30_000;

/** The person's non-removed server accounts, whatever their role. */
export function ownServerUsers(
  userId: string
): Promise<{ id: string; serverId: string; libraryIds: string[] | null }[]> {
  return db
    .select({
      id: serverUsers.id,
      serverId: serverUsers.serverId,
      libraryIds: serverUsers.libraryIds,
    })
    .from(serverUsers)
    .where(and(eq(serverUsers.userId, userId), isNull(serverUsers.removedAt)));
}

function scopeOf(
  userId: string,
  rows: { id: string; serverId: string; libraryIds: string[] | null }[]
): Exclude<Scope, 'all'> {
  // A merge can leave one person two accounts on a server; what either opens counts.
  const limits = new Map<string, string[] | null>();
  for (const { serverId, libraryIds } of rows) {
    const prev = limits.get(serverId);
    limits.set(
      serverId,
      prev === null || !libraryIds ? null : [...new Set([...(prev ?? []), ...libraryIds])].sort()
    );
  }
  return {
    userId,
    serverUserIds: rows.map((r) => r.id),
    serverIds: [...limits.keys()],
    libraryIds: Object.fromEntries(
      [...limits].filter((entry): entry is [string, string[]] => entry[1] !== null)
    ),
  };
}

/** The viewer's own accounts as a row scope, for every role. A member's is their scope. */
export async function ownScope(userId: string, scope: Scope): Promise<Exclude<Scope, 'all'>> {
  if (scope !== 'all') return scope;
  return scopeOf(userId, await ownServerUsers(userId));
}

/** request.scope, or the viewer's own accounts when the query asks for `self`. */
export async function viewScope(request: FastifyRequest): Promise<Scope> {
  const query = selfQuerySchema.safeParse(request.query);
  if (!query.success) throw ValidationError.fromZodError(query.error);
  return query.data.self ? ownScope(request.user.userId, request.scope) : request.scope;
}

export async function loadScope(userId: string, role: UserRole): Promise<Scope> {
  if (isStaff(role)) return 'all';
  const key = REDIS_KEYS.USER_SCOPE(userId);
  const cached = await getRedis().get(key);
  if (cached) return { ...(JSON.parse(cached) as Exclude<Scope, 'all'>), userId };
  const scope = scopeOf(userId, await ownServerUsers(userId));
  await getRedis().set(key, JSON.stringify(scope), 'PX', ACCESS_CACHE_TTL_MS);
  return scope;
}

// Every answer cached for one member carries memberCacheSegment, so the old scope's answers go
// with it. Filter options are cached per user for every role and go too.
export async function clearScope(userId: string): Promise<void> {
  await getRedis().del(REDIS_KEYS.USER_SCOPE(userId));
  const cache = getCacheService();
  if (!cache) return;
  await cache.invalidatePattern(`${getRedisPrefix()}tracearr:*:member:${userId}*`);
  await cache.invalidatePattern(REDIS_KEYS.FILTER_OPTIONS(userId, '*'));
}

/** Appended to a cache key whose value depends on the caller's row scope. */
export function memberCacheSegment(scope: Scope): string {
  return scope === 'all' ? '' : `:member:${scope.userId}`;
}

/**
 * Server filter for a row aliased `alias` that has server_id and library_id columns, narrowed
 * for a member to the libraries their account on each server can open.
 */
export function libraryFragment(serverIds: string[] | undefined, scope: Scope, alias: string): SQL {
  const servers = buildMultiServerFragment(serverIds, `${alias}.server_id`);
  if (scope === 'all' || !scope.libraryIds) return servers;
  const serverCol = sql.raw(`${alias}.server_id`);
  const libraryCol = sql.raw(`${alias}.library_id`);
  const limits = Object.entries(scope.libraryIds).map(([serverId, ids]) =>
    ids.length === 0
      ? sql` AND ${serverCol} <> ${serverId}::uuid`
      : sql` AND (${serverCol} <> ${serverId}::uuid OR ${libraryCol} IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `
        )}))`
  );
  return sql`${servers}${sql.join(limits)}`;
}

/** Appended to a cache key whose value depends on which libraries the caller can open. */
export function libraryCacheSegment(scope: Scope): string {
  if (scope === 'all' || !scope.libraryIds) return '';
  const limits = Object.entries(scope.libraryIds)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([serverId, ids]) => `${serverId}=${ids.join('+')}`);
  return limits.length === 0 ? '' : `:libs:${limits.join(',')}`;
}

/**
 * Whether the caller sees counts of other people's activity: others watching, title totals and
 * popularity sorts. Always for owner and admin; for a member only when the owner turns
 * memberServerActivity on, and then only as counts. Most Popular shelves are not gated by it.
 */
export async function seesServerActivity(scope: Scope): Promise<boolean> {
  return scope === 'all' || (await getSetting('memberServerActivity'));
}

export function scopeSessions(
  scope: Scope,
  column: Column = sessions.serverUserId
): SQL | undefined {
  if (scope === 'all') return undefined;
  if (scope.serverUserIds.length === 0) return sql`false`;
  return inArray(column, scope.serverUserIds);
}

export function scopeSessionsRaw(scope: Scope, column: SQL): SQL | undefined {
  if (scope === 'all') return undefined;
  if (scope.serverUserIds.length === 0) return sql`false`;
  return sql`${column} IN (${sql.join(
    scope.serverUserIds.map((id) => sql`${id}`),
    sql`, `
  )})`;
}

/** `AND <column> IN (...)` for raw queries built from fragments, empty for 'all'. */
export function scopeFragment(scope: Scope, column: SQL = sql`server_user_id`): SQL {
  const condition = scopeSessionsRaw(scope, column);
  return condition ? sql` AND ${condition}` : sql``;
}

/** buildMultiServerFragment followed by scopeFragment, for queries filtered both ways. */
export function scopedServerFragment(
  serverIds: string[] | undefined,
  scope: Scope,
  serverColumn = 'server_id',
  accountColumn: SQL = sql`server_user_id`
): SQL {
  return sql`${buildMultiServerFragment(serverIds, serverColumn)}${scopeFragment(scope, accountColumn)}`;
}

export function assertInScope(scope: Scope, serverUserId: string): boolean {
  return scope === 'all' || scope.serverUserIds.includes(serverUserId);
}

type RoleGrant = { authorize: (request: never) => { success: boolean } };
const ROLE_GRANTS: Partial<Record<string, RoleGrant>> = roles;

export function hasPermission<R extends Resource>(
  role: UserRole,
  resource: R,
  action: Action<R>
): boolean {
  const grant = Object.hasOwn(ROLE_GRANTS, role) ? ROLE_GRANTS[role] : undefined;
  return grant?.authorize({ [resource]: [action] } as never).success === true;
}

/**
 * Builds the `requirePermission` preHandler. A missing permission answers 404, not 403, so a
 * member cannot map what exists. A member's serverIds become the servers they have accounts
 * on, which the server filters downstream intersect with.
 */
export function permissionGuard(app: FastifyInstance) {
  return function requirePermission<R extends Resource>(resource: R, action: Action<R>) {
    return async function (request: FastifyRequest, reply: FastifyReply) {
      await app.authenticate(request, reply);
      if (reply.sent) return;
      if (!hasPermission(request.user.role, resource, action)) return reply.notFound();
      request.scope = await loadScope(request.user.userId, request.user.role);
      if (request.scope !== 'all') request.user.serverIds = request.scope.serverIds;
    };
  };
}
