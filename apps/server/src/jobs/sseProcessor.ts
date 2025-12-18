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

import { eq, and, isNull } from 'drizzle-orm';
import type { PlexPlaySessionNotification, ActiveSession } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, sessions, serverUsers, users } from '../db/schema.js';
import { createMediaServerClient } from '../services/mediaServer/index.js';
import { sseManager } from '../services/sseManager.js';
import type { CacheService, PubSubService } from '../services/cache.js';
import { geoipService } from '../services/geoip.js';
import { ruleEngine } from '../services/rules.js';
import { mapMediaSession } from './poller/sessionMapper.js';
import {
  calculatePauseAccumulation,
  calculateStopDuration,
  checkWatchCompletion,
} from './poller/stateTracker.js';
import { getActiveRules, batchGetRecentUserSessions } from './poller/database.js';
import { createViolation, isDuplicateViolation } from './poller/violations.js';
import { enqueueNotification } from './notificationQueue.js';
import { triggerReconciliationPoll } from './poller/index.js';

let cacheService: CacheService | null = null;
let pubSubService: PubSubService | null = null;

// Store wrapped handlers so we can properly remove them
interface SessionEvent {
  serverId: string;
  notification: PlexPlaySessionNotification;
}
const wrappedHandlers = {
  playing: (e: SessionEvent) => void handlePlaying(e),
  paused: (e: SessionEvent) => void handlePaused(e),
  stopped: (e: SessionEvent) => void handleStopped(e),
  progress: (e: SessionEvent) => void handleProgress(e),
  reconciliation: () => void handleReconciliation(),
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

  console.log('[SSEProcessor] Starting');

  // Subscribe to SSE events
  sseManager.on('plex:session:playing', wrappedHandlers.playing);
  sseManager.on('plex:session:paused', wrappedHandlers.paused);
  sseManager.on('plex:session:stopped', wrappedHandlers.stopped);
  sseManager.on('plex:session:progress', wrappedHandlers.progress);
  sseManager.on('reconciliation:needed', wrappedHandlers.reconciliation);
}

/**
 * Stop the SSE processor
 * Note: sseManager.stop() is called separately in index.ts during cleanup
 */
export function stopSSEProcessor(): void {
  console.log('[SSEProcessor] Stopping');

  sseManager.off('plex:session:playing', wrappedHandlers.playing);
  sseManager.off('plex:session:paused', wrappedHandlers.paused);
  sseManager.off('plex:session:stopped', wrappedHandlers.stopped);
  sseManager.off('plex:session:progress', wrappedHandlers.progress);
  sseManager.off('reconciliation:needed', wrappedHandlers.reconciliation);
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
    const session = await fetchFullSession(serverId, notification.sessionKey);
    if (!session) {
      return;
    }

    const existingRows = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.serverId, serverId),
          eq(sessions.sessionKey, notification.sessionKey),
          isNull(sessions.stoppedAt)
        )
      )
      .limit(1);

    if (existingRows[0]) {
      await updateExistingSession(existingRows[0], session, 'playing');
    } else {
      await createNewSession(serverId, session);
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
    const existingRows = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.serverId, serverId),
          eq(sessions.sessionKey, notification.sessionKey),
          isNull(sessions.stoppedAt)
        )
      )
      .limit(1);

    if (!existingRows[0]) {
      return;
    }

    const session = await fetchFullSession(serverId, notification.sessionKey);
    if (session) {
      await updateExistingSession(existingRows[0], session, 'paused');
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
    const existingRows = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.serverId, serverId),
          eq(sessions.sessionKey, notification.sessionKey),
          isNull(sessions.stoppedAt)
        )
      );

    if (existingRows.length === 0) {
      return;
    }

    // Stop all matching sessions (handles potential duplicates)
    for (const session of existingRows) {
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
    const existingRows = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.serverId, serverId),
          eq(sessions.sessionKey, notification.sessionKey),
          isNull(sessions.stoppedAt)
        )
      )
      .limit(1);

    if (!existingRows[0]) {
      return;
    }

    // Update progress in database
    const watched =
      existingRows[0].watched ||
      checkWatchCompletion(notification.viewOffset, existingRows[0].totalDurationMs);

    await db
      .update(sessions)
      .set({
        progressMs: notification.viewOffset,
        watched,
      })
      .where(eq(sessions.id, existingRows[0].id));

    // Update cache
    if (cacheService) {
      const cached = await cacheService.getSessionById(existingRows[0].id);
      if (cached) {
        cached.progressMs = notification.viewOffset;
        cached.watched = watched;
        await cacheService.setSessionById(existingRows[0].id, cached);
      }
    }

    // Broadcast update (but don't spam - progress events are frequent)
    // Only broadcast if there's a significant change (e.g., watched status changed)
    if (watched && !existingRows[0].watched && pubSubService) {
      const cached = await cacheService?.getSessionById(existingRows[0].id);
      if (cached) {
        await pubSubService.publish('session:updated', cached);
      }
    }
  } catch (error) {
    console.error('[SSEProcessor] Error handling progress event:', error);
  }
}

/**
 * Handle reconciliation request
 * Triggers a light poll for SSE-connected servers to catch any missed events
 */
async function handleReconciliation(): Promise<void> {
  console.log('[SSEProcessor] Triggering reconciliation poll');
  await triggerReconciliationPoll();
}

/**
 * Fetch full session details from Plex server
 */
async function fetchFullSession(
  serverId: string,
  sessionKey: string
): Promise<ReturnType<typeof mapMediaSession> | null> {
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

    return mapMediaSession(targetSession, server.type as 'plex');
  } catch (error) {
    console.error(`[SSEProcessor] Error fetching session ${sessionKey}:`, error);
    return null;
  }
}

/**
 * Create a new session from SSE event
 */
async function createNewSession(
  serverId: string,
  processed: ReturnType<typeof mapMediaSession>
): Promise<void> {
  // Get server info
  const serverRows = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);

  const server = serverRows[0];
  if (!server) {
    return;
  }

  // Get or create server user (with identity name from users table)
  const serverUserRows = await db
    .select({
      id: serverUsers.id,
      username: serverUsers.username,
      thumbUrl: serverUsers.thumbUrl,
      identityName: users.name,
    })
    .from(serverUsers)
    .innerJoin(users, eq(serverUsers.userId, users.id))
    .where(
      and(eq(serverUsers.serverId, serverId), eq(serverUsers.externalId, processed.externalUserId))
    )
    .limit(1);

  const serverUserId = serverUserRows[0]?.id;

  if (!serverUserId) {
    // This shouldn't happen often since users are synced, but handle it
    console.warn(`[SSEProcessor] Server user not found for ${processed.externalUserId}, skipping`);
    return;
  }

  // GeoIP lookup
  const geo = geoipService.lookup(processed.ipAddress);

  // Check if an active session already exists (prevents race condition with poller)
  // This can happen when SSE and poller both try to create a session simultaneously
  const existingActiveSession = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, serverId),
        eq(sessions.sessionKey, processed.sessionKey),
        isNull(sessions.stoppedAt)
      )
    )
    .limit(1);

  if (existingActiveSession.length > 0) {
    // Session already exists (likely created by poller), skip insert
    // The existing session will be updated by subsequent SSE events
    console.log(
      `[SSEProcessor] Active session already exists for ${processed.sessionKey}, skipping create`
    );
    return;
  }

  // Insert new session
  const insertedRows = await db
    .insert(sessions)
    .values({
      serverId,
      serverUserId,
      sessionKey: processed.sessionKey,
      ratingKey: processed.ratingKey || null,
      state: processed.state,
      mediaType: processed.mediaType,
      mediaTitle: processed.mediaTitle,
      grandparentTitle: processed.grandparentTitle || null,
      seasonNumber: processed.seasonNumber || null,
      episodeNumber: processed.episodeNumber || null,
      year: processed.year || null,
      thumbPath: processed.thumbPath || null,
      startedAt: new Date(),
      lastSeenAt: new Date(), // Track when we first saw this session
      totalDurationMs: processed.totalDurationMs || null,
      progressMs: processed.progressMs || null,
      lastPausedAt: processed.state === 'paused' ? new Date() : null,
      pausedDurationMs: 0,
      watched: false,
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
    return;
  }

  // Get server user details
  const serverUserFromDb = serverUserRows[0];
  const userDetail = serverUserFromDb
    ? {
        id: serverUserFromDb.id,
        username: serverUserFromDb.username,
        thumbUrl: serverUserFromDb.thumbUrl,
        identityName: serverUserFromDb.identityName,
      }
    : { id: serverUserId, username: 'Unknown', thumbUrl: null, identityName: null };

  // Build active session
  const activeSession: ActiveSession = {
    id: inserted.id,
    serverId,
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
    pausedDurationMs: 0,
    referenceId: null,
    watched: false,
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
    server: { id: server.id, name: server.name, type: server.type as 'plex' },
  };

  // Update cache atomically
  if (cacheService) {
    // Add to active sessions SET + store session data (atomic)
    await cacheService.addActiveSession(activeSession);
    await cacheService.addUserSession(serverUserId, inserted.id);
  }

  // Broadcast new session
  if (pubSubService) {
    await pubSubService.publish('session:started', activeSession);
    await enqueueNotification({ type: 'session_started', payload: activeSession });
  }

  // Evaluate rules
  const activeRules = await getActiveRules();
  const recentSessions = await batchGetRecentUserSessions([serverUserId]);
  const ruleResults = await ruleEngine.evaluateSession(
    inserted,
    activeRules,
    recentSessions.get(serverUserId) ?? []
  );

  for (const result of ruleResults) {
    const matchingRule = activeRules.find(
      (r) => (r.serverUserId === null || r.serverUserId === serverUserId) && result.violated
    );
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

      // TODO: Refactor to use createViolationInTransaction pattern for atomicity
      // Session is already inserted before rule evaluation, so using standalone function for now
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      await createViolation(
        matchingRule.id,
        serverUserId,
        inserted.id,
        result,
        matchingRule,
        pubSubService
      );
    }
  }

  console.log(`[SSEProcessor] Created session ${inserted.id} for ${processed.mediaTitle}`);
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

  // Check watch completion
  const watched =
    existingSession.watched ||
    checkWatchCompletion(processed.progressMs, processed.totalDurationMs);

  // Update session in database
  await db
    .update(sessions)
    .set({
      state: newState,
      quality: processed.quality,
      bitrate: processed.bitrate,
      progressMs: processed.progressMs || null,
      lastPausedAt: pauseResult.lastPausedAt,
      pausedDurationMs: pauseResult.pausedDurationMs,
      watched,
    })
    .where(eq(sessions.id, existingSession.id));

  // Update cache and broadcast
  if (cacheService) {
    let cached = await cacheService.getSessionById(existingSession.id);

    // If cache miss, try to get from active sessions SET
    if (!cached) {
      const allActive = await cacheService.getAllActiveSessions();
      cached = allActive.find((s) => s.id === existingSession.id) || null;
    }

    if (cached) {
      // Update cached session with new state
      cached.state = newState;
      cached.quality = processed.quality;
      cached.bitrate = processed.bitrate;
      cached.progressMs = processed.progressMs || null;
      cached.lastPausedAt = pauseResult.lastPausedAt;
      cached.pausedDurationMs = pauseResult.pausedDurationMs;
      cached.watched = watched;

      // Atomic update: just update this session's data (ID already in SET)
      await cacheService.updateActiveSession(cached);

      // Broadcast the update
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
  const stoppedAt = new Date();

  // Calculate final duration
  const { durationMs, finalPausedDurationMs } = calculateStopDuration(
    {
      startedAt: existingSession.startedAt,
      lastPausedAt: existingSession.lastPausedAt,
      pausedDurationMs: existingSession.pausedDurationMs || 0,
    },
    stoppedAt
  );

  // Check watch completion
  const watched =
    existingSession.watched ||
    checkWatchCompletion(existingSession.progressMs, existingSession.totalDurationMs);

  // Update session
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
    .where(eq(sessions.id, existingSession.id));

  // Get session details for notification BEFORE removing from cache
  const cachedSession = await cacheService?.getSessionById(existingSession.id);

  // Update cache atomically (no more race condition)
  if (cacheService) {
    // Atomic remove from active sessions SET + delete session data
    await cacheService.removeActiveSession(existingSession.id);
    await cacheService.removeUserSession(existingSession.serverUserId, existingSession.id);
  }

  // Broadcast stopped
  if (pubSubService) {
    await pubSubService.publish('session:stopped', existingSession.id);

    // Use cached session data for notification
    if (cachedSession) {
      await enqueueNotification({ type: 'session_stopped', payload: cachedSession });
    }
  }

  console.log(`[SSEProcessor] Stopped session ${existingSession.id}`);
}
