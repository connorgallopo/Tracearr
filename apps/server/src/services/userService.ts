/**
 * User Service
 *
 * Handles operations for the multi-server user architecture:
 * - `users` = Identity (the real human)
 * - `server_users` = Account on a specific server (Plex/Jellyfin/Emby)
 *
 * Key patterns:
 * - Get operations return User/ServerUser | null for flexibility
 * - Require operations throw NotFoundError for fail-fast behavior
 * - Sync operations handle auto-linking by email
 */

import { eq, and, sql, inArray, isNull, type SQL } from 'drizzle-orm';
import type { MediaUser } from './mediaServer/index.js';
import { usernameAsEmail } from '@tracearr/shared';
import { db } from '../db/client.js';
import { users, serverUsers, serverUserExternalAliases, automationRuns } from '../db/schema.js';
import { clearScope } from '../lib/scope.js';
import { NotFoundError } from '../utils/errors.js';
import { violationAliasConditions } from './automations/aliasFilter.js';

// Type for user identity table row
export type User = typeof users.$inferSelect;

// Type for server user table row
export type ServerUser = typeof serverUsers.$inferSelect;

// Transaction handle, or the plain db client when there's no surrounding transaction
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

// ============================================================================
// User Identity Operations
// ============================================================================

/**
 * Get user identity by ID (returns null if not found)
 */
export async function getUserById(id: string): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Get user identity by ID (throws if not found)
 */
export async function requireUserById(id: string): Promise<User> {
  const user = await getUserById(id);
  if (!user) {
    throw new UserNotFoundError(id);
  }
  return user;
}

/**
 * Get the owner user (for auth setup validation)
 */
export async function getOwnerUser(): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.role, 'owner')).limit(1);
  return rows[0] ?? null;
}

/** The column's CHECK requires lowercase, and an address that trims to nothing means no contact email. */
function normalizeContactEmail(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  return value.trim().toLowerCase() || null;
}

/**
 * Update user identity
 */
export async function updateUser(
  userId: string,
  data: Partial<{
    username: string;
    name: string | null;
    email: string | null;
    contactEmail: string | null;
    thumbnail: string | null;
    passwordHash: string | null;
    plexAccountId: string | null;
  }>
): Promise<User> {
  const rows = await db
    .update(users)
    .set({
      ...data,
      email: data.email?.toLowerCase() ?? data.email,
      contactEmail: normalizeContactEmail(data.contactEmail),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();

  const user = rows[0];
  if (!user) {
    throw new UserNotFoundError(userId);
  }
  return user;
}

// ============================================================================
// Server User Operations
// ============================================================================

/**
 * Get server user by ID
 */
export async function getServerUserById(id: string): Promise<ServerUser | null> {
  const rows = await db.select().from(serverUsers).where(eq(serverUsers.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Get server user by server ID and external ID (local PMS ID / Jellyfin ID)
 */
export async function getServerUserByExternalId(
  serverId: string,
  externalId: string
): Promise<ServerUser | null> {
  const rows = await db
    .select()
    .from(serverUsers)
    .where(and(eq(serverUsers.serverId, serverId), eq(serverUsers.externalId, externalId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Whether a same-server merge folded this external id into another account.
 *
 * Deliberately separate from getServerUserByExternalId: sync uses that one to
 * decide what to write, and resolving an alias there would overwrite the
 * surviving account's username, email and plex linkage with the absorbed
 * account's whenever both still exist on the media server.
 */
export async function isAliasedExternalId(serverId: string, externalId: string): Promise<boolean> {
  const rows = await db
    .select({ id: serverUserExternalAliases.id })
    .from(serverUserExternalAliases)
    .where(
      and(
        eq(serverUserExternalAliases.serverId, serverId),
        eq(serverUserExternalAliases.externalId, externalId)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Get server user by server ID and Plex account ID (plex.tv ID)
 * Used for Plex sync which uses plex.tv IDs instead of local PMS IDs
 */
export async function getServerUserByPlexAccountId(
  serverId: string,
  plexAccountId: string
): Promise<ServerUser | null> {
  const rows = await db
    .select()
    .from(serverUsers)
    .where(and(eq(serverUsers.serverId, serverId), eq(serverUsers.plexAccountId, plexAccountId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Get server user by server ID and username
 * Used as fallback for linking Plex sync users to existing serverUsers
 */
export async function getServerUserByUsername(
  serverId: string,
  username: string
): Promise<ServerUser | null> {
  const rows = await db
    .select()
    .from(serverUsers)
    .where(and(eq(serverUsers.serverId, serverId), eq(serverUsers.username, username)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Batch-resolve display names for server-user IDs.
 * Single query: serverUsers LEFT JOIN users WHERE id IN (...).
 * Returns id → (identityName ?? username). Safe to call with empty array.
 */
export async function getServerUserDisplayNames(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};

  const unique = [...new Set(ids)];
  const rows = await db
    .select({
      id: serverUsers.id,
      username: serverUsers.username,
      identityName: users.name,
    })
    .from(serverUsers)
    .leftJoin(users, eq(serverUsers.userId, users.id))
    .where(inArray(serverUsers.id, unique));

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.id] = row.identityName ?? row.username;
  }
  return result;
}

/**
 * Get all server users for a user identity
 */
export async function getServerUsersByUserId(userId: string): Promise<ServerUser[]> {
  return db.select().from(serverUsers).where(eq(serverUsers.userId, userId));
}

/**
 * Get all server_user ids belonging to an identity (for cross-server rule
 * aggregation on merged users)
 */
export async function getIdentityServerUserIds(userId: string): Promise<string[]> {
  const rows = await getServerUsersByUserId(userId);
  return rows.map((row) => row.id);
}

/** How a trust write names its new value; `adjust` is a delta, the other two are absolute. */
export type TrustChange =
  { mode: 'adjust'; amount: number } | { mode: 'set'; value: number } | { mode: 'reset' };

/** One account's score before and after a write, read off the row the write returned. */
export interface TrustMove {
  previous: number;
  serverUser: ServerUser;
}

/** Kept for the callers that read the whole row back, which is every one of them. */
export type TrustChangeResult = TrustMove;

const TRUST_BASELINE = 100;

/** The clamped expression each mode writes; the clamp is SQL so a delta cannot overshoot. */
export function trustValueSql(change: TrustChange): SQL {
  if (change.mode === 'adjust') {
    return sql`LEAST(100, GREATEST(0, ${serverUsers.trustScore} + ${change.amount}))`;
  }
  return sql`${change.mode === 'set' ? Math.min(100, Math.max(0, change.value)) : TRUST_BASELINE}`;
}

/**
 * Every trust write goes through this statement: the self-join returns both sides at once, so
 * nothing can read a value another write already moved. The caller owns the transaction and
 * announces the moves after it commits.
 */
export async function moveTrust(executor: Tx, next: SQL, match: SQL): Promise<TrustMove[]> {
  const rows = await executor
    .update(serverUsers)
    .set({ trustScore: next, updatedAt: new Date() })
    .from(sql`${serverUsers} AS before`)
    .where(sql`before.id = ${serverUsers.id} AND ${match}`)
    // Aliased: an unaliased before.trust_score would collide with the row's own column.
    .returning({
      previous: sql<number>`before.trust_score`.as('previous_trust'),
      row: serverUsers,
    });
  return rows.map((row) => ({ previous: row.previous, serverUser: row.row }));
}

/**
 * One account, in a transaction of its own, with the identity rollup committing alongside it.
 * Callers already holding a transaction use `moveTrust` directly.
 */
export async function applyTrustChange(
  serverUserId: string,
  change: TrustChange
): Promise<TrustMove | null> {
  return db.transaction(async (tx) => {
    const [moved] = await moveTrust(tx, trustValueSql(change), eq(serverUsers.id, serverUserId));
    if (!moved) return null;
    await recomputeIdentityAggregates(moved.serverUser.userId, tx);
    return moved;
  });
}

// ============================================================================
// Sync Operations (Creates both user identity and server user)
// ============================================================================

export interface SyncUserOptions {
  /** Set to true when syncing from Plex (uses plex.tv IDs) */
  isPlexServer?: boolean;
}

/**
 * Server-reported activity only ever advances ours. Jellyfin and Emby report
 * LastActivityDate for any interaction, including ones that never produce a
 * session, but a server that has been rebuilt can report something older than
 * the sessions we already recorded.
 */
function advancedActivityAt(reported: Date | undefined, current: Date | null): Date | undefined {
  if (!reported) return undefined;
  if (current && reported <= current) return undefined;
  return reported;
}

/** One server's accounts and their identities, loaded once so a whole-server sync looks rows up in memory. */
export interface ServerAccounts {
  byExternalId: Map<string, ServerUser>;
  byPlexAccountId: Map<string, ServerUser>;
  byUsername: Map<string, ServerUser>;
  usersById: Map<string, User>;
}

function indexAccount(accounts: ServerAccounts, row: ServerUser, replaced?: ServerUser): void {
  if (replaced) {
    if (accounts.byExternalId.get(replaced.externalId)?.id === row.id) {
      accounts.byExternalId.delete(replaced.externalId);
    }
    if (
      replaced.plexAccountId &&
      accounts.byPlexAccountId.get(replaced.plexAccountId)?.id === row.id
    ) {
      accounts.byPlexAccountId.delete(replaced.plexAccountId);
    }
    if (accounts.byUsername.get(replaced.username)?.id === row.id) {
      accounts.byUsername.delete(replaced.username);
    }
  }
  accounts.byExternalId.set(row.externalId, row);
  if (row.plexAccountId) accounts.byPlexAccountId.set(row.plexAccountId, row);
  accounts.byUsername.set(row.username, row);
}

export async function loadServerAccounts(serverId: string): Promise<ServerAccounts> {
  const rows = await db.select().from(serverUsers).where(eq(serverUsers.serverId, serverId));
  const userIds = [...new Set(rows.map((row) => row.userId))];
  const identities =
    userIds.length > 0 ? await db.select().from(users).where(inArray(users.id, userIds)) : [];
  const accounts: ServerAccounts = {
    byExternalId: new Map(),
    byPlexAccountId: new Map(),
    byUsername: new Map(),
    usersById: new Map(identities.map((user) => [user.id, user])),
  };
  // A username or plex id shared by several rows keeps one of them, as the LIMIT 1 lookups did.
  for (const row of rows) {
    accounts.byExternalId.set(row.externalId, row);
    if (row.plexAccountId && !accounts.byPlexAccountId.has(row.plexAccountId)) {
      accounts.byPlexAccountId.set(row.plexAccountId, row);
    }
    if (!accounts.byUsername.has(row.username)) accounts.byUsername.set(row.username, row);
  }
  return accounts;
}

/**
 * A whole-server sync's shared state: the accounts it loaded, the transaction its writes run in,
 * and the identity recounts and scope clears it runs once, after the loop and after commit.
 */
export interface ServerSyncBatch {
  accounts: ServerAccounts;
  tx: Tx;
  recompute: Set<string>;
  clearScopes: Set<string>;
}

type ServerUserChanges = Partial<typeof serverUsers.$inferInsert>;

function sameValue(next: unknown, current: unknown): boolean {
  if (next instanceof Date || current instanceof Date) {
    return (next as Date | null)?.getTime() === (current as Date | null)?.getTime();
  }
  if (Array.isArray(next) || Array.isArray(current)) {
    return JSON.stringify(next) === JSON.stringify(current);
  }
  return next === current;
}

function changesNothing(existing: ServerUser, changes: ServerUserChanges): boolean {
  return Object.entries(changes).every(([key, value]) =>
    sameValue(value, existing[key as keyof ServerUser])
  );
}

/**
 * Sync a user from media server - handles auto-linking by email
 *
 * Flow for Jellyfin/Emby:
 * 1. Check if server_user exists by (serverId, externalId)
 * 2. If exists: update server_user
 * 3. If new: create user + server_user
 *
 * Flow for Plex (isPlexServer=true):
 * 1. mediaUser.id is a plex.tv ID, NOT a local PMS ID
 * 2. Check if server_user exists by plexAccountId
 * 3. If not found, try to match by username (link existing users created by poller)
 * 4. If found: update metadata and set plexAccountId
 * 5. If new: skip creation (let poller create when user streams)
 *
 * An existing account whose row already matches is not written. With `batch`, lookups come from
 * its loaded accounts, writes run in savepoints of its transaction so one failure stays this
 * user's, and identity recounts and scope clears are left in its sets for the caller to run after
 * commit; a recount inside the loop would lock users rows ahead of later server_users writes,
 * the reverse of the poller's order.
 *
 * Returns { serverUser, user, created: boolean } or null if skipped
 */
export async function syncUserFromMediaServer(
  serverId: string,
  mediaUser: MediaUser,
  options: SyncUserOptions = {},
  batch?: ServerSyncBatch
): Promise<{
  serverUser: ServerUser;
  user: User;
  created: boolean;
  newlyDisabled: boolean;
} | null> {
  const { isPlexServer = false } = options;
  const executor = batch?.tx ?? db;
  const known = batch?.accounts;
  const libraryIds = mediaUser.sharedLibraries ? [...mediaUser.sharedLibraries].sort() : null;

  const identityOf = async (userId: string): Promise<User> => {
    if (!known) return requireUserById(userId);
    const user = known.usersById.get(userId);
    if (!user) throw new UserNotFoundError(userId);
    return user;
  };
  const recompute = async (userId: string) => {
    if (batch) batch.recompute.add(userId);
    else await recomputeIdentityAggregates(userId);
  };
  // The member's scope carries their library access, so a change drops it and its cached answers.
  const clearScopeOnLibraryChange = async (existing: ServerUser) => {
    if (String(existing.libraryIds) === String(libraryIds)) return;
    if (batch) batch.clearScopes.add(existing.userId);
    else await clearScope(existing.userId);
  };
  const writeChanges = async (existing: ServerUser, changes: ServerUserChanges) => {
    if (changesNothing(existing, changes)) return existing;
    const write = (t: Tx) =>
      t
        .update(serverUsers)
        .set({ ...changes, updatedAt: new Date() })
        .where(eq(serverUsers.id, existing.id))
        .returning();
    const [row] = batch ? await batch.tx.transaction(write) : await write(db);
    if (!row) throw new ServerUserNotFoundError(existing.id);
    if (known) indexAccount(known, row, existing);
    return row;
  };

  if (isPlexServer) {
    // For Plex: mediaUser.id is plex.tv ID
    // Shared users: plex.tv ID = local PMS ID (same!)
    // Owner: plex.tv ID ≠ local PMS ID (owner is always "1" locally)
    // plexAccountId first (already synced users), then externalId (for shared users plex.tv ID
    // = local PMS ID), then username (display name vs login name may differ).
    const existing = known
      ? (known.byPlexAccountId.get(mediaUser.id) ??
        known.byExternalId.get(mediaUser.id) ??
        known.byUsername.get(mediaUser.username) ??
        null)
      : ((await getServerUserByPlexAccountId(serverId, mediaUser.id)) ??
        (await getServerUserByExternalId(serverId, mediaUser.id)) ??
        (await getServerUserByUsername(serverId, mediaUser.username)));

    if (existing) {
      const nextJoinedAt = mediaUser.joinedAt ?? existing.joinedAt;
      const advancedActivity = advancedActivityAt(
        mediaUser.lastActivityAt,
        existing.lastActivityAt
      );
      const changes: ServerUserChanges = {
        username: mediaUser.username,
        email: mediaUser.email ?? null,
        thumbUrl: mediaUser.thumb ?? null,
        isServerAdmin: mediaUser.isAdmin,
        libraryIds,
        plexAccountId: mediaUser.id, // Set plex.tv ID
        joinedAt: nextJoinedAt,
      };
      if (advancedActivity) {
        changes.lastActivityAt = advancedActivity;
      }

      const updated = await writeChanges(existing, changes);

      // Sync is the only thing that moves joined_at from the server side, so
      // the identity rollups have to follow it. Guarded because this runs for
      // every user on every sync tick.
      if (advancedActivity || nextJoinedAt?.getTime() !== existing.joinedAt?.getTime()) {
        await recompute(existing.userId);
      }
      await clearScopeOnLibraryChange(existing);

      const user = await identityOf(existing.userId);
      return { serverUser: updated, user, created: false, newlyDisabled: false };
    }

    // Already folded into another account by a same-server merge. Creating it
    // again is what the alias table exists to prevent.
    if (await isAliasedExternalId(serverId, mediaUser.id)) {
      return null;
    }

    // Create new Plex user
    // For shared users: plex.tv ID = local PMS ID, so use mediaUser.id for both
    // For owner (isAdmin): should already exist from OAuth, but handle edge case
    const externalId = mediaUser.isAdmin ? '1' : mediaUser.id;

    const result = await executor.transaction(async (tx) => {
      let user: User | undefined;

      // Try to find existing user by email match
      if (mediaUser.email) {
        const [existingUser] = await tx
          .select()
          .from(users)
          .where(eq(users.email, mediaUser.email))
          .limit(1);
        user = existingUser;
      }
      const attachedToExistingIdentity = !!user;

      // No match - create new user identity
      if (!user) {
        const [newUser] = await tx
          .insert(users)
          .values({
            username: mediaUser.username,
            name: null,
            email: mediaUser.email ?? null,
            thumbnail: mediaUser.thumb ?? null,
            // Sole account, so its own dates are the identity rollups.
            firstJoinedAt: mediaUser.joinedAt ?? null,
            lastActivityAt: mediaUser.lastActivityAt ?? null,
          })
          .returning();
        user = newUser!;
      }

      // Create server user with dual IDs for Plex
      const [serverUser] = await tx
        .insert(serverUsers)
        .values({
          userId: user.id,
          serverId,
          externalId,
          plexAccountId: mediaUser.id,
          username: mediaUser.username,
          email: mediaUser.email ?? null,
          thumbUrl: mediaUser.thumb ?? null,
          isServerAdmin: mediaUser.isAdmin,
          libraryIds,
          joinedAt: mediaUser.joinedAt ?? null,
          lastActivityAt: mediaUser.lastActivityAt ?? null,
        })
        .returning();

      if (attachedToExistingIdentity) {
        if (batch) batch.recompute.add(user.id);
        else await recomputeIdentityAggregates(user.id, tx);
      }

      return { serverUser: serverUser!, user };
    });
    if (known) {
      indexAccount(known, result.serverUser);
      known.usersById.set(result.user.id, result.user);
    }

    return {
      serverUser: result.serverUser,
      user: result.user,
      created: true,
      newlyDisabled: false,
    };
  }

  // For Jellyfin/Emby: original flow using externalId
  const existing = known
    ? (known.byExternalId.get(mediaUser.id) ?? null)
    : await getServerUserByExternalId(serverId, mediaUser.id);
  // Account level only: the identity lookup and users.email below keep the raw
  // value, so a username never becomes a login email or links two people.
  const accountEmail = mediaUser.email ?? usernameAsEmail(mediaUser.username);

  if (existing) {
    const changes: ServerUserChanges = {
      username: mediaUser.username,
      email: accountEmail,
      thumbUrl: mediaUser.thumb ?? null,
      isServerAdmin: mediaUser.isAdmin,
      isDisabled: mediaUser.isDisabled ?? false,
      libraryIds,
    };

    const advancedActivity = advancedActivityAt(mediaUser.lastActivityAt, existing.lastActivityAt);
    if (advancedActivity) {
      changes.lastActivityAt = advancedActivity;
    }

    const updated = await writeChanges(existing, changes);

    if (advancedActivity) {
      await recompute(existing.userId);
    }
    await clearScopeOnLibraryChange(existing);

    const user = await identityOf(existing.userId);
    return {
      serverUser: updated,
      user,
      created: false,
      newlyDisabled: !existing.isDisabled && updated.isDisabled,
    };
  }

  // Already folded into another account by a same-server merge. Creating it
  // again is what the alias table exists to prevent.
  if (await isAliasedExternalId(serverId, mediaUser.id)) {
    return null;
  }

  // Use transaction to prevent orphaned users if server user creation fails
  // This ensures atomicity: either both user + server_user are created, or neither
  const result = await executor.transaction(async (tx) => {
    let user: User | undefined;

    // Try to find existing user by email match
    if (mediaUser.email) {
      const [existingUser] = await tx
        .select()
        .from(users)
        .where(eq(users.email, mediaUser.email))
        .limit(1);
      user = existingUser;
    }
    const attachedToExistingIdentity = !!user;

    // No match - create new user identity
    if (!user) {
      const [newUser] = await tx
        .insert(users)
        .values({
          username: mediaUser.username, // Use media server username as identity username
          name: null,
          email: mediaUser.email ?? null,
          thumbnail: mediaUser.thumb ?? null,
          // Sole account, so its own dates are the identity rollups.
          firstJoinedAt: mediaUser.joinedAt ?? null,
          lastActivityAt: mediaUser.lastActivityAt ?? null,
        })
        .returning();
      user = newUser!; // Insert always returns a row
    }

    // Create server user linked to user identity
    const [serverUser] = await tx
      .insert(serverUsers)
      .values({
        userId: user.id,
        serverId,
        externalId: mediaUser.id,
        username: mediaUser.username,
        email: accountEmail,
        thumbUrl: mediaUser.thumb ?? null,
        isServerAdmin: mediaUser.isAdmin,
        isDisabled: mediaUser.isDisabled ?? false,
        libraryIds,
        joinedAt: mediaUser.joinedAt ?? null,
        lastActivityAt: mediaUser.lastActivityAt ?? null,
      })
      .returning();

    // Only when the account joined a person who already had others: a fresh
    // identity's rollups were seeded by its own insert above.
    if (attachedToExistingIdentity) {
      if (batch) batch.recompute.add(user.id);
      else await recomputeIdentityAggregates(user.id, tx);
    }

    return { serverUser: serverUser!, user };
  });
  if (known) {
    indexAccount(known, result.serverUser);
    known.usersById.set(result.user.id, result.user);
  }

  return { serverUser: result.serverUser, user: result.user, created: true, newlyDisabled: false };
}

/**
 * Recompute identity-level rollups from each identity's server accounts:
 * aggregate trust, total violation count, earliest join and latest activity.
 * One statement for any number of identities.
 *
 * Identity trust is the WORST active account's score, not an average. Trust
 * penalties land only on the account where the behavior happened
 * (enforceAcrossServers extends kills, never scores), so with several
 * accounts an average would dilute the one signal the system writes.
 * Removed accounts only count when the identity has no active ones left.
 *
 * The dates deliberately do not follow that rule: they span every account,
 * removed included, because removing an account does not un-happen its
 * history. That matches how a merge combines two accounts on one server.
 *
 * Called after every write to serverUsers.trustScore and every violation
 * insert - there is no database trigger backing this, so every call site
 * that changes either input is responsible for calling this too. Pass the
 * transaction handle already in use so this participates in the same write
 * instead of racing it.
 */
export async function recomputeIdentityAggregates(
  userIds: string | string[],
  executor: Tx = db
): Promise<void> {
  const ids = [...new Set(typeof userIds === 'string' ? [userIds] : userIds)];
  if (ids.length === 0) return;
  // Aggregated over users, not accounts, so an identity with no accounts left still gets the defaults.
  await executor.execute(sql`
    UPDATE ${users} AS u SET
      aggregate_trust_score = coalesce(a.trust, 100),
      total_violations = coalesce(v.count, 0),
      first_joined_at = a.first_joined,
      last_activity_at = a.last_activity,
      updated_at = now()
    FROM (
      SELECT ${users.id} AS user_id,
        coalesce(
          min(${serverUsers.trustScore}) filter (where ${serverUsers.removedAt} is null),
          min(${serverUsers.trustScore})
        ) AS trust,
        min(${serverUsers.joinedAt}) AS first_joined,
        max(${serverUsers.lastActivityAt}) AS last_activity
      FROM ${users}
      LEFT JOIN ${serverUsers} ON ${serverUsers.userId} = ${users.id}
      WHERE ${inArray(users.id, ids)}
      GROUP BY ${users.id}
    ) AS a
    LEFT JOIN (
      SELECT ${serverUsers.userId} AS user_id, count(*)::int AS count
      FROM ${automationRuns}
      INNER JOIN ${serverUsers} ON ${automationRuns.serverUserId} = ${serverUsers.id}
      WHERE ${and(
        inArray(serverUsers.userId, ids),
        isNull(automationRuns.dismissedAt),
        ...violationAliasConditions()
      )}
      GROUP BY ${serverUsers.userId}
    ) AS v ON v.user_id = a.user_id
    WHERE u.id = a.user_id
  `);
}

/**
 * Bulk version of the identity date rollups, for jobs that rewrite joined_at or
 * last_activity_at across the whole server_users table at once. The DISTINCT
 * FROM guard keeps a second pass from rewriting rows the first one settled.
 */
export async function recomputeAllIdentityDates(executor: Tx = db): Promise<number> {
  const result = await executor.execute(sql`
    UPDATE ${users} u SET
      first_joined_at = agg.min_joined,
      last_activity_at = agg.max_activity,
      updated_at = now()
    FROM (
      SELECT user_id, MIN(joined_at) AS min_joined, MAX(last_activity_at) AS max_activity
      FROM ${serverUsers}
      GROUP BY user_id
    ) agg
    WHERE u.id = agg.user_id
      AND (
        u.first_joined_at IS DISTINCT FROM agg.min_joined
        OR u.last_activity_at IS DISTINCT FROM agg.max_activity
      )
  `);
  return Number(result.rowCount ?? 0);
}

/** Same recompute, addressed by the account ids a violation write already has in hand. */
export async function recomputeIdentityAggregatesForServerUser(
  serverUserIds: string | string[],
  executor: Tx = db
): Promise<void> {
  const ids = typeof serverUserIds === 'string' ? [serverUserIds] : serverUserIds;
  if (ids.length === 0) return;
  const rows = await executor
    .selectDistinct({ userId: serverUsers.userId })
    .from(serverUsers)
    .where(inArray(serverUsers.id, ids));
  await recomputeIdentityAggregates(
    rows.map((row) => row.userId),
    executor
  );
}

// ============================================================================
// Errors
// ============================================================================

/**
 * User not found error - extends NotFoundError for consistent error handling.
 */
export class UserNotFoundError extends NotFoundError {
  constructor(id?: string) {
    super('User', id);
    this.name = 'UserNotFoundError';
    Object.setPrototypeOf(this, UserNotFoundError.prototype);
  }
}

/**
 * Server user not found error
 */
export class ServerUserNotFoundError extends NotFoundError {
  constructor(id?: string) {
    super('ServerUser', id);
    this.name = 'ServerUserNotFoundError';
    Object.setPrototypeOf(this, ServerUserNotFoundError.prototype);
  }
}
