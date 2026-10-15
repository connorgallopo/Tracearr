/**
 * Seeded EXPLAIN gate for catalog browse queries.
 *
 * Seeds a production-scale synthetic dataset (30k media / 90k library_items
 * across 3 servers / ~500k cagg-relevant sessions) via set-based SQL, then
 * runs EXPLAIN (FORMAT JSON) against the catalog page queries and the
 * mediaWatchedService probes to pin their plan shapes. Imports the route's
 * exported buildCatalogPageQuery for the three page-query assertions, so
 * the pinned plans stay in lockstep with what the catalog route runs.
 *
 * Seed and assertions live in one `it` body: the per-test reset truncates
 * everything before every test, so a beforeAll seed would not survive to
 * the first assertion.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- catalogExplain
 */

import { describe, it, expect } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { buildAliasMapCte } from '../../src/services/library/mediaWatchedService.js';
import { buildMultiServerFragment } from '../../src/utils/serverFiltering.js';
import {
  buildCatalogPageQuery,
  buildCatalogTotalsQuery,
  buildCatalogCandidatesQuery,
  buildLetterCountsQuery,
  buildValueRollupCte,
  expandMediaAliases,
} from '../../src/routes/library/catalog.js';
import { mediaSizeSubquery } from '../../src/routes/library/utils.js';

// No new filter narrows the seeded set for these plan-shape assertions -
// every call site spreads this rather than repeating five no-op fields.
const NO_NEW_FILTERS = {
  libraryServerId: null,
  libraryId: null,
  hdr: false,
  sizeGbMin: null,
  sizeGbMax: null,
  scope: 'all',
} as const;

interface PlanNode {
  'Node Type': string;
  'Join Type'?: string;
  'Index Name'?: string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}

function flattenPlan(node: PlanNode): PlanNode[] {
  const nodes = [node];
  for (const child of node.Plans ?? []) {
    nodes.push(...flattenPlan(child));
  }
  return nodes;
}

async function explainPlan(query: SQL): Promise<PlanNode> {
  const result = await db.execute(sql`EXPLAIN (FORMAT JSON) ${query}`);
  const row = result.rows[0] as Record<string, unknown>;
  const raw = row['QUERY PLAN'];
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
  return parsed[0].Plan;
}

// A hypertable/cagg chunk's physical index is named
// `_hyper_<N>_<M>_chunk_<original index name>`, so a scan on a chunk reports
// that prefixed name in the plan rather than the name the index was created
// with; match either form.
function usesIndexScan(nodes: PlanNode[], indexName: string): boolean {
  return nodes.some(
    (n) =>
      (n['Node Type'] === 'Index Scan' ||
        n['Node Type'] === 'Index Only Scan' ||
        n['Node Type'] === 'Bitmap Index Scan') &&
      (n['Index Name'] === indexName || n['Index Name']?.endsWith(`_chunk_${indexName}`))
  );
}

function hasSeqScanOn(nodes: PlanNode[], relationName: string): boolean {
  return nodes.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === relationName);
}

// FORMAT JSON reports the anti-join as Node Type "Hash Join" with Join Type "Right Anti" / "Anti".
function hasHashAntiJoin(nodes: PlanNode[]): boolean {
  return nodes.some(
    (n) => n['Node Type'] === 'Hash Join' && (n['Join Type'] ?? '').includes('Anti')
  );
}

function hasNestedLoopAntiJoin(nodes: PlanNode[]): boolean {
  return nodes.some(
    (n) => n['Node Type'] === 'Nested Loop' && (n['Join Type'] ?? '').includes('Anti')
  );
}

const SEED_TIMEOUT_MS = 240_000;

describe('catalog EXPLAIN gate at scale', () => {
  it(
    'pins catalog browse query plans against a 30k/90k/500k seeded dataset',
    async () => {
      await db.execute(sql`
        INSERT INTO servers (id, name, type, url, token) VALUES
          ('11111111-1111-1111-1111-111111111111', 'seed-server-1', 'plex', 'http://s1', 'tok1'),
          ('22222222-2222-2222-2222-222222222222', 'seed-server-2', 'plex', 'http://s2', 'tok2'),
          ('33333333-3333-3333-3333-333333333333', 'seed-server-3', 'plex', 'http://s3', 'tok3')
      `);

      await db.execute(sql`
        INSERT INTO users (id, username, role)
        SELECT ('00000000-0000-0000-0000-' || lpad((100000 + k)::text, 12, '0'))::uuid,
               'seed-user-' || k::text,
               'member'
        FROM generate_series(1, 300) AS k
      `);

      await db.execute(sql`
        WITH servers_ranked AS (
          SELECT id, (row_number() OVER (ORDER BY id) - 1)::int AS idx FROM servers
        )
        INSERT INTO server_users (id, user_id, server_id, external_id, username)
        SELECT
          ('00000000-0000-0000-0000-' || lpad((200000 + k)::text, 12, '0'))::uuid,
          ('00000000-0000-0000-0000-' || lpad((100000 + k)::text, 12, '0'))::uuid,
          sr.id,
          'ext-' || k::text,
          'user-' || k::text
        FROM generate_series(1, 300) AS k
        JOIN servers_ranked sr ON sr.idx = (k % 3)
      `);

      // 30k media: i in 1..15000 are movies, 15001..30000 are shows. The id
      // embeds i in its last hex group (all decimal digits, valid hex), so
      // later steps can derive i back out via substr(id::text, 25, 12) without
      // a round trip through the DB.
      await db.execute(sql`
        INSERT INTO media (
          id, media_type, match_key, title, normalized_title, sort_title, year, genres, latest_added_at
        )
        SELECT
          ('00000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
          CASE WHEN i <= 15000 THEN 'movie' ELSE 'show' END,
          CASE WHEN i <= 15000 THEN 'movie:seed:' ELSE 'show:seed:' END || i::text,
          CASE WHEN i <= 15000 THEN 'Movie ' || i::text ELSE 'Show ' || (i - 15000)::text END,
          CASE WHEN i <= 15000 THEN 'movie-' || lpad(i::text, 6, '0')
               ELSE 'show-' || lpad((i - 15000)::text, 6, '0') END,
          CASE WHEN i <= 15000 THEN 'movie' || lpad(i::text, 6, '0')
               ELSE 'show' || lpad((i - 15000)::text, 6, '0') END,
          1970 + (i % 55),
          CASE WHEN i <= 15000
            THEN ARRAY[(ARRAY['Action','Drama','Comedy','Horror','Documentary'])[1 + (i % 5)],
                       (ARRAY['Action','Drama','Comedy','Horror','Documentary'])[1 + ((i + 1) % 5)]]
            ELSE ARRAY[(ARRAY['Action','Drama','Comedy','Horror','Documentary'])[1 + ((i - 15000) % 5)],
                       (ARRAY['Action','Drama','Comedy','Horror','Documentary'])[1 + ((i - 15000 + 1) % 5)]]
          END,
          now() - ((i % 400) || ' days')::interval
        FROM generate_series(1, 30000) AS i
      `);

      // 90k library_items: one active copy per media row per server.
      await db.execute(sql`
        WITH servers_ranked AS (
          SELECT id, (row_number() OVER (ORDER BY id) - 1)::int AS idx FROM servers
        )
        INSERT INTO library_items (
          server_id, library_id, rating_key, title, media_type, year, video_resolution, genres, media_id, created_at
        )
        SELECT
          sr.id,
          'lib-main',
          'rk-' || m.id::text || '-' || sr.idx::text,
          m.title,
          m.media_type,
          m.year,
          (ARRAY['4k','1080p','720p','sd'])[1 + ((substr(m.id::text, 25, 12)::bigint + sr.idx) % 4)],
          m.genres,
          m.id,
          now() - ((substr(m.id::text, 25, 12)::bigint % 400) || ' days')::interval
        FROM media m
        CROSS JOIN servers_ranked sr
      `);

      // 45k episode media rows, 3 per show, linked via show_media_id - so the
      // rollup path in mediaSizeSubquery (the OR show_media_id branch) is
      // actually exercised at scale rather than always seeing empty shows.
      await db.execute(sql`
        INSERT INTO media (
          id, media_type, match_key, title, normalized_title, year, show_media_id, latest_added_at
        )
        SELECT
          ('00000000-0000-0000-0001-' || lpad(((s.show_idx - 1) * 3 + ep)::text, 12, '0'))::uuid,
          'episode',
          'episode:seed:' || s.id::text || ':' || ep::text,
          'Episode ' || ep::text,
          NULL,
          s.year,
          s.id,
          now() - ((ep || ' days')::interval)
        FROM (
          SELECT id, year, (row_number() OVER (ORDER BY id))::int AS show_idx
          FROM media WHERE media_type = 'show'
        ) s
        CROSS JOIN generate_series(1, 3) AS ep
      `);

      // One active library_items copy per episode (single server is enough to
      // exercise the join; the mirror-dedupe shape is already covered by the
      // movie/show rows above).
      await db.execute(sql`
        INSERT INTO library_items (
          server_id, library_id, rating_key, title, media_type, year, video_resolution, genres, media_id, created_at, file_size
        )
        SELECT
          (SELECT id FROM servers ORDER BY id LIMIT 1),
          'lib-episodes',
          'rk-ep-' || m.id::text,
          m.title,
          m.media_type,
          m.year,
          '1080p',
          NULL,
          m.id,
          now() - ((substr(m.id::text, 25, 12)::bigint % 400) || ' days')::interval,
          500000000
        FROM media m
        WHERE m.media_type = 'episode'
      `);

      // One version row per item mirroring the flat columns - version-grain
      // queries (facets, size dedupe) read library_item_versions
      await db.execute(sql`
        INSERT INTO library_item_versions (library_item_id, server_version_key, video_resolution, file_size)
        SELECT id, 'v1', video_resolution, file_size
        FROM library_items
      `);

      // VACUUM, not just ANALYZE: only VACUUM sets the visibility map, and the
      // index-only paths pinned below (letter counts on the sort_title index)
      // are costed off relallvisible. ANALYZE alone left that to autovacuum timing.
      await db.execute(sql`VACUUM (ANALYZE) media`);
      await db.execute(sql`VACUUM (ANALYZE) library_items`);
      await db.execute(sql`VACUUM (ANALYZE) library_item_versions`);

      // ~500k sessions: every 3rd movie/show gets play history (the rest stay
      // never-watched), spread across 300 server_users and 400 days.
      await db.execute(sql`
        WITH su AS (
          SELECT array_agg(id ORDER BY id) AS ids, array_agg(server_id ORDER BY id) AS server_ids, count(*)::int AS n
          FROM server_users
        ),
        watched_movies AS (
          SELECT array_agg(id ORDER BY id) AS ids, count(*)::int AS n
          FROM media
          WHERE media_type = 'movie' AND (substr(id::text, 25, 12)::bigint % 3 = 0)
        ),
        watched_shows AS (
          SELECT array_agg(id ORDER BY id) AS ids, count(*)::int AS n
          FROM media
          WHERE media_type = 'show' AND (substr(id::text, 25, 12)::bigint % 3 = 0)
        )
        INSERT INTO sessions (
          server_id, server_user_id, session_key, state, media_type, media_title,
          media_id, show_media_id, started_at, last_seen_at, duration_ms, total_duration_ms,
          reference_id, watched, ip_address
        )
        SELECT
          su.server_ids[1 + (gs % su.n)],
          su.ids[1 + (gs % su.n)],
          'seed-session-' || gs::text,
          'stopped',
          CASE WHEN gs % 2 = 0 THEN 'movie' ELSE 'episode' END,
          'Seed Session ' || gs::text,
          CASE WHEN gs % 2 = 0 THEN watched_movies.ids[1 + (gs % watched_movies.n)]
               ELSE gen_random_uuid() END,
          CASE WHEN gs % 2 = 0 THEN NULL
               ELSE watched_shows.ids[1 + (gs % watched_shows.n)] END,
          now() - ((gs % 400) || ' days')::interval - ((gs % 24) || ' hours')::interval,
          now() - ((gs % 400) || ' days')::interval,
          120000 + (gs % 5) * 60000,
          7200000,
          NULL,
          (gs % 3 != 0),
          '10.0.0.' || ((gs % 250) + 1)::text
        FROM generate_series(1, 500000) AS gs
        CROSS JOIN su
        CROSS JOIN watched_movies
        CROSS JOIN watched_shows
      `);

      await db.execute(sql`VACUUM (ANALYZE) sessions`);

      await db.execute(
        sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
      );

      const caggTableResult = await db.execute(sql`
        SELECT materialization_hypertable_schema AS schema, materialization_hypertable_name AS name
        FROM timescaledb_information.continuous_aggregates
        WHERE view_name = 'user_media_plays_daily'
      `);
      const caggTable = caggTableResult.rows[0] as { schema: string; name: string };
      await db.execute(
        sql`VACUUM (ANALYZE) ${sql.identifier(caggTable.schema)}.${sql.identifier(caggTable.name)}`
      );

      // ==== Assertion 1: title offset window ====
      // Ordering runs on the sort_title column; with no extra
      // filters the planner walks idx_media_type_sort_title_id in order and
      // skips offset rows without a sort node.
      const titlePageQuery = buildCatalogPageQuery({
        type: 'movie',
        sort: 'title',
        offset: 5000,
        genre: null,
        yearFrom: null,
        yearTo: null,
        searchNormalized: null,
        resolution: null,
        ...NO_NEW_FILTERS,
        serverIds: undefined,
        pageSize: 60,
      });
      const titlePlan = flattenPlan(await explainPlan(titlePageQuery));
      expect(hasSeqScanOn(titlePlan, 'media')).toBe(false);
      expect(usesIndexScan(titlePlan, 'idx_media_type_sort_title_id')).toBe(true);

      // ==== Assertion 2: added sort. The first page (the case perceived
      // latency lives in) must ride the ordered index; at a deep offset the
      // planner may correctly trade the ordered walk (one EXISTS probe per
      // skipped row) for a bitmap + top-N sort - still index-driven, so the
      // deep pin is only "no seq scan on media". ====
      const addedFirstPageQuery = buildCatalogPageQuery({
        type: 'movie',
        sort: 'added',
        offset: 0,
        genre: null,
        yearFrom: null,
        yearTo: null,
        searchNormalized: null,
        resolution: null,
        ...NO_NEW_FILTERS,
        serverIds: undefined,
        pageSize: 60,
      });
      const addedFirstPlan = flattenPlan(await explainPlan(addedFirstPageQuery));
      expect(hasSeqScanOn(addedFirstPlan, 'media')).toBe(false);
      expect(usesIndexScan(addedFirstPlan, 'idx_media_type_added_active')).toBe(true);

      const addedDeepQuery = buildCatalogPageQuery({
        type: 'movie',
        sort: 'added',
        offset: 10000,
        genre: null,
        yearFrom: null,
        yearTo: null,
        searchNormalized: null,
        resolution: null,
        ...NO_NEW_FILTERS,
        serverIds: undefined,
        pageSize: 60,
      });
      const addedDeepPlan = flattenPlan(await explainPlan(addedDeepQuery));
      expect(hasSeqScanOn(addedDeepPlan, 'media')).toBe(false);

      // ==== Assertion 2b: year sort, same first-page/deep split on its
      // dedicated index. ====
      const yearFirstPageQuery = buildCatalogPageQuery({
        type: 'movie',
        sort: 'year',
        offset: 0,
        genre: null,
        yearFrom: null,
        yearTo: null,
        searchNormalized: null,
        resolution: null,
        ...NO_NEW_FILTERS,
        serverIds: undefined,
        pageSize: 60,
      });
      const yearFirstPlan = flattenPlan(await explainPlan(yearFirstPageQuery));
      expect(hasSeqScanOn(yearFirstPlan, 'media')).toBe(false);
      expect(usesIndexScan(yearFirstPlan, 'idx_media_type_year_id')).toBe(true);

      const yearDeepQuery = buildCatalogPageQuery({
        type: 'movie',
        sort: 'year',
        offset: 5000,
        genre: null,
        yearFrom: null,
        yearTo: null,
        searchNormalized: null,
        resolution: null,
        ...NO_NEW_FILTERS,
        serverIds: undefined,
        pageSize: 60,
      });
      const yearDeepPlan = flattenPlan(await explainPlan(yearDeepQuery));
      expect(hasSeqScanOn(yearDeepPlan, 'media')).toBe(false);

      // ==== Assertion 3: worst combo (genre + resolution filters, title
      // sort, deep offset). Under filters the planner may trade the ordered
      // index walk for a bitmap + sort over the ~2.9k matching rows - still
      // index-driven, never a seq scan over media. ====
      const worstComboQuery = buildCatalogPageQuery({
        type: 'movie',
        sort: 'title',
        offset: 2000,
        genre: 'Action',
        yearFrom: null,
        yearTo: null,
        searchNormalized: null,
        resolution: '1080p',
        ...NO_NEW_FILTERS,
        serverIds: undefined,
        pageSize: 60,
      });
      const worstPlan = flattenPlan(await explainPlan(worstComboQuery));
      expect(hasSeqScanOn(worstPlan, 'media')).toBe(false);

      // ==== Assertion 3b: the server selector narrowed to two servers -
      // buildMultiServerFragment now emits `IN (a, b)` instead of `= a` on
      // every li/li2 column it touches. Same seeded set, so this must hold
      // the identical plan shape: no seq scan on media or library_items.
      const twoServerIds = [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
      ];

      const titlePageQueryMultiServer = buildCatalogPageQuery({
        type: 'movie',
        sort: 'title',
        offset: 5000,
        genre: null,
        yearFrom: null,
        yearTo: null,
        searchNormalized: null,
        resolution: null,
        ...NO_NEW_FILTERS,
        serverIds: twoServerIds,
        pageSize: 60,
      });
      const titlePlanMultiServer = flattenPlan(await explainPlan(titlePageQueryMultiServer));
      expect(hasSeqScanOn(titlePlanMultiServer, 'media')).toBe(false);
      expect(hasSeqScanOn(titlePlanMultiServer, 'library_items')).toBe(false);
      expect(usesIndexScan(titlePlanMultiServer, 'idx_media_type_sort_title_id')).toBe(true);

      const totalsQueryMultiServer = buildCatalogTotalsQuery({
        type: 'movie',
        sort: 'title',
        genre: 'Action',
        yearFrom: null,
        yearTo: null,
        searchNormalized: null,
        resolution: '1080p',
        ...NO_NEW_FILTERS,
        serverIds: twoServerIds,
      });
      const totalsPlanMultiServer = flattenPlan(await explainPlan(totalsQueryMultiServer));
      expect(hasSeqScanOn(totalsPlanMultiServer, 'media')).toBe(false);

      // ==== Assertion 3c: letters GROUP BY aggregate - the whole filtered
      // set collapses to at most 27 rows in SQL; media stays on its sort
      // index (library_items may hash semi-join, which is correct for a
      // majority-match EXISTS at this scale). ====
      const letterCountsQuery = buildLetterCountsQuery({
        type: 'movie',
        genre: null,
        yearFrom: null,
        yearTo: null,
        searchNormalized: null,
        resolution: null,
        ...NO_NEW_FILTERS,
        serverIds: undefined,
      });
      const letterCountsPlan = flattenPlan(await explainPlan(letterCountsQuery));
      expect(hasSeqScanOn(letterCountsPlan, 'media')).toBe(false);
      expect(usesIndexScan(letterCountsPlan, 'idx_media_type_sort_title_id')).toBe(true);

      // ==== Assertion 3d: watched-path candidates query (ordered ids +
      // letter buckets, no window) rides the same sort index. ====
      const candidatesQuery = buildCatalogCandidatesQuery({
        type: 'movie',
        sort: 'title',
        genre: null,
        yearFrom: null,
        yearTo: null,
        searchNormalized: null,
        resolution: null,
        ...NO_NEW_FILTERS,
        serverIds: undefined,
      });
      const candidatesPlan = flattenPlan(await explainPlan(candidatesQuery));
      // Whole-set + ORDER BY: at this scale the planner correctly prefers a
      // bitmap + sort over ~15k ordered index probes, so pin index-driven
      // access only (this path runs once per watched-filter cache miss).
      expect(hasSeqScanOn(candidatesPlan, 'media')).toBe(false);

      // ==== Assertion 3d2: page-engagement rollup (fetchPageEngagement
      // shape) - idsFilter is alias-expanded first (expandMediaAliases), so
      // buildValueRollupCte filters p.media_id directly instead of through
      // COALESCE(am.merged_into_id, p.media_id). That keeps the cagg scan
      // bounded by the page's ~60 ids via idx_user_media_plays_media_user_chain,
      // instead of a full scan of the 30-day plays window per page. ====
      const pageIdsResult = await db.execute(sql`
        SELECT id FROM media WHERE media_type = 'movie' ORDER BY id LIMIT 60
      `);
      const pageIds = (pageIdsResult.rows as Array<{ id: string }>).map((r) => r.id);
      const expandedPageIds = await expandMediaAliases(pageIds);
      const engagementCte = buildValueRollupCte('movie', undefined, expandedPageIds);
      const engagementQuery = sql`
        WITH ${engagementCte}
        SELECT canonical_id, plays, viewers FROM value_rollup
      `;
      const engagementPlan = flattenPlan(await explainPlan(engagementQuery));
      // The materialized hypertable's index name is TimescaleDB-managed, not
      // one this codebase defines, so pin on "an index keyed by media_id was
      // used" rather than an exact name - a non-sargable COALESCE predicate
      // can only ride the day-only default index (scanning the whole 30-day
      // window), never one that also keys on media_id.
      const usesMediaIdIndex = engagementPlan.some(
        (n) =>
          (n['Node Type'] === 'Index Scan' ||
            n['Node Type'] === 'Index Only Scan' ||
            n['Node Type'] === 'Bitmap Index Scan') &&
          (n['Index Name'] ?? '').includes('media_id')
      );
      expect(usesMediaIdIndex).toBe(true);

      // ==== Assertion 3e: HDR + size-on-disk filters, deep offset. Both
      // predicates live inside the per-copy EXISTS on library_items, driven
      // by li.media_id - the EXISTS probes via idx_library_items_media with
      // hdr/size as residual filters, so the gate only needs to hold no
      // seq-scan regression on media or library_items. ====
      const hdrSizeQuery = buildCatalogPageQuery({
        type: 'movie',
        sort: 'title',
        offset: 2000,
        genre: null,
        yearFrom: null,
        yearTo: null,
        searchNormalized: null,
        resolution: null,
        libraryServerId: null,
        libraryId: null,
        hdr: true,
        sizeGbMin: 1,
        sizeGbMax: 50,
        serverIds: undefined,
        scope: 'all',
        pageSize: 60,
      });
      const hdrSizePlan = flattenPlan(await explainPlan(hdrSizeQuery));
      expect(hasSeqScanOn(hdrSizePlan, 'media')).toBe(false);
      expect(hasSeqScanOn(hdrSizePlan, 'library_items')).toBe(false);

      // ==== Assertion 3f: library filter (serverId + libraryId pair), same
      // per-copy EXISTS shape, one of the seeded servers/lib-main library. ====
      const libraryFilteredQuery = buildCatalogPageQuery({
        type: 'movie',
        sort: 'title',
        offset: 2000,
        genre: null,
        yearFrom: null,
        yearTo: null,
        searchNormalized: null,
        resolution: null,
        libraryServerId: '11111111-1111-1111-1111-111111111111',
        libraryId: 'lib-main',
        hdr: false,
        sizeGbMin: null,
        sizeGbMax: null,
        serverIds: undefined,
        scope: 'all',
        pageSize: 60,
      });
      const libraryFilteredPlan = flattenPlan(await explainPlan(libraryFilteredQuery));
      expect(hasSeqScanOn(libraryFilteredPlan, 'media')).toBe(false);
      expect(hasSeqScanOn(libraryFilteredPlan, 'library_items')).toBe(false);

      // ==== Assertion 4: show watched probe (mediaWatchedService.fetchShowWatchedRows shape) ====
      const showIdsResult = await db.execute(sql`
        SELECT id FROM media WHERE media_type = 'show' ORDER BY id LIMIT 60
      `);
      const showIds = (showIdsResult.rows as Array<{ id: string }>).map((r) => r.id);
      const aliasCte = buildAliasMapCte(showIds);
      const serverFragment = buildMultiServerFragment(undefined, 'p.server_id');
      const serverFragmentLi = buildMultiServerFragment(undefined, 'li.server_id');
      const lensUserId: string | null = null;
      const showProbeQuery = sql`
        ${aliasCte}
        SELECT a.canonical_id,
               COUNT(DISTINCT p.media_id) FILTER (
                 WHERE p.any_watched
                   AND EXISTS (
                     SELECT 1 FROM library_items li
                     WHERE li.media_id = p.media_id AND li.removed_at IS NULL ${serverFragmentLi}
                   )
               )::int AS eps_watched,
               COALESCE(BOOL_OR(p.counted), false) AS has_plays
        FROM alias_map a
        CROSS JOIN LATERAL (
          SELECT p2.media_id, p2.any_watched, p2.counted, p2.server_user_id, p2.server_id
          FROM user_media_plays_daily p2
          WHERE p2.show_media_id = a.any_id
          OFFSET 0
        ) p
        JOIN server_users su ON su.id = p.server_user_id
        WHERE (${lensUserId}::uuid IS NULL OR su.user_id = ${lensUserId}) ${serverFragment}
        GROUP BY a.canonical_id
      `;
      const showProbePlan = flattenPlan(await explainPlan(showProbeQuery));
      expect(usesIndexScan(showProbePlan, 'idx_user_media_plays_show_user_chain')).toBe(true);

      // ==== Assertion 5: never-watched anti-joins (movies and shows) ====
      const movieAntiJoinQuery = sql`
        WITH alias_map AS (
          SELECT m.id AS canonical_id, m.id AS any_id
          FROM media m
          WHERE m.merged_into_id IS NULL AND m.media_type = 'movie'
          UNION ALL
          SELECT loser.merged_into_id AS canonical_id, loser.id AS any_id
          FROM media loser
          WHERE loser.merged_into_id IS NOT NULL
        )
        SELECT m.id, m.latest_added_at
        FROM media m
        WHERE m.merged_into_id IS NULL
          AND m.media_type = 'movie'
          AND NOT EXISTS (
            SELECT 1
            FROM alias_map a
            JOIN user_media_plays_daily p ON p.media_id = a.any_id
            WHERE a.canonical_id = m.id
          )
        ORDER BY m.latest_added_at ASC NULLS LAST
        LIMIT 20
      `;
      const movieAntiJoinPlan = flattenPlan(await explainPlan(movieAntiJoinQuery));
      expect(hasHashAntiJoin(movieAntiJoinPlan)).toBe(true);
      expect(hasNestedLoopAntiJoin(movieAntiJoinPlan)).toBe(false);

      const showAntiJoinQuery = sql`
        WITH alias_map AS (
          SELECT m.id AS canonical_id, m.id AS any_id
          FROM media m
          WHERE m.merged_into_id IS NULL AND m.media_type = 'show'
          UNION ALL
          SELECT loser.merged_into_id AS canonical_id, loser.id AS any_id
          FROM media loser
          WHERE loser.merged_into_id IS NOT NULL
        )
        SELECT m.id, m.latest_added_at
        FROM media m
        WHERE m.merged_into_id IS NULL
          AND m.media_type = 'show'
          AND NOT EXISTS (
            SELECT 1
            FROM alias_map a
            JOIN user_media_plays_daily p ON p.show_media_id = a.any_id
            WHERE a.canonical_id = m.id
          )
        ORDER BY m.latest_added_at ASC NULLS LAST
        LIMIT 20
      `;
      const showAntiJoinPlan = flattenPlan(await explainPlan(showAntiJoinQuery));
      expect(hasHashAntiJoin(showAntiJoinPlan)).toBe(true);
      expect(hasNestedLoopAntiJoin(showAntiJoinPlan)).toBe(false);

      // ==== Assertion 6: shelves fetchMeta totals query (mediaSizeSubquery's
      // show_media_id rollup, now that shows actually carry episodes) ====
      const serverFragmentLiMeta = buildMultiServerFragment(undefined, 'li.server_id');
      const serverFragmentLi2Meta = buildMultiServerFragment(undefined, 'li2.server_id');
      const shelvesMetaQuery = sql`
        SELECT
          COUNT(*) FILTER (WHERE m.media_type = 'movie')::bigint AS movies,
          COUNT(*) FILTER (WHERE m.media_type = 'show')::bigint AS shows,
          COALESCE(SUM(${mediaSizeSubquery(sql`m.id`, serverFragmentLi2Meta)}), 0)::bigint AS total_file_size
        FROM media m
        WHERE m.merged_into_id IS NULL
          AND m.media_type IN ('movie', 'show')
          AND EXISTS (
            SELECT 1 FROM library_items li
            WHERE li.media_id = m.id AND li.removed_at IS NULL ${serverFragmentLiMeta}
          )
      `;
      const shelvesMetaPlan = flattenPlan(await explainPlan(shelvesMetaQuery));
      // The header-count total scans all movies/shows with no filter, so the
      // outer active-item EXISTS check is a majority-match semi-join and the
      // planner correctly sequential-scans library_items for it (touching
      // nearly the whole table beats an index probe per row) - that's not
      // what this assertion pins. What matters is the per-row size rollup:
      // media itself is never sequential-scanned, and the mediaSizeSubquery
      // correlated subplan (the OR join added by the episode rollup) stays
      // index-driven via idx_media_show and idx_library_items_media.
      expect(hasSeqScanOn(shelvesMetaPlan, 'media')).toBe(false);
      expect(usesIndexScan(shelvesMetaPlan, 'idx_media_show')).toBe(true);
      expect(usesIndexScan(shelvesMetaPlan, 'idx_library_items_media')).toBe(true);

      // ==== Assertion 7: shelves dead-weight candidate query for shows
      // (fetchDeadWeightCandidatesForType shape), same rollup subquery over
      // the never-watched anti-join population ====
      const serverFragmentLiDw = buildMultiServerFragment(undefined, 'li.server_id');
      const serverFragmentLi2Dw = buildMultiServerFragment(undefined, 'li2.server_id');
      const serverFragmentSelfDw = buildMultiServerFragment(undefined, 'p.server_id');
      const serverFragmentLoserDw = buildMultiServerFragment(undefined, 'p2.server_id');
      const deadWeightShowQuery = sql`
        SELECT m.id AS canonical_id,
          ${mediaSizeSubquery(sql`m.id`, serverFragmentLi2Dw)} AS total_file_size
        FROM media m
        WHERE m.merged_into_id IS NULL
          AND m.media_type = 'show'
          AND EXISTS (
            SELECT 1 FROM library_items li
            WHERE li.media_id = m.id AND li.removed_at IS NULL ${serverFragmentLiDw}
          )
          AND NOT EXISTS (
            SELECT 1 FROM user_media_plays_daily p WHERE p.show_media_id = m.id ${serverFragmentSelfDw}
            UNION ALL
            SELECT 1 FROM media loser
            JOIN user_media_plays_daily p2 ON p2.show_media_id = loser.id
            WHERE loser.merged_into_id = m.id ${serverFragmentLoserDw}
          )
      `;
      const deadWeightShowPlan = flattenPlan(await explainPlan(deadWeightShowQuery));
      expect(hasSeqScanOn(deadWeightShowPlan, 'media')).toBe(false);
      expect(usesIndexScan(deadWeightShowPlan, 'idx_media_show')).toBe(true);
      expect(usesIndexScan(deadWeightShowPlan, 'idx_library_items_media')).toBe(true);
    },
    SEED_TIMEOUT_MS
  );
});
