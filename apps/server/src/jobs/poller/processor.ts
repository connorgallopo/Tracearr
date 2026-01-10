/**
 * Session Processor
 *
 * Core processing logic for the poller:
 * - processServerSessions: Process sessions from a single server
 * - pollServers: Orchestrate polling across all servers
 * - Lifecycle management: start, stop, trigger
 */

import { eq, and, isNull, lte, inArray } from 'drizzle-orm';
import {
  POLLING_INTERVALS,
  SESSION_LIMITS,
  type ActiveSession,
  type SessionState,
  type Rule,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { servers, serverUsers, sessions, users } from '../../db/schema.js';
import { createMediaServerClient } from '../../services/mediaServer/index.js';
import { type GeoLocation } from '../../services/geoip.js';
import { lookupGeoIP } from '../../services/plexGeoip.js';
import type { CacheService, PubSubService } from '../../services/cache.js';
import { getGeoIPSettings } from '../../routes/settings.js';
import { sseManager } from '../../services/sseManager.js';

import type { PollerConfig, ServerWithToken, ServerProcessingResult } from './types.js';
import { mapMediaSession } from './sessionMapper.js';
import { batchGetRecentUserSessions, getActiveRules } from './database.js';
import {
  calculatePauseAccumulation,
  checkWatchCompletion,
  shouldForceStopStaleSession,
  detectMediaChange,
} from './stateTracker.js';
import { broadcastViolations } from './violations.js';
import {
  createSessionWithRulesAtomic,
  stopSessionAtomic,
  findActiveSession,
  buildActiveSession,
  processPollResults,
  handleMediaChangeAtomic,
} from './sessionLifecycle.js';
import { enqueueNotification } from '../notificationQueue.js';

// ============================================================================
// Module State
// ============================================================================

let pollingInterval: NodeJS.Timeout | null = null;
let staleSweepInterval: NodeJS.Timeout | null = null;
let cacheService: CacheService | null = null;
let pubSubService: PubSubService | null = null;

const defaultConfig: PollerConfig = {
  enabled: true,
  intervalMs: POLLING_INTERVALS.SESSIONS,
};

// ============================================================================
// Server Session Processing
// ============================================================================

/**
 * Process a single server's sessions
 *
 * This function:
 * 1. Fetches current sessions from the media server
 * 2. Creates/updates users as needed
 * 3. Creates new session records for new playbacks
 * 4. Updates existing sessions with state changes
 * 5. Marks stopped sessions as stopped
 * 6. Evaluates rules and creates violations
 *
 * @param server - Server to poll
 * @param activeRules - Active rules for evaluation
 * @param cachedSessionKeys - Set of currently cached session keys
 * @returns Processing results (new, updated, stopped sessions)
 */
async function processServerSessions(
  server: ServerWithToken,
  activeRules: Rule[],
  cachedSessionKeys: Set<string>
): Promise<ServerProcessingResult> {
  const newSessions: ActiveSession[] = [];
  const updatedSessions: ActiveSession[] = [];
  const currentSessionKeys = new Set<string>();

  // Get GeoIP settings once at the start
  const { usePlexGeoip } = await getGeoIPSettings();

  try {
    // Fetch sessions from server using unified adapter
    const client = createMediaServerClient({
      type: server.type,
      url: server.url,
      token: server.token,
    });
    const mediaSessions = await client.getSessions();
    const processedSessions = mediaSessions.map((s) => mapMediaSession(s, server.type));

    // OPTIMIZATION: Early return if no active sessions from media server
    if (processedSessions.length === 0) {
      // Still need to handle stopped sessions detection
      const stoppedSessionKeys: string[] = [];
      for (const cachedKey of cachedSessionKeys) {
        if (cachedKey.startsWith(`${server.id}:`)) {
          stoppedSessionKeys.push(cachedKey);

          // Mark session as stopped in database
          const sessionKey = cachedKey.replace(`${server.id}:`, '');
          const stoppedSession = await findActiveSession(server.id, sessionKey);

          if (stoppedSession) {
            const { wasUpdated } = await stopSessionAtomic({
              session: stoppedSession,
              stoppedAt: new Date(),
            });

            if (!wasUpdated) {
              const keyIndex = stoppedSessionKeys.indexOf(cachedKey);
              if (keyIndex > -1) {
                stoppedSessionKeys.splice(keyIndex, 1);
              }
            }
          }
        }
      }

      return { success: true, newSessions: [], stoppedSessionKeys, updatedSessions: [] };
    }

    // OPTIMIZATION: Only load server users that match active sessions (not all users for server)
    // Collect unique externalIds from current sessions
    const sessionExternalIds = [...new Set(processedSessions.map((s) => s.externalUserId))];

    const serverUsersList = await db
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
        identityName: users.name,
      })
      .from(serverUsers)
      .innerJoin(users, eq(serverUsers.userId, users.id))
      .where(
        and(
          eq(serverUsers.serverId, server.id),
          inArray(serverUsers.externalId, sessionExternalIds)
        )
      );

    // Build server user caches: externalId -> serverUser and id -> serverUser
    const serverUserByExternalId = new Map<string, (typeof serverUsersList)[0]>();
    const serverUserById = new Map<string, (typeof serverUsersList)[0]>();
    for (const serverUser of serverUsersList) {
      if (serverUser.externalId) {
        serverUserByExternalId.set(serverUser.externalId, serverUser);
      }
      serverUserById.set(serverUser.id, serverUser);
    }

    // Track server users that need to be created and their session indices
    const serverUsersToCreate: {
      externalId: string;
      username: string;
      thumbUrl: string | null;
      sessionIndex: number;
    }[] = [];

    // First pass: identify server users and resolve from cache or mark for creation
    const sessionServerUserIds: (string | null)[] = [];

    for (let i = 0; i < processedSessions.length; i++) {
      const processed = processedSessions[i]!;
      const existingServerUser = serverUserByExternalId.get(processed.externalUserId);

      if (existingServerUser) {
        // Check if server user data needs update
        const needsUpdate =
          existingServerUser.username !== processed.username ||
          (processed.userThumb && existingServerUser.thumbUrl !== processed.userThumb);

        if (needsUpdate) {
          await db
            .update(serverUsers)
            .set({
              username: processed.username,
              thumbUrl: processed.userThumb || existingServerUser.thumbUrl,
              updatedAt: new Date(),
            })
            .where(eq(serverUsers.id, existingServerUser.id));

          // Update cache
          existingServerUser.username = processed.username;
          if (processed.userThumb) existingServerUser.thumbUrl = processed.userThumb;
        }

        sessionServerUserIds.push(existingServerUser.id);
      } else {
        // Need to create server user - mark for batch creation
        serverUsersToCreate.push({
          externalId: processed.externalUserId,
          username: processed.username,
          thumbUrl: processed.userThumb || null,
          sessionIndex: i,
        });
        sessionServerUserIds.push(null); // Will be filled after creation
      }
    }

    // Batch create new server users (and their identity users)
    if (serverUsersToCreate.length > 0) {
      // First, create identity users for each new server user
      const newIdentityUsers = await db
        .insert(users)
        .values(
          serverUsersToCreate.map((u) => ({
            username: u.username, // Login identifier
            name: u.username, // Use username as initial display name
            thumbnail: u.thumbUrl,
          }))
        )
        .returning();

      // Then create server users linked to the identity users
      const newServerUsers = await db
        .insert(serverUsers)
        .values(
          serverUsersToCreate.map((u, idx) => ({
            userId: newIdentityUsers[idx]!.id,
            serverId: server.id,
            externalId: u.externalId,
            username: u.username,
            thumbUrl: u.thumbUrl,
          }))
        )
        .returning();

      // Update sessionServerUserIds with newly created server user IDs
      for (let i = 0; i < serverUsersToCreate.length; i++) {
        const serverUserToCreate = serverUsersToCreate[i]!;
        const newServerUser = newServerUsers[i];
        const newIdentityUser = newIdentityUsers[i];
        if (newServerUser && newIdentityUser) {
          sessionServerUserIds[serverUserToCreate.sessionIndex] = newServerUser.id;
          // Add to cache with identityName from the identity user
          const serverUserWithIdentity = {
            ...newServerUser,
            identityName: newIdentityUser.name,
          };
          serverUserById.set(newServerUser.id, serverUserWithIdentity);
          serverUserByExternalId.set(serverUserToCreate.externalId, serverUserWithIdentity);
        }
      }
    }

    // OPTIMIZATION: Batch load recent sessions for rule evaluation
    // Only load for server users with new sessions (not cached)
    const serverUsersWithNewSessions = new Set<string>();
    for (let i = 0; i < processedSessions.length; i++) {
      const processed = processedSessions[i]!;
      const sessionKey = `${server.id}:${processed.sessionKey}`;
      const isNew = !cachedSessionKeys.has(sessionKey);
      const serverUserId = sessionServerUserIds[i];
      if (isNew && serverUserId) {
        serverUsersWithNewSessions.add(serverUserId);
      }
    }

    const recentSessionsMap = await batchGetRecentUserSessions([...serverUsersWithNewSessions]);

    // Process each session
    for (let i = 0; i < processedSessions.length; i++) {
      const processed = processedSessions[i]!;
      const sessionKey = `${server.id}:${processed.sessionKey}`;
      currentSessionKeys.add(sessionKey);

      const serverUserId = sessionServerUserIds[i];
      if (!serverUserId) {
        console.error('Failed to get/create server user for session');
        continue;
      }

      // Get server user details from cache
      const serverUserFromCache = serverUserById.get(serverUserId);
      const userDetail = serverUserFromCache
        ? {
            id: serverUserFromCache.id,
            username: serverUserFromCache.username,
            thumbUrl: serverUserFromCache.thumbUrl,
            identityName: serverUserFromCache.identityName,
          }
        : { id: serverUserId, username: 'Unknown', thumbUrl: null, identityName: null };

      // Get GeoIP location (uses Plex API if enabled, falls back to MaxMind)
      const geo: GeoLocation = await lookupGeoIP(processed.ipAddress, usePlexGeoip);

      const isNew = !cachedSessionKeys.has(sessionKey);

      if (isNew) {
        // Distributed lock prevents race condition with SSE
        if (!cacheService) {
          console.warn('[Poller] Cache service not available, skipping session creation');
          continue;
        }

        const recentSessions = recentSessionsMap.get(serverUserId) ?? [];

        const createResult = await cacheService.withSessionCreateLock(
          server.id,
          processed.sessionKey,
          async () => {
            const existingWithSameKey = await findActiveSession(server.id, processed.sessionKey);

            if (existingWithSameKey) {
              cachedSessionKeys.add(sessionKey);
              console.log(
                `[Poller] Active session already exists for ${processed.sessionKey}, skipping create`
              );
              return null;
            }

            if (processed.ratingKey && userDetail?.id) {
              const [existingForContent] = await db
                .select({ id: sessions.id, sessionKey: sessions.sessionKey })
                .from(sessions)
                .where(
                  and(
                    eq(sessions.serverUserId, userDetail.id),
                    eq(sessions.ratingKey, processed.ratingKey),
                    isNull(sessions.stoppedAt)
                  )
                )
                .limit(1);

              if (existingForContent) {
                console.log(
                  `[Poller] Session_key ${processed.sessionKey} is new, but active session ${existingForContent.id} exists for same content (key: ${existingForContent.sessionKey}). Skipping duplicate.`
                );
                // Add both session keys to cache
                cachedSessionKeys.add(sessionKey);
                cachedSessionKeys.add(`${server.id}:${existingForContent.sessionKey}`);
                return null;
              }
            }

            const result = await createSessionWithRulesAtomic({
              processed,
              server: { id: server.id, name: server.name, type: server.type },
              serverUser: userDetail,
              geo,
              activeRules,
              recentSessions,
            });

            if (result.qualityChange) {
              const { stoppedSession } = result.qualityChange;

              if (cacheService) {
                await cacheService.removeActiveSession(stoppedSession.id);
                await cacheService.removeUserSession(
                  stoppedSession.serverUserId,
                  stoppedSession.id
                );
              }

              if (pubSubService) {
                await pubSubService.publish('session:stopped', stoppedSession.id);
              }

              // Prevent "stale" detection for this session
              cachedSessionKeys.delete(`${server.id}:${stoppedSession.sessionKey}`);
            }

            return {
              insertedSession: result.insertedSession,
              violationResults: result.violationResults,
            };
          }
        );

        if (!createResult) {
          continue;
        }

        const { insertedSession, violationResults } = createResult;

        const activeSession = buildActiveSession({
          session: insertedSession,
          processed,
          user: userDetail,
          geo,
          server,
        });

        newSessions.push(activeSession);

        // Broadcast violations AFTER transaction commits (outside transaction)
        // Wrapped in try-catch to prevent broadcast failures from crashing the poller
        try {
          await broadcastViolations(violationResults, insertedSession.id, pubSubService);
        } catch (err) {
          console.error('[Poller] Failed to broadcast violations:', err);
          // Violations are already persisted in DB, broadcast failure is non-fatal
        }
      } else {
        // Get existing ACTIVE session to check for state changes
        const existingSession = await findActiveSession(server.id, processed.sessionKey);
        if (!existingSession) {
          // Issue #120: Stale cache entry - session key is in Redis but no active session exists in DB
          // Remove stale cache entry and create session with proper locking to prevent duplicates.
          console.log(
            `[Poller] Stale cache detected for ${processed.sessionKey} - removing from cache`
          );
          cachedSessionKeys.delete(sessionKey);

          // Use distributed lock to prevent race condition with SSE
          if (!cacheService) {
            console.warn('[Poller] Cache service not available, skipping stale session recovery');
            continue;
          }

          let recentSessions = recentSessionsMap.get(serverUserId);
          if (!recentSessions && serverUserId) {
            const recentForUser = await batchGetRecentUserSessions([serverUserId]);
            recentSessions = recentForUser.get(serverUserId) ?? [];
            recentSessionsMap.set(serverUserId, recentSessions);
          }
          recentSessions = recentSessions ?? [];

          const createResult = await cacheService.withSessionCreateLock(
            server.id,
            processed.sessionKey,
            async () => {
              // Double-check inside lock - SSE might have created it
              const existingWithSameKey = await findActiveSession(server.id, processed.sessionKey);
              if (existingWithSameKey) {
                cachedSessionKeys.add(sessionKey);
                console.log(
                  `[Poller] Session created by SSE for ${processed.sessionKey}, skipping`
                );
                return null;
              }

              // Issue #121: Check if there's already an active session for same user+content
              // with a DIFFERENT session_key. This happens when Plex reassigns session keys
              // during transcoder restarts or quality changes. We should NOT create a new
              // session (which triggers quality change detection) - instead, just update cache.
              if (processed.ratingKey && userDetail?.id) {
                const [existingForContent] = await db
                  .select({ id: sessions.id, sessionKey: sessions.sessionKey })
                  .from(sessions)
                  .where(
                    and(
                      eq(sessions.serverUserId, userDetail.id),
                      eq(sessions.ratingKey, processed.ratingKey),
                      isNull(sessions.stoppedAt)
                    )
                  )
                  .limit(1);

                if (existingForContent) {
                  console.log(
                    `[Poller] Stale session_key ${processed.sessionKey} but active session ${existingForContent.id} exists for same content (key: ${existingForContent.sessionKey}). Skipping duplicate creation.`
                  );
                  // Add both session keys to cache to prevent future stale detection
                  cachedSessionKeys.add(sessionKey);
                  cachedSessionKeys.add(`${server.id}:${existingForContent.sessionKey}`);
                  return null;
                }
              }

              return createSessionWithRulesAtomic({
                processed,
                server: { id: server.id, name: server.name, type: server.type },
                serverUser: userDetail,
                geo,
                activeRules,
                recentSessions,
              });
            }
          );

          if (createResult) {
            const { insertedSession, violationResults } = createResult;
            const activeSession = buildActiveSession({
              session: insertedSession,
              processed,
              user: userDetail,
              geo,
              server,
            });
            newSessions.push(activeSession);
            cachedSessionKeys.add(sessionKey);

            try {
              await broadcastViolations(violationResults, insertedSession.id, pubSubService);
            } catch (err) {
              console.error('[Poller] Failed to broadcast violations:', err);
            }
          }
          continue;
        }

        // Issue #57: Detect media change (e.g., Emby "Play Next Episode")
        // When Emby plays next episode, it reuses sessionKey but changes ratingKey.
        // Stop old session and create new one for proper play count tracking.
        if (detectMediaChange(existingSession.ratingKey, processed.ratingKey)) {
          const recentSessions = recentSessionsMap.get(serverUserId) ?? [];

          const mediaChangeResult = await handleMediaChangeAtomic({
            existingSession,
            processed,
            server: { id: server.id, name: server.name, type: server.type },
            serverUser: userDetail,
            geo,
            activeRules,
            recentSessions,
          });

          if (mediaChangeResult) {
            const { stoppedSession, insertedSession, violationResults } = mediaChangeResult;

            // Update cache for stopped session
            if (cacheService) {
              await cacheService.removeActiveSession(stoppedSession.id);
              await cacheService.removeUserSession(stoppedSession.serverUserId, stoppedSession.id);
            }
            if (pubSubService) {
              await pubSubService.publish('session:stopped', stoppedSession.id);
            }

            // Build and add new session
            const activeSession = buildActiveSession({
              session: insertedSession,
              processed,
              user: userDetail,
              geo,
              server,
            });
            newSessions.push(activeSession);

            // Mark as cached within this poll cycle to prevent duplicate processing
            cachedSessionKeys.add(sessionKey);

            // Broadcast violations for new session
            try {
              await broadcastViolations(violationResults, insertedSession.id, pubSubService);
            } catch (err) {
              console.error('[Poller] Failed to broadcast violations:', err);
            }
          }

          continue; // Skip normal update path
        }

        const previousState = existingSession.state;
        const newState = processed.state;
        const now = new Date();

        const updatePayload: {
          state: 'playing' | 'paused';
          quality: string;
          bitrate: number;
          progressMs: number | null;
          lastSeenAt: Date;
          plexSessionId?: string | null;
          lastPausedAt?: Date | null;
          pausedDurationMs?: number;
          watched?: boolean;
          isTranscode: boolean;
          videoDecision: string;
          audioDecision: string;
        } = {
          state: newState,
          quality: processed.quality,
          bitrate: processed.bitrate,
          progressMs: processed.progressMs || null,
          lastSeenAt: now,
          plexSessionId: processed.plexSessionId || null,
          isTranscode: processed.isTranscode,
          videoDecision: processed.videoDecision,
          audioDecision: processed.audioDecision,
        };

        const pauseResult = calculatePauseAccumulation(
          previousState as SessionState,
          newState,
          {
            lastPausedAt: existingSession.lastPausedAt,
            pausedDurationMs: existingSession.pausedDurationMs || 0,
          },
          now
        );
        updatePayload.lastPausedAt = pauseResult.lastPausedAt;
        updatePayload.pausedDurationMs = pauseResult.pausedDurationMs;

        // Check for watch completion (80% threshold)
        if (
          !existingSession.watched &&
          checkWatchCompletion(processed.progressMs, processed.totalDurationMs)
        ) {
          updatePayload.watched = true;
        }

        // Update existing session with state changes and pause tracking
        await db.update(sessions).set(updatePayload).where(eq(sessions.id, existingSession.id));

        // Build active session for cache/broadcast (with updated pause tracking values)
        const activeSession = buildActiveSession({
          session: existingSession,
          processed,
          user: userDetail,
          geo,
          server,
          overrides: {
            state: newState,
            lastPausedAt: updatePayload.lastPausedAt ?? existingSession.lastPausedAt,
            pausedDurationMs:
              updatePayload.pausedDurationMs ?? existingSession.pausedDurationMs ?? 0,
            watched: updatePayload.watched ?? existingSession.watched ?? false,
          },
        });
        updatedSessions.push(activeSession);
      }
    }

    // Find stopped sessions
    const stoppedSessionKeys: string[] = [];
    for (const cachedKey of cachedSessionKeys) {
      if (cachedKey.startsWith(`${server.id}:`) && !currentSessionKeys.has(cachedKey)) {
        // Mark session as stopped in database
        const sessionKey = cachedKey.replace(`${server.id}:`, '');
        const stoppedSession = await findActiveSession(server.id, sessionKey);

        if (stoppedSession) {
          const { wasUpdated } = await stopSessionAtomic({
            session: stoppedSession,
            stoppedAt: new Date(),
          });

          if (wasUpdated) {
            stoppedSessionKeys.push(cachedKey);
          }
        }
      }
    }

    return { success: true, newSessions, stoppedSessionKeys, updatedSessions };
  } catch (error) {
    console.error(`Error polling server ${server.name}:`, error);
    return { success: false, newSessions: [], stoppedSessionKeys: [], updatedSessions: [] };
  }
}

// ============================================================================
// Main Polling Orchestration
// ============================================================================

/**
 * Poll all connected servers for active sessions
 *
 * With SSE integration:
 * - Plex servers with active SSE connections are skipped (handled by SSE)
 * - Plex servers in fallback mode are polled
 * - Jellyfin/Emby servers are always polled (no SSE support)
 */
async function pollServers(): Promise<void> {
  try {
    // Get all connected servers
    const allServers = await db.select().from(servers);

    if (allServers.length === 0) {
      return;
    }

    // Filter to only servers that need polling
    // SSE-connected Plex servers are handled by SSE, not polling
    const serversNeedingPoll = allServers.filter((server) => {
      // Non-Plex servers always need polling (Jellyfin/Emby don't support SSE yet)
      if (server.type !== 'plex') {
        return true;
      }
      // Plex servers in fallback mode need polling
      return sseManager.isInFallback(server.id);
    });

    if (serversNeedingPoll.length === 0) {
      // All Plex servers are connected via SSE, no polling needed
      return;
    }

    // Get cached session keys from atomic SET-based cache
    const cachedSessions = cacheService ? await cacheService.getAllActiveSessions() : [];
    const cachedSessionKeys = new Set(cachedSessions.map((s) => `${s.serverId}:${s.sessionKey}`));

    // Get active rules
    const activeRules = await getActiveRules();

    // Collect results from all servers
    const allNewSessions: ActiveSession[] = [];
    const allStoppedKeys: string[] = [];
    const allUpdatedSessions: ActiveSession[] = [];

    // Process each server with health tracking
    for (const server of serversNeedingPoll) {
      const serverWithToken = server as ServerWithToken;

      // Get previous health state for transition detection
      const wasHealthy = cacheService ? await cacheService.getServerHealth(server.id) : null;

      const { success, newSessions, stoppedSessionKeys, updatedSessions } =
        await processServerSessions(serverWithToken, activeRules, cachedSessionKeys);

      // Track health state and notify on transitions
      if (cacheService) {
        await cacheService.setServerHealth(server.id, success);

        // Detect health state transitions
        if (wasHealthy === true && !success) {
          // Server went down - notify
          console.log(`[Poller] Server ${server.name} is DOWN`);
          await enqueueNotification({
            type: 'server_down',
            payload: { serverName: server.name, serverId: server.id },
          });
        } else if (wasHealthy === false && success) {
          // Server came back up - notify
          console.log(`[Poller] Server ${server.name} is back UP`);
          await enqueueNotification({
            type: 'server_up',
            payload: { serverName: server.name, serverId: server.id },
          });
        }
        // wasHealthy === null means first poll, don't notify
      }

      allNewSessions.push(...newSessions);
      allStoppedKeys.push(...stoppedSessionKeys);
      allUpdatedSessions.push(...updatedSessions);
    }

    await processPollResults({
      newSessions: allNewSessions,
      stoppedKeys: allStoppedKeys,
      updatedSessions: allUpdatedSessions,
      cachedSessions,
      cacheService,
      pubSubService,
      enqueueNotification,
    });

    if (allNewSessions.length > 0 || allStoppedKeys.length > 0) {
      console.log(
        `Poll complete: ${allNewSessions.length} new, ${allUpdatedSessions.length} updated, ${allStoppedKeys.length} stopped`
      );
    }

    // Sweep for stale sessions that haven't been seen in a while
    // This catches sessions where server went down or SSE missed the stop event
    await sweepStaleSessions();
  } catch (error) {
    console.error('Polling error:', error);
  }
}

// ============================================================================
// Stale Session Detection
// ============================================================================

/**
 * Sweep for stale sessions and force-stop them
 *
 * A session is considered stale when:
 * - It hasn't been stopped (stoppedAt IS NULL)
 * - It hasn't been seen in a poll for > STALE_SESSION_TIMEOUT_SECONDS (default 5 min)
 *
 * This catches sessions where:
 * - Server became unreachable during playback
 * - SSE connection dropped and we missed the stop event
 * - The session hung on the media server side
 *
 * Stale sessions are marked with forceStopped = true to distinguish from normal stops.
 * Sessions with insufficient play time (< MIN_PLAY_TIME_MS) are still recorded for
 * audit purposes but can be filtered from stats queries.
 */
export async function sweepStaleSessions(): Promise<number> {
  try {
    // Calculate the stale threshold (sessions not seen in last 5 minutes)
    const staleThreshold = new Date(
      Date.now() - SESSION_LIMITS.STALE_SESSION_TIMEOUT_SECONDS * 1000
    );

    // Find all active sessions that haven't been seen recently
    const staleSessions = await db
      .select()
      .from(sessions)
      .where(
        and(
          isNull(sessions.stoppedAt), // Still active
          lte(sessions.lastSeenAt, staleThreshold) // Not seen recently
        )
      );

    if (staleSessions.length === 0) {
      return 0;
    }

    console.log(`[Poller] Force-stopping ${staleSessions.length} stale session(s)`);

    const now = new Date();

    for (const staleSession of staleSessions) {
      // Check if session should be force-stopped (using the stateTracker function)
      if (!shouldForceStopStaleSession(staleSession.lastSeenAt)) {
        // Shouldn't happen since we already filtered, but double-check
        continue;
      }

      const { wasUpdated } = await stopSessionAtomic({
        session: staleSession,
        stoppedAt: now,
        forceStopped: true,
      });

      if (!wasUpdated) {
        continue;
      }

      if (cacheService) {
        await cacheService.removeActiveSession(staleSession.id);
        await cacheService.removeUserSession(staleSession.serverUserId, staleSession.id);
      }

      if (pubSubService) {
        await pubSubService.publish('session:stopped', staleSession.id);
      }
    }

    // Invalidate dashboard stats after force-stopping sessions
    if (cacheService) {
      await cacheService.invalidateDashboardStatsCache();
    }

    return staleSessions.length;
  } catch (error) {
    console.error('[Poller] Error sweeping stale sessions:', error);
    return 0;
  }
}

// ============================================================================
// Lifecycle Management
// ============================================================================

/**
 * Initialize the poller with cache services
 */
export function initializePoller(cache: CacheService, pubSub: PubSubService): void {
  cacheService = cache;
  pubSubService = pubSub;
}

/**
 * Start the polling job
 */
export function startPoller(config: Partial<PollerConfig> = {}): void {
  const mergedConfig = { ...defaultConfig, ...config };

  if (!mergedConfig.enabled) {
    console.log('Session poller disabled');
    return;
  }

  if (pollingInterval) {
    console.log('Poller already running');
    return;
  }

  console.log(`Starting session poller with ${mergedConfig.intervalMs}ms interval`);

  // Run immediately on start
  void pollServers();

  // Then run on interval
  pollingInterval = setInterval(() => void pollServers(), mergedConfig.intervalMs);

  // Start stale session sweep (runs every 60 seconds to detect abandoned sessions)
  if (!staleSweepInterval) {
    console.log(
      `Starting stale session sweep with ${SESSION_LIMITS.STALE_SWEEP_INTERVAL_MS}ms interval`
    );
    staleSweepInterval = setInterval(
      () => void sweepStaleSessions(),
      SESSION_LIMITS.STALE_SWEEP_INTERVAL_MS
    );
  }
}

/**
 * Stop the polling job
 */
export function stopPoller(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log('Session poller stopped');
  }
  if (staleSweepInterval) {
    clearInterval(staleSweepInterval);
    staleSweepInterval = null;
    console.log('Stale session sweep stopped');
  }
}

/**
 * Force an immediate poll
 */
export async function triggerPoll(): Promise<void> {
  await pollServers();
}

/**
 * Reconciliation poll for SSE-connected servers
 *
 * This is a lighter poll that runs periodically to catch any events
 * that might have been missed by SSE. Only polls Plex servers that
 * have active SSE connections (not in fallback mode).
 *
 * Unlike the main poller, this processes results and updates the cache
 * to sync any sessions that SSE may have missed.
 */
export async function triggerReconciliationPoll(): Promise<void> {
  try {
    // Get all Plex servers with active SSE connections
    const allServers = await db.select().from(servers);
    const sseServers = allServers.filter(
      (server) => server.type === 'plex' && !sseManager.isInFallback(server.id)
    );

    if (sseServers.length === 0) {
      return;
    }

    console.log(
      `[Poller] Running reconciliation poll for ${sseServers.length} SSE-connected server(s)`
    );

    // Get cached session keys from atomic SET-based cache
    const cachedSessions = cacheService ? await cacheService.getAllActiveSessions() : [];
    const cachedSessionKeys = new Set(cachedSessions.map((s) => `${s.serverId}:${s.sessionKey}`));

    // Get active rules
    const activeRules = await getActiveRules();

    // Collect results from all SSE servers
    const allNewSessions: ActiveSession[] = [];
    const allStoppedKeys: string[] = [];
    const allUpdatedSessions: ActiveSession[] = [];

    // Process each SSE server and collect results
    for (const server of sseServers) {
      const serverWithToken = server as ServerWithToken;
      const { newSessions, stoppedSessionKeys, updatedSessions } = await processServerSessions(
        serverWithToken,
        activeRules,
        cachedSessionKeys
      );
      allNewSessions.push(...newSessions);
      allStoppedKeys.push(...stoppedSessionKeys);
      allUpdatedSessions.push(...updatedSessions);
    }

    if (allNewSessions.length > 0 || allStoppedKeys.length > 0 || allUpdatedSessions.length > 0) {
      await processPollResults({
        newSessions: allNewSessions,
        stoppedKeys: allStoppedKeys,
        updatedSessions: allUpdatedSessions,
        cachedSessions,
        cacheService,
        pubSubService,
        enqueueNotification,
      });

      console.log(
        `[Poller] Reconciliation complete: ${allNewSessions.length} new, ${allUpdatedSessions.length} updated, ${allStoppedKeys.length} stopped`
      );
    }
  } catch (error) {
    console.error('[Poller] Reconciliation poll error:', error);
  }
}
