/**
 * Version rollup helpers shared by the Plex and JF/Emby library parsers.
 * The flat quality columns on library_items are rollups over the version
 * list: file_size sums, everything else comes from the best version.
 */

import { createHash } from 'node:crypto';
import { resolutionTierRank } from '@tracearr/shared';
import type { MediaItemVersion } from '../types.js';

/**
 * Deterministic hash over the version set, order-insensitive. Joins the item
 * upsert's setWhere guard so version-only changes update the parent row and
 * trigger reconciliation; steady-state full scans stay no-ops.
 */
export function computeVersionsFingerprint(versions: MediaItemVersion[]): string {
  // Every mutable version field participates: several (container, bitrate,
  // part count, a non-best version's path or audio fields) have no flat
  // library_items mirror, so this hash is the ONLY change signal that can
  // get their rows rewritten by reconciliation.
  const tuples = versions
    .map((v) =>
      [
        v.serverVersionKey,
        v.fileSize ?? '',
        v.videoResolution ?? '',
        v.videoCodec ?? '',
        v.videoDynamicRange ?? '',
        v.audioCodec ?? '',
        v.audioChannels ?? '',
        v.audioAtmos ? 'atmos' : '',
        v.editionTitle ?? '',
        v.container ?? '',
        v.bitrate ?? '',
        v.partCount,
        v.filePath ?? '',
      ].join(':')
    )
    .sort();
  return createHash('sha1').update(tuples.join('|')).digest('hex');
}

/**
 * Best version by resolution tier, then bitrate, with the version key as the
 * final tiebreak so the rollup is deterministic across syncs.
 */
export function pickBestVersion(versions: MediaItemVersion[]): MediaItemVersion | undefined {
  return versions.toSorted(
    (a, b) =>
      (resolutionTierRank(b.videoResolution) ?? 0) - (resolutionTierRank(a.videoResolution) ?? 0) ||
      (b.bitrate ?? 0) - (a.bitrate ?? 0) ||
      a.serverVersionKey.localeCompare(b.serverVersionKey)
  )[0];
}

/** Sum of version sizes, or undefined when no version carries a size. */
export function sumVersionSizes(versions: MediaItemVersion[]): number | undefined {
  let total = 0;
  let seen = false;
  for (const v of versions) {
    if (typeof v.fileSize === 'number') {
      total += v.fileSize;
      seen = true;
    }
  }
  return seen ? total : undefined;
}
