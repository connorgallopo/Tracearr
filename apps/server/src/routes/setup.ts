/**
 * Setup routes - Check if Tracearr has been configured
 */

import type { FastifyPluginAsync } from 'fastify';
import { and, isNotNull, isNull, eq } from 'drizzle-orm';
import {
  assertNever,
  setupStatusQuerySchema,
  type ServerType,
  type SetupStatus,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, users } from '../db/schema.js';
import { isClaimCodeEnabled } from '../utils/claimCode.js';
import { mediaSignInClosed, openToMemberSignIn, usableLoginMethods } from '../lib/authGuards.js';
import { JellyfinClient } from '../services/mediaServer/index.js';

// The status route is public, so each hit must not become a request to every Jellyfin server.
const QUICK_CONNECT_TTL_MS = 60_000;
const quickConnectCache = new Map<string, { enabled: boolean; checkedAt: number }>();

async function quickConnectEnabled(url: string): Promise<boolean> {
  const cached = quickConnectCache.get(url);
  if (cached && Date.now() - cached.checkedAt < QUICK_CONNECT_TTL_MS) return cached.enabled;
  const enabled = await JellyfinClient.quickConnectEnabled(url);
  quickConnectCache.set(url, { enabled, checkedAt: Date.now() });
  return enabled;
}

/** Quick Connect is a Jellyfin feature; Plex and Emby have nothing like it. */
async function offersQuickConnect(type: ServerType, url: string): Promise<boolean> {
  switch (type) {
    case 'jellyfin':
      return quickConnectEnabled(url);
    case 'plex':
    case 'emby':
      return false;
    default:
      return assertNever(type);
  }
}

export const setupRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /setup/status - Check Tracearr configuration status
   *
   * This endpoint is public (no auth required) so the frontend
   * can determine whether to show the setup wizard or login page.
   *
   * Returns:
   * - needsSetup: true if no owner accounts exist
   * - requiresClaimCode: true if first-time setup requires a claim code
   * - hasServers: true if at least one server is configured
   * - hasPasswordAuth: true if at least one user has password login enabled
   */
  app.get('/status', async (request, reply): Promise<SetupStatus> => {
    const query = setupStatusQuerySchema.safeParse(request.query);
    if (!query.success) return reply.badRequest('Invalid query parameters');
    // ?all only changes what the login page offers, never who gets in: every server someone could
    // sign in through, including one only an Allow person can use, and the password and Plex
    // sign-in that SSO-only hides.
    const all = query.data.all !== undefined;

    // Check for servers and users in parallel
    const [serverList, jellyfinServerList, ownerList, passwordUserList] = await Promise.all([
      db.select({ id: servers.id }).from(servers).limit(1),
      db.select({ id: servers.id }).from(servers).where(eq(servers.type, 'jellyfin')).limit(1),
      db.select({ id: users.id }).from(users).where(eq(users.role, 'owner')).limit(1),
      db.select({ id: users.id }).from(users).where(isNotNull(users.passwordHash)).limit(1),
    ]);

    const needsSetup = ownerList.length === 0;

    const [usable, mediaClosed] = await Promise.all([usableLoginMethods(), mediaSignInClosed()]);
    // Hidden, not refused: an owner or admin whose identity provider is down signs in at ?all.
    const ssoOnly = mediaClosed && usable.oidc && !needsSetup && !all;
    const loginServers =
      !mediaClosed && (all || usable.member)
        ? await db
            .select({ id: servers.id, name: servers.name, type: servers.type, url: servers.url })
            .from(servers)
            .where(
              all
                ? openToMemberSignIn
                : and(eq(servers.allowMemberLogin, true), isNull(servers.historicalAt))
            )
            .orderBy(servers.displayOrder)
        : [];
    const memberLoginServers = await Promise.all(
      loginServers.map(async ({ url, ...server }) => ({
        ...server,
        quickConnect: await offersQuickConnect(server.type, url),
      }))
    );

    return {
      needsSetup,
      requiresClaimCode: needsSetup && isClaimCodeEnabled(), // Claim code required only if enabled and setup needed
      hasServers: serverList.length > 0,
      hasJellyfinServers: jellyfinServerList.length > 0,
      hasPasswordAuth: passwordUserList.length > 0,
      // needsSetup keeps first-run sign-up reachable before any owner exists.
      authMethods: {
        local: needsSetup || (usable.local && !ssoOnly),
        plex: needsSetup || (usable.plex && !ssoOnly),
        oidc: usable.oidc,
        oidcProviderName: usable.oidc ? (process.env.OIDC_PROVIDER_NAME ?? 'SSO') : null,
        member: all ? loginServers.length > 0 : usable.member,
        ssoOnly,
      },
      memberLoginServers,
    };
  });
};
