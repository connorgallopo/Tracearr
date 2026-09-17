/**
 * Resolution Classification
 *
 * Single source of truth for turning video dimensions and/or a media server's
 * resolution label into a resolution tier ("4K", "1080p", etc), and for the
 * name a person reads. Every classifier and display in the app (session
 * ingest, library sync, rules, web/mobile) goes through this module instead of
 * hand-rolling its own cutoffs or casing.
 */

/** Resolution tier rank (higher = better quality). */
export const RESOLUTION_TIERS = {
  '8K': 7,
  '4K': 6,
  '1440p': 5,
  '1080p': 4,
  '720p': 3,
  '480p': 2,
  SD: 1,
} as const;

export type ResolutionLabel = keyof typeof RESOLUTION_TIERS;

/** Every tier, best first: the order charts, filters and rule options list them in. */
export const RESOLUTION_LABELS: readonly ResolutionLabel[] = [
  '8K',
  '4K',
  '1440p',
  '1080p',
  '720p',
  '480p',
  'SD',
];

interface DimensionTier {
  label: ResolutionLabel;
  minWidth: number;
  minHeight: number;
}

const DIMENSION_LADDER: DimensionTier[] = [
  { label: '8K', minWidth: 6400, minHeight: 4000 },
  { label: '4K', minWidth: 3800, minHeight: 2000 },
  { label: '1440p', minWidth: 2500, minHeight: 1400 },
  { label: '1080p', minWidth: 1800, minHeight: 1000 },
  { label: '720p', minWidth: 1200, minHeight: 700 },
  { label: '480p', minWidth: 700, minHeight: 400 },
];

/** Either axis qualifies, so cropped widescreen (1920x800) and 4:3 (1440x1080) land on their real tier. */
export function classifyByDimensions(
  width: number | null | undefined,
  height: number | null | undefined
): ResolutionLabel | null {
  if (!width && !height) return null;

  for (const tier of DIMENSION_LADDER) {
    if ((width && width >= tier.minWidth) || (height && height >= tier.minHeight)) {
      return tier.label;
    }
  }

  return 'SD';
}

/**
 * Word labels from Plex/Jellyfin/Emby/Tautulli. "2k" is 1080p: Plex applies it
 * to DCI 2K (2048x1080) and 2160x1080 as well as 2560x1440, and only pixels can
 * tell those apart.
 */
const WORD_LABELS: Record<string, ResolutionLabel> = {
  '8k': '8K',
  '4k': '4K',
  uhd: '4K',
  qhd: '1440p',
  '2k': '1080p',
  fhd: '1080p',
  hd: '720p',
  sd: 'SD',
};

/** A bare line count ("576", "1080p", "1080i") is a height. */
const LINE_COUNT_LABEL = /^(\d+)[pi]?$/;

/** The tier a label names, in display casing, or null when it names none. */
export function normalizeResolutionLabel(label: string | null | undefined): ResolutionLabel | null {
  if (!label) return null;
  const lower = label.toLowerCase().trim();
  if (!lower) return null;

  const word = WORD_LABELS[lower];
  if (word) return word;

  const lines = LINE_COUNT_LABEL.exec(lower);
  return lines ? classifyByDimensions(null, Number(lines[1])) : null;
}

/** Rank of a resolution label for magnitude comparisons, or null if unknown. */
export function resolutionTierRank(label: string | null | undefined): number | null {
  const tier = normalizeResolutionLabel(label);
  return tier ? RESOLUTION_TIERS[tier] : null;
}

/** The bucket vocabulary library snapshots and facet endpoints store: one per tier. */
export type ResolutionBucket = Lowercase<ResolutionLabel>;

export const RESOLUTION_BUCKETS: readonly ResolutionBucket[] = RESOLUTION_LABELS.map(
  (label) => label.toLowerCase() as ResolutionBucket
);

/** Unknown non-null labels count as sd; null stays null (no video). */
export function resolutionBucket(label: string | null | undefined): ResolutionBucket | null {
  if (!label) return null;
  const tier = normalizeResolutionLabel(label);
  return tier ? (tier.toLowerCase() as ResolutionBucket) : 'sd';
}

/** Line counts older rows and imports may still carry before a resync rewrites them. */
const STORED_LINE_COUNTS = [4320, 2160, 1440, 1080, 720, 576, 540, 480, 360, 240];

const KNOWN_SPELLINGS = [
  ...new Set([
    ...RESOLUTION_BUCKETS,
    ...Object.keys(WORD_LABELS),
    ...STORED_LINE_COUNTS.flatMap((lines) => [`${lines}`, `${lines}p`]),
  ]),
];

/**
 * Every known spelling that falls in the given bucket, lowercase. Backs the
 * SQL IN-lists in resolutionBuckets.ts so database bucketing cannot drift
 * from resolutionBucket(). The sd bucket has no list: in SQL it is the
 * non-null complement of the others.
 */
export function resolutionBucketSpellings(bucket: Exclude<ResolutionBucket, 'sd'>): string[] {
  return KNOWN_SPELLINGS.filter((spelling) => resolutionBucket(spelling) === bucket);
}

/** All spellings that rank above the sd bucket, for SQL complement predicates. */
export function resolutionAboveSdSpellings(): string[] {
  return KNOWN_SPELLINGS.filter((spelling) => resolutionBucket(spelling) !== 'sd');
}

/** Known spellings paired with their tier rank, for SQL rank CASE expressions. */
export function resolutionSpellingRanks(): Array<{ spelling: string; rank: number }> {
  return KNOWN_SPELLINGS.map((spelling) => ({
    spelling,
    rank: resolutionTierRank(spelling) ?? 0,
  }));
}

export interface ResolutionInput {
  /** Resolution label from the media server (e.g. "1080", "4k", "sd") */
  label?: string | null;
  /** Video width in pixels */
  width?: number | null;
  /** Video height in pixels */
  height?: number | null;
}

// Pixels win over the label: servers label the same geometry differently
// (Plex calls 2160x1080 "2K", which reads as 1440p), while dimensions go
// through one ladder for every server. The label only fills in when a payload
// carries no dimensions.
export function normalizeResolution(input: ResolutionInput): ResolutionLabel | null {
  const { label, width, height } = input;
  return classifyByDimensions(width, height) ?? normalizeResolutionLabel(label);
}
