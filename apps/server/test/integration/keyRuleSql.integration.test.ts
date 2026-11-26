/**
 * The SQL forms of the key rules give the TS answer on every shared case.
 *
 * Run with: pnpm --filter @tracearr/server test:integration keyRuleSql
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestLibraryItem, createTestServer } from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { media } from '../../src/db/schema.js';
import {
  keyAgreesSql,
  normalizedShowTitleSql,
  normalizedTitleSql,
  repairClauseSql,
} from '../../src/services/import/keyRuleSql.js';
import { comparableTitle } from '../../src/services/import/libraryKeyMatch.js';
import {
  AGREEMENT_CASES,
  NORMALIZATION_CASES,
  REPAIR_CASES,
  SHOW_NORMALIZATION_CASES,
} from '../../src/test/keyRuleCases.js';

async function normalizedBySql(
  raws: string[],
  normalize: (expr: string) => string
): Promise<string[]> {
  const { rows } = await db.execute(sql`
    SELECT ${sql.raw(normalize('t.raw'))} AS normalized
    FROM unnest(${sql.param(raws)}::text[]) WITH ORDINALITY AS t(raw, i) ORDER BY t.i
  `);
  return (rows as Array<{ normalized: string }>).map((r) => r.normalized);
}

describe('key rules in SQL', () => {
  it('normalizes every title the way normalizeTitle does', async () => {
    expect(
      await normalizedBySql(
        NORMALIZATION_CASES.map((c) => c.raw),
        normalizedTitleSql
      )
    ).toEqual(NORMALIZATION_CASES.map((c) => c.normalized));
    expect(
      await normalizedBySql(
        SHOW_NORMALIZATION_CASES.map((c) => c.raw),
        normalizedShowTitleSql
      )
    ).toEqual(SHOW_NORMALIZATION_CASES.map((c) => c.normalized));
  });

  it('normalizes every code point the way the TS rules do', async () => {
    const { rows } = await db.execute(sql`
      SELECT n, ${sql.raw(normalizedTitleSql('chr(n)'))} AS normalized
      FROM generate_series(1, 1114111) n WHERE n NOT BETWEEN 55296 AND 57343
    `);
    const differing = (rows as Array<{ n: number; normalized: string }>)
      .filter((r) => r.normalized !== comparableTitle(String.fromCodePoint(r.n)))
      .map((r) => `U+${r.n.toString(16)}`);
    expect(differing).toEqual([]);
  }, 120_000);

  it('agrees in SQL wherever TS agrees', async () => {
    for (const { name, item, play, agrees } of AGREEMENT_CASES.filter((c) => !c.importOnly)) {
      const { rows } = await db.execute(sql`
        WITH s (media_type, media_title, year, grandparent_title, season_number, episode_number) AS (
          VALUES (${play.mediaType}::text, ${play.title ?? null}::text, ${play.year ?? null}::int,
            ${play.grandparentTitle ?? null}::text, ${play.seasonNumber ?? null}::int,
            ${play.episodeNumber ?? null}::int)
        ), item (media_type, title, year, grandparent_title, parent_index, item_index) AS (
          VALUES (${item.mediaType}::text, ${item.title}::text, ${item.year}::int,
            ${item.showTitle}::text, ${item.seasonNumber}::int, ${item.episodeNumber}::int)
        )
        SELECT ${keyAgreesSql('item')} AS agrees FROM s, item
      `);
      expect({ name, agrees: (rows[0] as { agrees: boolean }).agrees }).toEqual({ name, agrees });
    }
  });

  it('repairs in SQL wherever TS repairs', async () => {
    const server = await createTestServer({ type: 'plex' });
    // Each case runs twice: every pair as a library item, then the first pair as a title-path
    // match key and the rest as removed library items.
    for (const keyed of [false, true]) {
      for (const { name, link, play, clause } of REPAIR_CASES) {
        const showId = randomUUID();
        await db.insert(media).values({
          id: showId,
          mediaType: 'show',
          matchKey: `show:local:${randomUUID()}`,
          title: link.showTitle ?? '',
        });
        const [first, ...rest] = link.numbers;
        const inKey = keyed && first !== undefined;
        const [linked] = await db
          .insert(media)
          .values({
            mediaType: link.mediaType,
            matchKey: inKey
              ? `episode:${showId}:s${first[0]}e${first[1]}`
              : `${link.mediaType}:local:${randomUUID()}`,
            title: link.title ?? '',
            year: link.year,
            showMediaId: showId,
          })
          .returning({ id: media.id });
        for (const [season, episode] of inKey ? rest : link.numbers) {
          await createTestLibraryItem({
            serverId: server.id,
            ratingKey: randomUUID(),
            mediaType: link.mediaType,
            parentIndex: season,
            itemIndex: episode,
            mediaId: linked?.id ?? null,
            removedAt: keyed ? new Date() : null,
          });
        }
        const { rows } = await db.execute(sql`
          WITH s (server_id, media_type, media_title, year, grandparent_title, season_number,
            episode_number) AS (
            VALUES (${server.id}::uuid, ${play.mediaType}::text, ${play.title ?? null}::text,
              ${play.year ?? null}::int, ${play.grandparentTitle ?? null}::text,
              ${play.seasonNumber ?? null}::int, ${play.episodeNumber ?? null}::int)
          )
          SELECT ${repairClauseSql()} AS clause
          FROM s
          JOIN media em ON em.id = ${linked?.id ?? null}::uuid
          LEFT JOIN media sh ON sh.id = em.show_media_id
        `);
        expect({ name, keyed, clause: (rows[0] as { clause: string | null }).clause }).toEqual({
          name,
          keyed,
          clause,
        });
      }
    }
  });
});
