/**
 * No session can predate its server row except through an import, so
 * `servers.created_at` is the boundary between tracked and imported
 * history. The Tautulli importer uses it to skip plays Tracearr already
 * recorded, the duplicate-cleanup job as the server-wide dedup boundary, and
 * the imported-history linking job to leave imports from tracked time unlinked.
 * The Jellystat and Playback Reporting importers read `createdAt` from the
 * server row they already load.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { servers } from '../../db/schema.js';

/**
 * The earliest moment this server could have tracked a session.
 *
 * @param serverId - The server to look up
 * @returns The server's `created_at`, or `null` if the server row is gone
 */
export async function getServerTrackingStart(serverId: string): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: servers.createdAt })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  return row?.createdAt ?? null;
}
