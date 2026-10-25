import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { PersonalDashboard } from './PersonalDashboard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/components/charts/EngagementChart', () => ({ TIER_COLORS: {} }));
vi.mock('@/components/history/SessionDetailSheet', () => ({ SessionDetailSheet: () => null }));
vi.mock('@/components/sessions', () => ({
  NowPlayingCard: ({ session }: { session: { id: string } }) => (
    <div data-testid="now-playing">{session.id}</div>
  ),
}));
vi.mock('@/components/requests/MyRequestsCard', () => ({
  MyRequestsCard: () => <div data-testid="my-requests" />,
}));

vi.mock('@/hooks/queries', () => ({
  useActiveSessions: vi.fn(),
  useEngagementStats: vi.fn(),
  useHistoryAggregates: vi.fn(),
  useMyStats: vi.fn(),
  useMyTopTitles: vi.fn(),
  useOthersActive: vi.fn(),
  useOwnerLinks: vi.fn(),
  usePlaysByDayOfWeek: vi.fn(),
  usePlaysByHourOfDay: vi.fn(),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }));
vi.mock('@/hooks/useServer', () => ({
  useServer: () => ({
    selectedServerIds: ['srv-1'],
    servers: [{ id: 'srv-1', name: 'Den', type: 'plex', color: '#e5a00d' }],
  }),
}));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => ({ isConnected: true }) }));

import {
  useActiveSessions,
  useEngagementStats,
  useHistoryAggregates,
  useMyStats,
  useMyTopTitles,
  useOthersActive,
  useOwnerLinks,
  usePlaysByDayOfWeek,
  usePlaysByHourOfDay,
} from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';

function query(data: unknown) {
  return { data, isLoading: false, isError: false, isSuccess: true, refetch: vi.fn() } as never;
}

function title(overrides: Record<string, unknown>) {
  return {
    mediaId: 'm-1',
    mediaType: 'show',
    title: 'The Bear',
    year: 2022,
    genres: [],
    posterUrl: null,
    posterVersion: null,
    dominantColor: null,
    servers: [
      {
        serverId: 'srv-1',
        addedAt: '2026-01-01',
        videoResolution: null,
        fileSize: null,
        versionCount: 1,
      },
    ],
    resolutionBest: null,
    watchedState: 'partial',
    plays: 8,
    watchTimeMs: 21_600_000,
    episodes: 8,
    rank: 1,
    ...overrides,
  };
}

const bear = title({});
const dune = title({
  mediaId: 'm-2',
  mediaType: 'movie',
  title: 'Dune',
  year: 2021,
  plays: 1,
  watchTimeMs: 9_000_000,
  episodes: null,
  rank: 2,
});

function load({
  daysWatched = 30,
  currentStreak = 4,
  profile = 'completionist',
  streams = [] as { id: string }[],
  others = undefined as number | undefined,
  titles = [bear, dune] as unknown[],
  listenTimeMs = 0,
} = {}) {
  vi.mocked(useMyStats).mockReturnValue(
    query({
      daysWatched,
      currentStreak,
      longestStreak: 9,
      totalWatchTimeMs: 93_600_000,
      firstPlay: null,
      biggestBinge: null,
      topGenres: [],
    })
  );
  vi.mocked(useHistoryAggregates).mockImplementation((filters) =>
    query(
      filters?.endDate && filters.startDate && filters.startDate.getTime() < Date.now() - 4e9
        ? {
            playCount: 4,
            totalWatchTimeMs: 1_800_000,
            listenTimeMs: 0,
            uniqueContent: 3,
            uniqueUsers: 1,
          }
        : {
            playCount: 5,
            totalWatchTimeMs: 6_360_000,
            listenTimeMs,
            uniqueContent: 5,
            uniqueUsers: 1,
          }
    )
  );
  vi.mocked(useEngagementStats).mockReturnValue(
    query({
      engagementBreakdown: [{ tier: 'watched', count: 8, percentage: 80 }],
      userProfiles: [{ behaviorType: profile, completionRate: 82, totalPlays: 12 }],
    })
  );
  vi.mocked(usePlaysByDayOfWeek).mockReturnValue(query([{ day: 5, name: 'Fri', count: 6 }]));
  vi.mocked(usePlaysByHourOfDay).mockReturnValue(query([{ hour: 21, count: 4 }]));
  vi.mocked(useMyTopTitles).mockReturnValue(query({ data: titles }));
  vi.mocked(useActiveSessions).mockReturnValue(query(streams));
  vi.mocked(useOthersActive).mockReturnValue(query(others));
  vi.mocked(useOwnerLinks).mockReturnValue(query(undefined));
  vi.mocked(useAuth).mockReturnValue({ user: { role: 'member' } } as never);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <PersonalDashboard />
    </MemoryRouter>
  );
}

describe('PersonalDashboard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a welcome with a browse link, and nothing else, before a first play', () => {
    load({ daysWatched: 0 });

    renderPage();

    expect(screen.getByText('dashboard.me.welcome.title')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'dashboard.me.welcome.browse' })).toHaveAttribute(
      'href',
      '/media/browse'
    );
    for (const text of ['dashboard.plays', 'dashboard.me.topTitles', 'yourStats.allTime']) {
      expect(screen.queryByText(text)).not.toBeInTheDocument();
    }
    expect(screen.queryByText('yourStats.howYouWatch')).not.toBeInTheDocument();
  });

  it('sends an owner whose own account is not linked to the server settings instead', () => {
    load({ daysWatched: 0 });
    vi.mocked(useAuth).mockReturnValue({ user: { role: 'owner' } } as never);
    vi.mocked(useOwnerLinks).mockReturnValue(
      query([{ serverId: 'srv-2', linked: null, candidates: [] }])
    );

    renderPage();

    expect(screen.queryByText('dashboard.me.welcome.title')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'dashboard.me.link.action' })).toHaveAttribute(
      'href',
      '/settings/servers/connections'
    );
  });

  it('shows watch time and plays with the change against the 30 days before', () => {
    load();

    renderPage();

    expect(screen.getByText('1h 46m')).toBeInTheDocument();
    expect(screen.getByText('+25%')).toBeInTheDocument();
    expect(screen.getByText('+253%')).toBeInTheDocument();
    expect(screen.getAllByText('(userDetail.cards.vsPrior)')).toHaveLength(2);
  });

  it('takes listen time out of watch time and the change, and names it under the value', () => {
    load({ listenTimeMs: 3_600_000 });

    renderPage();

    expect(screen.getByText('46m')).toBeInTheDocument();
    expect(screen.getByText('(common:labels.listenTime 1h 0m)')).toBeInTheDocument();
    expect(screen.getByText('+53%')).toBeInTheDocument();
  });

  it('shows the day streak tile once, and not at all with no streak', () => {
    load({ currentStreak: 4 });
    const { unmount } = renderPage();
    expect(screen.getAllByText('dashboard.dayStreak')).toHaveLength(1);
    unmount();

    load({ currentStreak: 0 });
    renderPage();
    expect(screen.queryByText('dashboard.dayStreak')).not.toBeInTheDocument();
  });

  it('omits the last 30 days when nothing was played in them', () => {
    load();
    vi.mocked(useHistoryAggregates).mockReturnValue(
      query({ playCount: 0, totalWatchTimeMs: 0, uniqueContent: 0, uniqueUsers: 1 })
    );

    renderPage();

    expect(screen.queryByText('dashboard.plays')).not.toBeInTheDocument();
    expect(screen.queryByText('dashboard.watchTime')).not.toBeInTheDocument();
  });

  it('keeps the view toggle when the last 30 days are empty or fail to load', () => {
    const page = () =>
      render(
        <MemoryRouter>
          <PersonalDashboard actions={<button>toggle</button>} />
        </MemoryRouter>
      );
    load();
    vi.mocked(useHistoryAggregates).mockReturnValue(
      query({ playCount: 0, totalWatchTimeMs: 0, uniqueContent: 0, uniqueUsers: 1 })
    );
    const { unmount } = page();
    expect(screen.getByRole('button', { name: 'toggle' })).toBeInTheDocument();
    unmount();

    vi.mocked(useHistoryAggregates).mockReturnValue({
      isError: true,
      error: new Error('boom'),
      refetch: vi.fn(),
    } as never);
    page();
    expect(screen.getByRole('button', { name: 'toggle' })).toBeInTheDocument();
  });

  it('shows no Now Playing section without streams, and the cards with one', () => {
    load();
    const { unmount } = renderPage();
    expect(screen.queryByText('dashboard.nowPlaying')).not.toBeInTheDocument();
    unmount();

    load({ streams: [{ id: 'a1' }] });
    renderPage();
    expect(screen.getByText('dashboard.nowPlaying')).toBeInTheDocument();
    expect(screen.getAllByTestId('now-playing')).toHaveLength(1);
  });

  it('renders the top titles as ranked poster cards linking to their media pages', () => {
    load();

    renderPage();

    const row = screen.getByRole('region', { name: 'dashboard.me.topTitles' });
    const links = within(row).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/media/m-1', '/media/m-2']);
    expect(links[0]).toHaveAccessibleName(/The Bear \(2022\).*rankSuffix.*partial/);
    expect(within(row).getByText(/dashboard\.me\.episodes.*8/)).toBeInTheDocument();
    expect(within(row).getByText(/common:count\.play.*1\}/)).toBeInTheDocument();
  });

  it('omits top titles when the viewer has none', () => {
    load({ titles: [] });

    renderPage();

    expect(screen.queryByText('dashboard.me.topTitles')).not.toBeInTheDocument();
  });

  it('describes how they watch from the whole history, and hides it for an inactive profile', () => {
    load();
    const { unmount } = renderPage();
    expect(screen.getByText('yourStats.viewerType.completionist.label')).toBeInTheDocument();
    expect(screen.getByText(/yourStats\.habits.*Friday.*9 PM/)).toBeInTheDocument();
    expect(screen.getByText('yourStats.allTimeCaption')).toBeInTheDocument();
    unmount();

    load({ profile: 'inactive' });
    renderPage();
    expect(screen.queryByText('yourStats.howYouWatch')).not.toBeInTheDocument();
  });

  it("asks every read for the viewer's own accounts", () => {
    load({ streams: [{ id: 'a1' }] });

    renderPage();

    for (const call of vi.mocked(useHistoryAggregates).mock.calls) {
      expect(call[0]).toMatchObject({ self: true });
    }
    expect(vi.mocked(useEngagementStats).mock.calls[0]?.[2]).toMatchObject({ self: true });
    expect(vi.mocked(useEngagementStats).mock.calls[0]?.[0]).toEqual({ period: 'all' });
    for (const hook of [usePlaysByDayOfWeek, usePlaysByHourOfDay]) {
      expect(vi.mocked(hook).mock.calls[0]?.[2]).toEqual({ self: true });
    }
    expect(vi.mocked(useMyTopTitles)).toHaveBeenCalledWith(['srv-1']);
    expect(vi.mocked(useActiveSessions).mock.calls[0]?.[2]).toBe(true);
    expect(vi.mocked(useOthersActive).mock.calls[0]?.[2]).toBe(true);
  });

  it('mentions other streams only when the server sends a count above zero', () => {
    load({ others: 3 });
    const { unmount } = renderPage();
    expect(screen.getByText(/dashboard\.othersStreaming.*3/)).toBeInTheDocument();
    unmount();

    load({ others: 0 });
    renderPage();
    expect(screen.queryByText(/dashboard\.othersStreaming/)).not.toBeInTheDocument();
  });
});
