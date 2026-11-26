/**
 * The repair on real TimescaleDB: which imported links its unlink steps clear and what they log,
 * that a history with nothing to repair is read without a write or a decompressed chunk, and the
 * job: relinking through the import resolver, the breaker, the aggregate refresh and the lock.
 *
 * Run with: pnpm --filter @tracearr/server test:integration importedLinkRepair
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { Redis } from 'ioredis';
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
  runImportedLinkRepair,
  unlinkByRule,
  unlinkFoldPairs,
} from '../../src/jobs/importedLinkRepair.js';
import { acquireHeavyOpsLock, initHeavyOpsLock } from '../../src/jobs/heavyOpsLock.js';
import {
  enqueueMaintenanceJob,
  getMaintenanceJobStatus,
  initMaintenanceQueue,
  obliterateMaintenanceQueue,
  processImportedLinkRepairJob,
  shutdownMaintenanceQueue,
  startMaintenanceWorker,
  type MaintenanceJobData,
} from '../../src/jobs/maintenanceQueue.js';
import { getSetting, resetSettingsCache } from '../../src/services/settings.js';
import type { KeyedPlay, LinkedMedia } from '../../src/services/import/libraryKeyMatch.js';

const gate = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  reached: () => {},
  failResolve: false,
  refreshes: [] as Array<{ aggregate: string; start: Date }>,
}));
vi.mock('../../src/db/timescale.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/timescale.js')>();
  return {
    ...actual,
    safeFullRefreshAggregate: (...args: Parameters<typeof actual.safeFullRefreshAggregate>) => {
      gate.refreshes.push({ aggregate: args[0], start: args[1] });
      return actual.safeFullRefreshAggregate(...args);
    },
  };
});
vi.mock('../../src/services/library/importedPlayIdentity.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/services/library/importedPlayIdentity.js')>();
  return {
    ...actual,
    resolveImportedPlays: (...args: Parameters<typeof actual.resolveImportedPlays>) => {
      if (gate.failResolve) throw new Error('resolver unavailable');
      return actual.resolveImportedPlays(...args);
    },
  };
});
vi.mock('../../src/jobs/sessionWalk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/jobs/sessionWalk.js')>();
  return {
    ...actual,
    sessionWalkWindows: async (minStart: Date | null) => {
      if (gate.hold) {
        gate.reached();
        await gate.hold;
      }
      return actual.sessionWalkWindows(minStart);
    },
  };
});

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

function repairJob(trigger: 'auto' | 'manual'): Job<MaintenanceJobData> {
  return {
    id: `test-repair-${trigger}`,
    token: 'test-token',
    data: {
      type: 'repair_imported_links',
      userId: trigger === 'auto' ? 'system' : 'owner',
      options: trigger === 'auto' ? { trigger } : undefined,
    },
    updateProgress: async () => undefined,
    extendLock: async () => undefined,
  } as unknown as Job<MaintenanceJobData>;
}

const fullRun = () =>
  runImportedLinkRepair({
    skipBreaker: false,
    onBatch: async () => {},
    onCommit: () => {},
    beforeUnlink: async () => {},
  });

/** The titles of the media a play is linked to and of its show. */
async function linkOf(sessionId: string) {
  const { rows } = await db.execute(sql`
    SELECT m.title AS media, sh.title AS show
    FROM sessions s
    LEFT JOIN media m ON m.id = s.media_id
    LEFT JOIN media sh ON sh.id = s.show_media_id
    WHERE s.id = ${sessionId}::uuid
  `);
  const [row] = rows as Array<{ media: string | null; show: string | null }>;
  if (!row) throw new Error(`no session ${sessionId}`);
  return row;
}

/** Row versions of every session and log row; any write changes one. */
async function rowVersions() {
  const { rows } = await db.execute(sql`
    SELECT 'session:' || id AS id, xmin::text AS v FROM sessions
    UNION ALL SELECT 'log:' || session_id, xmin::text FROM session_link_repairs
    ORDER BY 1
  `);
  return rows;
}

const numbersCases = REPAIR_CASES.filter((c) => c.clause === 'numbers');

describe('imported link repair: relink and the job', () => {
  beforeEach(() => {
    resetSettingsCache();
    gate.failResolve = false;
    gate.hold = null;
    gate.refreshes = [];
  });

  it('relinks unlinked rows to their own show', async () => {
    const owner = await account('plex');
    const seeded = [];
    for (const c of numbersCases) seeded.push({ c, ...(await seed(owner, c.link, c.play)) });

    const result = await fullRun();

    expect(result).toMatchObject({
      unlinked: numbersCases.length,
      relinked: numbersCases.length,
      trippedServers: [],
    });
    for (const { c, sessionId } of seeded) {
      expect({ name: c.name, show: (await linkOf(sessionId)).show }).toEqual({
        name: c.name,
        show: c.play.grandparentTitle,
      });
      const log = await logOf(sessionId);
      expect(log).toHaveLength(1);
      expect(log[0]?.relinked_at).not.toBeNull();
    }
  });

  it('does not relink a movie by the ids the bad link copied', async () => {
    const owner = await account('plex');
    const c = REPAIR_CASES.find((r) => r.clause === 'movie');
    if (!c) throw new Error('no movie case');
    const { sessionId, mediaId } = await seed(owner, c.link, c.play);
    await db.execute(
      sql`UPDATE media SET imdb_id = 'tt0285331', tmdb_id = 46952 WHERE id = ${mediaId}::uuid`
    );

    await fullRun();

    const after = await stateOf(sessionId);
    expect(after.media_id).not.toBe(mediaId);
    expect(after.imdb_id).toBeNull();
    if (after.media_id) expect((await linkOf(sessionId)).media).toBe(c.play.title);
  });

  it('resumes after stopping between steps', async () => {
    const stopped = await account('plex');
    const straight = await account('plex');
    const pairs = [];
    for (const c of numbersCases) {
      pairs.push({
        stopped: (await seed(stopped, c.link, c.play)).sessionId,
        straight: (await seed(straight, c.link, c.play)).sessionId,
      });
    }

    expect((await unlinkByRule([stopped.serverId], null, LIMIT)).count).toBe(numbersCases.length);
    await unlinkFoldPairs([stopped.serverId], null, LIMIT);
    await fullRun();

    for (const pair of pairs) {
      expect(await linkOf(pair.stopped)).toEqual(await linkOf(pair.straight));
      expect((await logOf(pair.stopped))[0]?.relinked_at).not.toBeNull();
      expect((await logOf(pair.straight))[0]?.relinked_at).not.toBeNull();
    }
  });

  it('never relinks a play to the media it was unlinked from', async () => {
    const owner = await account('plex');
    const outOfScope = await account('jellyfin');
    const blacklist = await insertMedia({
      mediaType: 'show',
      matchKey: `show:local:${randomUUID()}`,
      title: 'The Blacklist',
    });
    const play: KeyedPlay = {
      mediaType: 'episode',
      grandparentTitle: 'SpongeBob SquarePants',
      seasonNumber: 12,
      episodeNumber: 22,
      title: 'Big Bad Bubble Bass',
      year: null,
      guid: null,
    };
    const folded = await insertMedia({
      mediaType: 'episode',
      matchKey: `episode:${blacklist}:s12e22`,
      title: 'Big Bad Bubble Bass',
      showMediaId: blacklist,
    });
    const sessionId = await importedPlay(owner, play, folded, blacklist);
    // A play the repair never touches keeps the title folded onto the wrong show.
    await importedPlay(outOfScope, play, folded, blacklist);
    await db.execute(sql`
      INSERT INTO session_link_repairs (session_id, started_at, repair_version, server_id, clause,
        grandparent_title, show_media_id)
      VALUES (${randomUUID()}::uuid, now(), ${IMPORTED_LINK_REPAIR_VERSION}, ${owner.serverId}::uuid,
        'numbers', 'SpongeBob SquarePants', ${blacklist}::uuid)
    `);

    expect(await fullRun()).toMatchObject({ foldUnlinked: 1, relinked: 0 });

    expect(await stateOf(sessionId)).toMatchObject(cleared);
    expect((await logOf(sessionId))[0]?.relinked_at).toBeNull();
  });

  it('does not relink under a show with another title', async () => {
    const owner = await account('plex');
    const outOfScope = await account('jellyfin');
    const c = numbersCases[0];
    if (!c) throw new Error('no numbers case');
    const { sessionId, mediaId, showId } = await seed(owner, c.link, c.play);
    // A play the repair never touches keeps the title folded onto The Blacklist.
    await importedPlay(outOfScope, c.play, mediaId, showId);

    expect(await fullRun()).toMatchObject({ unlinked: 1, relinked: 0 });

    expect(await stateOf(sessionId)).toMatchObject(cleared);
    expect((await logOf(sessionId))[0]?.relinked_at).toBeNull();
  });

  it('relinks a row unlinked again after its relink', async () => {
    const owner = await account('plex');
    const c = numbersCases[0];
    if (!c) throw new Error('no numbers case');
    const { sessionId, mediaId, showId } = await seed(owner, c.link, c.play);
    await fullRun();
    const [first] = await logOf(sessionId);

    await db.execute(sql`
      UPDATE sessions SET media_id = ${mediaId}::uuid, show_media_id = ${showId}::uuid
      WHERE id = ${sessionId}::uuid
    `);
    expect((await unlinkByRule([owner.serverId], null, LIMIT)).count).toBe(1);
    expect(await logOf(sessionId)).toEqual([{ ...first, relinked_at: null }]);

    expect((await fullRun()).relinked).toBe(1);
    expect((await linkOf(sessionId)).show).toBe(c.play.grandparentTitle);
  });

  it('refreshes the daily aggregate from the oldest repaired play', async () => {
    const owner = await account('plex');
    const startedAt = new Date(Date.now() - 30 * 86_400_000);
    const blacklistShows: string[] = [];
    for (const c of numbersCases) {
      const { sessionId, showId } = await seed(owner, c.link, c.play, startedAt);
      if (showId) blacklistShows.push(showId);
      await db.execute(sql`
        UPDATE sessions SET duration_ms = 1200000, total_duration_ms = 1300000,
          progress_ms = 1200000, watched = true, stopped_at = started_at + interval '20 minutes'
        WHERE id = ${sessionId}::uuid
      `);
    }
    await db.execute(
      sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
    );
    const underBlacklist = async () =>
      (
        (
          await db.execute(sql`
            SELECT count(*)::int AS n FROM user_media_plays_daily
            WHERE show_media_id = ANY(${sql.param(blacklistShows)}::uuid[])
          `)
        ).rows[0] as { n: number }
      ).n;
    expect(await underBlacklist()).toBe(numbersCases.length);

    await processImportedLinkRepairJob(repairJob('auto'));

    expect(await underBlacklist()).toBe(0);
    expect(await getSetting('importedLinkRepair')).toMatchObject({
      version: IMPORTED_LINK_REPAIR_VERSION,
      refreshFrom: null,
      breaker: null,
    });
  });

  it('refreshes from the stored start after a run stopped after unlinking', async () => {
    const owner = await account('plex');
    const c = numbersCases[0];
    if (!c) throw new Error('no numbers case');
    const older = new Date(Date.now() - 40 * 86_400_000);
    const unplaceable = await seed(
      owner,
      {
        mediaType: 'episode',
        title: 'Kings of the Highway',
        year: 2015,
        showTitle: 'The Blacklist',
        numbers: [],
      },
      {
        mediaType: 'episode',
        grandparentTitle: 'SpongeBob SquarePants',
        seasonNumber: null,
        episodeNumber: null,
        title: 'The Krusty Slammer',
        year: 2019,
        guid: null,
      },
      older
    );
    const placeable = await seed(owner, c.link, c.play, new Date(Date.now() - 10 * 86_400_000));

    gate.failResolve = true;
    await expect(processImportedLinkRepairJob(repairJob('auto'))).rejects.toThrow(
      'resolver unavailable'
    );
    expect((await stateOf(unplaceable.sessionId)).media_id).toBeNull();
    const { refreshFrom } = await getSetting('importedLinkRepair');
    expect(refreshFrom && new Date(refreshFrom).getTime()).toBe(older.getTime());

    gate.failResolve = false;
    gate.refreshes = [];
    const result = await processImportedLinkRepairJob(repairJob('auto'));

    expect(result).toMatchObject({ success: true, updated: 1 });
    expect((await linkOf(placeable.sessionId)).show).toBe(c.play.grandparentTitle);
    expect(gate.refreshes.length).toBeGreaterThan(0);
    expect(gate.refreshes.every((r) => r.start.getTime() === older.getTime())).toBe(true);
    expect((await getSetting('importedLinkRepair')).refreshFrom).toBeNull();
  });

  it('stores the refresh start before the unlink transaction opens', async () => {
    const owner = await account('plex');
    const c = numbersCases[0];
    if (!c) throw new Error('no numbers case');
    const startedAt = new Date(Date.now() - 20 * 86_400_000);
    const { sessionId, mediaId } = await seed(owner, c.link, c.play, startedAt);
    await db.execute(sql`
      CREATE FUNCTION fail_repair_log() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'repair log unavailable'; END $$
    `);
    await db.execute(sql`
      CREATE TRIGGER fail_repair_log BEFORE INSERT ON session_link_repairs
        FOR EACH ROW EXECUTE FUNCTION fail_repair_log()
    `);
    try {
      await expect(processImportedLinkRepairJob(repairJob('auto'))).rejects.toThrow();
    } finally {
      await db.execute(sql`DROP TRIGGER fail_repair_log ON session_link_repairs`);
      await db.execute(sql`DROP FUNCTION fail_repair_log()`);
    }

    expect((await stateOf(sessionId)).media_id).toBe(mediaId);
    expect(await logCount()).toBe(0);
    const { refreshFrom } = await getSetting('importedLinkRepair');
    expect(refreshFrom && new Date(refreshFrom).getTime()).toBe(startedAt.getTime());
  });

  it('counts automatic runs when they start and never manual ones', async () => {
    const owner = await account('plex');
    const c = numbersCases[0];
    if (!c) throw new Error('no numbers case');
    await seed(owner, c.link, c.play);
    const attempts = async () => {
      resetSettingsCache();
      return (await getSetting('importedLinkRepair')).autoAttempts;
    };

    gate.failResolve = true;
    await expect(processImportedLinkRepairJob(repairJob('manual'))).rejects.toThrow();
    expect(await attempts()).toBe(0);
    await expect(processImportedLinkRepairJob(repairJob('auto'))).rejects.toThrow();
    expect(await attempts()).toBe(1);

    // Held inside the walk, before any outcome: the run already counts.
    gate.failResolve = false;
    let release = () => {};
    gate.hold = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (gate.reached = resolve));
    const held = processImportedLinkRepairJob(repairJob('auto'));
    await reached;
    expect(await attempts()).toBe(2);
    gate.hold = null;
    release();
    await held;

    await processImportedLinkRepairJob(repairJob('manual'));
    expect(await attempts()).toBe(2);
  });

  it('a run with nothing new refreshes no aggregate', async () => {
    const owner = await account('plex');
    for (const c of numbersCases) await seed(owner, c.link, c.play);
    await processImportedLinkRepairJob(repairJob('manual'));
    expect(gate.refreshes.length).toBeGreaterThan(0);

    gate.refreshes = [];
    const again = await processImportedLinkRepairJob(repairJob('manual'));

    expect(again).toMatchObject({ success: true, updated: 0 });
    expect(gate.refreshes).toEqual([]);
  });

  it('a second run changes nothing', async () => {
    const owner = await account('plex');
    for (const c of REPAIR_CASES) await seed(owner, c.link, c.play);
    // Without numbers an episode never names a show, so the resolver cannot place it.
    const unplaceable = await seed(
      owner,
      {
        mediaType: 'episode',
        title: 'Kings of the Highway',
        year: 2015,
        showTitle: 'The Blacklist',
        numbers: [],
      },
      {
        mediaType: 'episode',
        grandparentTitle: 'SpongeBob SquarePants',
        seasonNumber: null,
        episodeNumber: null,
        title: 'The Krusty Slammer',
        year: 2019,
        guid: null,
      }
    );
    expect((await fullRun()).relinked).toBeGreaterThan(0);
    expect((await stateOf(unplaceable.sessionId)).media_id).toBeNull();
    expect((await logOf(unplaceable.sessionId))[0]?.relinked_at).toBeNull();
    const before = await rowVersions();

    expect(await fullRun()).toMatchObject({ unlinked: 0, foldUnlinked: 0, relinked: 0 });

    expect(await rowVersions()).toEqual(before);
  });

  it(
    'the automatic run honors the breaker and the manual run does not',
    { timeout: 120_000 },
    async () => {
      const owner = await account('plex');
      const candidate = numbersCases[0];
      const kept = REPAIR_CASES.find((c) => c.clause === null);
      if (!candidate || !kept) throw new Error('missing cases');
      const copies = async (sessionId: string, n: number) =>
        db.execute(sql`
          INSERT INTO sessions
          SELECT (jsonb_populate_record(s, jsonb_build_object(
            'id', gen_random_uuid(),
            'started_at', s.started_at - g * interval '1 minute',
            'external_session_id', 'tautulli-' || gen_random_uuid()))).*
          FROM sessions s, generate_series(1, ${n}::int) g
          WHERE s.id = ${sessionId}::uuid
        `);
      const bad = await seed(owner, candidate.link, candidate.play);
      await copies(bad.sessionId, 500);
      const good = await seed(owner, kept.link, kept.play);
      await copies(good.sessionId, 98);
      const onBlacklist = async () =>
        (
          (
            await db.execute(sql`
              SELECT count(*)::int AS n FROM sessions
              WHERE server_id = ${owner.serverId}::uuid AND media_id = ${bad.mediaId}::uuid
            `)
          ).rows[0] as { n: number }
        ).n;

      const auto = await processImportedLinkRepairJob(repairJob('auto'));

      expect(auto.success).toBe(true);
      expect(await onBlacklist()).toBe(501);
      expect(await logCount()).toBe(0);
      expect(await getSetting('importedLinkRepair')).toMatchObject({
        version: IMPORTED_LINK_REPAIR_VERSION,
        breaker: { servers: [{ serverId: owner.serverId, candidates: 501, linked: 600 }] },
      });

      await processImportedLinkRepairJob(repairJob('manual'));

      expect(await onBlacklist()).toBe(0);
      expect(await logCount()).toBe(501);
      expect((await linkOf(bad.sessionId)).show).toBe(candidate.play.grandparentTitle);
      expect((await getSetting('importedLinkRepair')).breaker).toBeNull();
    }
  );

  it('takes the heavy-ops lock', { timeout: 60_000 }, async () => {
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6380';
    const redis = new Redis(redisUrl);
    await initHeavyOpsLock(redis);
    initMaintenanceQueue(redisUrl);
    await obliterateMaintenanceQueue();
    startMaintenanceWorker();
    try {
      const owner = await account('plex');
      const c = numbersCases[0];
      if (!c) throw new Error('no numbers case');
      await seed(owner, c.link, c.play);
      let release = () => {};
      gate.hold = new Promise<void>((resolve) => (release = resolve));
      const reached = new Promise<void>((resolve) => (gate.reached = resolve));

      const jobId = await enqueueMaintenanceJob('repair_imported_links', 'owner');
      await reached;

      await expect(
        acquireHeavyOpsLock('maintenance', 'another-job', 'Another job', randomUUID())
      ).resolves.toMatchObject({
        jobType: 'maintenance',
        jobId,
        description: 'Imported Plex link repair',
      });

      gate.hold = null;
      release();
      await vi.waitFor(
        async () => expect((await getMaintenanceJobStatus(jobId))?.state).toBe('completed'),
        { timeout: 30_000, interval: 200 }
      );
    } finally {
      gate.hold = null;
      await obliterateMaintenanceQueue();
      await shutdownMaintenanceQueue();
      redis.disconnect();
    }
  });
});
