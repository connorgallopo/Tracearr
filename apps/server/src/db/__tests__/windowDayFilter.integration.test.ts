import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../client.js';
import { windowDayFilter } from '../../routes/publicV2/shared.js';
import { renderSql } from '../../test/helpers.js';

describe('windowDayFilter', () => {
  it.each([7, 30])('keeps the UTC calendar-day semantics of the cast at %i days', async (days) => {
    const windowStart = sql`(((now() AT TIME ZONE 'utc')::date - ${days - 1}::int)::timestamp AT TIME ZONE 'utc')`;
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL TimeZone = 'Asia/Tokyo'`);
      const result = await tx.execute(sql`
        SELECT t::text AS t,
          (t AT TIME ZONE 'utc')::date >= (now() AT TIME ZONE 'utc')::date - ${days - 1}::int AS old,
          (true${windowDayFilter(sql`t`, days)}) AS new
        FROM (VALUES
          (${windowStart}),
          (${windowStart} - interval '1 microsecond'),
          (${windowStart} + interval '1 microsecond'),
          (${windowStart} - interval '1 day' + interval '23:59:59.999999'),
          (${windowStart} - interval '8 hours'),
          ('2026-10-24T01:00:00+09:00'::timestamptz),
          (now())
        ) v(t)
      `);
      return result.rows as { t: string; old: boolean; new: boolean }[];
    });

    expect(rows).toHaveLength(7);
    for (const row of rows)
      expect({ t: row.t, match: row.new }).toEqual({ t: row.t, match: row.old });
  });

  it('compares the column itself so the bound can exclude chunks', () => {
    const { sql: text } = renderSql(windowDayFilter(sql`s.started_at`, 7));
    expect(text).toBe(' AND s.started_at >= $1');
    expect(text).not.toContain('::date');
  });
});
