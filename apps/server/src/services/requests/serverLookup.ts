import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { servers } from '../../db/schema.js';

export async function findServerByMachineId(
  machineId: string
): Promise<{ id: string; type: 'plex' | 'jellyfin' | 'emby' } | null> {
  const rows = await db
    .select({ id: servers.id, type: servers.type })
    .from(servers)
    .where(eq(servers.machineIdentifier, machineId))
    .limit(1);
  const row = rows[0];
  return row && row.type !== 'dispatcharr' ? { id: row.id, type: row.type } : null;
}

export async function serverTypeById(id: string): Promise<'plex' | 'jellyfin' | 'emby' | null> {
  const rows = await db
    .select({ type: servers.type })
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);
  const type = rows[0]?.type;
  return type && type !== 'dispatcharr' ? type : null;
}

export async function findServerById(
  id: string
): Promise<{ id: string; name: string; machineIdentifier: string | null } | null> {
  const rows = await db
    .select({
      id: servers.id,
      name: servers.name,
      machineIdentifier: servers.machineIdentifier,
      type: servers.type,
    })
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);
  const row = rows[0];
  return row && row.type !== 'dispatcharr' ? row : null;
}
