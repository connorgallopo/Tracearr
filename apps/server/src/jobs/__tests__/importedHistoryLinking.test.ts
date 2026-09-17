/**
 * importedHistoryLinking tests
 *
 * Links orphaned imported Plex sessions only through an exact identifier that
 * resolves to one canonical media row: the Plex guid Tautulli recorded under
 * the session's rating key, or a movie's IMDb or TMDB id. The job's state
 * decides whether library syncs keep handing it off.
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

vi.mock('../../lib/redisShared.js', () => ({
  getRedis: vi.fn(),
}));

vi.mock('../poller/database.js', async () => {
  const { sql } = await import('drizzle-orm');
  return {
    CONTAINER_MEDIA_TYPES_SQL: sql.join(
      ['show', 'season', 'artist', 'album'].map((type) => sql`${type}`),
      sql`, `
    ),
    batchResolveMediaByPlexGuid: vi.fn(),
  };
});

vi.mock('../../services/settings.js', () => ({
  getImportedHistoryLinkState: vi.fn(),
  getSettings: vi.fn(),
  setImportedHistoryLinkState: vi.fn(),
}));

vi.mock('../../services/tautulli.js', () => ({
  TautulliService: vi.fn(),
}));

vi.mock('../librarySyncQueue.js', () => ({
  hasPendingLibrarySync: vi.fn(),
}));

vi.mock('../../services/import/trackingCutoff.js', () => ({
  getServerTrackingStart: vi.fn(),
}));

import { db } from '../../db/client.js';
import { getRedis } from '../../lib/redisShared.js';
import {
  getImportedHistoryLinkState,
  getSettings,
  setImportedHistoryLinkState,
} from '../../services/settings.js';
import { getServerTrackingStart } from '../../services/import/trackingCutoff.js';
import { queryChain, renderSql } from '../../test/helpers.js';
import {
  importedHistoryLinkDeps,
  runImportedHistoryLinkingWalk,
} from '../importedHistoryLinking.js';
import { hasPendingLibrarySync } from '../librarySyncQueue.js';
import { batchResolveMediaByPlexGuid } from '../poller/database.js';
import { sessionWalkWindows } from '../sessionWalk.js';
import type { SQL } from 'drizzle-orm';

const SERVER_A = '00000000-0000-4000-8000-00000000000a';
const SERVER_B = '00000000-0000-4000-8000-00000000000b';
const MEDIA_ID = '00000000-0000-4000-8000-0000000000e1';
const SHOW_ID = '00000000-0000-4000-8000-0000000000e2';

interface FakeServer {
  id: string;
  name: string;
  machineIdentifier: string | null;
  scanVersion: string | null;
  synced: boolean;
  libraryIds: string[];
  orphanKeys: Array<{ rating_key: string; media_type: 'movie' | 'episode' }>;
}

type Statement = { sql: string; params: unknown[] };

const ARMED_AT = new Date().toISOString();
const PENDING = {
  state: 'pending',
  providerPassDoneServers: [],
  autoAttempts: 0,
  generation: 0,
  armedAt: ARMED_AT,
};
const DAY_MS = 86_400_000;
const WINDOW_MESSAGE =
  'Automatic runs stop 14 days after the last Tautulli import, Tautulli settings save or added Plex server; run Link Imported Plex History from Settings > Jobs to retry';

function plexServer(overrides: Partial<FakeServer> & { id: string }): FakeServer {
  return {
    name: 'Home',
    machineIdentifier: `pms-${overrides.id}`,
    scanVersion: '2',
    synced: true,
    libraryIds: ['lib-1'],
    orphanKeys: [],
    ...overrides,
  };
}

/**
 * Wires the db, Redis and state mocks; returns every statement the walk runs.
 * A guid link select returns the picked rows whose (rating key, external
 * session id) pair is among its first two array params.
 */
function setup(
  servers: FakeServer[],
  state: object = PENDING,
  picked: object[] = [],
  providerPicked: object[] = []
): Statement[] {
  const statements: Statement[] = [];
  const record = (query: SQL) => {
    const rendered = renderSql(query);
    const statement = { sql: rendered.sql.replace(/\s+/g, ' '), params: rendered.params };
    statements.push(statement);
    return statement;
  };

  vi.mocked(getImportedHistoryLinkState).mockResolvedValue(state as never);
  vi.mocked(db.select).mockReturnValue(
    queryChain(
      vi.fn,
      servers.map((s) => ({ id: s.id, name: s.name, machineIdentifier: s.machineIdentifier }))
    )
  );
  vi.mocked(db.execute).mockImplementation((async (query: SQL) => {
    const statement = record(query);
    const server = servers.find((s) => statement.params.includes(s.id));
    if (statement.sql.includes('FROM libraries WHERE')) {
      return { rows: server?.synced ? [{ '?column?': 1 }] : [] };
    }
    if (statement.sql.includes('DISTINCT library_id')) {
      return { rows: (server?.libraryIds ?? []).map((id) => ({ library_id: id })) };
    }
    if (statement.sql.includes('DISTINCT o.rating_key')) {
      return { rows: server?.orphanKeys ?? [] };
    }
    return { rows: [] };
  }) as never);
  vi.mocked(getRedis).mockReturnValue({
    mget: vi.fn(async (keys: string[]) =>
      keys.map((key) => servers.find((s) => key.includes(s.id))?.scanVersion ?? null)
    ),
  } as never);
  vi.mocked(db.transaction).mockImplementation((async (callback: (tx: unknown) => unknown) =>
    callback({
      execute: vi.fn(async (query: SQL) => {
        const statement = record(query);
        if (statement.sql.includes('by_imdb')) return { rows: providerPicked };
        if (statement.sql.includes('UPDATE sessions s')) {
          const [ids] = statement.params as string[][];
          return { rows: (ids ?? []).map(() => ({ started_at: '2026-02-10 12:00:00+00' })) };
        }
        if (!statement.sql.includes('JOIN unnest(')) return { rows: [] };
        const [keys, ids] = statement.params as string[][];
        return {
          rows: (picked as Array<{ rating_key: string; external_session_id: string }>).filter(
            (row) =>
              keys?.some((key, i) => key === row.rating_key && ids?.[i] === row.external_session_id)
          ),
        };
      }),
    })) as never);
  return statements;
}

/** Each key's rows carry reference id `ref-<key>` unless `referenceIds` names others. */
function tautulliStub(
  pmsIdentifier: string | null,
  guids: Record<string, string[]> | null,
  referenceIds: Record<string, string[]> = {}
) {
  return {
    getPmsIdentifier: vi.fn().mockResolvedValue(pmsIdentifier),
    getGuidsByRatingKey: vi.fn(async (keys: string[]) =>
      guids === null
        ? null
        : new Map(
            keys.flatMap((k) => {
              const rows = guids[k];
              if (!rows) return [];
              const refs = new Set(referenceIds[k] ?? [`ref-${k}`]);
              return [[k, { guids: new Set(rows), referenceIds: refs }] as const];
            })
          )
    ),
  };
}

const providerStatements = (all: Statement[]) => all.filter((s) => s.sql.includes('by_imdb'));
const guidStatements = (all: Statement[]) => all.filter((s) => s.sql.includes('JOIN unnest('));

async function walk(
  tautulli: ReturnType<typeof tautulliStub> | null,
  trigger: 'manual' | 'auto' = 'manual'
) {
  return runImportedHistoryLinkingWalk({
    tautulli,
    trigger,
    hasPendingLibrarySync,
    onBatch: async () => undefined,
    onCommit: () => undefined,
  });
}

function lastState() {
  return vi.mocked(setImportedHistoryLinkState).mock.calls.at(-1)?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(sessionWalkWindows).mockResolvedValue(null);
  vi.mocked(batchResolveMediaByPlexGuid).mockResolvedValue(new Map());
  vi.mocked(hasPendingLibrarySync).mockResolvedValue(false);
  vi.mocked(getServerTrackingStart).mockResolvedValue(new Date('2027-01-01T00:00:00Z'));
  vi.mocked(setImportedHistoryLinkState).mockResolvedValue(true);
});

describe('runImportedHistoryLinkingWalk readiness', () => {
  it('writes nothing to a server scanned at version 1 and never counts it as an attempt', async () => {
    const statements = setup([
      plexServer({
        id: SERVER_A,
        scanVersion: '1',
        orphanKeys: [{ rating_key: '10', media_type: 'movie' }],
      }),
    ]);
    const tautulli = tautulliStub(`pms-${SERVER_A}`, { '10': ['plex://movie/aaa'] });

    const result = await walk(tautulli, 'auto');

    expect(db.transaction).not.toHaveBeenCalled();
    expect(tautulli.getPmsIdentifier).not.toHaveBeenCalled();
    expect(statements.some((s) => s.sql.includes('rating_key'))).toBe(false);
    expect(lastState()).toEqual({
      state: 'pending',
      providerPassDoneServers: [],
      autoAttempts: 0,
      generation: 0,
      armedAt: ARMED_AT,
    });
    expect(result.details).toBe(
      'No imported plays were linked; waiting for a library sync or a full library scan on Plex server Home'
    );
  });

  it('never counts an attempt for a server that has not finished a library sync, even with none pending', async () => {
    const statements = setup([
      plexServer({
        id: SERVER_A,
        synced: false,
        libraryIds: [],
        orphanKeys: [{ rating_key: '10', media_type: 'movie' }],
      }),
    ]);
    const tautulli = tautulliStub(`pms-${SERVER_A}`, { '10': ['plex://movie/aaa'] });

    await walk(tautulli, 'auto');

    expect(db.transaction).not.toHaveBeenCalled();
    expect(tautulli.getPmsIdentifier).not.toHaveBeenCalled();
    expect(statements.some((s) => s.sql.includes('rating_key'))).toBe(false);
    expect(lastState()).toEqual(PENDING);
  });

  it('names every waiting server and says automatic runs stopped when an incomplete run makes the fifth attempt', async () => {
    const servers = [
      plexServer({ id: SERVER_A, name: 'Attic' }),
      plexServer({ id: SERVER_B, name: 'Office', synced: false, libraryIds: [] }),
      plexServer({ id: '00000000-0000-4000-8000-00000000000c', scanVersion: '1' }),
    ];
    vi.mocked(getServerTrackingStart).mockResolvedValue(null);
    setup(servers, { ...PENDING, autoAttempts: 3 });
    const fourth = await walk(null, 'auto');
    expect(fourth.details).not.toContain('Automatic runs stopped');

    setup(servers, { ...PENDING, autoAttempts: 4 });
    const fifth = await walk(null, 'auto');

    expect(lastState()).toMatchObject({ autoAttempts: 5 });
    expect(fifth.details).toBe(
      'No imported plays were linked; waiting for a library sync or a full library scan on Plex servers Office, Home. ' +
        'Automatic runs stopped after 5 incomplete attempts; run Link Imported Plex History from Settings > Jobs to retry'
    );
  });

  it('warns on an automatic run that starts within two days of the 14-day limit, stays incomplete and writes its state', async () => {
    const servers = [plexServer({ id: SERVER_A, synced: false, libraryIds: [] })];
    const nearLimit = new Date(Date.now() - 13.5 * DAY_MS).toISOString();

    setup(servers, { ...PENDING, armedAt: nearLimit });
    expect((await walk(null, 'auto')).details).toContain(`. ${WINDOW_MESSAGE}`);

    setup(servers, { ...PENDING, armedAt: nearLimit });
    expect((await walk(null, 'manual')).details).not.toContain(WINDOW_MESSAGE);

    setup(servers, { ...PENDING, armedAt: new Date(Date.now() - 11 * DAY_MS).toISOString() });
    expect((await walk(null, 'auto')).details).not.toContain(WINDOW_MESSAGE);

    setup(servers, { ...PENDING, armedAt: new Date(Date.now() - 12.5 * DAY_MS).toISOString() });
    expect((await walk(null, 'auto')).details).toContain(WINDOW_MESSAGE);

    setup(servers, { ...PENDING, armedAt: nearLimit });
    vi.mocked(setImportedHistoryLinkState).mockResolvedValueOnce(false);
    expect((await walk(null, 'auto')).details).not.toContain(WINDOW_MESSAGE);

    setup([plexServer({ id: SERVER_A })], { ...PENDING, armedAt: nearLimit });
    expect((await walk(null, 'auto')).details).not.toContain(WINDOW_MESSAGE);
  });

  it('writes nothing to a server with a library sync waiting or running for it and never counts it as an attempt', async () => {
    const statements = setup([
      plexServer({ id: SERVER_A, orphanKeys: [{ rating_key: '10', media_type: 'movie' }] }),
      plexServer({ id: SERVER_B }),
    ]);
    vi.mocked(hasPendingLibrarySync).mockImplementation(async (serverId) => serverId === SERVER_A);
    const tautulli = tautulliStub(`pms-${SERVER_A}`, { '10': ['plex://movie/aaa'] });

    await walk(tautulli, 'auto');

    expect(hasPendingLibrarySync).toHaveBeenCalledWith(SERVER_A);
    expect(tautulli.getGuidsByRatingKey).not.toHaveBeenCalled();
    expect(statements.some((s) => s.params.includes(SERVER_A))).toBe(false);
    expect(lastState()).toEqual({
      state: 'pending',
      providerPassDoneServers: [SERVER_B],
      autoAttempts: 0,
      generation: 0,
      armedAt: ARMED_AT,
    });
  });

  it('treats a library scanned at version 3 as ready', async () => {
    const statements = setup([plexServer({ id: SERVER_A, scanVersion: '3' })]);

    await walk(null);

    expect(providerStatements(statements)).toHaveLength(1);
    expect(lastState()).toEqual({
      state: 'done',
      providerPassDoneServers: [SERVER_A],
      autoAttempts: 0,
      generation: 0,
      armedAt: ARMED_AT,
    });
  });

  it('treats a server with no library items as ready', async () => {
    const statements = setup([plexServer({ id: SERVER_A, scanVersion: null, libraryIds: [] })]);

    await walk(null, 'auto');

    expect(providerStatements(statements)).toHaveLength(1);
    expect(lastState()).toEqual({
      state: 'done',
      providerPassDoneServers: [SERVER_A],
      autoAttempts: 0,
      generation: 0,
      armedAt: ARMED_AT,
    });
  });
});

describe('runImportedHistoryLinkingWalk guid pass', () => {
  it('skips guid writes when Tautulli belongs to another Plex server and still runs the provider pass', async () => {
    const statements = setup([
      plexServer({ id: SERVER_A, orphanKeys: [{ rating_key: '10', media_type: 'movie' }] }),
    ]);
    const tautulli = tautulliStub('pms-some-other-server', { '10': ['plex://movie/aaa'] });

    const result = await walk(tautulli);

    expect(tautulli.getGuidsByRatingKey).not.toHaveBeenCalled();
    expect(guidStatements(statements)).toHaveLength(0);
    expect(providerStatements(statements)).toHaveLength(1);
    expect(lastState()).toMatchObject({ state: 'done' });
    expect(result.details).toBe(
      'No imported plays were linked; did not use Tautulli history on 1 Plex server Tautulli does not monitor'
    );
  });

  it('drops a rating key whose Tautulli rows carry more than one guid', async () => {
    const statements = setup([
      plexServer({ id: SERVER_A, orphanKeys: [{ rating_key: '10', media_type: 'movie' }] }),
    ]);
    const tautulli = tautulliStub(`pms-${SERVER_A}`, {
      '10': ['plex://movie/aaa', 'plex://movie/bbb'],
    });
    vi.mocked(batchResolveMediaByPlexGuid).mockResolvedValue(
      new Map([
        [
          'plex://movie/aaa',
          { mediaId: MEDIA_ID, showMediaId: null, imdbId: null, tmdbId: null, tvdbId: null },
        ],
      ])
    );

    const result = await walk(tautulli);

    expect(guidStatements(statements)).toHaveLength(0);
    expect(result.details).toContain('skipped 1 title matching more than one Plex item');
  });

  it('links only when every row carries the same guid once its query is stripped, never a legacy and plex mix', async () => {
    const statements = setup([
      plexServer({
        id: SERVER_A,
        orphanKeys: [
          { rating_key: '10', media_type: 'movie' },
          { rating_key: '20', media_type: 'movie' },
        ],
      }),
    ]);
    const tautulli = tautulliStub(`pms-${SERVER_A}`, {
      '10': ['plex://movie/aaa?lang=en', 'plex://movie/aaa'],
      '20': ['com.plexapp.agents.imdb://tt0111161?lang=en', 'plex://movie/bbb'],
    });
    vi.mocked(batchResolveMediaByPlexGuid).mockImplementation(
      async (_server, guids) =>
        new Map(
          guids.map((g) => [
            g.guid,
            { mediaId: MEDIA_ID, showMediaId: null, imdbId: null, tmdbId: null, tvdbId: null },
          ])
        )
    );

    await walk(tautulli);

    expect(batchResolveMediaByPlexGuid).toHaveBeenCalledWith(SERVER_A, [
      { guid: 'plex://movie/aaa', mediaType: 'movie' },
    ]);
    const [link] = guidStatements(statements);
    expect(link?.params).toContainEqual(['10']);
    expect(link?.params.flat()).not.toContain('20');
  });

  it('writes no orphan whose external session id Tautulli did not return under its key, even with one agreeing guid', async () => {
    const statements = setup(
      [plexServer({ id: SERVER_A, orphanKeys: [{ rating_key: '10', media_type: 'movie' }] })],
      PENDING,
      [
        {
          id: 'session-1',
          started_at: '2026-02-10 12:00:00+00',
          rating_key: '10',
          external_session_id: '4242',
          media_type: 'movie',
          media_id: MEDIA_ID,
          show_media_id: null,
          imdb_id: null,
          tmdb_id: null,
          tvdb_id: null,
        },
      ]
    );
    const tautulli = tautulliStub(
      `pms-${SERVER_A}`,
      { '10': ['plex://movie/aaa'] },
      { '10': ['900'] }
    );
    vi.mocked(batchResolveMediaByPlexGuid).mockResolvedValue(
      new Map([
        [
          'plex://movie/aaa',
          { mediaId: MEDIA_ID, showMediaId: null, imdbId: null, tmdbId: null, tvdbId: null },
        ],
      ])
    );

    const result = await walk(tautulli);

    const [link] = guidStatements(statements);
    expect(link?.params.slice(0, 2)).toEqual([['10'], ['900']]);
    expect(statements.some((s) => s.sql.includes('UPDATE sessions s'))).toBe(false);
    expect(result.total).toBe(0);
  });

  it('drops a key or movie that resolves to two canonical ids', async () => {
    const statements = setup([
      plexServer({ id: SERVER_A, orphanKeys: [{ rating_key: '10', media_type: 'episode' }] }),
    ]);
    const tautulli = tautulliStub(`pms-${SERVER_A}`, { '10': ['plex://episode/aaa'] });
    // batchResolveMediaByPlexGuid leaves out a guid that resolves to two canonical ids.
    vi.mocked(batchResolveMediaByPlexGuid).mockResolvedValue(new Map());

    await walk(tautulli);

    expect(batchResolveMediaByPlexGuid).toHaveBeenCalledWith(SERVER_A, [
      { guid: 'plex://episode/aaa', mediaType: 'episode' },
    ]);
    expect(guidStatements(statements)).toHaveLength(0);
    const [provider] = providerStatements(statements);
    expect(provider?.sql).toContain('JOIN media c ON c.id = COALESCE(m.merged_into_id, m.id)');
    expect(provider?.sql).toContain("c.media_type = 'movie'");
    expect(provider?.sql).toContain('COALESCE(bi.matches, 1) = 1 AND COALESCE(bt.matches, 1) = 1');
    expect(provider?.sql).toContain(
      '(bi.media_id IS NULL OR bt.media_id IS NULL OR bi.media_id = bt.media_id)'
    );
  });
});

describe('runImportedHistoryLinkingWalk state', () => {
  it('keeps pending and counts an automatic attempt when Tautulli returns no rows for any orphan key', async () => {
    setup([
      plexServer({
        id: SERVER_A,
        orphanKeys: [
          { rating_key: '10', media_type: 'movie' },
          { rating_key: '20', media_type: 'episode' },
        ],
      }),
    ]);

    const result = await walk(tautulliStub(`pms-${SERVER_A}`, {}), 'auto');

    expect(result.details).toContain('Tautulli returned no history for 2 titles');
    expect(lastState()).toEqual({
      state: 'pending',
      providerPassDoneServers: [SERVER_A],
      autoAttempts: 1,
      generation: 0,
      armedAt: ARMED_AT,
    });
  });

  it('keeps pending when one answered batch returns no rows for any of its keys while another does', async () => {
    const orphanKeys = Array.from({ length: 150 }, (_, i) => ({
      rating_key: String(i),
      media_type: 'movie' as const,
    }));
    setup([plexServer({ id: SERVER_A, orphanKeys })]);
    const tautulli = tautulliStub(
      `pms-${SERVER_A}`,
      Object.fromEntries(orphanKeys.slice(0, 100).map((k) => [k.rating_key, ['plex://movie/aaa']]))
    );

    const result = await walk(tautulli);

    expect(tautulli.getGuidsByRatingKey).toHaveBeenCalledTimes(2);
    expect(result.details).toContain('Tautulli returned no history for 50 titles');
    expect(lastState()).toMatchObject({ state: 'pending' });
  });

  it('keeps pending after a null Tautulli batch and counts an attempt only when triggered automatically', async () => {
    const server = plexServer({
      id: SERVER_A,
      orphanKeys: [{ rating_key: '10', media_type: 'movie' }],
    });

    setup([server]);
    await walk(tautulliStub(`pms-${SERVER_A}`, null), 'manual');
    expect(lastState()).toEqual({
      state: 'pending',
      providerPassDoneServers: [SERVER_A],
      autoAttempts: 0,
      generation: 0,
      armedAt: ARMED_AT,
    });

    setup([server], { ...PENDING, providerPassDoneServers: [SERVER_A], autoAttempts: 2 });
    await walk(tautulliStub(`pms-${SERVER_A}`, null), 'auto');
    expect(lastState()).toEqual({
      state: 'pending',
      providerPassDoneServers: [SERVER_A],
      autoAttempts: 3,
      generation: 0,
      armedAt: ARMED_AT,
    });
  });

  it('marks linking done once every Plex server is ready and complete, bounding every sessions reference', async () => {
    vi.mocked(sessionWalkWindows).mockResolvedValue([
      { start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-03-01T00:00:00Z') },
    ]);
    const statements = setup(
      [
        plexServer({ id: SERVER_A, orphanKeys: [{ rating_key: '10', media_type: 'episode' }] }),
        plexServer({ id: SERVER_B }),
      ],
      { ...PENDING, generation: 7 },
      [
        {
          id: 'session-1',
          started_at: '2026-02-10 12:00:00+00',
          rating_key: '10',
          external_session_id: 'ref-10',
          media_type: 'episode',
          media_id: MEDIA_ID,
          show_media_id: SHOW_ID,
          imdb_id: null,
          tmdb_id: null,
          tvdb_id: 81189,
        },
      ]
    );
    const tautulli = tautulliStub(`pms-${SERVER_A}`, { '10': ['plex://episode/aaa'] });
    vi.mocked(batchResolveMediaByPlexGuid).mockResolvedValue(
      new Map([
        [
          'plex://episode/aaa',
          { mediaId: MEDIA_ID, showMediaId: SHOW_ID, imdbId: null, tmdbId: null, tvdbId: 81189 },
        ],
      ])
    );

    await walk(tautulli, 'auto');

    expect(setImportedHistoryLinkState).toHaveBeenCalledWith(7, {
      state: 'done',
      providerPassDoneServers: [SERVER_A, SERVER_B],
      autoAttempts: 0,
      generation: 7,
      armedAt: ARMED_AT,
    });
    const [link] = guidStatements(statements);
    expect(link?.params).toEqual(expect.arrayContaining([[MEDIA_ID], [SHOW_ID], [81189]]));
    const update = statements.find((s) => s.sql.includes('UPDATE sessions s'));
    expect(update?.params).toEqual(expect.arrayContaining([['session-1'], [MEDIA_ID], [SHOW_ID]]));
    const sessionStatements = statements.filter((s) => / sessions \w+/.test(s.sql));
    expect(sessionStatements.length).toBeGreaterThanOrEqual(5);
    for (const statement of sessionStatements) {
      for (const [, alias] of statement.sql.matchAll(/(?:FROM|JOIN|UPDATE) sessions (\w+)/g)) {
        expect(statement.sql).toMatch(
          new RegExp(
            `${alias}\\.server_id = \\$\\d+::uuid AND ${alias}\\.started_at >= \\$\\d+::timestamptz AND ${alias}\\.started_at < \\$\\d+::timestamptz`
          )
        );
      }
      expect(statement.sql).toMatch(/external_session_id IS NOT NULL/);
    }
  });

  it('skips the provider pass for a server already done and never adds a server that was not ready', async () => {
    const ready = plexServer({ id: SERVER_A });
    const notReady = plexServer({ id: SERVER_B, scanVersion: null });

    setup([ready, notReady]);
    await walk(null);
    const first = lastState();
    expect(first).toEqual({
      state: 'pending',
      providerPassDoneServers: [SERVER_A],
      autoAttempts: 0,
      generation: 0,
      armedAt: ARMED_AT,
    });

    const statements = setup([ready, notReady], first as object);
    await walk(null);

    expect(providerStatements(statements)).toHaveLength(0);
    expect(lastState()).toEqual({
      state: 'pending',
      providerPassDoneServers: [SERVER_A],
      autoAttempts: 0,
      generation: 0,
      armedAt: ARMED_AT,
    });
  });

  it('treats a job without a trigger option as manual', async () => {
    vi.mocked(getSettings).mockResolvedValue({ tautulliUrl: null, tautulliApiKey: null } as never);
    const deps = await importedHistoryLinkDeps(undefined);
    expect(deps).toEqual({ tautulli: null, trigger: 'manual', hasPendingLibrarySync });

    setup([plexServer({ id: SERVER_A, orphanKeys: [{ rating_key: '10', media_type: 'movie' }] })]);
    await runImportedHistoryLinkingWalk({
      ...deps,
      tautulli: tautulliStub(`pms-${SERVER_A}`, null),
      onBatch: async () => undefined,
      onCommit: () => undefined,
    });

    expect(lastState()).toMatchObject({ state: 'pending', autoAttempts: 0 });
  });
});

describe('runImportedHistoryLinkingWalk tracking cutoff', () => {
  const CUTOFF = new Date('2026-02-15T00:00:00Z');
  const orphanRow = (overrides: object) => ({
    id: 'session-1',
    started_at: '2026-02-10 12:00:00+00',
    rating_key: '10',
    external_session_id: 'ref-10',
    media_type: 'movie',
    media_id: MEDIA_ID,
    show_media_id: null,
    imdb_id: null,
    tmdb_id: null,
    tvdb_id: null,
    ...overrides,
  });

  it('bounds every orphan read and write below the server cutoff and skips windows after it', async () => {
    vi.mocked(getServerTrackingStart).mockResolvedValue(CUTOFF);
    vi.mocked(sessionWalkWindows).mockResolvedValue([
      { start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') },
      { start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-03-01T00:00:00Z') },
    ]);
    const statements = setup(
      [plexServer({ id: SERVER_A, orphanKeys: [{ rating_key: '10', media_type: 'movie' }] })],
      PENDING,
      [orphanRow({})],
      [orphanRow({ id: 'session-2', rating_key: '20', imdb_id: 'tt0111161' })]
    );
    vi.mocked(batchResolveMediaByPlexGuid).mockResolvedValue(
      new Map([
        [
          'plex://movie/aaa',
          { mediaId: MEDIA_ID, showMediaId: null, imdbId: null, tmdbId: null, tvdbId: null },
        ],
      ])
    );

    const result = await walk(tautulliStub(`pms-${SERVER_A}`, { '10': ['plex://movie/aaa'] }));

    expect(result.details).toBe(
      'Linked 1 imported play using Tautulli history; linked 1 imported movie play by IMDb or TMDB id'
    );
    expect(getServerTrackingStart).toHaveBeenCalledTimes(1);
    const sessionStatements = statements.filter((s) => / sessions \w+/.test(s.sql));
    expect(sessionStatements.filter((s) => s.sql.includes('DISTINCT o.rating_key'))).toHaveLength(
      1
    );
    expect(guidStatements(sessionStatements)).toHaveLength(1);
    expect(providerStatements(sessionStatements)).toHaveLength(1);
    expect(sessionStatements.filter((s) => s.sql.includes('UPDATE sessions s'))).toHaveLength(2);
    for (const statement of sessionStatements) {
      expect(statement.params).not.toContain('2026-04-01T00:00:00.000Z');
      for (const [, alias] of statement.sql.matchAll(/(?:FROM|JOIN|UPDATE) sessions (\w+)/g)) {
        const bound = [
          ...statement.sql.matchAll(
            new RegExp(`${alias}\\.started_at < \\$(\\d+)::timestamptz`, 'g')
          ),
        ].map(([, n]) => statement.params[Number(n) - 1]);
        expect(bound).toContain(CUTOFF.toISOString());
      }
    }
  });

  it('writes nothing to a server whose row has no cutoff and keeps linking pending', async () => {
    vi.mocked(getServerTrackingStart).mockResolvedValue(null);
    const statements = setup([
      plexServer({ id: SERVER_A, orphanKeys: [{ rating_key: '10', media_type: 'movie' }] }),
    ]);
    const tautulli = tautulliStub(`pms-${SERVER_A}`, { '10': ['plex://movie/aaa'] });

    await walk(tautulli);

    expect(statements.some((s) => / sessions \w+/.test(s.sql))).toBe(false);
    expect(tautulli.getGuidsByRatingKey).not.toHaveBeenCalled();
    expect(lastState()).toEqual(PENDING);
  });
});
