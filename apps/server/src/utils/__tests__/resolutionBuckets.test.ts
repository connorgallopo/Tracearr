import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  bucketMembershipColumns,
  perResolutionBucket,
  readResolutionCounts,
  resolutionBucketPredicate,
  resolutionRankSql,
  versionBucketFlagsJoin,
} from '../resolutionBuckets.js';

const dialect = new PgDialect();
const toSql = (fragment: ReturnType<typeof resolutionBucketPredicate>): string =>
  dialect.sqlToQuery(fragment).sql;

describe('resolutionBucketPredicate', () => {
  it('keeps 8k and 1440p out of the 4k bucket', () => {
    const rendered = toSql(resolutionBucketPredicate('video_resolution', '4k'));

    expect(rendered).toContain('video_resolution IN (');
    expect(rendered).toContain("'4k'");
    expect(rendered).toContain("'2160p'");
    expect(rendered).not.toContain("'1440p'");
    expect(rendered).not.toContain("'8k'");
    expect(rendered).not.toContain("'1080p'");
  });

  it('matches exact-tier buckets by their spellings', () => {
    expect(toSql(resolutionBucketPredicate('video_resolution', '1080p'))).toContain("'fhd'");
    expect(toSql(resolutionBucketPredicate('li.video_resolution', '720p'))).toContain(
      'li.video_resolution IN ('
    );
  });

  it('builds sd as the non-null complement of the other buckets', () => {
    const rendered = toSql(resolutionBucketPredicate('video_resolution', 'sd'));

    expect(rendered).toContain('video_resolution IS NOT NULL AND video_resolution NOT IN (');
    expect(rendered).toContain("'4k'");
    expect(rendered).toContain("'720p'");
  });

  it('counts NULL into sd only when the display rule asks for it', () => {
    const rendered = toSql(
      resolutionBucketPredicate('video_resolution', 'sd', { includeNullAsSd: true })
    );

    expect(rendered).toContain('video_resolution IS NULL OR video_resolution NOT IN (');
  });
});

describe('per-bucket helpers', () => {
  it('expands a fragment for all seven buckets in tier order', () => {
    expect(toSql(perResolutionBucket((bucket) => `count_${bucket}`))).toBe(
      'count_8k, count_4k, count_1440p, count_1080p, count_720p, count_480p, count_sd'
    );
  });

  it('builds a BOOL_OR membership column per bucket', () => {
    const rendered = toSql(bucketMembershipColumns('v.video_resolution'));

    expect(rendered).toContain('AS has_8k');
    expect(rendered).toContain('AS has_1440p');
    expect(rendered).toContain('AS has_sd');
  });

  it('reads counts off a row, treating missing columns and rows as zero', () => {
    expect(readResolutionCounts({ count_4k: '3', count_1440p: 2 })).toEqual({
      '8k': 0,
      '4k': 3,
      '1440p': 2,
      '1080p': 0,
      '720p': 0,
      '480p': 0,
      sd: 0,
    });
    expect(readResolutionCounts(undefined).sd).toBe(0);
  });
});

describe('versionBucketFlagsJoin', () => {
  it("reads each item's versions once for every bucket flag", () => {
    const rendered = toSql(versionBucketFlagsJoin('li.id'));

    expect(rendered).toContain('LEFT JOIN LATERAL');
    expect(rendered).toContain('liv.library_item_id = li.id');
    expect(rendered.match(/BOOL_OR/g)).toHaveLength(7);
    expect(rendered).toContain(') vb ON true');
  });

  it('passes the null-as-sd display rule through to the sd flag', () => {
    expect(toSql(versionBucketFlagsJoin('li.id', { includeNullAsSd: true }))).toContain(
      'liv.video_resolution IS NULL OR liv.video_resolution NOT IN ('
    );
  });
});

describe('resolutionRankSql', () => {
  it('ranks spellings by tier with unknown and NULL at 0', () => {
    const rendered = toSql(resolutionRankSql('video_resolution'));

    expect(rendered).toContain('CASE video_resolution');
    expect(rendered).toContain("WHEN '8k' THEN 7");
    expect(rendered).toContain("WHEN '4k' THEN 6");
    expect(rendered).toContain("WHEN '1440p' THEN 5");
    expect(rendered).toContain("WHEN 'sd' THEN 1");
    expect(rendered).toContain('ELSE 0 END');
  });
});
