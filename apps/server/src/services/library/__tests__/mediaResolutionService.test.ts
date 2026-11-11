/**
 * mediaResolutionService.resolveMediaBatch tests - covers the stored-identity
 * skip added to avoid re-resolving (and re-locking) items whose identity
 * hasn't changed since the last sync.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
  },
}));

import { db } from '../../../db/client.js';
import { resolveMediaBatch } from '../mediaResolutionService.js';
import { buildMediaMatchKey, type MatchKeyInput } from '../mediaMatchKey.js';

/** A select chain resolving to `rows`, whether or not the query ends in orderBy(). */
function selectResolving(rows: unknown[]) {
  const result = Object.assign(Promise.resolve(rows), {
    orderBy: vi.fn().mockResolvedValue(rows),
  });
  return {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnValue(result),
  };
}

/** loadStoredIdentities gets `rows`; the merged-away revalidation query that
 *  follows gets `mergedAwayIds` (defaults to none stale). */
function mockStoredIdentitiesQuery(rows: unknown[], mergedAwayIds: string[] = []) {
  let call = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const response = call === 0 ? rows : mergedAwayIds.map((id) => ({ id }));
    call++;
    return selectResolving(response) as never;
  });
}

// Batched-miss insert: returning() echoes every inserted matchKey back with `newId`
function mockBatchInsert(newId: string, opts: { conflict?: boolean } = {}) {
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    returning: vi.fn().mockImplementation(() => {
      if (opts.conflict) return Promise.resolve([]);
      const values = insertChain.values.mock.calls[0]![0] as Array<{ matchKey: string }>;
      return Promise.resolve(values.map((v) => ({ id: newId, matchKey: v.matchKey })));
    }),
  };
  vi.mocked(db.insert).mockReturnValue(insertChain as never);
  return insertChain;
}

/** Wires db.transaction so resolveMediaForItem finds no existing row by
 *  provider id and inserts a fresh one, returning `newId`. */
function mockFreshResolution(newId: string) {
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: newId }]),
  };
  const selectChain = selectResolving([]); // no hits by provider id
  const tx = {
    execute: vi.fn().mockResolvedValue(undefined),
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
  };
  vi.mocked(db.transaction).mockImplementation((async (callback: (tx: unknown) => unknown) =>
    callback(tx)) as never);
  return { tx, insertChain, selectChain };
}

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    ratingKey: 'rk-1',
    mediaId: randomUUID(),
    mediaType: 'movie',
    imdbId: null,
    tmdbId: 603,
    tvdbId: null,
    title: 'The Matrix',
    year: 1999,
    grandparentRatingKey: null,
    parentRatingKey: null,
    parentIndex: null,
    itemIndex: null,
    mediaShowMediaId: null,
    mediaMatchKey: null,
    ...overrides,
  };
}

function trackInput(overrides: Partial<MatchKeyInput> = {}): MatchKeyInput {
  return {
    mediaType: 'track',
    title: 'Intro',
    serverId: 'server-1',
    ratingKey: 'rk-1',
    grandparentTitle: 'Boards of Canada',
    parentTitle: 'Music Has the Right to Children',
    ...overrides,
  };
}

function movieInput(overrides: Partial<MatchKeyInput> = {}): MatchKeyInput {
  return {
    mediaType: 'movie',
    imdbId: null,
    tmdbId: 603,
    tvdbId: null,
    title: 'The Matrix',
    year: 1999,
    serverId: 'server-1',
    ratingKey: 'rk-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveMediaBatch', () => {
  it('reuses the stored media_id for an unchanged item and does not open a transaction', async () => {
    const stored = storedRow();
    mockStoredIdentitiesQuery([stored]);

    const result = await resolveMediaBatch([movieInput()]);

    expect(result.get('rk-1')).toBe(stored.mediaId);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('re-resolves an item whose tmdbId changed instead of reusing the stored id', async () => {
    const stored = storedRow({ tmdbId: 603 });
    mockStoredIdentitiesQuery([stored]);
    const newId = randomUUID();
    mockBatchInsert(newId);

    const result = await resolveMediaBatch([movieInput({ tmdbId: 999 })]);

    expect(result.get('rk-1')).toBe(newId);
    expect(result.get('rk-1')).not.toBe(stored.mediaId);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('re-resolves an item whose title changed instead of reusing the stored id', async () => {
    const stored = storedRow({ title: 'The Matrix' });
    mockStoredIdentitiesQuery([stored]);
    const newId = randomUUID();
    mockBatchInsert(newId);

    const result = await resolveMediaBatch([movieInput({ title: 'The Matrix Reloaded' })]);

    expect(result.get('rk-1')).toBe(newId);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('resolves a brand-new item with no stored row', async () => {
    mockStoredIdentitiesQuery([]); // nothing stored yet for this ratingKey
    const newId = randomUUID();
    const insertChain = mockBatchInsert(newId);

    const result = await resolveMediaBatch([movieInput({ ratingKey: 'brand-new' })]);

    expect(result.get('brand-new')).toBe(newId);
    expect(db.transaction).not.toHaveBeenCalled();
    const values = insertChain.values.mock.calls[0]![0] as Array<{
      matchKey: string;
      sortTitle: string;
    }>;
    expect(values[0]!.matchKey).toBe('movie:tmdb:603');
    expect(values[0]!.sortTitle).toBe('matrix');
  });

  it('does not reuse a stored row that has no media_id yet', async () => {
    // Simulates loadStoredIdentities filtering out rows with a null media_id -
    // nothing to reuse, so the row simply never appears in the map.
    mockStoredIdentitiesQuery([]);
    const newId = randomUUID();
    mockBatchInsert(newId);

    const result = await resolveMediaBatch([movieInput()]);

    expect(result.get('rk-1')).toBe(newId);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('resolves a batched provider-id hit and backfills missing ids without opening a transaction', async () => {
    const rowId = randomUUID();
    const mediaRow = {
      id: rowId,
      mediaType: 'movie',
      matchKey: 'movie:tmdb:603',
      imdbId: null,
      tmdbId: 603,
      tvdbId: null,
      title: 'The Matrix',
      normalizedTitle: 'thematrix',
      year: 1999,
      showMediaId: null,
      mergedIntoId: null,
      createdAt: new Date(),
    };
    let call = 0;
    vi.mocked(db.select).mockImplementation(() => {
      const idx = call++;
      return selectResolving(idx === 1 ? [mediaRow] : []) as never;
    });
    const updateChain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(db.update).mockReturnValue(updateChain as never);

    const result = await resolveMediaBatch([movieInput({ imdbId: 'tt0133093' })]);

    expect(result.get('rk-1')).toBe(rowId);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ imdbId: 'tt0133093' }));
  });

  it('falls back to the advisory-locked path when the batched insert loses the race', async () => {
    mockStoredIdentitiesQuery([]);
    mockBatchInsert(randomUUID(), { conflict: true });
    const newId = randomUUID();
    const { insertChain } = mockFreshResolution(newId);

    const result = await resolveMediaBatch([movieInput()]);

    expect(result.get('rk-1')).toBe(newId);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ matchKey: 'movie:tmdb:603', sortTitle: 'matrix' })
    );
  });

  it('re-resolves through the locked path when the cached id was merged away since it was read', async () => {
    const stored = storedRow();
    const newId = randomUUID();
    mockStoredIdentitiesQuery([stored], [stored.mediaId]);
    mockFreshResolution(newId);

    const result = await resolveMediaBatch([movieInput()]);

    expect(result.get('rk-1')).toBe(newId);
    expect(result.get('rk-1')).not.toBe(stored.mediaId);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('keeps season resolution correct when its show is skipped via the identity cache', async () => {
    const showStored = storedRow({
      ratingKey: 'show-1',
      mediaType: 'show',
      tmdbId: null,
      tvdbId: 555,
      title: 'Severance',
      year: 2022,
    });
    // Season's own identity changed (season number 1 -> 5), so it still goes
    // through full resolution - but it must resolve showMediaId from the
    // skipped show's cached id, not lose it.
    const seasonStored = storedRow({
      ratingKey: 'season-1',
      mediaType: 'season',
      tmdbId: null,
      title: '',
      year: null,
      grandparentRatingKey: 'show-1',
      parentIndex: 1,
    });
    mockStoredIdentitiesQuery([showStored, seasonStored]);
    const newSeasonId = randomUUID();
    const insertChain = mockBatchInsert(newSeasonId);

    const showInput: MatchKeyInput = {
      mediaType: 'show',
      imdbId: null,
      tmdbId: null,
      tvdbId: 555,
      title: 'Severance',
      year: 2022,
      serverId: 'server-1',
      ratingKey: 'show-1',
    };
    const seasonInput: MatchKeyInput = {
      mediaType: 'season',
      imdbId: null,
      tmdbId: null,
      tvdbId: null,
      title: '',
      year: null,
      serverId: 'server-1',
      ratingKey: 'season-1',
      grandparentRatingKey: 'show-1',
      seasonNumber: 5,
    };

    const result = await resolveMediaBatch([showInput, seasonInput]);

    // Show was reused from cache - no transaction for it.
    expect(result.get('show-1')).toBe(showStored.mediaId);
    // Season needed full resolution, and its matchKey must reference the
    // skipped show's cached media id (proving showIdByRatingKey was still
    // populated for the skipped show).
    expect(result.get('season-1')).toBe(newSeasonId);
    expect(db.transaction).not.toHaveBeenCalled();
    const insertedValues = insertChain.values.mock.calls[0]![0] as Array<{ matchKey: string }>;
    expect(insertedValues[0]!.matchKey).toBe(`season:${showStored.mediaId}:s5`);
  });

  it('resolves a season showMediaId from library_items when the show is not in the same batch', async () => {
    // Season's show synced in an earlier batch and isn't part of this resolve call at
    // all - showIdByRatingKey stays empty, so this only resolves via the DB fallback.
    const existingShowMediaId = randomUUID();
    const calls: unknown[][] = [];
    vi.mocked(db.select).mockImplementation(() => {
      const callIndex = calls.length;
      calls.push([]);
      if (callIndex === 0) {
        // loadStoredIdentities: season has never synced before
        return {
          from: vi.fn().mockReturnThis(),
          leftJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue([]),
        } as never;
      }
      if (callIndex === 1) {
        // lookupShowIdsFromLibraryItems: the show's prior sync already wrote its media_id
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue([{ ratingKey: 'show-1', mediaId: existingShowMediaId }]),
        } as never;
      }
      // findMergedAwayIds: nothing stale
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
      } as never;
    });
    const newSeasonId = randomUUID();
    const insertChain = mockBatchInsert(newSeasonId);

    const seasonInput: MatchKeyInput = {
      mediaType: 'season',
      imdbId: null,
      tmdbId: null,
      tvdbId: null,
      title: 'Season 1',
      year: null,
      serverId: 'server-1',
      ratingKey: 'season-1',
      grandparentRatingKey: 'show-1',
      seasonNumber: 1,
    };

    const result = await resolveMediaBatch([seasonInput]);

    expect(result.get('season-1')).toBe(newSeasonId);
    const insertedValues = insertChain.values.mock.calls[0]![0] as Array<{
      matchKey: string;
      showMediaId: string;
    }>;
    expect(insertedValues[0]!.matchKey).toBe(`season:${existingShowMediaId}:s1`);
    expect(insertedValues[0]!.showMediaId).toBe(existingShowMediaId);
  });

  it('repairs a null show_media_id on a cache hit instead of discarding it forever', async () => {
    const stored = storedRow({
      mediaType: 'episode',
      mediaShowMediaId: null, // sync N resolved this episode before its show existed
    });
    mockStoredIdentitiesQuery([stored]);
    const updateChain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(db.update).mockReturnValue(updateChain as never);
    const showMediaId = randomUUID();

    const result = await resolveMediaBatch([movieInput({ mediaType: 'episode', showMediaId })]);

    expect(result.get('rk-1')).toBe(stored.mediaId);
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ showMediaId }));
    expect(db.transaction).not.toHaveBeenCalled();
  });

  describe('id-bearing title probe', () => {
    /** Select call order on a full miss: loadStoredIdentities, batched provider-id query, title probe, findMergedAwayIds. */
    function mockMissSelects(probeRows: unknown[]) {
      let call = 0;
      vi.mocked(db.select).mockImplementation(() => {
        const idx = call++;
        return selectResolving(idx === 2 ? probeRows : []) as never;
      });
    }

    function probeRow(overrides: Record<string, unknown> = {}) {
      return {
        id: randomUUID(),
        mediaType: 'movie',
        matchKey: 'movie:imdb:tt0133093',
        imdbId: 'tt0133093',
        tmdbId: null,
        tvdbId: null,
        title: 'The Matrix',
        normalizedTitle: 'thematrix',
        year: 1999,
        showMediaId: null,
        mergedIntoId: null,
        createdAt: new Date(),
        ...overrides,
      };
    }

    it('lands a tmdb-only miss on an existing imdb-only row and backfills the tmdb id', async () => {
      const row = probeRow();
      mockMissSelects([row]);
      const updateChain = {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(db.update).mockReturnValue(updateChain as never);

      const result = await resolveMediaBatch([movieInput({ tmdbId: 603 })]);

      expect(result.get('rk-1')).toBe(row.id);
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ tmdbId: 603 }));
    });

    it('rejects the probe when the same id column carries a different value', async () => {
      mockMissSelects([probeRow({ imdbId: null, tmdbId: 604 })]);
      const newId = randomUUID();
      mockBatchInsert(newId);

      const result = await resolveMediaBatch([movieInput({ tmdbId: 603 })]);

      expect(result.get('rk-1')).toBe(newId);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('rejects the probe when two candidates are both viable', async () => {
      mockMissSelects([
        probeRow(),
        probeRow({ id: randomUUID(), matchKey: 'movie:tvdb:73255', imdbId: null, tvdbId: 73255 }),
      ]);
      const newId = randomUUID();
      mockBatchInsert(newId);

      const result = await resolveMediaBatch([movieInput({ tmdbId: 603 })]);

      expect(result.get('rk-1')).toBe(newId);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('rejects the probe on a one-year drift when the input carries ids', async () => {
      mockMissSelects([probeRow({ year: 1998 })]);
      const newId = randomUUID();
      mockBatchInsert(newId);

      const result = await resolveMediaBatch([movieInput({ tmdbId: 603 })]);

      expect(result.get('rk-1')).toBe(newId);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('routes a conflicting sibling to the locked path instead of gluing it to the claimed row', async () => {
      const row = probeRow();
      mockMissSelects([row]);
      const updateChain = {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(db.update).mockReturnValue(updateChain as never);
      const lockedId = randomUUID();
      mockFreshResolution(lockedId);

      const result = await resolveMediaBatch([
        movieInput({ tmdbId: 603, ratingKey: 'rk-1' }),
        movieInput({ tmdbId: 700, ratingKey: 'rk-2' }),
      ]);

      expect(result.get('rk-1')).toBe(row.id);
      expect(result.get('rk-2')).toBe(lockedId);
      expect(result.get('rk-2')).not.toBe(row.id);
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ tmdbId: 603 }));
      expect(updateChain.set).not.toHaveBeenCalledWith(expect.objectContaining({ tmdbId: 700 }));
    });

    it('lets non-conflicting siblings share the claimed row', async () => {
      const row = probeRow();
      mockMissSelects([row]);
      const updateChain = {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(db.update).mockReturnValue(updateChain as never);

      const result = await resolveMediaBatch([
        movieInput({ tmdbId: 603, ratingKey: 'rk-1' }),
        movieInput({ tmdbId: 603, ratingKey: 'rk-2' }),
      ]);

      expect(result.get('rk-1')).toBe(row.id);
      expect(result.get('rk-2')).toBe(row.id);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('accepts a candidate with no year against an input that has one', async () => {
      const row = probeRow({ year: null });
      mockMissSelects([row]);
      const updateChain = {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(db.update).mockReturnValue(updateChain as never);

      const result = await resolveMediaBatch([movieInput({ tmdbId: 603 })]);

      expect(result.get('rk-1')).toBe(row.id);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  it('reuses the stored media_id for a track whose recomputed matchKey still matches what is stored', async () => {
    const input = trackInput();
    const stored = storedRow({
      mediaType: 'track',
      tmdbId: null,
      title: 'Intro',
      year: null,
      mediaMatchKey: buildMediaMatchKey(input),
    });
    mockStoredIdentitiesQuery([stored]);

    const result = await resolveMediaBatch([input]);

    expect(result.get('rk-1')).toBe(stored.mediaId);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('re-resolves a track whose stored matchKey predates artist/album scoping, even though raw fields are unchanged', async () => {
    const input = trackInput();
    const stored = storedRow({
      mediaType: 'track',
      tmdbId: null,
      title: 'Intro',
      year: null,
      // Row resolved under the old global title:year key, before context scoping existed
      mediaMatchKey: 'track:title:intro:0',
    });
    mockStoredIdentitiesQuery([stored]);
    const newId = randomUUID();
    mockBatchInsert(newId);

    const result = await resolveMediaBatch([input]);

    expect(result.get('rk-1')).toBe(newId);
    expect(result.get('rk-1')).not.toBe(stored.mediaId);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
