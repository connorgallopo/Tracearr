/**
 * Session Processor
 *
 * Core processing logic for the poller:
 * - processServerSessions: Process sessions from a single server
 * - pollServers: Orchestrate polling across all servers
 * - Lifecycle management: start, stop, trigger
 */

import { eq, and, desc, isNull, gte, lte, inArray } from 'drizzle-orm';
import {
  POLLING_INTERVALS,
  TIME_MS,
  SESSION_LIMITS,
  type ActiveSession,
  type SessionState,
  type Rule,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { servers, serverUsers, sessions, users } from '../../db/schema.js';
import { createMediaServerClient } from '../../services/mediaServer/index.js';
import { geoipService, type GeoLocation } from '../../services/geoip.js';
import { ruleEngine } from '../../services/rules.js';
import type { CacheService, PubSubService } from '../../services/cache.js';
import { sseManager } from '../../services/sseManager.js';

import type { PollerConfig, ServerWithToken, ServerProcessingResult } from './types.js';
import { mapMediaSession } from './sessionMapper.js';
import { batchGetRecentUserSessions, getActiveRules } from './database.js';
import {
  calculatePauseAccumulation,
  calculateStopDuration,
  checkWatchCompletion,
  shouldForceStopStaleSession,
  shouldRecordSession,
} from './stateTracker.js';
import {
  createViolationInTransaction,
  broadcastViolations,
  doesRuleApplyToUser,
  isDuplicateViolation,
  type ViolationInsertResult,
} from './violations.js';
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
          const stoppedRows = await db
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.serverId, server.id),
                eq(sessions.sessionKey, sessionKey),
                isNull(sessions.stoppedAt)
              )
            )
            .limit(1);

          const stoppedSession = stoppedRows[0];
          if (stoppedSession) {
            const stoppedAt = new Date();
            const { durationMs, finalPausedDurationMs } = calculateStopDuration(
              {
                startedAt: stoppedSession.startedAt,
                lastPausedAt: stoppedSession.lastPausedAt,
                pausedDurationMs: stoppedSession.pausedDurationMs || 0,
              },
              stoppedAt
            );
            const watched =
              stoppedSession.watched ||
              checkWatchCompletion(stoppedSession.progressMs, stoppedSession.totalDurationMs);

            await db
              .update(sessions)
              .set({
                state: 'stopped',
                stoppedAt,
                durationMs,
                pausedDurationMs: finalPausedDurationMs,
                lastPausedAt: null,
                watched,
              })
              .where(eq(sessions.id, stoppedSession.id));
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

      // Get GeoIP location
      const geo: GeoLocation = geoipService.lookup(processed.ipAddress);

      const isNew = !cachedSessionKeys.has(sessionKey);

      if (isNew) {
        // RACE CONDITION CHECK: Verify no active session exists with this sessionKey
        // This can happen when SSE and poller both try to create a session simultaneously
        const existingWithSameKey = await db
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.serverId, server.id),
              eq(sessions.sessionKey, processed.sessionKey),
              isNull(sessions.stoppedAt)
            )
          )
          .limit(1);

        if (existingWithSameKey.length > 0) {
          // Session already exists (likely created by SSE), skip insert
          // Add to cache so we don't check again next poll
          cachedSessionKeys.add(sessionKey);
          console.log(
            `[Poller] Active session already exists for ${processed.sessionKey}, skipping create`
          );
          continue;
        }

        // Check for session grouping - find recent unfinished session with same serverUser+ratingKey
        let referenceId: string | null = null;

        // FIRST: Check if there's an ACTIVE session for the same user+content
        // This handles quality changes mid-stream where Plex assigns a new sessionKey
        if (processed.ratingKey) {
          const activeSameContent = await db
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.serverUserId, serverUserId),
                eq(sessions.ratingKey, processed.ratingKey),
                isNull(sessions.stoppedAt) // Still active
              )
            )
            .orderBy(desc(sessions.startedAt))
            .limit(1);

          const existingActiveSession = activeSameContent[0];
          if (existingActiveSession) {
            // This is a quality/resolution change during playback
            // Stop the old session and link the new one
            const now = new Date();
            const { durationMs, finalPausedDurationMs } = calculateStopDuration(
              {
                startedAt: existingActiveSession.startedAt,
                lastPausedAt: existingActiveSession.lastPausedAt,
                pausedDurationMs: existingActiveSession.pausedDurationMs || 0,
              },
              now
            );

            await db
              .update(sessions)
              .set({
                state: 'stopped',
                stoppedAt: now,
                durationMs,
                pausedDurationMs: finalPausedDurationMs,
                lastPausedAt: null,
                // Keep watched=false since playback is continuing
              })
              .where(eq(sessions.id, existingActiveSession.id));

            // Remove from cache
            if (cacheService) {
              await cacheService.deleteSessionById(existingActiveSession.id);
              await cacheService.removeUserSession(
                existingActiveSession.serverUserId,
                existingActiveSession.id
              );
            }

            // Publish stop event for the old session
            if (pubSubService) {
              await pubSubService.publish('session:stopped', existingActiveSession.id);
            }

            // Remove from cached session keys to prevent "stale" detection for this server
            cachedSessionKeys.delete(`${server.id}:${existingActiveSession.sessionKey}`);

            // Link to the original session chain
            referenceId = existingActiveSession.referenceId || existingActiveSession.id;

            console.log(
              `[Poller] Quality change detected for user ${serverUserId}, content ${processed.ratingKey}. Old session ${existingActiveSession.id} stopped, linking new session.`
            );
          }
        }

        // SECOND: Check for recently stopped sessions (resume tracking)
        if (!referenceId && processed.ratingKey) {
          const oneDayAgo = new Date(Date.now() - TIME_MS.DAY);
          const recentSameContent = await db
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.serverUserId, serverUserId),
                eq(sessions.ratingKey, processed.ratingKey),
                gte(sessions.stoppedAt, oneDayAgo),
                eq(sessions.watched, false) // Not fully watched
              )
            )
            .orderBy(desc(sessions.stoppedAt))
            .limit(1);

          const previousSession = recentSameContent[0];
          // If user is resuming (progress >= previous), link to the original session
          if (previousSession && processed.progressMs !== undefined) {
            const prevProgress = previousSession.progressMs || 0;
            if (processed.progressMs >= prevProgress) {
              // This is a "resume" - link to the first session in the chain
              referenceId = previousSession.referenceId || previousSession.id;
            }
          }
        }

        // Use transaction to ensure session insert + rule evaluation + violation creation are atomic
        // This prevents orphaned sessions without violations on crash
        const recentSessions = recentSessionsMap.get(serverUserId) ?? [];

        const { insertedSession, violationResults } = await db.transaction(async (tx) => {
          // Insert new session with pause tracking fields
          const insertedRows = await tx
            .insert(sessions)
            .values({
              serverId: server.id,
              serverUserId,
              sessionKey: processed.sessionKey,
              plexSessionId: processed.plexSessionId || null,
              ratingKey: processed.ratingKey || null,
              state: processed.state,
              mediaType: processed.mediaType,
              mediaTitle: processed.mediaTitle,
              // Enhanced media metadata
              grandparentTitle: processed.grandparentTitle || null,
              seasonNumber: processed.seasonNumber || null,
              episodeNumber: processed.episodeNumber || null,
              year: processed.year || null,
              thumbPath: processed.thumbPath || null,
              startedAt: new Date(),
              lastSeenAt: new Date(), // Track when we first saw this session
              totalDurationMs: processed.totalDurationMs || null,
              progressMs: processed.progressMs || null,
              // Pause tracking - use Jellyfin's precise timestamp if available, otherwise infer from state
              lastPausedAt:
                processed.lastPausedDate ?? (processed.state === 'paused' ? new Date() : null),
              pausedDurationMs: 0,
              // Session grouping
              referenceId,
              watched: false,
              // Network/device info
              ipAddress: processed.ipAddress,
              geoCity: geo.city,
              geoRegion: geo.region,
              geoCountry: geo.country,
              geoLat: geo.lat,
              geoLon: geo.lon,
              playerName: processed.playerName,
              deviceId: processed.deviceId || null,
              product: processed.product || null,
              device: processed.device || null,
              platform: processed.platform,
              quality: processed.quality,
              isTranscode: processed.isTranscode,
              videoDecision: processed.videoDecision,
              audioDecision: processed.audioDecision,
              bitrate: processed.bitrate,
            })
            .returning();

          const inserted = insertedRows[0];
          if (!inserted) {
            throw new Error('Failed to insert session');
          }

          // Evaluate rules within same transaction
          const session = {
            id: inserted.id,
            serverId: server.id,
            serverUserId,
            sessionKey: processed.sessionKey,
            state: processed.state,
            mediaType: processed.mediaType,
            mediaTitle: processed.mediaTitle,
            grandparentTitle: processed.grandparentTitle || null,
            seasonNumber: processed.seasonNumber || null,
            episodeNumber: processed.episodeNumber || null,
            year: processed.year || null,
            thumbPath: processed.thumbPath || null,
            ratingKey: processed.ratingKey || null,
            externalSessionId: null,
            startedAt: inserted.startedAt,
            stoppedAt: null,
            durationMs: null,
            totalDurationMs: processed.totalDurationMs || null,
            progressMs: processed.progressMs || null,
            lastPausedAt: inserted.lastPausedAt,
            pausedDurationMs: inserted.pausedDurationMs,
            referenceId: inserted.referenceId,
            watched: inserted.watched,
            ipAddress: processed.ipAddress,
            geoCity: geo.city,
            geoRegion: geo.region,
            geoCountry: geo.country,
            geoLat: geo.lat,
            geoLon: geo.lon,
            playerName: processed.playerName,
            deviceId: processed.deviceId || null,
            product: processed.product || null,
            device: processed.device || null,
            platform: processed.platform,
            quality: processed.quality,
            isTranscode: processed.isTranscode,
            videoDecision: processed.videoDecision,
            audioDecision: processed.audioDecision,
            bitrate: processed.bitrate,
          };

          const ruleResults = await ruleEngine.evaluateSession(
            session,
            activeRules,
            recentSessions
          );

          // Create violations within same transaction
          const createdViolations: ViolationInsertResult[] = [];
          for (const result of ruleResults) {
            if (result.violated) {
              const matchingRule = activeRules.find((r) => doesRuleApplyToUser(r, serverUserId));
              if (matchingRule) {
                // Check for duplicate violations before creating
                // This prevents multiple violations when sessions start simultaneously
                const relatedSessionIds = (result.data?.relatedSessionIds as string[]) || [];
                const isDuplicate = await isDuplicateViolation(
                  serverUserId,
                  matchingRule.type,
                  inserted.id,
                  relatedSessionIds
                );

                if (isDuplicate) {
                  continue; // Skip creating duplicate violation
                }

                const violationResult = await createViolationInTransaction(
                  tx,
                  matchingRule.id,
                  serverUserId,
                  inserted.id,
                  result,
                  matchingRule
                );
                createdViolations.push(violationResult);
              }
            }
          }

          return { insertedSession: inserted, violationResults: createdViolations };
        });

        // Build active session for cache/broadcast (outside transaction - read only)
        const activeSession: ActiveSession = {
          id: insertedSession.id,
          serverId: server.id,
          serverUserId,
          sessionKey: processed.sessionKey,
          state: processed.state,
          mediaType: processed.mediaType,
          mediaTitle: processed.mediaTitle,
          // Enhanced media metadata
          grandparentTitle: processed.grandparentTitle || null,
          seasonNumber: processed.seasonNumber || null,
          episodeNumber: processed.episodeNumber || null,
          year: processed.year || null,
          thumbPath: processed.thumbPath || null,
          ratingKey: processed.ratingKey || null,
          externalSessionId: null,
          startedAt: insertedSession.startedAt,
          stoppedAt: null,
          durationMs: null,
          totalDurationMs: processed.totalDurationMs || null,
          progressMs: processed.progressMs || null,
          // Pause tracking
          lastPausedAt: insertedSession.lastPausedAt,
          pausedDurationMs: insertedSession.pausedDurationMs,
          referenceId: insertedSession.referenceId,
          watched: insertedSession.watched,
          // Network/device info
          ipAddress: processed.ipAddress,
          geoCity: geo.city,
          geoRegion: geo.region,
          geoCountry: geo.country,
          geoLat: geo.lat,
          geoLon: geo.lon,
          playerName: processed.playerName,
          deviceId: processed.deviceId || null,
          product: processed.product || null,
          device: processed.device || null,
          platform: processed.platform,
          quality: processed.quality,
          isTranscode: processed.isTranscode,
          videoDecision: processed.videoDecision,
          audioDecision: processed.audioDecision,
          bitrate: processed.bitrate,
          user: userDetail,
          server: { id: server.id, name: server.name, type: server.type },
        };

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
        const existingRows = await db
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.serverId, server.id),
              eq(sessions.sessionKey, processed.sessionKey),
              isNull(sessions.stoppedAt)
            )
          )
          .limit(1);

        const existingSession = existingRows[0];
        if (!existingSession) continue;

        const previousState = existingSession.state;
        const newState = processed.state;
        const now = new Date();

        // Build update payload with pause tracking
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
        } = {
          state: newState,
          quality: processed.quality,
          bitrate: processed.bitrate,
          progressMs: processed.progressMs || null,
          lastSeenAt: now, // Track when we last saw this session (for stale detection)
          // Always update plexSessionId (backfills sessions created before migration 0012)
          plexSessionId: processed.plexSessionId || null,
        };

        // Handle state transitions for pause tracking
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
        const activeSession: ActiveSession = {
          id: existingSession.id,
          serverId: server.id,
          serverUserId,
          sessionKey: processed.sessionKey,
          state: newState,
          mediaType: processed.mediaType,
          mediaTitle: processed.mediaTitle,
          // Enhanced media metadata
          grandparentTitle: processed.grandparentTitle || null,
          seasonNumber: processed.seasonNumber || null,
          episodeNumber: processed.episodeNumber || null,
          year: processed.year || null,
          thumbPath: processed.thumbPath || null,
          ratingKey: processed.ratingKey || null,
          externalSessionId: existingSession.externalSessionId,
          startedAt: existingSession.startedAt,
          stoppedAt: null,
          durationMs: null,
          totalDurationMs: processed.totalDurationMs || null,
          progressMs: processed.progressMs || null,
          // Pause tracking - use updated values
          lastPausedAt: updatePayload.lastPausedAt ?? existingSession.lastPausedAt,
          pausedDurationMs: updatePayload.pausedDurationMs ?? existingSession.pausedDurationMs ?? 0,
          referenceId: existingSession.referenceId,
          watched: updatePayload.watched ?? existingSession.watched ?? false,
          // Network/device info
          ipAddress: processed.ipAddress,
          geoCity: geo.city,
          geoRegion: geo.region,
          geoCountry: geo.country,
          geoLat: geo.lat,
          geoLon: geo.lon,
          playerName: processed.playerName,
          deviceId: processed.deviceId || null,
          product: processed.product || null,
          device: processed.device || null,
          platform: processed.platform,
          quality: processed.quality,
          isTranscode: processed.isTranscode,
          videoDecision: processed.videoDecision,
          audioDecision: processed.audioDecision,
          bitrate: processed.bitrate,
          user: userDetail,
          server: { id: server.id, name: server.name, type: server.type },
        };
        updatedSessions.push(activeSession);
      }
    }

    // Find stopped sessions
    const stoppedSessionKeys: string[] = [];
    for (const cachedKey of cachedSessionKeys) {
      if (cachedKey.startsWith(`${server.id}:`) && !currentSessionKeys.has(cachedKey)) {
        stoppedSessionKeys.push(cachedKey);

        // Mark session as stopped in database
        const sessionKey = cachedKey.replace(`${server.id}:`, '');
        const stoppedRows = await db
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.serverId, server.id),
              eq(sessions.sessionKey, sessionKey),
              isNull(sessions.stoppedAt)
            )
          )
          .limit(1);

        const stoppedSession = stoppedRows[0];
        if (stoppedSession) {
          const stoppedAt = new Date();

          // Calculate final duration
          const { durationMs, finalPausedDurationMs } = calculateStopDuration(
            {
              startedAt: stoppedSession.startedAt,
              lastPausedAt: stoppedSession.lastPausedAt,
              pausedDurationMs: stoppedSession.pausedDurationMs || 0,
            },
            stoppedAt
          );

          // Check for watch completion
          const watched =
            stoppedSession.watched ||
            checkWatchCompletion(stoppedSession.progressMs, stoppedSession.totalDurationMs);

          // Check if session meets minimum play time threshold (default 120s)
          // Short sessions are recorded but can be filtered from stats
          const shortSession = !shouldRecordSession(durationMs);

          await db
            .update(sessions)
            .set({
              state: 'stopped',
              stoppedAt,
              durationMs,
              pausedDurationMs: finalPausedDurationMs,
              lastPausedAt: null, // Clear the pause timestamp
              watched,
              shortSession,
            })
            .where(eq(sessions.id, stoppedSession.id));
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

    // Update cache incrementally (preserves concurrent SSE operations)
    if (cacheService) {
      // Extract stopped session IDs from the key format "serverId:sessionKey"
      const stoppedSessionIds: string[] = [];
      for (const key of allStoppedKeys) {
        const parts = key.split(':');
        if (parts.length >= 2) {
          const serverId = parts[0];
          const sessionKey = parts.slice(1).join(':');
          const stoppedSession = cachedSessions.find(
            (s) => s.serverId === serverId && s.sessionKey === sessionKey
          );
          if (stoppedSession) {
            stoppedSessionIds.push(stoppedSession.id);
          }
        }
      }

      // Incremental sync: adds new, removes stopped, updates existing
      await cacheService.incrementalSyncActiveSessions(
        allNewSessions,
        stoppedSessionIds,
        allUpdatedSessions
      );

      // Update user session sets for new sessions
      for (const session of allNewSessions) {
        await cacheService.addUserSession(session.serverUserId, session.id);
      }

      // Remove stopped sessions from user session sets
      for (const key of allStoppedKeys) {
        const parts = key.split(':');
        if (parts.length >= 2) {
          const serverId = parts[0];
          const sessionKey = parts.slice(1).join(':');
          const stoppedSession = cachedSessions.find(
            (s) => s.serverId === serverId && s.sessionKey === sessionKey
          );
          if (stoppedSession) {
            await cacheService.removeUserSession(stoppedSession.serverUserId, stoppedSession.id);
          }
        }
      }
    }

    // Publish events via pub/sub
    if (pubSubService) {
      for (const session of allNewSessions) {
        await pubSubService.publish('session:started', session);
        // Enqueue notification for async dispatch
        await enqueueNotification({ type: 'session_started', payload: session });
      }

      for (const session of allUpdatedSessions) {
        await pubSubService.publish('session:updated', session);
      }

      for (const key of allStoppedKeys) {
        const parts = key.split(':');
        if (parts.length >= 2) {
          const serverId = parts[0];
          const sessionKey = parts.slice(1).join(':');
          const stoppedSession = cachedSessions?.find(
            (s) => s.serverId === serverId && s.sessionKey === sessionKey
          );
          if (stoppedSession) {
            await pubSubService.publish('session:stopped', stoppedSession.id);
            // Enqueue notification for async dispatch
            await enqueueNotification({ type: 'session_stopped', payload: stoppedSession });
          }
        }
      }
    }

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

      // Calculate final duration
      const { durationMs, finalPausedDurationMs } = calculateStopDuration(
        {
          startedAt: staleSession.startedAt,
          lastPausedAt: staleSession.lastPausedAt,
          pausedDurationMs: staleSession.pausedDurationMs || 0,
        },
        now
      );

      // Check for watch completion
      const watched =
        staleSession.watched ||
        checkWatchCompletion(staleSession.progressMs, staleSession.totalDurationMs);

      // Check if session meets minimum play time threshold
      const shortSession = !shouldRecordSession(durationMs);

      // Force-stop the session
      await db
        .update(sessions)
        .set({
          state: 'stopped',
          stoppedAt: now,
          durationMs,
          pausedDurationMs: finalPausedDurationMs,
          lastPausedAt: null,
          watched,
          forceStopped: true, // Mark as force-stopped
          shortSession,
        })
        .where(eq(sessions.id, staleSession.id));

      // Remove from cache if cached
      if (cacheService) {
        await cacheService.deleteSessionById(staleSession.id);
        await cacheService.removeUserSession(staleSession.serverUserId, staleSession.id);
      }

      // Publish stop event
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

    // Update cache incrementally if there were any changes
    if (
      cacheService &&
      (allNewSessions.length > 0 || allStoppedKeys.length > 0 || allUpdatedSessions.length > 0)
    ) {
      // Extract stopped session IDs from the key format "serverId:sessionKey"
      const stoppedSessionIds: string[] = [];
      for (const key of allStoppedKeys) {
        const parts = key.split(':');
        if (parts.length >= 2) {
          const serverId = parts[0];
          const sessionKey = parts.slice(1).join(':');
          const stoppedSession = cachedSessions.find(
            (s) => s.serverId === serverId && s.sessionKey === sessionKey
          );
          if (stoppedSession) {
            stoppedSessionIds.push(stoppedSession.id);
          }
        }
      }

      // Incremental sync: adds new, removes stopped, updates existing
      await cacheService.incrementalSyncActiveSessions(
        allNewSessions,
        stoppedSessionIds,
        allUpdatedSessions
      );

      // Update user session sets for new sessions
      for (const session of allNewSessions) {
        await cacheService.addUserSession(session.serverUserId, session.id);
      }

      // Remove stopped sessions from user session sets
      for (const key of allStoppedKeys) {
        const parts = key.split(':');
        if (parts.length >= 2) {
          const serverId = parts[0];
          const sessionKey = parts.slice(1).join(':');
          const stoppedSession = cachedSessions.find(
            (s) => s.serverId === serverId && s.sessionKey === sessionKey
          );
          if (stoppedSession) {
            await cacheService.removeUserSession(stoppedSession.serverUserId, stoppedSession.id);
          }
        }
      }

      console.log(
        `[Poller] Reconciliation complete: ${allNewSessions.length} new, ${allUpdatedSessions.length} updated, ${allStoppedKeys.length} stopped`
      );
    }

    // Publish events via pub/sub for any changes
    if (pubSubService) {
      for (const session of allNewSessions) {
        await pubSubService.publish('session:started', session);
        await enqueueNotification({ type: 'session_started', payload: session });
      }

      for (const session of allUpdatedSessions) {
        await pubSubService.publish('session:updated', session);
      }

      for (const key of allStoppedKeys) {
        const parts = key.split(':');
        if (parts.length >= 2) {
          const serverId = parts[0];
          const sessionKey = parts.slice(1).join(':');
          const stoppedSession = cachedSessions.find(
            (s) => s.serverId === serverId && s.sessionKey === sessionKey
          );
          if (stoppedSession) {
            await pubSubService.publish('session:stopped', stoppedSession.id);
            await enqueueNotification({ type: 'session_stopped', payload: stoppedSession });
          }
        }
      }
    }
  } catch (error) {
    console.error('[Poller] Reconciliation poll error:', error);
  }
}
