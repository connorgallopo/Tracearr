import { describe, it, expect } from 'vitest';
import {
  classifyByDimensions,
  normalizeResolutionLabel,
  normalizeResolution,
  resolutionTierRank,
  resolutionBucket,
  resolutionBucketSpellings,
  resolutionAboveSdSpellings,
  resolutionSpellingRanks,
  RESOLUTION_BUCKETS,
  RESOLUTION_TIERS,
} from '../resolution.js';

describe('classifyByDimensions', () => {
  // Golden table - see docs for the underlying research (jellyfin-web /
  // Radarr / Sonarr "closest resolution" bands).
  it.each([
    [1916, 1036, '1080p'], // Issue #798: near-cutoff widescreen source
    [1920, 804, '1080p'],
    [1440, 1080, '1080p'], // 4:3 aspect ratio
    [1920, 1080, '1080p'],
    [1800, 1, '1080p'], // exact width threshold
    [1490, 1, '720p'],
    [1280, 536, '720p'], // widescreen scope at 720p
    [1280, 720, '720p'],
    [3840, 2160, '4K'],
    [3840, 1600, '4K'],
    [3800, 1, '4K'], // exact width threshold
    [2560, 1440, '1440p'],
    [720, 480, '480p'],
  ])('classifies %ix%i as %s', (width, height, expected) => {
    expect(classifyByDimensions(width, height)).toBe(expected);
  });

  it('uses height alone when width is missing', () => {
    expect(classifyByDimensions(null, 1080)).toBe('1080p');
  });

  it('uses width alone when height is missing', () => {
    expect(classifyByDimensions(1920, null)).toBe('1080p');
  });

  it('returns SD below every band', () => {
    expect(classifyByDimensions(320, 240)).toBe('SD');
  });

  it('returns 8K for the extended top band', () => {
    expect(classifyByDimensions(7680, 4320)).toBe('8K');
    expect(classifyByDimensions(6400, 1)).toBe('8K');
  });

  it('returns null when no dimensions are provided', () => {
    expect(classifyByDimensions(null, null)).toBeNull();
    expect(classifyByDimensions(undefined, undefined)).toBeNull();
  });
});

describe('normalizeResolutionLabel', () => {
  it('maps known Plex/Tautulli labels to the app vocabulary', () => {
    expect(normalizeResolutionLabel('sd')).toBe('SD');
    expect(normalizeResolutionLabel('480')).toBe('480p');
    expect(normalizeResolutionLabel('576')).toBe('480p');
    expect(normalizeResolutionLabel('720')).toBe('720p');
    expect(normalizeResolutionLabel('1080')).toBe('1080p');
    expect(normalizeResolutionLabel('4k')).toBe('4K');
    expect(normalizeResolutionLabel('8k')).toBe('8K');
    expect(normalizeResolutionLabel('qhd')).toBe('1440p');
  });

  it('reads 2k as 1080p since Plex applies it to 2048x1080 and 2160x1080', () => {
    expect(normalizeResolutionLabel('2k')).toBe('1080p');
  });

  it('is case insensitive', () => {
    expect(normalizeResolutionLabel('4K')).toBe('4K');
    expect(normalizeResolutionLabel('SD')).toBe('SD');
    expect(normalizeResolutionLabel('1080P')).toBe('1080p');
  });

  it('classifies bare line counts by height', () => {
    expect(normalizeResolutionLabel('540')).toBe('480p');
    expect(normalizeResolutionLabel('1440')).toBe('1440p');
    expect(normalizeResolutionLabel('1080i')).toBe('1080p');
    expect(normalizeResolutionLabel('360')).toBe('SD');
  });

  it('returns null for labels that name no tier', () => {
    expect(normalizeResolutionLabel('custom')).toBeNull();
  });

  it('returns null for missing/empty labels', () => {
    expect(normalizeResolutionLabel(undefined)).toBeNull();
    expect(normalizeResolutionLabel(null)).toBeNull();
    expect(normalizeResolutionLabel('')).toBeNull();
  });
});

describe('normalizeResolution (pixels-first precedence)', () => {
  it('classifies by dimensions even when the label disagrees', () => {
    // Issue #1185: Plex labels 2160x1080 and 2560x1440 alike as "2k"
    expect(normalizeResolution({ label: '2k', width: 2160, height: 1080 })).toBe('1080p');
    expect(normalizeResolution({ label: '2k', width: 2560, height: 1440 })).toBe('1440p');
    expect(normalizeResolution({ label: '720', width: 1916, height: 1036 })).toBe('1080p');
  });

  it('falls back to dimensions when no label is present', () => {
    expect(normalizeResolution({ width: 1916, height: 1036 })).toBe('1080p');
  });

  it('falls back to dimensions when the label is empty', () => {
    expect(normalizeResolution({ label: '', width: 1280, height: 720 })).toBe('720p');
  });

  it('returns null when nothing is provided', () => {
    expect(normalizeResolution({})).toBeNull();
  });
});

describe('resolutionTierRank', () => {
  it('ranks known tiers in ascending quality order', () => {
    expect(resolutionTierRank('SD')).toBe(RESOLUTION_TIERS.SD);
    expect(resolutionTierRank('480p')).toBe(RESOLUTION_TIERS['480p']);
    expect(resolutionTierRank('1080')).toBe(RESOLUTION_TIERS['1080p']);
    expect(resolutionTierRank('4k')).toBe(RESOLUTION_TIERS['4K']);
    expect(resolutionTierRank('8k')).toBe(RESOLUTION_TIERS['8K']);
    expect(resolutionTierRank('4k')).toBeGreaterThan(resolutionTierRank('1080p')!);
  });

  it('ranks line counts by the tier their height falls in', () => {
    expect(resolutionTierRank('576')).toBe(RESOLUTION_TIERS['480p']);
  });

  it('returns null for unknown labels', () => {
    expect(resolutionTierRank('weird')).toBeNull();
    expect(resolutionTierRank(undefined)).toBeNull();
  });
});

describe('resolutionBucket', () => {
  it('gives every tier its own bucket', () => {
    expect(resolutionBucket('8k')).toBe('8k');
    expect(resolutionBucket('4k')).toBe('4k');
    expect(resolutionBucket('2160')).toBe('4k');
    expect(resolutionBucket('1440p')).toBe('1440p');
    expect(resolutionBucket('1080p')).toBe('1080p');
    expect(resolutionBucket('720p')).toBe('720p');
    expect(resolutionBucket('576')).toBe('480p');
    expect(resolutionBucket('480p')).toBe('480p');
    expect(resolutionBucket('sd')).toBe('sd');
  });

  it('counts unknown non-null labels as sd and keeps null as null', () => {
    expect(resolutionBucket('weird')).toBe('sd');
    expect(resolutionBucket(null)).toBeNull();
    expect(resolutionBucket(undefined)).toBeNull();
  });
});

describe('resolution bucket spellings', () => {
  it('partitions spellings without overlap', () => {
    const buckets = RESOLUTION_BUCKETS.filter((bucket) => bucket !== 'sd');
    const all = buckets.flatMap((bucket) => resolutionBucketSpellings(bucket));

    expect(resolutionBucketSpellings('4k')).not.toContain('1440p');
    expect(resolutionBucketSpellings('1440p')).toContain('qhd');
    expect(resolutionBucketSpellings('1080p')).toContain('2k');
    expect(resolutionBucketSpellings('480p')).toContain('576');
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(resolutionAboveSdSpellings())).toEqual(new Set(all));
  });

  it('agrees with resolutionBucket for every known spelling', () => {
    for (const { spelling, rank } of resolutionSpellingRanks()) {
      expect(rank).toBe(resolutionTierRank(spelling) ?? 0);
      const bucket = resolutionBucket(spelling);
      if (bucket === 'sd') {
        expect(resolutionAboveSdSpellings()).not.toContain(spelling);
      } else {
        expect(resolutionBucketSpellings(bucket!)).toContain(spelling);
      }
    }
  });
});
