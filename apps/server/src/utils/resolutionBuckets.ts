/**
 * SQL fragments for resolution bucketing, generated from the shared ladder in
 * @tracearr/shared/resolution so database bucketing agrees with
 * resolutionBucket() by construction. Used by the snapshot writer's SQL twin
 * (the history backfill), the facet endpoints, and best-of-copies ranking.
 */

import { sql, type SQL } from 'drizzle-orm';
import {
  RESOLUTION_BUCKETS,
  resolutionBucketSpellings,
  resolutionAboveSdSpellings,
  resolutionSpellingRanks,
  type ResolutionBucket,
  type ResolutionCounts,
} from '@tracearr/shared';

const quoteList = (values: string[]): string => values.map((v) => `'${v}'`).join(', ');

type AboveSdBucket = Exclude<ResolutionBucket, 'sd'>;

const IN_LIST = Object.fromEntries(
  RESOLUTION_BUCKETS.filter((bucket): bucket is AboveSdBucket => bucket !== 'sd').map((bucket) => [
    bucket,
    quoteList(resolutionBucketSpellings(bucket)),
  ])
) as Record<AboveSdBucket, string>;

const ABOVE_SD_LIST = quoteList(resolutionAboveSdSpellings());

/**
 * Predicate for membership in one of the snapshot buckets.
 *
 * @param column - Trusted column expression, e.g. 'video_resolution' or
 *   'li.video_resolution'. Interpolated raw; never pass user input.
 * @param opts.includeNullAsSd - Endpoint display rule that counts NULL into
 *   the sd bucket. Snapshot writers exclude NULL.
 */
export function resolutionBucketPredicate(
  column: string,
  bucket: ResolutionBucket,
  opts?: { includeNullAsSd?: boolean }
): SQL {
  const col = sql.raw(column);
  if (bucket === 'sd') {
    return opts?.includeNullAsSd
      ? sql`(${col} IS NULL OR ${col} NOT IN (${sql.raw(ABOVE_SD_LIST)}))`
      : sql`(${col} IS NOT NULL AND ${col} NOT IN (${sql.raw(ABOVE_SD_LIST)}))`;
  }
  return sql`${col} IN (${sql.raw(IN_LIST[bucket])})`;
}

/** Bucket names are fixed identifiers, so the fragments can go in raw. */
export function perResolutionBucket(fragment: (bucket: ResolutionBucket) => string): SQL {
  return sql.raw(RESOLUTION_BUCKETS.map(fragment).join(', '));
}

/** `BOOL_OR(...) AS has_<bucket>` for every bucket, for an item rollup's SELECT list. */
export function bucketMembershipColumns(
  versionColumn: string,
  opts?: { includeNullAsSd?: boolean }
): SQL {
  return sql.join(
    RESOLUTION_BUCKETS.map(
      (bucket) =>
        sql`BOOL_OR(${resolutionBucketPredicate(versionColumn, bucket, opts)}) AS ${sql.raw(`has_${bucket}`)}`
    ),
    sql`, `
  );
}

/**
 * Joins `vb.has_<bucket>` flags onto each item, reading its active versions
 * once however many buckets there are (a per-bucket EXISTS costs one index
 * probe per bucket). A 4K+1080p title carries both flags; an item with no
 * versions gets NULL flags, which count as false.
 *
 * @param itemIdColumn - Trusted column expression for the library_items id,
 *   e.g. 'library_items.id' or 'li.id'. Interpolated raw; never user input.
 */
export function versionBucketFlagsJoin(
  itemIdColumn: string,
  opts?: { includeNullAsSd?: boolean }
): SQL {
  return sql`LEFT JOIN LATERAL (
    SELECT ${bucketMembershipColumns('liv.video_resolution', opts)}
    FROM library_item_versions liv
    WHERE liv.library_item_id = ${sql.raw(itemIdColumn)}
      AND liv.removed_at IS NULL
  ) vb ON true`;
}

/** Reads `count_<bucket>` columns off a result row; a missing row or column reads as zero. */
export function readResolutionCounts(row: Record<string, unknown> | undefined): ResolutionCounts {
  return Object.fromEntries(
    RESOLUTION_BUCKETS.map((bucket) => [bucket, Number(row?.[`count_${bucket}`] ?? 0)])
  ) as ResolutionCounts;
}

const RANK_CASE_ARMS = resolutionSpellingRanks()
  .map(({ spelling, rank }) => `WHEN '${spelling}' THEN ${rank}`)
  .join(' ');

/**
 * CASE expression ranking a resolution column by tier (higher = better).
 * NULL and unknown labels rank 0. Mirrors resolutionTierRank for the stored
 * spellings; use with ARRAY_AGG(... ORDER BY ... DESC) to pick the best
 * actual label instead of comparing labels lexicographically.
 */
export function resolutionRankSql(column: string): SQL {
  return sql.raw(`CASE ${column} ${RANK_CASE_ARMS} ELSE 0 END`);
}
