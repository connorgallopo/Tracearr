/**
 * tofa sessions name only the media and file they play. The kind of item, the show, season,
 * episode and year come from the media itself, read in batches and kept for an hour so a
 * playing session costs no lookup on each poll. A file the read did not describe is not asked
 * about again for a few minutes, since a show is read whole, about 350 KB, to look for it.
 */

import type { TofaClient } from './client.js';
import { parseTofaMedia } from './parser.js';
import type { TofaMedia } from './types.js';

const BATCH_SIZE = 50;
const CACHE_TTL_MS = 60 * 60 * 1000;
const MISS_TTL_MS = 5 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 5_000;

const cache = new Map<string, { media: TofaMedia; expiresAt: number }>();
/** Media and file pairs a read did not describe: an id it did not return, or a show without the file */
const misses = new Map<string, { expiresAt: number }>();

function describesFile(media: TofaMedia | undefined, fileId: string): boolean {
  return media !== undefined && (media.kind !== 'tv' || media.episodesByFile.has(fileId));
}

/**
 * Media for the given ids, keyed by media id. A failed batch leaves its ids out, so the
 * session records what it carried and the next poll asks again. A show cached before a new
 * episode file arrived is asked again.
 */
export async function lookupTofaMedia(
  client: Pick<TofaClient, 'url' | 'getMediaBatch'>,
  wanted: { mediaId: string; fileId: string }[]
): Promise<Map<string, TofaMedia>> {
  const now = Date.now();
  for (const entries of [cache, misses]) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  }

  const found = new Map<string, TofaMedia>();
  const missing = new Set<string>();
  for (const { mediaId, fileId } of wanted) {
    const cached = cache.get(`${client.url}:${mediaId}`)?.media;
    if (describesFile(cached, fileId) || misses.has(`${client.url}:${mediaId}:${fileId}`)) {
      if (cached) found.set(mediaId, cached);
    } else {
      missing.add(mediaId);
    }
  }

  const ids = [...missing];
  const asked = new Set<string>();
  for (let start = 0; start < ids.length; start += BATCH_SIZE) {
    const batch = ids.slice(start, start + BATCH_SIZE);
    try {
      for (const detail of await client.getMediaBatch(batch, LOOKUP_TIMEOUT_MS)) {
        const media = parseTofaMedia(detail);
        cache.set(`${client.url}:${detail.id}`, { media, expiresAt: now + CACHE_TTL_MS });
        found.set(detail.id, media);
      }
      for (const id of batch) asked.add(id);
    } catch (error) {
      console.warn(`[tofa] Media lookup failed for ${batch.length} item(s):`, error);
    }
  }
  for (const { mediaId, fileId } of wanted) {
    if (asked.has(mediaId) && !describesFile(found.get(mediaId), fileId)) {
      misses.set(`${client.url}:${mediaId}:${fileId}`, { expiresAt: now + MISS_TTL_MS });
    }
  }
  return found;
}
