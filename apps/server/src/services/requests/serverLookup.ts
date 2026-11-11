import { and, eq } from 'drizzle-orm';
import type { ServerType } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { servers } from '../../db/schema.js';
import { liveServerCondition } from '../liveServers.js';

export async function findServerByMachineId(
  machineId: string
): Promise<{ id: string; type: ServerType } | null> {
  const rows = await db
    .select({ id: servers.id, type: servers.type })
    .from(servers)
    .where(eq(servers.machineIdentifier, machineId))
    .limit(1);
  return rows[0] ?? null;
}

export async function serverTypeById(id: string): Promise<ServerType | null> {
  const rows = await db
    .select({ type: servers.type })
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);
  return rows[0]?.type ?? null;
}

export async function findServerById(
  id: string
): Promise<{ id: string; name: string; machineIdentifier: string | null } | null> {
  const rows = await db
    .select({ id: servers.id, name: servers.name, machineIdentifier: servers.machineIdentifier })
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** The address and key of a server Tracearr still monitors; null once it is removed or historical */
export async function liveServerConnection(
  id: string
): Promise<{ url: string; token: string } | null> {
  const rows = await db
    .select({ url: servers.url, token: servers.token })
    .from(servers)
    .where(and(eq(servers.id, id), liveServerCondition))
    .limit(1);
  return rows[0] ?? null;
}
