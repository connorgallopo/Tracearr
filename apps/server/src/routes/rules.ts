/**
 * Rule management routes - CRUD for sharing detection rules
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { createRuleSchema, updateRuleSchema, ruleIdParamSchema } from '@tracearr/shared';
import { db } from '../db/client.js';
import { rules, serverUsers, violations, servers } from '../db/schema.js';
import { hasServerAccess } from '../utils/serverFiltering.js';

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
        type: rules.type,
        params: rules.params,
        serverUserId: rules.serverUserId,
        username: serverUsers.username,
        serverId: serverUsers.serverId,
        serverName: servers.name,
        isActive: rules.isActive,
        createdAt: rules.createdAt,
        updatedAt: rules.updatedAt,
      })
      .from(rules)
      .leftJoin(serverUsers, eq(rules.serverUserId, serverUsers.id))
      .leftJoin(servers, eq(serverUsers.serverId, servers.id))
      .orderBy(rules.name);

    // Filter rules by server access
    // Global rules (serverUserId = null) are visible to all
    // User-specific rules require server access
    const filteredRules = ruleList.filter((rule) => {
      // Global rule - visible to everyone
      if (!rule.serverUserId) return true;
      // User-specific rule - check server access
      if (!rule.serverId) return false; // Shouldn't happen, but defensive
      return hasServerAccess(authUser, rule.serverId);
    });

    return { data: filteredRules };
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
        type: rules.type,
        params: rules.params,
        serverUserId: rules.serverUserId,
        username: serverUsers.username,
        serverId: serverUsers.serverId,
        serverName: servers.name,
        isActive: rules.isActive,
        createdAt: rules.createdAt,
        updatedAt: rules.updatedAt,
      })
      .from(rules)
      .leftJoin(serverUsers, eq(rules.serverUserId, serverUsers.id))
      .leftJoin(servers, eq(serverUsers.serverId, servers.id))
      .where(eq(rules.id, id))
      .limit(1);

    const rule = ruleRows[0];
    if (!rule) {
      return reply.notFound('Rule not found');
    }

    // Check access for user-specific rules
    if (rule.serverUserId && rule.serverId && !hasServerAccess(authUser, rule.serverId)) {
      return reply.forbidden('You do not have access to this rule');
    }

    // Get violation count for this rule
    const violationCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(violations)
      .where(eq(violations.ruleId, id));

    return {
      ...rule,
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

    // Delete rule (cascade will handle violations)
    await db.delete(rules).where(eq(rules.id, id));

    return { success: true };
  });
};
