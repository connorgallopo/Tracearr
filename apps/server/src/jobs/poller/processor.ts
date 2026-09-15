/**
 * Session Processor
 *
 * Core processing logic for the poller:
 * - processServerSessions: Process sessions from a single server
 * - pollServers: Orchestrate polling across all servers
 * - Lifecycle management: start, stop, trigger
 */

import {
  POLLER_CONFIG,
  POLLING_INTERVALS,
  SESSION_LIMITS,
  usernameAsEmail,
  type ActiveSession,
  type EngineAutomation,
  type Session,
} from '@tracearr/shared';
import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../../db/client.js';
import {
  servers,
  serverUserExternalAliases,
  serverUsers,
  sessions,
  users,
} from '../../db/schema.js';
import { getGeoIPSettings } from '../../routes/settings.js';
import { isMaintenance } from '../../serverState.js';
import { isLeader } from '../../services/leaderLease.js';
import type { CacheService, PubSubService } from '../../services/cache.js';
import { type GeoLocation } from '../../services/geoip.js';
import { createMediaServerClient } from '../../services/mediaServer/index.js';
import type { MediaSession } from '../../services/mediaServer/types.js';
import { lookupGeoIP } from '../../services/plexGeoip.js';
import {
  fetchRecentSessionsForIdentity,
  setContextAssemblyDeps,
  toRuleSession,
} from '../../services/automations/events/contextAssembly.js';
import { dispatch } from '../../services/automations/events/dispatcher.js';
import {
  dispatchServerHealth,
  dispatchSessionFirstSeen,
} from '../../services/automations/events/producers.js';
import { registerRuleSubscribers } from '../../services/automations/events/subscribers.js';
import {
  registerPauseWakeSubscriptions,
  setPauseWakeDeps,
} from '../../services/automations/wakes/pauseWakes.js';
import { registerService, unregisterService } from '../../services/serviceTracker.js';
import { getWatchedThreshold } from '../../services/settings.js';
import { sseManager } from '../../services/sseManager.js';
import { registerLiveTvEpgPollTrigger } from '../../services/mediaServer/shared/liveTvEpg.js';
import { createLogger } from '../../utils/logger.js';

import {
  batchGetIdentityServerUserIds,
  batchGetLibraryItemIdentity,
  batchGetRecentUserSessions,
  getActiveAutomations,
  getCachedServers,
  widenRecentSessionsForMergedIdentities,
} from './database.js';
import {
  clearDbWriteTracking,
  recordDbWrite,
  resetDbWriteThrottle,
  shouldFlushDbWrite,
} from './dbWriteThrottle.js';
import { updatePendingSession } from './pendingConfirmation.js';
import {
  batchFindActiveSessionsByComposite,
  batchFindActiveSessionsByKey,
  buildActiveSession,
  buildPendingActiveSession,
  confirmAndPersistSession,
  createSessionWithRulesAtomic,
  findActiveSession,
  findActiveSessionByComposite,
  handleMediaChangeAtomic,
  handleQualityChangeFallout,
  processPollResults,
  stopSessionAtomic,
} from './sessionLifecycle.js';
import { mapMediaSession, pickLiveSessionFields, pickStreamDetailFields } from './sessionMapper.js';
import {
  buildCompositeKey,
  calculatePauseAccumulation,
  checkWatchCompletion,
  createInitialConfirmationState,
  detectMediaChange,
  shouldForceStopStaleSession,
  shouldWriteToDb,
} from './stateTracker.js';
import { PENDING_STOP_PERSIST_MIN_PROGRESS_MS } from './types.js';
import type {
  PendingSessionData,
  PendingSessionOutcome,
  PollerConfig,
  ResolvePendingSessionInput,
  ServerProcessingResult,
  ServerWithToken,
  StoppedSessionRef,
} from './types.js';
import { excludeUncountableSessions } from './utils.js';
import { broadcastViolations } from './violations.js';

// ============================================================================
// Module State
// ============================================================================

const pollerLogger = createLogger('Poller');

let pollingInterval: NodeJS.Timeout | null = null;
let staleSweepInterval: NodeJS.Timeout | null = null;
let cacheService: CacheService | null = null;
let pubSubService: PubSubService | null = null;
let previousPollHadSessions = false;
let currentPollIntervalMs: number = POLLING_INTERVALS.SESSIONS_IDLE;

registerLiveTvEpgPollTrigger((serverId) => {
  void triggerServerPoll(serverId);
});

const pollGuard = { running: false };
const sweepGuard = { running: false };
const reconcileGuard = { running: false };

/** Test-and-set reentrancy guard: returns false (and skips) if a run is already in progress. */
function acquireRunGuard(guard: { running: boolean }, label: string): boolean {
  if (guard.running) {
    console.log(`[Poller] Skipping ${label}, previous run still in progress`);
    return false;
  }
  guard.running = true;
  return true;
}

// Per-server mutex around processServerSessions, shared by pollServers,
// triggerServerPoll, and triggerReconciliationPoll. missedPollTracking below
// is unsynchronized module state: two runs racing for the same server can
// each observe the other's still-fresh grace-period entry and sweep it
// immediately, collapsing the intended two-poll grace window into a single
// miss. Holding this lock for a server's processServerSessions call (the
// whole body, for triggerServerPoll) prevents that.
//
// Every caller SKIPS a server whose lock is already held; none queue or
// coalesce. pollServers skips the busy server for that tick only, so a slow
// server can't make ticks pile up. triggerServerPoll and
// triggerReconciliationPoll drop the run for that server and rely on the
// next SSE event or timer tick to catch up. The entry is deleted (not
// flagged false) on release, so a server later removed from the DB leaves
// nothing behind.
const serverPollLocks = new Map<string, true>();

function acquireServerLock(serverId: string): boolean {
  if (serverPollLocks.has(serverId)) return false;
  serverPollLocks.set(serverId, true);
  return true;
}

// Servers poll concurrently so tick wall time tracks the slowest server, not
// the sum of every server's round trip. Per-server locks keep each iteration
// independent; the result accumulators are only pushed to between awaits.
const SERVER_POLL_CONCURRENCY = 5;

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      try {
        await fn(item);
      } catch (error) {
        // One item's failure degrades to that item only; a rejection here
        // would detach the sibling workers mid-tick and skip result handling
        // for servers that succeeded
        console.error('[Poller] Server poll worker failed:', error);
      }
    }
  });
  await Promise.all(workers);
}

function releaseServerLock(serverId: string): void {
  serverPollLocks.delete(serverId);
}

const defaultConfig: PollerConfig = {
  enabled: true,
  intervalMs: POLLING_INTERVALS.SESSIONS_IDLE,
};

// Time bound for active session queries to limit TimescaleDB chunk scanning.
// Active sessions should only exist in recent chunks - anything older would have
// been force-stopped by the stale session sweep. 7 days gives ample buffer.
const ACTIVE_SESSION_CHUNK_BOUND_MS = 7 * 24 * 60 * 60 * 1000;

// Grace period tracking for session stop detection. Reads and writes here
// must happen only while holding serverPollLocks for the session's server -
// this map is unsynchronized and a racing run for the same server would
// otherwise sweep the other run's fresh entry immediately.
// When a session disappears from a poll response, it enters a grace period
// rather than being stopped immediately. This prevents data loss from transient
// API failures (e.g., Emby/Jellyfin returning incomplete session data).
// On first miss: session is removed from cache (UI hides it) but DB is untouched.
// If the session reappears, it's recovered seamlessly with no data loss.
// On the NEXT poll, if still absent, the DB stop is confirmed and notification sent.
// Key: `serverId:sessionKey`, Value: ActiveSession snapshot for notification on confirmed stop.
const missedPollTracking = new Map<string, ActiveSession>();

const warnedMissingServerTypes = new Set<string>();

/**
 * Ids of sessions with at least one confirmed missed poll. Rule evaluation
 * excludes these; the dashboard keeps showing them until the stop is
 * confirmed on the next poll.
 */
export function gracePeriodSessionIds(): Set<string> {
  return new Set([...missedPollTracking.values()].map((s) => s.id));
}

/**
 * Handle first-miss grace period entries for a set of cached session keys.
 * Sessions that just disappeared from the API response are removed from cache
 * (UI hides them) but NOT stopped in DB. An ActiveSession snapshot is stored
 * in missedPollTracking for notification on confirmed stop.
 */
async function handleFirstMisses(
  cachedKeys: Iterable<string>,
  serverId: string,
  activeSessions: ActiveSession[],
  serverTypeMap: Map<string, string>
): Promise<void> {
  for (const cachedKey of cachedKeys) {
    if (!cachedKey.startsWith(`${serverId}:`)) continue;
    if (missedPollTracking.has(cachedKey)) continue; // Already in grace period

    const cachedActiveSession = activeSessions.find((s) => {
      const sType = (serverTypeMap.get(s.serverId) ?? 'plex') as
        | 'plex'
        | 'jellyfin'
        | 'emby'
        | 'dispatcharr';
      return (
        buildCompositeKey({
          serverType: sType,
          serverId: s.serverId,
          externalUserId: s.serverUserId,
          deviceId: s.deviceId ?? null,
          ratingKey: s.ratingKey ?? null,
          sessionKey: s.sessionKey,
        }) === cachedKey
      );
    });
    if (!cachedActiveSession) {
      console.warn(
        `[Poller] Cache mismatch for ${cachedKey}: in cachedSessionKeys but not in activeSessions`
      );
      continue;
    }

    // Only start tracking the miss here. The session stays visible in the cache
    // through the grace period so a single anomalous poll (a momentary empty or
    // partial session list) does not flush the dashboard. Removal and the
    // session:stopped broadcast happen in sweepGracePeriod once the miss is
    // confirmed on the next poll.
    missedPollTracking.set(cachedKey, cachedActiveSession);
  }
}

/**
 * Lazily backfill recentSessionsMap for a server user absent from the
 * new-session batch (e.g. a pending session confirming on a later tick, so
 * its key already reads as "not new"). Writes back into the map so repeat
 * lookups for the same user in one tick cost one query, not N.
 */
async function getOrFetchRecentSessions(
  recentSessionsMap: Map<string, Session[]>,
  serverUserId: string | undefined
): Promise<Session[]> {
  if (!serverUserId) return [];
  let recentSessions = recentSessionsMap.get(serverUserId);
  if (!recentSessions) {
    const recentForUser = await batchGetRecentUserSessions([serverUserId]);
    recentSessions = recentForUser.get(serverUserId) ?? [];
    recentSessionsMap.set(serverUserId, recentSessions);
  }
  return recentSessions;
}

/** A pending session that vanished pre-confirmation: mirrors sseProcessor's stop-before-confirm handling. */
async function resolveVanishedPendingSession(
  serverId: string,
  serverType: string,
  pendingKeySource: string
): Promise<void> {
  if (!cacheService) return;
  const cache = cacheService;
  const pendingKey =
    serverType === 'plex' ? pendingKeySource.slice(serverId.length + 1) : pendingKeySource;

  const pendingData = await cache.getPendingSession(serverId, pendingKey);
  if (!pendingData) return;

  const { maxViewOffset, initialViewOffset } = pendingData.confirmation;
  const progress = maxViewOffset - (initialViewOffset ?? maxViewOffset);

  if (progress < PENDING_STOP_PERSIST_MIN_PROGRESS_MS) {
    await cache.deletePendingSession(serverId, pendingKey);
    console.log(
      `[Poller] Discarded phantom pending session ${pendingKey} (id: ${pendingData.id}) ` +
        `(vanished before confirmation)`
    );
    return;
  }

  const lockResult = await cache.withSessionCreateLock(
    serverId,
    pendingData.processed.sessionKey,
    async () => {
      // Same two-part recheck as resolvePendingSession's create lock: a
      // concurrent SSE confirm/discard can have cleared the pending entry,
      // or already persisted a row under this same pre-generated id.
      const stillPending = await cache.getPendingSession(serverId, pendingKey);
      if (!stillPending) {
        console.log(
          `[Poller] Vanished pending session ${pendingKey} was discarded before the sweep reached the lock, skipping`
        );
        return null;
      }

      const [existingById] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, stillPending.id), isNull(sessions.stoppedAt)))
        .limit(1);
      if (existingById) {
        await cache.deletePendingSession(serverId, pendingKey);
        return null;
      }

      const activeAutomations = await getActiveAutomations();
      const activeSessions = excludeUncountableSessions(
        await cache.getAllActiveSessions(),
        gracePeriodSessionIds()
      );
      const recentSessions = await fetchRecentSessionsForIdentity(
        stillPending.serverUser.id,
        stillPending.serverUser.identityServerUserIds
      );

      const persisted = await confirmAndPersistSession({
        pendingData: stillPending,
        activeAutomations,
        activeSessions,
        recentSessions,
      });

      await cache.deletePendingSession(serverId, pendingKey);
      return persisted;
    }
  );

  if (!lockResult) return;

  if (lockResult.qualityChange) {
    await handleQualityChangeFallout(lockResult.qualityChange, cache, pubSubService);
  }
  if (lockResult.violationResults.length > 0 && pubSubService) {
    try {
      await broadcastViolations(
        lockResult.violationResults,
        lockResult.insertedSession.id,
        pubSubService
      );
    } catch (err) {
      console.error('[Poller] Failed to broadcast violations for vanished pending session:', err);
    }
  }
  if (lockResult.wasTerminatedByRule) return;

  const stopResult = await stopSessionAtomic({
    session: lockResult.insertedSession,
    stoppedAt: new Date(pendingData.lastSeenAt),
  });
  clearDbWriteTracking(lockResult.insertedSession.id);
  if (stopResult.needsRetry && stopResult.retryData) {
    await cache.addSessionWriteRetry(lockResult.insertedSession.id, stopResult.retryData);
  }

  console.log(
    `[Poller] Persisted vanished pending session ${lockResult.insertedSession.id} ` +
      `(${Math.round(progress / 1000)}s progress before disappearing)`
  );
}

/**
 * Sweep grace period entries that were tracked in a PREVIOUS poll cycle.
 * For each entry still absent, confirm the stop in DB and send notification.
 * Failed entries stay in the map for retry on the next poll.
 */
async function sweepGracePeriod(
  keysToSweep: Set<string>,
  serverId: string,
  serverTypeMap: Map<string, string>,
  currentSessionKeys?: Set<string>
): Promise<void> {
  // Dashboard invalidation is deferred to one call after the loop (instead of
  // one SCAN per removed session) - the flag must survive a mid-loop throw,
  // hence the outer try/finally rather than folding this into the return path.
  let dashboardStatsDirty = false;
  try {
    for (const key of keysToSweep) {
      if (currentSessionKeys?.has(key)) continue; // Reappeared

      try {
        const snapshot = missedPollTracking.get(key);
        if (!snapshot) {
          missedPollTracking.delete(key);
          continue;
        }

        // Pending sessions never wrote a DB row, so they resolve via Redis instead.
        if (snapshot.pending) {
          const pendingServerType = serverTypeMap.get(serverId);
          if (!pendingServerType) {
            if (!warnedMissingServerTypes.has(serverId)) {
              warnedMissingServerTypes.add(serverId);
              console.warn(
                `[Poller] No server type known for ${serverId}, skipping vanished pending session ${key} until it resolves`
              );
            }
            continue;
          }

          await resolveVanishedPendingSession(serverId, pendingServerType, key);
        } else {
          const serverType = serverTypeMap.get(serverId);
          const session =
            serverType && serverType !== 'plex'
              ? await findActiveSessionByComposite({
                  serverId,
                  serverUserId: snapshot.serverUserId,
                  deviceId: snapshot.deviceId || null,
                  ratingKey: snapshot.ratingKey ?? '',
                })
              : await findActiveSession({
                  serverId,
                  sessionKey: snapshot.sessionKey,
                  // Close only the tracked user's row: after a PMS restart the
                  // same sessionKey can sit on another user's live row
                  serverUserId: snapshot.serverUserId,
                });
          if (session) {
            // session.lastSeenAt is the last poll that confirmed this session
            // alive - it vanished 1-2 polls before this sweep, so `new Date()`
            // would bill the grace-period gap itself as watch time.
            const { needsRetry, retryData } = await stopSessionAtomic({
              session,
              stoppedAt: session.lastSeenAt,
            });
            clearDbWriteTracking(session.id);
            if (needsRetry && retryData && cacheService) {
              await cacheService.addSessionWriteRetry(session.id, retryData);
            }
          } else {
            console.log(
              `[Poller] Grace period: session for ${key} already stopped by another process`
            );
          }
        }

        // Confirmed miss: now remove from cache and broadcast the stop. This was
        // deferred from handleFirstMisses so a one-off bad poll can't flush the
        // dashboard before the grace period confirms the session really ended.
        if (cacheService) {
          await cacheService.removeActiveSession(snapshot.id, { skipDashboardInvalidation: true });
          dashboardStatsDirty = true;
        }
        if (pubSubService) {
          await pubSubService.publish('session:stopped', snapshot.id);
        }
      } catch (err) {
        console.error(`[Poller] Grace period sweep failed for ${key}, will retry next poll:`, err);
        continue;
      }
      missedPollTracking.delete(key);
    }
  } finally {
    if (dashboardStatsDirty && cacheService) {
      await cacheService.invalidateDashboardStatsCache();
    }
  }
}

/**
 * Reconcile grace-period entries for servers no longer in the current poll
 * set. Two different reasons land a server here, and they need different
 * handling:
 *  - SSE-covered (exists, not in fallback): reconciliation owns this server's
 *    grace entries. It created the entry when SSE missed a stop, and its
 *    two-pass sweep confirms it. The main tick (3-10s) fires between the
 *    30s reconciliation passes, so it must leave the entry alone; pruning
 *    here makes the confirm step unreachable and strands the session in
 *    cache (counted by rules) until the stale sweep. stopSessionAtomic's
 *    isNull(stoppedAt) guard already prevents any double-stop with SSE.
 *  - Removed from the DB: sessions.server_id is ON DELETE CASCADE, so the
 *    session row is already gone and there is nothing left to write or to
 *    build an evaluation context from - a stream-ended automation does not
 *    fire for it. The cache/pubsub entry is cleared the same way
 *    sweepGracePeriod clears a DB-confirmed stop.
 * Runs unprotected by serverPollLocks: the entries pruned belong to servers
 * this tick will not touch, and sweepGracePeriod already tolerates a
 * missing snapshot if triggerServerPoll or triggerReconciliationPoll races
 * this delete for the same server.
 */
async function pruneMissedPollTracking(
  serversNeedingPoll: { id: string }[],
  allServers: { id: string }[]
): Promise<void> {
  const pollableServerIds = new Set(serversNeedingPoll.map((server) => server.id));
  const existingServerIds = new Set(allServers.map((server) => server.id));
  // Same deferred-invalidation shape as sweepGracePeriod: one flush after the
  // loop, kept behind try/finally so a throw partway through still flushes
  // whatever was already removed.
  let dashboardStatsDirty = false;

  try {
    for (const [key, snapshot] of missedPollTracking) {
      if (pollableServerIds.has(snapshot.serverId)) continue;

      // SSE-covered server still in the DB: leave the entry for reconciliation.
      if (existingServerIds.has(snapshot.serverId)) continue;

      if (cacheService) {
        await cacheService.removeActiveSession(snapshot.id, { skipDashboardInvalidation: true });
        dashboardStatsDirty = true;
      }
      if (pubSubService) {
        await pubSubService.publish('session:stopped', snapshot.id);
      }
      missedPollTracking.delete(key);
    }
  } finally {
    if (dashboardStatsDirty && cacheService) {
      await cacheService.invalidateDashboardStatsCache();
    }
  }
}

// ============================================================================
// Server Session Processing
// ============================================================================

/**
 * Confirm or update a Redis-only pending session. Pending sessions are
 * invisible to cachedSessionKeys, so both poll branches must call this
 * before treating a session as new.
 */
async function resolvePendingSession(
  params: ResolvePendingSessionInput
): Promise<PendingSessionOutcome> {
  const {
    cacheService,
    pubSubService,
    server,
    pendingKey,
    processed,
    userDetail,
    activeAutomations,
    activeSessions,
    recentSessions,
    usePlexGeoip,
  } = params;

  const pendingSession = await cacheService.getPendingSession(server.id, pendingKey);
  if (!pendingSession) {
    return { status: 'not-pending' };
  }

  const { updatedData, isConfirmed } = updatePendingSession(
    pendingSession,
    processed.state,
    processed.progressMs,
    Date.now(),
    undefined,
    processed
  );

  if (!isConfirmed) {
    await cacheService.setPendingSession(server.id, pendingKey, updatedData);
    return { status: 'still-pending', updatedSession: buildPendingActiveSession(updatedData) };
  }

  const geo: GeoLocation = await lookupGeoIP(processed.ipAddress, usePlexGeoip);
  const createResult = await cacheService.withSessionCreateLock(
    server.id,
    processed.sessionKey,
    async () => {
      // Two checks, deliberately redundant. The stillPending re-read catches
      // a concurrent SSE confirm or discard that already cleared the pending
      // entry. The id-existence check guards this poller's own overlapping
      // ticks: this key's pending delete happens only after the lock is
      // released, so a second tick starting before that delete would
      // otherwise insert a duplicate row for the same session.
      const stillPending = await cacheService.getPendingSession(server.id, pendingKey);
      if (!stillPending) return null;

      const [existingById] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, updatedData.id), isNull(sessions.stoppedAt)))
        .limit(1);
      if (existingById) {
        // A concurrent caller already persisted this row. The pending entry is
        // now stale and its delete lives on the createResult path below, which
        // this early return skips - drop it here so the orphan sweep does not
        // later phantom-stop the live row this pending id points at.
        await cacheService.deletePendingSession(server.id, pendingKey);
        return null;
      }

      // Fresh processed/server/serverUser/geo (this tick's poll data) win over
      // updatedData's stale snapshot from pending creation; confirmAndPersistSession
      // corrects startedAt/pausedDurationMs/progressMs from updatedData's own fields.
      return confirmAndPersistSession({
        pendingData: { ...updatedData, processed, server, serverUser: userDetail, geo },
        activeAutomations,
        activeSessions,
        recentSessions,
      });
    }
  );

  if (!createResult || !('insertedSession' in createResult)) {
    return { status: 'confirmed', newSession: null };
  }

  await cacheService.deletePendingSession(server.id, pendingKey);
  const { insertedSession, violationResults, qualityChange, wasTerminatedByRule } = createResult;

  if (qualityChange) {
    await handleQualityChangeFallout(qualityChange, cacheService, pubSubService);
  }

  let newSession: ActiveSession | null = null;
  if (!wasTerminatedByRule) {
    newSession = buildActiveSession({
      session: insertedSession,
      processed: updatedData.processed,
      user: userDetail,
      geo,
      server,
    });
    recordDbWrite(insertedSession.id, Date.now());
  }

  if (violationResults.length > 0 && pubSubService) {
    try {
      await broadcastViolations(violationResults, insertedSession.id, pubSubService);
    } catch (err) {
      console.error('[Poller] Failed to broadcast violations:', err);
    }
  }

  return { status: 'confirmed', newSession };
}

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
export function mergeDispatcharrRealtimeSessions(
  realtimeSessions: MediaSession[],
  restSessions: MediaSession[]
): MediaSession[] {
  const restBySessionKey = new Map(restSessions.map((session) => [session.sessionKey, session]));
  const mergedRealtime = realtimeSessions.map((session) => ({
    ...session,
    ...(restBySessionKey.get(session.sessionKey) ?? {}),
  }));
  const realtimeKeys = new Set(realtimeSessions.map((session) => session.sessionKey));
  return [
    ...mergedRealtime,
    ...restSessions.filter((session) => !realtimeKeys.has(session.sessionKey)),
  ];
}

/**
 * Dispatcharr WebSocket updates are authoritative snapshots. Unlike a REST
 * poll, an entry absent from one of those snapshots is a confirmed stop and
 * must not wait for the generic two-poll grace period.
 */
async function stopMissingSessionsImmediately(
  cachedSessionKeys: Set<string>,
  currentSessionKeys: Set<string>,
  server: ServerWithToken,
  activeSessions: ActiveSession[]
): Promise<StoppedSessionRef[]> {
  const stoppedSessions: StoppedSessionRef[] = [];

  for (const activeSession of activeSessions) {
    if (activeSession.serverId !== server.id) continue;

    const activeKey = buildCompositeKey({
      serverType: server.type,
      serverId: server.id,
      externalUserId: activeSession.serverUserId,
      deviceId: activeSession.deviceId ?? null,
      ratingKey: activeSession.ratingKey ?? null,
      sessionKey: activeSession.sessionKey,
    });
    if (!cachedSessionKeys.has(activeKey) || currentSessionKeys.has(activeKey)) continue;

    const cache = cacheService;
    if (cache) {
      const pending = await cache.getPendingSession(server.id, activeKey);
      if (pending) {
        await cache.deletePendingSession(server.id, activeKey);
        stoppedSessions.push({
          id: activeSession.id,
          serverId: activeSession.serverId,
          sessionKey: activeSession.sessionKey,
        });
        missedPollTracking.delete(activeKey);
        continue;
      }
    }

    const result = await stopSessionAtomic({
      session: activeSession as unknown as typeof sessions.$inferSelect,
      stoppedAt: new Date(),
    });
    if (!result.wasUpdated) continue;

    clearDbWriteTracking(activeSession.id);
    if (result.needsRetry && result.retryData && cache) {
      await cache.addSessionWriteRetry(activeSession.id, result.retryData);
    }

    stoppedSessions.push({
      id: activeSession.id,
      serverId: activeSession.serverId,
      sessionKey: activeSession.sessionKey,
    });
    missedPollTracking.delete(activeKey);
  }

  return stoppedSessions;
}

export async function processServerSessions(
  server: ServerWithToken,
  activeAutomations: EngineAutomation[],
  cachedSessionKeys: Set<string>,
  activeSessions: ActiveSession[] = [],
  options: { mediaSessions?: MediaSession[]; immediateStops?: boolean } = {}
): Promise<ServerProcessingResult> {
  const newSessions: ActiveSession[] = [];
  const updatedSessions: ActiveSession[] = [];
  const currentSessionKeys = new Set<string>();
  const confirmedFromPendingIds = new Set<string>();
  let watchedTransitionOccurred = false;

  // Get GeoIP settings once at the start
  const { usePlexGeoip } = await getGeoIPSettings();
  // Watched thresholds fetched once per cycle rather than per session (settings cache is 10s anyway)
  const watchedThresholds = {
    movie: await getWatchedThreshold('movie'),
    episode: await getWatchedThreshold('episode'),
    track: await getWatchedThreshold('track'),
  };

  try {
    // Fetch sessions from server using unified adapter
    const client = createMediaServerClient({
      type: server.type,
      url: server.url,
      token: server.token,
      ignoreAnonymousStreams: server.ignoreAnonymousStreams,
      id: server.id,
      name: server.name,
    });
    const mediaSessions = options.mediaSessions ?? (await client.getSessions());
    sseManager.nudgeReconnect(server.id);

    const processedSessions = mediaSessions.map((s) => mapMediaSession(s, server.type));

    // OPTIMIZATION: Early return if no active sessions from media server
    if (processedSessions.length === 0) {
      if (options.immediateStops) {
        return {
          success: true,
          newSessions: [],
          stoppedSessions: await stopMissingSessionsImmediately(
            cachedSessionKeys,
            currentSessionKeys,
            server,
            activeSessions
          ),
          updatedSessions: [],
          watchedTransitionOccurred: false,
          confirmedFromPendingIds: new Set(),
        };
      }
      // Snapshot keys already in grace period BEFORE adding new entries
      const keysToSweep = new Set(
        [...missedPollTracking.keys()].filter((k) => k.startsWith(`${server.id}:`))
      );
      const sTypeMap = new Map([[server.id, server.type]]);
      await handleFirstMisses(cachedSessionKeys, server.id, activeSessions, sTypeMap);
      await sweepGracePeriod(keysToSweep, server.id, sTypeMap);

      // stoppedSessions intentionally empty
      return {
        success: true,
        newSessions: [],
        stoppedSessions: [],
        updatedSessions: [],
        watchedTransitionOccurred: false,
        confirmedFromPendingIds: new Set(),
      };
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
        lastActivityAt: serverUsers.lastActivityAt,
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

    // External ids a same-server merge folded into another account. Resolving
    // these is what stops the merge from being undone by the next stream.
    const aliasResolvedExternalIds = new Set<string>();
    const unmatchedExternalIds = sessionExternalIds.filter(
      (externalId) => !serverUserByExternalId.has(externalId)
    );
    if (unmatchedExternalIds.length > 0) {
      const aliased = await db
        .select({
          aliasExternalId: serverUserExternalAliases.externalId,
          id: serverUsers.id,
          userId: serverUsers.userId,
          serverId: serverUsers.serverId,
          externalId: serverUsers.externalId,
          username: serverUsers.username,
          email: serverUsers.email,
          thumbUrl: serverUsers.thumbUrl,
          isServerAdmin: serverUsers.isServerAdmin,
          trustScore: serverUsers.trustScore,
          lastActivityAt: serverUsers.lastActivityAt,
          createdAt: serverUsers.createdAt,
          updatedAt: serverUsers.updatedAt,
          identityName: users.name,
        })
        .from(serverUserExternalAliases)
        .innerJoin(serverUsers, eq(serverUserExternalAliases.serverUserId, serverUsers.id))
        .innerJoin(users, eq(serverUsers.userId, users.id))
        .where(
          and(
            eq(serverUserExternalAliases.serverId, server.id),
            inArray(serverUserExternalAliases.externalId, unmatchedExternalIds)
          )
        );

      for (const { aliasExternalId, ...serverUser } of aliased) {
        serverUserByExternalId.set(aliasExternalId, serverUser);
        serverUserById.set(serverUser.id, serverUser);
        aliasResolvedExternalIds.add(aliasExternalId);
      }
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
        // An aliased match is a different account on the media server that was
        // folded into this one, so its name and avatar are not this account's.
        const needsUpdate =
          !aliasResolvedExternalIds.has(processed.externalUserId) &&
          (existingServerUser.username !== processed.username ||
            (processed.userThumb && existingServerUser.thumbUrl !== processed.userThumb));

        if (needsUpdate) {
          await db
            .update(serverUsers)
            .set({
              username: processed.username,
              thumbUrl: processed.userThumb || existingServerUser.thumbUrl,
              ...(server.type === 'plex' ? {} : { email: usernameAsEmail(processed.username) }),
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
    // Wrapped in transaction to prevent orphan identity users if server user insert fails
    if (serverUsersToCreate.length > 0) {
      const { newIdentityUsers, newServerUsers } = await db.transaction(async (tx) => {
        // First, create identity users for each new server user
        const identityUsers = await tx
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
        const serverUserRows = await tx
          .insert(serverUsers)
          .values(
            serverUsersToCreate.map((u, idx) => ({
              userId: identityUsers[idx]!.id,
              serverId: server.id,
              externalId: u.externalId,
              username: u.username,
              email: server.type === 'plex' ? null : usernameAsEmail(u.username),
              thumbUrl: u.thumbUrl,
            }))
          )
          .returning();

        return { newIdentityUsers: identityUsers, newServerUsers: serverUserRows };
      });

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

    // OPTIMIZATION: Batch load recent sessions for rule evaluation (new sessions only)
    // and batch the active-session lookup for already-tracked sessions.
    const serverUsersWithNewSessions = new Set<string>();
    const plexSessionKeysToCheck: string[] = [];
    const compositeIdentitiesToCheck: { serverUserId: string; ratingKey: string }[] = [];
    for (let i = 0; i < processedSessions.length; i++) {
      const processed = processedSessions[i]!;
      const serverUserId = sessionServerUserIds[i];
      // serverUserId must match what pollServers uses from cachedSessions
      const sessionKey = buildCompositeKey({
        serverType: server.type,
        serverId: server.id,
        externalUserId: serverUserId ?? processed.externalUserId,
        deviceId: processed.deviceId,
        ratingKey: processed.ratingKey,
        sessionKey: processed.sessionKey,
      });
      const isNew = !cachedSessionKeys.has(sessionKey);
      if (isNew) {
        if (serverUserId) serverUsersWithNewSessions.add(serverUserId);
      } else if (server.type === 'plex') {
        plexSessionKeysToCheck.push(processed.sessionKey);
      } else if (serverUserId) {
        compositeIdentitiesToCheck.push({ serverUserId, ratingKey: processed.ratingKey ?? '' });
      }
    }

    const recentSessionsMap = await batchGetRecentUserSessions([...serverUsersWithNewSessions]);
    const plexActiveBatch =
      server.type === 'plex'
        ? await batchFindActiveSessionsByKey(server.id, plexSessionKeysToCheck)
        : new Map<string, (typeof sessions.$inferSelect)[]>();
    const compositeActiveBatch =
      server.type !== 'plex'
        ? await batchFindActiveSessionsByComposite(server.id, compositeIdentitiesToCheck)
        : new Map<string, (typeof sessions.$inferSelect)[]>();

    // One query per poll cycle resolves identity for every rating key; the insert path reads it off processed.
    const identityRatingKeys = processedSessions
      .map((p) => p.ratingKey)
      .filter((k): k is string => Boolean(k));
    const libraryItemIdentityMap = await batchGetLibraryItemIdentity(server.id, identityRatingKeys);
    for (const p of processedSessions) {
      p.identity = libraryItemIdentityMap.get(p.ratingKey) ?? null;
    }

    // OPTIMIZATION: Batch load sibling server_user ids per identity for cross-server
    // rule aggregation on merged users. One query per poll tick covers every server
    // user in this batch, avoiding a per-session/per-tick lookup in the hot path.
    // Skipped when there are no V2 rules to evaluate.
    const identityUserIds = [...new Set(Array.from(serverUserById.values()).map((u) => u.userId))];
    const identityServerUserIdsMap =
      activeAutomations.length > 0
        ? await batchGetIdentityServerUserIds(identityUserIds)
        : new Map<string, string[]>();

    // OPTIMIZATION: Widen recentSessionsMap for merged identities so the windowed
    // rule evaluators (unique_ips_in_window, unique_devices_in_window,
    // travel_speed_kmh) aggregate across every server the identity is merged
    // into. Only identities with more than one server_user are touched - unmerged
    // users (the overwhelming majority) see zero behavior change and zero extra
    // query cost. Failure here falls back to the narrower per-server_user
    // recentSessions already in the map (degraded detection, never a crash or a
    // blocked poll cycle).
    try {
      await widenRecentSessionsForMergedIdentities(recentSessionsMap, identityServerUserIdsMap);
    } catch (error) {
      console.error(
        '[Poller] Failed to widen recent sessions for merged identities, evaluating rules with per-server data only:',
        error
      );
    }

    // Concurrent-stream counting must not see sessions the system already
    // considers probably stopped, or unconfirmed pendings. A copy (not the
    // shared `activeSessions` passed in) so pending confirms appended below,
    // during this server's pass, never leak into another server's tick.
    const ruleEvalSessions = [
      ...excludeUncountableSessions(activeSessions, gracePeriodSessionIds()),
    ];

    // Process each session
    for (let i = 0; i < processedSessions.length; i++) {
      const processed = processedSessions[i]!;
      const serverUserId = sessionServerUserIds[i];
      const sessionKey = buildCompositeKey({
        serverType: server.type,
        serverId: server.id,
        externalUserId: serverUserId ?? processed.externalUserId,
        deviceId: processed.deviceId,
        ratingKey: processed.ratingKey,
        sessionKey: processed.sessionKey,
      });
      currentSessionKeys.add(sessionKey);

      // Isolated per session: a throw here (transient DB error, bad payload)
      // must not discard sessions already handled this tick or skip the grace
      // sweep below. The key is already in currentSessionKeys above, so a
      // session that fails here still counts as present for grace-period
      // purposes, not as missing - only client.getSessions() and the setup
      // preceding this loop can make success false.
      try {
        if (!serverUserId) {
          console.error('Failed to get/create server user for session');
          continue;
        }

        // Get server user details from cache
        const serverUserFromCache = serverUserById.get(serverUserId);
        const userDetail = serverUserFromCache
          ? {
              id: serverUserFromCache.id,
              userId: serverUserFromCache.userId,
              username: serverUserFromCache.username,
              thumbUrl: serverUserFromCache.thumbUrl,
              identityName: serverUserFromCache.identityName,
              trustScore: serverUserFromCache.trustScore,
              lastActivityAt: serverUserFromCache.lastActivityAt,
              createdAt: serverUserFromCache.createdAt,
              identityServerUserIds: identityServerUserIdsMap.get(serverUserFromCache.userId) ?? [
                serverUserFromCache.id,
              ],
            }
          : {
              id: serverUserId,
              // Defensive fallback: the server user was resolved but is missing from
              // cache. This should be unreachable since every id in
              // sessionServerUserIds is added to serverUserById above.
              userId: '',
              username: 'Unknown',
              thumbUrl: null,
              identityName: null,
              trustScore: 100,
              lastActivityAt: null,
              createdAt: new Date(), // Brand new users genuinely have 0-day account age
              identityServerUserIds: [serverUserId],
            };

        const isNew = !cachedSessionKeys.has(sessionKey);

        if (isNew) {
          // Distributed lock prevents race condition with SSE
          if (!cacheService) {
            console.warn('[Poller] Cache service not available, skipping session creation');
            continue;
          }

          // cachedSessionKeys only tracks confirmed sessions, so an SSE-created pending one still reads as new.
          const pendingKey = server.type === 'plex' ? processed.sessionKey : sessionKey;
          const pendingOutcome = await resolvePendingSession({
            cacheService,
            pubSubService,
            server: { id: server.id, name: server.name, type: server.type },
            pendingKey,
            processed,
            userDetail,
            activeAutomations,
            activeSessions: ruleEvalSessions,
            recentSessions: recentSessionsMap.get(serverUserId) ?? [],
            usePlexGeoip,
          });

          if (pendingOutcome.status === 'confirmed') {
            if (pendingOutcome.newSession) {
              newSessions.push(pendingOutcome.newSession);
              confirmedFromPendingIds.add(pendingOutcome.newSession.id);
              // So a second pending confirming later in this same pass counts this one too.
              ruleEvalSessions.push(pendingOutcome.newSession);
            }
            continue;
          }
          if (pendingOutcome.status === 'still-pending') {
            updatedSessions.push(pendingOutcome.updatedSession);
            continue;
          }

          // Get GeoIP location (uses Plex API if enabled, falls back to MaxMind)
          const geo: GeoLocation = await lookupGeoIP(processed.ipAddress, usePlexGeoip);

          const createResult = await cacheService.withSessionCreateLock<
            | { rediscovered: typeof sessions.$inferSelect }
            | { pendingCreated: PendingSessionData }
            | null
          >(server.id, processed.sessionKey, async () => {
            if (cacheService) {
              const stillPending = await cacheService.getPendingSession(server.id, pendingKey);
              if (stillPending) {
                console.log(
                  `[Poller] Pending session appeared for ${processed.sessionKey} while acquiring the create lock, deferring to next tick`
                );
                return null;
              }
            }

            // Reject a row whose server user differs from this play before
            // rediscovering it: Plex reuses sessionKey counters across PMS
            // restarts, so a stale open row from another user can carry this
            // key. Rediscovering it would touch its lastSeenAt (keeping it
            // alive) and rebuild it under this user's identity. Leave it for
            // the stale-sweep and create fresh under the correct user.
            const existingWithSameKey = await findActiveSession({
              serverId: server.id,
              sessionKey: processed.sessionKey,
              ratingKey: processed.ratingKey,
            });

            if (existingWithSameKey?.serverUserId === userDetail.id) {
              cachedSessionKeys.add(sessionKey);
              // Clear any grace period tracking - session is confirmed active
              missedPollTracking.delete(sessionKey);
              console.log(`[Poller] Recovering active session ${processed.sessionKey} into cache`);
              // Return the existing session for cache recovery instead of null
              return { rediscovered: existingWithSameKey };
            }

            // Check if this session was recently terminated (cooldown prevents re-creation)
            if (cacheService && processed.ratingKey) {
              const hasCooldown =
                server.type === 'plex'
                  ? await cacheService.hasTerminationCooldown(
                      server.id,
                      processed.sessionKey,
                      processed.ratingKey
                    )
                  : await cacheService.hasTerminationCooldownComposite(
                      server.id,
                      userDetail.id,
                      processed.deviceId || processed.sessionKey,
                      processed.ratingKey
                    );
              if (hasCooldown) {
                console.log(
                  `[Poller] Session ${processed.sessionKey} was recently terminated, skipping create`
                );
                return null;
              }
            }

            // Duplicate check: Plex-only (JF/Emby use composite keys)
            if (server.type === 'plex' && processed.ratingKey && userDetail?.id) {
              const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);

              const [existingForContent] = await db
                .select({ id: sessions.id, sessionKey: sessions.sessionKey })
                .from(sessions)
                .where(
                  and(
                    eq(sessions.serverUserId, userDetail.id),
                    eq(sessions.ratingKey, processed.ratingKey),
                    isNull(sessions.stoppedAt),
                    gte(sessions.startedAt, chunkBound)
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

            // Rules and the DB row wait for confirmation on a later tick, same as the SSE path.
            if (!cacheService) {
              return null;
            }

            const nowMs = Date.now();
            const pendingData: PendingSessionData = {
              id: randomUUID(),
              confirmation: createInitialConfirmationState(nowMs),
              processed,
              server: { id: server.id, name: server.name, type: server.type },
              serverUser: userDetail,
              geo,
              startedAt: nowMs,
              lastSeenAt: nowMs,
              currentState: processed.state,
              pausedDurationMs: 0,
              lastPausedAt: processed.state === 'paused' ? nowMs : null,
            };

            await cacheService.setPendingSession(server.id, pendingKey, pendingData);
            return { pendingCreated: pendingData };
          });

          if (!createResult) {
            continue;
          }

          if ('pendingCreated' in createResult) {
            const activeSession = buildPendingActiveSession(createResult.pendingCreated);
            await cacheService.addActiveSession(activeSession);
            if (pubSubService) {
              await pubSubService.publish('session:started', activeSession);
            }
            await dispatchSessionFirstSeen({
              session: activeSession,
              server: { id: server.id, name: server.name, type: server.type },
              serverUser: userDetail,
              at: new Date(createResult.pendingCreated.startedAt),
            });
            continue;
          }

          // Handle rediscovered session - existing active session found in DB but missing from cache.
          // This happens on server restart or after a grace period recovery.
          if ('rediscovered' in createResult && createResult.rediscovered) {
            const existing = createResult.rediscovered;
            try {
              // Update lastSeenAt so sweepStaleSessions doesn't kill it.
              // Guarded by isNull(stoppedAt): a stop racing this touch must not
              // resurrect the session into the cache.
              const touchResult = await db
                .update(sessions)
                .set({ lastSeenAt: new Date() })
                .where(and(eq(sessions.id, existing.id), isNull(sessions.stoppedAt)))
                .returning({ id: sessions.id });

              if (touchResult.length === 0) {
                console.log(
                  `[Poller] Rediscovered session ${existing.id} already stopped, skipping resurrection`
                );
              } else {
                const activeSession = buildActiveSession({
                  session: existing,
                  processed,
                  user: userDetail,
                  geo,
                  server,
                  overrides: {
                    state: processed.state,
                    lastPausedAt: existing.lastPausedAt,
                    pausedDurationMs: existing.pausedDurationMs ?? 0,
                    watched: existing.watched ?? false,
                  },
                });
                updatedSessions.push(activeSession);
              }
            } catch (err) {
              console.error(`[Poller] Failed to recover rediscovered session ${existing.id}:`, err);
            }
            continue;
          }

          // Guard: rediscovered returned but session was null
          if ('rediscovered' in createResult) {
            console.error(
              `[Poller] Unexpected null rediscovered session for ${processed.sessionKey}`
            );
            continue;
          }
        } else {
          // Pending session check (cache-first for JF/Emby, SSE for Plex)
          if (cacheService) {
            const pendingKey = server.type === 'plex' ? processed.sessionKey : sessionKey;
            const outcome = await resolvePendingSession({
              cacheService,
              pubSubService,
              server: { id: server.id, name: server.name, type: server.type },
              pendingKey,
              processed,
              userDetail,
              activeAutomations,
              activeSessions: ruleEvalSessions,
              recentSessions: await getOrFetchRecentSessions(recentSessionsMap, serverUserId),
              usePlexGeoip,
            });

            if (outcome.status === 'confirmed') {
              if (outcome.newSession) {
                newSessions.push(outcome.newSession);
                confirmedFromPendingIds.add(outcome.newSession.id);
                // So a second pending confirming later in this same pass counts this one too.
                ruleEvalSessions.push(outcome.newSession);
              }
              continue;
            }
            if (outcome.status === 'still-pending') {
              updatedSessions.push(outcome.updatedSession);
              continue;
            }
          }

          // Get existing ACTIVE session to check for state changes. Plex: match
          // by sessionKey alone (most recent active row). Filtering by the
          // incoming ratingKey here would drop the still-active old row on a
          // real media change (same sessionKey, new ratingKey) and leave the
          // detectMediaChange branch below unreachable.
          const existingRow =
            server.type === 'plex'
              ? (plexActiveBatch.get(processed.sessionKey)?.[0] ?? null)
              : ((
                  compositeActiveBatch.get(`${userDetail.id}::${processed.ratingKey ?? ''}`) ?? []
                ).find((r) =>
                  processed.deviceId ? r.deviceId === processed.deviceId : r.deviceId === null
                ) ?? null);

          // Plex reuses sessionKey counters across PMS restarts, so a stale open
          // row matched by sessionKey alone can belong to a different user than
          // this play. Only reuse the row when its server user matches;
          // otherwise treat it as no match so the stale row falls to the
          // stale-sweep and this play creates fresh under the correct user. The
          // composite (JF/Emby) key already includes userDetail.id, so this is a
          // no-op there.
          const existingSession =
            existingRow && existingRow.serverUserId !== userDetail.id ? null : existingRow;

          // Skip the GeoIP lookup when the IP matches the existing row - reuse its geo data.
          const geo: GeoLocation =
            existingSession?.ipAddress === processed.ipAddress
              ? {
                  city: existingSession.geoCity,
                  region: existingSession.geoRegion,
                  country: existingSession.geoCountry,
                  countryCode: existingSession.geoCountry,
                  continent: existingSession.geoContinent,
                  postal: existingSession.geoPostal,
                  lat: existingSession.geoLat,
                  lon: existingSession.geoLon,
                  asnNumber: existingSession.geoAsnNumber,
                  asnOrganization: existingSession.geoAsnOrganization,
                }
              : await lookupGeoIP(processed.ipAddress, usePlexGeoip);

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
                // Double-check inside lock - SSE might have created it. Reject a
                // row whose server user differs from this play: Plex reuses
                // sessionKey counters across PMS restarts, so a stale open row
                // from another user can carry this key. Treating it as a match
                // would skip creation and leave this user untracked; leave it
                // for the stale-sweep and create fresh under the correct user.
                const existingWithSameKey = await findActiveSession({
                  serverId: server.id,
                  sessionKey: processed.sessionKey,
                  ratingKey: processed.ratingKey,
                });
                if (existingWithSameKey?.serverUserId === userDetail.id) {
                  cachedSessionKeys.add(sessionKey);
                  console.log(
                    `[Poller] Session created by SSE for ${processed.sessionKey}, skipping`
                  );
                  return null;
                }

                // Check if this session was recently terminated (cooldown prevents re-creation)
                if (processed.ratingKey) {
                  const hasCooldown =
                    server.type === 'plex'
                      ? await cacheService!.hasTerminationCooldown(
                          server.id,
                          processed.sessionKey,
                          processed.ratingKey
                        )
                      : await cacheService!.hasTerminationCooldownComposite(
                          server.id,
                          userDetail.id,
                          processed.deviceId || processed.sessionKey,
                          processed.ratingKey
                        );
                  if (hasCooldown) {
                    console.log(
                      `[Poller] Session ${processed.sessionKey} was recently terminated, skipping stale recovery`
                    );
                    return null;
                  }
                }

                // Issue #121: Plex-only duplicate check for session key reassignment.
                if (server.type === 'plex' && processed.ratingKey && userDetail?.id) {
                  // Time bound reduces TimescaleDB chunk scanning
                  const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);

                  const [existingForContent] = await db
                    .select({ id: sessions.id, sessionKey: sessions.sessionKey })
                    .from(sessions)
                    .where(
                      and(
                        eq(sessions.serverUserId, userDetail.id),
                        eq(sessions.ratingKey, processed.ratingKey),
                        isNull(sessions.stoppedAt),
                        gte(sessions.startedAt, chunkBound)
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
                  activeAutomations,
                  activeSessions: ruleEvalSessions,
                  recentSessions,
                });
              }
            );

            if (createResult) {
              const { insertedSession, violationResults, qualityChange, wasTerminatedByRule } =
                createResult;

              if (qualityChange) {
                const { stoppedSession } = qualityChange;
                await handleQualityChangeFallout(qualityChange, cacheService, pubSubService);

                // Prevent "stale" detection for this session
                const stoppedKey = buildCompositeKey({
                  serverType: server.type,
                  serverId: server.id,
                  externalUserId: stoppedSession.serverUserId,
                  deviceId: stoppedSession.deviceId,
                  ratingKey: stoppedSession.ratingKey,
                  sessionKey: stoppedSession.sessionKey,
                });
                cachedSessionKeys.delete(stoppedKey);
              }

              if (wasTerminatedByRule) {
                console.log(
                  `[Poller] Stale recovery session ${processed.sessionKey} was terminated by rule, skipping cache add`
                );
                try {
                  await broadcastViolations(violationResults, insertedSession.id, pubSubService);
                } catch (err) {
                  console.error('[Poller] Failed to broadcast violations:', err);
                }
                continue;
              }

              const activeSession = buildActiveSession({
                session: insertedSession,
                processed,
                user: userDetail,
                geo,
                server,
              });
              newSessions.push(activeSession);
              // So a second brand-new session created later in this same pass counts this one too.
              ruleEvalSessions.push(activeSession);
              recordDbWrite(insertedSession.id, Date.now());
              cachedSessionKeys.add(sessionKey);

              try {
                await broadcastViolations(violationResults, insertedSession.id, pubSubService);
              } catch (err) {
                console.error('[Poller] Failed to broadcast violations:', err);
              }
            }
            continue;
          }

          // Issue #57: Plex-only media change detection (e.g. "Play Next Episode").
          // Normalize '' to null: a row stored during a metadata blip carries an
          // empty ratingKey, which detectMediaChange would otherwise read as a
          // real key and treat the arrival of the true key as a media change.
          if (
            server.type === 'plex' &&
            detectMediaChange(existingSession.ratingKey || null, processed.ratingKey || null)
          ) {
            const recentSessions = await getOrFetchRecentSessions(recentSessionsMap, serverUserId);

            const mediaChangeResult = await handleMediaChangeAtomic({
              existingSession,
              processed,
              server: { id: server.id, name: server.name, type: server.type },
              serverUser: userDetail,
              geo,
              activeAutomations,
              activeSessions: ruleEvalSessions,
              recentSessions,
            });

            if (mediaChangeResult) {
              const {
                stoppedSession,
                insertedSession,
                violationResults,
                wasTerminatedByRule,
                qualityChange,
              } = mediaChangeResult;

              clearDbWriteTracking(stoppedSession.id);
              if (cacheService) {
                await cacheService.removeActiveSession(stoppedSession.id);
              }
              if (pubSubService) {
                await pubSubService.publish('session:stopped', stoppedSession.id);
              }

              if (qualityChange) {
                await handleQualityChangeFallout(qualityChange, cacheService, pubSubService);

                // Media change is Plex-only, so the twin's cache key is always this plain form.
                // Prevents the twin from riding into missedPollTracking as a first-miss.
                cachedSessionKeys.delete(`${server.id}:${qualityChange.stoppedSession.sessionKey}`);
              }

              // Broadcast violations for new session
              try {
                await broadcastViolations(violationResults, insertedSession.id, pubSubService);
              } catch (err) {
                console.error('[Poller] Failed to broadcast violations:', err);
              }

              if (wasTerminatedByRule) {
                console.log(
                  `[Poller] Media change session ${processed.sessionKey} was terminated by rule, skipping cache add`
                );
                continue;
              }

              const activeSession = buildActiveSession({
                session: insertedSession,
                processed,
                user: userDetail,
                geo,
                server,
              });
              newSessions.push(activeSession);
              recordDbWrite(insertedSession.id, Date.now());
              cachedSessionKeys.add(sessionKey);

              // Auto-play-next is a new playback too; it skips the pending phase,
              // so first sight and confirmation announce at the same moment.
              await dispatchSessionFirstSeen({
                session: activeSession,
                server: { id: server.id, name: server.name, type: server.type },
                serverUser: userDetail,
                at: insertedSession.startedAt,
              });
            }

            continue; // Skip normal update path
          }

          const previousState = existingSession.state;
          const newState = processed.state;
          const now = new Date();

          // Check if transcode state changed (e.g., user changed quality mid-stream)
          // If so, we need to update stream details which contain output dimensions
          const transcodeStateChanged =
            existingSession.videoDecision !== processed.videoDecision ||
            existingSession.audioDecision !== processed.audioDecision;

          // JF/Emby: session.Id changed (restart)
          if (server.type !== 'plex' && existingSession.sessionKey !== processed.sessionKey) {
            console.log(
              `[Poller] [${server.type.toUpperCase()}] Session ${sessionKey} session.Id changed: ${existingSession.sessionKey} → ${processed.sessionKey}`
            );
          }

          // Build base update payload
          const updatePayload: Partial<typeof sessions.$inferInsert> = {
            state: newState,
            ratingKey: processed.ratingKey || null,
            mediaTitle: processed.mediaTitle,
            totalDurationMs: processed.totalDurationMs || null,
            quality: processed.quality,
            bitrate: processed.bitrate,
            progressMs: processed.progressMs || null,
            dispatcharrPlaybackKind: processed.dispatcharrPlaybackKind ?? null,
            lastSeenAt: now,
            plexSessionId: processed.plexSessionId || null,
            isTranscode: processed.isTranscode,
            videoDecision: processed.videoDecision,
            audioDecision: processed.audioDecision,
            // Update sessionKey if session.Id changed on restart
            ...(existingSession.sessionKey !== processed.sessionKey && {
              sessionKey: processed.sessionKey,
            }),
          };

          // Update stream details when valid (skip if API returned incomplete data)
          if (processed.sourceAudioCodec || processed.sourceVideoCodec) {
            Object.assign(updatePayload, pickStreamDetailFields(processed));
          }

          const pauseResult = calculatePauseAccumulation(
            previousState,
            newState,
            {
              lastPausedAt: existingSession.lastPausedAt,
              pausedDurationMs: existingSession.pausedDurationMs || 0,
            },
            now
          );
          updatePayload.lastPausedAt = pauseResult.lastPausedAt;
          updatePayload.pausedDurationMs = pauseResult.pausedDurationMs;

          // Check for watch completion
          if (!existingSession.watched && processed.totalDurationMs) {
            const elapsedMs = now.getTime() - existingSession.startedAt.getTime();
            // Account for accumulated pauses and any ongoing pause
            const ongoingPauseMs = pauseResult.lastPausedAt
              ? now.getTime() - pauseResult.lastPausedAt.getTime()
              : 0;
            const currentWatchTimeMs = Math.max(
              0,
              elapsedMs - pauseResult.pausedDurationMs - ongoingPauseMs
            );
            if (
              checkWatchCompletion(
                currentWatchTimeMs,
                processed.progressMs,
                processed.totalDurationMs,
                processed.mediaType === 'episode'
                  ? watchedThresholds.episode
                  : processed.mediaType === 'track'
                    ? watchedThresholds.track
                    : watchedThresholds.movie
              )
            ) {
              updatePayload.watched = true;
            }
          }

          // Write to DB only on state changes or on the periodic jittered flush
          const watchedThresholdReached = updatePayload.watched === true;
          if (watchedThresholdReached) watchedTransitionOccurred = true;
          const hasChanges = shouldWriteToDb(existingSession, processed, watchedThresholdReached);
          const flushElapsed = shouldFlushDbWrite(existingSession.id, now.getTime());

          // Guarded by isNull(stoppedAt): a stop racing this write must not
          // resurrect the session into updatedSessions/cache.
          let wasStoppedConcurrently = false;
          if (hasChanges || flushElapsed) {
            const updateResult = await db
              .update(sessions)
              .set(updatePayload)
              .where(and(eq(sessions.id, existingSession.id), isNull(sessions.stoppedAt)))
              .returning({ id: sessions.id });

            if (updateResult.length === 0) {
              wasStoppedConcurrently = true;
              console.log(
                `[Poller] Session ${existingSession.id} already stopped, skipping resurrection`
              );
            } else {
              recordDbWrite(existingSession.id, now.getTime());
            }
          }

          if (wasStoppedConcurrently) {
            continue;
          }

          // If transcode state changed, re-evaluate rules that have transcode-related conditions.
          // Gated by the wasStoppedConcurrently guard above (like the pause re-eval below) so a
          // session stopped mid-tick cannot still earn a violation row or a kill enqueue.
          if (transcodeStateChanged && activeAutomations.length > 0) {
            try {
              const recentSessions = await getOrFetchRecentSessions(
                recentSessionsMap,
                serverUserId
              );
              const { violations } = await dispatch(
                {
                  type: 'session.transcode_changed',
                  at: now,
                  server: { id: server.id, name: server.name, type: server.type },
                  serverUser: userDetail,
                  previous: {
                    videoDecision: existingSession.videoDecision,
                    audioDecision: existingSession.audioDecision,
                  },
                  next: {
                    videoDecision: processed.videoDecision,
                    audioDecision: processed.audioDecision,
                  },
                  session: toRuleSession(existingSession, pickLiveSessionFields(processed)),
                },
                { activeAutomations, activeSessions: ruleEvalSessions, recentSessions }
              );
              if (violations.length > 0 && pubSubService) {
                await broadcastViolations(violations, existingSession.id, pubSubService);
              }
            } catch (error) {
              console.error(
                `[Poller] Error re-evaluating rules on transcode change for session ${existingSession.id}:`,
                error
              );
            }
          }

          if (previousState !== 'paused' && newState === 'paused' && activeAutomations.length > 0) {
            try {
              const recentSessions = await getOrFetchRecentSessions(
                recentSessionsMap,
                serverUserId
              );
              const { violations } = await dispatch(
                {
                  type: 'session.paused',
                  at: now,
                  server: { id: server.id, name: server.name, type: server.type },
                  serverUser: userDetail,
                  pauseData: {
                    lastPausedAt: pauseResult.lastPausedAt,
                    pausedDurationMs: pauseResult.pausedDurationMs,
                  },
                  session: toRuleSession(existingSession, {
                    ...pickLiveSessionFields(processed),
                    lastPausedAt: pauseResult.lastPausedAt,
                    pausedDurationMs: pauseResult.pausedDurationMs,
                  }),
                },
                { activeAutomations, activeSessions: ruleEvalSessions, recentSessions }
              );
              if (violations.length > 0 && pubSubService) {
                await broadcastViolations(violations, existingSession.id, pubSubService);
              }
            } catch (error) {
              console.error(
                `[Poller] Error re-evaluating pause rules for session ${existingSession.id}:`,
                error
              );
            }
          } else if (previousState === 'paused' && newState === 'playing') {
            await dispatch({
              type: 'session.resumed',
              at: now,
              sessionId: existingSession.id,
              serverId: server.id,
            });
          }

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
      } catch (error) {
        console.error(
          `[Poller] Failed to process session ${sessionKey} on ${server.name}, skipping:`,
          error
        );
      }
    }

    // Clear grace period tracking for sessions that are present in this poll
    for (const key of currentSessionKeys) {
      if (missedPollTracking.delete(key)) {
        console.log(`[Poller] Session ${key} reappeared after grace period miss, recovered`);
      }
    }

    // Snapshot keys already in grace period BEFORE adding new entries (sweep only processes previous polls).
    // Filter to only keys absent from current poll (keys in currentSessionKeys were already cleared above).
    const keysToSweep = new Set(
      [...missedPollTracking.keys()].filter((k) => k.startsWith(`${server.id}:`))
    );
    const sTypeMap = new Map([[server.id, server.type]]);
    if (options.immediateStops) {
      return {
        success: true,
        newSessions,
        stoppedSessions: await stopMissingSessionsImmediately(
          cachedSessionKeys,
          currentSessionKeys,
          server,
          activeSessions
        ),
        updatedSessions,
        watchedTransitionOccurred,
        confirmedFromPendingIds,
      };
    }
    await handleFirstMisses(
      [...cachedSessionKeys].filter(
        (k) => k.startsWith(`${server.id}:`) && !currentSessionKeys.has(k)
      ),
      server.id,
      activeSessions,
      sTypeMap
    );
    await sweepGracePeriod(keysToSweep, server.id, sTypeMap, currentSessionKeys);

    // stoppedSessions intentionally empty - grace period handles stops inline.
    // processPollResults still processes newSessions and updatedSessions normally.
    return {
      success: true,
      newSessions,
      stoppedSessions: [],
      updatedSessions,
      watchedTransitionOccurred,
      confirmedFromPendingIds,
    };
  } catch (error) {
    console.error(`Error polling server ${server.name}:`, error);
    return {
      success: false,
      newSessions: [],
      stoppedSessions: [],
      updatedSessions: [],
      watchedTransitionOccurred: false,
      confirmedFromPendingIds: new Set(),
    };
  }
}

// ============================================================================
// Main Polling Orchestration
// ============================================================================

/**
 * Collapse the adaptive interval back to idle cadence when nothing needs
 * polling this tick. This is the only place that can do it when
 * serversNeedingPoll is empty, since the normal adaptive-interval switch
 * further down never runs on this early-return path: a previously active
 * 3s interval would otherwise keep firing `select * from servers` every
 * tick with no servers to poll.
 */
function resetAdaptivePollInterval(): void {
  if (pollingInterval && currentPollIntervalMs !== POLLING_INTERVALS.SESSIONS_IDLE) {
    clearInterval(pollingInterval);
    pollingInterval = setInterval(() => void pollServers(), POLLING_INTERVALS.SESSIONS_IDLE);
    currentPollIntervalMs = POLLING_INTERVALS.SESSIONS_IDLE;
    console.log('[Poller] Adaptive: switched to idle (nothing to poll)');
  }
  previousPollHadSessions = false;
}

/**
 * Poll all connected servers for active sessions
 *
 * With SSE integration:
 * - Plex servers with active SSE connections are skipped (handled by SSE)
 * - Plex servers in fallback mode are polled
 * - Jellyfin/Emby servers without the SSE plugin are polled normally
 * - Jellyfin/Emby servers with an active SSE plugin connection skip polling
 */
async function pollServers(): Promise<void> {
  // Bail out if maintenance mode was activated while we were queued.
  // stopPoller() clears the interval but can't abort an in-flight call.
  if (isMaintenance()) return;
  if (!acquireRunGuard(pollGuard, 'poll tick')) return;

  try {
    // Get all connected servers
    const allServers = await getCachedServers();

    // Filter to only servers that need polling.
    // SSE-connected servers (Plex or JF/Emby with plugin) are handled by SSE events.
    // JF/Emby in unsupported/fallback state are covered by polling as normal.
    const serversNeedingPoll = allServers.filter((server) => sseManager.isInFallback(server.id));

    // Servers no longer in the poll set (removed from the DB, or moved to SSE
    // coverage) would otherwise keep their grace-period snapshot forever with
    // no poll left to confirm or clear it. Runs even when allServers is empty,
    // since that means every remaining entry belongs to a deleted server.
    await pruneMissedPollTracking(serversNeedingPoll, allServers);

    if (serversNeedingPoll.length === 0) {
      // Nothing to poll: either every remaining server is handled by an
      // active SSE connection, or there are no servers left at all.
      resetAdaptivePollInterval();
      return;
    }

    // Get cached session keys from atomic SET-based cache
    const cachedSessions = cacheService ? await cacheService.getAllActiveSessions() : [];

    const serverTypeMap = new Map(allServers.map((s) => [s.id, s.type]));

    // Plex: serverId:sessionKey, JF/Emby: composite key
    const cachedSessionKeys = new Set(
      cachedSessions.map((s) => {
        const sType = serverTypeMap.get(s.serverId);
        if (sType && sType !== 'plex') {
          return buildCompositeKey({
            serverType: sType,
            serverId: s.serverId,
            externalUserId: s.serverUserId,
            deviceId: s.deviceId ?? null,
            ratingKey: s.ratingKey ?? null,
            sessionKey: s.sessionKey,
          });
        }
        return `${s.serverId}:${s.sessionKey}`;
      })
    );

    // Get active V2 rules
    const activeAutomations = await getActiveAutomations();

    // Collect results from all servers
    const allNewSessions: ActiveSession[] = [];
    const allStoppedSessions: StoppedSessionRef[] = [];
    const allUpdatedSessions: ActiveSession[] = [];
    const allConfirmedFromPendingIds = new Set<string>();
    let anyWatchedTransition = false;

    // Process each server with health tracking
    const pollStartedAt = Date.now();
    await runWithConcurrency(serversNeedingPoll, SERVER_POLL_CONCURRENCY, async (server) => {
      const serverWithToken = server as ServerWithToken;

      if (!acquireServerLock(server.id)) {
        console.log(
          `[Poller] Skipping ${server.name}, already being polled by another entry point`
        );
        return;
      }

      try {
        // Get previous health state for transition detection
        const wasHealthy = cacheService ? await cacheService.getServerHealth(server.id) : null;

        const {
          success,
          newSessions,
          stoppedSessions,
          updatedSessions,
          watchedTransitionOccurred,
          confirmedFromPendingIds,
        } = await processServerSessions(
          serverWithToken,
          activeAutomations,
          cachedSessionKeys,
          cachedSessions
        );

        // Track health state and notify on transitions (with consecutive-failure threshold)
        if (cacheService) {
          const healthServer = { id: server.id, name: server.name, type: server.type };
          if (success) {
            const wasDown = wasHealthy === false;
            await cacheService.setServerHealth(server.id, true);
            await cacheService.resetServerFailCount(server.id);

            if (wasDown) {
              console.log(`[Poller] Server ${server.name} is back UP`);
              await dispatchServerHealth('server.up', healthServer, new Date());
            }
          } else {
            const failCount = await cacheService.incrServerFailCount(server.id);

            if (failCount >= POLLER_CONFIG.DOWN_THRESHOLD) {
              await cacheService.setServerHealth(server.id, false);

              if (wasHealthy !== false) {
                console.log(
                  `[Poller] Server ${server.name} is DOWN (${failCount} consecutive failures)`
                );
                await dispatchServerHealth('server.down', healthServer, new Date());
              }
            }
          }
        }

        allNewSessions.push(...newSessions);
        allStoppedSessions.push(...stoppedSessions);
        allUpdatedSessions.push(...updatedSessions);
        for (const id of confirmedFromPendingIds) allConfirmedFromPendingIds.add(id);
        if (watchedTransitionOccurred) anyWatchedTransition = true;
      } finally {
        releaseServerLock(server.id);
      }
    });

    const pollElapsedMs = Date.now() - pollStartedAt;
    if (pollElapsedMs > currentPollIntervalMs) {
      console.warn(
        `[Poller] Tick took ${pollElapsedMs}ms against a ${currentPollIntervalMs}ms interval; ` +
          `overlapping ticks are being dropped`
      );
    }

    await processPollResults({
      newSessions: allNewSessions,
      stoppedSessions: allStoppedSessions,
      updatedSessions: allUpdatedSessions,
      watchedTransitionOccurred: anyWatchedTransition,
      cachedSessions,
      cacheService,
      pubSubService,
      confirmedFromPendingIds: allConfirmedFromPendingIds,
    });

    if (allNewSessions.length > 0 || allStoppedSessions.length > 0) {
      console.log(
        `Poll complete: ${allNewSessions.length} new, ${allUpdatedSessions.length} updated, ${allStoppedSessions.length} stopped`
      );
    }

    // Adaptive polling. cachedSessions spans every server; scoping to servers
    // actually polled this tick keeps an idle fallback server (and its 3s
    // `select * from servers` tick) from being held active by an unrelated
    // session that SSE, not this poller, is tracking on another server.
    const polledServerIds = new Set(serversNeedingPoll.map((server) => server.id));
    const cachedSessionsOnPolledServers = cachedSessions.filter((s) =>
      polledServerIds.has(s.serverId)
    );
    const hasActiveSessions =
      allNewSessions.length > 0 ||
      allUpdatedSessions.length > 0 ||
      cachedSessionsOnPolledServers.length > allStoppedSessions.length;

    if (hasActiveSessions !== previousPollHadSessions && pollingInterval) {
      const newInterval = hasActiveSessions
        ? POLLING_INTERVALS.SESSIONS_ACTIVE
        : POLLING_INTERVALS.SESSIONS_IDLE;

      if (newInterval !== currentPollIntervalMs) {
        clearInterval(pollingInterval);
        pollingInterval = setInterval(() => void pollServers(), newInterval);
        currentPollIntervalMs = newInterval;
        console.log(
          `[Poller] Adaptive: switched to ${newInterval}ms (${hasActiveSessions ? 'active' : 'idle'})`
        );
      }
    }
    previousPollHadSessions = hasActiveSessions;
    // Stale sessions are swept on their own 60s interval (startPoller), not
    // per tick: the stale timeout is 300s, so tick-rate sweeping buys nothing.
  } catch (error) {
    // Suppress DB errors during maintenance - the in-flight poll was already
    // running when the DB went down and stopPoller() can't abort an active await.
    if (!isMaintenance()) {
      console.error('Polling error:', error);
    }
  } finally {
    pollGuard.running = false;
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
  if (!acquireRunGuard(sweepGuard, 'stale sweep')) return 0;

  try {
    // Calculate the stale threshold (sessions not seen in last 5 minutes)
    const staleThreshold = new Date(
      Date.now() - SESSION_LIMITS.STALE_SESSION_TIMEOUT_SECONDS * 1000
    );

    // Only check recent chunks to avoid locking all TimescaleDB partitions.
    // Active sessions can only exist in recent data - anything older would have
    // been force-stopped by previous sweeps. 7 days gives ample buffer.
    const chunkBound = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Find all active sessions that haven't been seen recently
    const staleSessions = await db
      .select()
      .from(sessions)
      .where(
        and(
          isNull(sessions.stoppedAt), // Still active
          lte(sessions.lastSeenAt, staleThreshold), // Not seen recently
          gte(sessions.startedAt, chunkBound) // Only recent chunks (reduces lock count)
        )
      );

    if (staleSessions.length === 0) {
      return 0;
    }

    console.log(`[Poller] Force-stopping ${staleSessions.length} stale session(s)`);

    const now = new Date();

    // Dashboard invalidation is deferred to one call after the loop (instead
    // of one SCAN per force-stopped session); try/finally so the flag still
    // flushes if a later iteration throws.
    let dashboardStatsDirty = false;
    try {
      for (const staleSession of staleSessions) {
        // Check if session should be force-stopped (using the stateTracker function)
        if (!shouldForceStopStaleSession(staleSession.lastSeenAt)) {
          // Shouldn't happen since we already filtered, but double-check
          continue;
        }

        const { wasUpdated, needsRetry, retryData } = await stopSessionAtomic({
          session: staleSession,
          stoppedAt: now,
          forceStopped: true,
        });
        clearDbWriteTracking(staleSession.id);

        if (needsRetry && retryData && cacheService) {
          await cacheService.addSessionWriteRetry(staleSession.id, retryData);
        }

        if (!wasUpdated) {
          continue;
        }

        if (cacheService) {
          await cacheService.removeActiveSession(staleSession.id, {
            skipDashboardInvalidation: true,
          });
          dashboardStatsDirty = true;
        }

        if (pubSubService) {
          await pubSubService.publish('session:stopped', staleSession.id);
        }
      }
    } finally {
      if (dashboardStatsDirty && cacheService) {
        await cacheService.invalidateDashboardStatsCache();
      }
    }

    return staleSessions.length;
  } catch (error) {
    console.error('[Poller] Error sweeping stale sessions:', error);
    return 0;
  } finally {
    sweepGuard.running = false;
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
  setContextAssemblyDeps({
    getAllActiveSessions: () => cache.getAllActiveSessions(),
    gracePeriodSessionIds,
  });
  registerRuleSubscribers();
  setPauseWakeDeps({ pubSubService });
  registerPauseWakeSubscriptions();
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

  const initialInterval = POLLING_INTERVALS.SESSIONS_IDLE;
  currentPollIntervalMs = initialInterval;
  console.log(
    `Starting session poller (active: ${POLLING_INTERVALS.SESSIONS_ACTIVE}ms, idle: ${initialInterval}ms)`
  );

  // Run immediately on start
  void pollServers();

  // Then run on interval (starts idle, switches to active when sessions detected)
  pollingInterval = setInterval(() => void pollServers(), initialInterval);
  registerService('poller', {
    name: 'Session Poller',
    description: 'Polls media servers for active sessions',
    intervalMs: initialInterval,
  });

  // Start stale session sweep (runs every 60 seconds to detect abandoned sessions)
  if (!staleSweepInterval) {
    console.log(
      `Starting stale session sweep with ${SESSION_LIMITS.STALE_SWEEP_INTERVAL_MS}ms interval`
    );
    staleSweepInterval = setInterval(
      () => void sweepStaleSessions(),
      SESSION_LIMITS.STALE_SWEEP_INTERVAL_MS
    );
    registerService('stale-sweep', {
      name: 'Stale Session Sweep',
      description: 'Detects and stops abandoned sessions',
      intervalMs: SESSION_LIMITS.STALE_SWEEP_INTERVAL_MS,
    });
  }
}

/**
 * Stop the polling job
 */
export function stopPoller(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    unregisterService('poller');
    console.log('Session poller stopped');
  }
  if (staleSweepInterval) {
    clearInterval(staleSweepInterval);
    staleSweepInterval = null;
    unregisterService('stale-sweep');
    console.log('Stale session sweep stopped');
  }
  missedPollTracking.clear();
  resetDbWriteThrottle();
  previousPollHadSessions = false;
  currentPollIntervalMs = POLLING_INTERVALS.SESSIONS_IDLE;
}

/**
 * Force an immediate poll
 */
export async function triggerPoll(): Promise<void> {
  await pollServers();
}

/**
 * Process a single server on demand, triggered by a plugin SSE event.
 * Runs the same pipeline as the normal poller for that one server only.
 */
export async function triggerServerPoll(
  serverId: string,
  options: { immediateStops?: boolean } = {}
): Promise<void> {
  if (isMaintenance()) return;
  // Plugin SSE events must only drive polls on the leaseholder; a follower
  // that somehow holds a connection must not write sessions or run rules
  if (!isLeader()) return;
  if (!acquireServerLock(serverId)) {
    console.log(`[Poller] Skipping server poll for ${serverId}, already being processed`);
    return;
  }

  try {
    const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
    if (!server) return;
    // Dispatcharr has its own authoritative WebSocket snapshot processor.
    // Do not race it with a generic REST poll while realtime is healthy.
    if (server.type === 'dispatcharr' && sseManager.isDispatcharrRealtimeHealthy(server.id)) {
      return;
    }

    const cachedSessions = cacheService ? await cacheService.getAllActiveSessions() : [];
    const serverTypeMap = new Map([[server.id, server.type]]);

    const cachedSessionKeys = new Set(
      cachedSessions.map((s) => {
        const sType = serverTypeMap.get(s.serverId);
        if (sType && sType !== 'plex') {
          return buildCompositeKey({
            serverType: sType,
            serverId: s.serverId,
            externalUserId: s.serverUserId,
            deviceId: s.deviceId ?? null,
            ratingKey: s.ratingKey ?? null,
            sessionKey: s.sessionKey,
          });
        }
        return `${s.serverId}:${s.sessionKey}`;
      })
    );

    const activeAutomations = await getActiveAutomations();
    const {
      newSessions,
      stoppedSessions,
      updatedSessions,
      watchedTransitionOccurred,
      confirmedFromPendingIds,
    } = await processServerSessions(server, activeAutomations, cachedSessionKeys, cachedSessions, {
      immediateStops: options.immediateStops,
    });

    if (newSessions.length > 0 || stoppedSessions.length > 0 || updatedSessions.length > 0) {
      await processPollResults({
        newSessions,
        stoppedSessions,
        updatedSessions,
        watchedTransitionOccurred,
        cachedSessions,
        cacheService,
        pubSubService,
        confirmedFromPendingIds,
      });
    }
  } catch (error) {
    if (!isMaintenance()) {
      console.error(`[Poller] triggerServerPoll error for ${serverId}:`, error);
    }
  } finally {
    releaseServerLock(serverId);
  }
}

/**
 * Reconciliation poll for SSE-connected servers
 *
 * This is a lighter poll that runs periodically to catch any events
 * that might have been missed by SSE. Polls all servers (Plex or JF/Emby)
 * that have active SSE connections (not in fallback mode).
 *
 * Unlike the main poller, this processes results and updates the cache
 * to sync any sessions that SSE may have missed.
 */
export async function triggerReconciliationPoll(): Promise<void> {
  if (!acquireRunGuard(reconcileGuard, 'reconciliation poll')) return;

  try {
    // Dispatcharr has an authoritative WebSocket snapshot processor. Generic
    // reconciliation is only for Plex/Jellyfin/Emby; Dispatcharr in fallback
    // is already covered by the main REST poller.
    const allServers = await getCachedServers();
    const sseServers = allServers.filter(
      (server) => server.type !== 'dispatcharr' && !sseManager.isInFallback(server.id)
    );

    if (sseServers.length === 0) {
      return;
    }

    pollerLogger.debug(
      `Running reconciliation poll for ${sseServers.length} SSE-connected server(s)`
    );

    // Get cached session keys from atomic SET-based cache. Build keys with the
    // same composite logic the main poller uses so JF/Emby sessions match.
    const serverTypeMap = new Map(allServers.map((s) => [s.id, s.type]));
    const cachedSessions = cacheService ? await cacheService.getAllActiveSessions() : [];
    const cachedSessionKeys = new Set(
      cachedSessions.map((s) => {
        const sType = serverTypeMap.get(s.serverId);
        if (sType && sType !== 'plex') {
          return buildCompositeKey({
            serverType: sType,
            serverId: s.serverId,
            externalUserId: s.serverUserId,
            deviceId: s.deviceId ?? null,
            ratingKey: s.ratingKey ?? null,
            sessionKey: s.sessionKey,
          });
        }
        return `${s.serverId}:${s.sessionKey}`;
      })
    );

    // Get active V2 rules
    const activeAutomations = await getActiveAutomations();

    // Collect results from all SSE servers
    const allNewSessions: ActiveSession[] = [];
    const allStoppedSessions: StoppedSessionRef[] = [];
    const allUpdatedSessions: ActiveSession[] = [];
    const allConfirmedFromPendingIds = new Set<string>();
    let anyWatchedTransition = false;

    // Process each SSE server and collect results
    await runWithConcurrency(sseServers, SERVER_POLL_CONCURRENCY, async (server) => {
      const serverWithToken = server as ServerWithToken;

      if (!acquireServerLock(server.id)) {
        console.log(
          `[Poller] Skipping reconciliation for ${server.name}, already being polled by another entry point`
        );
        return;
      }

      try {
        const {
          newSessions,
          stoppedSessions,
          updatedSessions,
          watchedTransitionOccurred,
          confirmedFromPendingIds,
        } = await processServerSessions(
          serverWithToken,
          activeAutomations,
          cachedSessionKeys,
          cachedSessions
        );
        allNewSessions.push(...newSessions);
        allStoppedSessions.push(...stoppedSessions);
        allUpdatedSessions.push(...updatedSessions);
        for (const id of confirmedFromPendingIds) allConfirmedFromPendingIds.add(id);
        if (watchedTransitionOccurred) anyWatchedTransition = true;
      } finally {
        releaseServerLock(server.id);
      }
    });

    if (
      allNewSessions.length > 0 ||
      allStoppedSessions.length > 0 ||
      allUpdatedSessions.length > 0
    ) {
      await processPollResults({
        newSessions: allNewSessions,
        stoppedSessions: allStoppedSessions,
        updatedSessions: allUpdatedSessions,
        watchedTransitionOccurred: anyWatchedTransition,
        cachedSessions,
        cacheService,
        pubSubService,
        confirmedFromPendingIds: allConfirmedFromPendingIds,
      });

      console.log(
        `[Poller] Reconciliation complete: ${allNewSessions.length} new, ${allUpdatedSessions.length} updated, ${allStoppedSessions.length} stopped`
      );
    }
  } catch (error) {
    console.error('[Poller] Reconciliation poll error:', error);
  } finally {
    reconcileGuard.running = false;
  }
}
