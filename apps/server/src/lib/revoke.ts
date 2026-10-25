import { and, eq, inArray, ne, notExists } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  authAccounts,
  authSessions,
  mobileSessions,
  servers,
  serverUsers,
  users,
} from '../db/schema.js';
import { EmbyClient, JellyfinClient } from '../services/mediaServer/index.js';
import { createLogger } from '../utils/logger.js';
import { disconnectUserSockets } from '../websocket/index.js';
import { getAuth } from './auth.js';
import { memberStillValid } from './memberLogin.js';
import { clearScope } from './scope.js';

const log = createLogger('revoke');

// The owner passes no member gate, so nothing a gate change does may sign the owner out. Ids
// with no users row still go through: a merge has already deleted its source identity.
export async function revokeSessionsForUsers(userIds: string[]): Promise<void> {
  const requested = [...new Set(userIds)];
  if (requested.length === 0) return;
  const owners = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, requested), eq(users.role, 'owner')));
  const ids = requested.filter((id) => !owners.some((owner) => owner.id === id));
  if (ids.length === 0) return;

  // Deleting auth_sessions rows alone leaves the Redis copy better-auth reads first.
  const { internalAdapter } = await getAuth().$context;
  for (const id of ids) {
    await internalAdapter.deleteUserSessions(id);
    await clearScope(id);
    await disconnectUserSockets(id);
  }
  for (const id of ids) await logoutMemberTokens(id);
}

/**
 * Ends this person's browser sessions other than the one making the request. Paired phones keep
 * theirs: pairing is done from a browser that was already signed in, never through a media server.
 */
export async function revokeOtherWebSessions(
  userId: string,
  keepSessionId: string | undefined
): Promise<void> {
  const rows = await db
    .select({ token: authSessions.token })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.userId, userId),
        keepSessionId ? ne(authSessions.id, keepSessionId) : undefined,
        notExists(
          db
            .select({ id: mobileSessions.id })
            .from(mobileSessions)
            .where(eq(mobileSessions.betterAuthSessionId, authSessions.id))
        )
      )
    );
  if (rows.length === 0) return;
  const { internalAdapter } = await getAuth().$context;
  await internalAdapter.deleteSessions(rows.map((row) => row.token));
  // The client reconnects after a server-side disconnect, so only the ended sessions stay off.
  await disconnectUserSockets(userId);
}

/** Posts the server-side logout for each Jellyfin and Emby member token; failures are logged only. */
export async function logoutMemberTokens(userId: string): Promise<void> {
  const accounts = await db
    .select({ accountId: authAccounts.accountId, accessToken: authAccounts.accessToken })
    .from(authAccounts)
    .where(
      and(eq(authAccounts.userId, userId), inArray(authAccounts.providerId, ['jellyfin', 'emby']))
    );

  for (const account of accounts) {
    if (!account.accessToken) continue;
    const serverId = account.accountId.split(':')[0];
    if (!serverId) continue;
    try {
      const [server] = await db
        .select({ url: servers.url, type: servers.type })
        .from(servers)
        .where(eq(servers.id, serverId))
        .limit(1);
      if (!server) continue;
      const client = server.type === 'jellyfin' ? JellyfinClient : EmbyClient;
      await client.logoutUserToken(server.url, account.accessToken);
    } catch {
      log.warn('server-side logout failed', { userId, serverId });
    }
  }
}

/**
 * Signs out the people among these that a fresh sign-in would now refuse, by the same rule as the
 * daily refresh. Each person with a stored media server token costs a call to that server.
 */
export async function revokeUnlessStillIn(userIds: string[]): Promise<void> {
  const out: string[] = [];
  for (const id of new Set(userIds)) if (!(await memberStillValid(id))) out.push(id);
  await revokeSessionsForUsers(out);
}

export async function revokeSessionsForServerUsers(serverUserIds: string[]): Promise<void> {
  if (serverUserIds.length === 0) return;
  const rows = await db
    .select({ userId: serverUsers.userId })
    .from(serverUsers)
    .where(inArray(serverUsers.id, serverUserIds));
  await revokeUnlessStillIn(rows.map((r) => r.userId));
}

// better-auth caches the user object in each session's Redis snapshot; after a role change the
// snapshot keeps the old role until it is refreshed.
export async function refreshUserSessionSnapshots(userId: string): Promise<void> {
  const { internalAdapter } = await getAuth().$context;
  const user = await internalAdapter.findUserById(userId);
  if (user) await internalAdapter.refreshUserSessions(user);
}
