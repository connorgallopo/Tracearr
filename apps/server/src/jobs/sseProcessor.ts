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

import {
  SESSION_WRITE_RETRY,
  type PlexPlaySessionNotification,
  type Session,
} from '@tracearr/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { servers, serverUsers, sessions, users } from '../db/schema.js';
import { getGeoIPSettings } from '../routes/settings.js';
import type { CacheService, PubSubService } from '../services/cache.js';
import { createMediaServerClient } from '../services/mediaServer/index.js';
import { extractLiveUuid } from '../services/mediaServer/plex/plexUtils.js';
import { lookupGeoIP } from '../services/plexGeoip.js';
import { registerService, unregisterService } from '../services/serviceTracker.js';
import { getWatchedThreshold } from '../services/settings.js';
import { sseManager } from '../services/sseManager.js';
import { canonicalPlexExternalUserId, getIdentityServerUserIds } from '../services/userService.js';
import { createLogger } from '../utils/logger.js';
import { enqueueNotification } from './notificationQueue.js';
import {
  batchGetLibraryItemIdentity,
  batchGetRecentUserSessions,
  getActiveRulesV2,
  getServerUserIdByExternalId,
  mergeRecentSessionsForIdentity,
} from './poller/database.js';
import {
  clearDbWriteTracking,
  recordDbWrite,
  shouldFlushDbWrite,
} from './poller/dbWriteThrottle.js';
import { triggerReconciliationPoll } from './poller/index.js';
import { gracePeriodSessionIds } from './poller/processor.js';
import {
  buildActiveSession,
  buildPendingActiveSession,
  confirmAndPersistSession,
  findActiveSession,
  findActiveSessionsAll,
  handleMediaChangeAtomic,
  handleQualityChangeFallout,
  reEvaluateRulesOnPauseState,
  reEvaluateRulesOnTranscodeChange,
  stopSessionAtomic,
} from './poller/sessionLifecycle.js';
import { mapMediaSession, pickStreamDetailFields } from './poller/sessionMapper.js';
import {
  calculatePauseAccumulation,
  checkWatchCompletion,
  createInitialConfirmationState,
  detectMediaChange,
  isPlaybackConfirmed,
  updateConfirmationState,
} from './poller/stateTracker.js';
import { PENDING_STOP_PERSIST_MIN_PROGRESS_MS, type PendingSessionData } from './poller/types.js';
import { excludeUncountableSessions } from './poller/utils.js';
import { broadcastViolations } from './poller/violations.js';

const sseLogger = createLogger('SSEProcessor');

let cacheService: CacheService | null = null;
let pubSubService: PubSubService | null = null;
let isRunning = false;

/**
 * Resolve the sibling server_user ids for an identity, for cross-server rule
 * aggregation. Falls back to no siblings (single server_user behavior) if the
 * lookup fails, so a transient DB error degrades detection instead of
 * blocking this event.
 */
async function resolveIdentityServerUserIds(userId: string, context: string): Promise<string[]> {
  try {
    return await getIdentityServerUserIds(userId);
  } catch (error) {
    console.error(
      `[SSEProcessor] Failed to resolve identity server users for ${userId} (${context}), ` +
        'evaluating rules for this server only:',
      error
    );
    return [];
  }
}

/**
 * Fetch recent sessions for windowed rule evaluation (unique_ips_in_window,
 * unique_devices_in_window, travel_speed_kmh), widened to every server_user
 * id of the same identity when merged (identityServerUserIds.length > 1).
 * Falls back to this server_user's own recent sessions if the widened fetch
 * fails, so a transient DB error degrades detection instead of blocking
 * this event.
 */
async function fetchRecentSessionsForRules(
  serverUserId: string,
  identityServerUserIds: string[]
): Promise<Session[]> {
  const ids = identityServerUserIds.length > 1 ? identityServerUserIds : [serverUserId];
  try {
    const recentSessionsMap = await batchGetRecentUserSessions(ids);
    return mergeRecentSessionsForIdentity(recentSessionsMap, ids);
  } catch (error) {
    console.error(
      `[SSEProcessor] Failed to fetch recent sessions for ${serverUserId}, falling back to this server only:`,
      error
    );
    const fallbackMap = await batchGetRecentUserSessions([serverUserId]);
    return fallbackMap.get(serverUserId) ?? [];
  }
}

// Server down notification threshold in milliseconds
// Delay prevents false alarms from brief connection blips

const SERVER_DOWN_THRESHOLD_MS = 60 * 1000;

// Orphan sweep threshold in milliseconds
// Pending sessions older than this are considered orphaned and will be swept
const ORPHAN_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

// Playing notifications carry no user, so the repeat-tick fast path could
// latch onto a stale foreign row that matches sessionKey+ratingKey+deviceId.
// Each session gets a bounded fast-path window; expiry forces one full pass
// whose server-user check unlatches any foreign row.
const FAST_PATH_REVALIDATE_MS = 60 * 1000;
const fastPathWindowStart = new Map<string, number>();

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
  reconciliation: () =>
    void handleReconciliation().catch((err: unknown) =>
      console.error('[SSEProcessor] Error in reconciliation handler:', err)
    ),
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
 * Clean up orphaned pending sessions from a previous server instance.
 * Should be called on startup before starting the SSE processor.
 *
 * Orphaned pending sessions can occur if the server crashes or restarts
 * while sessions are in the pending state (< 30s confirmation).
 * These would have stale data if they were later "confirmed".
 *
 * The reconciliation poll will pick up any still-active playback
 * and create fresh pending sessions with current data.
 */
export async function cleanupOrphanedPendingSessions(): Promise<void> {
  if (!cacheService) {
    console.warn('[SSEProcessor] Cache service not initialized, skipping orphan cleanup');
    return;
  }

  const cache = cacheService;
  // Dashboard invalidation is deferred to one call after the loop (instead of
  // one SCAN per removed session) - the flag must survive a mid-loop throw,
  // hence the outer try/finally rather than folding this into the return path.
  let dashboardStatsDirty = false;
  try {
    const pendingKeys = await cache.getAllPendingSessionKeys();

    if (pendingKeys.length === 0) {
      console.log('[SSEProcessor] No orphaned pending sessions found');
      return;
    }

    console.log(`[SSEProcessor] Cleaning up ${pendingKeys.length} orphaned pending session(s)`);

    for (const { serverId, sessionKey } of pendingKeys) {
      const pendingData = await cache.getPendingSession(serverId, sessionKey);
      if (pendingData) {
        // Remove from all caches
        await cache.deletePendingSession(serverId, sessionKey);
        await cache.removeActiveSession(pendingData.id, { skipDashboardInvalidation: true });
        dashboardStatsDirty = true;

        console.log(
          `[SSEProcessor] Cleaned up orphaned session ${sessionKey} (${pendingData.processed.mediaTitle})`
        );
      } else {
        // Hash already expired: this member is a zombie left behind in
        // PENDING_SESSION_IDS. deletePendingSession's del is a no-op here;
        // its srem is what actually clears it.
        await cache.deletePendingSession(serverId, sessionKey);
      }
    }

    console.log('[SSEProcessor] Orphaned pending session cleanup complete');
  } catch (error) {
    console.error('[SSEProcessor] Error cleaning up orphaned pending sessions:', error);
  } finally {
    if (dashboardStatsDirty) {
      // Runs at startup before startSSEProcessor and sseManager.start. A bare
      // throw here escapes to index.ts's catch and skips both, leaving SSE dead
      // until restart. Degrade to a logged error instead.
      try {
        await cache.invalidateDashboardStatsCache();
      } catch (error) {
        console.error(
          '[SSEProcessor] Error invalidating dashboard stats after orphan cleanup:',
          error
        );
      }
    }
  }
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
  registerService('sse-processor', {
    name: 'SSE Processor',
    description: 'Processes real-time Plex SSE events',
    intervalMs: 0, // event-driven, not interval-based
  });

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
  fastPathWindowStart.clear();
  unregisterService('sse-processor');

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
 * Also updates pending sessions (Redis-only) with playing state
 */
async function handlePlaying(event: {
  serverId: string;
  notification: PlexPlaySessionNotification;
}): Promise<void> {
  const { serverId, notification } = event;

  // Extract liveUuid from SSE key for Live TV sessions
  // Live TV uses stable UUIDs across channel changes, unlike ratingKey
  const liveUuid = extractLiveUuid(notification.key);

  try {
    // First check for a pending session (Redis-only, not yet confirmed)
    // This handles resume from pause for pending sessions
    if (cacheService) {
      const pendingData = await cacheService.getPendingSession(serverId, notification.sessionKey);
      if (pendingData) {
        // Fetch fresh session data to check for media change
        const result = await fetchFullSession(serverId, notification.sessionKey);
        if (result) {
          // Check if media changed (e.g., autoplay next episode before 30s confirmation)
          // For Live TV, compare liveUuid instead of ratingKey (channel changes are not media changes)
          if (
            detectMediaChange(
              pendingData.processed.ratingKey,
              result.session.ratingKey,
              pendingData.processed.liveUuid,
              liveUuid
            )
          ) {
            console.log(
              `[SSEProcessor] Media change detected on pending session ${notification.sessionKey}: ` +
                `${pendingData.processed.mediaTitle} -> ${result.session.mediaTitle}`
            );
            // Discard old pending session (phantom - never confirmed)
            await discardPendingSession(serverId, notification.sessionKey, pendingData);
            // Create fresh pending session for new media
            await createNewSession(serverId, result.session, result.server, liveUuid);
            return;
          }
        }
        // No media change - just update the pending session state
        await updatePendingSession(
          serverId,
          notification.sessionKey,
          pendingData,
          'playing',
          notification.viewOffset
        );
        return;
      }
    }

    // Look up by sessionKey alone. Passing the incoming ratingKey would filter
    // out the still-active old row on a real media change (same sessionKey, new
    // ratingKey), leaving detectMediaChange below unreachable.
    const existingRow = await findActiveSession({
      serverId,
      sessionKey: notification.sessionKey,
    });

    // Plex delivers its progress stream as repeated 'playing' notifications
    // with an advancing viewOffset. When the active row already matches this
    // exact playback (same device, same media, already playing), take the
    // throttled progress path: no /status/sessions fetch, one DB write per
    // throttle window. The window expires after FAST_PATH_REVALIDATE_MS so
    // the full path re-checks the server user. Everything else (new play,
    // resume, media change, live TV) falls through to the full path, and the
    // 30s reconciliation poll covers mid-stream transcode flips.
    if (
      existingRow?.state === 'playing' &&
      existingRow.mediaType !== 'live' &&
      existingRow.ratingKey === notification.ratingKey &&
      existingRow.deviceId === notification.clientIdentifier
    ) {
      const windowStart = fastPathWindowStart.get(existingRow.id);
      if (windowStart === undefined || Date.now() - windowStart < FAST_PATH_REVALIDATE_MS) {
        if (windowStart === undefined) {
          fastPathWindowStart.set(existingRow.id, Date.now());
        }
        await applySessionProgress(existingRow, notification.viewOffset);
        return;
      }
      fastPathWindowStart.delete(existingRow.id);
    }

    const result = await fetchFullSession(serverId, notification.sessionKey);
    if (!result) {
      return;
    }

    const { session, server } = result;

    // Plex resets sessionKey counters on PMS restart, so within the
    // reconciliation window a stale open row from one user can carry the same
    // sessionKey a different user's new play now uses. Only reuse the row when
    // its server user matches this event's user; otherwise treat it as no match
    // so the stale row falls to its own cleanup and the create path below runs.
    // createNewSession re-applies this same server-user match under its lock, so
    // the foreign row is never reused and a fresh row is written under the
    // correct user.
    let existingSession = existingRow;
    if (existingRow) {
      const incomingServerUserId = await getServerUserIdByExternalId(
        serverId,
        session.externalUserId
      );
      if (incomingServerUserId !== existingRow.serverUserId) {
        existingSession = null;
      }
    }

    if (existingSession) {
      // DB doesn't store liveUuid; reuse incoming if mediaType is 'live'
      const existingLiveUuid = existingSession.mediaType === 'live' ? liveUuid : undefined;
      if (
        detectMediaChange(existingSession.ratingKey, session.ratingKey, existingLiveUuid, liveUuid)
      ) {
        await handleMediaChange(existingSession, session, server);
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

      // Pass server and liveUuid to avoid redundant lookups
      await createNewSession(serverId, session, server, liveUuid);
    }
  } catch (error) {
    console.error('[SSEProcessor] Error handling playing event:', error);
  }
}

/**
 * Handle paused event
 * Also updates pending sessions (Redis-only) with pause state
 */
async function handlePaused(event: {
  serverId: string;
  notification: PlexPlaySessionNotification;
}): Promise<void> {
  const { serverId, notification } = event;

  try {
    // First check for a pending session (Redis-only, not yet confirmed)
    if (cacheService) {
      const pendingData = await cacheService.getPendingSession(serverId, notification.sessionKey);
      if (pendingData) {
        await updatePendingSession(serverId, notification.sessionKey, pendingData, 'paused');
        return;
      }
    }

    // Check for confirmed session in DB
    const existingSession = await findActiveSession({
      serverId,
      sessionKey: notification.sessionKey,
    });

    if (!existingSession) {
      return;
    }

    const result = await fetchFullSession(serverId, notification.sessionKey);
    if (!result) {
      return;
    }

    // Same cross-user guard as handlePlaying: after a PMS restart this
    // sessionKey can still be held by a stale row from another user. Updating
    // that row would splice this user's stream into it and refresh its
    // lastSeenAt on every pause, so it never ages out of the stale sweep.
    // Leave the foreign row to its own cleanup instead.
    const incomingServerUserId = await getServerUserIdByExternalId(
      serverId,
      result.session.externalUserId
    );
    if (incomingServerUserId !== existingSession.serverUserId) {
      if (incomingServerUserId === null) {
        // Lookup miss, not a foreign row: reachable mid-stream after a user
        // merge re-points the account. Reconciliation applies the pause ~30s
        // later; log so the gap is diagnosable.
        console.log(
          `[SSEProcessor] Pause dropped: no server user for external id on server ${serverId}`
        );
      }
      return;
    }

    await updateExistingSession(existingSession, result.session, 'paused');
  } catch (error) {
    console.error('[SSEProcessor] Error handling paused event:', error);
  }
}

/**
 * Handle stopped event
 * If session is still pending and unconfirmed, discard it unless it showed real
 * progress (a short resume near the end of a file), in which case persist it.
 * If session is confirmed, stop it normally.
 */
async function handleStopped(event: {
  serverId: string;
  notification: PlexPlaySessionNotification;
}): Promise<void> {
  const { serverId, notification } = event;

  try {
    // First check for a pending session (Redis-only, not yet confirmed)
    if (cacheService) {
      const pendingData = await cacheService.getPendingSession(serverId, notification.sessionKey);
      if (pendingData) {
        const { maxViewOffset, initialViewOffset } = pendingData.confirmation;
        const progress = maxViewOffset - (initialViewOffset ?? maxViewOffset);

        if (progress >= PENDING_STOP_PERSIST_MIN_PROGRESS_MS) {
          // Real playback happened; a short resume near the end of a file must
          // still reach history and flip watched-state. Age-based confirmation
          // was never reached, so the observed progress is the evidence here.
          const persisted = await confirmPendingSessionAndPersist(
            serverId,
            notification.sessionKey,
            {
              ...pendingData,
              confirmation: { ...pendingData.confirmation, confirmedPlayback: true },
            }
          );
          if (persisted) {
            const sessionRow = await findActiveSession({
              serverId,
              sessionKey: notification.sessionKey,
              ratingKey: pendingData.processed.ratingKey,
            });
            if (sessionRow) await stopSession(sessionRow);
            return;
          }
          // False here has three causes: the in-lock pending recheck found
          // the entry already discarded (no row exists to close), the
          // existingActive recheck found a row already persisted or the
          // create lock was contended (a concurrent caller got there
          // first), or a kill_stream rule terminated the session while
          // confirming it (termination.ts already closed and broadcast
          // it). Fall through to the lookup-and-stop below so a row from
          // the concurrent-caller case still gets closed instead of
          // lingering until the stale sweep.
        } else {
          await discardPendingSession(serverId, notification.sessionKey, pendingData);
          console.log(
            `[SSEProcessor] Discarded phantom session ${notification.sessionKey} (id: ${pendingData.id}) ` +
              `(stopped before 30s confirmation)`
          );
          return;
        }
      }
    }

    // Query without limit to handle any duplicate sessions that may exist.
    // The stopping user's identity is unknowable here (the session is already
    // gone from Plex), so the ratingKey is the only guard against closing a
    // foreign row that shares this sessionKey after a PMS restart. Live TV is
    // exempt: its ratingKey changes per channel and the row never re-syncs,
    // so live rows match on sessionKey alone.
    const candidateSessions = await findActiveSessionsAll({
      serverId,
      sessionKey: notification.sessionKey,
    });
    const existingSessions =
      notification.ratingKey == null
        ? candidateSessions
        : candidateSessions.filter(
            (s) =>
              s.ratingKey === notification.ratingKey ||
              // Live rows can't match on ratingKey (channel changes rotate it),
              // so they close on device instead; without the device check a
              // non-live stop sharing this sessionKey after a PMS restart
              // would close a foreign live stream
              (s.mediaType === 'live' &&
                (notification.clientIdentifier == null ||
                  s.deviceId === notification.clientIdentifier))
          );

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
 * Apply a position update to a confirmed session at throttled DB cost: the
 * Redis cache updates on every call so dashboards stay live, while the DB
 * write coalesces through shouldFlushDbWrite. Watched transitions flush
 * immediately. Production reaches this from handlePlaying's repeat-tick fast
 * path; Plex SSE has no distinct progress state.
 */
async function applySessionProgress(
  existingSession: typeof sessions.$inferSelect,
  viewOffset: number
): Promise<void> {
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
    watched = checkWatchCompletion(
      currentWatchTimeMs,
      viewOffset,
      existingSession.totalDurationMs,
      await getWatchedThreshold(existingSession.mediaType)
    );
  }

  const watchedTransition = watched && !existingSession.watched;
  let wasStoppedConcurrently = false;
  if (watchedTransition || shouldFlushDbWrite(existingSession.id, now.getTime())) {
    // Guarded by isNull(stoppedAt): a stop racing this write must not
    // resurrect the session into the cache.
    const updateResult = await db
      .update(sessions)
      .set({
        progressMs: viewOffset,
        lastSeenAt: now, // Update for stale session detection
        watched,
      })
      .where(and(eq(sessions.id, existingSession.id), isNull(sessions.stoppedAt)))
      .returning({ id: sessions.id });

    if (updateResult.length === 0) {
      wasStoppedConcurrently = true;
      console.log(
        `[SSEProcessor] Session ${existingSession.id} already stopped, skipping progress resurrection`
      );
    } else {
      recordDbWrite(existingSession.id, now.getTime());
    }
  }

  if (wasStoppedConcurrently) {
    return;
  }

  if (cacheService) {
    const cached = await cacheService.getSessionById(existingSession.id);
    if (cached) {
      cached.progressMs = viewOffset;
      cached.watched = watched;
      await cacheService.updateActiveSession(cached);

      // Only broadcast on watched status change (progress events are frequent)
      if (watchedTransition && pubSubService) {
        await pubSubService.publish('session:updated', cached);
      }
    }
  }
}

/**
 * Handle progress event (periodic position updates)
 * Also handles pending session confirmation - if viewOffset exceeds 30s threshold,
 * the session is persisted to DB and rules are evaluated.
 * Plex SSE never emits a distinct progress state, so in production this logic
 * runs via handlePlaying's fast path; the subscription stays for the relay
 * interface and any event source that does emit it.
 */
async function handleProgress(event: {
  serverId: string;
  notification: PlexPlaySessionNotification;
}): Promise<void> {
  const { serverId, notification } = event;

  try {
    // First check for a pending session (Redis-only, not yet confirmed)
    if (cacheService) {
      const pendingData = await cacheService.getPendingSession(serverId, notification.sessionKey);
      if (pendingData) {
        // Update progress and check confirmation threshold
        await updatePendingSession(
          serverId,
          notification.sessionKey,
          pendingData,
          pendingData.currentState as 'playing' | 'paused',
          notification.viewOffset
        );
        return;
      }
    }

    const existingSession = await findActiveSession({
      serverId,
      sessionKey: notification.sessionKey,
    });

    if (!existingSession) {
      return;
    }

    await applySessionProgress(existingSession, notification.viewOffset);
  } catch (error) {
    console.error('[SSEProcessor] Error handling progress event:', error);
  }
}

/**
 * Handle reconciliation request - triggers a light poll to catch missed events
 */
async function handleReconciliation(): Promise<void> {
  sseLogger.debug('Triggering reconciliation poll');
  await triggerReconciliationPoll();

  // Run maintenance tasks during reconciliation
  await sweepOrphanedPendingSessions();
  await processSessionWriteRetries();
}

/**
 * Sweep orphaned pending sessions that have not been seen in ORPHAN_THRESHOLD_MS.
 * These are sessions that may have been left behind due to missed stop events.
 *
 * @param cache Optional cache service (for testing), defaults to module cacheService
 */
export async function sweepOrphanedPendingSessions(cache?: CacheService | null): Promise<void> {
  const svc = cache ?? cacheService;
  if (!svc) return;

  const now = Date.now();
  let sweptCount = 0;
  let zombieCount = 0;
  // Same deferred-invalidation shape as processor.ts's grace/stale sweeps:
  // one flush after the loop instead of one SCAN per removed session. The
  // flag must survive a mid-loop throw, hence the try/finally.
  let dashboardStatsDirty = false;

  // This runs on the 30s reconciliation tick. A Redis or Postgres outage here
  // must degrade to a logged error, not a rejected promise that surfaces as an
  // unhandledRejection and crashes the process.
  try {
    const pendingKeys = await svc.getAllPendingSessionKeys();
    for (const { serverId, sessionKey } of pendingKeys) {
      const pendingData = await svc.getPendingSession(serverId, sessionKey);
      if (!pendingData) {
        // Hash already expired: this member is a zombie left behind in
        // PENDING_SESSION_IDS. deletePendingSession's del is a no-op here;
        // its srem is what actually clears it.
        await svc.deletePendingSession(serverId, sessionKey);
        zombieCount++;
        continue;
      }
      if (now - pendingData.lastSeenAt > ORPHAN_THRESHOLD_MS) {
        await svc.deletePendingSession(serverId, sessionKey);
        await svc.removeActiveSession(pendingData.id, { skipDashboardInvalidation: true });
        dashboardStatsDirty = true;

        if (pubSubService) {
          await pubSubService.publish('session:stopped', pendingData.id);
        }

        sweptCount++;
      }
    }
  } catch (error) {
    console.error('[SSEProcessor] Error sweeping orphaned pending sessions:', error);
  } finally {
    if (dashboardStatsDirty) {
      try {
        await svc.invalidateDashboardStatsCache();
      } catch (error) {
        console.error(
          '[SSEProcessor] Error invalidating dashboard stats after orphan sweep:',
          error
        );
      }
    }
  }

  if (zombieCount > 0) {
    console.log(`[SSEProcessor] Cleared ${zombieCount} zombie pending-session set member(s)`);
  }

  if (sweptCount > 0) {
    console.log(`[SSEProcessor] Swept ${sweptCount} orphaned pending session(s)`);
  }
}

/**
 * Process any failed session DB writes from the retry queue.
 * Called during reconciliation to recover from transient DB errors.
 */
async function processSessionWriteRetries(): Promise<void> {
  if (!cacheService) return;
  const cache = cacheService;

  // Runs on the reconciliation tick; a Redis/Postgres outage must degrade to a
  // logged error rather than reject up into the unhandled handler.
  let retries;
  try {
    retries = await cache.getSessionWriteRetries();
  } catch (error) {
    console.error('[SSEProcessor] Error loading session write retries:', error);
    return;
  }

  for (const retry of retries) {
    // Isolated per retry: a transient error on one entry must not abandon the
    // rest of the queue for this tick.
    try {
      if (retry.attempts >= SESSION_WRITE_RETRY.MAX_TOTAL_ATTEMPTS) {
        clearDbWriteTracking(retry.sessionId);
        await cache.removeSessionWriteRetry(retry.sessionId);
        console.error(
          `[SSEProcessor] Max retry attempts (${SESSION_WRITE_RETRY.MAX_TOTAL_ATTEMPTS}) ` +
            `reached for session ${retry.sessionId}, abandoning`
        );
        continue;
      }

      // Attempt to find the session
      const session = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, retry.sessionId), isNull(sessions.stoppedAt)))
        .limit(1)
        .then((rows) => rows[0]);

      if (!session) {
        // Session no longer exists or already stopped
        clearDbWriteTracking(retry.sessionId);
        await cache.removeSessionWriteRetry(retry.sessionId);
        continue;
      }

      const result = await stopSessionAtomic({
        session,
        stoppedAt: new Date(retry.stopData.stoppedAt),
        forceStopped: retry.stopData.forceStopped,
      });

      if (result.wasUpdated || !result.needsRetry) {
        await cache.removeSessionWriteRetry(retry.sessionId);
        console.log(`[SSEProcessor] Retry succeeded for session ${retry.sessionId}`);
      } else {
        await cache.incrementSessionWriteRetry(retry.sessionId);
      }
    } catch (error) {
      console.error(
        `[SSEProcessor] Error processing session write retry for ${retry.sessionId}:`,
        error
      );
    }
  }
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

  // Re-sync sessions that may have started, stopped, or changed while SSE was
  // disconnected. JF/Emby have no other catch-up path, so reconcile on reconnect
  // rather than waiting for the next inbound event. Fire-and-forget so it never
  // delays the server up/down notification handling below.
  void Promise.resolve(triggerReconciliationPoll()).catch((error: unknown) =>
    console.error(`[SSEProcessor] Reconciliation on reconnect failed for ${serverName}:`, error)
  );

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
      type: server.type,
      url: server.url,
      token: server.token,
    });

    const allSessions = await client.getSessions();
    const targetSession = allSessions.find((s) => s.sessionKey === sessionKey);

    if (!targetSession) {
      return null;
    }

    const session = mapMediaSession(targetSession, server.type);
    // Plex aliases the server owner as user id "1" in session payloads;
    // resolve it to their plex.tv account id (see canonicalPlexExternalUserId).
    if (server.type === 'plex') {
      session.externalUserId = await canonicalPlexExternalUserId(session.externalUserId);
    }
    // Stamp identity like the poller does or SSE session rows insert with null media columns
    if (session.ratingKey) {
      const identityMap = await batchGetLibraryItemIdentity(server.id, [session.ratingKey]);
      session.identity = identityMap.get(session.ratingKey) ?? null;
    } else {
      session.identity = null;
    }

    return { session, server };
  } catch (error) {
    console.error(`[SSEProcessor] Error fetching session ${sessionKey}:`, error);
    return null;
  }
}

/**
 * Create a new session from SSE event
 *
 * Redis-First Architecture:
 * 1. New sessions are stored in Redis as "pending" (not yet in DB)
 * 2. Sessions remain pending until 30s confirmation threshold met
 * 3. Once confirmed, session is persisted to DB and rules are evaluated
 * 4. If stopped before confirmation, session is discarded (phantom session)
 *
 * This prevents Plex prefetch events from triggering rule violations.
 *
 * @param serverId Server ID
 * @param processed Processed session data
 * @param existingServer Optional server object to avoid redundant DB lookup (from fetchFullSession)
 * @param liveUuid Optional Live TV UUID extracted from SSE key (for Live TV sessions)
 */
async function createNewSession(
  serverId: string,
  processed: ReturnType<typeof mapMediaSession>,
  existingServer?: typeof servers.$inferSelect,
  liveUuid?: string
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
      userId: serverUsers.userId,
      username: serverUsers.username,
      thumbUrl: serverUsers.thumbUrl,
      identityName: users.name,
      trustScore: serverUsers.trustScore,
      lastActivityAt: serverUsers.lastActivityAt,
      createdAt: serverUsers.createdAt,
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

  const identityServerUserIds = await getIdentityServerUserIds(serverUserFromDb.userId);

  const userDetail = {
    id: serverUserFromDb.id,
    userId: serverUserFromDb.userId,
    username: serverUserFromDb.username,
    thumbUrl: serverUserFromDb.thumbUrl,
    identityName: serverUserFromDb.identityName,
    trustScore: serverUserFromDb.trustScore,
    lastActivityAt: serverUserFromDb.lastActivityAt,
    createdAt: serverUserFromDb.createdAt,
    identityServerUserIds,
  };

  // Get GeoIP location (uses Plex API if enabled, falls back to MaxMind)
  const { usePlexGeoip } = await getGeoIPSettings();
  const geo = await lookupGeoIP(processed.ipAddress, usePlexGeoip);

  if (!cacheService) {
    console.warn('[SSEProcessor] Cache service not available, skipping session creation');
    return;
  }

  const cache = cacheService;
  const srv = server;

  const now = Date.now();

  // Pre-generate UUID for session - this same ID will be used when persisting to DB
  // This ensures UI stability: no ID change means no component re-mount, no flicker
  const sessionId = randomUUID();

  // Add liveUuid to processed session data if this is a Live TV session
  // liveUuid comes from SSE notification key (/livetv/sessions/{uuid})
  const processedWithLiveUuid = {
    ...processed,
    liveUuid: liveUuid ?? null,
  };

  // Lock closes the check-then-act gap; only the re-checks and the dedup write live inside it.
  const pendingData = await cache.withSessionCreateLock(
    serverId,
    processed.sessionKey,
    async () => {
      const existingPending = await cache.getPendingSession(serverId, processed.sessionKey);
      if (existingPending) {
        console.log(
          `[SSEProcessor] Pending session already exists for ${processed.sessionKey}, skipping create`
        );
        return null;
      }

      // Reject a row whose server user differs from this play. Plex reuses
      // sessionKey counters across PMS restarts, so a stale open row from
      // another user can carry this key; skipping create against it would leave
      // this user untracked. Leave the foreign row for the stale-sweep and
      // create fresh under the correct user.
      const existingActive = await findActiveSession({
        serverId,
        sessionKey: processed.sessionKey,
        ratingKey: processed.ratingKey,
      });
      if (existingActive?.serverUserId === userDetail.id) {
        console.log(
          `[SSEProcessor] Active session already exists for ${processed.sessionKey}, skipping create`
        );
        return null;
      }

      // Create pending session data
      const data: PendingSessionData = {
        id: sessionId,
        confirmation: createInitialConfirmationState(now),
        processed: processedWithLiveUuid,
        server: { id: srv.id, name: srv.name, type: srv.type },
        serverUser: userDetail,
        geo,
        startedAt: now,
        lastSeenAt: now,
        currentState: processedWithLiveUuid.state,
        pausedDurationMs: 0,
        lastPausedAt: processedWithLiveUuid.state === 'paused' ? now : null,
      };

      // Store in Redis only (not DB yet)
      await cache.setPendingSession(serverId, processed.sessionKey, data);

      return data;
    }
  );

  if (!pendingData) {
    return;
  }

  // Build ActiveSession for immediate display in Now Playing dashboard
  // This ensures sessions appear immediately, not after 30s confirmation
  const activeSession = buildPendingActiveSession(pendingData);

  // Add to active sessions cache so Now Playing shows it immediately
  await cache.addActiveSession(activeSession);

  // Broadcast session:started immediately for real-time UI updates
  // Note: Rules are NOT evaluated yet - that happens after confirmation
  if (pubSubService) {
    await pubSubService.publish('session:started', activeSession);
    await enqueueNotification({ type: 'session_started', payload: activeSession });
  }

  console.log(
    `[SSEProcessor] Created pending session for ${processed.mediaTitle} (awaiting 30s confirmation)`
  );
}

/**
 * Handle media change (e.g., auto-play next episode reusing the same sessionKey)
 * Atomically stops old session and creates new one for accurate play history
 */
async function handleMediaChange(
  existingSession: typeof sessions.$inferSelect,
  processed: ReturnType<typeof mapMediaSession>,
  server: typeof servers.$inferSelect
): Promise<void> {
  const serverUserRows = await db
    .select({
      id: serverUsers.id,
      userId: serverUsers.userId,
      username: serverUsers.username,
      thumbUrl: serverUsers.thumbUrl,
      identityName: users.name,
      trustScore: serverUsers.trustScore,
      lastActivityAt: serverUsers.lastActivityAt,
      createdAt: serverUsers.createdAt,
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
  const activeSessions = excludeUncountableSessions(
    await cacheService.getAllActiveSessions(),
    gracePeriodSessionIds()
  );
  const identityServerUserIds = await resolveIdentityServerUserIds(
    serverUser.userId,
    'media change'
  );
  const recentSessions = await fetchRecentSessionsForRules(serverUser.id, identityServerUserIds);

  const result = await handleMediaChangeAtomic({
    existingSession,
    processed,
    server: { id: server.id, name: server.name, type: server.type },
    serverUser: { ...serverUser, identityServerUserIds },
    geo,
    activeRulesV2,
    activeSessions,
    recentSessions,
  });

  if (!result) {
    return;
  }

  const { stoppedSession, insertedSession, violationResults, wasTerminatedByRule, qualityChange } =
    result;

  clearDbWriteTracking(stoppedSession.id);
  fastPathWindowStart.delete(stoppedSession.id);

  // Update cache for stopped session
  await cacheService.removeActiveSession(stoppedSession.id);

  if (pubSubService) {
    await pubSubService.publish('session:stopped', stoppedSession.id);

    try {
      await broadcastViolations(violationResults, insertedSession.id, pubSubService);
    } catch (error) {
      console.error('[SSEProcessor] Error broadcasting violations:', error);
    }
  }

  if (qualityChange) {
    await handleQualityChangeFallout(qualityChange, cacheService, pubSubService);
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
    watched = checkWatchCompletion(
      currentWatchTimeMs,
      processed.progressMs,
      processed.totalDurationMs,
      await getWatchedThreshold(processed.mediaType)
    );
  }

  // Check if transcode state changed before updating
  const transcodeStateChanged =
    existingSession.videoDecision !== processed.videoDecision ||
    existingSession.audioDecision !== processed.audioDecision;

  // Build update payload
  const updatePayload: Partial<typeof sessions.$inferInsert> = {
    state: newState,
    quality: processed.quality,
    bitrate: processed.bitrate,
    progressMs: processed.progressMs || null,
    lastSeenAt: now, // Update for stale session detection
    lastPausedAt: pauseResult.lastPausedAt,
    pausedDurationMs: pauseResult.pausedDurationMs,
    watched,
    isTranscode: processed.isTranscode,
    videoDecision: processed.videoDecision,
    audioDecision: processed.audioDecision,
  };

  // Update stream details when valid (skip if API returned incomplete data)
  if (processed.sourceAudioCodec || processed.sourceVideoCodec) {
    Object.assign(updatePayload, pickStreamDetailFields(processed));
  }

  // Update session in database. Guarded by isNull(stoppedAt): a stop racing
  // this write must not resurrect the session into the cache.
  const updateResult = await db
    .update(sessions)
    .set(updatePayload)
    .where(and(eq(sessions.id, existingSession.id), isNull(sessions.stoppedAt)))
    .returning({ id: sessions.id });

  if (updateResult.length === 0) {
    console.log(
      `[SSEProcessor] Session ${existingSession.id} already stopped, skipping resurrection`
    );
    return;
  }

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
            userId: serverUsers.userId,
            username: serverUsers.username,
            thumbUrl: serverUsers.thumbUrl,
            identityName: users.name,
            trustScore: serverUsers.trustScore,
            lastActivityAt: serverUsers.lastActivityAt,
            createdAt: serverUsers.createdAt,
          })
          .from(serverUsers)
          .innerJoin(users, eq(serverUsers.userId, users.id))
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
            const activeSessions = excludeUncountableSessions(
              await cacheService.getAllActiveSessions(),
              gracePeriodSessionIds()
            );
            const identityServerUserIds = await resolveIdentityServerUserIds(
              serverUserDetail.userId,
              'transcode re-eval'
            );
            const recentSessions = await fetchRecentSessionsForRules(
              serverUserDetail.id,
              identityServerUserIds
            );

            const violationResults = await reEvaluateRulesOnTranscodeChange({
              existingSession,
              processed,
              server: { id: server.id, name: server.name, type: server.type },
              serverUser: { ...serverUserDetail, identityServerUserIds },
              activeRulesV2,
              activeSessions,
              recentSessions,
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

  // Re-evaluate pause-related V2 rules when the session is currently paused.
  // Runs every update cycle because pause duration grows over time.
  if (newState === 'paused') {
    try {
      const activeRulesV2 = await getActiveRulesV2();
      if (activeRulesV2.length > 0 && cacheService) {
        const serverUserRows = await db
          .select({
            id: serverUsers.id,
            userId: serverUsers.userId,
            username: serverUsers.username,
            thumbUrl: serverUsers.thumbUrl,
            identityName: users.name,
            trustScore: serverUsers.trustScore,
            lastActivityAt: serverUsers.lastActivityAt,
            createdAt: serverUsers.createdAt,
          })
          .from(serverUsers)
          .innerJoin(users, eq(serverUsers.userId, users.id))
          .where(eq(serverUsers.id, existingSession.serverUserId))
          .limit(1);

        const serverUserDetail = serverUserRows[0];
        if (serverUserDetail) {
          const serverRows = await db
            .select()
            .from(servers)
            .where(eq(servers.id, existingSession.serverId))
            .limit(1);

          const server = serverRows[0];
          if (server) {
            const activeSessions = excludeUncountableSessions(
              await cacheService.getAllActiveSessions(),
              gracePeriodSessionIds()
            );
            const identityServerUserIds = await resolveIdentityServerUserIds(
              serverUserDetail.userId,
              'pause re-eval'
            );
            const recentSessions = await fetchRecentSessionsForRules(
              serverUserDetail.id,
              identityServerUserIds
            );

            const violationResults = await reEvaluateRulesOnPauseState({
              existingSession,
              processed,
              pauseData: {
                lastPausedAt: pauseResult.lastPausedAt,
                pausedDurationMs: pauseResult.pausedDurationMs,
              },
              server: { id: server.id, name: server.name, type: server.type },
              serverUser: { ...serverUserDetail, identityServerUserIds },
              activeRulesV2,
              activeSessions,
              recentSessions,
            });

            if (violationResults.length > 0 && pubSubService) {
              await broadcastViolations(violationResults, existingSession.id, pubSubService);
            }
          }
        }
      }
    } catch (error) {
      console.error(
        `[SSEProcessor] Error re-evaluating pause rules for session ${existingSession.id}:`,
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

      // Update stream details in cache when valid
      if (processed.sourceAudioCodec || processed.sourceVideoCodec) {
        cached.sourceVideoCodec = processed.sourceVideoCodec ?? null;
        cached.sourceAudioCodec = processed.sourceAudioCodec ?? null;
        cached.sourceAudioChannels = processed.sourceAudioChannels ?? null;
        cached.sourceVideoDetails = processed.sourceVideoDetails ?? null;
        cached.sourceAudioDetails = processed.sourceAudioDetails ?? null;
        cached.streamVideoCodec = processed.streamVideoCodec ?? null;
        cached.streamAudioCodec = processed.streamAudioCodec ?? null;
        cached.streamVideoDetails = processed.streamVideoDetails ?? null;
        cached.streamAudioDetails = processed.streamAudioDetails ?? null;
        cached.transcodeInfo = processed.transcodeInfo ?? null;
        cached.subtitleInfo = processed.subtitleInfo ?? null;
      }

      await cacheService.updateActiveSession(cached);

      if (pubSubService) {
        await pubSubService.publish('session:updated', cached);
      }
    }
  }
}

/**
 * Discard a pending session (phantom session cleanup).
 * Called when media changes before 30s confirmation or when session stops before confirmation.
 * Removes from all caches and broadcasts session:stopped.
 *
 * @param serverId Server ID
 * @param sessionKey Session key
 * @param pendingData Pending session data to discard
 */
async function discardPendingSession(
  serverId: string,
  sessionKey: string,
  pendingData: PendingSessionData
): Promise<void> {
  if (!cacheService) return;
  const cache = cacheService;
  const sessionId = pendingData.id;

  // Take the same lock the confirm path uses and re-read the pending entry.
  // A concurrent confirm can persist this session and delete the pending entry
  // before this lock-free discard runs; without the recheck the discard would
  // evict the freshly confirmed session and leave its DB row open until the
  // stale sweep.
  const outcome = await cache.withSessionCreateLock(serverId, sessionKey, async () => {
    const stillPending = await cache.getPendingSession(serverId, sessionKey);
    if (!stillPending) {
      return 'confirmed-elsewhere' as const;
    }
    await cache.deletePendingSession(serverId, sessionKey);
    await cache.removeActiveSession(sessionId);
    return 'discarded' as const;
  });

  if (outcome === 'discarded') {
    // Broadcast session:stopped so UI removes the phantom.
    if (pubSubService) {
      await pubSubService.publish('session:stopped', sessionId);
    }
    return;
  }

  // A confirm won the race: the pending entry was already persisted ('confirmed
  // -elsewhere') or the confirm still holds the lock (null). Either way the
  // pending entry is not this discard's to remove. Close any persisted row
  // through the normal stop path instead of evicting a live session.
  //
  // Known residual (S2 ghost window): confirmPendingSessionAndPersist does its
  // updateActiveSession/broadcast after releasing the create lock, so a confirm
  // that just released can re-add the session to the cache moments after this
  // stop closes it here. The row stays closed in the DB; the stale cache entry
  // self-heals on the next reconciliation tick or its cache TTL. Left as-is
  // because widening the lock to cover the post-persist cache write would hold
  // it across broadcasts for every confirm.
  const persisted = await findActiveSessionsAll({ serverId, sessionKey });
  for (const row of persisted) {
    await stopSession(row);
  }
}

/**
 * Update a pending session (Redis-only, not yet in DB).
 * If the session meets the 30s confirmation threshold, persist to DB and evaluate rules.
 *
 * @param serverId Server ID
 * @param sessionKey Session key
 * @param pendingData Current pending session data
 * @param newState New playback state
 * @param viewOffset Optional view offset from progress event
 */
async function updatePendingSession(
  serverId: string,
  sessionKey: string,
  pendingData: PendingSessionData,
  newState: 'playing' | 'paused',
  viewOffset?: number
): Promise<void> {
  if (!cacheService) return;

  const now = Date.now();
  const previousState = pendingData.currentState;

  // Calculate pause accumulation
  // Note: Using inline logic instead of calculatePauseAccumulation() because:
  // - Pending sessions use epoch numbers (for JSON serialization)
  // - calculatePauseAccumulation() uses Date objects
  // - Avoiding Date object churn on frequent progress events
  let pausedDurationMs = pendingData.pausedDurationMs;
  let lastPausedAt = pendingData.lastPausedAt;

  if (previousState === 'paused' && newState === 'playing') {
    if (lastPausedAt) {
      pausedDurationMs += now - lastPausedAt;
    }
    lastPausedAt = null;
  } else if (previousState === 'playing' && newState === 'paused') {
    lastPausedAt = now;
  }

  // Update confirmation state with progress if provided
  const currentViewOffset = viewOffset ?? pendingData.confirmation.maxViewOffset;
  const updatedConfirmation = updateConfirmationState(pendingData.confirmation, currentViewOffset);

  // Check if playback is now confirmed
  const isConfirmed = isPlaybackConfirmed(updatedConfirmation, currentViewOffset, newState, now);

  if (isConfirmed) {
    // Session is confirmed - persist to DB and evaluate rules
    await confirmPendingSessionAndPersist(serverId, sessionKey, {
      ...pendingData,
      confirmation: { ...updatedConfirmation, confirmedPlayback: true },
      currentState: newState,
      pausedDurationMs,
      lastPausedAt,
      lastSeenAt: now,
    });
  } else {
    // Still pending - update Redis data
    const updatedData: PendingSessionData = {
      ...pendingData,
      confirmation: updatedConfirmation,
      currentState: newState,
      pausedDurationMs,
      lastPausedAt,
      lastSeenAt: now,
    };
    await cacheService.setPendingSession(serverId, sessionKey, updatedData);

    if (previousState !== newState) {
      const cached = await cacheService.getSessionById(pendingData.id);
      if (cached) {
        cached.state = newState;
        cached.lastPausedAt = lastPausedAt ? new Date(lastPausedAt) : null;
        cached.pausedDurationMs = pausedDurationMs;
        await cacheService.updateActiveSession(cached);

        if (pubSubService) {
          await pubSubService.publish('session:updated', cached);
        }
      }
    }
  }
}

/**
 * Confirm a pending session by persisting to DB with rule evaluation.
 * Called when a session meets the 30s confirmation threshold.
 *
 * Since pending sessions now use pre-generated UUIDs, the session ID is stable
 * throughout the lifecycle - no ID change occurs during confirmation.
 * This eliminates UI flicker and broken session detail pages.
 *
 * @param serverId Server ID
 * @param sessionKey Session key
 * @param pendingData Final pending session data (includes pre-generated UUID)
 * @returns true if a session row now sits active in the DB/cache for this identity
 */
async function confirmPendingSessionAndPersist(
  serverId: string,
  sessionKey: string,
  pendingData: PendingSessionData
): Promise<boolean> {
  if (!cacheService) return false;

  // Capture for closure - avoids non-null assertion in callback
  const cache = cacheService;

  // The session ID is stable - pre-generated when pending session was created
  const sessionId = pendingData.id;

  // Delete only after the row is confirmed to exist (persisted here, or already
  // persisted by a concurrent caller), never before the lock. A contended lock
  // must leave the pending entry in Redis for the next confirming caller instead
  // of losing the session with no DB row written.
  const result = await cache.withSessionCreateLock(serverId, sessionKey, async () => {
    // A stop's phantom-discard runs without this lock, so it can delete the
    // pending entry at any point up to here. Recheck before doing anything
    // else: if it's gone, a discard already won and this confirm must not
    // resurrect the session.
    const stillPending = await cache.getPendingSession(serverId, sessionKey);
    if (!stillPending) {
      console.log(
        `[SSEProcessor] Pending session ${sessionKey} was discarded before confirm reached the lock, skipping`
      );
      return null;
    }

    // Double-check no active session was created while we were confirming.
    // Reject a row whose server user differs from this pending session: Plex
    // reuses sessionKey counters across PMS restarts, so a stale open row from
    // another user can carry this key. Bailing against it would drop this
    // confirmed play; leave the foreign row for the stale-sweep and persist.
    const existingActive = await findActiveSession({
      serverId,
      sessionKey,
      ratingKey: pendingData.processed.ratingKey,
    });
    if (existingActive?.serverUserId === pendingData.serverUser.id) {
      console.log(`[SSEProcessor] Active session created while confirming ${sessionKey}, skipping`);
      await cache.deletePendingSession(serverId, sessionKey);
      return null;
    }

    const activeRulesV2 = await getActiveRulesV2();
    const activeSessions = excludeUncountableSessions(
      await cache.getAllActiveSessions(),
      gracePeriodSessionIds()
    );
    const recentSessions = await fetchRecentSessionsForRules(
      pendingData.serverUser.id,
      pendingData.serverUser.identityServerUserIds
    );

    const persisted = await confirmAndPersistSession({
      pendingData,
      activeRulesV2,
      activeSessions,
      recentSessions,
    });

    await cache.deletePendingSession(serverId, sessionKey);
    return persisted;
  });

  if (!result) {
    return false;
  }

  const { insertedSession, violationResults, qualityChange, wasTerminatedByRule } = result;

  // Handle quality change (rare but possible)
  if (qualityChange) {
    await handleQualityChangeFallout(qualityChange, cache, pubSubService);
  }

  // Broadcast any violations
  if (pubSubService) {
    try {
      await broadcastViolations(violationResults, insertedSession.id, pubSubService);
    } catch (error) {
      console.error('[SSEProcessor] Error broadcasting violations:', error);
    }
  }

  // If terminated by rule, clean up the session from cache. termination.ts
  // already broadcast session:stopped for the kill, so this path must not
  // publish it a second time.
  if (wasTerminatedByRule) {
    await cache.removeActiveSession(sessionId);

    console.log(
      `[SSEProcessor] Confirmed session ${sessionId} was terminated by rule, removed from cache`
    );
    return false;
  }

  // Build the confirmed active session with full DB data
  // The ID is the same pre-generated UUID used throughout
  const activeSession = buildActiveSession({
    session: insertedSession,
    processed: pendingData.processed,
    user: pendingData.serverUser,
    geo: pendingData.geo,
    server: pendingData.server,
  });

  // Update cache in place - no ID change means simple update, no atomic swap needed
  // The session ID is stable, so we just replace the session data
  await cacheService.updateActiveSession(activeSession);

  // Broadcast session:updated to inform clients the session is now confirmed
  // No stop+start dance needed since the ID is stable
  if (pubSubService) {
    await pubSubService.publish('session:updated', activeSession);
  }

  console.log(
    `[SSEProcessor] Confirmed and persisted session ${sessionId} for ${pendingData.processed.mediaTitle}`
  );
  return true;
}

/**
 * Stop a session
 */
async function stopSession(existingSession: typeof sessions.$inferSelect): Promise<void> {
  const cachedSession = await cacheService?.getSessionById(existingSession.id);

  const { wasUpdated, durationMs, needsRetry, retryData } = await stopSessionAtomic({
    session: existingSession,
    stoppedAt: new Date(),
  });

  clearDbWriteTracking(existingSession.id);
  fastPathWindowStart.delete(existingSession.id);

  if (needsRetry && retryData && cacheService) {
    await cacheService.addSessionWriteRetry(existingSession.id, retryData);
  }

  if (!wasUpdated) {
    console.log(`[SSEProcessor] Session ${existingSession.id} already stopped, skipping`);
    return;
  }

  if (cacheService) {
    await cacheService.removeActiveSession(existingSession.id);
  }

  if (pubSubService) {
    await pubSubService.publish('session:stopped', existingSession.id);
    if (cachedSession) {
      await enqueueNotification({
        type: 'session_stopped',
        payload: { ...cachedSession, durationMs },
      });
    }
  }

  console.log(`[SSEProcessor] Stopped session ${existingSession.id}`);
}
