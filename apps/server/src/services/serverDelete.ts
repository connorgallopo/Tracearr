import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { dropHeldImport } from '../jobs/importQueue.js';
import { publishServersChanged } from '../jobs/poller/database.js';
import { createLogger } from '../utils/logger.js';
import { sseManager } from './sseManager.js';

const log = createLogger('servers');

/** The cascade removes everything the server held; the poller and its live connection let go of it. */
export async function deleteServer(serverId: string): Promise<void> {
  await db.delete(servers).where(eq(servers.id, serverId));
  await publishServersChanged();
  await dropHeldImport(serverId).catch((error: unknown) => {
    log.error('Dropping the held history import failed after server delete', {
      err: error,
      serverId,
    });
  });
  sseManager.refresh().catch((error: unknown) => {
    log.error('SSE refresh failed after server delete', { err: error, serverId });
  });
}
