import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../client.js';
import { lastDaysWindow, rollupDayWindowSql } from '../sessions/rules.js';
import { renderSql } from '../../test/helpers.js';

describe('rollupDayWindowSql over lastDaysWindow', () => {
  it.each([7, 30])('keeps the UTC calendar-day semantics of the cast at %i days', async (days) => {
    // One instant for both sides, so the database clock never has to agree with this process's
    const now = new Date();
    const today = sql`(${now}::timestamptz AT TIME ZONE 'utc')::date`;
    const windowStart = sql`((${today} - ${days - 1}::int)::timestamp AT TIME ZONE 'utc')`;
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL TimeZone = 'Asia/Tokyo'`);
      const result = await tx.execute(sql`
        SELECT t::text AS t,
          (t AT TIME ZONE 'utc')::date >= ${today} - ${days - 1}::int AS old,
          (true${rollupDayWindowSql(lastDaysWindow(days, now), sql`t`)}) AS new
        FROM (VALUES
          (${windowStart}),
          (${windowStart} - interval '1 microsecond'),
          (${windowStart} + interval '1 microsecond'),
          (${windowStart} - interval '1 day' + interval '23:59:59.999999'),
          (${windowStart} - interval '8 hours'),
          ('2026-10-24T01:00:00+09:00'::timestamptz),
          (${now}::timestamptz - interval '1 millisecond')
        ) v(t)
      `);
      return result.rows as { t: string; old: boolean; new: boolean }[];
    });

    expect(rows).toHaveLength(7);
    for (const row of rows)
      expect({ t: row.t, match: row.new }).toEqual({ t: row.t, match: row.old });
  });

  it('compares the column itself so the bound can exclude chunks', () => {
    const { sql: text } = renderSql(rollupDayWindowSql(lastDaysWindow(7), sql`s.started_at`));
    expect(text).toBe(' AND s.started_at >= $1::timestamptz AND s.started_at < $2::timestamptz');
    expect(text).not.toContain('::date');
  });
});
