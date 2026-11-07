/**
 * The poster a row shows is not always its own image. Jellyfin and Emby give every
 * track its own path even when the bytes are the album's cover, so the cache held one
 * copy per track; and an episode's own image is a 16:9 still that a 2:3 poster crops
 * to a sliver. Both take their parent's art at sync: tracks their album's, episodes
 * their show's. A track whose album has no art keeps its own; an episode whose show
 * has none gets no image.
 *
 * The parent's dominant color comes along, because the image pipeline only computes a
 * color on a cache miss and the parent's poster is usually cached already.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { libraryItems } from '../../db/schema.js';
import type { MediaLibraryItem } from '../mediaServer/types.js';

// Jellyfin/Emby paths carry ?tag= only when the item had a Primary image at
// sync; an untagged /Items path 404s.
export function hasKnownImage(thumbPath: string): boolean {
  return !thumbPath.startsWith('/Items/') || thumbPath.includes('?tag=');
}

export interface ParentArt {
  thumbPath: string;
  dominantColor: string | null;
}

/** The rating key of the row whose art this item shows, or null when it shows its own. */
function artParentKey(item: {
  mediaType: string;
  parentRatingKey?: string | null;
  grandparentRatingKey?: string | null;
}): string | null {
  if (item.mediaType === 'track') return item.parentRatingKey ?? null;
  if (item.mediaType === 'episode') return item.grandparentRatingKey ?? null;
  return null;
}

/** The poster path and color for a batch item: its parent's, its own, or none. */
export function posterOf(
  item: MediaLibraryItem,
  art: ReadonlyMap<string, ParentArt>
): { thumbPath: string | null; dominantColor: string | null } {
  const parentKey = artParentKey(item);
  const parent = parentKey ? art.get(parentKey) : undefined;
  if (parent) return parent;
  return {
    thumbPath: item.mediaType === 'episode' ? null : (item.thumbPath ?? null),
    dominantColor: null,
  };
}

/** Parent rating key to art, for the albums and shows the batch's tracks and episodes belong to. */
export async function parentArtFor(
  serverId: string,
  items: MediaLibraryItem[]
): Promise<Map<string, ParentArt>> {
  const art = new Map<string, ParentArt>();
  const wanted = new Set<string>();
  for (const item of items) {
    if (item.mediaType === 'album' || item.mediaType === 'show') {
      if (item.thumbPath && hasKnownImage(item.thumbPath)) {
        art.set(item.ratingKey, { thumbPath: item.thumbPath, dominantColor: null });
      }
    } else {
      const parentKey = artParentKey(item);
      if (parentKey) wanted.add(parentKey);
    }
  }
  for (const key of art.keys()) wanted.delete(key);
  if (wanted.size === 0) return art;

  const rows = await db
    .select({
      ratingKey: libraryItems.ratingKey,
      thumbPath: libraryItems.thumbPath,
      dominantColor: libraryItems.dominantColor,
    })
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.serverId, serverId),
        inArray(libraryItems.ratingKey, [...wanted]),
        inArray(libraryItems.mediaType, ['album', 'show']),
        isNull(libraryItems.removedAt),
        sql`(${libraryItems.thumbPath} NOT LIKE '/Items/%' OR ${libraryItems.thumbPath} LIKE '%?tag=%')`
      )
    );
  for (const row of rows) {
    if (row.thumbPath) {
      art.set(row.ratingKey, { thumbPath: row.thumbPath, dominantColor: row.dominantColor });
    }
  }
  return art;
}
