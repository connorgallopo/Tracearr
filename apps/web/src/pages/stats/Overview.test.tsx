import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { StatsOverview, periodFilters } from './Overview';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'statsOverview.title': 'Watch Statistics',
        'statsOverview.controls.playCount': 'Play count',
        'statsOverview.controls.watchTime': 'Watch time',
        'statsOverview.units.plays': 'Plays',
        'statsOverview.units.hours': 'Hours',
      };
      return labels[key] ?? key;
    },
  }),
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: () => ({ selectedServerIds: ['server-1'] }),
}));

vi.mock('@/hooks/queries', () => ({
  useHistoryAggregates: () =>
    query({
      playCount: 100,
      totalWatchTimeMs: 360_000_000,
      uniqueUsers: 12,
      uniqueContent: 40,
    }),
  useTopMovies: (_ids: string[], _period: string, sortBy: string) =>
    query({
      items: [
        {
          ratingKey: sortBy === 'viewers' ? 'popular-movie' : 'watched-movie',
          title: sortBy === 'viewers' ? 'Michael' : 'Obsession',
          year: 2025,
          thumbPath: null,
          serverId: 'server-1',
          totalPlays: 36,
          totalWatchHours: 24.5,
          uniqueViewers: 17,
          completionRate: 80,
        },
      ],
    }),
  useTopShows: (_ids: string[], _period: string, sortBy: string) =>
    query({
      items: [
        {
          showTitle: sortBy === 'viewers' ? 'Dutton Ranch' : 'NCIS',
          year: 2025,
          thumbPath: null,
          serverId: 'server-1',
          totalEpisodeViews: 726,
          totalWatchHours: 200,
          uniqueViewers: 16,
          avgCompletionRate: 80,
          bingeScore: 60,
        },
      ],
    }),
  useUserStats: () =>
    query([
      {
        serverUserId: 'user-1',
        serverId: 'server-1',
        username: 'David',
        thumbUrl: null,
        playCount: 1593,
        watchTimeHours: 12.5,
      },
    ]),
  useTopUsers: () =>
    query([
      {
        userId: 'identity-1',
        serverUserId: 'user-1',
        username: 'David',
        identityName: 'David Deschene',
        thumbUrl: null,
        serverId: 'server-1',
        watchTimeHours: 12.5,
      },
    ]),
  usePlatformStats: () => query([{ platform: 'Android TV', count: 4514, watchTimeHours: 10.5 }]),
  useConcurrentStats: () =>
    query([{ hour: '2026-08-01T21:00:00Z', total: 11, direct: 8, directStream: 2, transcode: 1 }]),
  useQualityStats: () =>
    query({
      directPlay: 74,
      directStream: 17,
      transcode: 9,
      total: 100,
      directPlayPercent: 74,
      directStreamPercent: 17,
      transcodePercent: 9,
    }),
  useHistorySessions: () => ({
    ...query(undefined),
    data: { pages: [{ data: [] }] },
  }),
}));

function query<T>(data: T) {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
}

describe('StatsOverview', () => {
  it('maps every period to the stats API range it supports', () => {
    expect(periodFilters('7d').stats).toEqual({ period: 'week' });
    expect(periodFilters('30d').stats).toEqual({ period: 'month' });
    expect(periodFilters('1y').stats).toEqual({ period: 'year' });
    expect(periodFilters('all')).toEqual({ stats: { period: 'all' }, history: {} });

    const ninetyDays = periodFilters('90d');
    expect(ninetyDays.stats.period).toBe('custom');
    expect(ninetyDays.stats.startDate).toBe(ninetyDays.history.startDate?.toISOString());
    expect(ninetyDays.stats.endDate).toBe(ninetyDays.history.endDate?.toISOString());
    expect(
      (ninetyDays.history.endDate?.getTime() ?? 0) - (ninetyDays.history.startDate?.getTime() ?? 0)
    ).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it('defaults to play count and 90 days, then switches every metric leaderboard to hours', async () => {
    render(
      <MemoryRouter>
        <StatsOverview />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: 'Watch Statistics' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play count' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: '90D' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Obsession')).toBeInTheDocument();
    expect(screen.getByText('Android TV')).toBeInTheDocument();
    expect(screen.getByText('1,593')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Watch time' }));

    expect(screen.getByRole('button', { name: 'Watch time' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByText('David Deschene')).toBeInTheDocument();
    expect(screen.getByText('10.5h')).toBeInTheDocument();
    expect(screen.getAllByText('Hours').length).toBeGreaterThan(1);
  });
});
