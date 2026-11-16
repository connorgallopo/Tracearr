/**
 * The reads behind every automation payload: one joined select, the names it
 * carries, and the reference checks a write runs first. No Fastify in here, so
 * both the automation and the template routes can answer in the same shape.
 */

import { and, eq, getTableColumns, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  type Automation,
  type AutomationOrigin,
  type AutomationScopeRef,
  type AutomationTemplateRef,
  type AuthUser,
  type TriggerNode,
  type UpdateAutomationInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { automationTemplates, automations, serverUsers, servers, users } from '../../db/schema.js';
import { buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { matchesTrigger } from './events/evaluate.js';
import { type TemplateSource } from './templates/store.js';
import { type AutomationRow } from './versions.js';

// The account scope names a server too, and a detached row names the template it left.
const accountServers = alias(servers, 'account_servers');
const originTemplates = alias(automationTemplates, 'origin_templates');

/** The names a row needs to render; a write path that skips the joins renders nulls. */
interface AutomationJoins {
  serverName: string | null;
  accountName: string | null;
  accountServerId: string | null;
  accountServerName: string | null;
  personName: string | null;
  templateSlug: string | null;
  templateName: string | null;
  templateCurrentVersion: number | null;
  templateSource: TemplateSource | null;
  templateAuthor: string | null;
  templateAddedAt: Date | null;
  originName: string | null;
}

export type AutomationDetailRow = AutomationRow & Partial<AutomationJoins>;

const automationColumns = {
  ...getTableColumns(automations),
  serverName: servers.name,
  accountName: serverUsers.username,
  accountServerId: accountServers.id,
  accountServerName: accountServers.name,
  personName: sql<string | null>`coalesce(${users.name}, ${users.username})`,
  templateSlug: automationTemplates.slug,
  templateName: automationTemplates.name,
  templateCurrentVersion: automationTemplates.currentVersion,
  templateSource: automationTemplates.source,
  templateAuthor: automationTemplates.author,
  templateAddedAt: automationTemplates.createdAt,
  originName: originTemplates.name,
};

/** One row per automation: every scope is at most one join deep and each name is unique. */
export const automationSelect = () =>
  db
    .select(automationColumns)
    .from(automations)
    .leftJoin(servers, eq(servers.id, automations.serverId))
    .leftJoin(serverUsers, eq(serverUsers.id, automations.serverUserId))
    .leftJoin(accountServers, eq(accountServers.id, serverUsers.serverId))
    .leftJoin(users, eq(users.id, automations.userId))
    .leftJoin(automationTemplates, eq(automationTemplates.id, automations.templateId))
    .leftJoin(originTemplates, eq(originTemplates.id, automations.originTemplateId));

/** A global automation belongs to everyone; a scoped one needs the server it names. */
export function visibleAutomations(authUser: AuthUser): SQL | undefined {
  if (authUser.role === 'owner') return undefined;

  const global = and(
    isNull(automations.serverId),
    isNull(automations.serverUserId),
    isNull(automations.userId)
  );
  if (authUser.serverIds.length === 0) return global;

  const reachable = buildMultiServerFragment(authUser.serverIds, 'su.server_id');
  return or(
    global,
    inArray(automations.serverId, authUser.serverIds),
    sql`EXISTS (SELECT 1 FROM server_users su WHERE su.id = ${automations.serverUserId} ${reachable})`,
    sql`EXISTS (SELECT 1 FROM server_users su WHERE su.user_id = ${automations.userId} ${reachable})`
  );
}

export async function loadAutomation(
  id: string,
  authUser: AuthUser
): Promise<AutomationDetailRow | undefined> {
  const rows = await automationSelect()
    .where(and(eq(automations.id, id), visibleAutomations(authUser)))
    .limit(1);
  return rows[0];
}

function scopeRefOf(row: AutomationDetailRow): AutomationScopeRef | null {
  if (row.serverId && row.serverName) {
    return { kind: 'server', id: row.serverId, name: row.serverName };
  }
  if (row.serverUserId && row.accountName) {
    return {
      kind: 'account',
      id: row.serverUserId,
      name: row.accountName,
      serverId: row.accountServerId ?? undefined,
      serverName: row.accountServerName ?? undefined,
    };
  }
  if (row.userId && row.personName) {
    return { kind: 'person', id: row.userId, name: row.personName };
  }
  return null;
}

function templateRefOf(row: AutomationDetailRow): AutomationTemplateRef | null {
  const { templateId, templateSlug, templateName, templateSource } = row;
  if (!templateId || !templateSlug || !templateName || !templateSource) return null;
  if (typeof row.templateVersion !== 'number') return null;
  if (typeof row.templateCurrentVersion !== 'number') return null;
  if (!row.templateAddedAt) return null;
  return {
    id: templateId,
    slug: templateSlug,
    name: templateName,
    version: row.templateVersion,
    currentVersion: row.templateCurrentVersion,
    source: templateSource,
    author: row.templateAuthor ?? null,
    addedAt: row.templateAddedAt.toISOString(),
  };
}

/** A detached row keeps its provenance even after the template it came from is deleted. */
function originOf(row: AutomationDetailRow): AutomationOrigin | null {
  if (!row.originTemplateId || row.originTemplateVersion === null) return null;
  return {
    templateId: row.originTemplateId,
    version: row.originTemplateVersion,
    name: row.originName ?? null,
  };
}

export function toAutomation(row: AutomationDetailRow): Automation {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    severity: row.severity,
    triggers: row.triggers ?? [],
    conditions: row.conditions ?? { groups: [] },
    actions: row.actions ?? { actions: [] },
    serverId: row.serverId,
    serverUserId: row.serverUserId,
    userId: row.userId,
    enforceAcrossServers: row.enforceAcrossServers,
    isActive: row.isActive,
    cooldownMinutes: row.cooldownMinutes,
    retentionDays: row.retentionDays,
    scopeRef: scopeRefOf(row),
    template: templateRefOf(row),
    templateInputs: row.templateInputs,
    origin: originOf(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The sweep runs for whatever carries the inactivity trigger; conditions no longer route it. */
export function needsInactivitySweep(row: { triggers: TriggerNode[] | null }): boolean {
  return matchesTrigger({ triggers: row.triggers ?? [] }, 'account.inactive_for');
}

type ScopeRefs = Pick<UpdateAutomationInput, 'serverId' | 'serverUserId' | 'userId'>;

/** The first scope reference the payload names that no row backs. */
export async function missingScopeRef(scope: ScopeRefs): Promise<string | null> {
  if (scope.serverId) {
    const rows = await db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.id, scope.serverId))
      .limit(1);
    if (!rows[0]) return 'Server not found';
  }
  if (scope.serverUserId) {
    const rows = await db
      .select({ id: serverUsers.id })
      .from(serverUsers)
      .where(eq(serverUsers.id, scope.serverUserId))
      .limit(1);
    if (!rows[0]) return 'Server user not found';
  }
  if (scope.userId) {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, scope.userId))
      .limit(1);
    if (!rows[0]) return 'User not found';
  }
  return null;
}
