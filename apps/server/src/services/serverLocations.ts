import { eq, sql } from 'drizzle-orm';
import type { ServerLocationEntry, ServerLocationsResponse } from '@tracearr/shared';
import { db } from '../db/client.js';
import { serverLocations, servers } from '../db/schema.js';
import { RELAYED_COUNTRY } from '../db/sessions/rules.js';
import { geoipService, type GeoLocation } from './geoip.js';
import { lookupGeoIP } from './plexGeoip.js';
import {
  locationAt,
  locationRanges,
  placeLocal,
  type ServerLocation,
} from './serverLocationRanges.js';

export type SessionGeo = GeoLocation & { isLocal: boolean };

/** A client on tofa's relay has no address of its own to place, so it is labeled instead. */
export const RELAYED_SESSION_GEO: SessionGeo = {
  city: null,
  region: null,
  country: RELAYED_COUNTRY,
  countryCode: null,
  continent: null,
  postal: null,
  lat: null,
  lon: null,
  asnNumber: null,
  asnOrganization: null,
  isLocal: false,
};

export function loadServerLocations(serverId: string): Promise<ServerLocation[]> {
  return db
    .select({
      effectiveFrom: serverLocations.effectiveFrom,
      lat: serverLocations.lat,
      lon: serverLocations.lon,
      city: serverLocations.city,
      region: serverLocations.region,
      country: serverLocations.country,
    })
    .from(serverLocations)
    .where(eq(serverLocations.serverId, serverId));
}

export async function resolveSessionGeo(
  ip: string,
  serverId: string,
  usePlexGeoip: boolean,
  at: Date = new Date()
): Promise<SessionGeo> {
  const geo = await lookupGeoIP(ip, usePlexGeoip);
  if (!geoipService.isPrivateIP(ip)) return { ...geo, isLocal: false };
  const location = locationAt(await loadServerLocations(serverId), at);
  return { ...placeLocal(geo, location), isLocal: true };
}

/** Pending entries written before is_local existed carry no flag; the IP decides, as it does at insert. */
export function withLocalFlag(geo: GeoLocation & { isLocal?: boolean }, ip: string): SessionGeo {
  return { ...geo, isLocal: geo.isLocal ?? geoipService.isPrivateIP(ip) };
}

/** Imported rows arrive unplaced; a server with a location needs the sync to place them. */
export async function markImportedServerLocations(serverId: string): Promise<void> {
  const [entry] = await db
    .select({ id: serverLocations.id })
    .from(serverLocations)
    .where(eq(serverLocations.serverId, serverId))
    .limit(1);
  if (!entry) return;
  await db
    .update(servers)
    .set({ locationVersion: sql`${servers.locationVersion} + 1` })
    .where(eq(servers.id, serverId));
}

export async function getServerLocations(
  serverId: string
): Promise<ServerLocationsResponse | null> {
  const [server] = await db
    .select({ version: servers.locationVersion, synced: servers.locationSyncedVersion })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!server) return null;
  const entries = locationRanges(await loadServerLocations(serverId)).flatMap((range) =>
    range.location
      ? [
          {
            effectiveFrom: range.location.effectiveFrom?.toISOString() ?? null,
            lat: range.location.lat,
            lon: range.location.lon,
            city: range.location.city,
            region: range.location.region,
            country: range.location.country,
          },
        ]
      : []
  );
  return { entries, syncPending: server.version !== server.synced };
}

export async function replaceServerLocations(
  serverId: string,
  entries: ServerLocationEntry[]
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(serverLocations).where(eq(serverLocations.serverId, serverId));
    if (entries.length > 0) {
      await tx.insert(serverLocations).values(
        entries.map((entry) => ({
          serverId,
          effectiveFrom: entry.effectiveFrom ? new Date(entry.effectiveFrom) : null,
          lat: entry.lat,
          lon: entry.lon,
          city: entry.city,
          region: entry.region,
          country: entry.country,
        }))
      );
    }
    await tx
      .update(servers)
      .set({ locationVersion: sql`${servers.locationVersion} + 1` })
      .where(eq(servers.id, serverId));
  });
}
