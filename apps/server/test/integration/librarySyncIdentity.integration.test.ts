/**
 * Library sync identity integration tests.
 *
 * Confirms upsertItems resolves canonical media identity, stamps genres, and
 * that removals soft-delete (tombstone) rather than hard-delete, with re-upsert
 * clearing the tombstone.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- librarySyncIdentity
 */

import { describe, it, expect } from 'vitest';
import { createTestServer } from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { libraryItems } from '../../src/db/schema.js';
import { librarySyncService } from '../../src/services/librarySync.js';

function makeItem(overrides: Record<string, unknown>) {
  return {
    ratingKey: 'rk-1',
    title: '2 Fast 2 Furious',
    mediaType: 'movie',
    year: 2003,
    imdbId: 'tt0322259',
    tmdbId: 584,
    addedAt: new Date('2024-01-01'),
    genres: ['Action', 'Crime'],
    ...overrides,
  };
}

describe('library sync identity', () => {
  it('upsert stamps media_id and genres, and two servers share one media row', async () => {
    const s1 = await createTestServer({ type: 'plex' });
    const s2 = await createTestServer({ type: 'jellyfin' });
    await librarySyncService.upsertItems(s1.id, 'lib', [makeItem({})] as never);
    await librarySyncService.upsertItems(s2.id, 'lib', [
      makeItem({ imdbId: null, ratingKey: 'jf-9' }),
    ] as never);
    const rows = await db.select().from(libraryItems);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.mediaId).toBeTruthy();
    expect(rows[0]!.mediaId).toBe(rows[1]!.mediaId);
    expect(rows[0]!.genres).toEqual(['Action', 'Crime']);
  });

  it('retires an old copy the server replaced, and keeps one it still has', async () => {
    const s1 = await createTestServer({ type: 'emby' });
    await librarySyncService.upsertItems(s1.id, 'lib', [
      makeItem({ ratingKey: 'old' }),
      makeItem({ ratingKey: 'duplicate' }),
      makeItem({ ratingKey: 'new' }),
    ] as never);
    const client = {
      findExistingRatingKeys: async (keys: string[]) =>
        new Set(keys.filter((key) => key === 'duplicate')),
    };
    const retire = (
      librarySyncService as unknown as {
        retireReplacedCopies: (...args: unknown[]) => Promise<number>;
      }
    ).retireReplacedCopies.bind(librarySyncService);

    const retired = await retire(
      client,
      s1.id,
      { id: 'lib', name: 'Movies', type: 'movie' },
      ['new'],
      new Set<string>()
    );

    const live = (await db.select().from(libraryItems))
      .filter((row) => row.removedAt === null)
      .map((row) => row.ratingKey)
      .sort();
    expect(retired).toBe(1);
    expect(live).toEqual(['duplicate', 'new']);
  });

  it('markItemsRemoved soft-deletes and re-upsert clears the tombstone', async () => {
    const s1 = await createTestServer({ type: 'plex' });
    await librarySyncService.upsertItems(s1.id, 'lib', [makeItem({})] as never);
    await librarySyncService.markItemsRemoved(s1.id, 'lib', ['rk-1']);
    let [row] = await db.select().from(libraryItems);
    expect(row!.removedAt).not.toBeNull();
    await librarySyncService.upsertItems(s1.id, 'lib', [makeItem({})] as never);
    [row] = await db.select().from(libraryItems);
    expect(row!.removedAt).toBeNull();
  });

  it('tombstone reuse with a different item overwrites and re-resolves identity', async () => {
    const s1 = await createTestServer({ type: 'plex' });
    await librarySyncService.upsertItems(s1.id, 'lib', [makeItem({})] as never);
    await librarySyncService.markItemsRemoved(s1.id, 'lib', ['rk-1']);
    const [before] = await db.select().from(libraryItems);
    await librarySyncService.upsertItems(s1.id, 'lib', [
      makeItem({ title: 'Different Movie', imdbId: 'tt9999999', tmdbId: 7777 }),
    ] as never);
    const [after] = await db.select().from(libraryItems);
    expect(after!.removedAt).toBeNull();
    expect(after!.mediaId).not.toBe(before!.mediaId);
  });

  it('re-upserting a byte-identical item leaves updated_at untouched', async () => {
    const s1 = await createTestServer({ type: 'plex' });
    await librarySyncService.upsertItems(s1.id, 'lib', [makeItem({})] as never);
    const [before] = await db.select().from(libraryItems);

    await librarySyncService.upsertItems(s1.id, 'lib', [makeItem({})] as never);
    const [after] = await db.select().from(libraryItems);

    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    expect(after!.mediaId).toBe(before!.mediaId);
  });

  it('re-upserting with one changed tracked column still writes and bumps updated_at', async () => {
    const s1 = await createTestServer({ type: 'plex' });
    await librarySyncService.upsertItems(s1.id, 'lib', [makeItem({})] as never);
    const [before] = await db.select().from(libraryItems);

    await librarySyncService.upsertItems(s1.id, 'lib', [
      makeItem({ videoResolution: '4k' }),
    ] as never);
    const [after] = await db.select().from(libraryItems);

    expect(after!.videoResolution).toBe('4k');
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });
});
