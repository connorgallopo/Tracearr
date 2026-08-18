/**
 * V2 Rules Integration Module
 *
 * Wires real implementations into the V2 action executor system and provides
 * migration support from V1 legacy rules.
 */

import type { Redis } from 'ioredis';
import { eq, sql, and, isNull, isNotNull } from 'drizzle-orm';
import { REDIS_KEYS } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { rules, serverUsers, sessions, ruleActionResults } from '../../db/schema.js';
import { invalidateRulesCache } from '../../jobs/poller/database.js';
import { rulesLogger } from '../../utils/logger.js';
import { recomputeIdentityAggregates } from '../userService.js';
import {
  setActionExecutorDeps,
  type ActionExecutorDeps,
  type ActionResult,
} from './executors/index.js';
import { migrateRules, type LegacyRule } from './migration.js';

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
// Dependency Factory
// ============================================================================

/**
 * Create real implementations for all action executor dependencies.
 *
 * @param redis - Redis client for cooldown tracking
 * @returns ActionExecutorDeps with all implementations wired
 */
export function createActionExecutorDeps(redis: Redis): ActionExecutorDeps {
  return {
    /**
     * Log audit entry using the rules logger.
     */
    logAudit: async (params) => {
      rulesLogger.info(`Rule audit: ${params.ruleName}`, {
        sessionId: params.sessionId,
        serverUserId: params.serverUserId,
        serverId: params.serverId,
        ruleId: params.ruleId,
        message: params.message,
        ...params.details,
      });
    },

    /**
     * Fan the rule's event out to its destinations.
     * Uses dynamic import to avoid circular dependency.
     */
    enqueueRuleNotification: async ({ to, title, message, event }) => {
      const { enqueueNotification } = await import('../../jobs/notificationQueue.js');

      const count = await enqueueNotification(event, {
        to,
        source: { kind: 'rule', title, message },
      });
      if (count > 0) {
        rulesLogger.info(`Notification enqueued: ${title}`, { to, count });
      }
      return count;
    },

    /**
     * Adjust user trust score by delta amount.
     * Clamps result to 0-100 using GREATEST/LEAST SQL functions.
     *
     * Despite the param name (kept for interface compatibility), this is a
     * serverUserId - the account's identity rollup is recomputed in the same
     * transaction so it never reflects a trust change that hasn't happened yet.
     */
    adjustUserTrust: async (serverUserId, delta) => {
      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(serverUsers)
          .set({
            trustScore: sql`LEAST(100, GREATEST(0, ${serverUsers.trustScore} + ${delta}))`,
            updatedAt: new Date(),
          })
          .where(eq(serverUsers.id, serverUserId))
          .returning({ userId: serverUsers.userId });

        if (updated) {
          await recomputeIdentityAggregates(updated.userId, tx);
        }
      });

      rulesLogger.debug(`Adjusted trust score by ${delta}`, { userId: serverUserId });
    },

    /**
     * Set user trust score to a specific value.
     * Clamps to 0-100 range.
     */
    setUserTrust: async (serverUserId, value) => {
      const clampedValue = Math.min(100, Math.max(0, value));

      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(serverUsers)
          .set({
            trustScore: clampedValue,
            updatedAt: new Date(),
          })
          .where(eq(serverUsers.id, serverUserId))
          .returning({ userId: serverUsers.userId });

        if (updated) {
          await recomputeIdentityAggregates(updated.userId, tx);
        }
      });

      rulesLogger.debug(`Set trust score to ${clampedValue}`, { userId: serverUserId });
    },

    /**
     * Reset user trust score to baseline (100).
     */
    resetUserTrust: async (serverUserId) => {
      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(serverUsers)
          .set({
            trustScore: 100,
            updatedAt: new Date(),
          })
          .where(eq(serverUsers.id, serverUserId))
          .returning({ userId: serverUsers.userId });

        if (updated) {
          await recomputeIdentityAggregates(updated.userId, tx);
        }
      });

      rulesLogger.debug('Reset trust score to 100', { userId: serverUserId });
    },

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
      triggeringSessionId
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
        },
        delaySeconds
      );

      rulesLogger.debug('Kill enqueued', {
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
    sendClientMessage: async (sessionId, message, header, timeoutMs) => {
      // Get session with server info to determine server type
      const session = await db.query.sessions.findFirst({
        where: eq(sessions.id, sessionId),
        with: {
          server: true,
        },
      });

      if (!session) {
        rulesLogger.warn('Cannot send message: session not found', { sessionId });
        return;
      }

      // Plex doesn't support client messaging
      if (session.server.type === 'plex') {
        rulesLogger.debug('Skipping message_client for Plex (not supported)', { sessionId });
        return;
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
        // timeout_ms === 0 means "no auto-dismiss": omit TimeoutMs so
        // Jellyfin web renders a persistent dialog (its toast is a fixed
        // ~3.3s and ignores the value entirely). Absent keeps the previous
        // default of 10000 for backward compatibility.
        const resolvedTimeout = timeoutMs === 0 ? undefined : (timeoutMs ?? 10000);
        await client.sendMessage(session.sessionKey, message, header ?? 'Tracearr', resolvedTimeout);
        rulesLogger.debug('Client message sent', { sessionId, message });
      }
    },

    /**
     * Check if a rule/target combination is on cooldown.
     */
    checkCooldown: async (ruleId, targetId, _cooldownMinutes) => {
      const key = REDIS_KEYS.RULE_COOLDOWN(ruleId, targetId);
      const exists = await redis.exists(key);
      return exists === 1;
    },

    /**
     * Set cooldown for a rule/target combination.
     */
    setCooldown: async (ruleId, targetId, cooldownMinutes) => {
      const key = REDIS_KEYS.RULE_COOLDOWN(ruleId, targetId);
      const ttlSeconds = cooldownMinutes * 60;
      await redis.setex(key, ttlSeconds, '1');

      rulesLogger.debug(`Set cooldown for ${cooldownMinutes} minutes`, {
        ruleId,
        targetId,
        key,
      });
    },

    /**
     * Queue action for manual confirmation.
     * This is a deferred feature - currently a no-op.
     */
    queueForConfirmation: async (params) => {
      rulesLogger.debug('Confirmation queue not implemented', {
        ruleId: params.ruleId,
        action: params.action.type,
      });
      // Future: Store pending actions in a queue table for admin approval
    },
  };
}

// ============================================================================
// V1 to V2 Migration
// ============================================================================

/**
 * Migrate legacy V1 rules to V2 format.
 *
 * V1 rules have:
 * - type: RuleType (e.g., 'concurrent_streams', 'geo_restriction')
 * - params: JSONB with rule-specific parameters
 *
 * V2 rules have:
 * - conditions: Structured condition groups
 * - actions: Array of action definitions
 *
 * This function:
 * 1. Queries rules where type is set but conditions is null
 * 2. Converts each using the migration utilities
 * 3. Updates the rule with V2 format and clears legacy fields
 */
export async function runV1ToV2Migration(): Promise<{
  migratedCount: number;
  errors: Array<{ ruleId: string; ruleName: string; error: string }>;
}> {
  // Find rules that need migration
  const legacyRules = await db
    .select({
      id: rules.id,
      name: rules.name,
      type: rules.type,
      params: rules.params,
      serverUserId: rules.serverUserId,
      serverId: rules.serverId,
      isActive: rules.isActive,
    })
    .from(rules)
    .where(and(isNotNull(rules.type), isNull(rules.conditions)));

  if (legacyRules.length === 0) {
    rulesLogger.info('No V1 rules found requiring migration');
    return { migratedCount: 0, errors: [] };
  }

  rulesLogger.info(`Found ${legacyRules.length} V1 rules to migrate`);

  // Convert using migration utilities
  const { migrated, errors } = migrateRules(
    legacyRules
      .filter((r): r is LegacyRule & { type: NonNullable<typeof r.type> } => r.type !== null)
      .map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        params: r.params ?? {},
        serverUserId: r.serverUserId,
        serverId: r.serverId,
        isActive: r.isActive,
      }))
  );

  // Apply migrations to database
  let migratedCount = 0;
  for (const migratedRule of migrated) {
    try {
      await db
        .update(rules)
        .set({
          severity: migratedRule.severity,
          conditions: migratedRule.conditions,
          actions: migratedRule.actions,
          // Clear legacy fields after migration
          type: null,
          params: null,
          updatedAt: new Date(),
        })
        .where(eq(rules.id, migratedRule.id));

      migratedCount++;
      rulesLogger.debug(`Migrated rule ${migratedRule.id}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      errors.push({
        ruleId: migratedRule.id,
        ruleName: legacyRules.find((r) => r.id === migratedRule.id)?.name ?? 'Unknown',
        error: errorMsg,
      });
      rulesLogger.error(`Failed to migrate rule ${migratedRule.id}`, { error: errorMsg });
    }
  }

  rulesLogger.info(
    `V1 to V2 migration complete: ${migratedCount} migrated, ${errors.length} errors`
  );

  if (migratedCount > 0) {
    invalidateRulesCache();
  }

  return { migratedCount, errors };
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize V2 rules system.
 *
 * This should be called during server startup to:
 * 1. Wire real implementations into action executors
 * 2. Run migration for any remaining V1 rules
 *
 * @param redis - Redis client for cooldown tracking
 */
export async function initializeV2Rules(redis: Redis): Promise<void> {
  rulesLogger.info('Initializing V2 rules system...');

  // Wire action executor dependencies
  const deps = createActionExecutorDeps(redis);
  setActionExecutorDeps(deps);
  rulesLogger.debug('Action executor dependencies wired');

  // Run migration for any legacy rules
  const { migratedCount, errors } = await runV1ToV2Migration();

  if (migratedCount > 0) {
    rulesLogger.info(`Migrated ${migratedCount} V1 rules to V2 format`);
  }

  if (errors.length > 0) {
    rulesLogger.warn(`${errors.length} rules failed to migrate`, { errors });
  }

  rulesLogger.info('V2 rules system initialized');
}
