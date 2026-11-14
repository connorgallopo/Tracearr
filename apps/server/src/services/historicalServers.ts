/**
 * Marking a server historical and resuming it. Both run their side effects in
 * a fixed order so the route stays an owner check plus a row read.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { REDIS_KEYS, WS_EVENTS } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, sessions } from '../db/schema.js';
import { dropHeldImport } from '../jobs/importQueue.js';
import { rebuildAutoSyncSchedules } from '../jobs/librarySyncQueue.js';
import { publishServersChanged } from '../jobs/poller/database.js';
import { forceStopSessions } from '../jobs/poller/index.js';
import { clearServerDownState } from '../jobs/sseProcessor.js';
import { createLogger } from '../utils/logger.js';
import { getCacheService, getPubSubService } from './cache.js';
import { sseManager } from './sseManager.js';
import type { ServerRow } from './liveServers.js';

const logger = createLogger('HistoricalServers');

/** The queue may not be up (boot, Redis outage); the switch must not fail on it. */
async function rescheduleSyncs(): Promise<void> {
  try {
    await rebuildAutoSyncSchedules();
  } catch (error) {
    logger.warn('Library auto-sync reschedule failed', { error });
  }
}

/**
 * SSE pending sessions exist only in Redis and outlive the dropped connection
 * for up to the orphan threshold, so the switch ends them itself.
 */
async function clearPendingSessions(serverId: string): Promise<void> {
  const cache = getCacheService();
  if (!cache) return;

  let removed = false;
  for (const key of await cache.getAllPendingSessionKeys()) {
    if (key.serverId !== serverId) continue;
    const pending = await cache.getPendingSession(serverId, key.sessionKey);
    await cache.deletePendingSession(serverId, key.sessionKey);
    if (!pending) continue;
    await cache.removeActiveSession(pending.id, { skipDashboardInvalidation: true });
    await getPubSubService()?.publish('session:stopped', pending.id);
    removed = true;
  }
  if (removed) await cache.invalidateDashboardStatsCache();
}

export async function markServerHistorical(server: ServerRow): Promise<ServerRow> {
  if (server.historicalAt) return server;

  const [updated] = await db
    .update(servers)
    .set({ historicalAt: new Date(), updatedAt: new Date() })
    .where(eq(servers.id, server.id))
    .returning();
  if (!updated) throw new Error(`Server ${server.id} vanished while being marked historical`);

  await publishServersChanged();

  const active = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.serverId, server.id), isNull(sessions.stoppedAt)));
  await forceStopSessions(active);
  await clearPendingSessions(server.id);

  await sseManager.refresh();
  await rescheduleSyncs();
  // A held import would run against a server that no longer answers
  await dropHeldImport(server.id).catch((error: unknown) => {
    logger.warn('Dropping the held history import failed', { error });
  });

  const cache = getCacheService();
  if (cache) {
    await cache.invalidateCache(REDIS_KEYS.SERVER_HEALTH(server.id));
    await cache.resetServerFailCount(server.id);
    await cache.invalidateCache(REDIS_KEYS.SERVER_CONNECTION(server.id));
  }
  clearServerDownState(server.id);

  // Straight to the browsers' banner; dispatchServerHealth* would also run automations.
  await getPubSubService()?.publish(WS_EVENTS.SERVER_UP, {
    serverId: server.id,
    serverName: server.name,
  });

  return updated;
}

export async function resumeServer(server: ServerRow): Promise<ServerRow> {
  if (!server.historicalAt) return server;

  const [updated] = await db
    .update(servers)
    .set({ historicalAt: null, updatedAt: new Date() })
    .where(eq(servers.id, server.id))
    .returning();
  if (!updated) throw new Error(`Server ${server.id} vanished while being resumed`);

  clearServerDownState(server.id);
  await publishServersChanged();
  await sseManager.refresh();
  await rescheduleSyncs();
  return updated;
}
