import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import type { MediaStatsResponse, MediaWatcherEntry } from '@tracearr/shared';
import { KpiStrip, MemberKpiStrip, averageCompletion, finishedEveryEpisodeCount } from './KpiStrip';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

function watcher(overrides: Partial<MediaWatcherEntry> = {}): MediaWatcherEntry {
  return {
    user: {
      serverUserId: 's1',
      userId: 'u1',
      serverId: 'srv-1',
      username: 'sarah',
      identityName: 'Sarah',
      thumb: null,
      thumbServerId: null,
    },
    plays: 10,
    watchTimeMs: 1000,
    completionPct: 100,
    lastWatchedDay: '2026-07-01',
    distinctEpisodesWatched: 19,
    ...overrides,
  };
}

function stats(
  overrides: Partial<MediaStatsResponse['windows']['all_time']['combined']> = {}
): MediaStatsResponse {
  return {
    mediaId: 'media-1',
    mediaType: 'show',
    windows: {
      all_time: {
        combined: { plays: 214, watchTimeMs: 655_200_000, uniqueUsers: 14, ...overrides },
        perServer: [],
      },
      last_30: { combined: { plays: 30, watchTimeMs: 129_600_000, uniqueUsers: 4 }, perServer: [] },
      last_7: { combined: { plays: 5, watchTimeMs: 10_000, uniqueUsers: 2 }, perServer: [] },
    },
  };
}

describe('averageCompletion', () => {
  it('rounds the mean of every non-null completionPct', () => {
    const watchers = [
      watcher({ completionPct: 100 }),
      watcher({ completionPct: 74 }),
      watcher({ completionPct: 47 }),
    ];
    expect(averageCompletion(watchers)).toBe(74);
  });

  it('ignores watchers with a null completionPct', () => {
    const watchers = [watcher({ completionPct: 100 }), watcher({ completionPct: null })];
    expect(averageCompletion(watchers)).toBe(100);
  });

  it('returns null when no watcher has a completion figure', () => {
    expect(averageCompletion([watcher({ completionPct: null })])).toBeNull();
  });

  it('returns null for an empty watcher list', () => {
    expect(averageCompletion([])).toBeNull();
  });
});

describe('finishedEveryEpisodeCount', () => {
  it('counts only watchers at exactly 100%', () => {
    const watchers = [
      watcher({ completionPct: 100 }),
      watcher({ completionPct: 100 }),
      watcher({ completionPct: 99 }),
    ];
    expect(finishedEveryEpisodeCount(watchers)).toBe(2);
  });
});

describe('KpiStrip', () => {
  it('renders the four kpi tiles with the avg-completion caption for a show', () => {
    const watchers = [
      watcher({ completionPct: 100 }),
      watcher({ completionPct: 74 }),
      watcher({ completionPct: 47 }),
      watcher({ completionPct: 100 }),
    ];
    render(
      <KpiStrip
        mediaType="show"
        stats={stats()}
        statsLoading={false}
        statsError={false}
        onRetryStats={vi.fn()}
        watchers={watchers}
        watchersLoading={false}
        watchersError={false}
        onRetryWatchers={vi.fn()}
      />
    );

    expect(screen.getByText('214')).toBeInTheDocument();
    expect(screen.getByText('182h')).toBeInTheDocument();
    expect(screen.getByText('14')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('2 of 4 finished every episode')).toBeInTheDocument();
  });

  it('uses the movie-specific completion caption for a movie', () => {
    render(
      <KpiStrip
        mediaType="movie"
        stats={stats()}
        statsLoading={false}
        statsError={false}
        onRetryStats={vi.fn()}
        watchers={[watcher({ completionPct: 100 })]}
        watchersLoading={false}
        watchersError={false}
        onRetryWatchers={vi.fn()}
      />
    );

    expect(screen.getByText('1 of 1 watched to completion')).toBeInTheDocument();
  });

  it('speaks of listening, not episodes, for an artist', () => {
    render(
      <KpiStrip
        mediaType="artist"
        stats={stats()}
        statsLoading={false}
        statsError={false}
        onRetryStats={vi.fn()}
        watchers={[watcher({ completionPct: 100 }), watcher({ completionPct: 40 })]}
        watchersLoading={false}
        watchersError={false}
        onRetryWatchers={vi.fn()}
      />
    );

    expect(screen.getByText('Listen Time')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 listened to the end')).toBeInTheDocument();
    expect(screen.queryByText(/episode/)).not.toBeInTheDocument();
  });

  it('shows an inline error with retry when stats fails to load, independent of watchers', () => {
    const onRetryStats = vi.fn();
    render(
      <KpiStrip
        mediaType="show"
        stats={undefined}
        statsLoading={false}
        statsError
        onRetryStats={onRetryStats}
        watchers={[watcher()]}
        watchersLoading={false}
        watchersError={false}
        onRetryWatchers={vi.fn()}
      />
    );

    screen.getByRole('button', { name: /try again/i }).click();
    expect(onRetryStats).toHaveBeenCalled();
    // The completion tile still renders even though stats failed.
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('renders a dash for avg completion when no watcher has a completion figure', () => {
    render(
      <KpiStrip
        mediaType="show"
        stats={stats()}
        statsLoading={false}
        statsError={false}
        onRetryStats={vi.fn()}
        watchers={[]}
        watchersLoading={false}
        watchersError={false}
        onRetryWatchers={vi.fn()}
      />
    );

    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('MemberKpiStrip', () => {
  const render4 = (overrides: Partial<React.ComponentProps<typeof MemberKpiStrip>> = {}) =>
    render(
      <MemberKpiStrip
        mediaType="show"
        episodeCount={22}
        watchers={[watcher({ plays: 5, watchTimeMs: 7_200_000, completionPct: 64 })]}
        watchersLoading={false}
        watchersError={false}
        onRetryWatchers={vi.fn()}
        othersCount={undefined}
        {...overrides}
      />
    );

  it("shows the member's own plays, completion and episodes watched", () => {
    render4({ watchers: [watcher({ plays: 5, completionPct: 64, distinctEpisodesWatched: 14 })] });

    expect(screen.getByText('Your plays')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('64%')).toBeInTheDocument();
    expect(screen.getByText('14 of 22 episodes')).toBeInTheDocument();
    expect(screen.getByText('Jul 1, 2026')).toBeInTheDocument();
    expect(screen.queryByText('Viewers')).not.toBeInTheDocument();
  });

  it("labels an artist's numbers as listening and playing", () => {
    render4({ mediaType: 'artist', episodeCount: null });

    expect(screen.getByText('Your listen time')).toBeInTheDocument();
    expect(screen.getByText('Last played')).toBeInTheDocument();
    expect(screen.queryByText('Your watch time')).not.toBeInTheDocument();
    expect(screen.queryByText('Last watched')).not.toBeInTheDocument();
  });

  it('adds the others line only when the server sends a count', () => {
    const { rerender } = render4();
    expect(screen.queryByText(/Watched by/)).not.toBeInTheDocument();

    rerender(
      <MemberKpiStrip
        mediaType="show"
        episodeCount={22}
        watchers={[watcher()]}
        watchersLoading={false}
        watchersError={false}
        onRetryWatchers={vi.fn()}
        othersCount={3}
      />
    );
    expect(screen.getByText('Watched by 3 others')).toBeInTheDocument();
  });
});
