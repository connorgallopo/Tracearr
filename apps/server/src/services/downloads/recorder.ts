import { and, desc, eq, gte, isNull, ne, sql } from 'drizzle-orm';
import type { MediaDownloadSource } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { libraryItems, mediaDownloads } from '../../db/schema.js';
import { dispatchMediaDownloaded } from '../automations/events/producers.js';
import { enrichDownload, sourceColumns, type DownloadEnrichment } from './enrich.js';

export interface DownloadSignal {
  serverId: string;
  serverUserId: string | null;
  /** Jellyfin ItemId, Plex metadataID, Emby sync ItemId, null on the Emby activity log */
  ratingKey: string | null;
  title: string;
  app: string | null;
  device: string | null;
  source: MediaDownloadSource;
  seenAt: Date;
  /** Plex Context.partID */
  partId?: string | null;
  /** Plex Context.deviceID (a clientIdentifier), Emby sync TargetId */
  deviceId?: string | null;
  /** Known before enrichment: a Plex static transcode, an Emby sync item's file */
  delivered?: DownloadEnrichment['delivered'];
}

export interface RecordedDownload {
  id: string;
  opened: boolean;
  serverUserId: string | null;
  firstSeenAt: Date;
}

export const DOWNLOAD_COLLAPSE_MS = 60 * 60 * 1000;

// Emby logs no item id, so its title is the only key; a title shared by several items stays unmatched
export async function matchLibraryItem(
  signal: Pick<DownloadSignal, 'serverId' | 'ratingKey' | 'title'>
): Promise<{ id: string; title: string } | null> {
  const rows = await db
    .select({ id: libraryItems.id, title: libraryItems.title })
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.serverId, signal.serverId),
        signal.ratingKey
          ? eq(libraryItems.ratingKey, signal.ratingKey)
          : eq(libraryItems.title, signal.title)
      )
    )
    .limit(2);
  return rows.length === 1 && rows[0] ? rows[0] : null;
}

// Verified 2026-10-23: Plexamp fetches every track it queues with ?download=1, which Plex reports as a download
export async function isTrack(serverId: string, ratingKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: libraryItems.id })
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.serverId, serverId),
        eq(libraryItems.ratingKey, ratingKey),
        eq(libraryItems.mediaType, 'track')
      )
    )
    .limit(1);
  return row !== undefined;
}

/** Matches the library item (ratingKey, else title on Emby), collapses into the newest row within DOWNLOAD_COLLAPSE_MS, else enriches, inserts and announces the new row. */
export async function recordDownload(signal: DownloadSignal): Promise<RecordedDownload> {
  const [open] = await db
    .select({ id: mediaDownloads.id, firstSeenAt: mediaDownloads.firstSeenAt })
    .from(mediaDownloads)
    .where(
      and(
        eq(mediaDownloads.serverId, signal.serverId),
        // A converted pull is its own download, never a collapse target
        ne(mediaDownloads.source, 'jellyfin_transcode'),
        signal.serverUserId
          ? eq(mediaDownloads.serverUserId, signal.serverUserId)
          : isNull(mediaDownloads.serverUserId),
        signal.ratingKey
          ? eq(mediaDownloads.ratingKey, signal.ratingKey)
          : and(isNull(mediaDownloads.ratingKey), eq(mediaDownloads.title, signal.title)),
        gte(mediaDownloads.lastSeenAt, new Date(signal.seenAt.getTime() - DOWNLOAD_COLLAPSE_MS))
      )
    )
    .orderBy(desc(mediaDownloads.lastSeenAt))
    .limit(1);

  if (open) {
    await db
      .update(mediaDownloads)
      .set({ lastSeenAt: signal.seenAt, requestCount: sql`${mediaDownloads.requestCount} + 1` })
      .where(eq(mediaDownloads.id, open.id));
    return { ...open, opened: false, serverUserId: signal.serverUserId };
  }

  return insertDownload(signal, (await matchLibraryItem(signal))?.id ?? null);
}

/** Enriches, inserts and announces a new row, with no collapse into an earlier one. */
export async function insertDownload(
  signal: DownloadSignal,
  libraryItemId: string | null
): Promise<RecordedDownload> {
  const enrichment = await enrichDownload({ ...signal, libraryItemId });
  // Plex activities name no client; the resolved device's app stands in
  const app = signal.app ?? enrichment.device.product ?? enrichment.device.platform;
  const device = signal.device ?? enrichment.device.playerName;
  const varchar = (value: string | null | undefined, max: number) => value?.slice(0, max) ?? null;
  const delivered = signal.delivered ?? enrichment.delivered;
  const [row] = await db
    .insert(mediaDownloads)
    .values({
      serverId: signal.serverId,
      serverUserId: signal.serverUserId,
      libraryItemId,
      ratingKey: signal.ratingKey,
      title: signal.title,
      app,
      device,
      source: signal.source,
      firstSeenAt: signal.seenAt,
      lastSeenAt: signal.seenAt,
      ...sourceColumns(enrichment),
      ipAddress: enrichment.ipAddress,
      isLocal: enrichment.isLocal,
      geoCity: enrichment.geo?.city ?? null,
      geoRegion: enrichment.geo?.region ?? null,
      geoCountry: enrichment.geo?.country ?? null,
      geoLat: enrichment.geo?.lat ?? null,
      geoLon: enrichment.geo?.lon ?? null,
      deliveredBytes: delivered?.bytes ?? null,
      deliveredVideoCodec: delivered?.videoCodec ?? null,
      deliveredAudioCodec: delivered?.audioCodec ?? null,
      deliveredContainer: delivered?.container ?? null,
      deliveredBitrateKbps: delivered?.bitrateKbps ?? null,
      deliveredResolution: delivered?.resolution ?? null,
      playerName: varchar(enrichment.device.playerName, 255),
      product: varchar(enrichment.device.product, 255),
      platform: varchar(enrichment.device.platform, 100),
      deviceId: varchar(enrichment.device.deviceId ?? signal.deviceId, 255),
    })
    .returning({ id: mediaDownloads.id, firstSeenAt: mediaDownloads.firstSeenAt });
  if (!row) throw new Error('media_downloads insert returned no row');
  if (signal.serverUserId) {
    await dispatchMediaDownloaded({
      serverId: signal.serverId,
      serverUserId: signal.serverUserId,
      title: signal.title,
      app,
      device,
      firstSeenAt: row.firstSeenAt,
    });
  }
  return { ...row, opened: true, serverUserId: signal.serverUserId };
}
