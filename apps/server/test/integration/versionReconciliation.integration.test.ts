/**
 * Version reconciliation against a real database, driven through the actual
 * sync entry points (upsertItems / markItemsRemoved) rather than seeding
 * version rows directly. Covers the four mechanisms the multi-version branch
 * depends on: sentinel hard-delete, tombstone of absent versions, revival
 * preserving first_seen_at, and the fingerprint no-op guard.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- versionReconciliation
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestServer } from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { LibrarySyncService } from '../../src/services/librarySync.js';
import {
  computeVersionsFingerprint,
  pickBestVersion,
  sumVersionSizes,
} from '../../src/services/mediaServer/shared/versionUtils.js';
import type { MediaLibraryItem, MediaItemVersion } from '../../src/services/mediaServer/types.js';

const LIBRARY_ID = 'lib-1';

function buildItem(ratingKey: string, versions: MediaItemVersion[]): MediaLibraryItem {
  const best = pickBestVersion(versions);
  return {
    ratingKey,
    title: `Reconcile ${ratingKey}`,
    mediaType: 'movie',
    year: 2023,
    addedAt: new Date('2023-12-01T00:00:00Z'),
    videoResolution: best?.videoResolution,
    videoCodec: best?.videoCodec,
    fileSize: sumVersionSizes(versions),
    versions,
    versionsFingerprint: computeVersionsFingerprint(versions),
  };
}

const V_4K: MediaItemVersion = {
  serverVersionKey: '3207',
  videoResolution: '4k',
  videoCodec: 'HEVC',
  fileSize: 13_330_000_000,
  partCount: 1,
  filePath: '/data/a.mkv',
};
const V_1080: MediaItemVersion = {
  serverVersionKey: '98869',
  videoResolution: '1080p',
  videoCodec: 'H264',
  fileSize: 4_100_000_000,
  partCount: 1,
  filePath: '/data/b.mkv',
};

interface VersionRow {
  id: string;
  server_version_key: string;
  removed_at: string | null;
  first_seen_at: string;
  updated_at: string;
  file_path: string | null;
}

async function versionRows(serverId: string, ratingKey: string): Promise<VersionRow[]> {
  const result = await db.execute(sql`
    SELECT v.id, v.server_version_key, v.removed_at::text, v.first_seen_at::text,
           v.updated_at::text, v.file_path
    FROM library_item_versions v
    JOIN library_items li ON li.id = v.library_item_id
    WHERE li.server_id = ${serverId} AND li.rating_key = ${ratingKey}
    ORDER BY v.server_version_key
  `);
  return result.rows as unknown as VersionRow[];
}

describe('version reconciliation through the sync entry points', () => {
  it('creates, tombstones, revives, and no-ops version rows across syncs', async () => {
    const server = await createTestServer({ type: 'plex' });
    const service = new LibrarySyncService();
    const ratingKey = `covenant-${randomUUID().slice(0, 8)}`;

    // First sync: both versions land active
    await service.upsertItems(server.id, LIBRARY_ID, [buildItem(ratingKey, [V_4K, V_1080])]);
    let rows = await versionRows(server.id, ratingKey);
    expect(rows.map((r) => [r.server_version_key, r.removed_at === null])).toEqual([
      ['3207', true],
      ['98869', true],
    ]);
    const originalId1080 = rows.find((r) => r.server_version_key === '98869')!.id;
    const originalFirstSeen = rows.find((r) => r.server_version_key === '98869')!.first_seen_at;

    // Server stops reporting the 1080p file: tombstoned, never deleted
    await service.upsertItems(server.id, LIBRARY_ID, [buildItem(ratingKey, [V_4K])]);
    rows = await versionRows(server.id, ratingKey);
    expect(rows.find((r) => r.server_version_key === '3207')!.removed_at).toBeNull();
    expect(rows.find((r) => r.server_version_key === '98869')!.removed_at).not.toBeNull();

    // The file comes back: same row revives, first_seen_at preserved
    await service.upsertItems(server.id, LIBRARY_ID, [buildItem(ratingKey, [V_4K, V_1080])]);
    rows = await versionRows(server.id, ratingKey);
    const revived = rows.find((r) => r.server_version_key === '98869')!;
    expect(revived.removed_at).toBeNull();
    expect(revived.id).toBe(originalId1080);
    expect(revived.first_seen_at).toBe(originalFirstSeen);

    // Identical re-sync: the fingerprint no-op guard keeps every row untouched
    const before = new Map(rows.map((r) => [r.server_version_key, r.updated_at]));
    await service.upsertItems(server.id, LIBRARY_ID, [buildItem(ratingKey, [V_4K, V_1080])]);
    rows = await versionRows(server.id, ratingKey);
    for (const row of rows) {
      expect(row.updated_at).toBe(before.get(row.server_version_key));
    }

    // A version-only change (file rename) must break the no-op guard and
    // rewrite the child row even though byte size and resolution are unchanged
    const renamed1080 = { ...V_1080, filePath: '/data/renamed.mkv' };
    await service.upsertItems(server.id, LIBRARY_ID, [buildItem(ratingKey, [V_4K, renamed1080])]);
    rows = await versionRows(server.id, ratingKey);
    expect(rows.find((r) => r.server_version_key === '98869')!.file_path).toBe('/data/renamed.mkv');
  });

  it('hard-deletes the legacy:1 sentinel when real versions replace it', async () => {
    const server = await createTestServer({ type: 'plex' });
    const service = new LibrarySyncService();
    const ratingKey = `migrated-${randomUUID().slice(0, 8)}`;

    // Mimic the migration state: item with a NULL fingerprint plus a sentinel
    const inserted = await db.execute(sql`
      INSERT INTO library_items
        (server_id, library_id, rating_key, title, media_type, year, video_resolution, file_size, created_at)
      VALUES (${server.id}, ${LIBRARY_ID}, ${ratingKey}, 'Migrated Movie', 'movie', 2020, '1080p',
              ${4_100_000_000}, now())
      RETURNING id
    `);
    const itemId = (inserted.rows[0] as { id: string }).id;
    await db.execute(sql`
      INSERT INTO library_item_versions
        (library_item_id, server_version_key, video_resolution, file_size, part_count)
      VALUES (${itemId}, 'legacy:1', '1080p', ${4_100_000_000}, 1)
    `);

    // First real scan: NULL fingerprint IS DISTINCT FROM the computed one, so
    // the diff runs even though the single real version matches the sentinel
    await service.upsertItems(server.id, LIBRARY_ID, [buildItem(ratingKey, [V_1080])]);
    const rows = await versionRows(server.id, ratingKey);
    expect(rows.map((r) => r.server_version_key)).toEqual(['98869']);
  });

  it('cascades an item tombstone to its versions and revives both on re-sync', async () => {
    const server = await createTestServer({ type: 'plex' });
    const service = new LibrarySyncService();
    const ratingKey = `removed-${randomUUID().slice(0, 8)}`;

    await service.upsertItems(server.id, LIBRARY_ID, [buildItem(ratingKey, [V_4K, V_1080])]);
    await service.markItemsRemoved(server.id, LIBRARY_ID, [ratingKey]);

    let rows = await versionRows(server.id, ratingKey);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.removed_at !== null)).toBe(true);
    const itemRow = await db.execute(sql`
      SELECT removed_at FROM library_items
      WHERE server_id = ${server.id} AND rating_key = ${ratingKey}
    `);
    expect((itemRow.rows[0] as { removed_at: string | null }).removed_at).not.toBeNull();

    // The next sync still reports the item: item and versions both revive
    await service.upsertItems(server.id, LIBRARY_ID, [buildItem(ratingKey, [V_4K, V_1080])]);
    rows = await versionRows(server.id, ratingKey);
    expect(rows.every((r) => r.removed_at === null)).toBe(true);
  });

  it('never tombstones versions of an item that is no longer tombstoned', async () => {
    const server = await createTestServer({ type: 'plex' });
    const service = new LibrarySyncService();
    const ratingKey = `raced-${randomUUID().slice(0, 8)}`;

    await service.upsertItems(server.id, LIBRARY_ID, [buildItem(ratingKey, [V_4K, V_1080])]);
    // The guard inside tombstoneVersionsForItems re-checks the parent row, so
    // even when handed the item's id while the item is ACTIVE (the interleaved
    // revival shape), the versions survive
    const itemRow = await db.execute(sql`
      SELECT id FROM library_items WHERE server_id = ${server.id} AND rating_key = ${ratingKey}
    `);
    const itemId = (itemRow.rows[0] as { id: string }).id;
    await db.transaction(async (tx) => {
      await (
        service as unknown as {
          tombstoneVersionsForItems: (t: typeof tx, ids: string[]) => Promise<void>;
        }
      ).tombstoneVersionsForItems(tx, [itemId]);
    });

    const rows = await versionRows(server.id, ratingKey);
    expect(rows.every((r) => r.removed_at === null)).toBe(true);
  });
});

describe('rebuildSnapshotFromDb aggregates in SQL', () => {
  it('matches the overlapping-bucket semantics of the in-memory snapshot path', async () => {
    const server = await createTestServer({ type: 'plex' });
    const service = new LibrarySyncService();
    const libraryId = `lib-${randomUUID().slice(0, 8)}`;

    // Two-version title (4K+1080p: overlaps two buckets, high quality),
    // one plain 720p title, one show container (no file, excluded from
    // validItems but counted as a show)
    await service.upsertItems(server.id, libraryId, [
      buildItem(`snap-two-${randomUUID().slice(0, 6)}`, [V_4K, V_1080]),
      buildItem(`snap-720-${randomUUID().slice(0, 6)}`, [
        {
          serverVersionKey: 'v720',
          videoResolution: '720p',
          videoCodec: 'H264',
          fileSize: 1_000_000_000,
          partCount: 1,
        },
      ]),
    ]);

    const snapshot = await (
      service as unknown as {
        rebuildSnapshotFromDb: (s: string, l: string) => Promise<{ id: string } | null>;
      }
    ).rebuildSnapshotFromDb(server.id, libraryId);
    expect(snapshot).not.toBeNull();

    const row = await db.execute(sql`
      SELECT item_count, total_size::text, count_4k, count_1080p, count_720p, count_sd,
             count_high_quality, version_count, hevc_count, h264_count
      FROM library_snapshots WHERE id = ${snapshot!.id}
    `);
    expect(row.rows[0]).toMatchObject({
      item_count: 2,
      total_size: String(13_330_000_000 + 4_100_000_000 + 1_000_000_000),
      // The two-version title lands in BOTH 4k and 1080p: overlap by design
      count_4k: 1,
      count_1080p: 1,
      count_720p: 1,
      count_sd: 0,
      // Only the 4K+1080p title reaches 1080p or better; 720p does not
      count_high_quality: 1,
      version_count: 3,
      hevc_count: 1,
      h264_count: 2,
    });
  });

  it('buckets 480p on its own, tallies media types, and excludes size-less items', async () => {
    // The full-scan path aggregates snapshots from these rows too, so this
    // pins the scenarios the old in-memory builder's unit tests covered
    const server = await createTestServer({ type: 'plex' });
    const service = new LibrarySyncService();
    const libraryId = `lib-${randomUUID().slice(0, 8)}`;

    const typed = (
      ratingKey: string,
      mediaType: MediaLibraryItem['mediaType'],
      versions: MediaItemVersion[]
    ): MediaLibraryItem => ({ ...buildItem(ratingKey, versions), mediaType });
    const v = (
      key: string,
      videoResolution: string | undefined,
      videoCodec: string | undefined,
      fileSize?: number
    ): MediaItemVersion => ({
      serverVersionKey: key,
      videoResolution,
      videoCodec,
      fileSize,
      partCount: 1,
    });

    await service.upsertItems(server.id, libraryId, [
      typed(`m480-${randomUUID().slice(0, 6)}`, 'movie', [v('a', '480p', 'AV1', 700_000_000)]),
      typed(`ep-${randomUUID().slice(0, 6)}`, 'episode', [v('b', '1080p', 'H264', 900_000_000)]),
      typed(`trk-${randomUUID().slice(0, 6)}`, 'track', [v('c', undefined, undefined, 50_000_000)]),
      typed(`nosize-${randomUUID().slice(0, 6)}`, 'movie', [v('d', '4k', 'HEVC')]),
      typed(`show-${randomUUID().slice(0, 6)}`, 'show', []),
      typed(`season-${randomUUID().slice(0, 6)}`, 'season', []),
    ]);

    const snapshot = await (
      service as unknown as {
        rebuildSnapshotFromDb: (s: string, l: string) => Promise<{ id: string } | null>;
      }
    ).rebuildSnapshotFromDb(server.id, libraryId);
    expect(snapshot).not.toBeNull();

    const row = await db.execute(sql`
      SELECT item_count, total_size::text, movie_count, episode_count, season_count,
             show_count, music_count, count_sd, count_480p, count_1080p, count_4k,
             av1_count, h264_count, hevc_count, version_count
      FROM library_snapshots WHERE id = ${snapshot!.id}
    `);
    expect(row.rows[0]).toMatchObject({
      // The size-less 4k movie contributes nothing anywhere
      item_count: 3,
      total_size: String(700_000_000 + 900_000_000 + 50_000_000),
      movie_count: 1,
      episode_count: 1,
      // Containers count without a file-size gate
      season_count: 1,
      show_count: 1,
      music_count: 1,
      count_sd: 0,
      count_480p: 1,
      count_1080p: 1,
      count_4k: 0,
      av1_count: 1,
      h264_count: 1,
      hevc_count: 0,
      version_count: 3,
    });
  });
});
