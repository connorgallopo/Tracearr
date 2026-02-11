/**
 * Session Lifecycle Operations
 *
 * Shared atomic operations for session creation and termination.
 * Used by both the Poller and SSE processor to ensure consistent handling.
 */

import { eq, and, desc, isNull, gte } from 'drizzle-orm';
import {
  TIME_MS,
  type ActiveSession,
  type StreamDetailFields,
  type RuleV2,
  type Session,
  type Server,
  type ServerUser,
} from '@tracearr/shared';
import { pickStreamDetailFields } from './sessionMapper.js';
import { db } from '../../db/client.js';
import { serverUsers, sessions, violations } from '../../db/schema.js';
import type { GeoLocation } from '../../services/geoip.js';
import { evaluateRulesAsync, hasTranscodeConditions } from '../../services/rules/engine.js';
import { executeActions, type ActionResult } from '../../services/rules/executors/index.js';
import { resolveTargetSessions } from '../../services/rules/executors/targeting.js';
import { storeActionResults } from '../../services/rules/v2Integration.js';
import type { EvaluationContext, EvaluationResult } from '../../services/rules/types.js';
import {
  calculateStopDuration,
  checkWatchCompletion,
  shouldRecordSession,
} from './stateTracker.js';
import { sql } from 'drizzle-orm';
import { getTrustScorePenalty, type ViolationInsertResult } from './violations.js';
import type {
  SessionCreationInput,
  SessionCreationResult,
  QualityChangeResult,
  SessionStopInput,
  SessionStopResult,
  MediaChangeInput,
  MediaChangeResult,
  TranscodeReEvalInput,
} from './types.js';

// ============================================================================
// Serialization Retry Logic
// ============================================================================

// Constants for serializable transaction retry logic
const MAX_SERIALIZATION_RETRIES = 3;
const SERIALIZATION_RETRY_BASE_MS = 50; // P2-7: Increased from 10ms for better backoff
const TRANSACTION_TIMEOUT_MS = 10000; // P2-8: 10 second timeout for transactions

// Time bound for active session queries to limit TimescaleDB chunk scanning.
// Active sessions should only exist in recent chunks - anything older would have
// been force-stopped by the stale session sweep. 7 days gives ample buffer.
const ACTIVE_SESSION_CHUNK_BOUND_MS = 7 * 24 * 60 * 60 * 1000;

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
    geoContinent: geo.continent,
    geoPostal: geo.postal,
    geoLat: geo.lat,
    geoLon: geo.lon,
    geoAsnNumber: geo.asnNumber,
    geoAsnOrganization: geo.asnOrganization,
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
  // Time bound reduces TimescaleDB chunk scanning (only recent chunks can have active sessions)
  const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);

  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, serverId),
        eq(sessions.sessionKey, sessionKey),
        isNull(sessions.stoppedAt),
        gte(sessions.startedAt, chunkBound)
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
  // Time bound reduces TimescaleDB chunk scanning (only recent chunks can have active sessions)
  const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);

  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, serverId),
        eq(sessions.sessionKey, sessionKey),
        isNull(sessions.stoppedAt),
        gte(sessions.startedAt, chunkBound)
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
  const { processed, server, serverUser, geo, activeRulesV2, activeSessions, recentSessions } =
    input;

  let referenceId: string | null = null;
  let qualityChange: QualityChangeResult | null = null;

  // STEP 1: Check for quality change (active session with same user+ratingKey)
  if (processed.ratingKey) {
    // Time bound reduces TimescaleDB chunk scanning (only recent chunks can have active sessions)
    const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);

    const activeSameContent = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.serverUserId, serverUser.id),
          eq(sessions.ratingKey, processed.ratingKey),
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
      const { insertedSession, violationResults, pendingSideEffects } = await db.transaction(
        async (tx) => {
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
              geoContinent: geo.continent,
              geoPostal: geo.postal,
              geoLat: geo.lat,
              geoLon: geo.lon,
              geoAsnNumber: geo.asnNumber,
              geoAsnOrganization: geo.asnOrganization,
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

          // Build session object for rule evaluation (matches Session type)
          const session: Session = {
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
            geoContinent: geo.continent,
            geoPostal: geo.postal,
            geoLat: geo.lat,
            geoLon: geo.lon,
            geoAsnNumber: geo.asnNumber,
            geoAsnOrganization: geo.asnOrganization,
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

          // Build V2 evaluation context
          const serverObj: Server = {
            id: server.id,
            name: server.name,
            type: server.type,
            url: '', // Not needed for rule evaluation
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          const serverUserObj: ServerUser = {
            id: serverUser.id,
            userId: '', // Not needed for rule evaluation
            serverId: server.id,
            externalId: '',
            username: serverUser.username,
            email: null,
            thumbUrl: serverUser.thumbUrl,
            isServerAdmin: false,
            trustScore: serverUser.trustScore,
            sessionCount: serverUser.sessionCount,
            joinedAt: null,
            lastActivityAt: serverUser.lastActivityAt,
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          const baseContext: Omit<EvaluationContext, 'rule'> = {
            session,
            serverUser: serverUserObj,
            server: serverObj,
            activeSessions,
            recentSessions,
          };

          // Evaluate V2 rules
          const ruleResults = await evaluateRulesAsync(baseContext, activeRulesV2);

          // Process matched rules - create violations within transaction, queue side effects
          const createdViolations: ViolationInsertResult[] = [];
          const pendingSideEffects: Array<{
            context: EvaluationContext;
            result: EvaluationResult;
            rule: RuleV2;
          }> = [];

          for (const result of ruleResults) {
            if (!result.matched) continue;

            // Find the rule that produced this result
            const rule = activeRulesV2.find((r) => r.id === result.ruleId);
            if (!rule) continue;

            // Check for create_violation action
            const violationAction = result.actions.find((a) => a.type === 'create_violation');

            if (violationAction?.type === 'create_violation') {
              // Create violation within transaction for atomicity
              const severity = violationAction.severity;
              const trustPenalty = getTrustScorePenalty(severity);

              // Insert violation
              const insertedViolations = await tx
                .insert(violations)
                .values({
                  ruleId: rule.id,
                  serverUserId: serverUser.id,
                  sessionId: inserted.id,
                  severity,
                  ruleType: null, // V2 rules don't have a type field
                  data: {
                    ruleName: rule.name,
                    matchedGroups: result.matchedGroups,
                    sessionKey: session.sessionKey,
                    mediaTitle: session.mediaTitle,
                    ipAddress: session.ipAddress,
                  },
                })
                .onConflictDoNothing()
                .returning();

              const violation = insertedViolations[0];

              if (violation) {
                // Decrease trust score
                await tx
                  .update(serverUsers)
                  .set({
                    trustScore: sql`GREATEST(0, ${serverUsers.trustScore} - ${trustPenalty})`,
                    updatedAt: new Date(),
                  })
                  .where(eq(serverUsers.id, serverUser.id));

                // Create rule info for ViolationInsertResult (V2 rules don't have type)
                const ruleInfo = {
                  id: rule.id,
                  name: rule.name,
                  type: null, // V2 rules don't have a type
                };

                createdViolations.push({
                  violation,
                  rule: ruleInfo,
                  trustPenalty,
                });
              }
            }

            // Queue non-violation actions for execution after transaction
            const sideEffectActions = result.actions.filter((a) => a.type !== 'create_violation');
            if (sideEffectActions.length > 0) {
              pendingSideEffects.push({
                context: { ...baseContext, rule },
                result: { ...result, actions: sideEffectActions },
                rule,
              });
            }
          }

          return {
            insertedSession: inserted,
            violationResults: createdViolations,
            pendingSideEffects,
          };
        }
      );

      // Execute side effect actions after transaction commits
      let wasTerminatedByRule = false;

      for (const { context, result, rule } of pendingSideEffects) {
        // Before executing, check if any kill_stream action will target the triggering session
        for (const action of result.actions) {
          if (action.type === 'kill_stream') {
            const sessionsToKill = resolveTargetSessions({
              target: action.target ?? 'triggering',
              triggeringSession: context.session,
              serverUserId: context.serverUser.id,
              activeSessions: context.activeSessions.some((s) => s.id === context.session.id)
                ? context.activeSessions
                : [...context.activeSessions, context.session],
            });

            // Check if the triggering session is in the kill list
            if (sessionsToKill.some((s) => s.id === insertedSession.id)) {
              wasTerminatedByRule = true;
            }
          }
        }

        const actionResults: ActionResult[] = await executeActions(context, result.actions);

        // Find violation ID if one was created for this rule
        const violationId =
          violationResults.find((v) => v.rule.id === rule.id)?.violation.id ?? null;

        // Store results for UI
        await storeActionResults(violationId, result.ruleId, actionResults);
      }

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
  // Use durationMs (actual watch time) for completion check, not progressMs (playback position)
  // because some servers report incorrect position (e.g., Emby iOS transcoded sessions)
  const watched = preserveWatched
    ? session.watched
    : session.watched || checkWatchCompletion(durationMs, session.totalDurationMs);

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
  const {
    existingSession,
    processed,
    server,
    serverUser,
    geo,
    activeRulesV2,
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
  });

  if (!wasUpdated) {
    console.log(
      `[SessionLifecycle] Media change detected but session ${existingSession.id} was already stopped by another process.`
    );
    return null;
  }

  // STEP 2: Create new session for the new media
  const { insertedSession, violationResults, wasTerminatedByRule } =
    await createSessionWithRulesAtomic({
      processed,
      server,
      serverUser,
      geo,
      activeRulesV2,
      activeSessions,
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

// ============================================================================
// Transcode State Change Re-evaluation
// ============================================================================

/**
 * Re-evaluate V2 rules when an existing session's transcode state changes.
 *
 * Only rules containing transcode-related conditions (is_transcoding, is_transcode_downgrade,
 * output_resolution) are evaluated. This prevents false positives from rules that only check
 * conditions like concurrent_streams which are already evaluated at session creation.
 *
 * Deduplication: checks for existing violations per (ruleId, sessionId) before inserting,
 * since the DB unique index uses ruleType which is NULL for V2 rules.
 */
export async function reEvaluateRulesOnTranscodeChange(
  input: TranscodeReEvalInput
): Promise<ViolationInsertResult[]> {
  const {
    existingSession,
    processed,
    server,
    serverUser,
    activeRulesV2,
    activeSessions,
    recentSessions,
  } = input;

  // Filter to only rules that have transcode-related conditions
  const transcodeRules = activeRulesV2.filter(hasTranscodeConditions);
  if (transcodeRules.length === 0) return [];

  // Build Session object from existing session + updated transcode fields
  const session: Session = {
    id: existingSession.id,
    serverId: existingSession.serverId,
    serverUserId: existingSession.serverUserId,
    sessionKey: existingSession.sessionKey,
    externalSessionId: existingSession.externalSessionId,
    state: processed.state,
    mediaType: processed.mediaType,
    mediaTitle: processed.mediaTitle,
    grandparentTitle: processed.grandparentTitle || null,
    seasonNumber: processed.seasonNumber || null,
    episodeNumber: processed.episodeNumber || null,
    year: processed.year || null,
    thumbPath: processed.thumbPath || null,
    ratingKey: existingSession.ratingKey,
    startedAt: existingSession.startedAt,
    stoppedAt: null,
    durationMs: null,
    totalDurationMs: processed.totalDurationMs || null,
    progressMs: processed.progressMs || null,
    lastPausedAt: existingSession.lastPausedAt,
    pausedDurationMs: existingSession.pausedDurationMs,
    referenceId: existingSession.referenceId,
    watched: existingSession.watched,
    ipAddress: existingSession.ipAddress,
    geoCity: existingSession.geoCity,
    geoRegion: existingSession.geoRegion,
    geoCountry: existingSession.geoCountry,
    geoContinent: existingSession.geoContinent,
    geoPostal: existingSession.geoPostal,
    geoLat: existingSession.geoLat,
    geoLon: existingSession.geoLon,
    geoAsnNumber: existingSession.geoAsnNumber,
    geoAsnOrganization: existingSession.geoAsnOrganization,
    playerName: processed.playerName,
    deviceId: processed.deviceId || null,
    product: processed.product || null,
    device: processed.device || null,
    platform: processed.platform,
    quality: processed.quality,
    // Updated transcode fields (the reason for re-evaluation)
    isTranscode: processed.isTranscode,
    videoDecision: processed.videoDecision,
    audioDecision: processed.audioDecision,
    bitrate: processed.bitrate,
    ...pickStreamDetailFields(processed),
    channelTitle: existingSession.channelTitle,
    channelIdentifier: existingSession.channelIdentifier,
    channelThumb: existingSession.channelThumb,
    artistName: existingSession.artistName,
    albumName: existingSession.albumName,
    trackNumber: existingSession.trackNumber,
    discNumber: existingSession.discNumber,
  };

  const serverObj: Server = {
    id: server.id,
    name: server.name,
    type: server.type as Server['type'],
    url: '',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const serverUserObj: ServerUser = {
    id: serverUser.id,
    userId: '',
    serverId: server.id,
    externalId: '',
    username: serverUser.username,
    email: null,
    thumbUrl: serverUser.thumbUrl,
    isServerAdmin: false,
    trustScore: serverUser.trustScore,
    sessionCount: serverUser.sessionCount,
    joinedAt: null,
    lastActivityAt: serverUser.lastActivityAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const baseContext: Omit<EvaluationContext, 'rule'> = {
    session,
    serverUser: serverUserObj,
    server: serverObj,
    activeSessions,
    recentSessions,
  };

  // Evaluate only transcode-related rules
  const ruleResults = await evaluateRulesAsync(baseContext, transcodeRules);

  const createdViolations: ViolationInsertResult[] = [];

  for (const result of ruleResults) {
    if (!result.matched) continue;

    const rule = transcodeRules.find((r) => r.id === result.ruleId);
    if (!rule) continue;

    const violationAction = result.actions.find((a) => a.type === 'create_violation');

    if (violationAction?.type === 'create_violation') {
      const severity = violationAction.severity;
      const trustPenalty = getTrustScorePenalty(severity);

      // Use a transaction with advisory lock to prevent duplicate violations.
      // The DB unique index uses ruleType (NULL for V2), and NULL != NULL in PG,
      // so onConflictDoNothing can't catch V2 duplicates. The advisory lock
      // serializes concurrent SSE + reconciliation poll attempts for the same
      // session+rule pair, and the transaction ensures atomicity of the
      // dedup check + insert + trust penalty.
      const violationResult = await db.transaction(async (tx) => {
        // Advisory lock scoped to this session+rule pair.
        // Released automatically when the transaction commits/rolls back.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${existingSession.id} || '::' || ${rule.id}))`
        );

        // Dedup check (now race-free under advisory lock)
        const existing = await tx
          .select({ id: violations.id })
          .from(violations)
          .where(
            and(
              eq(violations.ruleId, rule.id),
              eq(violations.sessionId, existingSession.id),
              isNull(violations.acknowledgedAt)
            )
          )
          .limit(1);

        if (existing[0]) return null; // Already has a violation for this rule + session

        const insertedViolations = await tx
          .insert(violations)
          .values({
            ruleId: rule.id,
            serverUserId: serverUser.id,
            sessionId: existingSession.id,
            severity,
            ruleType: null,
            data: {
              ruleName: rule.name,
              matchedGroups: result.matchedGroups,
              sessionKey: session.sessionKey,
              mediaTitle: session.mediaTitle,
              ipAddress: session.ipAddress,
              transcodeReEval: true,
            },
          })
          .onConflictDoNothing()
          .returning();

        const violation = insertedViolations[0];
        if (!violation) return null;

        // Decrease trust score (atomic with the insert)
        await tx
          .update(serverUsers)
          .set({
            trustScore: sql`GREATEST(0, ${serverUsers.trustScore} - ${trustPenalty})`,
            updatedAt: new Date(),
          })
          .where(eq(serverUsers.id, serverUser.id));

        return violation;
      });

      if (violationResult) {
        const ruleInfo = {
          id: rule.id,
          name: rule.name,
          type: null,
        };

        createdViolations.push({ violation: violationResult, rule: ruleInfo, trustPenalty });

        console.log(
          `[rules] Transcode re-eval: rule "${rule.name}" matched session ${existingSession.id}`
        );
      }
    }

    // Execute non-violation actions (e.g., kill_stream, send_notification)
    // Runs outside the transaction - side effects shouldn't block violation commit,
    // and the advisory lock prevents duplicate action execution for the same rule+session.
    const sideEffectActions = result.actions.filter((a) => a.type !== 'create_violation');
    if (sideEffectActions.length > 0) {
      const context: EvaluationContext = { ...baseContext, rule };
      const actionResults: ActionResult[] = await executeActions(context, sideEffectActions);

      const violationId =
        createdViolations.find((v) => v.rule.id === rule.id)?.violation.id ?? null;
      await storeActionResults(violationId, result.ruleId, actionResults);
    }
  }

  return createdViolations;
}
