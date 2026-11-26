/**
 * The repair's unlink steps on real TimescaleDB: which imported links they clear, what they log,
 * and that a history with nothing to repair is read without a write or a decompressed chunk.
 *
 * Run with: pnpm --filter @tracearr/server test:integration importedLinkRepair
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestLibraryItem,
  createTestServer,
  createTestServerUser,
  createTestSession,
  createTestUser,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { media } from '../../src/db/schema.js';
import { compressSessionChunks } from '../../src/test/compressChunks.js';
import { REPAIR_CASES } from '../../src/test/keyRuleCases.js';
import { sessionWalkWindows } from '../../src/jobs/sessionWalk.js';
import {
  IMPORTED_LINK_REPAIR_VERSION,
  breakerTrips,
  countRepairCandidates,
  hasRepairableRows,
  unlinkByRule,
  unlinkFoldPairs,
} from '../../src/jobs/importedLinkRepair.js';
import type { KeyedPlay, LinkedMedia } from '../../src/services/import/libraryKeyMatch.js';

const LIMIT = 1000;

interface Seeded {
  sessionId: string;
  mediaId: string;
  showId: string | null;
}

interface SessionState {
  media_id: string | null;
  show_media_id: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  parent_rating_key: string | null;
  grandparent_rating_key: string | null;
  rating_key: string | null;
  media_title: string;
  grandparent_title: string | null;
}

interface LogRow {
  server_id: string;
  repair_version: number;
  clause: string;
  grandparent_title: string | null;
  media_id: string | null;
  show_media_id: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  parent_rating_key: string | null;
  grandparent_rating_key: string | null;
  relinked_at: Date | null;
}

async function account(type: 'plex' | 'jellyfin') {
  const server = await createTestServer({ type });
  const user = await createTestUser();
  const serverUser = await createTestServerUser({ serverId: server.id, userId: user.id });
  return { serverId: server.id, serverUserId: serverUser.id };
}

async function insertMedia(values: typeof media.$inferInsert): Promise<string> {
  const [row] = await db.insert(media).values(values).returning({ id: media.id });
  if (!row) throw new Error('media insert returned nothing');
  return row.id;
}

/** A show row, or null for a movie link. */
async function showFor(link: LinkedMedia): Promise<string | null> {
  return link.mediaType === 'episode'
    ? insertMedia({
        mediaType: 'show',
        matchKey: `show:local:${randomUUID()}`,
        title: link.showTitle ?? '',
      })
    : null;
}

/** An imported play linked to `mediaId` with every column a link copies filled in. */
async function importedPlay(
  owner: { serverId: string; serverUserId: string },
  play: KeyedPlay,
  mediaId: string,
  showId: string | null,
  startedAt = new Date()
): Promise<string> {
  const session = await createTestSession({
    ...owner,
    externalSessionId: `tautulli-${randomUUID()}`,
    state: 'stopped',
    mediaType: play.mediaType === 'episode' ? 'episode' : 'movie',
    seasonNumber: play.seasonNumber,
    episodeNumber: play.episodeNumber,
    ratingKey: '9807',
    parentRatingKey: '9806',
    grandparentRatingKey: '9805',
    mediaId,
    showMediaId: showId,
    imdbId: 'tt0285331',
    tmdbId: 46952,
    tvdbId: 266189,
    startedAt,
  });
  // The factory writes titles unescaped and defaults a null year, so these go in as parameters.
  await db.execute(sql`
    UPDATE sessions SET media_title = ${play.title ?? ''}, grandparent_title = ${play.grandparentTitle},
      year = ${play.year}::int
    WHERE id = ${session.id}::uuid
  `);
  return session.id;
}

async function seed(
  owner: { serverId: string; serverUserId: string },
  link: LinkedMedia,
  play: KeyedPlay,
  startedAt?: Date
): Promise<Seeded> {
  const showId = await showFor(link);
  const mediaId = await insertMedia({
    mediaType: link.mediaType,
    matchKey: `${link.mediaType}:local:${randomUUID()}`,
    title: link.title ?? '',
    year: link.year,
    showMediaId: showId,
  });
  for (const [season, episode] of link.numbers) {
    await createTestLibraryItem({
      serverId: owner.serverId,
      ratingKey: randomUUID(),
      mediaType: link.mediaType,
      parentIndex: season,
      itemIndex: episode,
      mediaId,
      removedAt: new Date(),
    });
  }
  const sessionId = await importedPlay(owner, play, mediaId, showId, startedAt);
  return { sessionId, mediaId, showId };
}

async function stateOf(sessionId: string): Promise<SessionState> {
  const { rows } = await db.execute(sql`
    SELECT media_id, show_media_id, imdb_id, tmdb_id, tvdb_id, parent_rating_key,
      grandparent_rating_key, rating_key, media_title, grandparent_title
    FROM sessions WHERE id = ${sessionId}::uuid
  `);
  const [row] = rows as unknown as SessionState[];
  if (!row) throw new Error(`no session ${sessionId}`);
  return row;
}

async function logOf(sessionId: string): Promise<LogRow[]> {
  const { rows } = await db.execute(sql`
    SELECT server_id, repair_version, clause, grandparent_title, media_id, show_media_id, imdb_id,
      tmdb_id, tvdb_id, parent_rating_key, grandparent_rating_key, relinked_at
    FROM session_link_repairs WHERE session_id = ${sessionId}::uuid
  `);
  return rows as unknown as LogRow[];
}

async function logCount(): Promise<number> {
  const { rows } = await db.execute(sql`SELECT count(*)::int AS n FROM session_link_repairs`);
  return (rows[0] as { n: number }).n;
}

const cleared = {
  media_id: null,
  show_media_id: null,
  imdb_id: null,
  tmdb_id: null,
  tvdb_id: null,
  parent_rating_key: null,
  grandparent_rating_key: null,
};

describe('imported link repair: unlink steps', () => {
  it('unlinks every disagreeing case and logs what it cleared', async () => {
    const owner = await account('plex');
    const cases = REPAIR_CASES.filter((c) => c.clause !== null);
    const seeded = [];
    for (const c of cases) seeded.push({ c, ...(await seed(owner, c.link, c.play)) });

    // Two rows a batch, each batch below the previous one's cursor, until one comes back short.
    let total = 0;
    let cursor: string | undefined;
    for (;;) {
      const batch = await unlinkByRule([owner.serverId], null, 2, cursor);
      total += batch.count;
      cursor = batch.cursor;
      if (batch.count < 2) break;
      expect(batch.oldest).toBeInstanceOf(Date);
    }
    expect(total).toBe(cases.length);

    for (const { c, sessionId, mediaId, showId } of seeded) {
      expect({ name: c.name, ...(await stateOf(sessionId)) }).toEqual({
        name: c.name,
        ...cleared,
        rating_key: '9807',
        media_title: c.play.title ?? '',
        grandparent_title: c.play.grandparentTitle,
      });
      expect({ name: c.name, log: await logOf(sessionId) }).toEqual({
        name: c.name,
        log: [
          {
            server_id: owner.serverId,
            repair_version: IMPORTED_LINK_REPAIR_VERSION,
            clause: c.clause,
            grandparent_title: c.play.grandparentTitle,
            media_id: mediaId,
            show_media_id: showId,
            imdb_id: 'tt0285331',
            tmdb_id: 46952,
            tvdb_id: 266189,
            parent_rating_key: '9806',
            grandparent_rating_key: '9805',
            relinked_at: null,
          },
        ],
      });
    }

    expect(await unlinkByRule([owner.serverId], null, LIMIT)).toEqual({ count: 0, oldest: null });
  });

  it('keeps a renamed show, a renumbered show and placeholder titles', async () => {
    const owner = await account('plex');
    const cases = REPAIR_CASES.filter((c) => c.clause === null);
    const seeded = [];
    for (const c of cases) seeded.push({ c, ...(await seed(owner, c.link, c.play)) });

    expect(await unlinkByRule([owner.serverId], null, LIMIT)).toEqual({ count: 0, oldest: null });
    for (const { c, sessionId, mediaId } of seeded) {
      expect({ name: c.name, mediaId: (await stateOf(sessionId)).media_id }).toEqual({
        name: c.name,
        mediaId,
      });
    }
    expect(await logCount()).toBe(0);
  });

  it('keeps a link to merged-away media', async () => {
    const owner = await account('plex');
    const play = REPAIR_CASES[0]?.play;
    if (!play) throw new Error('no repair case');
    // The loser alone disagrees: another show title and other numbers in its match key. The
    // merge moved the library items, with the play's numbers, to the winner.
    const winnerShow = await insertMedia({
      mediaType: 'show',
      matchKey: `show:local:${randomUUID()}`,
      title: 'SpongeBob SquarePants',
    });
    const winner = await insertMedia({
      mediaType: 'episode',
      matchKey: `episode:local:${randomUUID()}`,
      title: play.title ?? '',
      year: play.year,
      showMediaId: winnerShow,
    });
    await createTestLibraryItem({
      serverId: owner.serverId,
      ratingKey: randomUUID(),
      mediaType: 'episode',
      parentIndex: play.seasonNumber,
      itemIndex: play.episodeNumber,
      mediaId: winner,
    });
    const loserShow = await insertMedia({
      mediaType: 'show',
      matchKey: `show:local:${randomUUID()}`,
      title: 'Sponge Bob',
    });
    const loser = await insertMedia({
      mediaType: 'episode',
      matchKey: `episode:${loserShow}:s1e1`,
      title: 'Reef Blower',
      year: 1999,
      showMediaId: loserShow,
      mergedIntoId: winner,
    });
    const sessionId = await importedPlay(owner, play, loser, loserShow);

    expect(await unlinkByRule([owner.serverId], null, LIMIT)).toEqual({ count: 0, oldest: null });
    expect((await stateOf(sessionId)).media_id).toBe(loser);
    expect(await countRepairCandidates(null)).toEqual([
      { serverId: owner.serverId, candidates: 0, linked: 1 },
    ]);
  });

  it('never touches another server type', async () => {
    const owner = await account('jellyfin');
    const c = REPAIR_CASES[0];
    if (!c) throw new Error('no repair case');
    const { sessionId, mediaId } = await seed(owner, c.link, c.play);

    expect(await hasRepairableRows()).toBe(false);
    expect(await countRepairCandidates(null)).toEqual([]);
    expect(await unlinkByRule([owner.serverId], null, LIMIT)).toEqual({ count: 0, oldest: null });
    expect((await stateOf(sessionId)).media_id).toBe(mediaId);
    expect(await logCount()).toBe(0);
  });

  it('unlinks fold rows by logged pair', async () => {
    const owner = await account('plex');
    const firstCase = REPAIR_CASES[0];
    if (!firstCase) throw new Error('no repair case');
    const blacklist = await insertMedia({
      mediaType: 'show',
      matchKey: `show:local:${randomUUID()}`,
      title: 'The Blacklist',
    });
    // Episodes the title path created under the folded show: the play's own numbers and title.
    const foldedEpisode = async (play: KeyedPlay) =>
      insertMedia({
        mediaType: 'episode',
        matchKey: `episode:${blacklist}:s${play.seasonNumber}e${play.episodeNumber}`,
        title: play.title ?? '',
        year: play.year,
        showMediaId: blacklist,
      });
    const spongebob: KeyedPlay = {
      ...firstCase.play,
      seasonNumber: 12,
      episodeNumber: 22,
      title: 'Big Bad Bubble Bass',
      year: null,
    };
    const drawnTogether: KeyedPlay = {
      ...firstCase.play,
      grandparentTitle: 'Drawn Together',
      seasonNumber: 3,
      episodeNumber: 8,
      title: 'Lost in Parking Space',
      year: 2007,
    };
    const foldId = await importedPlay(owner, spongebob, await foldedEpisode(spongebob), blacklist);
    const otherId = await importedPlay(
      owner,
      drawnTogether,
      await foldedEpisode(drawnTogether),
      blacklist
    );

    expect(await unlinkFoldPairs([owner.serverId], null, LIMIT)).toEqual({
      count: 0,
      oldest: null,
    });

    const keyedEpisode = await insertMedia({
      mediaType: 'episode',
      matchKey: `episode:local:${randomUUID()}`,
      title: firstCase.link.title ?? '',
      year: firstCase.link.year,
      showMediaId: blacklist,
    });
    for (const [season, episode] of firstCase.link.numbers) {
      await createTestLibraryItem({
        serverId: owner.serverId,
        ratingKey: randomUUID(),
        mediaType: 'episode',
        parentIndex: season,
        itemIndex: episode,
        mediaId: keyedEpisode,
      });
    }
    await importedPlay(owner, firstCase.play, keyedEpisode, blacklist);

    // A logged pair naming the play's own show never unlinks a play filed under that show.
    const ownShow = await insertMedia({
      mediaType: 'show',
      matchKey: `show:local:${randomUUID()}`,
      title: 'SpongeBob SquarePants',
    });
    const ownEpisode = await insertMedia({
      mediaType: 'episode',
      matchKey: `episode:${ownShow}:s12e22`,
      title: spongebob.title ?? '',
      showMediaId: ownShow,
    });
    const ownId = await importedPlay(owner, spongebob, ownEpisode, ownShow);
    await db.execute(sql`
      INSERT INTO session_link_repairs (session_id, started_at, repair_version, server_id, clause,
        grandparent_title, show_media_id)
      VALUES (${randomUUID()}::uuid, now(), ${IMPORTED_LINK_REPAIR_VERSION}, ${owner.serverId}::uuid,
        'numbers', 'SpongeBob SquarePants', ${ownShow}::uuid)
    `);

    expect((await unlinkByRule([owner.serverId], null, LIMIT)).count).toBe(1);
    expect((await stateOf(foldId)).media_id).not.toBeNull();

    expect((await unlinkFoldPairs([owner.serverId], null, LIMIT)).count).toBe(1);
    expect((await stateOf(ownId)).media_id).toBe(ownEpisode);
    expect(await stateOf(foldId)).toMatchObject(cleared);
    expect((await logOf(foldId)).map((row) => row.clause)).toEqual(['fold']);
    expect((await stateOf(otherId)).media_id).not.toBeNull();
    expect(await logOf(otherId)).toEqual([]);
  });

  it("keeps a renamed show's library-backed links when a fold pair matches its title", async () => {
    const owner = await account('plex');
    const rename = REPAIR_CASES.find((c) => c.name === 'rename with equal numbers');
    if (!rename) throw new Error('no rename case');
    const plur1bus = await insertMedia({
      mediaType: 'show',
      matchKey: `show:local:${randomUUID()}`,
      title: 'PLUR1BUS',
    });
    const keyedEpisode = await insertMedia({
      mediaType: 'episode',
      matchKey: `episode:local:${randomUUID()}`,
      title: rename.link.title ?? '',
      year: rename.link.year,
      showMediaId: plur1bus,
    });
    // The play's own rating key names the episode it is linked to.
    await createTestLibraryItem({
      serverId: owner.serverId,
      ratingKey: '9807',
      mediaType: 'episode',
      parentIndex: 1,
      itemIndex: 1,
      mediaId: keyedEpisode,
    });
    const keyedId = await importedPlay(owner, rename.play, keyedEpisode, plur1bus);
    const titlePlay: KeyedPlay = { ...rename.play, episodeNumber: 2, title: 'Episode 2' };
    const titleEpisode = await insertMedia({
      mediaType: 'episode',
      matchKey: `episode:${plur1bus}:s1e2`,
      title: 'Episode 2',
      year: rename.play.year,
      showMediaId: plur1bus,
    });
    const titleId = await importedPlay(owner, titlePlay, titleEpisode, plur1bus);
    await db.execute(sql`
      INSERT INTO session_link_repairs (session_id, started_at, repair_version, server_id, clause,
        grandparent_title, show_media_id)
      VALUES (${randomUUID()}::uuid, now(), ${IMPORTED_LINK_REPAIR_VERSION}, ${owner.serverId}::uuid,
        'numbers', 'Pluribus', ${plur1bus}::uuid)
    `);

    expect((await unlinkFoldPairs([owner.serverId], null, LIMIT)).count).toBe(1);
    expect((await stateOf(keyedId)).media_id).toBe(keyedEpisode);
    expect(await logOf(keyedId)).toEqual([]);
    expect(await stateOf(titleId)).toMatchObject(cleared);
    expect((await logOf(titleId)).map((row) => row.clause)).toEqual(['fold']);
  });

  it('unlinks a fold row that landed on a library episode at the same numbers', async () => {
    const owner = await account('plex');
    const blacklist = await insertMedia({
      mediaType: 'show',
      matchKey: `show:local:${randomUUID()}`,
      title: 'The Blacklist',
    });
    const pilot = await insertMedia({
      mediaType: 'episode',
      matchKey: `episode:local:${randomUUID()}`,
      title: 'Pilot',
      year: 2013,
      showMediaId: blacklist,
    });
    await createTestLibraryItem({
      serverId: owner.serverId,
      ratingKey: randomUUID(),
      mediaType: 'episode',
      parentIndex: 1,
      itemIndex: 1,
      mediaId: pilot,
    });
    const play: KeyedPlay = {
      mediaType: 'episode',
      grandparentTitle: 'SpongeBob SquarePants',
      seasonNumber: 1,
      episodeNumber: 1,
      title: 'Help Wanted',
      // A known year two apart would let the rule's title clause take the row first.
      year: null,
      guid: null,
    };
    const sessionId = await importedPlay(owner, play, pilot, blacklist);
    await db.execute(sql`
      INSERT INTO session_link_repairs (session_id, started_at, repair_version, server_id, clause,
        grandparent_title, show_media_id)
      VALUES (${randomUUID()}::uuid, now(), ${IMPORTED_LINK_REPAIR_VERSION}, ${owner.serverId}::uuid,
        'numbers', 'SpongeBob SquarePants', ${blacklist}::uuid)
    `);

    expect((await unlinkByRule([owner.serverId], null, LIMIT)).count).toBe(0);
    expect((await unlinkFoldPairs([owner.serverId], null, LIMIT)).count).toBe(1);
    expect(await stateOf(sessionId)).toMatchObject(cleared);
    expect((await logOf(sessionId)).map((row) => row.clause)).toEqual(['fold']);
  });

  it('takes pairs only from rule unlinks of this repair version', async () => {
    const owner = await account('plex');
    const blacklist = await insertMedia({
      mediaType: 'show',
      matchKey: `show:local:${randomUUID()}`,
      title: 'The Blacklist',
    });
    const plays: KeyedPlay[] = ['SpongeBob SquarePants', 'Drawn Together'].map((show) => ({
      mediaType: 'episode',
      grandparentTitle: show,
      seasonNumber: 1,
      episodeNumber: 1,
      title: 'Episode 1',
      year: null,
      guid: null,
    }));
    const ids = [];
    for (const play of plays) {
      const episode = await insertMedia({
        mediaType: 'episode',
        matchKey: `episode:local:${randomUUID()}`,
        title: 'Episode 1',
        showMediaId: blacklist,
      });
      ids.push({ sessionId: await importedPlay(owner, play, episode, blacklist), episode });
    }
    await db.execute(sql`
      INSERT INTO session_link_repairs (session_id, started_at, repair_version, server_id, clause,
        grandparent_title, show_media_id)
      VALUES
        (${randomUUID()}::uuid, now(), ${IMPORTED_LINK_REPAIR_VERSION + 1}, ${owner.serverId}::uuid,
          'numbers', 'SpongeBob SquarePants', ${blacklist}::uuid),
        (${randomUUID()}::uuid, now(), ${IMPORTED_LINK_REPAIR_VERSION}, ${owner.serverId}::uuid,
          'fold', 'Drawn Together', ${blacklist}::uuid)
    `);

    expect(await unlinkFoldPairs([owner.serverId], null, LIMIT)).toEqual({
      count: 0,
      oldest: null,
    });
    for (const { sessionId, episode } of ids) {
      expect((await stateOf(sessionId)).media_id).toBe(episode);
    }
  });

  it('acts only inside the window', async () => {
    const owner = await account('plex');
    const firstCase = REPAIR_CASES[0];
    if (!firstCase) throw new Error('no repair case');
    const now = Date.now();
    const window = { start: new Date(now - 86_400_000), end: new Date(now + 86_400_000) };
    const outside = new Date(now - 200 * 86_400_000);
    const inRule = await seed(owner, firstCase.link, firstCase.play);
    const outRule = await seed(owner, firstCase.link, firstCase.play, outside);
    // Fold rows under the show the in-window rule unlink logs as its pair.
    const showId = inRule.showId;
    if (!showId) throw new Error('no show');
    const foldPlay: KeyedPlay = { ...firstCase.play, seasonNumber: 12, episodeNumber: 9 };
    const foldRow = async (startedAt: Date) => {
      const episode = await insertMedia({
        mediaType: 'episode',
        matchKey: `episode:${showId}:s12e9:${randomUUID()}`,
        title: foldPlay.title ?? '',
        showMediaId: showId,
      });
      return importedPlay(owner, foldPlay, episode, showId, startedAt);
    };
    const inFold = await foldRow(new Date(now));
    const outFold = await foldRow(outside);

    expect((await unlinkByRule([owner.serverId], window, LIMIT)).count).toBe(1);
    expect((await unlinkFoldPairs([owner.serverId], window, LIMIT)).count).toBe(1);
    expect((await stateOf(inRule.sessionId)).media_id).toBeNull();
    expect((await stateOf(inFold)).media_id).toBeNull();
    expect((await stateOf(outRule.sessionId)).media_id).toBe(outRule.mediaId);
    expect((await stateOf(outFold)).media_id).not.toBeNull();
  });

  it('counts per server and trips the breaker only past the floor and share', async () => {
    const plex = await account('plex');
    const other = await account('plex');
    for (const c of REPAIR_CASES) await seed(plex, c.link, c.play);
    // Neither an unlinked import nor a tracked play counts as linked.
    const c = REPAIR_CASES[0];
    if (!c) throw new Error('no repair case');
    const unlinked = await seed(plex, c.link, c.play);
    await db.execute(
      sql`UPDATE sessions SET media_id = NULL WHERE id = ${unlinked.sessionId}::uuid`
    );
    const tracked = await seed(plex, c.link, c.play);
    await db.execute(
      sql`UPDATE sessions SET external_session_id = NULL WHERE id = ${tracked.sessionId}::uuid`
    );
    const keep = REPAIR_CASES.find((r) => r.clause === null);
    if (!keep) throw new Error('no kept case');
    await seed(other, keep.link, keep.play);

    const candidates = REPAIR_CASES.filter((r) => r.clause !== null).length;
    expect(await hasRepairableRows()).toBe(true);
    const counts = await countRepairCandidates(await sessionWalkWindows(null));
    expect(counts.sort((a, b) => b.candidates - a.candidates)).toEqual([
      { serverId: plex.serverId, candidates, linked: REPAIR_CASES.length },
      { serverId: other.serverId, candidates: 0, linked: 1 },
    ]);
    expect(await logCount()).toBe(0);

    const serverId = plex.serverId;
    expect(breakerTrips({ serverId, candidates: 55, linked: 100 })).toBe(false);
    expect(breakerTrips({ serverId, candidates: 499, linked: 600 })).toBe(false);
    expect(breakerTrips({ serverId, candidates: 501, linked: 600 })).toBe(true);
  });

  it(
    'leaves a compressed chunk untouched when nothing disagrees',
    { timeout: 120_000 },
    async () => {
      const owner = await account('plex');
      const kept = REPAIR_CASES.filter((c) => c.clause === null);
      const startedAt = Date.now() - 120 * 86_400_000;
      let i = 0;
      for (let round = 0; round < 5; round++) {
        for (const c of kept) {
          await seed(owner, c.link, c.play, new Date(startedAt + i++ * 60_000));
        }
      }
      // A pair in the log makes the fold step read sessions too; no row matches it.
      const unrelatedShow = await insertMedia({
        mediaType: 'show',
        matchKey: `show:local:${randomUUID()}`,
        title: 'The Blacklist',
      });
      await db.execute(sql`
        INSERT INTO session_link_repairs (session_id, started_at, repair_version, server_id, clause,
          grandparent_title, show_media_id)
        VALUES (${randomUUID()}::uuid, now(), ${IMPORTED_LINK_REPAIR_VERSION}, ${owner.serverId}::uuid,
          'numbers', 'SpongeBob SquarePants', ${unrelatedShow}::uuid)
      `);

      expect((await compressSessionChunks(90)).length).toBeGreaterThanOrEqual(1);
      const chunks = async () =>
        (
          await db.execute(sql`
            SELECT format('%I.%I', chunk_schema, chunk_name) AS name, is_compressed
            FROM timescaledb_information.chunks
            WHERE hypertable_name = 'sessions' AND range_end <= now() - interval '90 days'
          `)
        ).rows as Array<{ name: string; is_compressed: boolean }>;
      const before = await chunks();
      expect(before.length).toBeGreaterThanOrEqual(1);
      expect(before.every((chunk) => chunk.is_compressed)).toBe(true);

      const windows = await sessionWalkWindows(null);
      if (!windows) throw new Error('sessions is not a hypertable');
      expect(await countRepairCandidates(windows)).toEqual([
        { serverId: owner.serverId, candidates: 0, linked: kept.length * 5 },
      ]);
      for (const window of windows) {
        expect(await unlinkByRule([owner.serverId], window, LIMIT)).toEqual({
          count: 0,
          oldest: null,
        });
        expect(await unlinkFoldPairs([owner.serverId], window, LIMIT)).toEqual({
          count: 0,
          oldest: null,
        });
      }

      expect(await chunks()).toEqual(before);
      for (const chunk of before) {
        const { rows } = await db.execute(
          sql`SELECT count(*)::int AS n FROM ONLY ${sql.raw(chunk.name)}`
        );
        expect({ chunk: chunk.name, heap: (rows[0] as { n: number }).n }).toEqual({
          chunk: chunk.name,
          heap: 0,
        });
      }
      expect(await logCount()).toBe(1);
    }
  );
});
