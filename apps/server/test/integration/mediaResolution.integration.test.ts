import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestServer, createTestLibraryItem } from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { media, libraryItems } from '../../src/db/schema.js';
import {
  resolveMediaForItem,
  resolveMediaBatch,
  resolveMediaAliases,
  mergeMediaRows,
  reconcileMediaDuplicates,
} from '../../src/services/library/mediaResolutionService.js';

// No local beforeEach: setup.integration.ts resets the DB and factory counters
// before every test, and Task 3 put media/library_items on the truncate list.
describe('mediaResolutionService', () => {
  it('creates one row and matches by any provider id across asymmetric servers', async () => {
    const a = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0322259',
      tmdbId: 584,
      title: '2 Fast 2 Furious',
      year: 2003,
      serverId: 's1',
      ratingKey: '1',
    });
    // Second server has only tmdb; must land on the same row and gain nothing new
    const b = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 584,
      title: '2 Fast 2 Furious',
      year: 2003,
      serverId: 's2',
      ratingKey: '9',
    });
    expect(b).toBe(a);
  });

  it('backfills missing provider ids onto the media row on hit', async () => {
    await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 584,
      title: '2 Fast 2 Furious',
      year: 2003,
      serverId: 's1',
      ratingKey: '1',
    });
    const id = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0322259',
      tmdbId: 584,
      title: '2 Fast 2 Furious',
      year: 2003,
      serverId: 's2',
      ratingKey: '9',
    });
    const [row] = await db.select().from(media);
    expect(row!.id).toBe(id);
    expect(row!.imdbId).toBe('tt0322259');
  });

  it('does not match the same provider id across media types', async () => {
    const movie = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 1891,
      title: 'The Empire Strikes Back',
      year: 1980,
      serverId: 's1',
      ratingKey: '1',
    });
    const show = await resolveMediaForItem({
      mediaType: 'show',
      tmdbId: 1891,
      title: 'Rome',
      year: 2005,
      serverId: 's1',
      ratingKey: '2',
    });
    expect(show).not.toBe(movie);
  });

  it('matches title-fallback items across a one-year drift', async () => {
    const a = await resolveMediaForItem({
      mediaType: 'movie',
      title: 'Crash',
      year: 2004,
      serverId: 's1',
      ratingKey: '1',
    });
    const b = await resolveMediaForItem({
      mediaType: 'movie',
      title: 'Crash!',
      year: 2005,
      serverId: 's2',
      ratingKey: '9',
    });
    expect(b).toBe(a);
  });

  it("merges when two rows match two of one item's ids, and aliases resolve", async () => {
    const byImdb = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt111',
      title: 'X',
      year: 2020,
      serverId: 's1',
      ratingKey: '1',
    });
    // Different year so the id-bearing title probe can't unify them up front
    const byTmdb = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 999,
      title: 'X',
      year: 2019,
      serverId: 's2',
      ratingKey: '2',
    });
    expect(byTmdb).not.toBe(byImdb);
    const resolved = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt111',
      tmdbId: 999,
      title: 'X',
      year: 2020,
      serverId: 's3',
      ratingKey: '3',
    });
    const aliases = await resolveMediaAliases(resolved);
    expect(new Set(aliases)).toEqual(new Set([byImdb, byTmdb]));
  });

  it("keeps episodes apart when a server gives each one the next episode's imdb id", async () => {
    const episode = (serverId: string, n: number, imdbId: string) => ({
      mediaType: 'episode',
      tvdbId: 5000100 + n,
      imdbId,
      title: `Episode ${n}`,
      seasonNumber: 1,
      episodeNumber: n,
      serverId,
      ratingKey: `${serverId}-${n}`,
    });
    const s1 = await createTestServer({ type: 'jellyfin' });
    const s2 = await createTestServer({ type: 'emby' });
    const first = await resolveMediaBatch([
      episode(s1.id, 1, 'tt7000101'),
      episode(s1.id, 2, 'tt7000102'),
      episode(s1.id, 3, 'tt7000103'),
    ]);
    const second = await resolveMediaBatch([
      episode(s2.id, 1, 'tt7000102'),
      episode(s2.id, 2, 'tt7000103'),
      episode(s2.id, 3, 'tt7000101'),
    ]);
    for (const n of [1, 2, 3]) expect(second.get(`${s2.id}-${n}`)).toBe(first.get(`${s1.id}-${n}`));
    const rows = await db.select().from(media);
    expect(rows.filter((r) => !r.mergedIntoId)).toHaveLength(3);
    expect(await reconcileMediaDuplicates()).toBe(0);
  });

  it('merges the hits that agree with the named row and leaves a conflicting hit alone', async () => {
    const createdAt = new Date();
    await db.insert(media).values([
      {
        mediaType: 'episode',
        matchKey: 'episode:tvdb:5000101',
        tvdbId: 5000101,
        title: 'Episode 1',
        createdAt,
      },
      {
        mediaType: 'episode',
        matchKey: 'episode:tmdb:6000101',
        tmdbId: 6000101,
        title: 'Episode 1',
        createdAt,
      },
      {
        mediaType: 'episode',
        matchKey: 'episode:tvdb:5000102',
        tvdbId: 5000102,
        imdbId: 'tt7000102',
        title: 'Episode 2',
        createdAt,
      },
    ]);
    const resolved = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 5000101,
      tmdbId: 6000101,
      imdbId: 'tt7000102',
      title: 'Episode 1',
      serverId: 's2',
      ratingKey: '1',
    });
    const rows = await db.select().from(media);
    const byKey = new Map(rows.map((r) => [r.matchKey, r]));
    expect(resolved).toBe(byKey.get('episode:tmdb:6000101')?.id);
    expect(byKey.get('episode:tvdb:5000101')?.mergedIntoId).toBe(resolved);
    expect(byKey.get('episode:tvdb:5000102')?.mergedIntoId).toBeNull();
    expect(byKey.get('episode:tmdb:6000101')?.imdbId).toBeNull();
    expect(await reconcileMediaDuplicates()).toBe(0);
  });

  it('gives an episode with another tvdb id its own row instead of the row sharing its imdb id', async () => {
    const jellyfin = await createTestServer({ type: 'jellyfin' });
    const emby = await createTestServer({ type: 'emby' });
    const episode = (serverId: string, tvdbId: number) => ({
      mediaType: 'episode',
      tvdbId,
      imdbId: 'tt7000148',
      title: 'Episode 48',
      seasonNumber: 3,
      episodeNumber: 48,
      serverId,
      ratingKey: `${serverId}-48`,
    });
    const fromJellyfin = await resolveMediaBatch([episode(jellyfin.id, 5000143)]);
    const fromEmby = await resolveMediaBatch([episode(emby.id, 5000148)]);
    const jellyfinRow = fromJellyfin.get(`${jellyfin.id}-48`);
    const embyRow = fromEmby.get(`${emby.id}-48`);
    expect(embyRow).not.toBe(jellyfinRow);
    const rows = await db.select().from(media);
    expect(rows.find((r) => r.id === embyRow)?.matchKey).toBe('episode:tvdb:5000148');
    expect(rows.find((r) => r.id === jellyfinRow)?.tvdbId).toBe(5000143);
    expect(await reconcileMediaDuplicates()).toBe(0);
  });

  it('among rows sharing the named id, takes the one that agrees with the input', async () => {
    const at = (micros: number) =>
      sql`${`2026-01-01T00:00:00.000${String(micros).padStart(3, '0')}Z`}::timestamptz`;
    await db.insert(media).values([
      {
        mediaType: 'movie',
        matchKey: 'movie:tmdb:6000101',
        imdbId: 'tt7000101',
        tmdbId: 6000101,
        title: 'Film',
        createdAt: at(100),
      },
      {
        mediaType: 'movie',
        matchKey: 'movie:tmdb:6000102',
        imdbId: 'tt7000101',
        tmdbId: 6000102,
        title: 'Film',
        createdAt: at(300),
      },
    ]);
    const resolved = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt7000101',
      tmdbId: 6000102,
      title: 'Film',
      serverId: 's2',
      ratingKey: '1',
    });
    const rows = await db.select().from(media);
    expect(resolved).toBe(rows.find((r) => r.matchKey === 'movie:tmdb:6000102')?.id);
    expect(rows.every((r) => r.mergedIntoId === null)).toBe(true);
  });

  it('reconcile merges rows that share an id only when they agree on every id both carry', async () => {
    const createdAt = new Date();
    await db.insert(media).values([
      {
        mediaType: 'episode',
        matchKey: 'episode:tmdb:6000101',
        imdbId: 'tt7000101',
        tmdbId: 6000101,
        title: 'Episode 1',
        createdAt,
      },
      {
        mediaType: 'episode',
        matchKey: 'episode:tvdb:5000101',
        imdbId: 'tt7000101',
        tvdbId: 5000101,
        title: 'Episode 1',
        createdAt,
      },
      {
        mediaType: 'episode',
        matchKey: 'episode:tvdb:5000102',
        imdbId: 'tt7000101',
        tvdbId: 5000102,
        title: 'Episode 2',
        createdAt,
      },
    ]);
    expect(await reconcileMediaDuplicates()).toBe(1);
    const byKey = new Map((await db.select().from(media)).map((r) => [r.matchKey, r]));
    const survivor = byKey.get('episode:tmdb:6000101')?.id;
    expect(byKey.get('episode:tvdb:5000101')?.mergedIntoId).toBe(survivor);
    expect(byKey.get('episode:tvdb:5000102')?.mergedIntoId).toBeNull();
  });

  it('path-compresses merge chains', async () => {
    const a = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt1',
      title: 'A',
      year: 2000,
      serverId: 's1',
      ratingKey: '1',
    });
    const b = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt2',
      title: 'B',
      year: 2000,
      serverId: 's1',
      ratingKey: '2',
    });
    const c = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt3',
      title: 'C',
      year: 2000,
      serverId: 's1',
      ratingKey: '3',
    });
    await mergeMediaRows(b, a); // a -> b
    await mergeMediaRows(c, b); // b -> c; a must now point at c directly
    const aliases = await resolveMediaAliases(c);
    expect(new Set(aliases)).toEqual(new Set([c, b, a]));
    const rows = await db.select().from(media);
    for (const r of rows.filter((r) => r.id !== c)) expect(r.mergedIntoId).toBe(c);
  });

  it('resolveMediaBatch resolves shows before episodes so composites key on the show row', async () => {
    const server = await createTestServer({ type: 'plex' });
    const result = await resolveMediaBatch([
      {
        mediaType: 'show',
        tvdbId: 121361,
        title: 'Some Show',
        year: 2011,
        serverId: server.id,
        ratingKey: 'show-1',
      },
      {
        mediaType: 'episode',
        title: 'Ep',
        year: null,
        serverId: server.id,
        ratingKey: 'ep-1',
        seasonNumber: 1,
        episodeNumber: 5,
        grandparentRatingKey: 'show-1',
      },
    ]);
    const showId = result.get('show-1')!;
    const epId = result.get('ep-1')!;
    const [epRow] = await db
      .select()
      .from(media)
      .where(sql`id = ${epId}`);
    expect(epRow!.showMediaId).toBe(showId);
    expect(epRow!.matchKey).toBe(`episode:${showId}:s1e5`);
  });

  it("resolveMediaBatch resolves an episode's show via library_items when the show synced in a separate batch", async () => {
    const server = await createTestServer({ type: 'plex' });

    // Show batch, synced and upserted first (mirrors librarySync.upsertItems:
    // resolveMediaBatch resolves the show, then the caller writes the
    // library_items row carrying its media_id).
    const showBatchResult = await resolveMediaBatch([
      {
        mediaType: 'show',
        tvdbId: 121362,
        title: 'Hacks',
        year: 2021,
        serverId: server.id,
        ratingKey: 'show-hacks',
      },
    ]);
    const showId = showBatchResult.get('show-hacks')!;
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'show-hacks',
      mediaType: 'show',
      mediaId: showId,
    });

    // Episode batch, synced separately with no show present in this batch -
    // the in-batch showIdByRatingKey map is empty for it.
    const episodeBatchResult = await resolveMediaBatch([
      {
        mediaType: 'episode',
        title: 'Bulletproof',
        year: null,
        serverId: server.id,
        ratingKey: 'ep-hacks-1',
        seasonNumber: 3,
        episodeNumber: 1,
        grandparentRatingKey: 'show-hacks',
      },
    ]);
    const epId = episodeBatchResult.get('ep-hacks-1')!;
    const [epRow] = await db
      .select()
      .from(media)
      .where(sql`id = ${epId}`);
    expect(epRow!.showMediaId).toBe(showId);
  });

  it('leaves show_media_id null when the show has not synced yet (fail-open)', async () => {
    const server = await createTestServer({ type: 'plex' });
    const result = await resolveMediaBatch([
      {
        mediaType: 'episode',
        title: 'Orphan Episode',
        year: null,
        serverId: server.id,
        ratingKey: 'ep-orphan-1',
        seasonNumber: 1,
        episodeNumber: 1,
        grandparentRatingKey: 'show-not-synced-yet',
      },
    ]);
    const epId = result.get('ep-orphan-1')!;
    const [epRow] = await db
      .select()
      .from(media)
      .where(sql`id = ${epId}`);
    expect(epRow!.showMediaId).toBeNull();
  });

  it('does not title-match ID-less episodes from different shows', async () => {
    const a = await resolveMediaForItem({
      mediaType: 'episode',
      title: 'Pilot',
      year: null,
      serverId: 's1',
      ratingKey: 'ep-a',
    });
    const b = await resolveMediaForItem({
      mediaType: 'episode',
      title: 'Pilot',
      year: null,
      serverId: 's2',
      ratingKey: 'ep-b',
    });
    expect(b).not.toBe(a);
  });

  it('backfills showMediaId onto an existing episode row when a later resolve carries it', async () => {
    const epFirst = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 987101,
      title: 'Pilot',
      year: 2008,
      serverId: 's1',
      ratingKey: 'ep-1',
    });
    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 90001,
      title: 'Some Show',
      year: 2008,
      serverId: 's1',
      ratingKey: 'show-1',
    });
    const epAgain = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 987101,
      title: 'Pilot',
      year: 2008,
      serverId: 's1',
      ratingKey: 'ep-1',
      showMediaId: showId,
    });
    expect(epAgain).toBe(epFirst);
    const [row] = await db
      .select()
      .from(media)
      .where(sql`id = ${epFirst}`);
    expect(row!.showMediaId).toBe(showId);
  });

  it('tolerant title lookup always picks the oldest of coexisting duplicates', async () => {
    const now = new Date();
    // Newer row sorts first on both the physical order and the year index
    await db.insert(media).values({
      mediaType: 'movie',
      matchKey: 'movie:title:crash:2004',
      title: 'Crash',
      normalizedTitle: 'crash',
      year: 2004,
      createdAt: now,
    });
    const [older] = await db
      .insert(media)
      .values({
        mediaType: 'movie',
        matchKey: 'movie:title:crash:2005',
        title: 'Crash',
        normalizedTitle: 'crash',
        year: 2005,
        createdAt: new Date(now.getTime() - 86400000),
      })
      .returning({ id: media.id });
    for (let i = 0; i < 3; i++) {
      const resolved = await resolveMediaForItem({
        mediaType: 'movie',
        title: 'Crash',
        year: 2004,
        serverId: 's1',
        ratingKey: `rk-${i}`,
      });
      expect(resolved).toBe(older!.id);
    }
  });

  it('reconciles title-keyed movie duplicates within a one-year drift, and nothing else', async () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 60000);
    await db.insert(media).values([
      // Race artifact: same movie, year drifted by one
      {
        mediaType: 'movie',
        matchKey: 'movie:title:heat:2004',
        title: 'Heat',
        normalizedTitle: 'heat',
        year: 2004,
        createdAt: earlier,
      },
      {
        mediaType: 'movie',
        matchKey: 'movie:title:heat:2005',
        title: 'Heat',
        normalizedTitle: 'heat',
        year: 2005,
        createdAt: now,
      },
      // Same title, five years apart: distinct films
      {
        mediaType: 'movie',
        matchKey: 'movie:title:crash:2000',
        title: 'Crash',
        normalizedTitle: 'crash',
        year: 2000,
        createdAt: earlier,
      },
      {
        mediaType: 'movie',
        matchKey: 'movie:title:crash:2005',
        title: 'Crash',
        normalizedTitle: 'crash',
        year: 2005,
        createdAt: now,
      },
      // Same-title episodes of different shows
      {
        mediaType: 'episode',
        matchKey: 'local:s1:ep-1',
        title: 'Pilot',
        normalizedTitle: 'pilot',
        year: null,
        createdAt: earlier,
      },
      {
        mediaType: 'episode',
        matchKey: 'local:s2:ep-9',
        title: 'Pilot',
        normalizedTitle: 'pilot',
        year: null,
        createdAt: now,
      },
    ]);
    const merged = await reconcileMediaDuplicates();
    expect(merged).toBe(1);
    const rows = await db.select().from(media);
    const heat = rows.filter((r) => r.normalizedTitle === 'heat');
    const winner = heat.find((r) => r.year === 2004)!;
    const loser = heat.find((r) => r.year === 2005)!;
    expect(winner.mergedIntoId).toBeNull();
    expect(loser.mergedIntoId).toBe(winner.id);
    expect(rows.filter((r) => r.normalizedTitle === 'crash' && !r.mergedIntoId)).toHaveLength(2);
    expect(rows.filter((r) => r.mediaType === 'episode' && !r.mergedIntoId)).toHaveLength(2);
  });

  it('reconcile merge carries the loser provider ids and genres to the winner, so lookups hit it', async () => {
    const now = new Date();
    await db.insert(media).values([
      {
        mediaType: 'movie',
        matchKey: 'movie:imdb:ttA9',
        imdbId: 'ttA9',
        tmdbId: 93307,
        title: 'Skewed',
        normalizedTitle: 'skewed',
        year: 2001,
        createdAt: new Date(now.getTime() - 60000),
      },
      // Frozen tvdb match key: born tvdb-only, tmdb backfilled later
      {
        mediaType: 'movie',
        matchKey: 'movie:tvdb:9333700',
        tvdbId: 9333700,
        tmdbId: 93307,
        genres: ['Drama'],
        title: 'Skewed',
        normalizedTitle: 'skewed',
        year: 2001,
        createdAt: now,
      },
    ]);
    await reconcileMediaDuplicates();
    const rows = await db.select().from(media);
    const winner = rows.find((r) => !r.mergedIntoId)!;
    expect(winner.matchKey).toBe('movie:imdb:ttA9');
    expect(winner.tvdbId).toBe(9333700);
    expect(winner.genres).toEqual(['Drama']);
    const resolved = await resolveMediaForItem({
      mediaType: 'movie',
      tvdbId: 9333700,
      title: 'Skewed',
      year: 2001,
      serverId: 's2',
      ratingKey: 'rk-1',
    });
    expect(resolved).toBe(winner.id);
  });

  it('match-key re-select follows a stranded merged loser to its canonical root', async () => {
    const now = new Date();
    const [winner] = await db
      .insert(media)
      .values({
        mediaType: 'movie',
        matchKey: 'movie:imdb:ttW1',
        imdbId: 'ttW1',
        title: 'Rooted',
        normalizedTitle: 'rooted',
        year: 1999,
        createdAt: new Date(now.getTime() - 60000),
      })
      .returning({ id: media.id });
    // Loser merged before merges copied provider ids: its tvdb key stays frozen
    await db.insert(media).values({
      mediaType: 'movie',
      matchKey: 'movie:tvdb:777001',
      tvdbId: 777001,
      mergedIntoId: winner!.id,
      title: 'Rooted',
      normalizedTitle: 'rooted',
      year: 1999,
      createdAt: now,
    });
    const resolved = await resolveMediaForItem({
      mediaType: 'movie',
      tvdbId: 777001,
      title: 'Rooted',
      year: 1999,
      serverId: 's1',
      ratingKey: 'rk-1',
    });
    expect(resolved).toBe(winner!.id);
  });

  it('merging into an already-merged winner lands everything on the canonical root', async () => {
    const a = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt1',
      title: 'A',
      year: 2000,
      serverId: 's1',
      ratingKey: '1',
    });
    const b = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt2',
      title: 'B',
      year: 2000,
      serverId: 's1',
      ratingKey: '2',
    });
    const c = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt3',
      title: 'C',
      year: 2000,
      serverId: 's1',
      ratingKey: '3',
    });
    await mergeMediaRows(a, b); // b -> a
    await mergeMediaRows(b, c); // winner b is merged; c must land on a, not throw
    const rows = await db.select().from(media);
    for (const r of rows.filter((r) => r.id !== a)) expect(r.mergedIntoId).toBe(a);
  });

  it('resolveMediaBatch reuses the stored media_id on a second pass with unchanged identity, and re-resolves after a real change', async () => {
    const server = await createTestServer({ type: 'plex' });
    const input = {
      mediaType: 'movie' as const,
      imdbId: null,
      tmdbId: 1234,
      title: '300',
      year: 2006,
      serverId: server.id,
      ratingKey: 'rk-300',
    };

    const firstPass = await resolveMediaBatch([input]);
    const firstId = firstPass.get('rk-300')!;
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'rk-300',
      mediaType: 'movie',
      imdbId: input.imdbId,
      tmdbId: input.tmdbId,
      title: input.title,
      year: input.year,
      mediaId: firstId,
    });

    // Second pass, identical inputs: must reuse the same id and create no
    // second media row.
    const secondPass = await resolveMediaBatch([input]);
    expect(secondPass.get('rk-300')).toBe(firstId);
    const rowsAfterUnchanged = await db.select().from(media);
    expect(rowsAfterUnchanged).toHaveLength(1);

    // Third pass, tmdbId genuinely changed (no imdbId to fall back and match
    // the old row through): must not reuse the stale cached id.
    const thirdPass = await resolveMediaBatch([{ ...input, tmdbId: 9999 }]);
    expect(thirdPass.get('rk-300')).not.toBe(firstId);
  });

  // Functional check only: mergeMediaRowsWithin's own library_items update
  // means loadStoredIdentities already reads the winner by the time this
  // runs, so this cannot construct read-before-merge/write-after-merge - see
  // "re-resolves through the locked path..." in the mocked unit suite for that.
  it('resolves an item whose stored id was merged away between syncs to the winning row', async () => {
    const server = await createTestServer({ type: 'plex' });
    const input = {
      mediaType: 'movie' as const,
      imdbId: 'tt0111161',
      tmdbId: null,
      title: 'The Shawshank Redemption',
      year: 1994,
      serverId: server.id,
      ratingKey: 'rk-shawshank',
    };

    const staleId = await resolveMediaForItem(input);
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: input.ratingKey,
      mediaType: 'movie',
      imdbId: input.imdbId,
      title: input.title,
      year: input.year,
      mediaId: staleId,
    });

    const [winner] = await db
      .insert(media)
      .values({
        mediaType: 'movie',
        matchKey: 'movie:imdb:tt0111161:dup',
        title: input.title,
        normalizedTitle: 'theshawshankredemption',
        year: input.year,
      })
      .returning({ id: media.id });
    await mergeMediaRows(winner!.id, staleId);

    const result = await resolveMediaBatch([input]);

    expect(result.get(input.ratingKey)).toBe(winner!.id);
    const [staleRow] = await db
      .select()
      .from(media)
      .where(sql`id = ${staleId}`);
    expect(staleRow!.mergedIntoId).toBe(winner!.id);
  });

  it('a provider-id-less episode reuses its own row after its show merges, instead of orphaning a duplicate', async () => {
    const server = await createTestServer({ type: 'plex' });

    const showResult = await resolveMediaBatch([
      {
        mediaType: 'show',
        tvdbId: 700001,
        title: 'Merge Show',
        year: 2015,
        serverId: server.id,
        ratingKey: 'show-merge',
      },
    ]);
    const showIdA = showResult.get('show-merge')!;
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'show-merge',
      mediaType: 'show',
      title: 'Merge Show',
      year: 2015,
      mediaId: showIdA,
    });

    // year avoids null: buildLibraryItem's `data.year ?? 2020` default treats
    // an explicit null the same as omitted, so null could never round-trip.
    const episodeInput = {
      mediaType: 'episode' as const,
      title: 'No Provider Ids',
      year: 2020,
      serverId: server.id,
      ratingKey: 'ep-merge-1',
      seasonNumber: 1,
      episodeNumber: 1,
      grandparentRatingKey: 'show-merge',
    };
    const epResult = await resolveMediaBatch([episodeInput]);
    const epId = epResult.get('ep-merge-1')!;
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'ep-merge-1',
      mediaType: 'episode',
      title: episodeInput.title,
      year: episodeInput.year,
      mediaId: epId,
      grandparentRatingKey: 'show-merge',
      parentIndex: 1,
      itemIndex: 1,
    });

    // The show gets merged into a new canonical row between syncs.
    const [showWinner] = await db
      .insert(media)
      .values({
        mediaType: 'show',
        matchKey: 'show:tvdb:700001:dup',
        tvdbId: 700001,
        title: 'Merge Show',
        normalizedTitle: 'mergeshow',
        year: 2015,
      })
      .returning({ id: media.id });
    await mergeMediaRows(showWinner!.id, showIdA);

    // Next sync resolves both again with unchanged identity.
    const result = await resolveMediaBatch([
      {
        mediaType: 'show',
        tvdbId: 700001,
        title: 'Merge Show',
        year: 2015,
        serverId: server.id,
        ratingKey: 'show-merge',
      },
      episodeInput,
    ]);

    expect(result.get('show-merge')).toBe(showWinner!.id);
    expect(result.get('ep-merge-1')).toBe(epId);

    const allMedia = await db.select().from(media);
    const episodeRows = allMedia.filter((r) => r.mediaType === 'episode');
    expect(episodeRows).toHaveLength(1);
    expect(episodeRows[0]!.id).toBe(epId);
  });

  it('batch-resolves a mix of hits, misses, and an in-batch duplicate title to correct identities', async () => {
    const server = await createTestServer({ type: 'plex' });
    const knownId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0100100',
      title: 'Known Movie',
      year: 2001,
      serverId: 's-seed',
      ratingKey: 'seed-1',
    });
    const heatId = await resolveMediaForItem({
      mediaType: 'movie',
      title: 'Heat',
      year: 1995,
      serverId: 's-seed',
      ratingKey: 'seed-2',
    });

    const result = await resolveMediaBatch([
      {
        mediaType: 'show',
        tvdbId: 424242,
        title: 'Batch Show',
        year: 2020,
        serverId: server.id,
        ratingKey: 'show-1',
      },
      {
        mediaType: 'season',
        title: 'Season 1',
        year: null,
        serverId: server.id,
        ratingKey: 'season-1',
        grandparentRatingKey: 'show-1',
        seasonNumber: 1,
      },
      {
        mediaType: 'episode',
        title: 'Batch Ep',
        year: null,
        serverId: server.id,
        ratingKey: 'ep-1',
        grandparentRatingKey: 'show-1',
        seasonNumber: 1,
        episodeNumber: 2,
      },
      {
        mediaType: 'movie',
        imdbId: 'tt0100100',
        tmdbId: 100100,
        title: 'Known Movie',
        year: 2001,
        serverId: server.id,
        ratingKey: 'movie-hit',
      },
      {
        mediaType: 'movie',
        title: 'Heat!',
        year: 1996,
        serverId: server.id,
        ratingKey: 'movie-title-hit',
      },
      {
        mediaType: 'movie',
        tmdbId: 777001,
        title: 'Fresh Movie',
        year: 2023,
        serverId: server.id,
        ratingKey: 'movie-new',
      },
      {
        mediaType: 'movie',
        title: 'Twin Release',
        year: 2022,
        serverId: server.id,
        ratingKey: 'dup-a',
      },
      {
        mediaType: 'movie',
        title: 'Twin Release',
        year: 2022,
        serverId: server.id,
        ratingKey: 'dup-b',
      },
    ]);

    expect(result.get('movie-hit')).toBe(knownId);
    expect(result.get('movie-title-hit')).toBe(heatId);
    const [knownRow] = await db
      .select()
      .from(media)
      .where(sql`id = ${knownId}`);
    expect(knownRow!.tmdbId).toBe(100100);

    expect(result.get('dup-a')).toBe(result.get('dup-b'));

    const showId = result.get('show-1')!;
    const [seasonRow] = await db
      .select()
      .from(media)
      .where(sql`id = ${result.get('season-1')!}`);
    expect(seasonRow!.showMediaId).toBe(showId);
    expect(seasonRow!.matchKey).toBe(`season:${showId}:s1`);
    const [epRow] = await db
      .select()
      .from(media)
      .where(sql`id = ${result.get('ep-1')!}`);
    expect(epRow!.showMediaId).toBe(showId);
    expect(epRow!.matchKey).toBe(`episode:${showId}:s1e2`);

    // 2 seeds + show + season + episode + fresh movie + one twin row, no duplicate match keys
    const allRows = await db.select().from(media);
    expect(allRows).toHaveLength(7);
    expect(new Set(allRows.map((r) => r.matchKey)).size).toBe(7);
  });

  it('resolves a tmdb-only item onto an existing imdb-only row with the same title and year', async () => {
    const a = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0156887',
      title: 'Perfect Blue',
      year: 1997,
      serverId: 's1',
      ratingKey: '1',
    });
    const b = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 10494,
      title: 'Perfect Blue',
      year: 1997,
      serverId: 's2',
      ratingKey: '9',
    });
    expect(b).toBe(a);
    const rows = await db.select().from(media);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.imdbId).toBe('tt0156887');
    expect(rows[0]!.tmdbId).toBe(10494);
  });

  it('batched resolution lands a tvdb-only miss on an existing disjoint-id row and backfills it', async () => {
    const seeded = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0245429',
      title: 'Spirited Away',
      year: 2001,
      serverId: 's-seed',
      ratingKey: 'seed-1',
    });
    const server = await createTestServer({ type: 'jellyfin' });
    const result = await resolveMediaBatch([
      {
        mediaType: 'movie',
        tvdbId: 792,
        title: 'Spirited Away',
        year: 2001,
        serverId: server.id,
        ratingKey: 'm-1',
      },
      {
        mediaType: 'movie',
        tmdbId: 8392,
        title: 'My Neighbor Totoro',
        year: 1988,
        serverId: server.id,
        ratingKey: 'm-2',
      },
    ]);
    expect(result.get('m-1')).toBe(seeded);
    expect(result.get('m-2')).not.toBe(seeded);
    const [seededRow] = await db
      .select()
      .from(media)
      .where(sql`id = ${seeded}`);
    expect(seededRow!.tvdbId).toBe(792);
    expect(seededRow!.imdbId).toBe('tt0245429');
    expect(await db.select().from(media)).toHaveLength(2);
  });

  it('two batched siblings with the same title and year but different tmdb ids do not share one row', async () => {
    const seeded = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'ttSib1',
      title: 'Sibling',
      year: 2003,
      serverId: 's-seed',
      ratingKey: 'seed-1',
    });
    const server = await createTestServer({ type: 'plex' });
    const result = await resolveMediaBatch([
      {
        mediaType: 'movie',
        tmdbId: 111,
        title: 'Sibling',
        year: 2003,
        serverId: server.id,
        ratingKey: 'sib-a',
      },
      {
        mediaType: 'movie',
        tmdbId: 222,
        title: 'Sibling',
        year: 2003,
        serverId: server.id,
        ratingKey: 'sib-b',
      },
    ]);
    const aId = result.get('sib-a')!;
    const bId = result.get('sib-b')!;
    expect(aId).toBe(seeded);
    expect(bId).not.toBe(aId);
    const rows = await db.select().from(media);
    expect(rows.filter((r) => !r.mergedIntoId)).toHaveLength(2);
    const shared = rows.find((r) => r.id === seeded)!;
    expect(shared.imdbId).toBe('ttSib1');
    expect(shared.tmdbId).toBe(111);
    const split = rows.find((r) => r.id === bId)!;
    expect(split.tmdbId).toBe(222);
  });

  it('two batched siblings with identical tmdb ids both land on the existing row', async () => {
    const seeded = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'ttTw1',
      title: 'Twice',
      year: 2001,
      serverId: 's-seed',
      ratingKey: 'seed-1',
    });
    const server = await createTestServer({ type: 'plex' });
    const result = await resolveMediaBatch([
      {
        mediaType: 'movie',
        tmdbId: 333,
        title: 'Twice',
        year: 2001,
        serverId: server.id,
        ratingKey: 'tw-a',
      },
      {
        mediaType: 'movie',
        tmdbId: 333,
        title: 'Twice',
        year: 2001,
        serverId: server.id,
        ratingKey: 'tw-b',
      },
    ]);
    expect(result.get('tw-a')).toBe(seeded);
    expect(result.get('tw-b')).toBe(seeded);
    const rows = await db.select().from(media);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tmdbId).toBe(333);
  });

  it('keeps two rows split when the same provider column carries different values for one title and year', async () => {
    const a = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 111,
      title: 'Solaris',
      year: 2002,
      serverId: 's1',
      ratingKey: '1',
    });
    const b = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 222,
      title: 'Solaris',
      year: 2002,
      serverId: 's2',
      ratingKey: '2',
    });
    expect(b).not.toBe(a);
    expect(await reconcileMediaDuplicates()).toBe(0);
    const rows = await db.select().from(media);
    expect(rows.filter((r) => !r.mergedIntoId)).toHaveLength(2);
  });

  it('does not join an id-bearing input to a same-title row one year away, at resolve or reconcile', async () => {
    const a = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'ttD1',
      title: 'Drifted',
      year: 2004,
      serverId: 's1',
      ratingKey: '1',
    });
    const b = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 4242,
      title: 'Drifted',
      year: 2005,
      serverId: 's2',
      ratingKey: '2',
    });
    expect(b).not.toBe(a);
    expect(await reconcileMediaDuplicates()).toBe(0);
  });

  it('treats a missing year as compatible in the id-bearing title probe', async () => {
    const a = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'ttN1',
      title: 'Yearless',
      year: null,
      serverId: 's1',
      ratingKey: '1',
    });
    const b = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 4243,
      title: 'Yearless',
      year: 2010,
      serverId: 's2',
      ratingKey: '2',
    });
    expect(b).toBe(a);
    const [row] = await db.select().from(media);
    expect(row!.imdbId).toBe('ttN1');
    expect(row!.tmdbId).toBe(4243);
  });

  it('inserts a new row when two existing candidates are both viable, then reconcile heals all three', async () => {
    const now = new Date();
    await db.insert(media).values([
      {
        mediaType: 'movie',
        matchKey: 'movie:imdb:ttA1',
        imdbId: 'ttA1',
        title: 'Twin',
        normalizedTitle: 'twin',
        year: 2001,
        createdAt: new Date(now.getTime() - 60000),
      },
      {
        mediaType: 'movie',
        matchKey: 'movie:tvdb:700',
        tvdbId: 700,
        title: 'Twin',
        normalizedTitle: 'twin',
        year: 2001,
        createdAt: now,
      },
    ]);
    const c = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 55,
      title: 'Twin',
      year: 2001,
      serverId: 's1',
      ratingKey: '1',
    });
    const rowsBefore = await db.select().from(media);
    expect(rowsBefore).toHaveLength(3);
    expect(rowsBefore.find((r) => r.id === c)!.matchKey).toBe('movie:tmdb:55');

    expect(await reconcileMediaDuplicates()).toBe(2);
    const rowsAfter = await db.select().from(media);
    const survivor = rowsAfter.find((r) => !r.mergedIntoId)!;
    expect(survivor.matchKey).toBe('movie:imdb:ttA1');
    expect(survivor.imdbId).toBe('ttA1');
    expect(survivor.tvdbId).toBe(700);
    expect(survivor.tmdbId).toBe(55);
    for (const r of rowsAfter.filter((r) => r.id !== survivor.id)) {
      expect(r.mergedIntoId).toBe(survivor.id);
    }
  });

  it('reconcile heals a pre-split imdb-only and tmdb-only pair, repointing library items', async () => {
    const now = new Date();
    const [older] = await db
      .insert(media)
      .values({
        mediaType: 'movie',
        matchKey: 'movie:imdb:tt0119116',
        imdbId: 'tt0119116',
        title: 'The Fifth Element',
        normalizedTitle: 'thefifthelement',
        year: 1997,
        createdAt: new Date(now.getTime() - 60000),
      })
      .returning({ id: media.id });
    const [newer] = await db
      .insert(media)
      .values({
        mediaType: 'movie',
        matchKey: 'movie:tmdb:18',
        tmdbId: 18,
        title: 'The Fifth Element',
        normalizedTitle: 'thefifthelement',
        year: 1997,
        createdAt: now,
      })
      .returning({ id: media.id });
    const server = await createTestServer({ type: 'plex' });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'rk-5e',
      mediaType: 'movie',
      title: 'The Fifth Element',
      year: 1997,
      mediaId: newer!.id,
    });

    expect(await reconcileMediaDuplicates()).toBe(1);

    const rows = await db.select().from(media);
    const winner = rows.find((r) => r.id === older!.id)!;
    const loser = rows.find((r) => r.id === newer!.id)!;
    expect(winner.mergedIntoId).toBeNull();
    expect(winner.imdbId).toBe('tt0119116');
    expect(winner.tmdbId).toBe(18);
    expect(loser.mergedIntoId).toBe(winner.id);
    const [item] = await db
      .select()
      .from(libraryItems)
      .where(sql`rating_key = 'rk-5e'`);
    expect(item!.mediaId).toBe(winner.id);
  });

  it('reconcile folds a year-less row into the sole known year bucket', async () => {
    const now = new Date();
    await db.insert(media).values([
      {
        mediaType: 'movie',
        matchKey: 'movie:imdb:tt0876563',
        imdbId: 'tt0876563',
        title: 'Ponyo',
        normalizedTitle: 'ponyo',
        year: 2008,
        createdAt: new Date(now.getTime() - 60000),
      },
      {
        mediaType: 'movie',
        matchKey: 'movie:tmdb:12429',
        tmdbId: 12429,
        title: 'Ponyo',
        normalizedTitle: 'ponyo',
        year: null,
        createdAt: now,
      },
    ]);
    expect(await reconcileMediaDuplicates()).toBe(1);
    const rows = await db.select().from(media);
    const winner = rows.find((r) => !r.mergedIntoId)!;
    expect(winner.year).toBe(2008);
    expect(winner.imdbId).toBe('tt0876563');
    expect(winner.tmdbId).toBe(12429);
  });

  it('reconcile leaves same-title rows split when years differ and a year-less row is ambiguous', async () => {
    const now = new Date();
    await db.insert(media).values([
      {
        mediaType: 'movie',
        matchKey: 'movie:tmdb:111',
        tmdbId: 111,
        title: 'Crash',
        normalizedTitle: 'crash',
        year: 1996,
        createdAt: new Date(now.getTime() - 120000),
      },
      {
        mediaType: 'movie',
        matchKey: 'movie:imdb:tt0375679',
        imdbId: 'tt0375679',
        title: 'Crash',
        normalizedTitle: 'crash',
        year: 2004,
        createdAt: new Date(now.getTime() - 60000),
      },
      {
        mediaType: 'movie',
        matchKey: 'movie:tvdb:999',
        tvdbId: 999,
        title: 'Crash',
        normalizedTitle: 'crash',
        year: null,
        createdAt: now,
      },
    ]);
    expect(await reconcileMediaDuplicates()).toBe(0);
    const rows = await db.select().from(media);
    expect(rows.filter((r) => !r.mergedIntoId)).toHaveLength(3);
  });

  it('reconciles duplicate provider rows created by races', async () => {
    // Simulate a race result: two rows, same (type, tmdb)
    await db.insert(media).values([
      {
        mediaType: 'movie',
        matchKey: 'movie:imdb:ttA',
        imdbId: 'ttA',
        tmdbId: 7,
        title: 'A',
        normalizedTitle: 'a',
        year: 2000,
      },
      {
        mediaType: 'movie',
        matchKey: 'movie:tvdb:70',
        tvdbId: 70,
        tmdbId: 7,
        title: 'A',
        normalizedTitle: 'a',
        year: 2000,
      },
    ]);
    const merged = await reconcileMediaDuplicates();
    expect(merged).toBe(1);
  });

  // Rows written by one statement share created_at. Unless noted, the expected loser holds the
  // lower id and sits first on disk, so neither decides the survivor.
  const lowId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const survivingKeys = async () =>
    (await db.select().from(media))
      .filter((r) => !r.mergedIntoId)
      .map((r) => r.matchKey)
      .sort();

  it('a resolve hitting two rows created together merges into the lower match key', async () => {
    const createdAt = new Date();
    await db.insert(media).values([
      {
        id: lowId(1),
        mediaType: 'episode',
        matchKey: 'episode:tvdb:5000101',
        tvdbId: 5000101,
        title: 'Episode 1',
        normalizedTitle: 'episode 1',
        createdAt,
      },
      {
        id: lowId(2),
        mediaType: 'episode',
        matchKey: 'episode:imdb:tt7000101',
        imdbId: 'tt7000101',
        title: 'Episode 1',
        normalizedTitle: 'episode 1',
        createdAt,
      },
    ]);
    const resolved = await resolveMediaForItem({
      mediaType: 'episode',
      imdbId: 'tt7000101',
      tvdbId: 5000101,
      title: 'Episode 1',
      serverId: 's2',
      ratingKey: '1',
    });
    expect(resolved).toBe(lowId(2));
    expect(await survivingKeys()).toEqual(['episode:imdb:tt7000101']);
  });

  it('title lookups pick the lower match key among rows created together, batched or not', async () => {
    const createdAt = new Date();
    await db.insert(media).values([
      {
        id: lowId(1),
        mediaType: 'movie',
        matchKey: 'movie:title:heat:1996',
        title: 'Heat',
        normalizedTitle: 'heat',
        year: 1996,
        createdAt,
      },
      {
        id: lowId(2),
        mediaType: 'movie',
        matchKey: 'movie:title:heat:1995',
        title: 'Heat',
        normalizedTitle: 'heat',
        year: 1995,
        createdAt,
      },
    ]);
    const server = await createTestServer({ type: 'plex' });
    const input = { mediaType: 'movie', title: 'Heat', year: 1995, serverId: server.id };
    expect(await resolveMediaForItem({ ...input, ratingKey: 'rk-1' })).toBe(lowId(2));
    const batch = await resolveMediaBatch([{ ...input, ratingKey: 'rk-2' }]);
    expect(batch.get('rk-2')).toBe(lowId(2));
  });

  it('reconcile keeps the lower match key among rows created together, in every pass', async () => {
    const createdAt = new Date();
    const row = (
      n: number,
      matchKey: string,
      fields: Omit<typeof media.$inferInsert, 'id' | 'mediaType' | 'matchKey'>
    ) => ({ id: lowId(n), mediaType: 'movie', matchKey, createdAt, ...fields });
    await db.insert(media).values([
      // Shared tmdb id; the second pair puts the winner first on disk with the lower id
      row(1, 'movie:tvdb:70', { tvdbId: 70, tmdbId: 7, title: 'A', normalizedTitle: 'a' }),
      row(5, 'movie:imdb:ttA', { imdbId: 'ttA', tmdbId: 7, title: 'A', normalizedTitle: 'a' }),
      row(2, 'movie:imdb:ttC', { imdbId: 'ttC', tmdbId: 8, title: 'B', normalizedTitle: 'b' }),
      row(6, 'movie:tvdb:80', { tvdbId: 80, tmdbId: 8, title: 'B', normalizedTitle: 'b' }),
      // Title-keyed race artifact
      row(3, 'movie:title:heat:1996', { title: 'Heat', normalizedTitle: 'heat', year: 1996 }),
      row(7, 'movie:title:heat:1995', { title: 'Heat', normalizedTitle: 'heat', year: 1995 }),
      // Split provider ids for one title and year
      row(4, 'movie:tmdb:18', { tmdbId: 18, title: 'Fifth', normalizedTitle: 'fifth', year: 1997 }),
      row(8, 'movie:imdb:tt0119116', {
        imdbId: 'tt0119116',
        title: 'Fifth',
        normalizedTitle: 'fifth',
        year: 1997,
      }),
    ]);
    expect(await reconcileMediaDuplicates()).toBe(4);
    expect(await survivingKeys()).toEqual([
      'movie:imdb:tt0119116',
      'movie:imdb:ttA',
      'movie:imdb:ttC',
      'movie:title:heat:1995',
    ]);
  });

  it('a row older by microseconds wins even when both share a millisecond', async () => {
    const at = (micros: number) =>
      sql`${`2026-01-01T00:00:00.000${String(micros).padStart(3, '0')}Z`}::timestamptz`;
    // In each pair the older row carries the higher match key and the lower id
    await db.insert(media).values([
      {
        id: lowId(1),
        mediaType: 'episode',
        matchKey: 'episode:tvdb:5000101',
        tvdbId: 5000101,
        title: 'Episode 1',
        normalizedTitle: 'episode 1',
        createdAt: at(100),
      },
      {
        id: lowId(2),
        mediaType: 'episode',
        matchKey: 'episode:imdb:tt7000101',
        imdbId: 'tt7000101',
        title: 'Episode 1',
        normalizedTitle: 'episode 1',
        createdAt: at(300),
      },
      {
        id: lowId(3),
        mediaType: 'movie',
        matchKey: 'movie:title:heat:1996',
        title: 'Heat',
        normalizedTitle: 'heat',
        year: 1996,
        createdAt: at(100),
      },
      {
        id: lowId(4),
        mediaType: 'movie',
        matchKey: 'movie:title:heat:1995',
        title: 'Heat',
        normalizedTitle: 'heat',
        year: 1995,
        createdAt: at(300),
      },
    ]);
    const resolved = await resolveMediaForItem({
      mediaType: 'episode',
      imdbId: 'tt7000101',
      tvdbId: 5000101,
      title: 'Episode 1',
      serverId: 's2',
      ratingKey: '1',
    });
    expect(resolved).toBe(lowId(1));
    const server = await createTestServer({ type: 'plex' });
    const batch = await resolveMediaBatch([
      { mediaType: 'movie', title: 'Heat', year: 1995, serverId: server.id, ratingKey: 'rk-1' },
    ]);
    expect(batch.get('rk-1')).toBe(lowId(3));
  });
});
