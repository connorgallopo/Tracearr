import { describe, it, expect } from 'vitest';
import type {
  JellystatLibraryEpisode,
  JellystatLibraryItem,
  JellystatPlaybackActivity,
  JellystatPluginRow,
} from '@tracearr/shared';
import {
  buildJellystatRemapIndex,
  chooseJellystatItemKey,
  isImportedEpisodeRowRewritten,
  isRemapVetoed,
  resolveJellystatItemKey,
} from '../jellystatRemapVeto.js';

function activity(overrides: Partial<JellystatPlaybackActivity> = {}): JellystatPlaybackActivity {
  return {
    Id: 'activity-1',
    UserId: 'user-1',
    NowPlayingItemId: 'movie-new',
    NowPlayingItemName: 'Godzilla',
    SeriesName: null,
    EpisodeId: null,
    PlaybackDuration: '100',
    ActivityDateInserted: '2024-01-01T00:00:00.000Z',
    imported: false,
    ...overrides,
  };
}

function item(overrides: Partial<JellystatLibraryItem> = {}): JellystatLibraryItem {
  return { Id: 'movie-new', Name: 'Godzilla', ProductionYear: 2014, archived: false, ...overrides };
}

function episode(overrides: Partial<JellystatLibraryEpisode> = {}): JellystatLibraryEpisode {
  return {
    EpisodeId: 'ep-new',
    SeriesId: 'series-us',
    Name: 'Pilot',
    SeriesName: 'The Office',
    ParentIndexNumber: 1,
    IndexNumber: 1,
    archived: false,
    ...overrides,
  };
}

function episodeActivity(overrides: Partial<JellystatPlaybackActivity> = {}) {
  return activity({
    NowPlayingItemId: 'series-us',
    NowPlayingItemName: 'Pilot',
    SeriesName: 'The Office',
    EpisodeId: 'ep-new',
    ...overrides,
  });
}

const SERIES_US = item({ Id: 'series-us', Name: 'The Office', ProductionYear: 2005 });

function episodeIndex(
  archivedOriginal: Partial<JellystatLibraryEpisode>,
  seriesItems: JellystatLibraryItem[] = [SERIES_US]
) {
  const episodes = [
    episode(),
    episode({ EpisodeId: 'ep-old', archived: true, ...archivedOriginal }),
  ];
  return buildJellystatRemapIndex(seriesItems, episodes, null);
}

describe('chooseJellystatItemKey', () => {
  it('uses the plugin ItemId for a plugin-origin row even when NowPlayingItemId differs', () => {
    const pluginRows: JellystatPluginRow[] = [{ rowid: 42, ItemId: 'plugin-original' }];
    const index = buildJellystatRemapIndex([], [], pluginRows);

    const choice = chooseJellystatItemKey(
      activity({ Id: '42', imported: true, NowPlayingItemId: 'remapped-id' }),
      index
    );

    expect(choice).toEqual({ candidates: ['plugin-original'], source: 'plugin', checked: true });
  });

  it('keys an Emby-shaped concatenated imported row on NowPlayingItemId only, checked when the backup has episodes', () => {
    const index = buildJellystatRemapIndex(
      [item({ Id: '12', Name: 'Show', ProductionYear: 2010 })],
      [episode({ EpisodeId: '12345', SeriesId: '12', SeriesName: 'Show' })],
      null
    );
    const play = episodeActivity({
      Id: '42',
      imported: true,
      NowPlayingItemId: '12',
      SeasonId: '345',
      EpisodeId: '12345',
    });

    expect(chooseJellystatItemKey(play, index)).toEqual({
      candidates: ['12'],
      source: 'native',
      checked: true,
    });
    expect(chooseJellystatItemKey(play, buildJellystatRemapIndex([], null, null))).toEqual({
      candidates: ['12'],
      source: 'native',
      checked: false,
    });
  });

  it('treats a plugin-origin row with no plugin table row as native', () => {
    const pluginRows: JellystatPluginRow[] = [{ rowid: 7, ItemId: 'other' }];
    const index = buildJellystatRemapIndex([], null, pluginRows);

    const choice = chooseJellystatItemKey(
      activity({ Id: '42', imported: true, NowPlayingItemId: 'movie-new' }),
      index
    );

    expect(choice).toEqual({ candidates: ['movie-new'], source: 'native', checked: true });
  });
});

describe('isRemapVetoed for items', () => {
  it('vetoes a movie with an archived same-name item of a different year', () => {
    const index = buildJellystatRemapIndex(
      [item(), item({ Id: 'movie-old', ProductionYear: 1954, archived: true })],
      null,
      null
    );

    expect(isRemapVetoed(activity(), 'movie-new', false, index)).toBe(true);
  });

  it('does not veto when the archived same-name item has the same year', () => {
    const index = buildJellystatRemapIndex(
      [item(), item({ Id: 'movie-old', ProductionYear: 2014, archived: true })],
      null,
      null
    );

    expect(isRemapVetoed(activity(), 'movie-new', false, index)).toBe(false);
  });

  it('vetoes when a year is missing', () => {
    const index = buildJellystatRemapIndex(
      [item(), item({ Id: 'movie-old', ProductionYear: null, archived: true })],
      null,
      null
    );

    expect(isRemapVetoed(activity(), 'movie-new', false, index)).toBe(true);
  });

  it('does not veto without an archived same-name item', () => {
    const index = buildJellystatRemapIndex(
      [item(), item({ Id: 'movie-old', Name: 'Mothra', ProductionYear: 1961, archived: true })],
      null,
      null
    );

    expect(isRemapVetoed(activity(), 'movie-new', false, index)).toBe(false);
  });

  it('never vetoes on a non-archived same-name item', () => {
    const index = buildJellystatRemapIndex(
      [item(), item({ Id: 'movie-other', ProductionYear: 1954, archived: false })],
      null,
      null
    );

    expect(isRemapVetoed(activity(), 'movie-new', false, index)).toBe(false);
  });

  it('vetoes an audio play with an archived same-name item of a different year', () => {
    const index = buildJellystatRemapIndex(
      [
        item({ Id: 'track-new', Name: 'Intro', ProductionYear: 2019 }),
        item({ Id: 'track-old', Name: 'Intro', ProductionYear: 2009, archived: true }),
      ],
      null,
      null
    );
    const audio = activity({ NowPlayingItemId: 'track-new', NowPlayingItemName: 'Intro' });

    expect(isRemapVetoed(audio, 'track-new', false, index)).toBe(true);
  });

  it('vetoes a play whose id does not resolve in library_items yet', () => {
    const index = buildJellystatRemapIndex(
      [item(), item({ Id: 'movie-old', ProductionYear: 1954, archived: true })],
      null,
      null
    );
    const play = activity();
    const choice = chooseJellystatItemKey(play, index);
    const { ratingKey, identity } = resolveJellystatItemKey(choice, new Map());

    expect(identity).toBeUndefined();
    expect(ratingKey).toBe('movie-new');
    expect(isRemapVetoed(play, ratingKey, false, index)).toBe(true);
  });
});

describe('isRemapVetoed for episodes', () => {
  it('vetoes an episode with an archived same-name same-series episode in a different slot', () => {
    const index = episodeIndex({ ParentIndexNumber: 2, IndexNumber: 1 });

    expect(isRemapVetoed(episodeActivity(), 'ep-new', true, index)).toBe(true);
  });

  it('does not veto an archived same-name same-series episode in the same slot', () => {
    const index = episodeIndex({ ParentIndexNumber: 1, IndexNumber: 1 });

    expect(isRemapVetoed(episodeActivity(), 'ep-new', true, index)).toBe(false);
  });

  it('vetoes when an index number is missing', () => {
    const index = episodeIndex({ ParentIndexNumber: 1, IndexNumber: null });

    expect(isRemapVetoed(episodeActivity(), 'ep-new', true, index)).toBe(true);
  });

  it('vetoes the same slot when the two series rows differ in ProductionYear', () => {
    const index = episodeIndex({ SeriesId: 'series-uk', ParentIndexNumber: 1, IndexNumber: 1 }, [
      SERIES_US,
      item({ Id: 'series-uk', Name: 'The Office', ProductionYear: 2001, archived: true }),
    ]);

    expect(isRemapVetoed(episodeActivity(), 'ep-new', true, index)).toBe(true);
  });

  it('vetoes when a stale row for the target EpisodeId sits in another slot, in either order', () => {
    const current = episode();
    const stale = episode({ ParentIndexNumber: 2 });
    const original = episode({ EpisodeId: 'ep-old', archived: true });

    for (const episodes of [
      [current, stale, original],
      [stale, current, original],
    ]) {
      const index = buildJellystatRemapIndex([SERIES_US], episodes, null);
      expect(isRemapVetoed(episodeActivity(), 'ep-new', true, index)).toBe(true);
    }
  });

  it('vetoes a native episode play with a null SeriesName', () => {
    const index = buildJellystatRemapIndex([SERIES_US], [episode()], null);

    expect(isRemapVetoed(episodeActivity({ SeriesName: null }), 'ep-new', true, index)).toBe(true);
  });

  it('skips name evidence for an untouched 093-form imported row', () => {
    const index = episodeIndex({ ParentIndexNumber: 2, IndexNumber: 1 });
    const play = episodeActivity({ Id: '42', imported: true, NowPlayingItemId: 'ep-new' });

    expect(isRemapVetoed(play, 'ep-new', true, index)).toBe(false);
  });

  it('counts an archived same-name episode with a null SeriesName as evidence', () => {
    const index = episodeIndex({ SeriesName: null, ParentIndexNumber: 3, IndexNumber: 1 });

    expect(isRemapVetoed(episodeActivity(), 'ep-new', true, index)).toBe(true);
  });
});

describe('isImportedEpisodeRowRewritten', () => {
  const index = buildJellystatRemapIndex([SERIES_US], [episode()], null);

  function importedEpisode(overrides: Partial<JellystatPlaybackActivity>) {
    const play = episodeActivity({ Id: '42', imported: true, SeasonId: 'season-1', ...overrides });
    return { play, choice: chooseJellystatItemKey(play, index) };
  }

  it('flags a remapped imported row keyed on the series id with a real EpisodeId', () => {
    const { play, choice } = importedEpisode({
      NowPlayingItemId: 'series-us',
      EpisodeId: 'ep-new',
    });

    expect(isImportedEpisodeRowRewritten(play, choice)).toBe(true);
  });

  it('does not flag an untouched 093-form row', () => {
    const { play, choice } = importedEpisode({ NowPlayingItemId: 'ep-new', EpisodeId: 'ep-new' });

    expect(isImportedEpisodeRowRewritten(play, choice)).toBe(false);
  });

  it('does not flag an untouched pre-093 concatenated row', () => {
    const { play, choice } = importedEpisode({
      NowPlayingItemId: 'ep-new',
      EpisodeId: 'ep-newseason-1',
    });

    expect(isImportedEpisodeRowRewritten(play, choice)).toBe(false);
  });

  it('flags a concatenated-looking row whose SeasonId is null', () => {
    const { play, choice } = importedEpisode({
      NowPlayingItemId: 'ep-new',
      EpisodeId: 'ep-newseason-1',
      SeasonId: null,
    });

    expect(isImportedEpisodeRowRewritten(play, choice)).toBe(true);
  });

  it('does not flag a native row that was never imported', () => {
    const { play, choice } = importedEpisode({
      imported: false,
      NowPlayingItemId: 'series-us',
      EpisodeId: 'ep-new',
    });

    expect(isImportedEpisodeRowRewritten(play, choice)).toBe(false);
  });

  it('does not flag a plugin-source row even when its ids match neither form', () => {
    const pluginIndex = buildJellystatRemapIndex(null, null, [{ rowid: 42, ItemId: 'ep-new' }]);
    const play = episodeActivity({
      Id: '42',
      imported: true,
      SeasonId: 'season-1',
      NowPlayingItemId: 'series-us',
      EpisodeId: 'ep-other',
    });

    expect(isImportedEpisodeRowRewritten(play, chooseJellystatItemKey(play, pluginIndex))).toBe(
      false
    );
  });
});
