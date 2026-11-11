import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  REQUEST_SERVICE_BUILT_IN,
  REQUEST_SERVICE_TYPES,
  SERVER_PROFILES,
  WS_EVENTS,
  type RequestService,
  type RequestServiceType,
  type ServerType,
} from '@tracearr/shared';
import { db, type Executor } from '../../db/client.js';
import { mediaRequests, requestServices } from '../../db/schema.js';
import { createLogger } from '../../utils/logger.js';
import { getCacheService, getPubSubService } from '../cache.js';
import { decryptConfig, encryptConfig } from '../notifications/destinationCrypto.js';

const logger = createLogger('request-services');

export type RequestServiceRow = typeof requestServices.$inferSelect;
export type MediaRequestRow = typeof mediaRequests.$inferSelect;

const LINKED_TYPES = REQUEST_SERVICE_TYPES.filter((type) => !REQUEST_SERVICE_BUILT_IN[type]);
const BUILT_IN_TYPES = REQUEST_SERVICE_TYPES.filter((type) => REQUEST_SERVICE_BUILT_IN[type]);

export async function publishRequestsChanged(serviceId: string): Promise<void> {
  await getCacheService()
    ?.invalidatePattern(`${REDIS_KEYS.REQUESTS_ANALYTICS}:*`)
    .catch((error: unknown) => {
      logger.warn('requests analytics cache invalidation failed', { error });
    });
  await getPubSubService()
    ?.publish(WS_EVENTS.REQUESTS_CHANGED, { serviceId })
    .catch((error: unknown) => {
      logger.warn('requests:changed publish failed', { error });
    });
}

export async function listRequestServices(): Promise<RequestServiceRow[]> {
  return db.select().from(requestServices).orderBy(requestServices.createdAt, requestServices.id);
}

/** Whether any service takes requests: a linked one, or a server's own with its requests on */
export async function anyRequestServiceLinked(): Promise<boolean> {
  const rows = await db
    .select({ id: requestServices.id })
    .from(requestServices)
    .where(eq(requestServices.takesRequests, true))
    .limit(1);
  return rows.length > 0;
}

export async function getRequestService(id: string): Promise<RequestServiceRow | null> {
  const rows = await db.select().from(requestServices).where(eq(requestServices.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getRequestServiceByServer(
  serverId: string
): Promise<RequestServiceRow | null> {
  const rows = await db
    .select()
    .from(requestServices)
    .where(eq(requestServices.serverId, serverId))
    .limit(1);
  return rows[0] ?? null;
}

export function readApiKey(row: RequestServiceRow): { ok: true; apiKey: string } | { ok: false } {
  if (!row.config) return { ok: false };
  const opened = decryptConfig(row.config);
  if (!opened.ok) return { ok: false };
  const apiKey = opened.config.apiKey;
  return typeof apiKey === 'string' && apiKey !== '' ? { ok: true, apiKey } : { ok: false };
}

export async function createRequestService(input: {
  serverId: string;
  type: RequestServiceType;
  name: string;
  url: string;
  apiKey: string;
  remoteServerId: string;
  version: string | null;
}): Promise<RequestServiceRow> {
  const [row] = await db
    .insert(requestServices)
    .values({
      serverId: input.serverId,
      type: input.type,
      name: input.name,
      url: input.url,
      config: encryptConfig({ apiKey: input.apiKey }),
      remoteServerId: input.remoteServerId,
      version: input.version,
    })
    .returning();
  if (!row) throw new Error('insert returned no row');
  await publishRequestsChanged(row.id);
  return row;
}

/**
 * Gives each server of these types that has requests built in its request service, named and
 * addressed as the server, unless it has one. Returns the ids of the services created.
 */
export async function addBuiltInRequestServices(
  executor: Executor,
  serverTypes: readonly ServerType[]
): Promise<string[]> {
  const created: string[] = [];
  for (const serverType of serverTypes) {
    const type = SERVER_PROFILES[serverType].builtInRequests;
    if (type === null) continue;
    const result = await executor.execute(sql`
      INSERT INTO request_services (server_id, type, name, url)
      SELECT id, ${type}, name, url FROM servers WHERE type = ${serverType}
      ON CONFLICT (server_id) DO NOTHING
      RETURNING id
    `);
    created.push(...(result.rows as { id: string }[]).map((row) => row.id));
  }
  return created;
}

/** Copies the server's name and address onto its built-in request service, if it has one. */
export async function followServerOnBuiltInRequestService(
  executor: Executor,
  serverId: string
): Promise<void> {
  await executor.execute(sql`
    UPDATE request_services SET name = servers.name, url = servers.url, updated_at = now()
    FROM servers
    WHERE servers.id = ${serverId} AND request_services.server_id = servers.id
      AND request_services.type = ANY(${sql.param(BUILT_IN_TYPES)}::text[])
  `);
}

export async function updateRequestService(
  id: string,
  patch: {
    name?: string;
    url?: string;
    apiKey?: string;
    enabled?: boolean;
    remoteServerId?: string;
    version?: string | null;
  }
): Promise<RequestServiceRow | null> {
  const set: Partial<typeof requestServices.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.remoteServerId !== undefined) set.remoteServerId = patch.remoteServerId;
  if (patch.version !== undefined) set.version = patch.version;
  if (patch.apiKey !== undefined) {
    set.config = encryptConfig({ apiKey: patch.apiKey });
    set.configStatus = 'ok';
  }
  const [row] = await db
    .update(requestServices)
    .set(set)
    .where(eq(requestServices.id, id))
    .returning();
  if (!row) return null;
  await publishRequestsChanged(row.id);
  return row;
}

/** A built-in service is left alone: it goes when its server does. */
export async function deleteRequestService(id: string): Promise<boolean> {
  const deleted = await db
    .delete(requestServices)
    .where(and(eq(requestServices.id, id), inArray(requestServices.type, LINKED_TYPES)))
    .returning({ id: requestServices.id });
  if (deleted.length === 0) return false;
  await publishRequestsChanged(id);
  return true;
}

export async function markRequestServiceReencrypt(id: string): Promise<void> {
  await db
    .update(requestServices)
    .set({ configStatus: 'reencrypt', updatedAt: new Date() })
    .where(eq(requestServices.id, id));
  await publishRequestsChanged(id);
}

export async function recordSyncResult(
  id: string,
  patch: {
    version?: string;
    syncCursor?: Date | null;
    lastCounts?: RequestServiceRow['lastCounts'];
    lastSyncAt?: Date;
    lastFullSyncAt?: Date;
    lastSyncError: string | null;
    takesRequests?: boolean;
  }
): Promise<void> {
  await db
    .update(requestServices)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(requestServices.id, id));
}

export interface MirroredRequest {
  titled: boolean;
  postered: boolean;
}

/**
 * What the mirror holds for each of a service's requests, by remote id. A stored title or
 * poster needs no lookup: the upsert keeps the stored one.
 */
export async function mirroredRequests(serviceId: string): Promise<Map<string, MirroredRequest>> {
  const rows = await db
    .select({
      remoteId: mediaRequests.remoteId,
      titled: sql<boolean>`${mediaRequests.title} IS NOT NULL`,
      postered: sql<boolean>`${mediaRequests.posterPath} IS NOT NULL`,
    })
    .from(mediaRequests)
    .where(eq(mediaRequests.serviceId, serviceId));
  return new Map(rows.map(({ remoteId, ...stored }) => [remoteId, stored]));
}

export async function requestCountsByService(): Promise<Map<string, RequestService['counts']>> {
  const rows = await db
    .select({
      serviceId: mediaRequests.serviceId,
      requests: sql<number>`count(*)::int`,
      unmatchedMedia: sql<number>`count(*) filter (where ${mediaRequests.mediaId} is null)::int`,
      unmatchedUsers: sql<number>`count(*) filter (where ${mediaRequests.serverUserId} is null)::int`,
    })
    .from(mediaRequests)
    .where(isNull(mediaRequests.deletedAt))
    .groupBy(mediaRequests.serviceId);
  return new Map(
    rows.map((r) => [
      r.serviceId,
      { requests: r.requests, unmatchedMedia: r.unmatchedMedia, unmatchedUsers: r.unmatchedUsers },
    ])
  );
}

export function toPublicRequestService(
  row: RequestServiceRow,
  counts: RequestService['counts']
): RequestService {
  return {
    id: row.id,
    serverId: row.serverId,
    type: row.type,
    name: row.name,
    url: row.url,
    enabled: row.enabled,
    configStatus: row.configStatus,
    remoteServerId: row.remoteServerId,
    version: row.version,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastFullSyncAt: row.lastFullSyncAt?.toISOString() ?? null,
    lastSyncError: row.lastSyncError,
    counts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const EMPTY_COUNTS: RequestService['counts'] = {
  requests: 0,
  unmatchedMedia: 0,
  unmatchedUsers: 0,
};
