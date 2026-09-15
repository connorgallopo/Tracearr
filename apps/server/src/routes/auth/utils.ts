import { db } from '../../db/client.js';
import { servers } from '../../db/schema.js';

/**
 * Get all server IDs for owner tokens
 */
export async function getAllServerIds(): Promise<string[]> {
  const allServers = await db.select({ id: servers.id }).from(servers);
  return allServers.map((s) => s.id);
}
