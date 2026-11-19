/**
 * Fills server_profiles from the profiles plays name and from each account's profile list
 * in the user sync.
 */

import { and, eq, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { serverProfiles } from '../db/schema.js';
import { NOT_NEEDED, type IMediaServerClient } from './mediaServer/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('profiles');

/** A profile as a play names it, under the account that played */
export interface ProfileSighting {
  externalId: string;
  serverUserId: string;
  name: string;
}

type SightingMode = 'refresh' | 'insertMissing';

const ON_CONFLICT: Record<SightingMode, SQL> = {
  refresh: sql`DO UPDATE SET name = excluded.name, removed_at = NULL, updated_at = now()
    WHERE server_profiles.name IS DISTINCT FROM excluded.name
      OR server_profiles.removed_at IS NOT NULL`,
  insertMissing: sql`DO NOTHING`,
};

// A profile stays on its stored account, so every poll would repeat the warning.
const warnedProfileIds = new Set<string>();

/**
 * The server_profiles id of each sighted profile, by the server's profile id, inserting the
 * ones not stored yet. Live plays `refresh` the name and clear a removal; plays from the
 * past only `insertMissing`, so an old name never overwrites the current one.
 */
export async function resolveProfiles(
  serverId: string,
  sightings: ProfileSighting[],
  mode: SightingMode
): Promise<Map<string, string>> {
  const sightingOf = new Map(sightings.map((sighting) => [sighting.externalId, sighting]));
  if (sightingOf.size === 0) return new Map();

  const incoming = sql.join(
    [...sightingOf.values()].map(
      (sighting) => sql`(${sighting.externalId}, ${sighting.serverUserId}::uuid, ${sighting.name})`
    ),
    sql`, `
  );
  // A conflict the update skips returns no row from the insert, so stored rows it left alone
  // are read back from the statement's snapshot.
  const { rows } = await db.execute<{ id: string; external_id: string; server_user_id: string }>(
    sql`
      WITH incoming (external_id, server_user_id, name) AS (VALUES ${incoming}),
      written AS (
        INSERT INTO server_profiles (server_id, server_user_id, external_id, name)
        SELECT ${serverId}::uuid, server_user_id, external_id, name FROM incoming
        ON CONFLICT (server_id, external_id) ${ON_CONFLICT[mode]}
        RETURNING id, external_id, server_user_id
      )
      SELECT id, external_id, server_user_id FROM written
      UNION ALL
      SELECT p.id, p.external_id, p.server_user_id
      FROM server_profiles p
      JOIN incoming i ON i.external_id = p.external_id
      WHERE p.server_id = ${serverId}
        AND NOT EXISTS (SELECT 1 FROM written w WHERE w.external_id = p.external_id)
    `
  );

  for (const row of rows) {
    const seenUnder = sightingOf.get(row.external_id)?.serverUserId;
    if (seenUnder === row.server_user_id || warnedProfileIds.has(row.id)) continue;
    warnedProfileIds.add(row.id);
    log.warn('Profile played under another account; it stays linked to its stored account', {
      profileId: row.id,
      storedServerUserId: row.server_user_id,
      playedServerUserId: seenUnder,
    });
  }
  return new Map(rows.map((row) => [row.external_id, row.id]));
}

/**
 * Saves each account's profile list as the server reports it, and marks removed the profiles
 * an account no longer lists. An account whose list could not be read or saved keeps the
 * profiles it had, and the other accounts still sync.
 */
export async function syncAccountProfiles(
  serverId: string,
  client: IMediaServerClient,
  accounts: { serverUserId: string; externalId: string }[]
): Promise<void> {
  for (const account of accounts) {
    try {
      const profiles = await client.getAccountProfiles(account.externalId);
      if (profiles === NOT_NEEDED) continue;
      await db.transaction(async (tx) => {
        if (profiles.length > 0) {
          await tx
            .insert(serverProfiles)
            .values(
              profiles.map((profile) => ({
                serverId,
                serverUserId: account.serverUserId,
                externalId: profile.id,
                name: profile.name,
                thumbUrl: profile.thumb,
                isPrimary: profile.isPrimary,
                isChild: profile.isChild,
              }))
            )
            .onConflictDoUpdate({
              target: [serverProfiles.serverId, serverProfiles.externalId],
              set: {
                name: sql`excluded.name`,
                thumbUrl: sql`excluded.thumb_url`,
                isPrimary: sql`excluded.is_primary`,
                isChild: sql`excluded.is_child`,
                removedAt: null,
                updatedAt: new Date(),
              },
              setWhere: sql`
                ${serverProfiles.name} IS DISTINCT FROM excluded.name OR
                ${serverProfiles.thumbUrl} IS DISTINCT FROM excluded.thumb_url OR
                ${serverProfiles.isPrimary} IS DISTINCT FROM excluded.is_primary OR
                ${serverProfiles.isChild} IS DISTINCT FROM excluded.is_child OR
                ${serverProfiles.removedAt} IS NOT NULL`,
            });
        }
        await tx
          .update(serverProfiles)
          .set({ removedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(serverProfiles.serverUserId, account.serverUserId),
              isNull(serverProfiles.removedAt),
              notInArray(
                serverProfiles.externalId,
                profiles.map((profile) => profile.id)
              )
            )
          );
      });
    } catch (err) {
      log.warn('Profile sync failed for an account; it keeps the profiles it had', {
        serverUserId: account.serverUserId,
        error: err,
      });
    }
  }
}
