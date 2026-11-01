import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';

/**
 * Whether this server should run catalog sync and the poster precache that
 * follows it. Missing row or pre-migration payloads keep the previous
 * always-on behavior.
 */
export async function isLibrarySyncEnabled(serverId: string): Promise<boolean> {
  const [row] = await db
    .select({ librarySyncEnabled: servers.librarySyncEnabled })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  return row?.librarySyncEnabled !== false;
}
