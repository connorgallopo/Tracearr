/**
 * Album rows through a library sync on real Postgres: the Plex album
 * lands beside its artist and tracks, survives a rescan while the server
 * still lists it, and is tombstoned alone once it is gone; Emby tracks take
 * their album cover path.
 *
 * Run with: pnpm --filter @tracearr/server test:integration librarySyncAlbums
 */

import { describe, it, expect, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { REDIS_KEYS } from '@tracearr/shared';
import { createTestServer } from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { libraryItems } from '../../src/db/schema.js';
import {
  createMediaServerClient,
  type MediaLibraryItem,
} from '../../src/services/mediaServer/index.js';
import { getRedis } from '../../src/lib/redisShared.js';
import { initLibrarySyncRedis, librarySyncService } from '../../src/services/librarySync.js';

vi.mock('../../src/services/mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(),
}));

const LIBRARY_ID = 'music';
const ALBUM_ADDED_AT = new Date('2023-04-12T18:30:00Z');

const artist: MediaLibraryItem = {
  ratingKey: 'artist-1',
  title: 'Massive Attack',
  mediaType: 'artist',
  addedAt: new Date('2023-04-12T18:00:00Z'),
};

const album: MediaLibraryItem = {
  ratingKey: 'album-1',
  title: 'Mezzanine',
  mediaType: 'album',
  year: 1998,
  addedAt: ALBUM_ADDED_AT,
  thumbPath: '/library/metadata/album-1/thumb/1681324200',
  parentRatingKey: 'artist-1',
  parentTitle: 'Massive Attack',
  genres: ['Trip Hop'],
};

const tracks: MediaLibraryItem[] = ['Angel', 'Teardrop'].map((title, i) => ({
  ratingKey: `track-${i + 1}`,
  title,
  mediaType: 'track',
  addedAt: ALBUM_ADDED_AT,
  parentRatingKey: 'album-1',
  parentTitle: 'Mezzanine',
  grandparentRatingKey: 'artist-1',
  grandparentTitle: 'Massive Attack',
  itemIndex: i + 1,
}));

function page(items: MediaLibraryItem[], options?: { offset?: number }) {
  return Promise.resolve({
    items: (options?.offset ?? 0) === 0 ? items : [],
    totalCount: items.length,
  });
}

function stubPlexClient(albums: MediaLibraryItem[]) {
  vi.mocked(createMediaServerClient).mockReturnValue({
    serverType: 'plex',
    testConnection: () => Promise.resolve(true),
    getLibraries: () => Promise.resolve([{ id: LIBRARY_ID, name: 'Music', type: 'artist' }]),
    getLibraryItems: (_id: string, options?: { offset?: number }) => page([artist], options),
    getLibraryLeaves: (_id: string, options?: { offset?: number }) => page(tracks, options),
    getLibraryAlbums: (_id: string, options?: { offset?: number }) => page(albums, options),
    findExistingRatingKeys: () => Promise.resolve(new Set<string>()),
  } as never);
}

async function rowsByKey(serverId: string) {
  const rows = await db
    .select()
    .from(libraryItems)
    .where(and(eq(libraryItems.serverId, serverId), eq(libraryItems.libraryId, LIBRARY_ID)));
  return new Map(rows.map((row) => [row.ratingKey, row]));
}

describe('library sync album rows', () => {
  it('points Emby tracks at their album cover and leaves tracks of untagged albums alone', async () => {
    const server = await createTestServer({ type: 'emby' });
    const embyTrack = (ratingKey: string, albumKey: string): MediaLibraryItem => ({
      ratingKey,
      title: ratingKey,
      mediaType: 'track',
      addedAt: ALBUM_ADDED_AT,
      parentRatingKey: albumKey,
      thumbPath: `/Items/${ratingKey}/Images/Primary?tag=${ratingKey}`,
    });
    const covered: MediaLibraryItem = {
      ...album,
      ratingKey: '100',
      thumbPath: '/Items/101/Images/Primary?tag=cover',
    };
    const untagged: MediaLibraryItem = {
      ...album,
      ratingKey: '200',
      thumbPath: '/Items/200/Images/Primary',
    };

    await librarySyncService.upsertItems(server.id, LIBRARY_ID, [covered, untagged]);
    await librarySyncService.upsertItems(server.id, LIBRARY_ID, [
      embyTrack('101', '100'),
      embyTrack('102', '100'),
      embyTrack('201', '200'),
    ]);
    const later: MediaLibraryItem = {
      ...album,
      ratingKey: '300',
      thumbPath: '/Items/300/Images/Primary?tag=own',
    };
    await librarySyncService.upsertItems(server.id, LIBRARY_ID, [later, embyTrack('301', '300')]);

    const rows = await rowsByKey(server.id);
    expect(rows.get('101')?.thumbPath).toBe('/Items/101/Images/Primary?tag=cover');
    expect(rows.get('102')?.thumbPath).toBe('/Items/101/Images/Primary?tag=cover');
    expect(rows.get('201')?.thumbPath).toBe('/Items/201/Images/Primary?tag=201');
    expect(rows.get('301')?.thumbPath).toBe('/Items/300/Images/Primary?tag=own');
  });

  it('stores the album under its artist, keeps it on rescan and tombstones it alone once gone', async () => {
    const server = await createTestServer({ type: 'plex' });

    stubPlexClient([album]);
    await librarySyncService.syncServer(server.id, undefined, 'manual');

    let rows = await rowsByKey(server.id);
    const albumRows = [...rows.values()].filter((row) => row.mediaType === 'album');
    expect(albumRows).toHaveLength(1);
    expect(albumRows[0]).toMatchObject({
      ratingKey: 'album-1',
      parentRatingKey: 'artist-1',
      createdAt: ALBUM_ADDED_AT,
      removedAt: null,
    });
    expect(rows.size).toBe(4);

    await librarySyncService.syncServer(server.id, undefined, 'manual');
    rows = await rowsByKey(server.id);
    expect(rows.get('album-1')?.removedAt).toBeNull();

    stubPlexClient([]);
    await librarySyncService.syncServer(server.id, undefined, 'manual');
    rows = await rowsByKey(server.id);
    expect(rows.get('album-1')?.removedAt).toBeInstanceOf(Date);
    expect(rows.get('artist-1')?.removedAt).toBeNull();
  });

  it('dates albums from a version-bump scan by their added date and later albums by the scan', async () => {
    initLibrarySyncRedis(getRedis());
    const server = await createTestServer({ type: 'plex' });
    const backfilled: MediaLibraryItem = {
      ...album,
      ratingKey: 'album-2',
      title: 'Protection',
      addedAt: new Date('2019-02-01T09:00:00Z'),
    };
    const fresh: MediaLibraryItem = { ...album, ratingKey: 'album-3', title: 'Heligoland' };

    stubPlexClient([album]);
    await librarySyncService.syncServer(server.id, undefined, 'manual');

    await getRedis().set(REDIS_KEYS.LIBRARY_SYNC_SCAN_VERSION(server.id, LIBRARY_ID), '3');
    stubPlexClient([album, backfilled]);
    await librarySyncService.syncServer(server.id, undefined, 'manual');

    let rows = await rowsByKey(server.id);
    expect(rows.get('album-2')?.firstSeenAt).toEqual(rows.get('album-2')?.createdAt);

    const beforeLaterScan = new Date();
    stubPlexClient([album, backfilled, fresh]);
    await librarySyncService.syncServer(server.id, undefined, 'manual');

    rows = await rowsByKey(server.id);
    expect(rows.get('album-3')?.firstSeenAt?.getTime()).toBeGreaterThanOrEqual(
      beforeLaterScan.getTime()
    );
  });
});
