import { eq } from 'drizzle-orm';
import type {
  ActiveSession,
  EngineAutomation,
  Server,
  ServerUser,
  Session,
} from '@tracearr/shared';
import { db } from '../../../db/client.js';
import { servers, serverUsers, users } from '../../../db/schema.js';
import { personNameColumn } from '../../../utils/representativeAccount.js';
import {
  batchGetRecentUserSessions,
  maxWindowHoursFromAutomations,
  mergeRecentSessionsForIdentity,
} from '../../../jobs/poller/database.js';
import { mapSessionRow } from '../../../jobs/poller/sessionMapper.js';
import { excludeUncountableSessions } from '../../../jobs/poller/utils.js';
import { automationsLogger } from '../../../utils/logger.js';
import { getIdentityServerUserIds } from '../../userService.js';
import type {
  EvaluationInputs,
  EvaluationServer,
  EvaluationServerUser,
  SessionRow,
} from './types.js';

export interface ContextAssemblyDeps {
  getAllActiveSessions: () => Promise<ActiveSession[]>;
  gracePeriodSessionIds: () => Set<string>;
}

let deps: ContextAssemblyDeps | null = null;

/** Wired by initializePoller: the active-session cache and the poller's grace map are producer state. */
export function setContextAssemblyDeps(next: ContextAssemblyDeps): void {
  deps = next;
}

/**
 * The session list a rule evaluates against. Excludes stoppedTwinId (the quality-change twin
 * stopped earlier in the same operation but still in the caller's cache snapshot) and appends
 * triggeringSession unless a session with that id is already there.
 */
export function buildRuleContextSessions(
  activeSessions: Session[],
  triggeringSession: Session,
  stoppedTwinId: string | null | undefined
): Session[] {
  const countableSessions = stoppedTwinId
    ? activeSessions.filter((s) => s.id !== stoppedTwinId)
    : activeSessions;
  return countableSessions.some((s) => s.id === triggeringSession.id)
    ? countableSessions
    : [...countableSessions, triggeringSession];
}

export function toRuleServer(server: EvaluationServer): Server {
  return {
    id: server.id,
    name: server.name,
    type: server.type,
    url: '',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function toRuleServerUser(serverUser: EvaluationServerUser, serverId: string): ServerUser {
  return {
    id: serverUser.id,
    userId: serverUser.userId,
    serverId,
    externalId: '',
    username: serverUser.username,
    email: null,
    thumbUrl: serverUser.thumbUrl,
    isServerAdmin: false,
    trustScore: serverUser.trustScore,
    joinedAt: null,
    lastActivityAt: serverUser.lastActivityAt,
    createdAt: serverUser.createdAt,
    removedAt: null,
    updatedAt: new Date(),
    identityName: serverUser.identityName,
  };
}

/** One Session builder for every trigger: the stored row plus whatever the fresh payload overrides. */
export function toRuleSession(row: SessionRow, live?: Partial<Session>): Session {
  return { ...mapSessionRow(row), ...live };
}

/** The eight-column server-user shape the rule pipeline reads, by server-user id. */
export async function loadEvaluationServerUser(
  serverUserId: string
): Promise<Omit<EvaluationServerUser, 'identityServerUserIds'> | null> {
  const [su] = await db
    .select({
      id: serverUsers.id,
      userId: serverUsers.userId,
      username: serverUsers.username,
      thumbUrl: serverUsers.thumbUrl,
      identityName: personNameColumn(),
      trustScore: serverUsers.trustScore,
      lastActivityAt: serverUsers.lastActivityAt,
      createdAt: serverUsers.createdAt,
    })
    .from(serverUsers)
    .innerJoin(users, eq(serverUsers.userId, users.id))
    .where(eq(serverUsers.id, serverUserId))
    .limit(1);
  return su ?? null;
}

/**
 * Refs plus inputs for producers that hold only ids (SSE updates, wakes); the poller
 * already has the rows. `known` skips the server read for a caller that just did it.
 */
export async function loadEvaluationContext(
  serverId: string,
  serverUserId: string,
  rules: EngineAutomation[],
  known?: EvaluationServer
): Promise<{
  server: EvaluationServer;
  serverUser: EvaluationServerUser;
  inputs: EvaluationInputs;
} | null> {
  const su = await loadEvaluationServerUser(serverUserId);
  if (!su) return null;
  const server = known ?? (await readEvaluationServer(serverId));
  if (!server) return null;
  const serverUser: EvaluationServerUser = { ...su, identityServerUserIds: [] };
  const inputs = await assembleEvaluationInputs({ rules, server, serverUser });
  serverUser.identityServerUserIds = inputs.identityServerUserIds ?? [];
  return { server, serverUser, inputs };
}

/** The three columns every trigger context names a server by; null when the row is gone. */
async function readEvaluationServer(serverId: string): Promise<EvaluationServer | null> {
  const [srv] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  return srv ? { id: srv.id, name: srv.name, type: srv.type } : null;
}

/** The server row plus the inputs its triggers evaluate in; null when the row is already gone. */
export async function loadServerContext(
  serverId: string,
  rules: EngineAutomation[]
): Promise<{ server: EvaluationServer; inputs: EvaluationInputs } | null> {
  const server = await readEvaluationServer(serverId);
  if (!server) return null;
  return serverContextFor(server, rules);
}

/** For the producers that already hold the row (the poller tick, the plugin checker). */
export async function serverContextFor(
  server: EvaluationServer,
  rules: EngineAutomation[]
): Promise<{ server: EvaluationServer; inputs: EvaluationInputs }> {
  return { server, inputs: await assembleServerInputs({ rules, server }) };
}

/** The install context has no server and no account: the automations and nothing else. */
export function installInputs(rules: EngineAutomation[]): EvaluationInputs {
  return {
    activeAutomations: rules,
    activeSessions: [],
    recentSessions: [],
    identityServerUserIds: [],
  };
}

/**
 * The SSE processor and the wake scheduler have no tick; this builds the inputs the poller
 * carries per tick. Failed identity/recent lookups degrade to this server_user only.
 */
export async function assembleEvaluationInputs(args: {
  rules: EngineAutomation[];
  server: EvaluationServer;
  serverUser: EvaluationServerUser;
}): Promise<EvaluationInputs> {
  const { rules, serverUser } = args;
  if (rules.length === 0) {
    return {
      activeAutomations: rules,
      activeSessions: [],
      recentSessions: [],
      identityServerUserIds: serverUser.identityServerUserIds,
    };
  }
  if (!deps) throw new Error('setContextAssemblyDeps has not been called');

  const activeSessions = excludeUncountableSessions(
    await deps.getAllActiveSessions(),
    deps.gracePeriodSessionIds()
  );

  let identityServerUserIds: string[];
  try {
    identityServerUserIds = await getIdentityServerUserIds(serverUser.userId);
  } catch (error) {
    automationsLogger.error(
      'Failed to resolve identity server users, evaluating this server only',
      {
        serverUserId: serverUser.id,
        error,
      }
    );
    identityServerUserIds = [serverUser.id];
  }

  const recentSessions = await fetchRecentSessionsForIdentity(
    serverUser.id,
    identityServerUserIds,
    maxWindowHoursFromAutomations(rules)
  );

  return { activeAutomations: rules, activeSessions, recentSessions, identityServerUserIds };
}

/**
 * The inputs a server or install trigger evaluates in: no account, so no identity
 * and no history. The active sessions ride along even though nothing at server
 * context can read them, so a later trigger context needs no second builder.
 */
export async function assembleServerInputs(args: {
  rules: EngineAutomation[];
  server: EvaluationServer;
}): Promise<EvaluationInputs> {
  const { rules, server } = args;
  if (rules.length === 0) return installInputs(rules);
  if (!deps) throw new Error('setContextAssemblyDeps has not been called');

  const activeSessions = excludeUncountableSessions(
    await deps.getAllActiveSessions(),
    deps.gracePeriodSessionIds()
  );
  return {
    activeAutomations: rules,
    activeSessions: activeSessions.filter((session) => session.serverId === server.id),
    recentSessions: [],
    identityServerUserIds: [],
  };
}

/** History for windowed rules across every server_user of the identity; a failed wide read falls back to this server alone. */
export async function fetchRecentSessionsForIdentity(
  serverUserId: string,
  identityServerUserIds: string[],
  windowHours?: number
): Promise<Session[]> {
  const ids = identityServerUserIds.length > 1 ? identityServerUserIds : [serverUserId];
  try {
    const recentMap = await batchGetRecentUserSessions(ids, windowHours);
    return mergeRecentSessionsForIdentity(recentMap, ids);
  } catch (error) {
    automationsLogger.error('Failed to fetch recent sessions, falling back to this server only', {
      serverUserId,
      error,
    });
    const fallback = await batchGetRecentUserSessions([serverUserId], windowHours);
    return fallback.get(serverUserId) ?? [];
  }
}
