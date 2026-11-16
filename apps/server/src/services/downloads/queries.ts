import { and, count, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import type { DownloadsStats, MediaDownloadRow } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { libraryItems, mediaDownloads, servers, serverUsers, users } from '../../db/schema.js';

// A converted pull sent less than its source file; without the plugin's byte count it counts zero
const downloadBytes = sql`coalesce(${mediaDownloads.deliveredBytes}, case when ${mediaDownloads.source} = 'jellyfin_transcode' then null else ${mediaDownloads.fileSizeBytes} end)`;

function downloadsSince(
  serverUserIds: string[],
  since: Date,
  serverId?: string | null
): SQL | undefined {
  return and(
    inArray(mediaDownloads.serverUserId, serverUserIds),
    gte(mediaDownloads.firstSeenAt, since),
    serverId ? eq(mediaDownloads.serverId, serverId) : undefined
  );
}

/** Downloads first seen since the cutoff by any of these accounts, on one server when serverId is set. */
export async function countDownloads(
  serverUserIds: string[],
  since: Date,
  serverId?: string | null
): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(mediaDownloads)
    .where(downloadsSince(serverUserIds, since, serverId));
  return row?.count ?? 0;
}

/** Bytes those downloads delivered, the source file size where the delivered size is unknown (never for a converted pull); unknown sizes count zero. */
export async function sumDownloadBytes(
  serverUserIds: string[],
  since: Date,
  serverId?: string | null
): Promise<number> {
  const [row] = await db
    .select({
      bytes: sql`coalesce(sum(${downloadBytes}), 0)`,
    })
    .from(mediaDownloads)
    .where(downloadsSince(serverUserIds, since, serverId));
  // sum over bigint is numeric, which the driver returns as a string
  return Number(row?.bytes ?? 0);
}

const downloadTitle = sql<string>`coalesce(nullif(${mediaDownloads.title}, ''), ${libraryItems.title}, '')`;

const downloadRowColumns = {
  id: mediaDownloads.id,
  serverId: mediaDownloads.serverId,
  serverName: servers.name,
  serverType: servers.type,
  serverUserId: mediaDownloads.serverUserId,
  username: serverUsers.username,
  identityName: sql<string | null>`coalesce(${users.name}, ${users.username})`,
  thumbUrl: serverUsers.thumbUrl,
  libraryItemId: mediaDownloads.libraryItemId,
  mediaId: mediaDownloads.mediaId,
  title: downloadTitle,
  mediaType: libraryItems.mediaType,
  thumbPath: libraryItems.thumbPath,
  app: mediaDownloads.app,
  device: mediaDownloads.device,
  source: mediaDownloads.source,
  requestCount: mediaDownloads.requestCount,
  firstSeenAt: mediaDownloads.firstSeenAt,
  lastSeenAt: mediaDownloads.lastSeenAt,
  videoResolution: mediaDownloads.videoResolution,
  videoCodec: mediaDownloads.videoCodec,
  videoDynamicRange: mediaDownloads.videoDynamicRange,
  container: mediaDownloads.container,
  fileSizeBytes: mediaDownloads.fileSizeBytes,
  ipAddress: mediaDownloads.ipAddress,
  isLocal: mediaDownloads.isLocal,
  geoCity: mediaDownloads.geoCity,
  geoRegion: mediaDownloads.geoRegion,
  geoCountry: mediaDownloads.geoCountry,
  deliveredBytes: mediaDownloads.deliveredBytes,
  deliveredVideoCodec: mediaDownloads.deliveredVideoCodec,
  deliveredAudioCodec: mediaDownloads.deliveredAudioCodec,
  deliveredContainer: mediaDownloads.deliveredContainer,
  deliveredBitrateKbps: mediaDownloads.deliveredBitrateKbps,
  deliveredResolution: mediaDownloads.deliveredResolution,
  completionPercent: mediaDownloads.completionPercent,
  deviceId: mediaDownloads.deviceId,
  playerName: mediaDownloads.playerName,
  product: mediaDownloads.product,
  platform: mediaDownloads.platform,
};

type DownloadDbRow = Omit<MediaDownloadRow, 'firstSeenAt' | 'lastSeenAt'> & {
  firstSeenAt: Date;
  lastSeenAt: Date;
};

function toDownloadRow(row: DownloadDbRow): MediaDownloadRow {
  return {
    ...row,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

/** Newest-first download rows for a WHERE over media_downloads (and its joined server, account, identity and item). */
export async function listDownloadRows(
  where: SQL | undefined,
  limit: number,
  offset = 0,
  dbOrTx: typeof db = db
): Promise<MediaDownloadRow[]> {
  const rows = await dbOrTx
    .select(downloadRowColumns)
    .from(mediaDownloads)
    .innerJoin(servers, eq(servers.id, mediaDownloads.serverId))
    .leftJoin(serverUsers, eq(serverUsers.id, mediaDownloads.serverUserId))
    .leftJoin(users, eq(users.id, serverUsers.userId))
    .leftJoin(libraryItems, eq(libraryItems.id, mediaDownloads.libraryItemId))
    .where(where)
    .orderBy(desc(mediaDownloads.lastSeenAt), desc(mediaDownloads.id))
    .limit(limit)
    .offset(offset);
  return rows.map(toDownloadRow);
}

/** Newest downloads of a canonical media item, including the ids merged into it. */
export function queryMediaDownloads(
  mediaIds: string[],
  serverIds: string[] | undefined,
  limit = 20
) {
  return listDownloadRows(
    and(
      inArray(mediaDownloads.mediaId, mediaIds),
      serverIds ? inArray(mediaDownloads.serverId, serverIds) : undefined
    ),
    limit
  );
}

/** Cards and one page of rows over a caller-built WHERE (date range, server and row scope). */
export async function queryDownloadsStats(
  where: SQL,
  page: number,
  pageSize: number
): Promise<DownloadsStats> {
  const [rows, [totals], [top]] = await Promise.all([
    listDownloadRows(where, pageSize, (page - 1) * pageSize),
    db
      .select({
        total: count(),
        people: sql`count(distinct coalesce(${serverUsers.userId}, ${mediaDownloads.serverUserId}))`,
        bytes: sql`coalesce(sum(${downloadBytes}), 0)`,
      })
      .from(mediaDownloads)
      .leftJoin(serverUsers, eq(serverUsers.id, mediaDownloads.serverUserId))
      .where(where),
    db
      .select({ title: downloadTitle, libraryItemId: mediaDownloads.libraryItemId, count: count() })
      .from(mediaDownloads)
      .leftJoin(libraryItems, eq(libraryItems.id, mediaDownloads.libraryItemId))
      .where(where)
      .groupBy(downloadTitle, mediaDownloads.libraryItemId)
      .orderBy(desc(count()), downloadTitle)
      .limit(1),
  ]);
  return {
    total: totals?.total ?? 0,
    people: Number(totals?.people ?? 0),
    totalBytes: Number(totals?.bytes ?? 0),
    topTitle: top ? { title: top.title, count: top.count, libraryItemId: top.libraryItemId } : null,
    rows,
    page,
    pageSize,
  };
}
