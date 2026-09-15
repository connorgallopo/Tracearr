/**
 * The window query decides inclusion by first_seen_at with created_at as the fallback,
 * excludes removed rows, and honors server and library scope. Only Postgres can prove it.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- newsletterAssemble
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_NEWSLETTER_SECTIONS } from '@tracearr/shared';
import { seedBasicOwner } from '@tracearr/test-utils';
import { db } from '../../src/db/client.js';
import { libraryItems, servers } from '../../src/db/schema.js';
import {
  assembleDigest,
  loadItemRows,
  loadWindowItems,
} from '../../src/services/newsletters/assemble.js';

const START = new Date('2026-08-26T00:00:00Z');
const END = new Date('2026-09-02T00:00:00Z');
const inside = new Date('2026-08-30T00:00:00Z');
const before = new Date('2026-08-01T00:00:00Z');
// Distinct from `inside` so the three included rows have a well-defined recency
// order instead of tying on the same COALESCE(first_seen_at, created_at) instant.
const newerInside = new Date('2026-08-31T00:00:00Z');
const olderInside = new Date('2026-08-29T00:00:00Z');

describe('loadWindowItems', () => {
  let serverId: string;

  // The suite-wide beforeEach truncates every table before each test, so this
  // seed has to be re-inserted per test rather than once in a beforeAll.
  beforeEach(async () => {
    const seeded = await seedBasicOwner();
    serverId = seeded.serverId;
    await db.insert(libraryItems).values([
      {
        serverId,
        libraryId: '1',
        ratingKey: 'a',
        title: 'Seen inside, added before',
        mediaType: 'movie',
        createdAt: before,
        firstSeenAt: newerInside,
      },
      {
        serverId,
        libraryId: '1',
        ratingKey: 'b',
        title: 'Added inside, never first-seen',
        mediaType: 'movie',
        createdAt: inside,
        firstSeenAt: null,
      },
      {
        serverId,
        libraryId: '1',
        ratingKey: 'c',
        title: 'Removed',
        mediaType: 'movie',
        createdAt: inside,
        firstSeenAt: inside,
        removedAt: inside,
      },
      {
        serverId,
        libraryId: '2',
        ratingKey: 'd',
        title: 'Other library',
        mediaType: 'movie',
        createdAt: olderInside,
        firstSeenAt: olderInside,
      },
      {
        serverId,
        libraryId: '1',
        ratingKey: 'e',
        title: 'Before window',
        mediaType: 'movie',
        createdAt: before,
        firstSeenAt: before,
      },
      {
        serverId,
        libraryId: '1',
        ratingKey: 'f',
        title: 'At the end boundary',
        mediaType: 'movie',
        createdAt: END,
        firstSeenAt: END,
      },
    ]);
  });

  it('includes first-seen-inside and added-inside rows, excludes removed, out-of-window, and end-boundary rows', async () => {
    const rows = await loadWindowItems(
      { serverIds: [], libraries: [] },
      { start: START, end: END }
    );
    expect(rows.map((r) => r.ratingKey).sort()).toEqual(['a', 'b', 'd']);
    expect(rows.find((r) => r.ratingKey === 'a')?.addedAt).toEqual(before);
    // groupDigest's artist/album ordering relies on rows already arriving newest-first.
    expect(rows.map((r) => r.ratingKey)).toEqual(['a', 'b', 'd']);
  });

  it('pairs a library with its server, so the same section id on another server stays out', async () => {
    const [other] = await db
      .insert(servers)
      .values({ name: 'Attic', type: 'plex', url: 'http://attic:32400', token: 'tok' })
      .returning({ id: servers.id });
    const otherId = other!.id;
    await db.insert(libraryItems).values({
      serverId: otherId,
      libraryId: '1',
      ratingKey: 'z',
      title: 'Section 1 on the other server',
      mediaType: 'movie',
      createdAt: inside,
      firstSeenAt: inside,
    });
    const window = { start: START, end: END };

    const basement = await loadWindowItems(
      { serverIds: [], libraries: [{ serverId, libraryId: '1' }] },
      window
    );
    expect(basement.map((r) => r.ratingKey).sort()).toEqual(['a', 'b']);

    const attic = await loadWindowItems(
      { serverIds: [], libraries: [{ serverId: otherId, libraryId: '1' }] },
      window
    );
    expect(attic.map((r) => r.ratingKey)).toEqual(['z']);

    const scoped = await loadWindowItems(
      { serverIds: [serverId], libraries: [{ serverId, libraryId: '2' }] },
      window
    );
    expect(scoped.map((r) => r.ratingKey)).toEqual(['d']);

    const none = await loadWindowItems(
      { serverIds: ['00000000-0000-4000-8000-000000000000'], libraries: [] },
      window
    );
    expect(none).toEqual([]);
  });
});

describe('loadItemRows', () => {
  let serverId: string;
  let otherServerId: string;
  const SHARED_KEY = 'shared-rk';
  const REMOVED_KEY = 'removed-rk';
  const movieMediaId = randomUUID();
  const showMediaId = randomUUID();

  // library_items_server_rating_key_unique is unique on (server_id, rating_key) alone,
  // with no media_type in it, so a movie and a show can never share a rating key on
  // the same server. The shared key lives on two servers instead, one row of each type.
  beforeEach(async () => {
    const seeded = await seedBasicOwner();
    serverId = seeded.serverId;
    const [other] = await db
      .insert(servers)
      .values({ name: 'Other Server', type: 'plex', url: 'http://other:32400', token: 'tok' })
      .returning({ id: servers.id });
    otherServerId = other!.id;
    await db.insert(libraryItems).values([
      {
        serverId,
        libraryId: '1',
        ratingKey: SHARED_KEY,
        title: 'Shared Movie',
        mediaType: 'movie',
        mediaId: movieMediaId,
        imdbId: 'tt0000001',
      },
      {
        serverId: otherServerId,
        libraryId: '1',
        ratingKey: SHARED_KEY,
        title: 'Shared Show',
        mediaType: 'show',
        mediaId: showMediaId,
        imdbId: 'tt0000002',
      },
      {
        serverId,
        libraryId: '1',
        ratingKey: REMOVED_KEY,
        title: 'Gone',
        mediaType: 'movie',
        removedAt: new Date('2026-08-01T00:00:00Z'),
      },
    ]);
  });

  it('filters by media_type, returning the movie row and not the show row sharing its key', async () => {
    const keys = [
      { serverId, ratingKey: SHARED_KEY },
      { serverId: otherServerId, ratingKey: SHARED_KEY },
    ];
    const movieRows = await loadItemRows(keys, 'movie');
    expect(movieRows).toHaveLength(1);
    expect(movieRows[0]).toMatchObject({
      title: 'Shared Movie',
      mediaId: movieMediaId,
      imdbId: 'tt0000001',
    });

    const showRows = await loadItemRows(keys, 'show');
    expect(showRows).toHaveLength(1);
    expect(showRows[0]).toMatchObject({
      title: 'Shared Show',
      mediaId: showMediaId,
      imdbId: 'tt0000002',
    });
  });

  it('excludes a removed row for its key', async () => {
    const rows = await loadItemRows([{ serverId, ratingKey: REMOVED_KEY }], 'movie');
    expect(rows).toEqual([]);
  });

  it('returns [] without a query for an empty key list', async () => {
    const spy = vi.spyOn(db, 'execute');
    const rows = await loadItemRows([], 'movie');
    expect(rows).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('assembleDigest mirrors', () => {
  it('collapses a title on two servers into one card with the first scoped server first and the other as a mirror, and never collapses a null media id', async () => {
    const seeded = await seedBasicOwner();
    const [attic] = await db
      .insert(servers)
      .values({ name: 'Attic', type: 'plex', url: 'http://attic:32400', token: 'tok' })
      .returning({ id: servers.id });
    const atticId = attic!.id;
    const heat = randomUUID();
    await db.insert(libraryItems).values([
      {
        serverId: seeded.serverId,
        libraryId: '1',
        ratingKey: 'a-heat',
        title: 'Heat',
        mediaType: 'movie',
        mediaId: heat,
        createdAt: inside,
        firstSeenAt: inside,
      },
      {
        serverId: atticId,
        libraryId: '1',
        ratingKey: 'b-heat',
        title: 'Heat',
        mediaType: 'movie',
        mediaId: heat,
        createdAt: inside,
        firstSeenAt: inside,
      },
      {
        serverId: seeded.serverId,
        libraryId: '1',
        ratingKey: 'a-alien',
        title: 'Alien',
        mediaType: 'movie',
        mediaId: null,
        createdAt: inside,
        firstSeenAt: inside,
      },
      {
        serverId: atticId,
        libraryId: '1',
        ratingKey: 'b-alien',
        title: 'Alien',
        mediaType: 'movie',
        mediaId: null,
        createdAt: inside,
        firstSeenAt: inside,
      },
    ]);
    const window = { start: START, end: END };
    const sections = { ...DEFAULT_NEWSLETTER_SECTIONS, music: { enabled: false, max: 8 } };

    const both = await assembleDigest(
      { scope: { serverIds: [atticId, seeded.serverId], libraries: [] }, sections },
      window,
      { posters: false }
    );
    const cards = both.data.movies.map((m) => [m.title, m.serverId, m.mirrors]);
    expect(cards.filter(([title]) => title === 'Heat')).toEqual([
      ['Heat', atticId, [{ serverId: seeded.serverId, ratingKey: 'a-heat' }]],
    ]);
    expect(
      cards
        .filter(([title]) => title === 'Alien')
        .map(([, serverId]) => serverId)
        .sort()
    ).toEqual([atticId, seeded.serverId].sort());
    expect(both.data.counts.movies).toBe(3);
    expect(both.posters).toEqual({});

    const atticOnly = await assembleDigest(
      { scope: { serverIds: [atticId], libraries: [] }, sections },
      window,
      { posters: false }
    );
    // The two Attic rows share a first-seen instant, so their order is not defined; sort before comparing.
    expect(atticOnly.data.movies.map((m) => [m.ratingKey, m.mirrors]).sort()).toEqual([
      ['b-alien', []],
      ['b-heat', []],
    ]);
  });

  it("folds a show whose refetched rows mirror each other into one card counting both servers' new episodes", async () => {
    const seeded = await seedBasicOwner();
    const [attic] = await db
      .insert(servers)
      .values({ name: 'Attic', type: 'plex', url: 'http://attic:32400', token: 'tok' })
      .returning({ id: servers.id });
    const atticId = attic!.id;
    const wire = randomUUID();
    const episode = (serverId: string, showKey: string, e: number) => ({
      serverId,
      libraryId: '1',
      ratingKey: `${showKey}-e${e}`,
      title: `Ep ${e}`,
      mediaType: 'episode',
      grandparentTitle: 'Wire',
      grandparentRatingKey: showKey,
      parentTitle: 'Season 1',
      parentRatingKey: `${showKey}-s1`,
      parentIndex: 1,
      itemIndex: e,
      createdAt: inside,
      firstSeenAt: inside,
    });
    // The show rows sit outside the window, so assembleDigest refetches one per server
    // and only the second collapse pass can see they are the same title.
    await db.insert(libraryItems).values([
      {
        serverId: seeded.serverId,
        libraryId: '1',
        ratingKey: 'show-a',
        title: 'Wire',
        mediaType: 'show',
        mediaId: wire,
        year: 2002,
        thumbPath: '/wire',
        createdAt: before,
        firstSeenAt: before,
      },
      {
        serverId: atticId,
        libraryId: '1',
        ratingKey: 'show-b',
        title: 'Wire',
        mediaType: 'show',
        mediaId: wire,
        year: 2002,
        thumbPath: '/wire-attic',
        createdAt: before,
        firstSeenAt: before,
      },
      episode(seeded.serverId, 'show-a', 1),
      episode(seeded.serverId, 'show-a', 2),
      episode(atticId, 'show-b', 3),
    ]);

    const { data } = await assembleDigest(
      {
        scope: { serverIds: [seeded.serverId, atticId], libraries: [] },
        sections: { ...DEFAULT_NEWSLETTER_SECTIONS, music: { enabled: false, max: 8 } },
      },
      { start: START, end: END },
      { posters: false }
    );
    expect(data.counts.shows).toBe(1);
    expect(data.shows.map((s) => [s.title, s.serverId, s.thumbPath, s.year, s.mirrors])).toEqual([
      ['Wire', seeded.serverId, '/wire', 2002, [{ serverId: atticId, ratingKey: 'show-b' }]],
    ]);
    expect(data.shows[0]?.episodeCount).toBe(3);
    expect(data.shows[0]?.seasons.map((s) => [s.number, s.episodeRange])).toEqual([[1, 'E01-E03']]);
  });
});
