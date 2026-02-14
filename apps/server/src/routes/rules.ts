/**
 * Rule management routes - CRUD for sharing detection rules
 *
 * Supports both legacy (type/params) and V2 (conditions/actions) formats.
 * Legacy rules can be migrated to V2 format via the migration endpoint.
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, sql, inArray, isNull, isNotNull, and, or } from 'drizzle-orm';
import {
  createRuleSchema,
  updateRuleSchema,
  ruleIdParamSchema,
  createRuleV2Schema,
  updateRuleV2Schema,
  bulkUpdateRulesSchema,
  bulkDeleteRulesSchema,
  bulkMigrateRulesSchema,
} from '@tracearr/shared';
import type { RuleConditions, RuleActions, ViolationSeverity } from '@tracearr/shared';
import { db } from '../db/client.js';
import { rules, serverUsers, violations, servers } from '../db/schema.js';
import { hasServerAccess } from '../utils/serverFiltering.js';
import { scheduleInactivityChecks, hasInactivityCondition } from '../jobs/inactivityCheckQueue.js';
import { scheduleTrafficChecks, hasTrafficCondition } from '../jobs/trafficCheckQueue.js';
import {
  needsMigration,
  convertLegacyRule,
  migrateRules,
  type LegacyRule,
} from '../services/rules/migration.js';

export const ruleRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /rules - List all rules
   *
   * Rules can be:
   * - Global (serverUserId = null) - applies to all servers, visible to all
   * - User-specific (serverUserId set) - only visible if user has access to that server
   */
  app.get('/', { preHandler: [app.authenticate] }, async (request) => {
    const authUser = request.user;

    // Get all rules with server user and server information
    const ruleList = await db
      .select({
        id: rules.id,
        name: rules.name,
        description: rules.description,
        severity: rules.severity,
        // Legacy fields
        type: rules.type,
        params: rules.params,
        // V2 fields
        conditions: rules.conditions,
        actions: rules.actions,
        // Scope
        serverId: rules.serverId,
        serverUserId: rules.serverUserId,
        username: serverUsers.username,
        serverUserServerId: serverUsers.serverId,
        serverName: servers.name,
        isActive: rules.isActive,
        createdAt: rules.createdAt,
        updatedAt: rules.updatedAt,
      })
      .from(rules)
      .leftJoin(serverUsers, eq(rules.serverUserId, serverUsers.id))
      .leftJoin(servers, or(eq(rules.serverId, servers.id), eq(serverUsers.serverId, servers.id)))
      .orderBy(rules.name);

    // Filter rules by server access
    // Global rules (no serverId and no serverUserId) are visible to all
    // Server-scoped or user-specific rules require server access
    const filteredRules = ruleList.filter((rule) => {
      // Global rule - visible to everyone
      if (!rule.serverId && !rule.serverUserId) return true;
      // Server-scoped rule - check server access
      if (rule.serverId) return hasServerAccess(authUser, rule.serverId);
      // User-specific rule - check server access via server user
      if (rule.serverUserServerId) return hasServerAccess(authUser, rule.serverUserServerId);
      return false;
    });

    // Compute effective serverId for each rule
    const rulesWithEffectiveServerId = filteredRules.map((rule) => ({
      ...rule,
      effectiveServerId: rule.serverId ?? rule.serverUserServerId ?? null,
    }));

    return { data: rulesWithEffectiveServerId };
  });

  /**
   * POST /rules - Create a new rule
   */
  app.post('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = createRuleSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const authUser = request.user;

    // Only owners can create rules
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can create rules');
    }

    const { name, type, params, serverUserId, isActive } = body.data;

    // Verify serverUserId exists and user has access if provided
    if (serverUserId) {
      const serverUserRows = await db
        .select({
          id: serverUsers.id,
          serverId: serverUsers.serverId,
        })
        .from(serverUsers)
        .where(eq(serverUsers.id, serverUserId))
        .limit(1);

      const serverUser = serverUserRows[0];
      if (!serverUser) {
        return reply.notFound('Server user not found');
      }

      // Verify owner has access to this server
      if (!hasServerAccess(authUser, serverUser.serverId)) {
        return reply.forbidden('You do not have access to this server');
      }
    }

    // Create rule
    const inserted = await db
      .insert(rules)
      .values({
        name,
        type,
        params,
        serverUserId,
        isActive,
      })
      .returning();

    const rule = inserted[0];
    if (!rule) {
      return reply.internalServerError('Failed to create rule');
    }

    // Reschedule inactivity checks if this is an inactivity rule
    if (type === 'account_inactivity') {
      void scheduleInactivityChecks();
    }
    if (type === 'maximum_traffic') {
      void scheduleTrafficChecks();
    }

    return reply.status(201).send(rule);
  });

  /**
   * POST /rules/v2 - Create a new V2 rule with conditions and actions
   */
  app.post('/v2', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = createRuleV2Schema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest(`Invalid request body: ${body.error.message}`);
    }

    const authUser = request.user;

    // Only owners can create rules
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can create rules');
    }

    const { name, description, serverId, isActive, severity, conditions, actions } = body.data;

    // Verify serverId exists and user has access if provided
    if (serverId) {
      const serverRows = await db
        .select({ id: servers.id })
        .from(servers)
        .where(eq(servers.id, serverId))
        .limit(1);

      if (!serverRows[0]) {
        return reply.notFound('Server not found');
      }

      // Verify owner has access to this server
      if (!hasServerAccess(authUser, serverId)) {
        return reply.forbidden('You do not have access to this server');
      }
    }

    // Create rule with V2 format
    const inserted = await db
      .insert(rules)
      .values({
        name,
        description,
        serverId,
        isActive,
        severity,
        conditions,
        actions,
      })
      .returning();

    const rule = inserted[0];
    if (!rule) {
      return reply.internalServerError('Failed to create rule');
    }

    // Reschedule inactivity checks if this V2 rule has inactivity conditions
    if (hasInactivityCondition(conditions)) {
      void scheduleInactivityChecks();
    }
    if (hasTrafficCondition(conditions)) {
      void scheduleTrafficChecks();
    }

    return reply.status(201).send(rule);
  });

  /**
   * GET /rules/:id - Get a specific rule
   */
  app.get('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = ruleIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid rule ID');
    }

    const { id } = params.data;
    const authUser = request.user;

    const ruleRows = await db
      .select({
        id: rules.id,
        name: rules.name,
        description: rules.description,
        severity: rules.severity,
        // Legacy fields
        type: rules.type,
        params: rules.params,
        // V2 fields
        conditions: rules.conditions,
        actions: rules.actions,
        // Scope
        serverId: rules.serverId,
        serverUserId: rules.serverUserId,
        username: serverUsers.username,
        serverUserServerId: serverUsers.serverId,
        serverName: servers.name,
        isActive: rules.isActive,
        createdAt: rules.createdAt,
        updatedAt: rules.updatedAt,
      })
      .from(rules)
      .leftJoin(serverUsers, eq(rules.serverUserId, serverUsers.id))
      .leftJoin(servers, or(eq(rules.serverId, servers.id), eq(serverUsers.serverId, servers.id)))
      .where(eq(rules.id, id))
      .limit(1);

    const rule = ruleRows[0];
    if (!rule) {
      return reply.notFound('Rule not found');
    }

    // Check access for server-scoped or user-specific rules
    const effectiveServerId = rule.serverId ?? rule.serverUserServerId;
    if (effectiveServerId && !hasServerAccess(authUser, effectiveServerId)) {
      return reply.forbidden('You do not have access to this rule');
    }

    // Get violation count for this rule
    const violationCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(violations)
      .where(eq(violations.ruleId, id));

    return {
      ...rule,
      effectiveServerId,
      needsMigration: needsMigration(rule),
      violationCount: violationCount[0]?.count ?? 0,
    };
  });

  /**
   * PATCH /rules/:id - Update a rule
   */
  app.patch('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = ruleIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid rule ID');
    }

    const body = updateRuleSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Only owners can update rules
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can update rules');
    }

    // Check rule exists and get server info
    const ruleRows = await db
      .select({
        id: rules.id,
        serverUserId: rules.serverUserId,
        serverId: serverUsers.serverId,
      })
      .from(rules)
      .leftJoin(serverUsers, eq(rules.serverUserId, serverUsers.id))
      .where(eq(rules.id, id))
      .limit(1);

    const existingRule = ruleRows[0];
    if (!existingRule) {
      return reply.notFound('Rule not found');
    }

    // Check access for user-specific rules
    if (
      existingRule.serverUserId &&
      existingRule.serverId &&
      !hasServerAccess(authUser, existingRule.serverId)
    ) {
      return reply.forbidden('You do not have access to this rule');
    }

    // Build update object
    const updateData: Partial<{
      name: string;
      params: Record<string, unknown>;
      isActive: boolean;
      updatedAt: Date;
    }> = {
      updatedAt: new Date(),
    };

    if (body.data.name !== undefined) {
      updateData.name = body.data.name;
    }

    if (body.data.params !== undefined) {
      updateData.params = body.data.params;
    }

    if (body.data.isActive !== undefined) {
      updateData.isActive = body.data.isActive;
    }

    // Update rule
    const updated = await db.update(rules).set(updateData).where(eq(rules.id, id)).returning();

    const updatedRule = updated[0];
    if (!updatedRule) {
      return reply.internalServerError('Failed to update rule');
    }

    // Reschedule inactivity checks if this rule has inactivity conditions
    if (hasInactivityCondition(updatedRule.conditions)) {
      void scheduleInactivityChecks();
    }
    if (hasTrafficCondition(updatedRule.conditions)) {
      void scheduleTrafficChecks();
    }

    return updatedRule;
  });

  /**
   * PATCH /rules/:id/v2 - Update a rule with V2 format
   */
  app.patch('/:id/v2', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = ruleIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid rule ID');
    }

    const body = updateRuleV2Schema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest(`Invalid request body: ${body.error.message}`);
    }

    const { id } = params.data;
    const authUser = request.user;

    // Only owners can update rules
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can update rules');
    }

    // Check rule exists and get server info
    const ruleRows = await db
      .select({
        id: rules.id,
        serverId: rules.serverId,
        serverUserId: rules.serverUserId,
        serverUserServerId: serverUsers.serverId,
        conditions: rules.conditions,
      })
      .from(rules)
      .leftJoin(serverUsers, eq(rules.serverUserId, serverUsers.id))
      .where(eq(rules.id, id))
      .limit(1);

    const existingRule = ruleRows[0];
    if (!existingRule) {
      return reply.notFound('Rule not found');
    }

    // Check access for server-scoped or user-specific rules
    const effectiveServerId = existingRule.serverId ?? existingRule.serverUserServerId;
    if (effectiveServerId && !hasServerAccess(authUser, effectiveServerId)) {
      return reply.forbidden('You do not have access to this rule');
    }

    const hadInactivity = hasInactivityCondition(existingRule.conditions);
    const hadTraffic = hasTrafficCondition(existingRule.conditions);

    // Build update object
    const updateData: Partial<{
      name: string;
      description: string | null;
      severity: ViolationSeverity;
      conditions: RuleConditions;
      actions: RuleActions;
      isActive: boolean;
      updatedAt: Date;
    }> = {
      updatedAt: new Date(),
    };

    if (body.data.name !== undefined) {
      updateData.name = body.data.name;
    }

    if (body.data.description !== undefined) {
      updateData.description = body.data.description;
    }

    if (body.data.severity !== undefined) {
      updateData.severity = body.data.severity;
    }

    if (body.data.conditions !== undefined) {
      updateData.conditions = body.data.conditions;
    }

    if (body.data.actions !== undefined) {
      updateData.actions = body.data.actions;
    }

    if (body.data.isActive !== undefined) {
      updateData.isActive = body.data.isActive;
    }

    // Update rule
    const updated = await db.update(rules).set(updateData).where(eq(rules.id, id)).returning();

    const updatedRule = updated[0];
    if (!updatedRule) {
      return reply.internalServerError('Failed to update rule');
    }

    // Reschedule inactivity checks if inactivity conditions changed
    const hasInactivity = hasInactivityCondition(updatedRule.conditions);
    if (hadInactivity || hasInactivity) {
      void scheduleInactivityChecks();
    }
    const hasTraffic = hasTrafficCondition(updatedRule.conditions);
    if (hadTraffic || hasTraffic) {
      void scheduleTrafficChecks();
    }

    return updatedRule;
  });

  /**
   * DELETE /rules/:id - Delete a rule
   */
  app.delete('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = ruleIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid rule ID');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Only owners can delete rules
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can delete rules');
    }

    // Check rule exists and get server info
    const ruleRows = await db
      .select({
        id: rules.id,
        conditions: rules.conditions,
        serverUserId: rules.serverUserId,
        serverId: serverUsers.serverId,
      })
      .from(rules)
      .leftJoin(serverUsers, eq(rules.serverUserId, serverUsers.id))
      .where(eq(rules.id, id))
      .limit(1);

    const existingRule = ruleRows[0];
    if (!existingRule) {
      return reply.notFound('Rule not found');
    }

    // Check access for user-specific rules
    if (
      existingRule.serverUserId &&
      existingRule.serverId &&
      !hasServerAccess(authUser, existingRule.serverId)
    ) {
      return reply.forbidden('You do not have access to this rule');
    }

    const wasInactivityRule = hasInactivityCondition(existingRule.conditions);
    const wasTrafficRule = hasTrafficCondition(existingRule.conditions);

    // Delete rule (cascade will handle violations)
    await db.delete(rules).where(eq(rules.id, id));

    // Reschedule inactivity checks if this was an inactivity rule
    if (wasInactivityRule) {
      void scheduleInactivityChecks();
    }
    if (wasTrafficRule) {
      void scheduleTrafficChecks();
    }

    return { success: true };
  });

  /**
   * PATCH /bulk - Bulk enable/disable rules
   * Owner-only. Accepts array of rule IDs and isActive flag.
   */
  app.patch('/bulk', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can update rules
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only owners can update rules');
    }

    const parsed = bulkUpdateRulesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest('Invalid request body');
    }
    const { ids, isActive } = parsed.data;

    // Get all requested rules with server info
    const ruleDetails = await db
      .select({
        id: rules.id,
        serverUserId: rules.serverUserId,
        serverId: serverUsers.serverId,
      })
      .from(rules)
      .leftJoin(serverUsers, eq(rules.serverUserId, serverUsers.id))
      .where(inArray(rules.id, ids));

    // Filter to only accessible rules
    // Global rules (serverUserId = null) are accessible to all owners
    // User-specific rules require server access
    const accessibleIds = ruleDetails
      .filter((r) => {
        if (!r.serverUserId) return true; // Global rule
        if (!r.serverId) return false;
        return hasServerAccess(authUser, r.serverId);
      })
      .map((r) => r.id);

    if (accessibleIds.length === 0) {
      return { success: true, updated: 0 };
    }

    // Bulk update isActive
    await db
      .update(rules)
      .set({
        isActive,
        updatedAt: new Date(),
      })
      .where(inArray(rules.id, accessibleIds));

    return { success: true, updated: accessibleIds.length };
  });

  /**
   * DELETE /bulk - Bulk delete rules
   * Owner-only. Accepts array of rule IDs.
   */
  app.delete('/bulk', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can delete rules
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only owners can delete rules');
    }

    const parsed = bulkDeleteRulesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest('Invalid request body');
    }
    const { ids: deleteIds } = parsed.data;

    // Get all requested rules with server info
    const ruleDetails = await db
      .select({
        id: rules.id,
        serverUserId: rules.serverUserId,
        serverId: serverUsers.serverId,
      })
      .from(rules)
      .leftJoin(serverUsers, eq(rules.serverUserId, serverUsers.id))
      .where(inArray(rules.id, deleteIds));

    // Filter to only accessible rules
    const accessibleIds = ruleDetails
      .filter((r) => {
        if (!r.serverUserId) return true; // Global rule
        if (!r.serverId) return false;
        return hasServerAccess(authUser, r.serverId);
      })
      .map((r) => r.id);

    if (accessibleIds.length === 0) {
      return { success: true, deleted: 0 };
    }

    // Bulk delete (cascade will handle violations)
    await db.delete(rules).where(inArray(rules.id, accessibleIds));

    return { success: true, deleted: accessibleIds.length };
  });

  /**
   * GET /rules/migrate/preview - Preview migration of legacy rules to V2 format
   * Shows what the migration would do without making changes.
   */
  app.get('/migrate/preview', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can migrate rules
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can migrate rules');
    }

    // Get all legacy rules that need migration
    const legacyRules = await db
      .select({
        id: rules.id,
        name: rules.name,
        type: rules.type,
        params: rules.params,
        serverId: rules.serverId,
        serverUserId: rules.serverUserId,
        isActive: rules.isActive,
      })
      .from(rules)
      .where(
        and(
          isNotNull(rules.type),
          isNotNull(rules.params),
          or(isNull(rules.conditions), isNull(rules.actions))
        )
      );

    // Filter by server access
    const rulesWithAccess = await Promise.all(
      legacyRules.map(async (rule) => {
        if (!rule.serverId && !rule.serverUserId) return rule;
        if (rule.serverId && hasServerAccess(authUser, rule.serverId)) return rule;
        if (rule.serverUserId) {
          const serverUser = await db
            .select({ serverId: serverUsers.serverId })
            .from(serverUsers)
            .where(eq(serverUsers.id, rule.serverUserId))
            .limit(1);
          if (serverUser[0] && hasServerAccess(authUser, serverUser[0].serverId)) return rule;
        }
        return null;
      })
    );

    const accessibleRules = rulesWithAccess.filter((r): r is NonNullable<typeof r> => r !== null);

    // Preview migration
    const result = migrateRules(
      accessibleRules.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type!,
        params: r.params as Record<string, unknown>,
        serverUserId: r.serverUserId,
        serverId: r.serverId,
        isActive: r.isActive,
      })) as LegacyRule[]
    );

    return {
      totalLegacyRules: accessibleRules.length,
      canMigrate: result.migrated.length,
      willFail: result.errors.length,
      preview: result.migrated.map((m) => ({
        id: m.id,
        conditions: m.conditions,
        actions: m.actions,
      })),
      errors: result.errors,
    };
  });

  /**
   * POST /rules/migrate - Migrate legacy rules to V2 format
   * Converts all accessible legacy rules to V2 format.
   */
  app.post('/migrate', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can migrate rules
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can migrate rules');
    }

    const parsed = bulkMigrateRulesSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.badRequest('Invalid request body');
    }
    const specificIds = parsed.data.ids;

    // Build WHERE conditions for legacy rules
    const baseCondition = and(
      isNotNull(rules.type),
      isNotNull(rules.params),
      or(isNull(rules.conditions), isNull(rules.actions))
    );

    // Get legacy rules that need migration
    const legacyRules = await db
      .select({
        id: rules.id,
        name: rules.name,
        type: rules.type,
        params: rules.params,
        serverId: rules.serverId,
        serverUserId: rules.serverUserId,
        isActive: rules.isActive,
      })
      .from(rules)
      .where(specificIds ? and(baseCondition, inArray(rules.id, specificIds)) : baseCondition);

    // Filter by server access
    const rulesWithAccess = await Promise.all(
      legacyRules.map(async (rule) => {
        if (!rule.serverId && !rule.serverUserId) return rule;
        if (rule.serverId && hasServerAccess(authUser, rule.serverId)) return rule;
        if (rule.serverUserId) {
          const serverUser = await db
            .select({ serverId: serverUsers.serverId })
            .from(serverUsers)
            .where(eq(serverUsers.id, rule.serverUserId))
            .limit(1);
          if (serverUser[0] && hasServerAccess(authUser, serverUser[0].serverId)) return rule;
        }
        return null;
      })
    );

    const accessibleRules = rulesWithAccess.filter((r): r is NonNullable<typeof r> => r !== null);

    // Perform migration
    const result = migrateRules(
      accessibleRules.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type!,
        params: r.params as Record<string, unknown>,
        serverUserId: r.serverUserId,
        serverId: r.serverId,
        isActive: r.isActive,
      })) as LegacyRule[]
    );

    // Update migrated rules in database within a transaction
    const updatedCount = await db.transaction(async (tx) => {
      let count = 0;
      for (const migrated of result.migrated) {
        await tx
          .update(rules)
          .set({
            severity: migrated.severity,
            conditions: migrated.conditions,
            actions: migrated.actions,
            updatedAt: new Date(),
          })
          .where(eq(rules.id, migrated.id));
        count++;
      }
      return count;
    });

    return {
      success: true,
      migrated: updatedCount,
      skipped: result.errors.length,
      errors: result.errors,
    };
  });

  /**
   * POST /rules/:id/migrate - Migrate a single legacy rule to V2 format
   */
  app.post('/:id/migrate', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = ruleIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid rule ID');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Only owners can migrate rules
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can migrate rules');
    }

    // Get the rule
    const ruleRows = await db
      .select({
        id: rules.id,
        name: rules.name,
        type: rules.type,
        params: rules.params,
        conditions: rules.conditions,
        actions: rules.actions,
        serverId: rules.serverId,
        serverUserId: rules.serverUserId,
        isActive: rules.isActive,
      })
      .from(rules)
      .where(eq(rules.id, id))
      .limit(1);

    const rule = ruleRows[0];
    if (!rule) {
      return reply.notFound('Rule not found');
    }

    // Check access
    if (rule.serverId && !hasServerAccess(authUser, rule.serverId)) {
      return reply.forbidden('You do not have access to this rule');
    }
    if (rule.serverUserId) {
      const serverUser = await db
        .select({ serverId: serverUsers.serverId })
        .from(serverUsers)
        .where(eq(serverUsers.id, rule.serverUserId))
        .limit(1);
      if (serverUser[0] && !hasServerAccess(authUser, serverUser[0].serverId)) {
        return reply.forbidden('You do not have access to this rule');
      }
    }

    // Check if migration is needed
    if (!needsMigration(rule)) {
      return reply.badRequest(
        'Rule does not need migration (already has V2 fields or no legacy fields)'
      );
    }

    // Convert rule
    const migrated = convertLegacyRule({
      id: rule.id,
      name: rule.name,
      type: rule.type!,
      params: rule.params as Record<string, unknown>,
      serverUserId: rule.serverUserId,
      serverId: rule.serverId,
      isActive: rule.isActive,
    } as LegacyRule);

    if (!migrated) {
      return reply.badRequest(`Cannot migrate rule: unknown type ${rule.type}`);
    }

    // Update rule in database
    const updated = await db
      .update(rules)
      .set({
        severity: migrated.severity,
        conditions: migrated.conditions,
        actions: migrated.actions,
        updatedAt: new Date(),
      })
      .where(eq(rules.id, id))
      .returning();

    return updated[0];
  });
};
