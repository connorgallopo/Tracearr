import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { libraryItems, libraryItemVersions, servers, serverUsers } from '../../db/schema.js';
import { createLogger } from '../../utils/logger.js';
import { createMediaServerClient } from '../mediaServer/index.js';
import { resolveSessionGeo } from '../serverLocations.js';
import { getGeoIPSettings } from '../settings.js';
import type { StaticTranscode } from '../mediaServer/plex/eventSource.js';
import type { DeliveredFile, DownloadSourceDescription } from '../mediaServer/types.js';
import type { DownloadSignal } from './recorder.js';

export interface DownloadEnrichment {
  serverVersionKey: string | null;
  libraryItemVersionId: string | null;
  videoResolution: string | null;
  videoCodec: string | null;
  videoDynamicRange: string | null;
  container: string | null;
  fileSizeBytes: number | null;
  ipAddress: string | null;
  isLocal: boolean | null;
  geo: {
    city: string | null;
    region: string | null;
    country: string | null;
    lat: number | null;
    lon: number | null;
  } | null;
  delivered: DeliveredFile | null;
  mediaId: string | null;
  device: DownloadSourceDescription['device'];
}

// Verified 2026-10-20: the media.download activity started 3 s after its static transcode ended
const STATIC_TRANSCODE_WINDOW_MS = 15_000;

const NO_ENRICHMENT: DownloadEnrichment = {
  serverVersionKey: null,
  libraryItemVersionId: null,
  videoResolution: null,
  videoCodec: null,
  videoDynamicRange: null,
  container: null,
  fileSizeBytes: null,
  ipAddress: null,
  isLocal: null,
  geo: null,
  delivered: null,
  mediaId: null,
  device: { deviceId: null, playerName: null, product: null, platform: null },
};

const logger = createLogger('downloads');

/** The source-file columns of a download row */
export function sourceColumns(enrichment: DownloadEnrichment) {
  return {
    libraryItemVersionId: enrichment.libraryItemVersionId,
    videoResolution: enrichment.videoResolution,
    videoCodec: enrichment.videoCodec,
    videoDynamicRange: enrichment.videoDynamicRange,
    container: enrichment.container,
    fileSizeBytes: enrichment.fileSizeBytes,
    mediaId: enrichment.mediaId,
  };
}

/** A delivered stream as Jellyfin and Emby describe it: bps, pixel dimensions, lowercase codecs */
export function deliveredFile(
  stream: {
    bitrate: number | null;
    width: number | null;
    height: number | null;
    videoCodec: string | null;
    audioCodec: string | null;
    container: string | null;
  },
  bytes: number | null
): DeliveredFile {
  return {
    bytes,
    videoCodec: stream.videoCodec?.toUpperCase() ?? null,
    audioCodec: stream.audioCodec?.toUpperCase() ?? null,
    container: stream.container?.toLowerCase() ?? null,
    bitrateKbps: stream.bitrate === null ? null : Math.round(stream.bitrate / 1000),
    resolution: stream.width && stream.height ? `${stream.width}x${stream.height}` : null,
  };
}

/** What a static transcode that ended within 15 s before the download started delivered, else null. */
export function deliveredFromTranscode(
  transcode: StaticTranscode | null,
  startedAt: Date | null
): DeliveredFile | null {
  if (!transcode || !startedAt) return null;
  const gap = startedAt.getTime() - transcode.at.getTime();
  if (gap < 0 || gap > STATIC_TRANSCODE_WINDOW_MS) return null;
  return {
    bytes: transcode.size,
    videoCodec: transcode.videoCodec?.toUpperCase() ?? null,
    audioCodec: transcode.audioCodec?.toUpperCase() ?? null,
    container: transcode.container?.toLowerCase() ?? null,
    // bits per ms is kbps
    bitrateKbps:
      transcode.duration > 0 ? Math.round((transcode.size * 8) / transcode.duration) : null,
    resolution: null,
  };
}

async function externalUserId(serverUserId: string | null): Promise<string | null> {
  if (!serverUserId) return null;
  const [row] = await db
    .select({ externalId: serverUsers.externalId })
    .from(serverUsers)
    .where(eq(serverUsers.id, serverUserId))
    .limit(1);
  return row?.externalId ?? null;
}

async function matchVersion(libraryItemId: string, key: string | null): Promise<string | null> {
  const versions = await db
    .select({ id: libraryItemVersions.id, serverVersionKey: libraryItemVersions.serverVersionKey })
    .from(libraryItemVersions)
    .where(
      and(
        eq(libraryItemVersions.libraryItemId, libraryItemId),
        isNull(libraryItemVersions.removedAt)
      )
    );
  const match =
    versions.find((version) => version.serverVersionKey === key) ??
    (versions.length === 1 ? versions[0] : undefined);
  return match?.id ?? null;
}

async function enrich(
  signal: DownloadSignal & { libraryItemId: string | null }
): Promise<DownloadEnrichment> {
  const [server] = await db.select().from(servers).where(eq(servers.id, signal.serverId)).limit(1);
  if (!server) return NO_ENRICHMENT;
  const client = createMediaServerClient(server);
  const [[item], userId] = await Promise.all([
    signal.libraryItemId
      ? db
          .select({ mediaId: libraryItems.mediaId, ratingKey: libraryItems.ratingKey })
          .from(libraryItems)
          .where(eq(libraryItems.id, signal.libraryItemId))
          .limit(1)
      : [],
    externalUserId(signal.serverUserId),
  ]);

  const side = await client.describeDownloadSource({
    // Emby activity entries carry no item id; the title-matched item supplies it
    itemKey: signal.ratingKey ?? item?.ratingKey ?? null,
    partId: signal.partId ?? null,
    deviceId: signal.deviceId ?? null,
    userId,
    app: signal.app,
    device: signal.device,
  });

  const geo = side.ipAddress
    ? await resolveSessionGeo(
        side.ipAddress,
        server.id,
        (await getGeoIPSettings()).usePlexGeoip,
        signal.seenAt
      )
    : null;

  return {
    serverVersionKey: side.version?.key ?? null,
    libraryItemVersionId: signal.libraryItemId
      ? await matchVersion(signal.libraryItemId, side.version?.key ?? null)
      : null,
    videoResolution: side.version?.videoResolution ?? null,
    videoCodec: side.version?.videoCodec ?? null,
    videoDynamicRange: side.version?.videoDynamicRange ?? null,
    container: side.version?.container ?? null,
    fileSizeBytes: side.version?.size ?? null,
    ipAddress: side.ipAddress,
    isLocal: geo?.isLocal ?? null,
    // Country as sessions store it, the code when GeoIP has one
    geo: geo && {
      city: geo.city,
      region: geo.region,
      country: geo.countryCode ?? geo.country,
      lat: geo.lat,
      lon: geo.lon,
    },
    delivered: signal.delivered ?? side.delivered,
    mediaId: item?.mediaId ?? null,
    device: side.device,
  };
}

/** Best effort, bounded by one request per source plus one geo lookup; resolves an all-null enrichment on any failure and logs at debug. */
export async function enrichDownload(
  signal: DownloadSignal & { libraryItemId: string | null }
): Promise<DownloadEnrichment> {
  try {
    return await enrich(signal);
  } catch (error) {
    logger.debug('Download enrichment failed', {
      serverId: signal.serverId,
      ratingKey: signal.ratingKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return NO_ENRICHMENT;
  }
}
