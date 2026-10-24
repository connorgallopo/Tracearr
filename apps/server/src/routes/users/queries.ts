/** Shared User Query Functions **/

import type { UserDevice, AuthUser, UserLocation, MediaDownloadRow } from '@tracearr/shared';
import { sql, eq, and, between, desc, inArray, count, type SQL } from 'drizzle-orm';
import type { db as defaultDb } from '../../db/client.js';
import {
  automations,
  mediaDownloads,
  servers,
  serverUsers,
  sessions,
  terminationLogs,
  users,
} from '../../db/schema.js';
import { listDownloadRows } from '../../services/downloads/queries.js';
import { buildServerAccessCondition, hasServerAccess } from '../../utils/serverFiltering.js';
import { uuidArraySql } from '../../utils/sqlArrays.js';
import { localSessionSql } from '../../utils/localSession.js';
import { assertInScope, type Scope } from '../../lib/scope.js';

// Accept either the default db or a transaction context
type DbOrTx = typeof defaultDb;

/**
 * All server_user ids belonging to a person's identity that the caller can
 * access. Always scoped by the caller's accessible servers (owners see every
 * sibling account, everyone else only their own accessible servers) so an
 * identity-wide query can never surface accounts on servers the caller
 * doesn't have access to.
 */
export async function resolveAccessibleServerUserIdsForIdentity(
  dbOrTx: DbOrTx,
  authUser: AuthUser,
  identityUserId: string
): Promise<string[]> {
  return resolveAccessibleServerUserIdsForIdentities(dbOrTx, authUser, [identityUserId]);
}

/**
 * Batched version of resolveAccessibleServerUserIdsForIdentity - the union of
 * every accessible server_user id across all given identities in a single
 * query. An identity with no accessible account under the caller's server
 * access contributes nothing to the union (fail-closed), same as the
 * singular resolver.
 */
export async function resolveAccessibleServerUserIdsForIdentities(
  dbOrTx: DbOrTx,
  authUser: AuthUser,
  identityUserIds: string[]
): Promise<string[]> {
  if (identityUserIds.length === 0) return [];

  const accessCondition = buildServerAccessCondition(authUser, serverUsers.serverId);
  const where = accessCondition
    ? and(inArray(serverUsers.userId, identityUserIds), accessCondition)
    : inArray(serverUsers.userId, identityUserIds);

  const rows = await dbOrTx.select({ id: serverUsers.id }).from(serverUsers).where(where);
  return rows.map((row) => row.id);
}

/**
 * Resolve the set of server_user ids a per-account endpoint (anchored on
 * `:id`) should query against: just `[id]` by default, or every accessible
 * sibling account under the same identity when `scope=identity` is set.
 */
export async function resolveIdentityScopedServerUserIds(
  dbOrTx: DbOrTx,
  authUser: AuthUser,
  id: string,
  scope: 'identity' | undefined,
  rowScope: Scope
): Promise<
  | { error: 'notFound' }
  | { error: 'forbidden' }
  | { serverUser: { id: string; serverId: string; userId: string }; ids: string[] }
> {
  const rows = await dbOrTx
    .select({ id: serverUsers.id, serverId: serverUsers.serverId, userId: serverUsers.userId })
    .from(serverUsers)
    .where(eq(serverUsers.id, id))
    .limit(1);

  const serverUser = rows[0];
  if (!serverUser || !assertInScope(rowScope, serverUser.id)) {
    return { error: 'notFound' };
  }
  if (!hasServerAccess(authUser, serverUser.serverId)) {
    return { error: 'forbidden' };
  }
  if (scope !== 'identity') {
    return { serverUser, ids: [id] };
  }

  const ids = (
    await resolveAccessibleServerUserIdsForIdentity(dbOrTx, authUser, serverUser.userId)
  ).filter((accountId) => assertInScope(rowScope, accountId));
  // The anchor account is always part of its own identity and already passed
  // the access check above, so this can't come back empty in practice.
  return { serverUser, ids: ids.length > 0 ? ids : [id] };
}

/**
 * Build a `<columnRef> = ANY(...)` SQL fragment for a raw query.
 */
export function serverUserIdAnyFragment(ids: string[], columnRef = 'server_user_id') {
  return sql`${sql.raw(columnRef)} = ANY(${uuidArraySql(ids)})`;
}

interface StartedAtWindow {
  start: Date;
  end: Date;
}

/**
 * The User pages' history horizon. A literal started_at range is a plan-time bound,
 * so TimescaleDB excludes chunks instead of planning the whole hypertable.
 */
export function userHistoryWindow(): StartedAtWindow {
  const end = new Date();
  return { start: new Date(end.getTime() - 10 * 365 * 24 * 60 * 60 * 1000), end };
}

function startedAtWindowSql(window: StartedAtWindow | undefined): SQL {
  return window ? sql`AND started_at >= ${window.start} AND started_at < ${window.end}` : sql``;
}

/**
 * Deduplicate to one row per play, then aggregate by location.
 * Each play is assigned to its most recent segment's location.
 */
export async function queryUserLocations(
  dbOrTx: DbOrTx,
  serverUserIds: string[],
  window?: StartedAtWindow
): Promise<UserLocation[]> {
  const result = await dbOrTx.execute(sql`
    WITH plays AS (
      SELECT DISTINCT ON (COALESCE(reference_id, id))
        geo_city, geo_region, geo_country, geo_lat, geo_lon,
        ${localSessionSql('sessions')} AS local_flag,
        ip_address, started_at
      FROM sessions
      WHERE ${serverUserIdAnyFragment(serverUserIds)}
        ${startedAtWindowSql(window)}
      ORDER BY COALESCE(reference_id, id), started_at DESC
    )
    SELECT
      geo_city AS city, geo_region AS region, geo_country AS country,
      geo_lat AS lat, geo_lon AS lon, local_flag AS is_local,
      count(*)::int AS session_count,
      max(started_at) AS last_seen_at,
      array_agg(DISTINCT ip_address) AS ip_addresses
    FROM plays
    GROUP BY geo_city, geo_region, geo_country, geo_lat, geo_lon, local_flag
    ORDER BY max(started_at) DESC
  `);
  return (
    result.rows as {
      city: string | null;
      region: string | null;
      country: string | null;
      lat: number | null;
      lon: number | null;
      is_local: boolean;
      session_count: number;
      last_seen_at: Date;
      ip_addresses: string[];
    }[]
  ).map((loc) => ({
    city: loc.city,
    region: loc.region,
    country: loc.country,
    lat: loc.lat,
    lon: loc.lon,
    isLocal: loc.is_local,
    sessionCount: loc.session_count,
    lastSeenAt: loc.last_seen_at,
    ipAddresses: loc.ip_addresses ?? [],
  }));
}

interface DeviceSessionRow {
  device_id: string | null;
  player_name: string | null;
  product: string | null;
  device: string | null;
  platform: string | null;
  started_at: Date;
  geo_city: string | null;
  geo_region: string | null;
  geo_country: string | null;
  is_local: boolean;
}

interface DeviceDownloadRow extends Omit<DeviceSessionRow, 'started_at' | 'is_local'> {
  is_local: boolean | null;
  download_count: number;
  last_seen_at: Date;
}

type DeviceLocation = UserDevice['locations'][number];

function deviceLocationKey(
  row: Pick<DeviceDownloadRow, 'geo_city' | 'geo_region' | 'geo_country' | 'is_local'>
): string {
  return `${row.geo_city ?? ''}-${row.geo_region ?? ''}-${row.geo_country ?? ''}-${row.is_local}`;
}

function deviceKey(
  row: Pick<DeviceSessionRow, 'device_id' | 'player_name' | 'product' | 'device' | 'platform'>
): string {
  return (
    row.device_id ??
    row.player_name ??
    `${row.product ?? 'unknown'}-${row.device ?? 'unknown'}-${row.platform ?? 'unknown'}`
  );
}

function newDeviceLocation(session: DeviceSessionRow & { started_at: Date }) {
  return {
    city: session.geo_city,
    region: session.geo_region,
    country: session.geo_country,
    isLocal: session.is_local,
    sessionCount: 1,
    lastSeenAt: session.started_at,
  };
}

/**
 * Query deduplicated device sessions and aggregate into UserDevice[].
 * Uses DISTINCT ON to collapse pause/resume chains into one row per play,
 * then groups by device key with per-device location breakdowns.
 */
export async function queryUserDevices(
  dbOrTx: DbOrTx,
  serverUserIds: string | string[],
  window?: StartedAtWindow
): Promise<UserDevice[]> {
  const ids = Array.isArray(serverUserIds) ? serverUserIds : [serverUserIds];
  const result = await dbOrTx.execute(sql`
    SELECT DISTINCT ON (COALESCE(reference_id, id))
      device_id, player_name, product, device, platform, started_at,
      geo_city, geo_region, geo_country,
      ${localSessionSql('sessions')} AS is_local
    FROM sessions
    WHERE ${serverUserIdAnyFragment(ids)}
      ${startedAtWindowSql(window)}
    ORDER BY COALESCE(reference_id, id), started_at DESC
  `);
  const downloadResult = await dbOrTx.execute(sql`
    SELECT
      device_id, player_name, product, device, platform,
      geo_city, geo_region, geo_country, is_local,
      count(*)::int AS download_count,
      max(last_seen_at) AS last_seen_at
    FROM media_downloads
    WHERE ${serverUserIdAnyFragment(ids)}
    GROUP BY device_id, player_name, product, device, platform,
      geo_city, geo_region, geo_country, is_local
  `);

  // Raw SQL returns timestamps as strings — coerce to Date for comparisons
  const sessionData = (result.rows as unknown as DeviceSessionRow[]).map((r) => ({
    ...r,
    started_at: new Date(r.started_at),
  }));

  const deviceMap = new Map<
    string,
    {
      deviceId: string | null;
      playerName: string | null;
      product: string | null;
      device: string | null;
      platform: string | null;
      sessionCount: number;
      downloadCount: number;
      lastSeenAt: Date;
      locationMap: Map<string, DeviceLocation>;
    }
  >();

  for (const session of sessionData) {
    const key = deviceKey(session);

    const existing = deviceMap.get(key);
    if (existing) {
      existing.sessionCount++;
      if (session.started_at > existing.lastSeenAt) {
        existing.lastSeenAt = session.started_at;
        existing.playerName = session.player_name ?? existing.playerName;
        existing.product = session.product ?? existing.product;
        existing.device = session.device ?? existing.device;
        existing.platform = session.platform ?? existing.platform;
      }

      const locKey = deviceLocationKey(session);
      const existingLoc = existing.locationMap.get(locKey);
      if (existingLoc) {
        existingLoc.sessionCount++;
        if (session.started_at > existingLoc.lastSeenAt) {
          existingLoc.lastSeenAt = session.started_at;
        }
      } else {
        existing.locationMap.set(locKey, newDeviceLocation(session));
      }
    } else {
      const locationMap = new Map<string, DeviceLocation>();
      locationMap.set(deviceLocationKey(session), newDeviceLocation(session));

      deviceMap.set(key, {
        deviceId: session.device_id,
        playerName: session.player_name,
        product: session.product,
        device: session.device,
        platform: session.platform,
        sessionCount: 1,
        downloadCount: 0,
        lastSeenAt: session.started_at,
        locationMap,
      });
    }
  }

  for (const row of downloadResult.rows as unknown as DeviceDownloadRow[]) {
    const key = deviceKey(row);
    const lastSeenAt = new Date(row.last_seen_at);
    let entry = deviceMap.get(key);
    if (!entry) {
      entry = {
        deviceId: row.device_id,
        playerName: row.player_name,
        product: row.product,
        device: row.device,
        platform: row.platform,
        sessionCount: 0,
        downloadCount: 0,
        lastSeenAt,
        locationMap: new Map(),
      };
      deviceMap.set(key, entry);
    }
    entry.downloadCount += row.download_count;
    if (lastSeenAt > entry.lastSeenAt) entry.lastSeenAt = lastSeenAt;

    // A device that streamed keeps the places its sessions saw; Plex downloads carry no address
    const located = row.geo_city ?? row.geo_region ?? row.geo_country ?? row.is_local;
    if (entry.sessionCount > 0 || located === null) continue;
    const locKey = deviceLocationKey(row);
    const existingLoc = entry.locationMap.get(locKey);
    if (existingLoc) {
      if (lastSeenAt > existingLoc.lastSeenAt) existingLoc.lastSeenAt = lastSeenAt;
    } else {
      entry.locationMap.set(locKey, {
        city: row.geo_city,
        region: row.geo_region,
        country: row.geo_country,
        isLocal: row.is_local,
        sessionCount: 0,
        lastSeenAt,
      });
    }
  }

  return Array.from(deviceMap.values())
    .map((dev) => ({
      deviceId: dev.deviceId,
      playerName: dev.playerName,
      product: dev.product,
      device: dev.device,
      platform: dev.platform,
      sessionCount: dev.sessionCount,
      downloadCount: dev.downloadCount,
      lastSeenAt: dev.lastSeenAt,
      locations: Array.from(dev.locationMap.values()).sort(
        (a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime()
      ),
    }))
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
}

export async function queryUserDownloads(
  dbOrTx: DbOrTx,
  serverUserIds: string[],
  page: number,
  pageSize: number
): Promise<{ data: MediaDownloadRow[]; total: number }> {
  const where = inArray(mediaDownloads.serverUserId, serverUserIds);
  const [data, [totalRow]] = await Promise.all([
    listDownloadRows(where, pageSize, (page - 1) * pageSize, dbOrTx),
    dbOrTx.select({ count: count() }).from(mediaDownloads).where(where),
  ]);
  return { data, total: totalRow?.count ?? 0 };
}

const DAY_MS = 24 * 60 * 60 * 1000;

const NO_SESSION = {
  mediaTitle: null,
  mediaType: null,
  grandparentTitle: null,
  seasonNumber: null,
  episodeNumber: null,
  year: null,
  artistName: null,
  albumName: null,
};

/**
 * Termination logs newest first, each carrying the fields of the session it ended, or nulls
 * when that session is gone. The sessions read is bounded by the started_at the log stored
 * and the log's own time instead of joined by id alone, which would plan every chunk:
 * confirmation only ever moves started_at earlier, and no session starts after the log that
 * ended it, so a day of slack either side keeps every match the plain join would find.
 */
export async function queryTerminationHistory(
  dbOrTx: DbOrTx,
  where: SQL,
  page: { limit: number; offset?: number }
) {
  const logs = await dbOrTx
    .select({
      id: terminationLogs.id,
      sessionId: terminationLogs.sessionId,
      sessionStartedAt: terminationLogs.sessionStartedAt,
      serverId: terminationLogs.serverId,
      serverName: servers.name,
      serverUserId: terminationLogs.serverUserId,
      trigger: terminationLogs.trigger,
      triggeredByUserId: terminationLogs.triggeredByUserId,
      triggeredByUsername: users.username,
      ruleId: terminationLogs.ruleId,
      ruleName: automations.name,
      violationId: terminationLogs.violationId,
      reason: terminationLogs.reason,
      success: terminationLogs.success,
      errorMessage: terminationLogs.errorMessage,
      createdAt: terminationLogs.createdAt,
    })
    .from(terminationLogs)
    .leftJoin(users, eq(terminationLogs.triggeredByUserId, users.id))
    .leftJoin(automations, eq(terminationLogs.ruleId, automations.id))
    .leftJoin(servers, eq(terminationLogs.serverId, servers.id))
    .where(where)
    .orderBy(desc(terminationLogs.createdAt))
    .limit(page.limit)
    .offset(page.offset ?? 0);

  const startedAts = logs.flatMap((log) => log.sessionStartedAt?.getTime() ?? []);
  const sessionRows =
    startedAts.length === 0
      ? []
      : await dbOrTx
          .select({
            id: sessions.id,
            mediaTitle: sessions.mediaTitle,
            mediaType: sessions.mediaType,
            grandparentTitle: sessions.grandparentTitle,
            seasonNumber: sessions.seasonNumber,
            episodeNumber: sessions.episodeNumber,
            year: sessions.year,
            artistName: sessions.artistName,
            albumName: sessions.albumName,
          })
          .from(sessions)
          .where(
            and(
              inArray(
                sessions.id,
                logs.map((log) => log.sessionId)
              ),
              between(
                sessions.startedAt,
                new Date(Math.min(...startedAts) - DAY_MS),
                new Date(Math.max(...logs.map((log) => log.createdAt.getTime())) + DAY_MS)
              )
            )
          );
  const sessionById = new Map(sessionRows.map(({ id, ...fields }) => [id, fields]));

  return logs.map(({ sessionStartedAt: _, ...log }) => ({
    ...log,
    ...(sessionById.get(log.sessionId) ?? NO_SESSION),
  }));
}
