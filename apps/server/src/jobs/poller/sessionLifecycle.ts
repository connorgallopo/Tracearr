/**
 * Session Lifecycle Operations
 *
 * Shared atomic operations for session creation and termination.
 * Used by both the Poller and SSE processor to ensure consistent handling.
 */

import {
  isPlacedLocal,
  LOCAL_NETWORK_COUNTRY,
  SESSION_WRITE_RETRY,
  TIME_MS,
  type ActiveSession,
  type EngineAutomation,
  type Session,
  type StreamDetailFields,
} from '@tracearr/shared';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { automationRuns, serverUsers, sessions, users } from '../../db/schema.js';
import { ACTIVE_SESSION_CHUNK_BOUND_MS, sessionRowById } from '../../db/sessionRow.js';
import { toRuleSession } from '../../services/automations/events/contextAssembly.js';
import { dispatch } from '../../services/automations/events/dispatcher.js';
import { matchesTrigger } from '../../services/automations/events/evaluate.js';
import {
  dispatchNewDevice,
  dispatchSessionStopped,
} from '../../services/automations/events/producers.js';
import type { ActionResult } from '../../services/automations/executors/index.js';
import { getWatchedThreshold } from '../../services/settings.js';
import {
  resolveSessionGeo,
  type SessionGeo,
  withLocalFlag,
} from '../../services/serverLocations.js';
import { isLocalSession } from '../../utils/localSession.js';
import { clearDbWriteTracking } from './dbWriteThrottle.js';
import { pickStreamDetailFields } from './sessionMapper.js';
import {
  calculateStopDuration,
  checkWatchCompletion,
  shouldRecordSession,
} from './stateTracker.js';
import type { DbTx } from '../../services/automations/events/types.js';
import type { SessionIdentity as MediaItemIdentity } from './database.js';
import type {
  CompositeSessionIdentity,
  MediaChangeInput,
  MediaChangeResult,
  PendingSessionData,
  QualityChangeResult,
  SessionCreationInput,
  SessionCreationResult,
  SessionIdentity,
  SessionStopInput,
  SessionStopResult,
} from './types.js';

// ============================================================================
// Serialization Retry Logic
// ============================================================================

// Constants for serializable transaction retry logic
const MAX_SERIALIZATION_RETRIES = 3;
const SERIALIZATION_RETRY_BASE_MS = 50; // P2-7: Increased from 10ms for better backoff
const TRANSACTION_TIMEOUT_MS = 10000; // P2-8: 10 second timeout for transactions

// Bound for the STEP 2 resume-detection query below. A resumable session's
// startedAt can precede the 24h stoppedAt resume window by up to its own
// wall-clock duration (e.g. a live TV session kept alive for days by polling),
// so the bound has to cover the resume window plus the max in-scope duration.
const RESUME_CHUNK_BOUND_MS = ACTIVE_SESSION_CHUNK_BOUND_MS + TIME_MS.DAY;

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
    /** Plex Session.id - required for termination (some clients like Plexamp may not have this) */
    plexSessionId?: string;
    state: 'playing' | 'paused';
    buffering?: boolean;
    mediaType: 'movie' | 'episode' | 'track' | 'live' | 'photo' | 'unknown';
    mediaTitle: string;
    grandparentTitle: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    year: number;
    thumbPath: string;
    ratingKey: string;
    totalDurationMs: number;
    progressMs: number;
    serverVersionKey?: string | null;
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
    /** Canonical media identity resolved from library_items, stamped at session insert. */
    identity?: MediaItemIdentity | null;
  };

  /** Server user info */
  user: {
    id: string;
    username: string;
    thumbUrl: string | null;
    identityName: string | null;
  };

  /** GeoIP location data */
  geo: SessionGeo;

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
    buffering: processed.buffering,

    // Media metadata
    mediaType: processed.mediaType,
    mediaTitle: processed.mediaTitle,
    grandparentTitle: processed.grandparentTitle || null,
    seasonNumber: processed.mediaType === 'episode' ? processed.seasonNumber : null,
    episodeNumber: processed.mediaType === 'episode' ? processed.episodeNumber : null,
    year: processed.year || null,
    thumbPath: processed.thumbPath || null,
    ratingKey: processed.ratingKey || null,
    serverVersionKey: processed.serverVersionKey ?? null,
    parentRatingKey: processed.identity?.parentRatingKey ?? null,
    grandparentRatingKey: processed.identity?.grandparentRatingKey ?? null,
    mediaId: processed.identity?.mediaId ?? null,
    showMediaId: processed.identity?.showMediaId ?? null,
    imdbId: processed.identity?.imdbId ?? null,
    tmdbId: processed.identity?.tmdbId ?? null,
    tvdbId: processed.identity?.tvdbId ?? null,

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
    geoContinent: geo.continent,
    geoPostal: geo.postal,
    geoLat: geo.lat,
    geoLon: geo.lon,
    geoAsnNumber: geo.asnNumber,
    geoAsnOrganization: geo.asnOrganization,
    isLocal: geo.isLocal,
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

    // Termination capability - Plex requires Session.id, some clients (like Plexamp) don't provide it
    canTerminate: server.type !== 'plex' || !!processed.plexSessionId,
  };
}

/**
 * Build an ActiveSession from PendingSessionData for display in Now Playing.
 *
 * Pending sessions are displayed immediately while awaiting confirmation threshold.
 * The session ID is pre-generated when the pending session is created, ensuring
 * the same UUID is used throughout the session lifecycle (pending → confirmed).
 * This eliminates UI flicker and session detail page breaks during transition.
 */
export function buildPendingActiveSession(pendingData: PendingSessionData): ActiveSession {
  const { processed, serverUser, geo, server } = pendingData;

  return {
    // Core identifiers - use pre-generated UUID (stable from creation to DB persistence)
    id: pendingData.id,
    serverId: server.id,
    serverUserId: serverUser.id,
    sessionKey: processed.sessionKey,

    // State
    state: pendingData.currentState,
    buffering: processed.buffering,

    // Media metadata
    mediaType: processed.mediaType,
    mediaTitle: processed.mediaTitle,
    grandparentTitle: processed.grandparentTitle || null,
    seasonNumber: processed.mediaType === 'episode' ? processed.seasonNumber : null,
    episodeNumber: processed.mediaType === 'episode' ? processed.episodeNumber : null,
    year: processed.year || null,
    thumbPath: processed.thumbPath || null,
    ratingKey: processed.ratingKey || null,
    serverVersionKey: processed.serverVersionKey ?? null,
    parentRatingKey: processed.identity?.parentRatingKey ?? null,
    grandparentRatingKey: processed.identity?.grandparentRatingKey ?? null,
    mediaId: processed.identity?.mediaId ?? null,
    showMediaId: processed.identity?.showMediaId ?? null,
    imdbId: processed.identity?.imdbId ?? null,
    tmdbId: processed.identity?.tmdbId ?? null,
    tvdbId: processed.identity?.tvdbId ?? null,

    // External session ID (for Plex API calls)
    externalSessionId: processed.plexSessionId ?? null,

    // Timing - use pending data timestamps
    startedAt: new Date(pendingData.startedAt),
    stoppedAt: null,
    durationMs: null,

    // Progress
    totalDurationMs: processed.totalDurationMs || null,
    progressMs: processed.progressMs || null,

    // Pause tracking
    lastPausedAt: pendingData.lastPausedAt ? new Date(pendingData.lastPausedAt) : null,
    pausedDurationMs: pendingData.pausedDurationMs,

    // Resume tracking - pending sessions don't have reference ID yet
    referenceId: null,

    // Watch status - not yet determined
    watched: false,

    // Network/device info
    ipAddress: processed.ipAddress,
    geoCity: geo.city,
    geoRegion: geo.region,
    geoCountry: geo.countryCode ?? geo.country,
    geoContinent: geo.continent,
    geoPostal: geo.postal,
    geoLat: geo.lat,
    geoLon: geo.lon,
    geoAsnNumber: geo.asnNumber,
    geoAsnOrganization: geo.asnOrganization,
    isLocal: withLocalFlag(geo, processed.ipAddress).isLocal,
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

    // Stream details
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
    user: {
      id: serverUser.id,
      username: serverUser.username,
      thumbUrl: serverUser.thumbUrl,
      identityName: serverUser.identityName,
    },
    server: { id: server.id, name: server.name, type: server.type },

    // Termination capability
    canTerminate: server.type !== 'plex' || !!processed.plexSessionId,

    // Unconfirmed; excludeUncountableSessions drops this from rule evaluation
    pending: true,
  };
}

// ============================================================================
// Session Query Helpers
// ============================================================================

/**
 * Find an active (not stopped) session by SessionIdentity.
 * When ratingKey is provided and non-null, validates the session has matching ratingKey.
 */
export async function findActiveSession(
  identity: SessionIdentity
): Promise<typeof sessions.$inferSelect | null> {
  const { serverId, sessionKey, ratingKey, serverUserId } = identity;
  // Time bound reduces TimescaleDB chunk scanning (only recent chunks can have active sessions)
  const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);

  // Build conditions array
  const conditions = [
    eq(sessions.serverId, serverId),
    eq(sessions.sessionKey, sessionKey),
    isNull(sessions.stoppedAt),
    gte(sessions.startedAt, chunkBound),
  ];

  // Add ratingKey validation if provided and non-null
  if (ratingKey != null) {
    conditions.push(eq(sessions.ratingKey, ratingKey));
  }

  if (serverUserId != null) {
    conditions.push(eq(sessions.serverUserId, serverUserId));
  }

  // Newest first: after a PMS restart a stale open row can share this
  // sessionKey with a fresh one, and an unordered limit(1) could latch the
  // stale row forever
  const rows = await db
    .select()
    .from(sessions)
    .where(and(...conditions))
    .orderBy(desc(sessions.startedAt))
    .limit(1);

  return rows[0] || null;
}

/** Find an active session by composite identity (JF/Emby). */
export async function findActiveSessionByComposite(
  identity: CompositeSessionIdentity
): Promise<typeof sessions.$inferSelect | null> {
  const { serverId, serverUserId, deviceId, ratingKey } = identity;
  const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);

  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, serverId),
        eq(sessions.serverUserId, serverUserId),
        deviceId ? eq(sessions.deviceId, deviceId) : isNull(sessions.deviceId),
        eq(sessions.ratingKey, ratingKey),
        isNull(sessions.stoppedAt),
        gte(sessions.startedAt, chunkBound)
      )
    )
    .limit(1);

  return rows[0] || null;
}

/**
 * Find all active (not stopped) sessions matching SessionIdentity.
 * When ratingKey is provided and non-null, validates sessions have matching ratingKey.
 * Use when handling potential duplicates.
 */
export async function findActiveSessionsAll(
  identity: SessionIdentity
): Promise<(typeof sessions.$inferSelect)[]> {
  const { serverId, sessionKey, ratingKey } = identity;
  // Time bound reduces TimescaleDB chunk scanning (only recent chunks can have active sessions)
  const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);

  // Build conditions array
  const conditions = [
    eq(sessions.serverId, serverId),
    eq(sessions.sessionKey, sessionKey),
    isNull(sessions.stoppedAt),
    gte(sessions.startedAt, chunkBound),
  ];

  // Add ratingKey validation if provided and non-null
  if (ratingKey != null) {
    conditions.push(eq(sessions.ratingKey, ratingKey));
  }

  return db
    .select()
    .from(sessions)
    .where(and(...conditions));
}

function groupActiveSessionRow(
  map: Map<string, (typeof sessions.$inferSelect)[]>,
  key: string,
  row: typeof sessions.$inferSelect
): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(row);
  else map.set(key, [row]);
}

/** Batch equivalent of findActiveSession for a whole poll tick, grouped by sessionKey. */
export async function batchFindActiveSessionsByKey(
  serverId: string,
  sessionKeys: string[]
): Promise<Map<string, (typeof sessions.$inferSelect)[]>> {
  const result = new Map<string, (typeof sessions.$inferSelect)[]>();
  if (sessionKeys.length === 0) return result;

  const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, serverId),
        inArray(sessions.sessionKey, [...new Set(sessionKeys)]),
        isNull(sessions.stoppedAt),
        gte(sessions.startedAt, chunkBound)
      )
    )
    .orderBy(desc(sessions.startedAt));

  for (const row of rows) groupActiveSessionRow(result, row.sessionKey, row);
  return result;
}

/** Batch equivalent of findActiveSessionByComposite, grouped by serverUserId+ratingKey. */
export async function batchFindActiveSessionsByComposite(
  serverId: string,
  identities: { serverUserId: string; ratingKey: string }[]
): Promise<Map<string, (typeof sessions.$inferSelect)[]>> {
  const result = new Map<string, (typeof sessions.$inferSelect)[]>();
  if (identities.length === 0) return result;

  const serverUserIds = [...new Set(identities.map((i) => i.serverUserId))];
  const ratingKeys = [...new Set(identities.map((i) => i.ratingKey))];
  const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, serverId),
        inArray(sessions.serverUserId, serverUserIds),
        inArray(sessions.ratingKey, ratingKeys),
        isNull(sessions.stoppedAt),
        gte(sessions.startedAt, chunkBound)
      )
    )
    .orderBy(desc(sessions.startedAt));

  for (const row of rows) {
    groupActiveSessionRow(result, `${row.serverUserId}::${row.ratingKey}`, row);
  }
  return result;
}

// ============================================================================
// Session Creation
// ============================================================================

/**
 * What a device is known by. An empty deviceId falls through to the player name rather than
 * probing for '', which the insert could never have written: it stores `deviceId || null`.
 */
export function deviceKeyOf(session: {
  deviceId?: string | null;
  playerName?: string | null;
}): { column: 'deviceId' | 'playerName'; value: string } | null {
  if (session.deviceId) return { column: 'deviceId', value: session.deviceId };
  if (session.playerName) return { column: 'playerName', value: session.playerName };
  return null;
}

/** City and region as a message names them, or null when the session carries no geo columns. */
export function sessionLocation(session: {
  geoCity: string | null;
  geoRegion: string | null;
  geoCountry: string | null;
  geoLat: number | null;
  isLocal?: boolean | null;
}): string | null {
  const parts = [session.geoCity, session.geoRegion ?? session.geoCountry].filter(
    (part): part is string => part !== null && part !== ''
  );
  if (parts.length === 0) return null;
  const place = parts.join(', ');
  return isPlacedLocal({ isLocal: isLocalSession(session), country: session.geoCountry })
    ? `${place} (${LOCAL_NETWORK_COUNTRY})`
    : place;
}

/**
 * Whether this account has ever streamed from the device. Ordered append visits the newest
 * chunk first and stops at the first row, so a device already on file never fans out.
 */
async function accountHasSeenDevice(
  tx: DbTx,
  serverUserId: string,
  key: { column: 'deviceId' | 'playerName'; value: string }
): Promise<boolean> {
  const seen = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.serverUserId, serverUserId),
        key.column === 'deviceId'
          ? eq(sessions.deviceId, key.value)
          : and(isNull(sessions.deviceId), eq(sessions.playerName, key.value))
      )
    )
    .orderBy(desc(sessions.startedAt))
    .limit(1);
  return seen.length > 0;
}

/**
 * Whether the triggering session had a kill job enqueued for it.
 *
 * Reflects enqueue, not execution: reverify can still abort the kill later
 * (session already stopped, rule gone, condition cleared), so this is only
 * ever a prediction that the session may die shortly, not a guarantee.
 */
export function wasTriggeringSessionTargetedForKill(
  actionResults: ActionResult[],
  triggeringSessionId: string
): boolean {
  return actionResults.some(
    (result) =>
      result.action.type === 'kill_stream' &&
      result.enqueuedSessionIds?.includes(triggeringSessionId)
  );
}

/**
 * Clean up the twin stopped by createSessionWithRulesAtomic's quality-change
 * detection (STEP 1): clear its DB-write throttle tracking, remove it from
 * the active-session cache, and publish its stop. Every caller of
 * createSessionWithRulesAtomic/confirmAndPersistSession that can receive a
 * non-null `qualityChange` must run this, or the twin lingers in the cache
 * until TTL with a stale throttle entry and no stop broadcast.
 */
export async function handleQualityChangeFallout(
  qualityChange: QualityChangeResult,
  cacheService: { removeActiveSession: (sessionId: string) => Promise<void> } | null,
  pubSubService: { publish: (event: string, data: unknown) => Promise<void> } | null
): Promise<void> {
  const { stoppedSession } = qualityChange;
  clearDbWriteTracking(stoppedSession.id);
  if (cacheService) {
    await cacheService.removeActiveSession(stoppedSession.id);
  }
  if (pubSubService) {
    await pubSubService.publish('session:stopped', stoppedSession.id);
  }
}

/**
 * Create a session with atomic rule evaluation and violation creation.
 * Handles quality change detection, resume tracking, and rule violations.
 */
export async function createSessionWithRulesAtomic(
  input: SessionCreationInput
): Promise<SessionCreationResult> {
  const {
    processed,
    server,
    serverUser,
    geo,
    activeAutomations,
    activeSessions,
    recentSessions,
    preGeneratedId,
  } = input;

  let referenceId: string | null = null;
  let qualityChange: QualityChangeResult | null = null;

  // STEP 1: Check for quality change (active session with same user+device+ratingKey)
  if (processed.ratingKey) {
    // Time bound reduces TimescaleDB chunk scanning (only recent chunks can have active sessions)
    const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);

    const deviceCondition = processed.deviceId
      ? eq(sessions.deviceId, processed.deviceId)
      : isNull(sessions.deviceId);

    const activeSameContent = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.serverUserId, serverUser.id),
          eq(sessions.ratingKey, processed.ratingKey),
          deviceCondition,
          isNull(sessions.stoppedAt),
          gte(sessions.startedAt, chunkBound)
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
        reason: 'quality_change',
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
            deviceId: existingActiveSession.deviceId,
            ratingKey: existingActiveSession.ratingKey,
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
    // Time bound reduces TimescaleDB chunk scanning (mirrors STEP 1 above).
    // Uses RESUME_CHUNK_BOUND_MS, not ACTIVE_SESSION_CHUNK_BOUND_MS: covers any
    // resumable session whose wall-clock duration is at most
    // ACTIVE_SESSION_CHUNK_BOUND_MS. Only live TV channels and stuck sessions
    // kept alive by polling can run longer than that; those rows lose resume
    // chaining here, an accepted tradeoff.
    const chunkBound = new Date(Date.now() - RESUME_CHUNK_BOUND_MS);
    const recentSameContent = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.serverUserId, serverUser.id),
          eq(sessions.ratingKey, processed.ratingKey),
          gte(sessions.stoppedAt, oneDayAgo),
          gte(sessions.startedAt, chunkBound),
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
      const { insertedSession, violationResults, deferredActions, newDevice } =
        await db.transaction(async (tx) => {
          // Set SERIALIZABLE isolation to prevent duplicate violations from concurrent polls
          // This ensures that if two transactions read the violations table simultaneously,
          // one will be forced to retry after the other commits
          await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);

          // P2-8: Set transaction timeout to prevent long-running transactions
          // Note: SET LOCAL doesn't support parameterized queries, must use raw value
          await tx.execute(
            sql`SET LOCAL statement_timeout = ${sql.raw(String(TRANSACTION_TIMEOUT_MS))}`
          );

          // Before the insert: after it the new row would match itself. The rules are in
          // hand, so an install with no such automation never issues the query.
          const deviceKey = activeAutomations.some((candidate) =>
            matchesTrigger(candidate, 'account.new_device')
          )
            ? deviceKeyOf(processed)
            : null;
          const isNewDevice = deviceKey
            ? !(await accountHasSeenDevice(tx, serverUser.id, deviceKey))
            : false;

          const insertedRows = await tx
            .insert(sessions)
            .values({
              // Use pre-generated ID if provided (pending sessions), otherwise let DB generate
              ...(preGeneratedId ? { id: preGeneratedId } : {}),
              serverId: server.id,
              serverUserId: serverUser.id,
              sessionKey: processed.sessionKey,
              plexSessionId: processed.plexSessionId || null,
              // Store '' rather than null for an absent media id. Every composite
              // lookup (batchFindActiveSessionsByComposite, findActiveSessionByComposite)
              // and buildCompositeKey coerce a missing ratingKey to '', so storing
              // null here would make each tick's dedup miss the row it wrote last
              // tick and insert a duplicate until the stale sweep.
              ratingKey: processed.ratingKey ?? '',
              serverVersionKey: processed.serverVersionKey ?? null,
              parentRatingKey: processed.identity?.parentRatingKey ?? null,
              grandparentRatingKey: processed.identity?.grandparentRatingKey ?? null,
              mediaId: processed.identity?.mediaId ?? null,
              showMediaId: processed.identity?.showMediaId ?? null,
              imdbId: processed.identity?.imdbId ?? null,
              tmdbId: processed.identity?.tmdbId ?? null,
              tvdbId: processed.identity?.tvdbId ?? null,
              state: processed.state,
              mediaType: processed.mediaType,
              mediaTitle: processed.mediaTitle,
              grandparentTitle: processed.grandparentTitle || null,
              seasonNumber: processed.mediaType === 'episode' ? processed.seasonNumber : null,
              episodeNumber: processed.mediaType === 'episode' ? processed.episodeNumber : null,
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
              geoContinent: geo.continent,
              geoPostal: geo.postal,
              geoLat: geo.lat,
              geoLon: geo.lon,
              geoAsnNumber: geo.asnNumber,
              geoAsnOrganization: geo.asnOrganization,
              isLocal: geo.isLocal,
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

          await tx
            .update(serverUsers)
            .set({
              lastActivityAt: sql`GREATEST(COALESCE(${serverUsers.lastActivityAt}, ${inserted.startedAt}), ${inserted.startedAt})`,
            })
            .where(eq(serverUsers.id, serverUser.id));

          // Mirror of the account bump above, not recomputeIdentityAggregates:
          // this is the poller hot path and the rollup only ever moves forward.
          await tx
            .update(users)
            .set({
              lastActivityAt: sql`GREATEST(COALESCE(${users.lastActivityAt}, ${inserted.startedAt}), ${inserted.startedAt})`,
            })
            .where(eq(users.id, serverUser.userId));

          const session = toRuleSession(inserted);
          const ruleServer = { id: server.id, name: server.name, type: server.type };
          const inputs = {
            activeAutomations,
            // The quality-change twin was stopped in STEP 1 but still sits in the caller's snapshot.
            activeSessions: qualityChange
              ? activeSessions.filter((s) => s.id !== qualityChange.stoppedSession.id)
              : activeSessions,
            recentSessions,
            identityServerUserIds: serverUser.identityServerUserIds,
          };
          const { violations: violationResults, deferredActions } = await dispatch(
            {
              type: 'session.started',
              at: inserted.startedAt,
              server: ruleServer,
              serverUser,
              session,
            },
            inputs,
            { tx, deferActions: true }
          );

          const newDevice = isNewDevice
            ? {
                event: {
                  at: inserted.startedAt,
                  server: ruleServer,
                  serverUser,
                  session,
                  device: {
                    name: inserted.playerName ?? inserted.device ?? inserted.product ?? '',
                    platform: inserted.platform,
                    product: inserted.product,
                    location: sessionLocation(inserted),
                  },
                },
                inputs,
              }
            : null;

          return { insertedSession: inserted, violationResults, deferredActions, newDevice };
        });

      const actionResults = deferredActions ? await deferredActions() : [];
      if (newDevice) await dispatchNewDevice(newDevice.event, newDevice.inputs);
      const wasTerminatedByRule = wasTriggeringSessionTargetedForKill(
        actionResults,
        insertedSession.id
      );

      console.log(
        `[SessionLifecycle] Session started: ${processed.mediaType} "${processed.grandparentTitle ? `${processed.grandparentTitle} - ` : ''}${processed.mediaTitle}" by ${serverUser.username} on ${server.name} (${processed.playerName ?? 'unknown player'}, key ${processed.sessionKey})`
      );

      // Transaction succeeded, return result
      return {
        insertedSession,
        violationResults,
        qualityChange,
        referenceId,
        wasTerminatedByRule,
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
// Pending Session Confirmation
// ============================================================================

/**
 * Input for confirming a pending session (persisting from Redis to DB).
 */
export interface ConfirmPendingSessionInput {
  /** Pending session data from Redis */
  pendingData: PendingSessionData;
  /** Active V2 rules to evaluate */
  activeAutomations: EngineAutomation[];
  /** Active sessions for rule context */
  activeSessions: Session[];
  /** Recent sessions for rule evaluation */
  recentSessions: Session[];
}

/**
 * Confirm and persist a pending session to the database with rule evaluation.
 *
 * Called when a pending session meets the 30s confirmation threshold.
 * This function delegates to createSessionWithRulesAtomic but ensures
 * the startedAt reflects when the session actually started (not when confirmed).
 *
 * @param input - Pending session data and rule context
 * @returns Session creation result with any violations, and the geo the row was inserted with
 */
export async function confirmAndPersistSession(
  input: ConfirmPendingSessionInput
): Promise<SessionCreationResult & { geo: SessionGeo }> {
  const { pendingData, activeAutomations, activeSessions, recentSessions } = input;
  const { processed, server, serverUser } = pendingData;
  const actualStartedAt = new Date(pendingData.startedAt);
  const seenGeo = withLocalFlag(pendingData.geo, processed.ipAddress);
  // The pending entry holds the placement from first sight; a location saved while it waited
  // still applies, as of when the session started. Private IPs never reach Plex GeoIP.
  const geo = seenGeo.isLocal
    ? await resolveSessionGeo(processed.ipAddress, server.id, false, actualStartedAt)
    : seenGeo;

  // Delegate to createSessionWithRulesAtomic for atomic rule evaluation
  // The session will be created with current state from the pending data
  // Use the pre-generated UUID from pending data for stable ID throughout lifecycle
  const result = await createSessionWithRulesAtomic({
    processed: {
      ...processed,
      // Use the current state from pending data (may have changed from initial)
      state: pendingData.currentState as 'playing' | 'paused',
      // Pass lastPausedDate for initial pause state detection
      lastPausedDate: pendingData.lastPausedAt ? new Date(pendingData.lastPausedAt) : undefined,
    },
    server,
    serverUser,
    geo,
    activeAutomations,
    activeSessions,
    recentSessions,
    // Use the pre-generated UUID - ensures same ID from pending to confirmed state
    preGeneratedId: pendingData.id,
  });

  // Update the session with correct timing from pending data:
  // - startedAt: When the session actually started (not when confirmed)
  // - pausedDurationMs: Accumulated pause time while pending
  // This ensures accurate watch duration calculations
  const timeDriftMs = Date.now() - pendingData.startedAt;

  // Only update if there's meaningful drift (> 1 second)
  // This accounts for the time between session start and confirmation
  if (timeDriftMs > 1000) {
    // Use latest progress from confirmation state (may have advanced during pending phase)
    const latestProgressMs = pendingData.confirmation.maxViewOffset;

    await db
      .update(sessions)
      .set({
        startedAt: actualStartedAt,
        pausedDurationMs: pendingData.pausedDurationMs,
        lastPausedAt: pendingData.lastPausedAt ? new Date(pendingData.lastPausedAt) : null,
        ...(latestProgressMs > 0 && { progressMs: latestProgressMs }),
      })
      .where(sessionRowById(result.insertedSession));
    // The runs the start dispatch recorded keyed the session by its confirmation time
    await db
      .update(automationRuns)
      .set({ sessionStartedAt: actualStartedAt })
      .where(eq(automationRuns.sessionId, result.insertedSession.id));

    result.insertedSession.startedAt = actualStartedAt;
    result.insertedSession.pausedDurationMs = pendingData.pausedDurationMs;
    result.insertedSession.lastPausedAt = pendingData.lastPausedAt
      ? new Date(pendingData.lastPausedAt)
      : null;
    if (latestProgressMs > 0) {
      result.insertedSession.progressMs = latestProgressMs;
    }

    console.log(
      `[SessionLifecycle] Confirmed pending session ${result.insertedSession.id} ` +
        `(started ${Math.round(timeDriftMs / 1000)}s ago, paused ${Math.round(pendingData.pausedDurationMs / 1000)}s)`
    );
  }

  return { ...result, geo };
}

// ============================================================================
// Session Stop
// ============================================================================

/**
 * Stop a session atomically. Returns wasUpdated=false if already stopped.
 * Implements bounded retry logic for transient DB failures.
 */
export async function stopSessionAtomic(input: SessionStopInput): Promise<SessionStopResult> {
  const {
    session,
    stoppedAt,
    forceStopped = false,
    preserveWatched = false,
    reason = 'ended',
  } = input;

  const { durationMs, finalPausedDurationMs } = calculateStopDuration(
    {
      startedAt: session.startedAt,
      lastPausedAt: session.lastPausedAt,
      pausedDurationMs: session.pausedDurationMs ?? 0,
      progressMs: session.progressMs,
      totalDurationMs: session.totalDurationMs,
    },
    stoppedAt
  );

  // For quality changes (preserveWatched=true), keep the existing watched status
  // since playback is continuing in a new session
  const watched = preserveWatched
    ? session.watched
    : session.watched ||
      checkWatchCompletion(
        durationMs,
        session.progressMs,
        session.totalDurationMs,
        await getWatchedThreshold(session.mediaType)
      );

  const shortSession = !shouldRecordSession(durationMs);

  // Retry loop for transient DB failures (connection errors, timeouts, etc.)
  let lastError: unknown;
  // null until a write attempt lands; then whether this call is the one that stopped the row.
  let wasUpdated: boolean | null = null;
  for (let attempt = 1; attempt <= SESSION_WRITE_RETRY.IMMEDIATE_RETRIES; attempt++) {
    try {
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
        .where(and(sessionRowById(session), isNull(sessions.stoppedAt)))
        .returning({ id: sessions.id });

      wasUpdated = result.length > 0;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < SESSION_WRITE_RETRY.IMMEDIATE_RETRIES) {
        const delayMs = SESSION_WRITE_RETRY.IMMEDIATE_BACKOFF_MS * Math.pow(2, attempt - 1);
        console.log(
          `[SessionLifecycle] DB write failed on attempt ${attempt}/${SESSION_WRITE_RETRY.IMMEDIATE_RETRIES}, retrying in ${delayMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  if (wasUpdated === null) {
    // All retries failed - return needsRetry for caller to queue for later processing
    console.error(
      `[SessionLifecycle] All ${SESSION_WRITE_RETRY.IMMEDIATE_RETRIES} attempts failed for session ${session.id}:`,
      lastError
    );

    return {
      durationMs,
      watched,
      shortSession,
      wasUpdated: false,
      needsRetry: true,
      retryData: { stoppedAt: stoppedAt.getTime(), forceStopped },
    };
  }

  if (wasUpdated) {
    console.log(
      `[SessionLifecycle] Session stopped: "${session.mediaTitle}" after ${Math.round(durationMs / 1000)}s (watched=${watched}${forceStopped ? ', forced' : ''})`
    );
    // Outside the retry loop: the row is stopped, and a failed dispatch must not re-run the write.
    await dispatchSessionStopped(
      toRuleSession(session, {
        state: 'stopped',
        stoppedAt,
        durationMs,
        pausedDurationMs: finalPausedDurationMs,
        lastPausedAt: null,
        watched,
      }),
      durationMs,
      stoppedAt,
      reason
    );
  }

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
  const {
    existingSession,
    processed,
    server,
    serverUser,
    geo,
    activeAutomations,
    activeSessions,
    recentSessions,
  } = input;

  console.log(
    `[SessionLifecycle] Media change detected: ${existingSession.ratingKey} -> ${processed.ratingKey}`
  );

  // STEP 1: Stop the old session atomically
  const now = new Date();
  const { wasUpdated } = await stopSessionAtomic({
    session: existingSession,
    stoppedAt: now,
    reason: 'media_change',
  });

  if (!wasUpdated) {
    console.log(
      `[SessionLifecycle] Media change detected but session ${existingSession.id} was already stopped by another process.`
    );
    return null;
  }

  await dispatch({
    type: 'session.media_changed',
    at: now,
    sessionId: existingSession.id,
    serverId: existingSession.serverId,
  });

  // STEP 2: Create new session for the new media
  const { insertedSession, violationResults, wasTerminatedByRule, qualityChange } =
    await createSessionWithRulesAtomic({
      processed,
      server,
      serverUser,
      geo,
      activeAutomations,
      // The old-media session was stopped above; the caller's snapshot
      // predates that stop.
      activeSessions: activeSessions.filter((s) => s.id !== existingSession.id),
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
    wasTerminatedByRule,
    qualityChange,
  };
}

// ============================================================================
// Poll Result Processing
// ============================================================================

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
  /** Whether any session crossed the watched-completion threshold this tick */
  watchedTransitionOccurred: boolean;
  /** Cached sessions for looking up stopped session details */
  cachedSessions: ActiveSession[];
  /** Cache service for persistence */
  cacheService: {
    incrementalSyncActiveSessions: (
      newSessions: ActiveSession[],
      stoppedIds: string[],
      updatedSessions: ActiveSession[],
      watchedTransitionOccurred?: boolean
    ) => Promise<void>;
  } | null;
  /** PubSub service for broadcasting */
  pubSubService: {
    publish: (event: string, data: unknown) => Promise<void>;
  } | null;
  /**
   * IDs (subset of newSessions) confirmed from a pending entry rather than
   * created fresh. The pending create already published session:started, so
   * it is skipped here for these ids.
   */
  confirmedFromPendingIds?: Set<string>;
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
    watchedTransitionOccurred,
    cachedSessions,
    cacheService,
    pubSubService,
    confirmedFromPendingIds,
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
      updatedSessions,
      watchedTransitionOccurred
    );
  }

  // Publish events via pub/sub
  if (pubSubService) {
    for (const session of newSessions) {
      // A session confirmed from a pending entry was already published at pending
      // create; re-sending here would double the SSE event.
      if (confirmedFromPendingIds?.has(session.id)) continue;
      await pubSubService.publish('session:started', session);
    }

    // Relays read session:updated as a change signal, so one tick's updates collapse to a single
    // publish; sessions:progress below carries the rest.
    if (updatedSessions.length > 0) {
      await pubSubService.publish('session:updated', updatedSessions[0]);
      await pubSubService.publish('sessions:progress', {
        sessions: updatedSessions.map((s) => ({
          id: s.id,
          serverId: s.serverId,
          state: s.state,
          progressMs: s.progressMs ?? 0,
          bitrate: s.bitrate ?? null,
        })),
      });
    }

    for (const key of stoppedKeys) {
      const stoppedSession = findStoppedSession(key, cachedSessions);
      if (stoppedSession) await pubSubService.publish('session:stopped', stoppedSession.id);
    }
  }
}
