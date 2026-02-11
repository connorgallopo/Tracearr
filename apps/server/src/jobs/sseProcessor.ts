/**
 * SSE Event Processor
 *
 * Handles incoming SSE events and updates sessions accordingly.
 * This bridges the real-time SSE events to the existing session processing logic.
 *
 * Flow:
 * 1. SSE event received (playing/paused/stopped/progress)
 * 2. Fetch full session details from Plex API (SSE only gives minimal info)
 * 3. Process session update using existing poller logic
 * 4. Broadcast updates via WebSocket
 */

import { eq, and } from 'drizzle-orm';
import type { PlexPlaySessionNotification } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, sessions, serverUsers, users } from '../db/schema.js';
import { createMediaServerClient } from '../services/mediaServer/index.js';
import { sseManager } from '../services/sseManager.js';
import type { CacheService, PubSubService } from '../services/cache.js';
import { lookupGeoIP } from '../services/plexGeoip.js';
import { getGeoIPSettings } from '../routes/settings.js';
import { mapMediaSession } from './poller/sessionMapper.js';
import {
  calculatePauseAccumulation,
  checkWatchCompletion,
  detectMediaChange,
} from './poller/stateTracker.js';
import { getActiveRulesV2, batchGetRecentUserSessions } from './poller/database.js';
import { broadcastViolations } from './poller/violations.js';
import {
  createSessionWithRulesAtomic,
  stopSessionAtomic,
  findActiveSession,
  findActiveSessionsAll,
  buildActiveSession,
  handleMediaChangeAtomic,
  reEvaluateRulesOnTranscodeChange,
} from './poller/sessionLifecycle.js';
import { enqueueNotification } from './notificationQueue.js';
import { triggerReconciliationPoll } from './poller/index.js';

let cacheService: CacheService | null = null;
let pubSubService: PubSubService | null = null;
let isRunning = false;

// Server down notification threshold in milliseconds
// Delay prevents false alarms from brief connection blips

const SERVER_DOWN_THRESHOLD_MS = 60 * 1000;

// Track pending server down notifications (can be cancelled if server comes back up)
const pendingServerDownNotifications = new Map<string, NodeJS.Timeout>();

// Track servers that have been notified as down (server_down was sent)
// Used to determine if we should send server_up when connection is restored
const notifiedDownServers = new Set<string>();

const MAX_NOTIFIED_DOWN_SERVERS = 100;

// Store wrapped handlers so we can properly remove them
interface SessionEvent {
  serverId: string;
  notification: PlexPlaySessionNotification;
}
interface FallbackEvent {
  serverId: string;
  serverName: string;
}
const wrappedHandlers = {
  playing: (e: SessionEvent) => void handlePlaying(e),
  paused: (e: SessionEvent) => void handlePaused(e),
  stopped: (e: SessionEvent) => void handleStopped(e),
  progress: (e: SessionEvent) => void handleProgress(e),
  reconciliation: () => void handleReconciliation(),
  fallbackActivated: (e: FallbackEvent) => handleFallbackActivated(e),
  fallbackDeactivated: (e: FallbackEvent) =>
    void handleFallbackDeactivated(e).catch((err: unknown) =>
      console.error('[SSEProcessor] Error in fallbackDeactivated handler:', err)
    ),
};

/**
 * Initialize the SSE processor with cache services
 */
export function initializeSSEProcessor(cache: CacheService, pubSub: PubSubService): void {
  cacheService = cache;
  pubSubService = pubSub;
}

/**
 * Start the SSE processor
 * Subscribes to SSE manager events and processes them
 * Note: sseManager.start() is called separately in index.ts after server is listening
 */
export function startSSEProcessor(): void {
  if (!cacheService || !pubSubService) {
    throw new Error('SSE processor not initialized');
  }

  if (isRunning) {
    console.log('[SSEProcessor] Already running, skipping start');
    return;
  }

  console.log('[SSEProcessor] Starting');
  isRunning = true;

  // Subscribe to SSE events
  sseManager.on('plex:session:playing', wrappedHandlers.playing);
  sseManager.on('plex:session:paused', wrappedHandlers.paused);
  sseManager.on('plex:session:stopped', wrappedHandlers.stopped);
  sseManager.on('plex:session:progress', wrappedHandlers.progress);
  sseManager.on('reconciliation:needed', wrappedHandlers.reconciliation);

  // Subscribe to server health events (SSE connection state changes)
  sseManager.on('fallback:activated', wrappedHandlers.fallbackActivated);
  sseManager.on('fallback:deactivated', wrappedHandlers.fallbackDeactivated);
}

/**
 * Stop the SSE processor
 * Note: sseManager.stop() is called separately in index.ts during cleanup
 */
export function stopSSEProcessor(): void {
  if (!isRunning) {
    console.log('[SSEProcessor] Not running, skipping stop');
    return;
  }

  console.log('[SSEProcessor] Stopping');
  isRunning = false;

  sseManager.off('plex:session:playing', wrappedHandlers.playing);
  sseManager.off('plex:session:paused', wrappedHandlers.paused);
  sseManager.off('plex:session:stopped', wrappedHandlers.stopped);
  sseManager.off('plex:session:progress', wrappedHandlers.progress);
  sseManager.off('reconciliation:needed', wrappedHandlers.reconciliation);
  sseManager.off('fallback:activated', wrappedHandlers.fallbackActivated);
  sseManager.off('fallback:deactivated', wrappedHandlers.fallbackDeactivated);

  // Clear any pending server down notifications
  for (const [serverId, timeout] of pendingServerDownNotifications) {
    clearTimeout(timeout);
    console.log(`[SSEProcessor] Cancelled pending server down notification for ${serverId}`);
  }
  pendingServerDownNotifications.clear();

  // Clear notified down servers state
  notifiedDownServers.clear();
}

/**
 * Handle playing event (new session or resume)
 */
async function handlePlaying(event: {
  serverId: string;
  notification: PlexPlaySessionNotification;
}): Promise<void> {
  const { serverId, notification } = event;

  try {
    const result = await fetchFullSession(serverId, notification.sessionKey);
    if (!result) {
      return;
    }

    const { session, server } = result;

    const existingSession = await findActiveSession(serverId, notification.sessionKey);

    if (existingSession) {
      if (detectMediaChange(existingSession.ratingKey, session.ratingKey)) {
        await handleMediaChange(existingSession, session, serverId, server);
        return;
      }

      await updateExistingSession(existingSession, session, 'playing');
    } else {
      // Check if this session was recently terminated (cooldown prevents re-creation)
      if (cacheService && session.ratingKey) {
        const hasCooldown = await cacheService.hasTerminationCooldown(
          serverId,
          notification.sessionKey,
          session.ratingKey
        );
        if (hasCooldown) {
          console.log(
            `[SSEProcessor] Session ${notification.sessionKey} was recently terminated, ignoring playing event`
          );
          return;
        }
      }

      // Pass server to avoid redundant DB lookup
      await createNewSession(serverId, session, server);
    }
  } catch (error) {
    console.error('[SSEProcessor] Error handling playing event:', error);
  }
}

/**
 * Handle paused event
 */
async function handlePaused(event: {
  serverId: string;
  notification: PlexPlaySessionNotification;
}): Promise<void> {
  const { serverId, notification } = event;

  try {
    const existingSession = await findActiveSession(serverId, notification.sessionKey);

    if (!existingSession) {
      return;
    }

    const result = await fetchFullSession(serverId, notification.sessionKey);
    if (result) {
      await updateExistingSession(existingSession, result.session, 'paused');
    }
  } catch (error) {
    console.error('[SSEProcessor] Error handling paused event:', error);
  }
}

/**
 * Handle stopped event
 */
async function handleStopped(event: {
  serverId: string;
  notification: PlexPlaySessionNotification;
}): Promise<void> {
  const { serverId, notification } = event;

  try {
    // Query without limit to handle any duplicate sessions that may exist
    const existingSessions = await findActiveSessionsAll(serverId, notification.sessionKey);

    if (existingSessions.length === 0) {
      return;
    }

    // Stop all matching sessions (handles potential duplicates)
    for (const session of existingSessions) {
      await stopSession(session);
    }
  } catch (error) {
    console.error('[SSEProcessor] Error handling stopped event:', error);
  }
}

/**
 * Handle progress event (periodic position updates)
 */
async function handleProgress(event: {
  serverId: string;
  notification: PlexPlaySessionNotification;
}): Promise<void> {
  const { serverId, notification } = event;

  try {
    const existingSession = await findActiveSession(serverId, notification.sessionKey);

    if (!existingSession) {
      return;
    }

    // Calculate current watch time for completion check (not playback position)
    // Some servers report incorrect position (e.g., Emby iOS transcoded sessions)
    const now = new Date();
    let watched = existingSession.watched;
    if (!watched && existingSession.totalDurationMs) {
      const elapsedMs = now.getTime() - existingSession.startedAt.getTime();
      const pausedMs = existingSession.pausedDurationMs || 0;
      // Account for ongoing pause if currently paused
      const ongoingPauseMs = existingSession.lastPausedAt
        ? now.getTime() - existingSession.lastPausedAt.getTime()
        : 0;
      const currentWatchTimeMs = Math.max(0, elapsedMs - pausedMs - ongoingPauseMs);
      watched = checkWatchCompletion(currentWatchTimeMs, existingSession.totalDurationMs);
    }

    await db
      .update(sessions)
      .set({
        progressMs: notification.viewOffset,
        lastSeenAt: now, // Update for stale session detection
        watched,
      })
      .where(eq(sessions.id, existingSession.id));

    if (cacheService) {
      const cached = await cacheService.getSessionById(existingSession.id);
      if (cached) {
        cached.progressMs = notification.viewOffset;
        cached.watched = watched;
        await cacheService.updateActiveSession(cached);

        // Only broadcast on watched status change (progress events are frequent)
        if (watched && !existingSession.watched && pubSubService) {
          await pubSubService.publish('session:updated', cached);
        }
      }
    }
  } catch (error) {
    console.error('[SSEProcessor] Error handling progress event:', error);
  }
}

/**
 * Handle reconciliation request - triggers a light poll to catch missed events
 */
async function handleReconciliation(): Promise<void> {
  console.log('[SSEProcessor] Triggering reconciliation poll');
  await triggerReconciliationPoll();
}

/**
 * Handle SSE fallback activated (server became unreachable after SSE retries exhausted)
 * Schedules a server_down notification after a threshold delay to prevent false alarms
 */
function handleFallbackActivated(event: FallbackEvent): void {
  const { serverId, serverName } = event;

  // Cancel any existing pending notification for this server (shouldn't happen, but be safe)
  const existing = pendingServerDownNotifications.get(serverId);
  if (existing) {
    clearTimeout(existing);
  }

  console.log(
    `[SSEProcessor] Server ${serverName} SSE connection failed, ` +
      `scheduling server_down notification in ${SERVER_DOWN_THRESHOLD_MS / 1000}s`
  );

  // Schedule the notification after threshold delay
  const timeout = setTimeout(() => {
    pendingServerDownNotifications.delete(serverId);

    if (notifiedDownServers.size >= MAX_NOTIFIED_DOWN_SERVERS) {
      console.warn(
        `[SSEProcessor] notifiedDownServers reached ${MAX_NOTIFIED_DOWN_SERVERS}, clearing oldest entries`
      );
      notifiedDownServers.clear();
    }

    notifiedDownServers.add(serverId); // Mark as down so we know to send server_up later
    console.log(`[SSEProcessor] Server ${serverName} is DOWN (threshold exceeded)`);

    enqueueNotification({
      type: 'server_down',
      payload: { serverName, serverId },
    }).catch((error: unknown) => {
      console.error(`[SSEProcessor] Error enqueueing server_down notification:`, error);
    });
  }, SERVER_DOWN_THRESHOLD_MS);

  pendingServerDownNotifications.set(serverId, timeout);
}

/**
 * Handle SSE fallback deactivated (server came back online, SSE connection restored)
 * Cancels pending server_down notification if server recovers before threshold
 * Sends server_up notification if server was previously marked as down
 */
async function handleFallbackDeactivated(event: FallbackEvent): Promise<void> {
  const { serverId, serverName } = event;

  // Check if there's a pending server_down notification to cancel
  const pending = pendingServerDownNotifications.get(serverId);
  if (pending) {
    clearTimeout(pending);
    pendingServerDownNotifications.delete(serverId);
    console.log(
      `[SSEProcessor] Server ${serverName} recovered before threshold, ` +
        `cancelled pending server_down notification`
    );
    // Don't send server_up since we never sent server_down
    return;
  }

  // Only send server_up if we actually sent a server_down notification
  if (!notifiedDownServers.has(serverId)) {
    // Server was never marked as down (e.g., initial connection or no prior fallback)
    return;
  }

  // Server was previously down (notification was sent), now it's back up
  notifiedDownServers.delete(serverId);
  console.log(`[SSEProcessor] Server ${serverName} is back UP (SSE restored)`);

  try {
    await enqueueNotification({
      type: 'server_up',
      payload: { serverName, serverId },
    });
  } catch (error) {
    console.error(`[SSEProcessor] Error enqueueing server_up notification:`, error);
  }
}

/**
 * Result of fetching full session details
 */
interface FetchSessionResult {
  session: ReturnType<typeof mapMediaSession>;
  server: typeof servers.$inferSelect;
}

/**
 * Fetch full session details from Plex server
 * Returns both session and server to avoid redundant DB lookups
 */
async function fetchFullSession(
  serverId: string,
  sessionKey: string
): Promise<FetchSessionResult | null> {
  try {
    const serverRows = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);

    const server = serverRows[0];
    if (!server) {
      return null;
    }

    const client = createMediaServerClient({
      type: server.type as 'plex',
      url: server.url,
      token: server.token,
    });

    const allSessions = await client.getSessions();
    const targetSession = allSessions.find((s) => s.sessionKey === sessionKey);

    if (!targetSession) {
      return null;
    }

    return {
      session: mapMediaSession(targetSession, server.type as 'plex'),
      server,
    };
  } catch (error) {
    console.error(`[SSEProcessor] Error fetching session ${sessionKey}:`, error);
    return null;
  }
}

/**
 * Create a new session from SSE event
 * Uses shared createSessionWithRulesAtomic for consistent handling with poller
 *
 * @param serverId Server ID
 * @param processed Processed session data
 * @param existingServer Optional server object to avoid redundant DB lookup (from fetchFullSession)
 */
async function createNewSession(
  serverId: string,
  processed: ReturnType<typeof mapMediaSession>,
  existingServer?: typeof servers.$inferSelect
): Promise<void> {
  let server = existingServer;
  if (!server) {
    const serverRows = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    server = serverRows[0];
  }

  if (!server) {
    return;
  }

  const serverUserRows = await db
    .select({
      id: serverUsers.id,
      username: serverUsers.username,
      thumbUrl: serverUsers.thumbUrl,
      identityName: users.name,
      trustScore: serverUsers.trustScore,
      sessionCount: serverUsers.sessionCount,
      lastActivityAt: serverUsers.lastActivityAt,
    })
    .from(serverUsers)
    .innerJoin(users, eq(serverUsers.userId, users.id))
    .where(
      and(eq(serverUsers.serverId, serverId), eq(serverUsers.externalId, processed.externalUserId))
    )
    .limit(1);

  const serverUserFromDb = serverUserRows[0];
  if (!serverUserFromDb) {
    console.warn(`[SSEProcessor] Server user not found for ${processed.externalUserId}, skipping`);
    return;
  }

  const userDetail = {
    id: serverUserFromDb.id,
    username: serverUserFromDb.username,
    thumbUrl: serverUserFromDb.thumbUrl,
    identityName: serverUserFromDb.identityName,
    trustScore: serverUserFromDb.trustScore,
    sessionCount: serverUserFromDb.sessionCount,
    lastActivityAt: serverUserFromDb.lastActivityAt,
  };

  // Get GeoIP location (uses Plex API if enabled, falls back to MaxMind)
  const { usePlexGeoip } = await getGeoIPSettings();
  const geo = await lookupGeoIP(processed.ipAddress, usePlexGeoip);

  if (!cacheService) {
    console.warn('[SSEProcessor] Cache service not available, skipping session creation');
    return;
  }

  const activeRulesV2 = await getActiveRulesV2();
  const recentSessions = await batchGetRecentUserSessions([userDetail.id]);
  const activeSessions = await cacheService.getAllActiveSessions();

  const result = await cacheService.withSessionCreateLock(
    serverId,
    processed.sessionKey,
    async () => {
      const existingActiveSession = await findActiveSession(serverId, processed.sessionKey);

      if (existingActiveSession) {
        console.log(
          `[SSEProcessor] Active session already exists for ${processed.sessionKey}, skipping create`
        );
        return null;
      }

      return createSessionWithRulesAtomic({
        processed,
        server: { id: server.id, name: server.name, type: server.type },
        serverUser: userDetail,
        geo,
        activeRulesV2,
        activeSessions,
        recentSessions: recentSessions.get(userDetail.id) ?? [],
      });
    }
  );

  if (!result) {
    return;
  }

  const { insertedSession, violationResults, qualityChange, wasTerminatedByRule } = result;

  if (qualityChange && cacheService) {
    await cacheService.removeActiveSession(qualityChange.stoppedSession.id);
    await cacheService.removeUserSession(
      qualityChange.stoppedSession.serverUserId,
      qualityChange.stoppedSession.id
    );
    if (pubSubService) {
      await pubSubService.publish('session:stopped', qualityChange.stoppedSession.id);
    }
  }

  if (pubSubService) {
    try {
      await broadcastViolations(violationResults, insertedSession.id, pubSubService);
    } catch (error) {
      console.error('[SSEProcessor] Error broadcasting violations:', error);
    }
  }

  if (wasTerminatedByRule) {
    console.log(
      `[SSEProcessor] Session ${insertedSession.id} was terminated by rule, skipping cache add`
    );
    return;
  }

  const activeSession = buildActiveSession({
    session: insertedSession,
    processed,
    user: userDetail,
    geo,
    server: { id: server.id, name: server.name, type: server.type },
  });

  await cacheService.addActiveSession(activeSession);
  await cacheService.addUserSession(userDetail.id, insertedSession.id);

  if (pubSubService) {
    await pubSubService.publish('session:started', activeSession);
    await enqueueNotification({ type: 'session_started', payload: activeSession });
  }

  console.log(`[SSEProcessor] Created session ${insertedSession.id} for ${processed.mediaTitle}`);
}

/**
 * Handle media change (e.g., auto-play next episode reusing the same sessionKey)
 * Atomically stops old session and creates new one for accurate play history
 */
async function handleMediaChange(
  existingSession: typeof sessions.$inferSelect,
  processed: ReturnType<typeof mapMediaSession>,
  serverId: string,
  server: typeof servers.$inferSelect
): Promise<void> {
  const serverUserRows = await db
    .select({
      id: serverUsers.id,
      username: serverUsers.username,
      thumbUrl: serverUsers.thumbUrl,
      identityName: users.name,
      trustScore: serverUsers.trustScore,
      sessionCount: serverUsers.sessionCount,
      lastActivityAt: serverUsers.lastActivityAt,
    })
    .from(serverUsers)
    .innerJoin(users, eq(serverUsers.userId, users.id))
    .where(eq(serverUsers.id, existingSession.serverUserId))
    .limit(1);

  const serverUser = serverUserRows[0];
  if (!serverUser) {
    console.warn(
      `[SSEProcessor] Server user not found for media change on session ${existingSession.id}`
    );
    return;
  }

  const { usePlexGeoip } = await getGeoIPSettings();
  const geo = await lookupGeoIP(processed.ipAddress, usePlexGeoip);

  if (!cacheService) {
    return;
  }

  const activeRulesV2 = await getActiveRulesV2();
  const recentSessions = await batchGetRecentUserSessions([serverUser.id]);
  const activeSessions = await cacheService.getAllActiveSessions();

  const result = await handleMediaChangeAtomic({
    existingSession,
    processed,
    server: { id: server.id, name: server.name, type: server.type },
    serverUser,
    geo,
    activeRulesV2,
    activeSessions,
    recentSessions: recentSessions.get(serverUser.id) ?? [],
  });

  if (!result) {
    return;
  }

  const { stoppedSession, insertedSession, violationResults, wasTerminatedByRule } = result;

  // Update cache for stopped session
  await cacheService.removeActiveSession(stoppedSession.id);
  await cacheService.removeUserSession(stoppedSession.serverUserId, stoppedSession.id);

  if (pubSubService) {
    await pubSubService.publish('session:stopped', stoppedSession.id);

    try {
      await broadcastViolations(violationResults, insertedSession.id, pubSubService);
    } catch (error) {
      console.error('[SSEProcessor] Error broadcasting violations:', error);
    }
  }

  if (wasTerminatedByRule) {
    console.log(
      `[SSEProcessor] Media change session ${insertedSession.id} was terminated by rule, skipping cache add`
    );
    return;
  }

  // Build and cache the new session
  const activeSession = buildActiveSession({
    session: insertedSession,
    processed,
    user: serverUser,
    geo,
    server: { id: server.id, name: server.name, type: server.type },
  });

  await cacheService.addActiveSession(activeSession);
  await cacheService.addUserSession(serverUser.id, insertedSession.id);

  if (pubSubService) {
    await pubSubService.publish('session:started', activeSession);
    await enqueueNotification({ type: 'session_started', payload: activeSession });
  }

  console.log(
    `[SSEProcessor] Media change created session ${insertedSession.id} for ${processed.mediaTitle}`
  );
}

/**
 * Update an existing session
 */
async function updateExistingSession(
  existingSession: typeof sessions.$inferSelect,
  processed: ReturnType<typeof mapMediaSession>,
  newState: 'playing' | 'paused'
): Promise<void> {
  const now = new Date();
  const previousState = existingSession.state;

  // Calculate pause accumulation
  const pauseResult = calculatePauseAccumulation(
    previousState,
    newState,
    {
      lastPausedAt: existingSession.lastPausedAt,
      pausedDurationMs: existingSession.pausedDurationMs || 0,
    },
    now
  );

  // Check watch completion using actual watch time (not playback position)
  // Some servers report incorrect position (e.g., Emby iOS transcoded sessions)
  let watched = existingSession.watched;
  if (!watched && processed.totalDurationMs) {
    const elapsedMs = now.getTime() - existingSession.startedAt.getTime();
    // Account for accumulated pauses and any ongoing pause
    const ongoingPauseMs = pauseResult.lastPausedAt
      ? now.getTime() - pauseResult.lastPausedAt.getTime()
      : 0;
    const currentWatchTimeMs = Math.max(
      0,
      elapsedMs - pauseResult.pausedDurationMs - ongoingPauseMs
    );
    watched = checkWatchCompletion(currentWatchTimeMs, processed.totalDurationMs);
  }

  // Check if transcode state changed before updating
  const transcodeStateChanged =
    existingSession.videoDecision !== processed.videoDecision ||
    existingSession.audioDecision !== processed.audioDecision;

  // Update session in database
  await db
    .update(sessions)
    .set({
      state: newState,
      quality: processed.quality,
      bitrate: processed.bitrate,
      progressMs: processed.progressMs || null,
      lastSeenAt: now, // Update for stale session detection
      lastPausedAt: pauseResult.lastPausedAt,
      pausedDurationMs: pauseResult.pausedDurationMs,
      watched,
      // Transcode fields - can change mid-session (e.g., bandwidth drop)
      isTranscode: processed.isTranscode,
      videoDecision: processed.videoDecision,
      audioDecision: processed.audioDecision,
    })
    .where(eq(sessions.id, existingSession.id));

  // Re-evaluate transcode-related V2 rules when transcode state changes.
  // At session creation (especially via SSE), transcode state may not be known yet,
  // so rules like "block 4K transcoding" need re-evaluation when transcoding starts.
  if (transcodeStateChanged) {
    try {
      const activeRulesV2 = await getActiveRulesV2();
      if (activeRulesV2.length > 0 && cacheService) {
        // Load server user details for rule evaluation context
        const serverUserRows = await db
          .select({
            id: serverUsers.id,
            username: serverUsers.username,
            thumbUrl: serverUsers.thumbUrl,
            trustScore: serverUsers.trustScore,
            sessionCount: serverUsers.sessionCount,
            lastActivityAt: serverUsers.lastActivityAt,
          })
          .from(serverUsers)
          .where(eq(serverUsers.id, existingSession.serverUserId))
          .limit(1);

        const serverUserDetail = serverUserRows[0];
        if (serverUserDetail) {
          // Load server info
          const serverRows = await db
            .select()
            .from(servers)
            .where(eq(servers.id, existingSession.serverId))
            .limit(1);

          const server = serverRows[0];
          if (server) {
            const activeSessions = await cacheService.getAllActiveSessions();
            const recentSessions = await batchGetRecentUserSessions([serverUserDetail.id]);

            const violationResults = await reEvaluateRulesOnTranscodeChange({
              existingSession,
              processed,
              server: { id: server.id, name: server.name, type: server.type },
              serverUser: serverUserDetail,
              activeRulesV2,
              activeSessions,
              recentSessions: recentSessions.get(serverUserDetail.id) ?? [],
            });

            if (violationResults.length > 0 && pubSubService) {
              await broadcastViolations(violationResults, existingSession.id, pubSubService);
            }
          }
        }
      }
    } catch (error) {
      console.error(
        `[SSEProcessor] Error re-evaluating rules on transcode change for session ${existingSession.id}:`,
        error
      );
    }
  }

  if (cacheService) {
    let cached = await cacheService.getSessionById(existingSession.id);

    if (!cached) {
      const allActive = await cacheService.getAllActiveSessions();
      cached = allActive.find((s) => s.id === existingSession.id) || null;
    }

    if (cached) {
      cached.state = newState;
      cached.quality = processed.quality;
      cached.bitrate = processed.bitrate;
      cached.progressMs = processed.progressMs || null;
      cached.lastPausedAt = pauseResult.lastPausedAt;
      cached.pausedDurationMs = pauseResult.pausedDurationMs;
      cached.watched = watched;
      cached.isTranscode = processed.isTranscode;
      cached.videoDecision = processed.videoDecision;
      cached.audioDecision = processed.audioDecision;

      await cacheService.updateActiveSession(cached);

      if (pubSubService) {
        await pubSubService.publish('session:updated', cached);
      }
    }
  }
}

/**
 * Stop a session
 */
async function stopSession(existingSession: typeof sessions.$inferSelect): Promise<void> {
  const cachedSession = await cacheService?.getSessionById(existingSession.id);

  const { wasUpdated } = await stopSessionAtomic({
    session: existingSession,
    stoppedAt: new Date(),
  });

  if (!wasUpdated) {
    console.log(`[SSEProcessor] Session ${existingSession.id} already stopped, skipping`);
    return;
  }

  if (cacheService) {
    await cacheService.removeActiveSession(existingSession.id);
    await cacheService.removeUserSession(existingSession.serverUserId, existingSession.id);
  }

  if (pubSubService) {
    await pubSubService.publish('session:stopped', existingSession.id);
    if (cachedSession) {
      await enqueueNotification({ type: 'session_stopped', payload: cachedSession });
    }
  }

  console.log(`[SSEProcessor] Stopped session ${existingSession.id}`);
}
