/**
 * History's started-at pages: the page ids come from their own statement and the rows from
 * a second one bounded by the page's starts. Every page must equal what the single-statement
 * read returns, across chains, an orphaned chain, several accounts and media types, filters,
 * date bounds and compressed chunks. The other sorts keep the single statement.
 *
 * Run with: pnpm --filter @tracearr/server test:integration historyStartedAtPage
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { historyQuerySchema, type AuthUser } from '@tracearr/shared';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { compressSessionChunks } from '../../src/test/compressChunks.js';
import {
  buildHistoryFilterConditions,
  fetchHistoryPage,
  fetchSortedHistoryPage,
  parseHistoryCursor,
  type HistoryPageParams,
} from '../../src/routes/sessions/history.js';
import type { HistoryRow } from '../../src/routes/sessions/historyRow.js';

const DAY_MS = 86_400_000;
const PAGE_SIZE = 3;
const owner: AuthUser = { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };

afterEach(() => {
  vi.restoreAllMocks();
});

async function seed() {
  const user = await createTestUser({ role: 'owner' });
  const other = await createTestUser({ role: 'member' });
  const plex = await createTestServer({ type: 'plex' });
  const jellyfin = await createTestServer({ type: 'jellyfin' });
  const accounts = [
    await createTestServerUser({ userId: user.id, serverId: plex.id }),
    await createTestServerUser({ userId: other.id, serverId: plex.id }),
    await createTestServerUser({ userId: other.id, serverId: jellyfin.id }),
  ];
  const now = Date.now();
  const at = (days: number) => new Date(now - days * DAY_MS);
  const session = (n: number, days: number, extra: Record<string, unknown> = {}) => {
    const account = accounts[n % accounts.length]!;
    return createTestSession({
      serverId: account.serverId,
      serverUserId: account.id,
      state: 'stopped',
      mediaType: (['movie', 'episode', 'track'] as const)[n % 3],
      mediaTitle: n % 4 === 0 ? `The Title ${n}` : `Title ${n}`,
      grandparentTitle: n % 3 === 1 ? `Show ${n % 2}` : null,
      platform: n % 2 === 0 ? 'Android' : 'Roku',
      geoCity: n % 3 === 0 ? 'Chicago' : 'Denver',
      watched: n % 2 === 1,
      durationMs: 60_000 * (n + 1),
      startedAt: at(days),
      ...extra,
    });
  };

  for (let n = 0; n < 24; n++) await session(n, 2 + n * 6);

  // Chains: three segments a few minutes apart, one with a 45-day resume gap across a chunk
  // boundary, and one whose segments differ on platform and watched so a filter keeps only
  // some of them.
  const chainA = await session(1, 10, { platform: 'Android' });
  await session(1, 10 - 0.01, { referenceId: chainA.id, platform: 'Android' });
  await session(1, 10 - 0.02, { referenceId: chainA.id, platform: 'Android', watched: true });
  const chainB = await session(2, 95, { mediaType: 'episode', grandparentTitle: 'Show 1' });
  await session(2, 50, { referenceId: chainB.id, mediaType: 'episode', grandparentTitle: 'Show 1' });
  const chainC = await session(3, 40, { platform: 'Roku', watched: false });
  await session(3, 39.9, { referenceId: chainC.id, platform: 'Android', watched: true });

  // Orphaned chain: the root is gone and two continuation segments still point at it.
  const root = await session(4, 70);
  await session(4, 69.9, { referenceId: root.id });
  await session(4, 69.8, { referenceId: root.id, watched: true });
  await db.execute(sql`DELETE FROM sessions WHERE id = ${root.id}`);

  // Two plays that start at the same instant.
  const tied = at(33);
  await session(5, 33, { startedAt: tied });
  await session(6, 33, { startedAt: tied });

  // Imported rows can carry microseconds, which a JS Date drops.
  await db.execute(sql`
    UPDATE sessions SET started_at = started_at + interval '123 microseconds'
    WHERE started_at > now() - interval '30 days'
  `);

  expect((await compressSessionChunks(45)).length).toBeGreaterThan(0);
  return { accounts, at, orphanId: root.id };
}

function paramsFor(query: Record<string, string>, cursor?: string): HistoryPageParams {
  const input = historyQuerySchema.parse({
    ...query,
    pageSize: String(PAGE_SIZE),
    ...(cursor ? { cursor } : {}),
  });
  const filters = buildHistoryFilterConditions(input, owner, 'all');
  if (!filters) throw new Error('no server access');
  const parsed = input.cursor ? parseHistoryCursor(input.cursor, input.orderBy) : null;
  if (parsed === undefined) throw new Error('bad cursor');
  return {
    conditions: filters.conditions,
    orderBy: input.orderBy,
    orderDir: input.orderDir,
    pageSize: input.pageSize,
    cursor: parsed,
    startDate: input.startDate,
    endDate: input.endDate,
  };
}

function nextCursor(rows: HistoryRow[]): string | undefined {
  const last = rows.at(-1);
  if (!last || !(Number(rows[0]?.page_candidate_count) > PAGE_SIZE)) return undefined;
  return `${new Date(last.started_at).getTime()}_${last.id}`;
}

describe('history started-at pages', () => {
  it(
    'return the same rows as the single-statement read on pages 1 to 3',
    { timeout: 120_000 },
    async () => {
      const { accounts, at, orphanId } = await seed();
      const shapes: Record<string, string>[] = [
        {},
        { orderDir: 'asc' },
        { startDate: at(80).toISOString(), endDate: at(20).toISOString() },
        { startDate: at(60).toISOString() },
        { endDate: at(30).toISOString(), orderDir: 'asc' },
        { serverUserIds: accounts[1]!.id },
        { mediaTypes: 'episode', watched: 'true' },
        { platforms: 'Android' },
        { platforms: 'Android', startDate: at(45).toISOString() },
        { search: 'the' },
        { geoCity: 'Chicago', orderDir: 'asc' },
      ];

      const seen = new Set<string>();
      let multiSegment = 0;
      let compared = 0;
      for (const shape of shapes) {
        let cursor: string | undefined;
        for (let page = 1; page <= 3; page++) {
          const params = paramsFor(shape, cursor);
          const single = await fetchSortedHistoryPage(params);
          const split = await fetchHistoryPage(params);
          expect(split, `${JSON.stringify(shape)} page ${page}`).toStrictEqual(single);
          compared += single.length;
          for (const row of single) {
            seen.add(row.id);
            if (Number(row.segment_count) > 1) multiSegment++;
          }
          cursor = nextCursor(single);
          if (!cursor) break;
        }
      }

      expect(compared).toBeGreaterThan(60);
      expect(multiSegment).toBeGreaterThan(5);
      expect(seen).toContain(orphanId);
    }
  );

  it('read the page ids in their own transaction and leave the aggregation setting on afterward', async () => {
    await seed();
    const transaction = vi.spyOn(db, 'transaction');

    await fetchHistoryPage(paramsFor({}));
    expect(transaction).toHaveBeenCalledTimes(1);

    const settings = await Promise.all(
      Array.from({ length: 50 }, () =>
        db.execute(sql`SELECT current_setting('timescaledb.enable_chunkwise_aggregation') AS v`)
      )
    );
    expect(new Set(settings.map((result) => (result.rows[0] as { v: string }).v))).toEqual(
      new Set(['on'])
    );
  });

  it.each(['durationMs', 'mediaTitle'])('keep the single statement for %s', async (orderBy) => {
    await seed();
    const transaction = vi.spyOn(db, 'transaction');

    const rows = await fetchHistoryPage(paramsFor({ orderBy }));

    expect(rows.length).toBe(PAGE_SIZE);
    expect(transaction).not.toHaveBeenCalled();
  });
});
