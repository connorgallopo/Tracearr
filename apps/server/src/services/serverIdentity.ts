/**
 * Backfills `servers.machine_identifier`, which item deep links need. Only the
 * Plex OAuth and plugin paths ever wrote it, so manually added servers of every
 * type have it null. The value comes from a live call, so no SQL backfill.
 */

import { eq, isNull, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { createMediaServerClient } from './mediaServer/index.js';
import { invalidateServersCache } from '../jobs/poller/database.js';
import type { ServerType } from '@tracearr/shared';

interface IdentifiableServer {
  id: string;
  type: ServerType;
  url: string;
  token: string;
  machineIdentifier: string | null;
}

/** The identifier the server at this address reports for itself, or null when it reports none. */
export async function readServerIdentity(
  server: Omit<IdentifiableServer, 'machineIdentifier'>
): Promise<string | null> {
  const client = createMediaServerClient({
    type: server.type,
    url: server.url,
    token: server.token,
    id: server.id,
  });
  return client.getServerIdentity ? client.getServerIdentity() : null;
}

/**
 * Fetches and stores the identifier when missing. Never throws: a server that
 * is unreachable keeps a null identifier and gets retried on the next pass.
 *
 * @returns the identifier now on the row, or null when it could not be read
 */
export async function ensureServerIdentifier(
  server: IdentifiableServer,
  log?: { debug: (obj: unknown, msg: string) => void }
): Promise<string | null> {
  if (server.machineIdentifier) return server.machineIdentifier;

  try {
    const identity = await readServerIdentity(server);
    if (!identity) return null;

    await db
      .update(servers)
      .set({ machineIdentifier: identity, updatedAt: new Date() })
      .where(and(eq(servers.id, server.id), isNull(servers.machineIdentifier)));
    invalidateServersCache();
    return identity;
  } catch (error) {
    log?.debug({ err: error, serverId: server.id }, 'Could not read server identity');
    return null;
  }
}

/** Sweeps every server still missing an identifier. */
export async function backfillMissingServerIdentifiers(log?: {
  debug: (obj: unknown, msg: string) => void;
}): Promise<number> {
  const rows = await db
    .select({
      id: servers.id,
      type: servers.type,
      url: servers.url,
      token: servers.token,
      machineIdentifier: servers.machineIdentifier,
    })
    .from(servers)
    .where(isNull(servers.machineIdentifier));

  let filled = 0;
  for (const row of rows) {
    if (await ensureServerIdentifier(row, log)) filled += 1;
  }
  return filled;
}
