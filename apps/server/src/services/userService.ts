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

import { eq, and, sql } from 'drizzle-orm';
import type { MediaUser } from './mediaServer/index.js';
import type { UserRole } from '@tracearr/shared';
import { db } from '../db/client.js';
import { users, serverUsers, servers, sessions } from '../db/schema.js';
import { NotFoundError } from '../utils/errors.js';

// Type for user identity table row
export type User = typeof users.$inferSelect;

// Type for server user table row
export type ServerUser = typeof serverUsers.$inferSelect;

// Type for server user with user and server info
export interface ServerUserWithDetails {
  id: string;
  userId: string;
  serverId: string;
  externalId: string;
  username: string;
  email: string | null;
  thumbUrl: string | null;
  isServerAdmin: boolean;
  trustScore: number;
  sessionCount: number;
  createdAt: Date;
  updatedAt: Date;
  // User identity info
  user: {
    id: string;
    name: string | null;
    thumbnail: string | null;
    email: string | null;
    role: UserRole;
    aggregateTrustScore: number;
  };
  // Server info
  server: {
    id: string;
    name: string;
    type: string;
  };
}

// Type for user with stats (for user detail page)
export interface UserWithStats {
  id: string;
  username: string;
  name: string | null;
  thumbnail: string | null;
  email: string | null;
  role: UserRole;
  aggregateTrustScore: number;
  totalViolations: number;
  createdAt: Date;
  updatedAt: Date;
  serverUsers: Array<{
    id: string;
    serverId: string;
    serverName: string;
    serverType: string;
    username: string;
    thumbUrl: string | null;
    trustScore: number;
    sessionCount: number;
  }>;
  stats: {
    totalSessions: number;
    totalWatchTime: number;
  };
}

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
 * Get user identity by email (for auto-linking during sync)
 */
export async function getUserByEmail(email: string): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return rows[0] ?? null;
}

/**
 * Get user identity by username (for local auth lookup)
 */
export async function getUserByUsername(username: string): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return rows[0] ?? null;
}

/**
 * Get user identity by Plex account ID (for Login with Plex)
 */
export async function getUserByPlexAccountId(plexAccountId: string): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.plexAccountId, plexAccountId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Get the owner user (for auth setup validation)
 */
export async function getOwnerUser(): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.role, 'owner')).limit(1);
  return rows[0] ?? null;
}

/**
 * Create a new user identity
 */
export async function createUser(data: {
  username: string;
  name?: string;
  email?: string;
  thumbnail?: string;
  passwordHash?: string;
  plexAccountId?: string;
  role?: UserRole;
}): Promise<User> {
  const rows = await db
    .insert(users)
    .values({
      username: data.username,
      name: data.name ?? null,
      email: data.email?.toLowerCase() ?? null,
      thumbnail: data.thumbnail ?? null,
      passwordHash: data.passwordHash ?? null,
      plexAccountId: data.plexAccountId ?? null,
      role: data.role ?? 'member',
    })
    .returning();
  return rows[0]!;
}

/**
 * Create owner user (for initial setup)
 */
export async function createOwnerUser(data: {
  username: string;
  name?: string;
  passwordHash?: string;
  email?: string;
  plexAccountId?: string;
  thumbnail?: string;
}): Promise<User> {
  return createUser({
    ...data,
    role: 'owner',
  });
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

/**
 * Link Plex account to existing user
 */
export async function linkPlexAccount(
  userId: string,
  plexAccountId: string,
  thumbnail?: string
): Promise<User> {
  return updateUser(userId, {
    plexAccountId,
    thumbnail: thumbnail ?? undefined,
  });
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
 * Get server user by ID (throws if not found)
 */
export async function requireServerUserById(id: string): Promise<ServerUser> {
  const serverUser = await getServerUserById(id);
  if (!serverUser) {
    throw new ServerUserNotFoundError(id);
  }
  return serverUser;
}

/**
 * Get server user by server ID and external ID (Plex/Jellyfin user ID)
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
 * Get server user with full details (user identity + server info)
 */
export async function getServerUserWithDetails(id: string): Promise<ServerUserWithDetails | null> {
  const rows = await db
    .select({
      id: serverUsers.id,
      userId: serverUsers.userId,
      serverId: serverUsers.serverId,
      externalId: serverUsers.externalId,
      username: serverUsers.username,
      email: serverUsers.email,
      thumbUrl: serverUsers.thumbUrl,
      isServerAdmin: serverUsers.isServerAdmin,
      trustScore: serverUsers.trustScore,
      sessionCount: serverUsers.sessionCount,
      createdAt: serverUsers.createdAt,
      updatedAt: serverUsers.updatedAt,
      userName: users.name,
      userThumbnail: users.thumbnail,
      userEmail: users.email,
      userRole: users.role,
      userAggregateTrustScore: users.aggregateTrustScore,
      serverName: servers.name,
      serverType: servers.type,
    })
    .from(serverUsers)
    .innerJoin(users, eq(serverUsers.userId, users.id))
    .innerJoin(servers, eq(serverUsers.serverId, servers.id))
    .where(eq(serverUsers.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    userId: row.userId,
    serverId: row.serverId,
    externalId: row.externalId,
    username: row.username,
    email: row.email,
    thumbUrl: row.thumbUrl,
    isServerAdmin: row.isServerAdmin,
    trustScore: row.trustScore,
    sessionCount: row.sessionCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    user: {
      id: row.userId,
      name: row.userName,
      thumbnail: row.userThumbnail,
      email: row.userEmail,
      role: row.userRole,
      aggregateTrustScore: row.userAggregateTrustScore,
    },
    server: {
      id: row.serverId,
      name: row.serverName,
      type: row.serverType,
    },
  };
}

/**
 * Get all server users for a server (for batch processing in poller)
 * Returns a Map keyed by externalId for O(1) lookups
 */
export async function getServerUsersByServer(serverId: string): Promise<Map<string, ServerUser>> {
  const rows = await db.select().from(serverUsers).where(eq(serverUsers.serverId, serverId));

  const userMap = new Map<string, ServerUser>();
  for (const su of rows) {
    userMap.set(su.externalId, su);
  }
  return userMap;
}

/**
 * Get all server users for a user identity
 */
export async function getServerUsersByUserId(userId: string): Promise<ServerUser[]> {
  return db.select().from(serverUsers).where(eq(serverUsers.userId, userId));
}

/**
 * Create a server user linked to a user identity
 */
export async function createServerUser(data: {
  userId: string;
  serverId: string;
  externalId: string;
  username: string;
  email?: string;
  thumbUrl?: string;
  isServerAdmin?: boolean;
}): Promise<ServerUser> {
  const rows = await db
    .insert(serverUsers)
    .values({
      userId: data.userId,
      serverId: data.serverId,
      externalId: data.externalId,
      username: data.username,
      email: data.email ?? null,
      thumbUrl: data.thumbUrl ?? null,
      isServerAdmin: data.isServerAdmin ?? false,
    })
    .returning();
  return rows[0]!;
}

/**
 * Update server user from media server data
 */
export async function updateServerUser(
  serverUserId: string,
  data: Partial<{
    username: string;
    email: string | null;
    thumbUrl: string | null;
    isServerAdmin: boolean;
  }>
): Promise<ServerUser> {
  const rows = await db
    .update(serverUsers)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(serverUsers.id, serverUserId))
    .returning();

  const serverUser = rows[0];
  if (!serverUser) {
    throw new ServerUserNotFoundError(serverUserId);
  }
  return serverUser;
}

/**
 * Update server user trust score
 */
export async function updateServerUserTrustScore(
  serverUserId: string,
  trustScore: number
): Promise<ServerUser> {
  const rows = await db
    .update(serverUsers)
    .set({
      trustScore,
      updatedAt: new Date(),
    })
    .where(eq(serverUsers.id, serverUserId))
    .returning();

  const serverUser = rows[0];
  if (!serverUser) {
    throw new ServerUserNotFoundError(serverUserId);
  }
  return serverUser;
}

/**
 * Increment server user session count
 */
export async function incrementServerUserSessionCount(serverUserId: string): Promise<void> {
  await db
    .update(serverUsers)
    .set({
      sessionCount: sql`${serverUsers.sessionCount} + 1`,
    })
    .where(eq(serverUsers.id, serverUserId));
}

// ============================================================================
// Sync Operations (Creates both user identity and server user)
// ============================================================================

/**
 * Sync a user from media server - handles auto-linking by email
 *
 * Flow:
 * 1. Check if server_user exists by (serverId, externalId)
 * 2. If exists: update server_user
 * 3. If new:
 *    a. Try to find existing user identity by email match
 *    b. If no match: create new user identity
 *    c. Create server_user linked to user
 *
 * Returns { serverUser, user, created: boolean }
 */
export async function syncUserFromMediaServer(
  serverId: string,
  mediaUser: MediaUser
): Promise<{ serverUser: ServerUser; user: User; created: boolean }> {
  // Check for existing server user
  const existing = await getServerUserByExternalId(serverId, mediaUser.id);

  if (existing) {
    // Update existing server user
    const updated = await updateServerUser(existing.id, {
      username: mediaUser.username,
      email: mediaUser.email ?? null,
      thumbUrl: mediaUser.thumb ?? null,
      isServerAdmin: mediaUser.isAdmin,
    });

    const user = await requireUserById(existing.userId);
    return { serverUser: updated, user, created: false };
  }

  // Use transaction to prevent orphaned users if server user creation fails
  // This ensures atomicity: either both user + server_user are created, or neither
  const result = await db.transaction(async (tx) => {
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

    // No match - create new user identity
    if (!user) {
      const [newUser] = await tx
        .insert(users)
        .values({
          username: mediaUser.username, // Use media server username as identity username
          name: null,
          email: mediaUser.email ?? null,
          thumbnail: mediaUser.thumb ?? null,
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
        email: mediaUser.email ?? null,
        thumbUrl: mediaUser.thumb ?? null,
        isServerAdmin: mediaUser.isAdmin,
      })
      .returning();

    return { serverUser: serverUser!, user };
  });

  return { serverUser: result.serverUser, user: result.user, created: true };
}

/**
 * Batch sync users from media server
 * More efficient than individual syncs - uses batch lookups
 */
export async function batchSyncUsersFromMediaServer(
  serverId: string,
  mediaUsers: MediaUser[]
): Promise<{ added: number; updated: number }> {
  if (mediaUsers.length === 0) return { added: 0, updated: 0 };

  let added = 0;
  let updated = 0;

  for (const mediaUser of mediaUsers) {
    const result = await syncUserFromMediaServer(serverId, mediaUser);
    if (result.created) {
      added++;
    } else {
      updated++;
    }
  }

  return { added, updated };
}

// ============================================================================
// Aggregated User Operations (across all server users)
// ============================================================================

/**
 * Get user with stats (for user detail page)
 */
export async function getUserWithStats(userId: string): Promise<UserWithStats | null> {
  const user = await getUserById(userId);
  if (!user) return null;

  // Get all server users for this user
  const serverUserRows = await db
    .select({
      id: serverUsers.id,
      serverId: serverUsers.serverId,
      serverName: servers.name,
      serverType: servers.type,
      username: serverUsers.username,
      thumbUrl: serverUsers.thumbUrl,
      trustScore: serverUsers.trustScore,
      sessionCount: serverUsers.sessionCount,
    })
    .from(serverUsers)
    .innerJoin(servers, eq(serverUsers.serverId, servers.id))
    .where(eq(serverUsers.userId, userId));

  // Get aggregated stats across all server users
  const serverUserIds = serverUserRows.map((su) => su.id);
  let totalSessions = 0;
  let totalWatchTime = 0;

  if (serverUserIds.length > 0) {
    // Build explicit PostgreSQL array literal (Drizzle doesn't auto-convert JS arrays for ANY())
    const serverUserIdArray = sql.raw(
      `ARRAY[${serverUserIds.map((id) => `'${id}'::uuid`).join(',')}]`
    );
    const statsResult = await db
      .select({
        totalSessions: sql<number>`count(*)::int`,
        totalWatchTime: sql<number>`coalesce(sum(duration_ms), 0)::bigint`,
      })
      .from(sessions)
      .where(sql`${sessions.serverUserId} = ANY(${serverUserIdArray})`);

    const stats = statsResult[0];
    totalSessions = stats?.totalSessions ?? 0;
    totalWatchTime = Number(stats?.totalWatchTime ?? 0);
  }

  return {
    id: user.id,
    username: user.username,
    name: user.name,
    thumbnail: user.thumbnail,
    email: user.email,
    role: user.role,
    aggregateTrustScore: user.aggregateTrustScore,
    totalViolations: user.totalViolations,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    serverUsers: serverUserRows,
    stats: {
      totalSessions,
      totalWatchTime,
    },
  };
}

/**
 * Recalculate aggregate trust score for a user
 * Called by triggers when server_user trust scores change
 */
export async function recalculateAggregateTrustScore(userId: string): Promise<void> {
  // Calculate weighted average by session count
  const result = await db
    .select({
      weightedSum: sql<number>`coalesce(sum(${serverUsers.trustScore}::numeric * ${serverUsers.sessionCount}), 0)`,
      totalSessions: sql<number>`coalesce(sum(${serverUsers.sessionCount}), 0)`,
    })
    .from(serverUsers)
    .where(eq(serverUsers.userId, userId));

  const { weightedSum, totalSessions } = result[0] ?? { weightedSum: 0, totalSessions: 0 };

  // Calculate aggregate score (default to 100 if no sessions)
  const aggregateScore =
    totalSessions > 0 ? Math.round(Number(weightedSum) / Number(totalSessions)) : 100;

  await db
    .update(users)
    .set({
      aggregateTrustScore: aggregateScore,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
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
