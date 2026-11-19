/**
 * Fills server_profiles from the profiles plays name and from each account's profile list
 * in the user sync, and lists them for the profile filters.
 */

import { and, eq, inArray, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import type { ProfileFilterOption } from '@tracearr/shared';
import { db, type Executor } from '../db/client.js';
import { serverProfiles } from '../db/schema.js';
import { getServerUserIdsByExternalId } from '../jobs/poller/database.js';
import { NOT_NEEDED, type IMediaServerClient, type MediaProfile } from './mediaServer/types.js';
import { compareNames } from '../utils/collation.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('profiles');

/** A profile as a play names it, under the account that played */
export interface ProfileSighting {
  externalId: string;
  serverUserId: string;
  name: string;
}

/** A row from a server that names its account by the server's user id, as tofa's history and downloads do */
interface ProfileNamingRow {
  user_id: string;
  profile_id?: string | null;
  profile_name?: string | null;
}

type SightingMode = 'refresh' | 'insertMissing' | 'insertRemoved';

const WRITE: Record<SightingMode, { removedAt: SQL; onConflict: SQL }> = {
  refresh: {
    removedAt: sql`NULL`,
    onConflict: sql`DO UPDATE SET name = excluded.name, removed_at = NULL, updated_at = now()
      WHERE server_profiles.name IS DISTINCT FROM excluded.name
        OR server_profiles.removed_at IS NOT NULL`,
  },
  insertMissing: { removedAt: sql`NULL`, onConflict: sql`DO NOTHING` },
  insertRemoved: { removedAt: sql`now()`, onConflict: sql`DO NOTHING` },
};

// A profile stays on its stored account, so every poll would repeat the warning.
const warnedProfileIds = new Set<string>();

// Code unit order, the order of COLLATE "C" for these ids, so it matches lockProfilesInOrder
function byExternalId(a: { externalId: string }, b: { externalId: string }): number {
  return a.externalId < b.externalId ? -1 : Number(a.externalId > b.externalId);
}

/**
 * Locks the stored profiles a transaction is about to write, in the order resolveProfiles writes
 * them, so a poll and that transaction never wait on each other in a cycle over stored profiles.
 */
export async function lockProfilesInOrder(tx: Executor, where: SQL): Promise<void> {
  await tx
    .select({ id: serverProfiles.id })
    .from(serverProfiles)
    .where(where)
    .orderBy(sql`${serverProfiles.externalId} COLLATE "C"`)
    .for('update');
}

/** The profile each row names, under its account, for the rows whose account Tracearr knows */
export function profileSightings(
  rows: ProfileNamingRow[],
  accountOf: ReadonlyMap<string, string>
): ProfileSighting[] {
  return rows.flatMap((row) => {
    const serverUserId = accountOf.get(row.user_id);
    return row.profile_id && row.profile_name && serverUserId
      ? [{ externalId: row.profile_id, serverUserId, name: row.profile_name }]
      : [];
  });
}

/** The server_profiles id of the profile a row names, from what resolveProfiles returned */
export function profileIdOf(
  profileIds: ReadonlyMap<string, string>,
  row: Pick<ProfileNamingRow, 'profile_id'>
): string | null {
  return row.profile_id ? (profileIds.get(row.profile_id) ?? null) : null;
}

/**
 * The server_profiles id of each sighted profile, by the server's profile id, inserting the
 * ones not stored yet. Live plays `refresh` the name and clear a removal; plays from the
 * past only `insertMissing`, so an old name never overwrites the current one. A profile only
 * the past names, after the user sync stored every profile the server lists, is one the server
 * no longer has: `insertRemoved` stores it marked removed.
 */
export async function resolveProfiles(
  serverId: string,
  sightings: ProfileSighting[],
  mode: SightingMode
): Promise<Map<string, string>> {
  const sightingOf = new Map(sightings.map((sighting) => [sighting.externalId, sighting]));
  if (sightingOf.size === 0) return new Map();

  const incoming = sql.join(
    [...sightingOf.values()]
      .toSorted(byExternalId)
      .map(
        (sighting) =>
          sql`(${sighting.externalId}, ${sighting.serverUserId}::uuid, ${sighting.name})`
      ),
    sql`, `
  );
  // A conflict the update skips returns no row from the insert, so stored rows it left alone
  // are read back from the statement's snapshot.
  const { rows } = await db.execute<{ id: string; external_id: string; server_user_id: string }>(
    sql`
      WITH incoming (external_id, server_user_id, name) AS (VALUES ${incoming}),
      written AS (
        INSERT INTO server_profiles (server_id, server_user_id, external_id, name, removed_at)
        SELECT ${serverId}::uuid, server_user_id, external_id, name, ${WRITE[mode].removedAt}
        FROM incoming
        ON CONFLICT (server_id, external_id) ${WRITE[mode].onConflict}
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
 * Saves the profile lists of the accounts the server reports, and marks removed the profiles no
 * list names any more. An account's lists are its own and those of the external ids a
 * same-server merge folded into it. An account with a list that could not be read keeps the
 * profiles it had, and the other accounts still sync.
 */
export async function syncAccountProfiles(
  serverId: string,
  client: IMediaServerClient,
  reportedExternalIds: string[]
): Promise<void> {
  const accountOf = await getServerUserIdsByExternalId(serverId, reportedExternalIds);

  const listed = new Map<string, MediaProfile[]>();
  for (const [serverUserId, accounts] of Map.groupBy(accountOf, ([, account]) => account)) {
    try {
      const profiles: MediaProfile[] = [];
      for (const [externalId] of accounts) {
        const list = await client.getAccountProfiles(externalId);
        if (list === NOT_NEEDED) return;
        profiles.push(...list);
      }
      listed.set(serverUserId, profiles);
    } catch (err) {
      log.warn('Profile list unread for an account; it keeps the profiles it had', {
        serverUserId,
        error: err,
      });
    }
  }
  if (listed.size === 0) return;

  const rows = new Map<string, typeof serverProfiles.$inferInsert>();
  for (const [serverUserId, profiles] of listed) {
    for (const profile of profiles) {
      rows.set(profile.id, {
        serverId,
        serverUserId,
        externalId: profile.id,
        name: profile.name,
        thumbUrl: profile.thumb,
        isPrimary: profile.isPrimary,
        isChild: profile.isChild,
      });
    }
  }

  try {
    await db.transaction(async (tx) => {
      await lockProfilesInOrder(tx, eq(serverProfiles.serverId, serverId));
      if (rows.size > 0) {
        await tx
          .insert(serverProfiles)
          .values([...rows.values()].toSorted(byExternalId))
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
      // Every list counts, not only the account's own: a profile stored under one account and
      // listed under another is still on the server.
      await tx
        .update(serverProfiles)
        .set({ removedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(serverProfiles.serverId, serverId),
            inArray(serverProfiles.serverUserId, [...listed.keys()]),
            isNull(serverProfiles.removedAt),
            notInArray(serverProfiles.externalId, [...rows.keys()])
          )
        );
    });
  } catch (err) {
    log.warn('Profile sync failed; every account keeps the profiles it had', {
      serverId,
      error: err,
    });
  }
}

/** The profiles `where` selects, removed ones included, in name order */
export async function profileOptions(
  executor: Executor,
  where: SQL | undefined
): Promise<ProfileFilterOption[]> {
  const rows = await executor
    .select({
      id: serverProfiles.id,
      name: serverProfiles.name,
      serverUserId: serverProfiles.serverUserId,
      removed: sql<boolean>`${serverProfiles.removedAt} IS NOT NULL`,
    })
    .from(serverProfiles)
    .where(where);
  return rows.sort((a, b) => compareNames(a.name, b.name) || a.id.localeCompare(b.id));
}
