/**
 * Episode art through a library sync on real Postgres: an episode stores its show's
 * poster and color instead of its own 16:9 still, a row synced before that moves over,
 * and a row showing its own art keeps its color when the poster changes.
 *
 * Run with: pnpm --filter @tracearr/server test:integration librarySyncEpisodeArt
 */

import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestServer } from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { libraryItems } from '../../src/db/schema.js';
import type { MediaLibraryItem } from '../../src/services/mediaServer/index.js';
import { librarySyncService } from '../../src/services/librarySync.js';

const LIBRARY_ID = 'tv';
const ADDED_AT = new Date('2026-11-05T20:00:00Z');
const SHOW_POSTER = '/library/metadata/show-1/thumb/1762300000';
const SHOW_COLOR = '#1d2b3a';

const show: MediaLibraryItem = {
  ratingKey: 'show-1',
  title: 'The Daily Show',
  mediaType: 'show',
  addedAt: ADDED_AT,
  thumbPath: SHOW_POSTER,
};

const episode = (ratingKey: string, showKey: string): MediaLibraryItem => ({
  ratingKey,
  title: 'Grandmaster Flash',
  mediaType: 'episode',
  addedAt: ADDED_AT,
  thumbPath: `/library/metadata/${ratingKey}/thumb/1762300100`,
  grandparentRatingKey: showKey,
  grandparentTitle: 'The Daily Show',
  parentIndex: 31,
  itemIndex: 126,
});

async function rowOf(serverId: string, ratingKey: string) {
  const [row] = await db
    .select({ thumbPath: libraryItems.thumbPath, dominantColor: libraryItems.dominantColor })
    .from(libraryItems)
    .where(and(eq(libraryItems.serverId, serverId), eq(libraryItems.ratingKey, ratingKey)));
  return row;
}

async function colorRow(serverId: string, ratingKey: string, dominantColor: string) {
  await db
    .update(libraryItems)
    .set({ dominantColor })
    .where(and(eq(libraryItems.serverId, serverId), eq(libraryItems.ratingKey, ratingKey)));
}

describe('library sync episode art', () => {
  it("stores the show's poster and color on new episodes, and none when the show is unknown", async () => {
    const server = await createTestServer({ type: 'plex' });
    await librarySyncService.upsertItems(server.id, LIBRARY_ID, [show]);
    await colorRow(server.id, 'show-1', SHOW_COLOR);

    await librarySyncService.upsertItems(server.id, LIBRARY_ID, [
      episode('ep-1', 'show-1'),
      episode('ep-2', 'show-missing'),
    ]);

    expect(await rowOf(server.id, 'ep-1')).toEqual({
      thumbPath: SHOW_POSTER,
      dominantColor: SHOW_COLOR,
    });
    expect(await rowOf(server.id, 'ep-2')).toEqual({ thumbPath: null, dominantColor: null });
  });

  it("moves an episode synced with its still onto the show's poster and color", async () => {
    const server = await createTestServer({ type: 'plex' });
    await librarySyncService.upsertItems(server.id, LIBRARY_ID, [episode('ep-1', 'show-1')]);
    await db
      .update(libraryItems)
      .set({ thumbPath: '/library/metadata/ep-1/thumb/1762300100', dominantColor: '#f0e0d0' })
      .where(and(eq(libraryItems.serverId, server.id), eq(libraryItems.ratingKey, 'ep-1')));
    await librarySyncService.upsertItems(server.id, LIBRARY_ID, [show]);
    await colorRow(server.id, 'show-1', SHOW_COLOR);

    await librarySyncService.upsertItems(server.id, LIBRARY_ID, [episode('ep-1', 'show-1')]);

    expect(await rowOf(server.id, 'ep-1')).toEqual({
      thumbPath: SHOW_POSTER,
      dominantColor: SHOW_COLOR,
    });
  });

  it('keeps the color of a row showing its own art when its poster changes', async () => {
    const server = await createTestServer({ type: 'plex' });
    await librarySyncService.upsertItems(server.id, LIBRARY_ID, [show]);
    await colorRow(server.id, 'show-1', SHOW_COLOR);

    await librarySyncService.upsertItems(server.id, LIBRARY_ID, [
      { ...show, thumbPath: '/library/metadata/show-1/thumb/1762400000' },
    ]);

    expect(await rowOf(server.id, 'show-1')).toEqual({
      thumbPath: '/library/metadata/show-1/thumb/1762400000',
      dominantColor: SHOW_COLOR,
    });
  });
});
