/**
 * Server User List and CRUD Routes
 *
 * These routes manage server users (accounts on Plex/Jellyfin/Emby servers),
 * not the identity users. Server users have per-server trust scores and session counts.
 *
 * GET / - List all server users with pagination
 * GET /:id - Get server user details
 * PATCH /:id - Update server user (trustScore, etc.)
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and, sql, inArray, type SQL } from 'drizzle-orm';
import {
  updateUserSchema,
  updateUserIdentitySchema,
  userIdParamSchema,
  userListQuerySchema,
  userRosterFilterSchema,
  bulkResetTrustBodySchema,
  type AuthUser,
  type ListResponse,
  type UserRole,
  type UserRosterFilters,
  type UserSortField,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { serverUsers, sessions, servers, users } from '../../db/schema.js';
import {
  hasServerAccess,
  buildServerAccessCondition,
  resolveServerIds,
  buildMultiServerFragment,
} from '../../utils/serverFiltering.js';
import {
  buildOrderBy,
  likePattern,
  utcDayEnd,
  utcDayStart,
  type SortDirection,
  type SortKey,
} from '../../utils/listQuery.js';
import {
  dispatchTrustChanged,
  dispatchTrustMoves,
} from '../../services/automations/events/producers.js';
import {
  applyTrustChange,
  moveTrust,
  trustValueSql,
  updateUser,
  recomputeIdentityAggregates,
} from '../../services/userService.js';
import { isLoginCapable } from '../../services/mergeService.js';
import { representativeAccountOrderSql } from '../../utils/representativeAccount.js';
import { PLAY_COUNT } from '../../constants/index.js';

/** What a trust-score notification says moved the score when a person did it by hand. */
const OWNER_TRUST_REASON = 'changed by an owner';

/** The same, for the bulk reset that follows a merge or a split. */
const RESET_TRUST_REASON = 'reset by an owner';

/**
 * Sort keys, all on the identity row so the LIMIT can ride an index on `users`
 * instead of sorting the whole server_users x users product. The directions and
 * NULLS placement mirror migration 0089's indexes exactly; see buildOrderBy.
 *
 * `username` orders on the identity's display name rather than the
 * representative account's server username. Those differ only when users.name
 * is set or a server-side rename left users.username behind, and the roster
 * renders identityName ?? username, so this sorts by what the row shows.
 */
const USER_SORT_KEYS: Record<UserSortField, SortKey> = {
  username: { key: sql`coalesce(u.name, u.username)`, defaultDir: 'asc', nulls: 'last' },
  trustScore: { key: sql`u.aggregate_trust_score`, defaultDir: 'desc', nulls: 'last' },
  joinedAt: { key: sql`u.first_joined_at`, defaultDir: 'desc', nulls: 'last' },
  lastActivityAt: { key: sql`u.last_activity_at`, defaultDir: 'desc', nulls: 'last' },
};

interface UserRosterSql {
  /** undefined = every server; [] = none of the requested servers are visible. */
  resolvedIds: string[] | undefined;
  /** Predicates on the identity row, which every roster query aliases `u`. */
  identityConditions: SQL[];
  /** `AND ...` narrowing a server_users alias to the accounts the roster counts. */
  accountScope: (alias: string) => SQL;
}

/**
 * The single definition of "which people are in this roster".
 *
 * GET /, its count query and POST /bulk/reset-trust's selectAll seed all build
 * their row set from this. They used to build it separately, and the bulk
 * endpoint's copy accepted only the server filters: Zod stripped `search`
 * silently, so narrowing the table to three people and hitting "select all"
 * reset every account on the server. Sharing the builder makes that drift a
 * type error rather than a quiet data loss.
 */
export function buildUserRosterSql(
  filters: UserRosterFilters,
  authUser: AuthUser,
  { strict = true }: { strict?: boolean } = {}
): UserRosterSql {
  const resolvedIds = resolveServerIds(authUser, filters.serverId, filters.serverIds, { strict });

  const serverScope = (alias: string): SQL =>
    buildMultiServerFragment(resolvedIds, `${alias}.server_id`);
  const accountScope = (alias: string): SQL =>
    filters.includeRemoved
      ? serverScope(alias)
      : sql`${serverScope(alias)} AND ${sql.raw(alias)}.removed_at IS NULL`;

  const identityConditions: SQL[] = [];

  if (filters.search) {
    const pattern = likePattern(filters.search);
    // Any account's username matches, not just the representative's: someone
    // who is bob_plex on Plex and robert on Jellyfin is findable as either.
    identityConditions.push(sql`(
      u.name ILIKE ${pattern}
      OR EXISTS (
        SELECT 1 FROM server_users rsu
        WHERE rsu.user_id = u.id AND rsu.username ILIKE ${pattern} ${serverScope('rsu')}
      )
    )`);
  }

  if (filters.hasAccessTo && filters.hasAccessTo.length > 0) {
    const wanted = [...new Set(filters.hasAccessTo)];
    const visible =
      authUser.role === 'owner' ? wanted : wanted.filter((id) => authUser.serverIds.includes(id));

    if (visible.length !== wanted.length) {
      // Asked about a server this caller cannot see, so no honest answer exists.
      identityConditions.push(sql`false`);
    } else {
      // Counts DISTINCT servers so the match is "on every one of them", and
      // ignores the view scope: the question is what the person can reach, not
      // what is currently on screen. A removed account is not access.
      identityConditions.push(sql`(
        SELECT count(DISTINCT asu.server_id)
        FROM server_users asu
        WHERE asu.user_id = u.id
          AND asu.removed_at IS NULL
          AND asu.server_id IN (${sql.join(
            visible.map((id) => sql`${id}::uuid`),
            sql`, `
          )})
      ) = ${visible.length}`);
    }
  }

  const joinedAfter = utcDayStart(filters.joinedAfter);
  if (joinedAfter) {
    identityConditions.push(sql`u.first_joined_at >= ${joinedAfter}`);
  }
  const joinedBefore = utcDayEnd(filters.joinedBefore);
  if (joinedBefore) {
    identityConditions.push(sql`u.first_joined_at < ${joinedBefore}`);
  }
  const activeAfter = utcDayStart(filters.activeAfter);
  if (activeAfter) {
    identityConditions.push(sql`u.last_activity_at >= ${activeAfter}`);
  }
  const activeBefore = utcDayEnd(filters.activeBefore);
  if (activeBefore) {
    identityConditions.push(sql`u.last_activity_at < ${activeBefore}`);
  }

  return { resolvedIds, identityConditions, accountScope };
}

function identityWhere(roster: UserRosterSql): SQL {
  return roster.identityConditions.length > 0
    ? sql.join(roster.identityConditions, sql` AND `)
    : sql`true`;
}

/**
 * One row per identity, driven by `users` so the ORDER BY and LIMIT can use an
 * index. The lateral picks the person's representative account with
 * representativeAccountOrderSql, byte-identical to the DISTINCT ON this
 * replaced, and runs once per returned row off server_users_user_idx.
 *
 * The login-capability counts are select-list subqueries, so they only run for
 * the rows that survive the LIMIT.
 */
export function buildUserRosterPageQuery(params: {
  roster: UserRosterSql;
  orderBy: UserSortField;
  orderDir: SortDirection | undefined;
  pageSize: number;
  offset: number;
}): SQL {
  const { roster, orderBy, orderDir, pageSize, offset } = params;

  return sql`
    SELECT
      u.id AS "userId",
      u.name AS "identityName",
      u.role AS "role",
      u.password_hash AS "passwordHash",
      u.plex_account_id AS "identityPlexAccountId",
      u.aggregate_trust_score AS "identityTrustScore",
      u.first_joined_at AS "identityJoinedAt",
      u.last_activity_at AS "identityLastActivityAt",
      (SELECT count(*)::int FROM plex_accounts pa WHERE pa.user_id = u.id) AS "plexAccountCount",
      (SELECT count(*)::int FROM auth_accounts aa WHERE aa.user_id = u.id) AS "authAccountCount",
      rep.id AS "id",
      rep.server_id AS "serverId",
      s.name AS "serverName",
      rep.external_id AS "externalId",
      rep.username AS "username",
      rep.email AS "email",
      rep.thumb_url AS "thumbUrl",
      rep.is_server_admin AS "isServerAdmin",
      rep.trust_score AS "trustScore",
      rep.joined_at AS "joinedAt",
      rep.last_activity_at AS "lastActivityAt",
      rep.removed_at AS "removedAt",
      rep.updated_at AS "updatedAt"
    FROM users u
    JOIN LATERAL (
      SELECT su.id, su.server_id, su.external_id, su.username, su.email, su.thumb_url,
             su.is_server_admin, su.trust_score, su.joined_at, su.last_activity_at,
             su.removed_at, su.updated_at
      FROM server_users su
      WHERE su.user_id = u.id ${roster.accountScope('su')}
      ORDER BY ${representativeAccountOrderSql('su')}
      LIMIT 1
    ) rep ON true
    INNER JOIN servers s ON s.id = rep.server_id
    WHERE ${identityWhere(roster)}
    ORDER BY ${buildOrderBy(USER_SORT_KEYS, orderBy, orderDir, sql`u.id`)}
    LIMIT ${pageSize} OFFSET ${offset}
  `;
}

/** Same row set as the page query, counted without running the lateral. */
export function buildUserRosterCountQuery(roster: UserRosterSql): SQL {
  return sql`
    SELECT count(*)::int AS "total"
    FROM users u
    WHERE ${identityWhere(roster)}
      AND EXISTS (
        SELECT 1 FROM server_users su
        WHERE su.user_id = u.id ${roster.accountScope('su')}
      )
  `;
}

/** Every account behind the roster's identities, not just the representatives. */
export function buildUserRosterAccountIdQuery(roster: UserRosterSql): SQL {
  return sql`
    SELECT su.id AS "id"
    FROM server_users su
    INNER JOIN users u ON u.id = su.user_id
    WHERE ${identityWhere(roster)} ${roster.accountScope('su')}
  `;
}

interface RosterPageRow {
  userId: string;
  identityName: string | null;
  role: UserRole;
  passwordHash: string | null;
  identityPlexAccountId: string | null;
  identityTrustScore: number;
  identityJoinedAt: Date | null;
  identityLastActivityAt: Date | null;
  plexAccountCount: number;
  authAccountCount: number;
  id: string;
  serverId: string;
  serverName: string;
  externalId: string;
  username: string;
  email: string | null;
  thumbUrl: string | null;
  isServerAdmin: boolean;
  trustScore: number;
  joinedAt: Date | null;
  lastActivityAt: Date | null;
  removedAt: Date | null;
  updatedAt: Date;
}

interface IdentityServer {
  id: string;
  name: string;
  serverUserId: string;
  removedAt: string | null;
}

/** The roster's wire row: the representative account plus its identity rollups. */
interface UserRosterRow {
  id: string;
  serverId: string;
  serverName: string;
  userId: string;
  externalId: string;
  username: string;
  email: string | null;
  thumbUrl: string | null;
  isServerAdmin: boolean;
  trustScore: number;
  joinedAt: Date | null;
  lastActivityAt: Date | null;
  removedAt: Date | null;
  updatedAt: Date;
  identityName: string | null;
  role: UserRole;
  identityTrustScore: number;
  identityJoinedAt: Date | null;
  identityLastActivityAt: Date | null;
  loginCapable: boolean;
  identityServers: IdentityServer[];
}

export const listRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET / - List all server users with pagination
   */
  app.get('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = userListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { page, pageSize, orderBy, orderDir, ...filters } = query.data;
    const authUser = request.user;
    const offset = (page - 1) * pageSize;

    const roster = buildUserRosterSql(filters, authUser);

    // Short-circuit when the user has no accessible servers in the requested set
    if (roster.resolvedIds?.length === 0) {
      return {
        data: [],
        meta: { page, pageSize, total: 0 },
      } satisfies ListResponse<UserRosterRow>;
    }

    const pageResult = await db.execute(
      buildUserRosterPageQuery({ roster, orderBy, orderDir, pageSize, offset })
    );
    const pageRows = pageResult.rows as unknown as RosterPageRow[];

    const countResult = await db.execute(buildUserRosterCountQuery(roster));
    const total = (countResult.rows[0] as unknown as { total: number } | undefined)?.total ?? 0;

    // Batch-fetch each identity's server memberships in one query for the whole
    // page, scoped to servers the caller can access (owners see all).
    const pageUserIds = pageRows.map((row) => row.userId);
    const identityServersByUserId = new Map<string, IdentityServer[]>();
    if (pageUserIds.length > 0) {
      const identityServerAccessCondition = buildServerAccessCondition(
        authUser,
        serverUsers.serverId
      );
      const identityWhereClause = identityServerAccessCondition
        ? and(inArray(serverUsers.userId, pageUserIds), identityServerAccessCondition)
        : inArray(serverUsers.userId, pageUserIds);

      const identityServerRows = await db
        .selectDistinct({
          userId: serverUsers.userId,
          serverId: serverUsers.serverId,
          serverName: servers.name,
          serverUserId: serverUsers.id,
          removedAt: serverUsers.removedAt,
        })
        .from(serverUsers)
        .innerJoin(servers, eq(serverUsers.serverId, servers.id))
        .where(identityWhereClause);

      for (const row of identityServerRows) {
        const existing = identityServersByUserId.get(row.userId);
        const entry = {
          id: row.serverId,
          name: row.serverName,
          serverUserId: row.serverUserId,
          removedAt: row.removedAt ? row.removedAt.toISOString() : null,
        };
        if (existing) {
          existing.push(entry);
        } else {
          identityServersByUserId.set(row.userId, [entry]);
        }
      }
    }

    const data: UserRosterRow[] = pageRows.map((row) => ({
      id: row.id,
      serverId: row.serverId,
      serverName: row.serverName,
      userId: row.userId,
      externalId: row.externalId,
      username: row.username,
      email: row.email,
      thumbUrl: row.thumbUrl,
      isServerAdmin: row.isServerAdmin,
      trustScore: row.trustScore,
      joinedAt: row.joinedAt,
      lastActivityAt: row.lastActivityAt,
      removedAt: row.removedAt,
      updatedAt: row.updatedAt,
      identityName: row.identityName,
      role: row.role,
      // The person's overall trust across all their server accounts,
      // distinct from `trustScore` (this representative account's own score).
      identityTrustScore: row.identityTrustScore,
      identityJoinedAt: row.identityJoinedAt,
      identityLastActivityAt: row.identityLastActivityAt,
      // Wider than canLogin(role); the merge dialog picks its direction from
      // this, and deriving it client-side from role alone picks the wrong one.
      loginCapable: isLoginCapable({
        id: row.userId,
        role: row.role,
        passwordHash: row.passwordHash,
        plexAccountId: row.identityPlexAccountId,
        linkedPlexAccountCount: row.plexAccountCount,
        authAccountCount: row.authAccountCount,
      }),
      // Fallback is unreachable in practice: the row's own server is always part of the
      // batched scope above. Kept as a safety net, not an expected path.
      identityServers: identityServersByUserId.get(row.userId) ?? [
        {
          id: row.serverId,
          name: row.serverName,
          serverUserId: row.id,
          removedAt: row.removedAt ? row.removedAt.toISOString() : null,
        },
      ],
    }));

    return { data, meta: { page, pageSize, total } } satisfies ListResponse<UserRosterRow>;
  });

  /**
   * GET /:id - Get server user details
   */
  app.get('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const { id } = params.data;
    const authUser = request.user;

    const serverUserRows = await db
      .select({
        id: serverUsers.id,
        serverId: serverUsers.serverId,
        serverName: servers.name,
        userId: serverUsers.userId,
        externalId: serverUsers.externalId,
        username: serverUsers.username,
        email: serverUsers.email,
        thumbUrl: serverUsers.thumbUrl,
        isServerAdmin: serverUsers.isServerAdmin,
        trustScore: serverUsers.trustScore,
        joinedAt: serverUsers.joinedAt,
        lastActivityAt: serverUsers.lastActivityAt,
        removedAt: serverUsers.removedAt,
        updatedAt: serverUsers.updatedAt,
        // Include identity info
        identityName: users.name,
        role: users.role,
      })
      .from(serverUsers)
      .innerJoin(servers, eq(serverUsers.serverId, servers.id))
      .innerJoin(users, eq(serverUsers.userId, users.id))
      .where(eq(serverUsers.id, id))
      .limit(1);

    const serverUser = serverUserRows[0];
    if (!serverUser) {
      return reply.notFound('User not found');
    }

    // Verify access (owners can see all servers)
    if (!hasServerAccess(authUser, serverUser.serverId)) {
      return reply.forbidden('You do not have access to this user');
    }

    // Get session stats for this server user (count unique plays, not raw rows)
    const statsResult = await db
      .select({
        totalSessions: PLAY_COUNT,
        totalWatchTime: sql<number>`coalesce(sum(duration_ms), 0)::bigint`,
      })
      .from(sessions)
      .where(eq(sessions.serverUserId, id));

    const stats = statsResult[0];

    return {
      ...serverUser,
      stats: {
        totalSessions: stats?.totalSessions ?? 0,
        totalWatchTime: Number(stats?.totalWatchTime ?? 0),
      },
    };
  });

  /**
   * PATCH /:id - Update server user (trustScore, etc.)
   */
  app.patch('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const body = updateUserSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Only owners can update users
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can update users');
    }

    // Get existing server user
    const serverUserRows = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, id))
      .limit(1);

    const serverUser = serverUserRows[0];
    if (!serverUser) {
      return reply.notFound('User not found');
    }

    // Verify access (owners can see all servers)
    if (!hasServerAccess(authUser, serverUser.serverId)) {
      return reply.forbidden('You do not have access to this user');
    }

    // A trust write goes through the one writer, which recomputes the person's rollup in
    // the same transaction; anything else on this body only moves the timestamp.
    const { trustScore } = body.data;
    const applied =
      trustScore === undefined
        ? null
        : await applyTrustChange(id, { mode: 'set', value: trustScore });
    const updated = applied
      ? applied.serverUser
      : (
          await db
            .update(serverUsers)
            .set({ updatedAt: new Date() })
            .where(eq(serverUsers.id, id))
            .returning()
        )[0];

    if (!updated) {
      return reply.internalServerError('Failed to update user');
    }

    if (applied) {
      await dispatchTrustChanged({
        serverId: updated.serverId,
        serverUserId: updated.id,
        previous: applied.previous,
        next: updated.trustScore,
        reason: OWNER_TRUST_REASON,
      });
    }

    return {
      id: updated.id,
      serverId: updated.serverId,
      userId: updated.userId,
      externalId: updated.externalId,
      username: updated.username,
      email: updated.email,
      thumbUrl: updated.thumbUrl,
      isServerAdmin: updated.isServerAdmin,
      trustScore: updated.trustScore,
      joinedAt: updated.joinedAt,
      lastActivityAt: updated.lastActivityAt,
      updatedAt: updated.updatedAt,
    };
  });

  /**
   * PATCH /:id/identity - Update user identity (display name and contact email)
   * Owner-only. Updates the users table (identity), not server_users.
   */
  app.patch('/:id/identity', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const body = updateUserIdentitySchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Only owners can update user identity
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only owners can update user identity');
    }

    // Get serverUser to find userId (the identity)
    const serverUserRows = await db
      .select({ userId: serverUsers.userId, serverId: serverUsers.serverId })
      .from(serverUsers)
      .where(eq(serverUsers.id, id))
      .limit(1);

    const serverUser = serverUserRows[0];
    if (!serverUser) {
      return reply.notFound('User not found');
    }

    // Verify access
    if (!hasServerAccess(authUser, serverUser.serverId)) {
      return reply.forbidden('Access denied');
    }

    // Update the identity record (users table)
    const updated = await updateUser(serverUser.userId, {
      name: body.data.name,
      contactEmail: body.data.contactEmail,
    });

    return { success: true, name: updated.name, contactEmail: updated.contactEmail };
  });

  /**
   * POST /bulk/reset-trust - Bulk reset trust scores to 100
   * Owner/admin. Accepts either specific server-user IDs or a selectAll flag
   * with the same roster filters as GET /. Resetting a person's representative
   * row resets ALL of their accounts on servers the caller can access, so the
   * identity's overall trust score actually returns to 100 for an owner (not
   * just the one account that happened to be selected). A scoped admin only
   * ever touches accounts on servers they can access, so the identity's
   * rollup recomputes over the person's full account set and may land short
   * of 100 if a sibling account outside their access still has a lower score.
   */
  app.post('/bulk/reset-trust', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners and admins can reset trust scores
    if (authUser.role !== 'owner' && authUser.role !== 'admin') {
      return reply.forbidden('Only administrators can reset trust scores');
    }

    const parsedBody = bulkResetTrustBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.badRequest('Invalid request body');
    }
    const body = parsedBody.data;

    if ((!body.ids || body.ids.length === 0) && !body.selectAll) {
      return reply.badRequest('ids array or selectAll is required');
    }

    let seedIds: string[];

    if (body.selectAll) {
      // The roster builder GET / uses, so selectAll can never reach past what
      // the table showed: every filter narrowing the list narrows this too.
      const roster = buildUserRosterSql(
        body.filters ?? userRosterFilterSchema.parse({}),
        authUser,
        {
          strict: false,
        }
      );

      if (roster.resolvedIds?.length === 0) {
        return { success: true, updated: 0 };
      }

      const matching = await db.execute(buildUserRosterAccountIdQuery(roster));
      seedIds = (matching.rows as unknown as { id: string }[]).map((row) => row.id);
    } else {
      seedIds = body.ids!;
    }

    if (seedIds.length === 0) {
      return { success: true, updated: 0 };
    }

    // Verify access and resolve the identities behind the seed accounts
    const seedDetails = await db
      .select({
        id: serverUsers.id,
        serverId: serverUsers.serverId,
        userId: serverUsers.userId,
      })
      .from(serverUsers)
      .where(inArray(serverUsers.id, seedIds));

    const accessibleSeeds = seedDetails.filter((u) => hasServerAccess(authUser, u.serverId));
    if (accessibleSeeds.length === 0) {
      return { success: true, updated: 0 };
    }

    const affectedIdentityIds = [...new Set(accessibleSeeds.map((u) => u.userId))];

    // Expand each touched identity to ALL of their accounts on servers the
    // caller can access, so a merged person's sibling accounts get reset too.
    const identityAccessCondition = buildServerAccessCondition(authUser, serverUsers.serverId);
    const identityWhereClause = identityAccessCondition
      ? and(inArray(serverUsers.userId, affectedIdentityIds), identityAccessCondition)
      : inArray(serverUsers.userId, affectedIdentityIds);

    const accountsToReset = await db
      .select({ id: serverUsers.id })
      .from(serverUsers)
      .where(identityWhereClause);

    const accountIds = accountsToReset.map((a) => a.id);
    if (accountIds.length === 0) {
      return { success: true, updated: 0 };
    }

    // Bulk update trust scores to 100, then recompute each affected identity's
    // rollup once in the same transaction.
    const moves = await db.transaction(async (tx) => {
      const moved = await moveTrust(
        tx,
        trustValueSql({ mode: 'reset' }),
        inArray(serverUsers.id, accountIds)
      );

      for (const userId of affectedIdentityIds) {
        await recomputeIdentityAggregates(userId, tx);
      }
      return moved;
    });

    await dispatchTrustMoves(moves, RESET_TRUST_REASON);

    return { success: true, updated: accountIds.length };
  });
};
