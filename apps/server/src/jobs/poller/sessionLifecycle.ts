/**
 * Session Lifecycle Operations
 *
 * Shared atomic operations for session creation and termination.
 * Used by both the Poller and SSE processor to ensure consistent handling.
 */

import { eq, and, desc, isNull, gte } from 'drizzle-orm';
import { TIME_MS, type ActiveSession, type StreamDetailFields } from '@tracearr/shared';
import { pickStreamDetailFields } from './sessionMapper.js';
import { db } from '../../db/client.js';
import { sessions } from '../../db/schema.js';
import type { GeoLocation } from '../../services/geoip.js';
import { ruleEngine } from '../../services/rules.js';
import {
  calculateStopDuration,
  checkWatchCompletion,
  shouldRecordSession,
} from './stateTracker.js';
import { sql } from 'drizzle-orm';
import {
  createViolationInTransaction,
  isDuplicateViolationInTransaction,
  type ViolationInsertResult,
} from './violations.js';
import type {
  SessionCreationInput,
  SessionCreationResult,
  QualityChangeResult,
  SessionStopInput,
  SessionStopResult,
  MediaChangeInput,
  MediaChangeResult,
} from './types.js';

// ============================================================================
// Serialization Retry Logic
// ============================================================================

// Constants for serializable transaction retry logic
const MAX_SERIALIZATION_RETRIES = 3;
const SERIALIZATION_RETRY_BASE_MS = 50; // P2-7: Increased from 10ms for better backoff
const TRANSACTION_TIMEOUT_MS = 10000; // P2-8: 10 second timeout for transactions

/**
 * Check if an error is a PostgreSQL serialization failure.
 * These occur when SERIALIZABLE transactions conflict.
 */
function isSerializationError(error: unknown): boolean {
  if (error instanceof Error) {
    // PostgreSQL error code 40001 = serialization_failure
    // The error message typically contains "could not serialize access"
    const message = error.message.toLowerCase();
    return (
      message.includes('could not serialize access') ||
      message.includes('serialization') ||
      (error as { code?: string }).code === '40001'
    );
  }
  return false;
}

// ============================================================================
// ActiveSession Builder
// ============================================================================

/**
 * Input for building an ActiveSession object
 */
export interface BuildActiveSessionInput {
  /** Session data from database (inserted or existing) */
  session: {
    id: string;
    startedAt: Date;
    lastPausedAt: Date | null;
    pausedDurationMs: number | null;
    referenceId: string | null;
    watched: boolean;
    externalSessionId?: string | null;
  };

  /** Processed session data from media server (extends StreamDetailFields for DRY) */
  processed: StreamDetailFields & {
    sessionKey: string;
    state: 'playing' | 'paused';
    mediaType: 'movie' | 'episode' | 'track' | 'live' | 'photo' | 'unknown';
    mediaTitle: string;
    grandparentTitle: string;
    seasonNumber: number;
    episodeNumber: number;
    year: number;
    thumbPath: string;
    ratingKey: string;
    totalDurationMs: number;
    progressMs: number;
    ipAddress: string;
    playerName: string;
    deviceId: string;
    product: string;
    device: string;
    platform: string;
    quality: string;
    isTranscode: boolean;
    videoDecision: string;
    audioDecision: string;
    bitrate: number;
    // Live TV specific fields
    channelTitle: string | null;
    channelIdentifier: string | null;
    channelThumb: string | null;
    // Music track metadata
    artistName: string | null;
    albumName: string | null;
    trackNumber: number | null;
    discNumber: number | null;
  };

  /** Server user info */
  user: {
    id: string;
    username: string;
    thumbUrl: string | null;
    identityName: string | null;
  };

  /** GeoIP location data */
  geo: GeoLocation;

  /** Server info */
  server: {
    id: string;
    name: string;
    type: 'plex' | 'jellyfin' | 'emby';
  };

  /** Optional overrides for update scenarios */
  overrides?: {
    state?: 'playing' | 'paused';
    lastPausedAt?: Date | null;
    pausedDurationMs?: number;
    watched?: boolean;
  };
}

/**
 * Build an ActiveSession object for cache and broadcast.
 */
export function buildActiveSession(input: BuildActiveSessionInput): ActiveSession {
  const { session, processed, user, geo, server, overrides } = input;

  return {
    // Core identifiers
    id: session.id,
    serverId: server.id,
    serverUserId: user.id,
    sessionKey: processed.sessionKey,

    // State (can be overridden for updates)
    state: overrides?.state ?? processed.state,

    // Media metadata
    mediaType: processed.mediaType,
    mediaTitle: processed.mediaTitle,
    grandparentTitle: processed.grandparentTitle || null,
    seasonNumber: processed.seasonNumber || null,
    episodeNumber: processed.episodeNumber || null,
    year: processed.year || null,
    thumbPath: processed.thumbPath || null,
    ratingKey: processed.ratingKey || null,

    // External session ID (for Plex API calls)
    externalSessionId: session.externalSessionId ?? null,

    // Timing
    startedAt: session.startedAt,
    stoppedAt: null, // Active sessions never have stoppedAt
    durationMs: null, // Calculated on stop

    // Progress
    totalDurationMs: processed.totalDurationMs || null,
    progressMs: processed.progressMs || null,

    // Pause tracking (can be overridden for updates)
    lastPausedAt:
      overrides?.lastPausedAt !== undefined ? overrides.lastPausedAt : session.lastPausedAt,
    pausedDurationMs:
      overrides?.pausedDurationMs !== undefined
        ? overrides.pausedDurationMs
        : (session.pausedDurationMs ?? 0),

    // Resume tracking
    referenceId: session.referenceId,

    // Watch status (can be overridden for updates)
    watched: overrides?.watched !== undefined ? overrides.watched : session.watched,

    // Network/device info
    ipAddress: processed.ipAddress,
    geoCity: geo.city,
    geoRegion: geo.region,
    geoCountry: geo.countryCode ?? geo.country,
    geoLat: geo.lat,
    geoLon: geo.lon,
    playerName: processed.playerName,
    deviceId: processed.deviceId || null,
    product: processed.product || null,
    device: processed.device || null,
    platform: processed.platform,

    // Quality/transcode info
    quality: processed.quality,
    isTranscode: processed.isTranscode,
    videoDecision: processed.videoDecision,
    audioDecision: processed.audioDecision,
    bitrate: processed.bitrate,

    // Stream details (source media, stream output, transcode/subtitle info)
    ...pickStreamDetailFields(processed),

    // Live TV specific fields
    channelTitle: processed.channelTitle,
    channelIdentifier: processed.channelIdentifier,
    channelThumb: processed.channelThumb,
    // Music track metadata
    artistName: processed.artistName,
    albumName: processed.albumName,
    trackNumber: processed.trackNumber,
    discNumber: processed.discNumber,

    // Relationships
    user,
    server: { id: server.id, name: server.name, type: server.type },
  };
}

// ============================================================================
// Session Query Helpers
// ============================================================================

/**
 * Find an active (not stopped) session by server ID and session key.
 */
export async function findActiveSession(
  serverId: string,
  sessionKey: string
): Promise<typeof sessions.$inferSelect | null> {
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, serverId),
        eq(sessions.sessionKey, sessionKey),
        isNull(sessions.stoppedAt)
      )
    )
    .limit(1);

  return rows[0] || null;
}

/**
 * Find all active (not stopped) sessions matching criteria.
 * Use when handling potential duplicates.
 */
export async function findActiveSessionsAll(
  serverId: string,
  sessionKey: string
): Promise<(typeof sessions.$inferSelect)[]> {
  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, serverId),
        eq(sessions.sessionKey, sessionKey),
        isNull(sessions.stoppedAt)
      )
    );
}

// ============================================================================
// Session Creation
// ============================================================================

/**
 * Create a session with atomic rule evaluation and violation creation.
 * Handles quality change detection, resume tracking, and rule violations.
 */
export async function createSessionWithRulesAtomic(
  input: SessionCreationInput
): Promise<SessionCreationResult> {
  const { processed, server, serverUser, geo, activeRules, recentSessions } = input;

  let referenceId: string | null = null;
  let qualityChange: QualityChangeResult | null = null;

  // STEP 1: Check for quality change (active session with same user+ratingKey)
  if (processed.ratingKey) {
    const activeSameContent = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.serverUserId, serverUser.id),
          eq(sessions.ratingKey, processed.ratingKey),
          isNull(sessions.stoppedAt)
        )
      )
      .orderBy(desc(sessions.startedAt))
      .limit(1);

    const existingActiveSession = activeSameContent[0];
    if (existingActiveSession) {
      // This is a quality/resolution change during playback
      // Stop the old session atomically with idempotency guard
      const now = new Date();

      // Use stopSessionAtomic for idempotency (prevents double-stop race conditions)
      // preserveWatched=true because playback continues in the new session
      const { wasUpdated } = await stopSessionAtomic({
        session: existingActiveSession,
        stoppedAt: now,
        preserveWatched: true,
      });

      // Only proceed with quality change if we actually stopped the session
      // If wasUpdated=false, another process already stopped it
      if (wasUpdated) {
        // Link to the original session chain
        referenceId = existingActiveSession.referenceId || existingActiveSession.id;

        qualityChange = {
          stoppedSession: {
            id: existingActiveSession.id,
            serverUserId: existingActiveSession.serverUserId,
            sessionKey: existingActiveSession.sessionKey,
          },
          referenceId,
        };

        console.log(
          `[SessionLifecycle] Quality change detected for user ${serverUser.id}, content ${processed.ratingKey}. Old session ${existingActiveSession.id} stopped.`
        );
      } else {
        console.log(
          `[SessionLifecycle] Quality change detected but session ${existingActiveSession.id} was already stopped by another process.`
        );
      }
    }
  }

  // STEP 2: Check for resume tracking (recently stopped session with same content)
  if (!referenceId && processed.ratingKey) {
    const oneDayAgo = new Date(Date.now() - TIME_MS.DAY);
    const recentSameContent = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.serverUserId, serverUser.id),
          eq(sessions.ratingKey, processed.ratingKey),
          gte(sessions.stoppedAt, oneDayAgo),
          eq(sessions.watched, false)
        )
      )
      .orderBy(desc(sessions.stoppedAt))
      .limit(1);

    const previousSession = recentSameContent[0];
    if (previousSession && processed.progressMs !== undefined) {
      const prevProgress = previousSession.progressMs || 0;
      if (processed.progressMs >= prevProgress) {
        // This is a resume - link to the first session in the chain
        referenceId = previousSession.referenceId || previousSession.id;
      }
    }
  }

  // STEP 3: Atomic transaction with SERIALIZABLE isolation and retry logic
  // SERIALIZABLE prevents phantom reads that cause duplicate violations
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_SERIALIZATION_RETRIES; attempt++) {
    try {
      const { insertedSession, violationResults } = await db.transaction(async (tx) => {
        // Set SERIALIZABLE isolation to prevent duplicate violations from concurrent polls
        // This ensures that if two transactions read the violations table simultaneously,
        // one will be forced to retry after the other commits
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);

        // P2-8: Set transaction timeout to prevent long-running transactions
        // Note: SET LOCAL doesn't support parameterized queries, must use raw value
        await tx.execute(
          sql`SET LOCAL statement_timeout = ${sql.raw(String(TRANSACTION_TIMEOUT_MS))}`
        );

        const insertedRows = await tx
          .insert(sessions)
          .values({
            serverId: server.id,
            serverUserId: serverUser.id,
            sessionKey: processed.sessionKey,
            plexSessionId: processed.plexSessionId || null,
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
            lastSeenAt: new Date(),
            totalDurationMs: processed.totalDurationMs || null,
            progressMs: processed.progressMs || null,
            lastPausedAt:
              processed.lastPausedDate ?? (processed.state === 'paused' ? new Date() : null),
            pausedDurationMs: 0,
            referenceId,
            watched: false,
            ipAddress: processed.ipAddress,
            geoCity: geo.city,
            geoRegion: geo.region,
            geoCountry: geo.countryCode ?? geo.country,
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
            // Stream details (source media, stream output, transcode/subtitle info)
            ...pickStreamDetailFields(processed),
            // Live TV specific fields
            channelTitle: processed.channelTitle,
            channelIdentifier: processed.channelIdentifier,
            channelThumb: processed.channelThumb,
            // Music track metadata
            artistName: processed.artistName,
            albumName: processed.albumName,
            trackNumber: processed.trackNumber,
            discNumber: processed.discNumber,
          })
          .returning();

        const inserted = insertedRows[0];
        if (!inserted) {
          throw new Error('Failed to insert session');
        }

        // Build session object for rule evaluation
        const session = {
          id: inserted.id,
          serverId: server.id,
          serverUserId: serverUser.id,
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
          geoCountry: geo.countryCode ?? geo.country,
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
          // Stream details (source media, stream output, transcode/subtitle info)
          ...pickStreamDetailFields(processed),
          // Live TV specific fields
          channelTitle: processed.channelTitle,
          channelIdentifier: processed.channelIdentifier,
          channelThumb: processed.channelThumb,
          // Music track metadata
          artistName: processed.artistName,
          albumName: processed.albumName,
          trackNumber: processed.trackNumber,
          discNumber: processed.discNumber,
        };

        // Evaluate rules
        const ruleResults = await ruleEngine.evaluateSession(session, activeRules, recentSessions);

        // Create violations within same transaction using transaction-aware dedup
        const createdViolations: ViolationInsertResult[] = [];
        for (const result of ruleResults) {
          // Issue #67: Use result.rule directly instead of .find() to get correct rule attribution
          if (result.violated && result.rule) {
            const matchingRule = result.rule;
            const relatedSessionIds = (result.data?.relatedSessionIds as string[]) || [];

            // Use transaction-aware duplicate check (reads within SERIALIZABLE isolation)
            const isDuplicate = await isDuplicateViolationInTransaction(
              tx,
              serverUser.id,
              matchingRule.type,
              inserted.id,
              relatedSessionIds
            );

            if (isDuplicate) {
              continue;
            }

            const violationResult = await createViolationInTransaction(
              tx,
              matchingRule.id,
              serverUser.id,
              inserted.id,
              result,
              matchingRule
            );
            // Only add if insert succeeded (not blocked by DB constraint)
            if (violationResult) {
              createdViolations.push(violationResult);
            }
          }
        }

        return { insertedSession: inserted, violationResults: createdViolations };
      });

      // Transaction succeeded, return result
      return {
        insertedSession,
        violationResults,
        qualityChange,
        referenceId,
      };
    } catch (error) {
      lastError = error;

      // Check if this is a serialization error that we can retry
      if (isSerializationError(error) && attempt < MAX_SERIALIZATION_RETRIES) {
        // Exponential backoff: 10ms, 20ms, 40ms
        const delayMs = SERIALIZATION_RETRY_BASE_MS * Math.pow(2, attempt - 1);
        console.log(
          `[SessionLifecycle] Serialization conflict on attempt ${attempt}/${MAX_SERIALIZATION_RETRIES}, retrying in ${delayMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      // Not a serialization error or max retries exceeded - rethrow
      throw error;
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError;
}

// ============================================================================
// Session Stop
// ============================================================================

/**
 * Stop a session atomically. Returns wasUpdated=false if already stopped.
 */
export async function stopSessionAtomic(input: SessionStopInput): Promise<SessionStopResult> {
  const { session, stoppedAt, forceStopped = false, preserveWatched = false } = input;

  const { durationMs, finalPausedDurationMs } = calculateStopDuration(
    {
      startedAt: session.startedAt,
      lastPausedAt: session.lastPausedAt,
      pausedDurationMs: session.pausedDurationMs ?? 0,
      progressMs: session.progressMs,
    },
    stoppedAt
  );

  // For quality changes (preserveWatched=true), keep the existing watched status
  // since playback is continuing in a new session
  const watched = preserveWatched
    ? session.watched
    : session.watched || checkWatchCompletion(session.progressMs, session.totalDurationMs);

  const shortSession = !shouldRecordSession(durationMs);

  // Use conditional update for idempotency - only stop if not already stopped
  // This prevents race conditions when multiple stop events arrive concurrently
  const result = await db
    .update(sessions)
    .set({
      state: 'stopped',
      stoppedAt,
      durationMs,
      pausedDurationMs: finalPausedDurationMs,
      lastPausedAt: null,
      watched,
      shortSession,
      ...(forceStopped && { forceStopped: true }),
    })
    .where(and(eq(sessions.id, session.id), isNull(sessions.stoppedAt)))
    .returning({ id: sessions.id });

  // Return whether the update was applied (for caller to skip cache/broadcast if already stopped)
  const wasUpdated = result.length > 0;

  return { durationMs, watched, shortSession, wasUpdated };
}

// ============================================================================
// Media Change Handling
// ============================================================================

/**
 * Handle media change scenario: stop old session, create new session.
 *
 * Used when sessionKey is reused but content changes (e.g., Emby "Play Next Episode").
 * This is the inverse of quality change:
 * - Quality change: Same ratingKey, different sessionKey
 * - Media change: Same sessionKey, different ratingKey
 *
 * @param input - Media change input with existing session and new media data
 * @returns Result with stopped session and newly created session, or null if stop failed
 */
export async function handleMediaChangeAtomic(
  input: MediaChangeInput
): Promise<MediaChangeResult | null> {
  const { existingSession, processed, server, serverUser, geo, activeRules, recentSessions } =
    input;

  console.log(
    `[SessionLifecycle] Media change detected: ${existingSession.ratingKey} -> ${processed.ratingKey}`
  );

  // STEP 1: Stop the old session atomically
  const now = new Date();
  const { wasUpdated } = await stopSessionAtomic({
    session: existingSession,
    stoppedAt: now,
  });

  if (!wasUpdated) {
    console.log(
      `[SessionLifecycle] Media change detected but session ${existingSession.id} was already stopped by another process.`
    );
    return null;
  }

  // STEP 2: Create new session for the new media
  const { insertedSession, violationResults } = await createSessionWithRulesAtomic({
    processed,
    server,
    serverUser,
    geo,
    activeRules,
    recentSessions,
  });

  return {
    stoppedSession: {
      id: existingSession.id,
      serverUserId: existingSession.serverUserId,
      sessionKey: existingSession.sessionKey,
    },
    insertedSession,
    violationResults,
  };
}

// ============================================================================
// Poll Result Processing
// ============================================================================

/**
 * Notification types used during poll processing
 */
type PollNotification =
  | { type: 'session_started'; payload: ActiveSession }
  | { type: 'session_stopped'; payload: ActiveSession };

/**
 * Input for processing poll results
 */
export interface PollResultsInput {
  /** Newly created sessions */
  newSessions: ActiveSession[];
  /** Keys of stopped sessions in format "serverId:sessionKey" */
  stoppedKeys: string[];
  /** Sessions that were updated */
  updatedSessions: ActiveSession[];
  /** Cached sessions for looking up stopped session details */
  cachedSessions: ActiveSession[];
  /** Cache service for persistence */
  cacheService: {
    incrementalSyncActiveSessions: (
      newSessions: ActiveSession[],
      stoppedIds: string[],
      updatedSessions: ActiveSession[]
    ) => Promise<void>;
    addUserSession: (userId: string, sessionId: string) => Promise<void>;
    removeUserSession: (userId: string, sessionId: string) => Promise<void>;
  } | null;
  /** PubSub service for broadcasting */
  pubSubService: {
    publish: (event: string, data: unknown) => Promise<void>;
  } | null;
  /** Notification enqueue function */
  enqueueNotification: (notification: PollNotification) => Promise<unknown>;
}

/**
 * Find a stopped session from cached sessions by serverId:sessionKey format
 */
function findStoppedSession(
  key: string,
  cachedSessions: ActiveSession[]
): ActiveSession | undefined {
  const parts = key.split(':');
  if (parts.length < 2) return undefined;
  const serverId = parts[0];
  const sessionKey = parts.slice(1).join(':');
  return cachedSessions.find((s) => s.serverId === serverId && s.sessionKey === sessionKey);
}

/**
 * Process poll results: sync cache and broadcast events.
 */
export async function processPollResults(input: PollResultsInput): Promise<void> {
  const {
    newSessions,
    stoppedKeys,
    updatedSessions,
    cachedSessions,
    cacheService,
    pubSubService,
    enqueueNotification,
  } = input;

  // Extract stopped session IDs from the key format "serverId:sessionKey"
  const stoppedSessionIds: string[] = [];
  for (const key of stoppedKeys) {
    const stoppedSession = findStoppedSession(key, cachedSessions);
    if (stoppedSession) {
      stoppedSessionIds.push(stoppedSession.id);
    }
  }

  // Update cache incrementally
  if (cacheService) {
    // Incremental sync: adds new, removes stopped, updates existing
    await cacheService.incrementalSyncActiveSessions(
      newSessions,
      stoppedSessionIds,
      updatedSessions
    );

    // Update user session sets for new sessions
    for (const session of newSessions) {
      await cacheService.addUserSession(session.serverUserId, session.id);
    }

    // Remove stopped sessions from user session sets
    for (const key of stoppedKeys) {
      const stoppedSession = findStoppedSession(key, cachedSessions);
      if (stoppedSession) {
        await cacheService.removeUserSession(stoppedSession.serverUserId, stoppedSession.id);
      }
    }
  }

  // Publish events via pub/sub
  if (pubSubService) {
    for (const session of newSessions) {
      await pubSubService.publish('session:started', session);
      await enqueueNotification({ type: 'session_started', payload: session });
    }

    for (const session of updatedSessions) {
      await pubSubService.publish('session:updated', session);
    }

    for (const key of stoppedKeys) {
      const stoppedSession = findStoppedSession(key, cachedSessions);
      if (stoppedSession) {
        await pubSubService.publish('session:stopped', stoppedSession.id);
        await enqueueNotification({ type: 'session_stopped', payload: stoppedSession });
      }
    }
  }
}
