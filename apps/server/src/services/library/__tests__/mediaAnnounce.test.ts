/**
 * The library-sync diff behind the two media triggers: which rows count as added,
 * which count as an upgrade, and how many of them one sync run may announce.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaQuality } from '../../automations/types.js';

const mockMediaListeners = vi.fn();
const mockDispatchMediaAdded = vi.fn();
const mockDispatchMediaUpgraded = vi.fn();
vi.mock('../../automations/events/producers.js', () => ({
  mediaListeners: (...args: unknown[]) => mockMediaListeners(...args),
  dispatchMediaAdded: (...args: unknown[]) => mockDispatchMediaAdded(...args),
  dispatchMediaUpgraded: (...args: unknown[]) => mockDispatchMediaUpgraded(...args),
}));

import {
  MEDIA_ANNOUNCE_CAP,
  collapseMediaChanges,
  collectMediaChanges,
  createAnnounceRun,
  createMediaAnnounce,
  diffMediaChanges,
  flushMediaAnnounceRun,
  type CollectedChange,
  type MediaAnnounceRun,
  type PriorMediaRow,
  type SyncedMediaRow,
} from '../mediaAnnounce.js';

const server = { id: 'server-1', name: 'Basement', type: 'plex' as const };
const firstSeen = new Date('2026-08-21T12:00:00Z');
const earlier = new Date('2026-01-01T00:00:00Z');

const quality = (overrides: Partial<MediaQuality> = {}): MediaQuality => ({
  resolution: '1080p',
  dynamicRange: 'sdr',
  videoCodec: 'H264',
  audioCodec: 'AC3',
  audioChannels: 6,
  fileSize: 8_000_000_000,
  ...overrides,
});

const synced = (overrides: Partial<SyncedMediaRow> = {}): SyncedMediaRow => ({
  id: 'item-1',
  ratingKey: 'rk-1',
  mediaId: null,
  firstSeenAt: earlier,
  title: 'Cars',
  grandparentTitle: null,
  parentTitle: null,
  grandparentRatingKey: null,
  parentRatingKey: null,
  parentIndex: null,
  itemIndex: null,
  mediaType: 'movie',
  year: 2006,
  imdbId: null,
  tmdbId: null,
  tvdbId: null,
  thumbPath: null,
  quality: quality(),
  ...overrides,
});

const collectedOf = (rows: SyncedMediaRow[]): CollectedChange[] =>
  rows.map((row) => ({
    change: { kind: 'added' as const, row },
    libraryId: '1',
    libraryName: 'Shows',
  }));

const priorOf = (rows: Array<[string, PriorMediaRow]>) => new Map(rows);

const both = { added: true, upgraded: true };

describe('diffMediaChanges', () => {
  it('reads a row first seen in this call as an addition', () => {
    const rows = [synced({ firstSeenAt: firstSeen })];

    const { changes } = diffMediaChanges({
      rows,
      prior: priorOf([]),
      firstSeen,
      budget: 10,
      listening: both,
    });

    expect(changes).toEqual([{ kind: 'added', row: rows[0] }]);
  });

  it('reads a changed quality column as an upgrade and names the fields that moved', () => {
    const rows = [synced({ quality: quality({ resolution: '4k', fileSize: 40_000_000_000 }) })];
    const prior = priorOf([['rk-1', { quality: quality() }]]);

    const { changes } = diffMediaChanges({ rows, prior, firstSeen, budget: 10, listening: both });

    expect(changes).toEqual([
      {
        kind: 'upgraded',
        row: rows[0],
        from: quality(),
        changed: ['resolution', 'fileSize'],
      },
    ]);
  });

  it('announces a drop too: the trigger is named for the common case', () => {
    const rows = [synced({ quality: quality({ resolution: '720p' }) })];
    const prior = priorOf([['rk-1', { quality: quality() }]]);

    const { changes } = diffMediaChanges({ rows, prior, firstSeen, budget: 10, listening: both });

    expect(changes[0]).toMatchObject({ kind: 'upgraded', changed: ['resolution'] });
  });

  it('ignores a column arriving and a column disappearing', () => {
    const appeared = [synced({ quality: quality({ dynamicRange: 'hdr10' }) })];
    const appearedPrior = priorOf([['rk-1', { quality: quality({ dynamicRange: null }) }]]);
    expect(
      diffMediaChanges({
        rows: appeared,
        prior: appearedPrior,
        firstSeen,
        budget: 10,
        listening: both,
      }).changes
    ).toEqual([]);

    const vanished = [synced({ quality: quality({ dynamicRange: null }) })];
    const vanishedPrior = priorOf([['rk-1', { quality: quality({ dynamicRange: 'hdr10' }) }]]);
    expect(
      diffMediaChanges({
        rows: vanished,
        prior: vanishedPrior,
        firstSeen,
        budget: 10,
        listening: both,
      }).changes
    ).toEqual([]);
  });

  it('says nothing about an identical signature or a revived tombstone', () => {
    const rows = [synced()];
    const prior = priorOf([['rk-1', { quality: quality() }]]);

    expect(
      diffMediaChanges({ rows, prior, firstSeen, budget: 10, listening: both }).changes
    ).toEqual([]);
  });

  it('stops at the budget and counts what it dropped', () => {
    const rows = Array.from({ length: MEDIA_ANNOUNCE_CAP + 1 }, (_, index) =>
      synced({ id: `item-${index}`, ratingKey: `rk-${index}`, firstSeenAt: firstSeen })
    );

    const { changes, suppressed } = diffMediaChanges({
      rows,
      prior: priorOf([]),
      firstSeen,
      budget: MEDIA_ANNOUNCE_CAP,
      listening: both,
    });

    expect(changes).toHaveLength(MEDIA_ANNOUNCE_CAP);
    expect(suppressed).toBe(1);
  });
});

describe('createMediaAnnounce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMediaListeners.mockResolvedValue(both);
  });

  it('announces nothing on a first sync, and never probes the library when nothing listens', async () => {
    const isFirstSync = vi.fn().mockResolvedValue(true);
    const run = createAnnounceRun(server);

    expect(await createMediaAnnounce({ run, libraryName: 'Movies', isFirstSync })).toBeNull();
    expect(isFirstSync).toHaveBeenCalledOnce();

    mockMediaListeners.mockResolvedValue({ added: false, upgraded: false });
    expect(await createMediaAnnounce({ run, libraryName: 'Movies', isFirstSync })).toBeNull();
    expect(isFirstSync).toHaveBeenCalledOnce();
  });

  it('shares one budget across every library of the run', async () => {
    const run = createAnnounceRun(server);
    const isFirstSync = vi.fn().mockResolvedValue(false);

    const movies = await createMediaAnnounce({ run, libraryName: 'Movies', isFirstSync });
    const shows = await createMediaAnnounce({ run, libraryName: 'Shows', isFirstSync });

    expect(movies?.libraryName).toBe('Movies');
    expect(shows?.budget).toBe(movies?.budget);
    expect(run.budget.remaining).toBe(MEDIA_ANNOUNCE_CAP);
  });
});

describe('collectMediaChanges and flushMediaAnnounceRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const runWith = (remaining: number): MediaAnnounceRun => ({
    server,
    budget: { remaining, suppressed: 0 },
    collected: [],
  });

  const announceFor = (run: MediaAnnounceRun, listening = both) => ({
    server,
    libraryName: 'Movies',
    budget: run.budget,
    run,
    listening,
  });

  it('holds changes until the run flushes', () => {
    const run = runWith(2);

    collectMediaChanges({
      announce: announceFor(run),
      libraryId: '1',
      rows: [synced({ firstSeenAt: firstSeen })],
      prior: priorOf([]),
      firstSeen,
    });

    expect(mockDispatchMediaAdded).not.toHaveBeenCalled();
    expect(run.collected).toHaveLength(1);
  });

  it('dispatches one event per change and spends the run budget', async () => {
    const run = runWith(2);
    const rows = [
      synced({ firstSeenAt: firstSeen }),
      synced({ id: 'item-2', ratingKey: 'rk-2', quality: quality({ resolution: '4k' }) }),
      synced({ id: 'item-3', ratingKey: 'rk-3', firstSeenAt: firstSeen }),
    ];
    const prior = priorOf([
      ['rk-2', { quality: quality() }],
      ['rk-3', { quality: quality() }],
    ]);

    collectMediaChanges({ announce: announceFor(run), libraryId: '1', rows, prior, firstSeen });
    await flushMediaAnnounceRun(run);

    expect(mockDispatchMediaAdded).toHaveBeenCalledWith({
      server,
      media: expect.objectContaining({
        libraryItemId: 'item-1',
        ratingKey: 'rk-1',
        title: 'Cars',
        type: 'movie',
        year: 2006,
        libraryId: '1',
        libraryName: 'Movies',
        quality: quality(),
      }),
    });
    expect(mockDispatchMediaUpgraded).toHaveBeenCalledWith({
      server,
      media: expect.objectContaining({ libraryItemId: 'item-2' }),
      from: quality(),
      changed: ['resolution'],
    });
    expect(run.budget).toEqual({ remaining: 0, suppressed: 1 });
  });

  it('spends no slot on an upgrade nothing listens for', async () => {
    const run = runWith(1);
    const rows = [
      synced({ quality: quality({ resolution: '4k' }) }),
      synced({ id: 'item-2', ratingKey: 'rk-2', firstSeenAt: firstSeen }),
    ];
    const prior = priorOf([['rk-1', { quality: quality() }]]);

    collectMediaChanges({
      announce: announceFor(run, { added: true, upgraded: false }),
      libraryId: '1',
      rows,
      prior,
      firstSeen,
    });
    await flushMediaAnnounceRun(run);

    expect(mockDispatchMediaUpgraded).not.toHaveBeenCalled();
    expect(mockDispatchMediaAdded).toHaveBeenCalledWith(
      expect.objectContaining({ media: expect.objectContaining({ libraryItemId: 'item-2' }) })
    );
    expect(run.budget).toEqual({ remaining: 0, suppressed: 0 });
  });

  it('dispatches nothing once the budget is spent', async () => {
    const run = runWith(0);

    collectMediaChanges({
      announce: announceFor(run),
      libraryId: '1',
      rows: [synced({ firstSeenAt: firstSeen })],
      prior: priorOf([]),
      firstSeen,
    });
    await flushMediaAnnounceRun(run);

    expect(mockDispatchMediaAdded).not.toHaveBeenCalled();
    expect(run.budget).toEqual({ remaining: 0, suppressed: 1 });
  });

  it('carries the episode count a season absorbed onto the dispatched subject', async () => {
    const run = runWith(MEDIA_ANNOUNCE_CAP);
    const season = synced({
      id: 'season-1',
      ratingKey: 'season-rk',
      firstSeenAt: firstSeen,
      title: 'Season 1',
      mediaType: 'season',
      parentTitle: 'Murderbot',
      parentRatingKey: 'show-rk',
      parentIndex: 1,
    });
    const episodes = [1, 2].map((n) =>
      synced({
        id: `ep-${String(n)}`,
        ratingKey: `ep-rk-${String(n)}`,
        firstSeenAt: firstSeen,
        title: `Episode ${String(n)}`,
        mediaType: 'episode',
        grandparentTitle: 'Murderbot',
        grandparentRatingKey: 'show-rk',
        parentRatingKey: 'season-rk',
        parentIndex: 1,
        itemIndex: n,
      })
    );

    collectMediaChanges({
      announce: announceFor(run),
      libraryId: '1',
      rows: [...episodes, season],
      prior: priorOf([]),
      firstSeen,
    });
    await flushMediaAnnounceRun(run);

    expect(mockDispatchMediaAdded).toHaveBeenCalledOnce();
    expect(mockDispatchMediaAdded).toHaveBeenCalledWith({
      server,
      media: expect.objectContaining({ ratingKey: 'season-rk', addedEpisodeCount: 2 }),
    });
  });
});

describe('collapseMediaChanges', () => {
  const season = (overrides: Partial<SyncedMediaRow> = {}) =>
    synced({
      id: 'season-1',
      ratingKey: 'season-rk',
      title: 'Season 1',
      mediaType: 'season',
      parentTitle: 'Murderbot',
      parentRatingKey: 'show-rk',
      parentIndex: 1,
      ...overrides,
    });

  const episode = (n: number, overrides: Partial<SyncedMediaRow> = {}) =>
    synced({
      id: `ep-${String(n)}`,
      ratingKey: `ep-rk-${String(n)}`,
      title: `Episode ${String(n)}`,
      mediaType: 'episode',
      grandparentTitle: 'Murderbot',
      grandparentRatingKey: 'show-rk',
      parentRatingKey: 'season-rk',
      parentIndex: 1,
      itemIndex: n,
      ...overrides,
    });

  it("folds a season's episodes into it as a count", () => {
    const { announced, absorbed } = collapseMediaChanges(
      collectedOf([episode(1), episode(2), episode(3), season()])
    );

    expect(absorbed).toBe(3);
    expect(announced).toHaveLength(1);
    expect(announced[0]?.addedEpisodeCount).toBe(3);
    expect(announced[0]?.collected.change.row.ratingKey).toBe('season-rk');
  });

  it('matches episodes to a season by show and season number when the season key is missing', () => {
    const legacy = episode(1, { parentRatingKey: null });

    const { announced, absorbed } = collapseMediaChanges(collectedOf([legacy, season()]));

    expect(absorbed).toBe(1);
    expect(announced[0]?.addedEpisodeCount).toBe(1);
  });

  it('leaves an episode alone when its season was not added in the same run', () => {
    const { announced, absorbed } = collapseMediaChanges(collectedOf([episode(4)]));

    expect(absorbed).toBe(0);
    expect(announced).toHaveLength(1);
    expect(announced[0]?.addedEpisodeCount).toBeUndefined();
    expect(announced[0]?.collected.change.row.ratingKey).toBe('ep-rk-4');
  });

  it('drops a show whose seasons are announcing, since those name it anyway', () => {
    const show = synced({
      id: 'show-1',
      ratingKey: 'show-rk',
      title: 'Murderbot',
      mediaType: 'show',
    });

    const { announced } = collapseMediaChanges(collectedOf([show, season(), episode(1)]));

    expect(announced).toHaveLength(1);
    expect(announced[0]?.collected.change.row.ratingKey).toBe('season-rk');
  });

  it('announces a season with no episodes of its own as a count of zero', () => {
    const { announced } = collapseMediaChanges(collectedOf([season()]));

    expect(announced).toHaveLength(1);
    expect(announced[0]?.addedEpisodeCount).toBe(0);
  });

  it('keeps a movie untouched', () => {
    const { announced, absorbed } = collapseMediaChanges(collectedOf([synced()]));

    expect(absorbed).toBe(0);
    expect(announced).toHaveLength(1);
    expect(announced[0]?.addedEpisodeCount).toBeUndefined();
  });
});
