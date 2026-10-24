/**
 * Kill Queue Re-verification
 *
 * Re-checks a matched kill_stream condition against current state right
 * before the delayed termination fires. delay_seconds is the sustain window
 * between the original match and this check, so a session that stopped or a
 * condition that cleared in the meantime must abort rather than kill on
 * stale evidence. Builds its evaluation context through the same seams live
 * rule evaluation uses (excludeUncountableSessions, gracePeriodSessionIds,
 * evaluateRulesAsync) so re-verification and live evaluation can never
 * disagree about what counts as an active session.
 *
 * A kill job carries two session ids. The TRIGGER is the session whose match
 * produced the kill; its context (user, server, media, geo, identity,
 * recentSessions) is what the rule matched on, so re-verification rebuilds the
 * evaluation context from the trigger. The TARGET is the session actually
 * terminated - for target: 'triggering' the two are the same, but multi-target
 * (oldest/newest/all_*) and enforceAcrossServers kills point the target at a
 * different session, possibly on another server or account, whose own context
 * never matched the rule. Re-verifying against the target instead of the
 * trigger loses those kills and, for serverId/serverUserId-scoped
 * enforceAcrossServers rules, self-aborts every time on the scope check. The
 * target still owns the already-stopped short-circuit and the termination call.
 *
 * The cache is not a faithful stand-in for "current state" for the triggering
 * session specifically: createSessionWithRulesAtomic skips re-adding it to the
 * cache once a kill job is enqueued for it (wasTerminatedByRule), so at
 * delay_seconds 0 this can run before any poll tick rediscovers it. The context
 * and target sessions are appended back into the count context only when
 * genuinely uncached (absent from the RAW cache list), never when
 * excludeUncountableSessions dropped them for being grace-flagged, which would
 * count a stream the system already thinks stopped. A pending flag on either is
 * stale instead: both have a DB row, a pending session has none, and a delay 0
 * job runs before the confirming caller rewrites the entry it cached at first
 * sight. The flag is cleared before filtering.
 *
 * A multi-target match fans out one kill job per target, all sharing one
 * violation id. A sibling stopped BY THIS violation is ACTION REACH, not the
 * condition genuinely clearing, so it must not weaken the condition for its
 * still-pending siblings. Two effects are undone: (a) when the trigger itself
 * was the sibling stopped under this violation (its termination log carries the
 * violation id and forceStopped is set), it is treated as still-present and the
 * context is rebuilt as-at-trigger from its row rather than aborting; (b) every
 * session terminated under this violation is folded back into the count context
 * so a threshold like concurrent_streams does not drop below its limit as
 * siblings die. A genuine trigger loss (user stopped it, no rule termination
 * log tying the stop to this violation) still aborts.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { automations } from '../../db/schema.js';
import { readSessionRow } from '../../db/sessionRow.js';
import { getCacheService } from '../cache.js';
import {
  batchGetIdentityServerUserIds,
  batchGetRecentUserSessions,
  maxWindowHoursFromAutomations,
  getSessionsTerminatedByViolation,
  mapAutomationRow,
  widenRecentSessionsForMergedIdentities,
} from '../../jobs/poller/database.js';
import { excludeUncountableSessions } from '../../jobs/poller/utils.js';
import { gracePeriodSessionIds } from '../../jobs/poller/processor.js';
import { buildRuleContextSessions } from './events/contextAssembly.js';
import { terminateSession } from '../termination.js';
import { automationsLogger } from '../../utils/logger.js';
import { isLocalSession } from '../../utils/localSession.js';
import { evaluateRulesAsync } from './engine.js';
import type { EvaluationContext } from './types.js';

export type ReverifyOutcome =
  | 'killed'
  | 'skipped_already_stopped'
  | 'skipped_rule_gone'
  | 'skipped_condition_cleared'
  | 'failed';

export interface ReverifyKillConditionParams {
  /** Session whose match produced this kill. The evaluation context (session,
   *  serverUser, server, identity, recentSessions) is rebuilt from THIS row so
   *  the re-check reproduces the match live evaluation made. */
  triggeringSessionId: string;
  /** Session actually terminated. Equals triggeringSessionId for
   *  target: 'triggering'; differs for oldest/newest/all_* and
   *  enforceAcrossServers kills. */
  targetSessionId: string;
  serverId: string;
  ruleId: string;
  /** Violation the kill_stream match created; carried through to the
   *  termination log so rule kills are attributed to their violation. */
  violationId?: string | null;
  /** Message to display to the user before termination (Plex only). */
  message?: string;
  /** True when a prior attempt of this same BullMQ job already ran (and
   *  failed after termination, e.g. storeActionResults threw). Narrows the
   *  already-stopped idempotency check below to retries only. */
  isRetry?: boolean;
  /** Starts captured at match time; absent on jobs queued before they were carried. */
  targetStartedAt?: string;
  triggeringStartedAt?: string;
}

export interface ReverifyKillConditionResult {
  outcome: ReverifyOutcome;
  error?: string;
  /** More specific reason than the coarse outcome enum, persisted as the
   *  action's skipReason when present. Used when a skipped_condition_cleared
   *  outcome would otherwise misread the truth - e.g. a cross-server kill that
   *  cannot be re-evaluated after the trigger is genuinely gone, which is "not
   *  evaluable", not "condition cleared". */
  skipReason?: string;
}

/**
 * Re-verify a kill_stream match at fire time and terminate if it still holds.
 * Ownership of the actual termination call lives here rather than in the
 * queue worker, so a "matched" result and a "killed" outcome can never drift
 * apart.
 */
export async function reverifyKillCondition(
  params: ReverifyKillConditionParams
): Promise<ReverifyKillConditionResult> {
  const {
    triggeringSessionId,
    targetSessionId,
    serverId,
    ruleId,
    violationId,
    message,
    isRetry,
    targetStartedAt,
    triggeringStartedAt,
  } = params;

  // The TARGET decides the already-stopped short-circuit and is the session we
  // actually terminate.
  const targetFound = await readSessionRow(targetSessionId, targetStartedAt, (where) =>
    db.query.sessions.findFirst({ where, with: { server: true, serverUser: true } })
  );

  if (!targetFound) {
    return { outcome: 'skipped_already_stopped' };
  }
  const targetRow = { ...targetFound, isLocal: isLocalSession(targetFound) };

  if (targetRow.server.historicalAt) {
    return { outcome: 'skipped_condition_cleared', skipReason: 'server_historical' };
  }

  if (targetRow.stoppedAt) {
    // A retry only happens after a prior attempt of this exact job got past
    // termination and then threw (e.g. storeActionResults failing) - forceStopped
    // is already on the row we just fetched, so this costs no extra query and
    // avoids relabeling that earlier success as skipped_already_stopped. It
    // can't tell this job's kill apart from an unrelated forced stop (admin,
    // stale sweep) landing in the same narrow retry window; that tradeoff is
    // accepted given how rarely the two coincide within a few seconds.
    if (isRetry && targetRow.forceStopped) {
      return { outcome: 'killed' };
    }
    return { outcome: 'skipped_already_stopped' };
  }

  const [ruleRow] = await db.select().from(automations).where(eq(automations.id, ruleId)).limit(1);
  if (!ruleRow || !ruleRow.isActive || !ruleRow.conditions) {
    return { outcome: 'skipped_rule_gone' };
  }

  // No version id: re-verification decides a kill against the live definition and records no run.
  const rule = mapAutomationRow(ruleRow, null);

  // Sessions this same violation already terminated (see module header). Used
  // both to tell a self-inflicted trigger stop apart from a genuine one and to
  // keep the killed siblings counting when rebuilding the count context.
  const violationTerminatedSessions = violationId
    ? await getSessionsTerminatedByViolation(violationId)
    : [];
  const violationTerminatedIds = new Set(violationTerminatedSessions.map((s) => s.id));

  // Evaluate against the TRIGGER's context, not the target's. The rule matched
  // because of the triggering session (its user, server, media, geo, ...); a
  // multi-target or enforceAcrossServers kill can point at a sibling session on
  // another server/account whose own context never matched the rule (and whose
  // server fails the rule's serverId scope), so re-verifying against the target
  // would lose legitimate kills and, for scoped enforceAcrossServers rules,
  // self-abort every time.
  let contextSession = targetRow;
  if (triggeringSessionId !== targetSessionId) {
    const triggerFound = await readSessionRow(triggeringSessionId, triggeringStartedAt, (where) =>
      db.query.sessions.findFirst({ where, with: { server: true, serverUser: true } })
    );
    const triggerRow = triggerFound && { ...triggerFound, isLocal: isLocalSession(triggerFound) };

    if (triggerRow && !triggerRow.stoppedAt) {
      contextSession = triggerRow;
    } else if (triggerRow && triggerRow.forceStopped && violationTerminatedIds.has(triggerRow.id)) {
      // The trigger IS stopped, but a sibling job of THIS same match killed it -
      // its termination log carries this violation id and forceStopped is set.
      // That stop is action reach, not the condition clearing, so evaluate
      // as-at-trigger from its row (still coherent: id, user, server, geo, media
      // are all on the row) rather than aborting as if the user walked away.
      contextSession = triggerRow;
    } else if (rule.enforceAcrossServers) {
      // The trigger genuinely ended during the delay window (no rule kill under
      // this violation stopped it), so the as-at-trigger context is gone. For an
      // identity-wide rule the target's own context is still coherent (detection
      // aggregates across the whole identity regardless of which session is
      // "session"), so fall back to it - UNLESS the rule is scoped to a specific
      // server/account the target does not satisfy. Then the engine scope check
      // would drop it and report skipped_condition_cleared, which reads as "the
      // condition cleared" when the truth is "cannot re-evaluate cross-server
      // after the trigger is gone". Say that plainly instead.
      const targetOutOfScope =
        (rule.serverId != null && rule.serverId !== targetRow.serverId) ||
        (rule.serverUserId != null && rule.serverUserId !== targetRow.serverUserId);
      if (targetOutOfScope) {
        automationsLogger.info(
          'Kill queue: trigger gone, target out of rule scope, cannot re-verify',
          {
            triggeringSessionId,
            targetSessionId,
            ruleId,
          }
        );
        return {
          outcome: 'skipped_condition_cleared',
          skipReason: 'trigger_gone_cross_server_unverifiable',
        };
      }
      contextSession = targetRow;
    } else {
      // Non-identity rule with the trigger gone: the condition can no longer be
      // evaluated as-at-trigger and the target's context never matched on its
      // own, so abort instead of killing on a context that was never checked.
      automationsLogger.info('Kill queue: trigger session gone, aborting kill', {
        triggeringSessionId,
        targetSessionId,
        ruleId,
      });
      return { outcome: 'skipped_condition_cleared' };
    }
  }

  const cacheService = getCacheService();
  const persistedIds = new Set([contextSession.id, targetRow.id]);
  const cachedSessions = (cacheService ? await cacheService.getAllActiveSessions() : []).map((s) =>
    s.pending && persistedIds.has(s.id) ? { ...s, pending: false } : s
  );
  const countableCachedSessions = excludeUncountableSessions(
    cachedSessions,
    gracePeriodSessionIds()
  );
  // contextSession is missing from countableCachedSessions exactly when this
  // kill was enqueued for the triggering session (see module header) - append
  // it back so conditions like concurrent_streams count it instead of
  // undercounting by one and self-aborting. Append ONLY when it is genuinely
  // uncached (absent from the RAW cache list). If it sits in the raw cache but
  // excludeUncountableSessions dropped it (grace-flagged), trust the filter
  // and leave it out.
  const rawCacheIds = new Set(cachedSessions.map((s) => s.id));
  let activeSessions = buildRuleContextSessions(countableCachedSessions, contextSession, null);
  if (rawCacheIds.has(contextSession.id)) {
    // Raw-cached: trust excludeUncountableSessions rather than the unconditional
    // append above. If the filter dropped it (grace), it stays out.
    activeSessions = countableCachedSessions;
  }
  // The target, if it is a different still-playing session that is genuinely
  // uncached, is counted too. Same grace guard: a raw-cached target the filter
  // dropped must stay dropped.
  if (
    targetRow.id !== contextSession.id &&
    !rawCacheIds.has(targetRow.id) &&
    !activeSessions.some((s) => s.id === targetRow.id)
  ) {
    activeSessions = [...activeSessions, targetRow];
  }
  // Fold back the siblings this same violation already terminated: they left the
  // cache as each sibling job killed its target, but a session stopped BY THIS
  // violation is action reach, not the condition clearing, so it must keep
  // counting for the still-pending siblings (see module header). Without this a
  // threshold like concurrent_streams >= 3 drops below its limit as siblings die
  // and the later jobs self-abort, killing only some of the matched sessions.
  for (const terminated of violationTerminatedSessions) {
    if (!activeSessions.some((s) => s.id === terminated.id)) {
      activeSessions = [...activeSessions, terminated];
    }
  }

  // Identity aggregation runs unconditionally here, mirroring the live poller
  // (processor.ts) - detection-side identity counting is NOT gated by
  // enforceAcrossServers, that flag only controls whether a MATCHED rule's
  // actions reach sessions beyond the triggering one. Gating this lookup on
  // the flag would let a kill matched under live evaluation's identity-wide
  // count re-verify with single-account context and wrongly self-abort as
  // skipped_condition_cleared. Always re-derived here from the DB rather than
  // trusting the identityServerUserIds snapshot the enqueue payload carries
  // from match time: identity membership (server merges/unmerges) can change
  // during the delay window between match and this re-check.
  const identityMap = await batchGetIdentityServerUserIds([contextSession.serverUser.userId]);
  const identityServerUserIds = identityMap.get(contextSession.serverUser.userId);

  const recentSessionsUserIds =
    identityServerUserIds && identityServerUserIds.length > 1
      ? identityServerUserIds
      : [contextSession.serverUserId];
  // The kill worker runs on every instance while the rules cache (and the
  // window default it feeds) only refreshes where rules evaluate, so the
  // window must be derived from THIS rule, never from the module default.
  const ruleWindowHours = maxWindowHoursFromAutomations([rule]);
  const recentSessionsMap = await batchGetRecentUserSessions(
    recentSessionsUserIds,
    ruleWindowHours
  );

  // Widen recentSessions across the identity's server_user ids so windowed
  // evaluators (unique_ips_in_window, travel_speed_kmh, ...) see the same
  // cross-server history live evaluation matched on, not just this session's
  // own account - otherwise a cross-server match can silently fail to
  // reproduce here and abort as skipped_condition_cleared.
  if (identityServerUserIds && identityServerUserIds.length > 1) {
    await widenRecentSessionsForMergedIdentities(
      recentSessionsMap,
      new Map([[contextSession.serverUser.userId, identityServerUserIds]]),
      ruleWindowHours
    );
  }

  // The context session's own row is present in recentSessions by re-verify
  // time (it has been persisted). The evaluators exclude the current session by
  // object reference, not id, and contextSession is a different object than its
  // recent-sessions row, so drop it by id here - otherwise travel_speed_kmh and
  // friends compare the session against itself (0 km, speed 0) and clear.
  const recentSessions = (recentSessionsMap.get(contextSession.serverUserId) ?? []).filter(
    (s) => s.id !== contextSession.id
  );

  const baseContext: Omit<EvaluationContext, 'rule'> = {
    session: contextSession,
    serverUser: contextSession.serverUser,
    server: contextSession.server,
    media: null,
    subjectKey: contextSession.id,
    activeSessions,
    recentSessions,
    identityServerUserIds,
  };

  const results = await evaluateRulesAsync(baseContext, [rule]);
  const matched = results.some((r) => r.ruleId === rule.id && r.matched);

  if (!matched) {
    return { outcome: 'skipped_condition_cleared' };
  }

  try {
    const result = await terminateSession({
      sessionId: targetSessionId,
      sessionStartedAt: targetRow.startedAt,
      trigger: 'rule',
      ruleId,
      violationId: violationId ?? undefined,
      reason: message,
    });

    if (!result.success) {
      return { outcome: 'failed', error: result.error ?? 'Termination failed' };
    }

    automationsLogger.info('Kill queue: terminated session after re-verification', {
      triggeringSessionId,
      targetSessionId,
      serverId,
      ruleId,
    });

    return { outcome: 'killed' };
  } catch (err) {
    return {
      outcome: 'failed',
      error: err instanceof Error ? err.message : 'Unknown termination error',
    };
  }
}
