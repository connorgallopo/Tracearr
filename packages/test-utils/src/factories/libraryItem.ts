/**
 * Library item factory for test data generation
 *
 * Creates library_items entities for media catalog tests.
 */

import { executeRawSql } from '../db/pool.js';

let itemCounter = 0;
export function resetLibraryItemCounter(): void {
  itemCounter = 0;
}

export interface LibraryItemData {
  serverId: string;
  libraryId?: string;
  ratingKey?: string;
  title?: string;
  mediaType?: string;
  year?: number | null;
  imdbId?: string | null;
  tmdbId?: number | null;
  tvdbId?: number | null;
  grandparentTitle?: string | null;
  grandparentRatingKey?: string | null;
  parentTitle?: string | null;
  parentRatingKey?: string | null;
  parentIndex?: number | null;
  itemIndex?: number | null;
  genres?: string[] | null;
  mediaId?: string | null;
  removedAt?: Date | null;
  removedSource?: 'event' | 'scan' | null;
  firstSeenAt?: Date | null;
  fileSize?: number | null;
  videoResolution?: string | null;
  videoDynamicRange?: string | null;
  createdAt?: Date | null;
  /** Skip the automatic version row (containers, or tests seeding their own) */
  withoutVersion?: boolean;
}

export interface LibraryItemVersionData {
  libraryItemId: string;
  serverVersionKey?: string;
  videoResolution?: string | null;
  videoCodec?: string | null;
  videoDynamicRange?: string | null;
  audioCodec?: string | null;
  audioChannels?: number | null;
  container?: string | null;
  bitrate?: number | null;
  fileSize?: number | null;
  partCount?: number;
  filePath?: string | null;
  removedAt?: Date | null;
}

export function buildLibraryItem(data: LibraryItemData): Required<LibraryItemData> {
  itemCounter += 1;
  return {
    serverId: data.serverId,
    libraryId: data.libraryId ?? 'lib-1',
    ratingKey: data.ratingKey ?? `item-${itemCounter}`,
    title: data.title ?? `Test Item ${itemCounter}`,
    mediaType: data.mediaType ?? 'movie',
    year: data.year ?? 2020,
    imdbId: data.imdbId ?? null,
    tmdbId: data.tmdbId ?? null,
    tvdbId: data.tvdbId ?? null,
    grandparentTitle: data.grandparentTitle ?? null,
    grandparentRatingKey: data.grandparentRatingKey ?? null,
    parentTitle: data.parentTitle ?? null,
    parentRatingKey: data.parentRatingKey ?? null,
    parentIndex: data.parentIndex ?? null,
    itemIndex: data.itemIndex ?? null,
    genres: data.genres ?? null,
    mediaId: data.mediaId ?? null,
    removedAt: data.removedAt ?? null,
    removedSource: data.removedSource ?? null,
    firstSeenAt: data.firstSeenAt ?? null,
    fileSize: data.fileSize ?? null,
    videoResolution: data.videoResolution ?? null,
    videoDynamicRange: data.videoDynamicRange ?? null,
    createdAt: data.createdAt ?? null,
    withoutVersion: data.withoutVersion ?? false,
  };
}

export async function createTestLibraryItem(
  data: LibraryItemData
): Promise<{ id: string; ratingKey: string; serverId: string }> {
  const d = buildLibraryItem(data);
  const esc = (v: string) => v.replace(/'/g, "''");
  const str = (v: string | null) => (v === null ? 'NULL' : `'${esc(v)}'`);
  const num = (v: number | null) => (v === null ? 'NULL' : String(v));
  const genres =
    d.genres === null ? 'NULL' : `ARRAY[${d.genres.map((g) => `'${esc(g)}'`).join(',')}]::text[]`;
  const removedAt = d.removedAt === null ? 'NULL' : `'${d.removedAt.toISOString()}'`;
  const removedSource = str(d.removedSource);
  const firstSeenAt = d.firstSeenAt === null ? 'NULL' : `'${d.firstSeenAt.toISOString()}'`;
  const fileSize = d.fileSize === null ? 'NULL' : String(d.fileSize);
  const videoResolution = str(d.videoResolution);
  const videoDynamicRange = str(d.videoDynamicRange);
  const createdAt = d.createdAt === null ? 'DEFAULT' : `'${d.createdAt.toISOString()}'`;
  const result = await executeRawSql(`
    INSERT INTO library_items
      (server_id, library_id, rating_key, title, media_type, year, imdb_id, tmdb_id, tvdb_id,
       grandparent_title, grandparent_rating_key, parent_title, parent_rating_key, parent_index, item_index,
       genres, media_id, removed_at,
       removed_source, first_seen_at, file_size, video_resolution, video_dynamic_range, created_at)
    VALUES ('${d.serverId}', '${esc(d.libraryId)}', '${esc(d.ratingKey)}', '${esc(d.title)}',
       '${d.mediaType}', ${num(d.year)}, ${str(d.imdbId)}, ${num(d.tmdbId)}, ${num(d.tvdbId)},
       ${str(d.grandparentTitle)}, ${str(d.grandparentRatingKey)}, ${str(d.parentTitle)}, ${str(d.parentRatingKey)},
       ${num(d.parentIndex)}, ${num(d.itemIndex)}, ${genres}, ${d.mediaId === null ? 'NULL' : `'${d.mediaId}'`}, ${removedAt},
       ${removedSource}, ${firstSeenAt}, ${fileSize}, ${videoResolution}, ${videoDynamicRange}, ${createdAt})
    RETURNING id, rating_key, server_id
  `);
  const row = result.rows[0] as { id: string; rating_key: string; server_id: string };

  // Mirror the flat quality columns into one version row, matching what a
  // real sync writes. Tests that need multi-version or tombstoned versions
  // add rows via createTestLibraryItemVersion.
  if (!data.withoutVersion) {
    await createTestLibraryItemVersion({
      libraryItemId: row.id,
      serverVersionKey: 'v1',
      videoResolution: d.videoResolution,
      videoDynamicRange: d.videoDynamicRange,
      fileSize: d.fileSize,
    });
  }

  return { id: row.id, ratingKey: row.rating_key, serverId: row.server_id };
}

let versionCounter = 0;

export async function createTestLibraryItemVersion(
  data: LibraryItemVersionData
): Promise<{ id: string; serverVersionKey: string }> {
  versionCounter += 1;
  const esc = (v: string) => v.replace(/'/g, "''");
  const str = (v: string | null | undefined) => (v == null ? 'NULL' : `'${esc(v)}'`);
  const num = (v: number | null | undefined) => (v == null ? 'NULL' : String(v));
  const serverVersionKey = data.serverVersionKey ?? `v${versionCounter}`;
  const removedAt = data.removedAt == null ? 'NULL' : `'${data.removedAt.toISOString()}'`;
  const result = await executeRawSql(`
    INSERT INTO library_item_versions
      (library_item_id, server_version_key, video_resolution, video_codec, video_dynamic_range,
       audio_codec, audio_channels, container, bitrate, file_size, part_count, file_path, removed_at)
    VALUES ('${data.libraryItemId}', '${esc(serverVersionKey)}', ${str(data.videoResolution)},
       ${str(data.videoCodec)}, ${str(data.videoDynamicRange)}, ${str(data.audioCodec)},
       ${num(data.audioChannels)}, ${str(data.container)}, ${num(data.bitrate)},
       ${num(data.fileSize)}, ${data.partCount ?? 1}, ${str(data.filePath)}, ${removedAt})
    RETURNING id, server_version_key
  `);
  const row = result.rows[0] as { id: string; server_version_key: string };
  return { id: row.id, serverVersionKey: row.server_version_key };
}
