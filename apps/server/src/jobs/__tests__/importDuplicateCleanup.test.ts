/**
 * importDuplicateCleanup tests
 *
 * Deletes an imported session only when exactly one tracked row records the same
 * play and the tracked chain keeps its watched state, play and watch time. Every
 * statement stays inside constant server and started_at bounds so a compressed
 * chunk is never decompressed outside the window being walked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/client.js', () => ({
  db: { transaction: vi.fn(), execute: vi.fn(), select: vi.fn() },
}));

vi.mock('../../db/timescale.js', () => ({
  uncapDecompressionForTx: vi.fn(),
  getSessionChunkRanges: vi.fn(),
  getTimescaleStatus: vi.fn(),
}));

vi.mock('../sessionWalk.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sessionWalk.js')>()),
  sessionWalkWindows: vi.fn(),
}));

vi.mock('../../services/import/trackingCutoff.js', () => ({
  getServerTrackingStart: vi.fn(),
}));

import { db } from '../../db/client.js';
import { getSessionChunkRanges, uncapDecompressionForTx } from '../../db/timescale.js';
import { getServerTrackingStart } from '../../services/import/trackingCutoff.js';
import { queryChain, renderSql } from '../../test/helpers.js';
import {
  countAmbiguousImports,
  removeImportDuplicatesBatch,
  runImportDuplicateCleanupWalk,
} from '../importDuplicateCleanup.js';
import { sessionWalkWindows } from '../sessionWalk.js';
import type { SQL } from 'drizzle-orm';

const SERVER_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const IMPORT_A = '00000000-0000-4000-8000-00000000000a';
const IMPORT_B = '00000000-0000-4000-8000-00000000000b';
const ROOT_A = '00000000-0000-4000-8000-0000000000f1';
const ROOT_B = '00000000-0000-4000-8000-0000000000f2';
const CHILD_1 = '00000000-0000-4000-8000-0000000000c1';
const CHILD_2 = '00000000-0000-4000-8000-0000000000c2';

const CUTOFF = new Date('2026-02-01T00:02:00.000Z');
const WINDOW = {
  start: new Date('2026-02-01T00:00:00.000Z'),
  end: new Date('2026-03-01T00:00:00.000Z'),
};
const PLEX = { id: SERVER_ID, type: 'plex' as const, cutoff: CUTOFF };
const JELLYFIN = { id: SERVER_ID, type: 'jellyfin' as const, cutoff: CUTOFF };

const PAIR_A = {
  id: IMPORT_A,
  started_at: '2026-02-10 12:00:03+00',
  server_user_id: USER_ID,
  root_id: ROOT_A,
};
const PAIR_B = {
  id: IMPORT_B,
  started_at: '2026-02-08 09:30:00+00',
  server_user_id: USER_ID,
  root_id: ROOT_B,
};

const PASS_A = {
  i_id: IMPORT_A,
  passes: true,
  chain_start: '2026-02-10 12:00:00+00',
  chain_end: '2026-02-10 12:00:00+00',
};
const PASS_B = {
  i_id: IMPORT_B,
  passes: true,
  chain_start: '2026-02-08 09:29:57+00',
  chain_end: '2026-02-08 09:29:57+00',
};

type Statement = { sql: string; params: unknown[] };

function mockTransaction(executeResults: Array<{ rows: unknown[] }>) {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  for (const result of executeResults) execute.mockResolvedValueOnce(result);
  vi.mocked(db.transaction).mockImplementation((async (callback: (tx: unknown) => unknown) =>
    callback({ execute })) as never);
  return execute;
}

function statements(execute: ReturnType<typeof vi.fn>): Statement[] {
  return execute.mock.calls.map((call) => {
    const rendered = renderSql(call[0] as SQL);
    return { sql: rendered.sql.replace(/\s+/g, ' '), params: rendered.params };
  });
}

/** The param bound by the first match of `pattern`, whose last group is the $n index */
function boundParam(statement: Statement, pattern: RegExp): unknown {
  const match = pattern.exec(statement.sql);
  if (!match) throw new Error(`${pattern} not found in ${statement.sql}`);
  return statement.params[Number(match[match.length - 1]) - 1];
}

async function runFullBatch(kept = new Set<string>()) {
  vi.mocked(getSessionChunkRanges).mockResolvedValue([
    { start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') },
    { start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-03-01T00:00:00Z') },
  ]);
  const execute = mockTransaction([
    { rows: [PAIR_A] },
    { rows: [PASS_A] },
    { rows: [] },
    {
      rows: [
        { id: CHILD_1, started_at: '2026-02-10 13:00:00+00', reference_id: IMPORT_A },
        { id: CHILD_2, started_at: '2026-03-02 08:00:00+00', reference_id: IMPORT_A },
      ],
    },
    { rows: [] },
    { rows: [] },
    { rows: [{ started_at: PAIR_A.started_at }] },
  ]);
  const result = await removeImportDuplicatesBatch(PLEX, 1000, WINDOW, kept);
  return { result, statements: statements(execute) };
}

async function renderSelection(server: typeof PLEX | typeof JELLYFIN = PLEX) {
  const execute = mockTransaction([{ rows: [] }]);
  await removeImportDuplicatesBatch(server, 1000, WINDOW, new Set(['kept-id']));
  return statements(execute)[0]!;
}

async function renderVerdict() {
  const { statements: all } = await runFullBatch();
  return all[1]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(uncapDecompressionForTx).mockResolvedValue(undefined);
});

describe('removeImportDuplicatesBatch bounds', () => {
  it('bounds every sessions reference in every statement by constant server and started_at', async () => {
    const { statements: batch } = await runFullBatch();
    const skippedExecute = vi.fn().mockResolvedValue({ rows: [{ skipped: 0 }] });
    vi.mocked(db).execute = skippedExecute as never;
    await countAmbiguousImports(PLEX, WINDOW);
    const all = [...batch, ...statements(skippedExecute)];

    expect(all).toHaveLength(8);
    for (const statement of all) {
      const references = [...statement.sql.matchAll(/\bsessions\b(?: (\w+))?/g)];
      expect(references.length).toBeGreaterThan(0);
      for (const [, word] of references) {
        const alias = word && !/^(WHERE|SET|USING)$/.test(word) ? `${word}.` : '';
        const column = (name: string) => `(?<![\\w.])${alias.replace('.', '\\.')}${name}`;
        expect(statement.sql).toMatch(new RegExp(`${column('server_id')} = \\$\\d+`));
        expect(statement.sql).toMatch(
          new RegExp(`${column('started_at')} >= \\$\\d+::timestamptz`)
        );
      }
    }
  });

  it('clamps neighbour bounds to the cutoff but not the import count near the tracked row', async () => {
    const selection = await renderSelection();
    const verdict = await renderVerdict();

    expect(boundParam(selection, /i\.started_at >= \$(\d+)/)).toBe(CUTOFF.toISOString());
    expect(selection.sql).toMatch(/i\.started_at >= \$\d+::timestamptz AND i\.started_at >= \$\d+/);
    expect(boundParam(selection, /i\.started_at < \$(\d+)/)).toBe(WINDOW.end.toISOString());
    expect(boundParam(selection, /l\.started_at >= \$(\d+)/)).toBe(CUTOFF.toISOString());
    expect(boundParam(selection, /x\.started_at >= \$(\d+)/)).toBe(CUTOFF.toISOString());
    expect(boundParam(selection, /x\.started_at < \$(\d+)/)).toBe('2026-03-01T00:04:00.000Z');
    expect(boundParam(selection, /i2\.started_at >= \$(\d+)/)).toBe('2026-01-31T23:56:00.000Z');
    expect(boundParam(selection, /i2\.started_at < \$(\d+)/)).toBe('2026-03-01T00:04:00.000Z');
    expect(boundParam(verdict, /r\.started_at < \$(\d+)/)).toBe('2026-03-01T00:02:00.000Z');
  });
});

describe('removeImportDuplicatesBatch selection', () => {
  it('selects only pairs with one non-import neighbour that is tracked and one import near it', async () => {
    const selection = await renderSelection();

    expect(selection.sql).toMatch(
      /\(SELECT count\(\*\) FROM sessions x WHERE .*AND \(x\.session_key = 'tautulli-' \|\| x\.external_session_id\) IS NOT TRUE AND x\.server_user_id = i\.server_user_id .*\) = 1/
    );
    expect(selection.sql).toMatch(
      /\(SELECT count\(\*\) FROM sessions i2 WHERE .*AND i2\.external_session_id IS NOT NULL AND i2\.server_user_id = l\.server_user_id .*\) = 1/
    );
    expect(selection.sql).toContain('l.external_session_id IS NULL');
    expect(selection.sql).toContain(
      'l.server_user_id = i.server_user_id AND l.rating_key = i.rating_key AND (i.device_id IS NULL OR l.device_id IS NULL OR i.device_id = l.device_id) AND abs(extract(epoch FROM l.started_at - i.started_at)) <= 120'
    );
    expect(selection.sql).toMatch(/ORDER BY i\.started_at DESC LIMIT \$\d+/);
  });

  it('recognises Tautulli imports on Plex and keyed imports on Jellyfin and Emby', async () => {
    const plex = await renderSelection(PLEX);
    const jellyfin = await renderSelection(JELLYFIN);

    expect(plex.sql).toContain("(i.session_key = 'tautulli-' || i.external_session_id)");
    expect(plex.sql).not.toContain('i.session_key = i.external_session_id');
    expect(jellyfin.sql).toContain(
      '(i.external_session_id IS NOT NULL AND i.session_key = i.external_session_id)'
    );
    expect(jellyfin.sql).not.toContain('tautulli-');
  });

  it('excludes kept ids and adds pairs that fail a rule to the kept set', async () => {
    const kept = new Set(['kept-id']);
    const execute = mockTransaction([
      { rows: [PAIR_A, PAIR_B] },
      { rows: [{ i_id: IMPORT_A, passes: false }, PASS_B] },
      { rows: [] },
      { rows: [] },
      { rows: [{ started_at: PAIR_B.started_at }] },
    ]);

    const result = await removeImportDuplicatesBatch(PLEX, 1000, WINDOW, kept);

    const [selection, , , , remove] = statements(execute);
    expect(boundParam(selection!, /i\.id <> ALL\(\$(\d+)::uuid\[\]\)/)).toEqual(['kept-id']);
    expect(remove!.params).toContainEqual([IMPORT_B]);
    expect(remove!.params).not.toContainEqual([IMPORT_A]);
    expect([...kept]).toEqual(['kept-id', IMPORT_A]);
    expect(result.count).toBe(2);
    expect(result.deleted).toBe(1);
  });
});

describe('removeImportDuplicatesBatch nothing-lost rules', () => {
  it('keeps a pair whose root is missing from the bounds, is not tracked, or hangs off the import', async () => {
    const verdict = await renderVerdict();

    expect(verdict.sql).toMatch(
      /FROM sessions r WHERE r\.id = ANY\(\$\d+::uuid\[\]\) AND r\.server_id = \$\d+::uuid AND r\.server_user_id = ANY\(\$\d+::uuid\[\]\) AND r\.started_at >= \$\d+::timestamptz AND r\.started_at < \$\d+::timestamptz/
    );
    expect(verdict.sql).toContain(
      'r.id IS NOT NULL AND r.external_session_id IS NULL AND r.reference_id IS DISTINCT FROM i.id'
    );
    expect(verdict.sql).toContain(') IS TRUE AS passes');
  });

  it('requires the same media_id on the root and on every chain row it counts', async () => {
    const verdict = await renderVerdict();

    expect(verdict.sql).toContain('r.media_id IS NOT DISTINCT FROM i.media_id');
    expect(verdict.sql).toContain(
      'LEFT JOIN chain_totals t ON t.root_id = r.id AND t.media_id IS NOT DISTINCT FROM i.media_id'
    );
    expect(verdict.sql).toMatch(
      /JOIN sessions c ON c\.reference_id = root\.id WHERE c\.reference_id = ANY\(\$\d+::uuid\[\]\) AND c\.external_session_id IS NULL/
    );
  });

  it('keeps a watched import unless a tracked chain row is watched', async () => {
    const verdict = await renderVerdict();

    expect(verdict.sql).toContain('bool_or(watched) AS any_watched');
    expect(verdict.sql).toContain('AND (NOT i.watched OR t.any_watched)');
  });

  it('keeps an import with a counted play unless the root counts one on the same UTC day', async () => {
    const verdict = await renderVerdict();

    expect(verdict.sql).toContain(
      "AND (NOT (i.reference_id IS NULL AND COALESCE(i.duration_ms, 0) >= 120000) OR (r.reference_id IS NULL AND r.duration_ms >= 120000 AND (r.started_at AT TIME ZONE 'UTC')::date = (i.started_at AT TIME ZONE 'UTC')::date))"
    );
  });

  it('keeps an import longer than the whole tracked chain', async () => {
    const verdict = await renderVerdict();

    expect(verdict.sql).toContain('SUM(COALESCE(duration_ms, 0)) AS total_ms');
    expect(verdict.sql).toContain(
      'AND COALESCE(i.duration_ms, 0) <= COALESCE(t.total_ms, 0) + 15000'
    );
  });

  it('keeps an import whose counted watch time the chain rows of 120 s or more do not cover', async () => {
    const verdict = await renderVerdict();

    expect(verdict.sql).toContain(
      'SUM(duration_ms) FILTER (WHERE duration_ms >= 120000) AS counted_ms'
    );
    expect(verdict.sql).toContain(
      'AND (COALESCE(i.duration_ms, 0) < 120000 OR i.duration_ms <= COALESCE(t.counted_ms, 0) + 15000)'
    );
  });

  it('keeps an import that a tracked row references as its chain root', async () => {
    const execute = mockTransaction([{ rows: [PAIR_A, PAIR_B] }, { rows: [] }]);

    await removeImportDuplicatesBatch(PLEX, 1000, WINDOW, new Set());

    const verdict = statements(execute)[1]!;
    expect(verdict.sql).toMatch(
      /AND NOT EXISTS \(SELECT 1 FROM sessions lc WHERE lc\.server_id = \$\d+::uuid AND lc\.server_user_id = ANY\(\$\d+::uuid\[\]\) AND lc\.started_at >= \$\d+::timestamptz AND lc\.reference_id = ANY\(\$\d+::uuid\[\]\) AND lc\.reference_id = i\.id AND lc\.external_session_id IS NULL\)/
    );
    expect(boundParam(verdict, /lc\.started_at >= \$(\d+)/)).toBe(PAIR_B.started_at);
    expect(boundParam(verdict, /lc\.reference_id = ANY\(\$(\d+)/)).toEqual([IMPORT_A, IMPORT_B]);
    expect(verdict.sql).not.toMatch(/lc\.started_at <=? /);
  });

  it('keeps an import that an automation run or termination log references', async () => {
    const verdict = await renderVerdict();

    expect(verdict.sql).toContain(
      'AND NOT EXISTS (SELECT 1 FROM automation_runs ar WHERE ar.session_id = i.id)'
    );
    expect(verdict.sql).toContain(
      'AND NOT EXISTS (SELECT 1 FROM termination_logs tl WHERE tl.session_id = i.id)'
    );
  });
});

describe('removeImportDuplicatesBatch shared chains', () => {
  it('keeps a pair when another import sits near any row of its tracked chain', async () => {
    const execute = mockTransaction([
      { rows: [PAIR_A, PAIR_B] },
      {
        rows: [
          { ...PASS_A, chain_start: '2026-02-01 00:03:00+00', chain_end: '2026-02-01 01:00:00+00' },
          PASS_B,
        ],
      },
      { rows: [{ i_id: IMPORT_A }] },
      { rows: [] },
      { rows: [{ started_at: PAIR_B.started_at }] },
    ]);
    const kept = new Set<string>();

    const result = await removeImportDuplicatesBatch(PLEX, 1000, WINDOW, kept);

    const [, , competitors, , remove] = statements(execute);
    expect(competitors!.sql).toContain(
      'y.external_session_id IS NOT NULL AND y.id <> p.i_id AND y.server_user_id = ch.server_user_id'
    );
    expect(competitors!.sql).toMatch(
      /ch\.server_id = \$\d+::uuid AND ch\.server_user_id = ANY\(\$\d+::uuid\[\]\) AND ch\.started_at >= \$\d+::timestamptz AND ch\.started_at <= \$\d+::timestamptz/
    );
    expect(competitors!.sql).toMatch(
      /y\.server_id = \$\d+::uuid AND y\.server_user_id = ANY\(\$\d+::uuid\[\]\) AND y\.started_at >= \$\d+::timestamptz AND y\.started_at <= \$\d+::timestamptz/
    );
    expect(boundParam(competitors!, /ch\.started_at >= \$(\d+)/)).toBe('2026-02-01 00:03:00+00');
    expect(boundParam(competitors!, /ch\.started_at <= \$(\d+)/)).toBe('2026-02-08 09:29:57+00');
    // 00:03 minus 240 s lands before the 00:02 cutoff: no clamp
    expect(boundParam(competitors!, /y\.started_at >= \$(\d+)/)).toBe('2026-01-31T23:59:00.000Z');
    expect(boundParam(competitors!, /y\.started_at <= \$(\d+)/)).toBe('2026-02-08T09:33:57.000Z');
    expect(remove!.params).toContainEqual([IMPORT_B]);
    expect(remove!.params).not.toContainEqual([IMPORT_A]);
    expect([...kept]).toEqual([IMPORT_A]);
    expect(result).toMatchObject({ count: 2, deleted: 1 });
  });
});

describe('removeImportDuplicatesBatch children and delete', () => {
  it('skips the repoint update when no child points at a deleted import', async () => {
    const execute = mockTransaction([
      { rows: [PAIR_A] },
      { rows: [PASS_A] },
      { rows: [] },
      { rows: [] },
      { rows: [{ started_at: PAIR_A.started_at }] },
    ]);

    await removeImportDuplicatesBatch(PLEX, 1000, WINDOW, new Set());

    const all = statements(execute);
    expect(all).toHaveLength(5);
    expect(all[3]!.sql).toMatch(/^ SELECT id, started_at, reference_id FROM sessions WHERE/);
    expect(all[3]!.sql).toMatch(/reference_id = ANY\(\$\d+::uuid\[\]\)/);
    expect(all[3]!.sql).not.toMatch(/started_at <=? /);
    expect(all.some((s) => s.sql.includes('UPDATE sessions'))).toBe(false);
    expect(getSessionChunkRanges).not.toHaveBeenCalled();
    expect(all[4]!.sql).toMatch(/^ DELETE FROM sessions s/);
  });

  it('repoints children to the tracked root one chunk at a time before the delete', async () => {
    const { statements: all } = await runFullBatch();

    const [, , , , first, second, remove] = all;
    for (const [update, child] of [
      [first!, CHILD_1],
      [second!, CHILD_2],
    ] as const) {
      expect(update.sql).toMatch(/^ UPDATE sessions s SET reference_id = m\.root_id FROM unnest/);
      expect(update.params).toContainEqual([child]);
      expect(update.params).toContainEqual([ROOT_A]);
      expect(update.sql).toMatch(
        /s\.started_at >= \$\d+::timestamptz AND s\.started_at <= \$\d+::timestamptz/
      );
    }
    expect(boundParam(first!, /s\.started_at <= \$(\d+)/)).toBe('2026-02-10 13:00:00+00');
    expect(boundParam(second!, /s\.started_at >= \$(\d+)/)).toBe('2026-03-02 08:00:00+00');
    expect(remove!.sql).toMatch(/^ DELETE FROM sessions s USING unnest/);
  });

  it('returns the selected count, the deleted count and the oldest deleted start', async () => {
    mockTransaction([
      { rows: [PAIR_A, PAIR_B] },
      { rows: [PASS_A, PASS_B] },
      { rows: [] },
      { rows: [] },
      { rows: [{ started_at: PAIR_A.started_at }, { started_at: PAIR_B.started_at }] },
    ]);

    await expect(removeImportDuplicatesBatch(PLEX, 1000, WINDOW, new Set())).resolves.toEqual({
      count: 2,
      deleted: 2,
      oldest: new Date('2026-02-08T09:30:00.000Z'),
    });
  });
});

describe('runImportDuplicateCleanupWalk', () => {
  const OTHER_SERVER = '00000000-0000-4000-8000-000000000002';
  const windowA = {
    start: new Date('2026-03-01T00:00:00Z'),
    end: new Date('2026-04-01T00:00:00Z'),
  };
  const windowB = {
    start: new Date('2026-02-01T00:00:00Z'),
    end: new Date('2026-03-01T00:00:00Z'),
  };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(db.select).mockReturnValue(
      queryChain(vi.fn, [
        { id: SERVER_ID, type: 'plex' },
        { id: OTHER_SERVER, type: 'jellyfin' },
      ])
    );
    vi.mocked(getServerTrackingStart).mockResolvedValue(CUTOFF);
    vi.mocked(sessionWalkWindows).mockResolvedValue([windowA, windowB]);
  });

  it('leaves Dispatcharr history untouched while processing supported import providers', async () => {
    vi.mocked(db.select).mockReturnValue(
      queryChain(vi.fn, [
        { id: SERVER_ID, type: 'plex' },
        { id: OTHER_SERVER, type: 'dispatcharr' },
      ])
    );
    const runBatch = vi.fn().mockResolvedValue({ count: 0, deleted: 0, oldest: null });
    const countSkipped = vi.fn().mockResolvedValue(0);

    await runImportDuplicateCleanupWalk({
      onBatch: async () => undefined,
      onCommit: () => undefined,
      runBatch,
      countSkipped,
    });

    expect(getServerTrackingStart).toHaveBeenCalledExactlyOnceWith(SERVER_ID);
    expect(runBatch).toHaveBeenCalledTimes(2);
    for (const [server] of runBatch.mock.calls) {
      expect(server).toEqual(PLEX);
    }
    expect(countSkipped).toHaveBeenCalledTimes(2);
  });

  it('shares one kept set across every window and bisected sub-window of a server', async () => {
    const seen: Array<{ server: string; kept: Set<string> }> = [];
    let failedOnce = false;
    const runBatch = vi.fn(
      async (server: { id: string }, _limit: number, window: unknown, kept: Set<string>) => {
        seen.push({ server: server.id, kept });
        if (window === windowA && !failedOnce) {
          failedOnce = true;
          throw new Error('tuple decompression limit exceeded');
        }
        return { count: 0, deleted: 0, oldest: null };
      }
    );

    await runImportDuplicateCleanupWalk({
      onBatch: async () => undefined,
      onCommit: () => undefined,
      runBatch,
      countSkipped: async () => 0,
    });

    const plexSets = new Set(seen.filter((s) => s.server === SERVER_ID).map((s) => s.kept));
    const jellyfinSets = new Set(seen.filter((s) => s.server === OTHER_SERVER).map((s) => s.kept));
    expect(seen.filter((s) => s.server === SERVER_ID)).toHaveLength(4);
    expect(plexSets.size).toBe(1);
    expect(jellyfinSets.size).toBe(1);
    expect([...plexSets][0]).not.toBe([...jellyfinSets][0]);
  });

  it('reports the deleted count from details, never the selected total', async () => {
    vi.mocked(sessionWalkWindows).mockResolvedValue([windowB]);
    const runBatch = vi.fn(
      async (_server: unknown, _limit: number, _window: unknown, kept: Set<string>) => {
        kept.add(`kept-${kept.size}`);
        kept.add(`kept-${kept.size}`);
        return { count: 3, deleted: 1, oldest: new Date('2026-02-10T00:00:00Z') };
      }
    );
    const countSkipped = vi.fn().mockResolvedValue(4);

    const result = await runImportDuplicateCleanupWalk({
      onBatch: async () => undefined,
      onCommit: () => undefined,
      runBatch,
      countSkipped,
    });

    expect(result.total).toBe(6);
    expect(result.earliest).toEqual(new Date('2026-02-10T00:00:00Z'));
    expect(countSkipped).toHaveBeenCalledTimes(2);
    expect(result.details).toBe(
      'Removed 2 duplicate imported sessions; kept 4 that could not be proven to add nothing; skipped 8 with more than one possible match'
    );
  });
});
