/**
 * Server profile factory for test data generation
 *
 * Creates server_profiles: the profiles one server account plays under.
 */

import { executeRawSql } from '../db/pool.js';
import { quote } from '../db/sql.js';

export interface ServerProfileData {
  id?: string;
  serverId: string;
  serverUserId: string;
  externalId?: string;
  name?: string;
  thumbUrl?: string | null;
  isPrimary?: boolean | null;
  removedAt?: Date | null;
}

export interface CreatedServerProfile {
  id: string;
  serverId: string;
  serverUserId: string;
  externalId: string;
  name: string;
  thumbUrl: string | null;
  isPrimary: boolean | null;
  removedAt: Date | null;
}

let serverProfileCounter = 0;

/** Generate unique server profile data with defaults */
export function buildServerProfile(overrides: ServerProfileData): Required<ServerProfileData> {
  const index = ++serverProfileCounter;
  return {
    id: overrides.id ?? crypto.randomUUID(),
    serverId: overrides.serverId,
    serverUserId: overrides.serverUserId,
    externalId: overrides.externalId ?? crypto.randomUUID(),
    name: overrides.name ?? `Profile ${index}`,
    thumbUrl: overrides.thumbUrl ?? null,
    isPrimary: overrides.isPrimary ?? null,
    removedAt: overrides.removedAt ?? null,
  };
}

/** Create a server profile in the database */
export async function createTestServerProfile(
  data: ServerProfileData
): Promise<CreatedServerProfile> {
  const full = buildServerProfile(data);

  const result = await executeRawSql(`
    INSERT INTO server_profiles (
      id, server_id, server_user_id, external_id, name, thumb_url, is_primary, removed_at
    )
    VALUES (
      ${quote(full.id)},
      ${quote(full.serverId)},
      ${quote(full.serverUserId)},
      ${quote(full.externalId)},
      ${quote(full.name)},
      ${quote(full.thumbUrl)},
      ${full.isPrimary ?? 'NULL'},
      ${quote(full.removedAt?.toISOString() ?? null)}
    )
    RETURNING *
  `);

  return mapServerProfileRow(result.rows[0]);
}

/** Map database row to a typed server profile */
function mapServerProfileRow(row: Record<string, unknown>): CreatedServerProfile {
  return {
    id: row.id as string,
    serverId: row.server_id as string,
    serverUserId: row.server_user_id as string,
    externalId: row.external_id as string,
    name: row.name as string,
    thumbUrl: row.thumb_url as string | null,
    isPrimary: row.is_primary as boolean | null,
    removedAt: row.removed_at as Date | null,
  };
}

/** Reset server profile counter */
export function resetServerProfileCounter(): void {
  serverProfileCounter = 0;
}
