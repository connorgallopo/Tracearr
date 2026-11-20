/**
 * Every write to server_profiles: the profiles plays name, each account's profile list from the
 * user sync, and the move a merge makes. Also how stored profiles show on plays and in the
 * profile filters, and whether a scope has a server with profiles at all.
 */

import { and, eq, inArray, isNotNull, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import {
  someServerHasProfiles,
  type NonMainProfile,
  type ProfileFilterOption,
  type Session,
} from '@tracearr/shared';
import { db, type Executor } from '../db/client.js';
import { serverProfiles, servers, serverUsers } from '../db/schema.js';
import {
  getServerTypes,
  getServerUserIdsByExternalId,
  onServersCacheInvalidated,
} from '../jobs/poller/database.js';
import { NOT_NEEDED, type IMediaServerClient, type MediaProfile } from './mediaServer/types.js';
import { compareNames } from '../utils/collation.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('profiles');

/** A profile as a play names it, under the account that played */
interface ProfileSighting {
  externalId: string;
  serverUserId: string;
  name: string;
}

/** The server's ids for the account and profile a play names, and the profile's name */
export interface ProfileNaming {
  accountExternalId: string;
  profileExternalId?: string | null;
  profileName?: string | null;
}

type SightingMode = 'refresh' | 'insertMissing' | 'insertRemoved';

const WRITE_BY_MODE: Record<SightingMode, { removedAt: SQL; onConflict: SQL }> = {
  refresh: {
    removedAt: sql`NULL`,
    onConflict: sql`DO UPDATE SET name = excluded.name, removed_at = NULL, updated_at = now()
      WHERE server_profiles.name IS DISTINCT FROM excluded.name
        OR server_profiles.removed_at IS NOT NULL`,
  },
  insertMissing: { removedAt: sql`NULL`, onConflict: sql`DO NOTHING` },
  insertRemoved: { removedAt: sql`now()`, onConflict: sql`DO NOTHING` },
};

type StoredProfileRow = {
  id: string;
  external_id: string;
  server_user_id: string;
  name: string;
  thumb_url: string | null;
  is_primary: boolean | null;
  removed: boolean;
};

/** A sighted profile's stored row, and how screens show it */
export interface ResolvedProfile {
  id: string;
  nonMainProfile?: NonMainProfile;
}

/** A profile as a live poll last wrote it, with the account the poll saw it under and its name */
interface PolledProfile extends ResolvedProfile {
  serverUserId: string;
  name: string;
}

// Per server, by the server's profile id. A sighting that matches its entry sends no statement,
// so an entry is only ever a row a refresh returned, and a server's entries are forgotten
// whenever its profiles are written other than by a live poll.
const livePolledProfiles = new Map<string, Map<string, PolledProfile>>();

// A profile stays on its stored account, so every poll would repeat the warning.
const warnedProfileIds = new Set<string>();

/** Forget what live polls wrote, for one server or for all, after any other write to its profiles */
export function forgetPolledProfiles(serverId?: string): void {
  if (serverId === undefined) livePolledProfiles.clear();
  else livePolledProfiles.delete(serverId);
}

export function registerProfileCacheInvalidation(): void {
  // A deleted server takes its profiles with it, and a restore replaces every profile row
  onServersCacheInvalidated(() => forgetPolledProfiles());
}

// A profile the server says nothing about counts as its account's main one
export function isMainProfile(isPrimary: boolean | null): boolean {
  return isPrimary !== false;
}

/** The profile as screens show it; nothing for a main profile, which shows as its account */
function nonMainProfileOf(profile: {
  name: string;
  thumbUrl: string | null;
  isPrimary: boolean | null;
  removed: boolean;
}): NonMainProfile | undefined {
  return isMainProfile(profile.isPrimary)
    ? undefined
    : { name: profile.name, thumbUrl: profile.thumbUrl, removed: profile.removed };
}

// Code unit order, the order of COLLATE "C" for these ids, so it matches lockProfilesInOrder
function byExternalId(a: { externalId: string }, b: { externalId: string }): number {
  return a.externalId < b.externalId ? -1 : Number(a.externalId > b.externalId);
}

/**
 * Locks the stored profiles a transaction is about to write, in the order resolveProfiles writes
 * them, so a poll and that transaction never wait on each other in a cycle over stored profiles.
 */
async function lockProfilesInOrder(tx: Executor, where: SQL): Promise<void> {
  await tx
    .select({ id: serverProfiles.id })
    .from(serverProfiles)
    .where(where)
    .orderBy(sql`${serverProfiles.externalId} COLLATE "C"`)
    .for('update');
}

/** The profile each play names, under its account, for the plays whose account Tracearr knows */
export function profileSightings(
  plays: ProfileNaming[],
  serverUserIdOf: (accountExternalId: string) => string | undefined
): ProfileSighting[] {
  return plays.flatMap((play) => {
    const serverUserId = serverUserIdOf(play.accountExternalId);
    return play.profileExternalId && play.profileName && serverUserId
      ? [{ externalId: play.profileExternalId, serverUserId, name: play.profileName }]
      : [];
  });
}

/** The server_profiles id of the profile a play names, from what resolveProfiles returned */
export function profileIdOf(
  profiles: ReadonlyMap<string, ResolvedProfile>,
  profileExternalId: string | null | undefined
): string | null {
  return profileExternalId ? (profiles.get(profileExternalId)?.id ?? null) : null;
}

/**
 * The stored row of each sighted profile, by the server's profile id, inserting the ones not
 * stored yet. Live plays `refresh` the name and clear a removal; plays from the
 * past only `insertMissing`, so an old name never overwrites the current one. A profile only
 * the past names, after the user sync stored every profile the server lists, is one the server
 * no longer has: `insertRemoved` stores it marked removed. A live sighting a live poll already
 * wrote under the same account and name sends no statement.
 */
export async function resolveProfiles(
  serverId: string,
  sightings: ProfileSighting[],
  mode: SightingMode
): Promise<Map<string, ResolvedProfile>> {
  if (sightings.length === 0) return new Map();
  const polled =
    mode === 'refresh'
      ? (livePolledProfiles.get(serverId) ?? new Map<string, PolledProfile>())
      : undefined;
  if (polled) livePolledProfiles.set(serverId, polled);
  const resolved = new Map<string, ResolvedProfile>();
  const toWrite: ProfileSighting[] = [];
  for (const sighting of new Map(sightings.map((seen) => [seen.externalId, seen])).values()) {
    const profile = polled?.get(sighting.externalId);
    if (profile?.serverUserId === sighting.serverUserId && profile.name === sighting.name) {
      resolved.set(sighting.externalId, { id: profile.id, nonMainProfile: profile.nonMainProfile });
    } else {
      toWrite.push(sighting);
    }
  }
  if (toWrite.length === 0) return resolved;

  const incoming = sql.join(
    toWrite
      .toSorted(byExternalId)
      .map(
        (sighting) =>
          sql`(${sighting.externalId}, ${sighting.serverUserId}::uuid, ${sighting.name})`
      ),
    sql`, `
  );
  // A conflict the update skips returns no row from the insert, so stored rows it left alone
  // are read back from the statement's snapshot.
  const { rows } = await db.execute<StoredProfileRow>(
    sql`
      WITH incoming (external_id, server_user_id, name) AS (VALUES ${incoming}),
      written AS (
        INSERT INTO server_profiles (server_id, server_user_id, external_id, name, removed_at)
        SELECT ${serverId}::uuid, server_user_id, external_id, name, ${WRITE_BY_MODE[mode].removedAt}
        FROM incoming
        ON CONFLICT (server_id, external_id) ${WRITE_BY_MODE[mode].onConflict}
        RETURNING id, external_id, server_user_id, name, thumb_url, is_primary,
          removed_at IS NOT NULL AS removed
      )
      SELECT id, external_id, server_user_id, name, thumb_url, is_primary, removed FROM written
      UNION ALL
      SELECT p.id, p.external_id, p.server_user_id, p.name, p.thumb_url, p.is_primary,
        p.removed_at IS NOT NULL
      FROM server_profiles p
      JOIN incoming i ON i.external_id = p.external_id
      WHERE p.server_id = ${serverId}
        AND NOT EXISTS (SELECT 1 FROM written w WHERE w.external_id = p.external_id)
    `
  );
  const rowOf = new Map(rows.map((row) => [row.external_id, row]));

  // A profile another transaction committed while the statement ran conflicts without being in
  // the statement's snapshot, so only a new statement can read it.
  const unread = toWrite.filter((sighting) => !rowOf.has(sighting.externalId));
  if (unread.length > 0) {
    const { rows: committed } = await db.execute<StoredProfileRow>(sql`
      SELECT id, external_id, server_user_id, name, thumb_url, is_primary,
        removed_at IS NOT NULL AS removed
      FROM server_profiles
      WHERE server_id = ${serverId}
        AND external_id = ANY(${sql.param(unread.map((sighting) => sighting.externalId))}::text[])
    `);
    for (const row of committed) rowOf.set(row.external_id, row);
  }

  for (const sighting of toWrite) {
    const row = rowOf.get(sighting.externalId);
    if (!row) continue;
    const profile = {
      id: row.id,
      nonMainProfile: nonMainProfileOf({
        name: row.name,
        thumbUrl: row.thumb_url,
        isPrimary: row.is_primary,
        removed: row.removed,
      }),
    };
    resolved.set(sighting.externalId, profile);
    // Every row a refresh returns is stored under that name and not removed
    polled?.set(sighting.externalId, {
      ...profile,
      serverUserId: sighting.serverUserId,
      name: row.name,
    });
    if (row.server_user_id === sighting.serverUserId || warnedProfileIds.has(row.id)) continue;
    warnedProfileIds.add(row.id);
    log.warn('Profile played under another account; it stays linked to its stored account', {
      profileId: row.id,
      storedServerUserId: row.server_user_id,
      playedServerUserId: sighting.serverUserId,
    });
  }
  return resolved;
}

/**
 * Saves the profile lists of the accounts the server reports, and marks removed the profiles no
 * list names any more. An account's lists are its own and those of the external ids a
 * same-server merge folded into it, and an account the user sync marked removed lists nothing.
 * An account with a list that could not be read keeps the profiles it had, and the other
 * accounts still sync. True when every list was read and saved.
 */
export async function syncAccountProfiles(
  serverId: string,
  client: IMediaServerClient,
  reportedExternalIds: string[]
): Promise<boolean> {
  const accountOf = await getServerUserIdsByExternalId(serverId, reportedExternalIds);

  const listed = new Map<string, MediaProfile[]>();
  let everyListRead = true;
  for (const [serverUserId, accounts] of Map.groupBy(accountOf, ([, account]) => account)) {
    try {
      const profiles: MediaProfile[] = [];
      for (const [externalId] of accounts) {
        const list = await client.getAccountProfiles(externalId);
        if (list === NOT_NEEDED) return false;
        profiles.push(...list);
      }
      listed.set(serverUserId, profiles);
    } catch (err) {
      everyListRead = false;
      log.warn('Profile list unread for an account; it keeps the profiles it had', {
        serverUserId,
        error: err,
      });
    }
  }
  const reported = new Set(accountOf.values());
  const removedAccounts = await db
    .select({ id: serverUsers.id })
    .from(serverUsers)
    .where(and(eq(serverUsers.serverId, serverId), isNotNull(serverUsers.removedAt)));
  for (const account of removedAccounts) {
    if (!reported.has(account.id)) listed.set(account.id, []);
  }
  if (listed.size === 0) return everyListRead;

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
    forgetPolledProfiles(serverId);
    return everyListRead;
  } catch (err) {
    log.warn('Profile sync failed; every account keeps the profiles it had', {
      serverId,
      error: err,
    });
    return false;
  }
}

export async function moveProfilesToAccount(
  tx: Executor,
  sourceServerUserId: string,
  targetServerUserId: string
): Promise<void> {
  await lockProfilesInOrder(tx, eq(serverProfiles.serverUserId, sourceServerUserId));
  await tx
    .update(serverProfiles)
    .set({ serverUserId: targetServerUserId, updatedAt: new Date() })
    .where(eq(serverProfiles.serverUserId, sourceServerUserId));
}

/** By server_profiles id: each profile's current name, and how screens show it */
export type CurrentProfiles = ReadonlyMap<
  string,
  { name: string; nonMainProfile?: NonMainProfile }
>;

/** The profiles the ids name, read by primary key, with no query when every id is null */
export async function readCurrentProfiles(
  executor: Executor,
  profileIds: (string | null)[]
): Promise<CurrentProfiles> {
  const ids = [...new Set(profileIds.filter((id) => id != null))];
  if (ids.length === 0) return new Map();
  const rows = await executor
    .select({
      id: serverProfiles.id,
      name: serverProfiles.name,
      thumbUrl: serverProfiles.thumbUrl,
      isPrimary: serverProfiles.isPrimary,
      removedAt: serverProfiles.removedAt,
    })
    .from(serverProfiles)
    .where(sql`${serverProfiles.id} = ANY(${sql.param(ids)}::uuid[])`);
  return new Map(
    rows.map((row) => [
      row.id,
      {
        name: row.name,
        nonMainProfile: nonMainProfileOf({ ...row, removed: row.removedAt !== null }),
      },
    ])
  );
}

/** The profile a play shows: its profile's current name, else the name the play stored */
export function shownProfile(
  profiles: CurrentProfiles,
  profileId: string | null,
  storedName: string | null
): Pick<Session, 'profileId' | 'profileName' | 'nonMainProfile'> {
  const profile = profileId === null ? undefined : profiles.get(profileId);
  return profile
    ? { profileId, profileName: profile.name, nonMainProfile: profile.nonMainProfile }
    : { profileId: null, profileName: storedName };
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
      accountUsername: serverUsers.username,
      serverName: servers.name,
      isPrimary: serverProfiles.isPrimary,
      removed: sql<boolean>`${serverProfiles.removedAt} IS NOT NULL`,
    })
    .from(serverProfiles)
    .innerJoin(serverUsers, eq(serverUsers.id, serverProfiles.serverUserId))
    .innerJoin(servers, eq(servers.id, serverProfiles.serverId))
    .where(where);
  return rows
    .map(({ isPrimary, ...option }) => ({ ...option, main: isMainProfile(isPrimary) }))
    .sort((a, b) => compareNames(a.name, b.name) || a.id.localeCompare(b.id));
}

/** Whether any of the servers, or any server at all when none are named, keeps profiles */
export async function serversHaveProfiles(serverIds: string[] | undefined): Promise<boolean> {
  const typeOf = await getServerTypes(serverIds);
  return someServerHasProfiles(
    serverIds ? serverIds.flatMap((serverId) => typeOf.get(serverId) ?? []) : [...typeOf.values()]
  );
}
