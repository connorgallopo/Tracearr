/**
 * V2 Rules Integration Module
 *
 * Wires real implementations into the V2 action executor system and provides
 * migration support from V1 legacy rules.
 */

import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import { REDIS_KEYS } from '@tracearr/shared';
import { db, type Executor } from '../../db/client.js';
import { ruleActionResults } from '../../db/schema.js';
import { readSessionRow } from '../../db/sessions/row.js';
import { automationsLogger } from '../../utils/logger.js';
import { applyTrustChange, type TrustChange } from '../userService.js';
import { dispatchTrustChanged } from './events/producers.js';
import {
  setActionExecutorDeps,
  type ActionExecutorDeps,
  type ActionResult,
} from './executors/index.js';
import { convertLegacyRule, type LegacyRuleType } from './migration.js';

// ============================================================================
// Action Result Storage
// ============================================================================

/**
 * Store action execution results in the database.
 *
 * @param violationId - Optional violation ID if one was created
 * @param ruleId - The rule that triggered the actions
 * @param results - Array of action execution results
 */
export async function storeActionResults(
  violationId: string | null,
  ruleId: string,
  results: ActionResult[]
): Promise<void> {
  if (results.length === 0) return;

  const values = results.map((result) => ({
    violationId: violationId ?? null,
    ruleId,
    actionType: result.action.type,
    success: result.success,
    skipped: result.skipped ?? false,
    skipReason: result.skipReason ?? null,
    errorMessage: result.success ? null : (result.message ?? null),
  }));

  await db.insert(ruleActionResults).values(values);
}

// ============================================================================
// Cooldowns
// ============================================================================

/** Cooldown keys hold nothing but their TTL; presence is the whole answer. */
export async function isCoolingDown(redis: Redis, key: string): Promise<boolean> {
  return (await redis.exists(key)) === 1;
}

export async function armCooldown(redis: Redis, key: string, minutes: number): Promise<void> {
  await redis.setex(key, minutes * 60, '1');
}

// ============================================================================
// Dependency Factory
// ============================================================================

/** The three modes share one path: write, then announce the move the write made. */
async function changeTrust(
  serverUserId: string,
  change: TrustChange,
  reason: string
): Promise<void> {
  const applied = await applyTrustChange(serverUserId, change);
  if (!applied) return;
  const { previous, serverUser } = applied;
  automationsLogger.debug(`Trust score ${previous} -> ${serverUser.trustScore}`, {
    userId: serverUserId,
    mode: change.mode,
  });
  await dispatchTrustChanged({
    serverId: serverUser.serverId,
    serverUserId,
    previous,
    next: serverUser.trustScore,
    reason,
  });
}

/**
 * Create real implementations for all action executor dependencies.
 *
 * @param redis - Redis client for cooldown tracking
 * @returns ActionExecutorDeps with all implementations wired
 */
export function createActionExecutorDeps(redis: Redis): ActionExecutorDeps {
  return {
    /**
     * Fan the automation's event out to its destinations.
     * Uses dynamic import to avoid circular dependency.
     */
    enqueueAutomationNotification: async ({ to, event, source }) => {
      const { enqueueNotification } = await import('../../jobs/notificationQueue.js');

      const count = await enqueueNotification(event, { to, source });
      if (count > 0) {
        automationsLogger.info(`Notification enqueued: ${event.type}`, { to, count });
      }
      return count;
    },

    adjustUserTrust: (serverUserId, delta, reason) =>
      changeTrust(serverUserId, { mode: 'adjust', amount: delta }, reason),
    setUserTrust: (serverUserId, value, reason) =>
      changeTrust(serverUserId, { mode: 'set', value }, reason),
    resetUserTrust: (serverUserId, reason) => changeTrust(serverUserId, { mode: 'reset' }, reason),

    /**
     * Enqueue termination through the kill queue rather than terminating inline.
     * delay_seconds becomes the sustain window: the worker waits, re-verifies
     * the match against current state, and only then calls termination.ts.
     */
    terminateSession: async (
      sessionId,
      serverId,
      ruleId,
      violationId,
      delay,
      message,
      identityServerUserIds,
      cooldown,
      triggeringSessionId,
      sessionStarts
    ) => {
      // Dynamic import to avoid circular dependency
      const { enqueueKill } = await import('../../jobs/killQueue.js');

      const delaySeconds = delay && delay > 0 ? delay : 0;

      const jobId = await enqueueKill(
        {
          targetSessionId: sessionId,
          triggeringSessionId: triggeringSessionId ?? sessionId,
          serverId,
          ruleId,
          violationId,
          message,
          identityServerUserIds,
          cooldownMinutes: cooldown?.minutes,
          triggeringServerUserId: cooldown?.triggeringServerUserId,
          targetStartedAt: sessionStarts && new Date(sessionStarts.target).toISOString(),
          triggeringStartedAt: sessionStarts && new Date(sessionStarts.triggering).toISOString(),
        },
        delaySeconds
      );

      automationsLogger.debug('Kill enqueued', {
        targetSessionId: sessionId,
        triggeringSessionId: triggeringSessionId ?? sessionId,
        serverId,
        ruleId,
        violationId,
        delaySeconds,
        identityServerUserIds,
        jobId,
      });

      return jobId;
    },

    /**
     * Send a message to the client device.
     * Plex does not support client messaging - only Jellyfin/Emby do.
     */
    sendClientMessage: async (sessionId, message, startedAt) => {
      const session = await readSessionRow(sessionId, startedAt, (where) =>
        db.query.sessions.findFirst({ where, with: { server: true } })
      );

      if (!session) {
        automationsLogger.warn('Cannot send message: session not found', { sessionId });
        return undefined;
      }

      if (session.server.historicalAt) {
        automationsLogger.debug('Skipping message_client for a historical server', { sessionId });
        return { skipReason: 'server_historical' };
      }

      // Plex doesn't support client messaging
      if (session.server.type === 'plex') {
        automationsLogger.debug('Skipping message_client for Plex (not supported)', { sessionId });
        return undefined;
      }

      // Dynamic import to avoid circular dependency
      const { createMediaServerClient } = await import('../mediaServer/index.js');
      const client = createMediaServerClient({
        type: session.server.type,
        url: session.server.url,
        token: session.server.token,
      });

      // Jellyfin/Emby use sessionKey for API calls
      if ('sendMessage' in client && typeof client.sendMessage === 'function') {
        await client.sendMessage(session.sessionKey, message, 'Tracearr', 10000);
        automationsLogger.debug('Client message sent', { sessionId, message });
      }
      return undefined;
    },

    /**
     * Check if a rule/target combination is on cooldown.
     */
    checkCooldown: async (ruleId, targetId, _cooldownMinutes) => {
      return isCoolingDown(redis, REDIS_KEYS.ACTION_COOLDOWN(ruleId, targetId));
    },

    /**
     * Set cooldown for a rule/target combination.
     */
    setCooldown: async (ruleId, targetId, cooldownMinutes) => {
      const key = REDIS_KEYS.ACTION_COOLDOWN(ruleId, targetId);
      await armCooldown(redis, key, cooldownMinutes);

      automationsLogger.debug(`Set cooldown for ${cooldownMinutes} minutes`, {
        ruleId,
        targetId,
        key,
      });
    },
  };
}

// ============================================================================
// V1 to V2 Migration
// ============================================================================

/** A row with a legacy `type` and no `conditions`, as written by the retired V1 create route. */
export interface LegacyAutomationRow {
  id: string;
  name: string;
  type: LegacyRuleType;
  params: Record<string, unknown> | null;
  serverUserId: string | null;
  serverId: string | null;
  isActive: boolean;
}

/**
 * Rewrite one legacy row as V2 conditions and actions, clearing the legacy fields.
 * Throws on an unconvertible type so the caller's transaction rolls back whole.
 */
export async function convertV1Rule(executor: Executor, row: LegacyAutomationRow): Promise<void> {
  const converted = convertLegacyRule({
    id: row.id,
    name: row.name,
    type: row.type,
    params: row.params ?? {},
    serverUserId: row.serverUserId,
    serverId: row.serverId,
    isActive: row.isActive,
  });

  if (!converted) {
    throw new Error(`Cannot convert rule ${row.id}: unknown V1 type "${row.type}"`);
  }

  // Raw because `type` and `params` are gone from the schema; only a legacy row still has them.
  await executor.execute(sql`
    UPDATE automations
    SET severity = ${converted.severity},
        conditions = ${JSON.stringify(converted.conditions)}::jsonb,
        actions = ${JSON.stringify(converted.actions)}::jsonb,
        type = NULL,
        params = NULL,
        updated_at = now()
    WHERE id = ${row.id}
  `);
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize V2 rules system: wire real implementations into the action executors.
 * Legacy row conversion belongs to the boot model migration.
 *
 * @param redis - Redis client for cooldown tracking
 */
export async function initializeV2Rules(redis: Redis): Promise<void> {
  automationsLogger.info('Initializing V2 rules system...');

  // Wire action executor dependencies
  const deps = createActionExecutorDeps(redis);
  setActionExecutorDeps(deps);
  automationsLogger.debug('Action executor dependencies wired');

  automationsLogger.info('V2 rules system initialized');
}
