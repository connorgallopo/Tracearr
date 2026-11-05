import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { Dashboard } from './Dashboard';

function Search() {
  return <div data-testid="search">{useLocation().search}</div>;
}

function renderDashboard(url = '/') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Dashboard />
      <Search />
    </MemoryRouter>
  );
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count !== undefined ? `${key}:${options.count}` : key,
  }),
}));

vi.mock('@/hooks/queries', () => ({
  useDashboardStats: vi.fn(),
  useActiveSessions: vi.fn(),
}));

vi.mock('@/components/dashboard/PersonalDashboard', () => ({
  PersonalDashboard: ({ actions }: { actions?: React.ReactNode }) => (
    <div data-testid="personal">{actions}</div>
  ),
}));

const auth = vi.hoisted(() => ({
  user: { role: 'owner', impersonatedBy: undefined as string | undefined },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));

const { multiLiveStats } = vi.hoisted(() => ({
  multiLiveStats: vi.fn((_ids: string[], _enabled: boolean) => ({
    series: [],
    clockSkewMs: 0,
    isLoading: false,
  })),
}));

// Not typechecked against the real module - keep in sync by hand
vi.mock('@/hooks/queries/useServers', () => ({
  useServerLiveStats: () => ({
    statistics: undefined,
    statisticsAverages: null,
    bandwidth: undefined,
    bandwidthAverages: null,
    clockSkewMs: 0,
    isLoading: false,
  }),
  useMultiServerLiveStats: (ids: string[], enabled: boolean) => multiLiveStats(ids, enabled),
}));

vi.mock('@/components/charts/ServerResourceCharts', () => ({
  ServerResourceCharts: () => null,
}));

vi.mock('@/components/charts/BandwidthChart', () => ({
  ServerBandwidthChart: () => null,
}));

vi.mock('@/components/history/SessionDetailSheet', () => ({
  SessionDetailSheet: () => null,
}));

vi.mock('@/components/map/StreamCard', () => ({
  StreamCard: () => null,
}));

vi.mock('@/components/sessions', () => ({
  NowPlayingCard: () => null,
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ isConnected: true }),
}));

vi.mock('@/hooks/useServerColorMap', () => ({
  useServerColorMap: () => new Map(),
}));

import { useDashboardStats, useActiveSessions } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';

const mockUseDashboardStats = vi.mocked(useDashboardStats);
const mockUseActiveSessions = vi.mocked(useActiveSessions);
const mockUseServer = vi.mocked(useServer);

function serverReturn() {
  return {
    selectedServerIds: [],
    selectedServers: [],
    isMultiServer: false,
    selectedServerId: null,
  } as unknown as ReturnType<typeof useServer>;
}

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user.role = 'owner';
    auth.user.impersonatedBy = undefined;
    localStorage.clear();
    mockUseServer.mockReturnValue(serverReturn());
  });

  it('shows Now Playing skeletons (not the empty-streams card) while sessions are still loading', () => {
    mockUseDashboardStats.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useDashboardStats>);
    mockUseActiveSessions.mockReturnValue({
      data: undefined,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useActiveSessions>);

    renderDashboard();

    expect(screen.queryByText('dashboard.noActiveStreams')).not.toBeInTheDocument();
    // The skeleton grid renders three placeholder cards while sessions are undefined.
    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('shows the no-active-streams empty state once sessions have loaded and there are none', () => {
    mockUseDashboardStats.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useDashboardStats>);
    mockUseActiveSessions.mockReturnValue({
      data: [],
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useActiveSessions>);

    renderDashboard();

    expect(screen.getByText('dashboard.noActiveStreams')).toBeInTheDocument();
  });

  it('shows a page-level error state when the stats query fails, and retry refetches both queries', async () => {
    const refetchStats = vi.fn();
    const refetchSessions = vi.fn();
    mockUseDashboardStats.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('stats failed'),
      refetch: refetchStats,
    } as unknown as ReturnType<typeof useDashboardStats>);
    mockUseActiveSessions.mockReturnValue({
      data: undefined,
      isError: false,
      error: null,
      refetch: refetchSessions,
    } as unknown as ReturnType<typeof useActiveSessions>);

    renderDashboard();

    expect(screen.getByText('common:errors.somethingWentWrong')).toBeInTheDocument();
    expect(screen.getByText('stats failed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /actions.tryAgain/ }));
    expect(refetchStats).toHaveBeenCalled();
    expect(refetchSessions).toHaveBeenCalled();
  });

  it('polls live stats only for the live servers in a multi-server view', () => {
    mockUseDashboardStats.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useDashboardStats>);
    mockUseActiveSessions.mockReturnValue({
      data: [],
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useActiveSessions>);
    mockUseServer.mockReturnValue({
      selectedServerIds: ['a', 'b'],
      selectedServers: [
        { id: 'a', name: 'Attic', type: 'plex', historicalAt: null },
        { id: 'b', name: 'Old', type: 'jellyfin', historicalAt: '2026-09-01T12:00:00.000Z' },
      ],
      isMultiServer: true,
      selectedServerId: null,
    } as unknown as ReturnType<typeof useServer>);

    renderDashboard();

    expect(multiLiveStats).toHaveBeenCalledWith(['a'], true);
  });

  it('shows no server resources section when the only Plex server is historical', () => {
    mockUseDashboardStats.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useDashboardStats>);
    mockUseActiveSessions.mockReturnValue({
      data: [],
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useActiveSessions>);
    mockUseServer.mockReturnValue({
      selectedServerIds: ['a', 'b'],
      selectedServers: [
        { id: 'a', name: 'Old Plex', type: 'plex', historicalAt: '2026-09-01T12:00:00.000Z' },
        { id: 'b', name: 'Attic', type: 'jellyfin', historicalAt: null },
      ],
      isMultiServer: true,
      selectedServerId: null,
    } as unknown as ReturnType<typeof useServer>);

    renderDashboard();

    expect(screen.queryByText('dashboard.serverResources')).not.toBeInTheDocument();
  });

  describe('view toggle', () => {
    beforeEach(() => {
      mockUseDashboardStats.mockReturnValue({
        data: { activeUsersToday: 2, todayPlays: 0, todaySessions: 0 },
        isLoading: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useDashboardStats>);
      mockUseActiveSessions.mockReturnValue({
        data: [],
        isError: false,
        error: null,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useActiveSessions>);
    });

    it('opens the server view for an owner with the toggle in the Today heading', () => {
      renderDashboard();

      expect(screen.getByRole('radio', { name: 'dashboard.view.admin' })).toBeChecked();
      expect(screen.getByText('dashboard.activeUsers')).toBeInTheDocument();
      expect(screen.queryByTestId('personal')).not.toBeInTheDocument();
    });

    it('has no visible h1 and keeps the toggle in the Today heading', () => {
      renderDashboard();

      const h1 = screen.getByRole('heading', { level: 1, name: 'dashboard' });
      expect(h1).toHaveClass('sr-only');
      const today = screen.getByText('common:time.today');
      expect(
        within(today.parentElement as HTMLElement).getByRole('radio', {
          name: 'dashboard.view.admin',
        })
      ).toBeInTheDocument();
    });

    it('opens the personal view from ?view=me, with the toggle in its first heading', () => {
      renderDashboard('/?view=me');

      expect(screen.getByTestId('personal')).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'dashboard.view.me' })).toBeChecked();
      expect(screen.queryByText('dashboard.activeUsers')).not.toBeInTheDocument();
    });

    it('stores the choice and sets the param when the personal view is picked', async () => {
      renderDashboard();

      await userEvent.click(screen.getByRole('radio', { name: 'dashboard.view.me' }));

      expect(localStorage.getItem('tracearr_dashboard_view')).toBe('me');
      expect(screen.getByTestId('search')).toHaveTextContent('?view=me');
      expect(screen.getByTestId('personal')).toBeInTheDocument();
    });

    it('opens the stored view when the URL names none, and lets the URL win when it does', () => {
      localStorage.setItem('tracearr_dashboard_view', 'me');

      renderDashboard();
      expect(screen.getByTestId('personal')).toBeInTheDocument();

      renderDashboard('/?view=admin');
      expect(screen.getAllByTestId('personal')).toHaveLength(1);
      expect(screen.getByText('dashboard.activeUsers')).toBeInTheDocument();
    });

    it.each([
      ['a member', undefined],
      ['an owner viewing as a member', 'owner-1'],
    ])('gives %s the personal view and no toggle, whatever the URL and storage say', (_n, by) => {
      auth.user.role = 'member';
      auth.user.impersonatedBy = by;
      localStorage.setItem('tracearr_dashboard_view', 'admin');

      renderDashboard('/?view=admin');

      expect(screen.getByTestId('personal')).toBeInTheDocument();
      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
      expect(localStorage.getItem('tracearr_dashboard_view')).toBe('admin');
    });

    it('gives an owner viewing as an admin the server view and no toggle, whatever the URL and storage say', () => {
      auth.user.role = 'admin';
      auth.user.impersonatedBy = 'owner-1';
      localStorage.setItem('tracearr_dashboard_view', 'me');

      renderDashboard('/?view=me');

      expect(screen.getByText('dashboard.activeUsers')).toBeInTheDocument();
      expect(screen.queryByTestId('personal')).not.toBeInTheDocument();
      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
      expect(localStorage.getItem('tracearr_dashboard_view')).toBe('me');
    });
  });

  it('adds listen time under watch time only when music was played today', () => {
    const stats = (listenTimeMs: number) =>
      ({
        data: { todayPlays: 4, todaySessions: 4, watchTimeMs: 9_180_000, listenTimeMs },
        isLoading: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      }) as unknown as ReturnType<typeof useDashboardStats>;
    mockUseActiveSessions.mockReturnValue({
      data: [],
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useActiveSessions>);

    mockUseDashboardStats.mockReturnValue(stats(0));
    const { unmount } = renderDashboard();
    expect(screen.getByText('2h 33m')).toBeInTheDocument();
    expect(screen.queryByText(/common:labels\.listenTime/)).not.toBeInTheDocument();
    unmount();

    mockUseDashboardStats.mockReturnValue(stats(3_600_000));
    renderDashboard();
    expect(screen.getByText('(common:labels.listenTime 1h 0m)')).toBeInTheDocument();
  });

  it('leaves the server view with the active users tile and no member extras', () => {
    mockUseDashboardStats.mockReturnValue({
      data: { activeUsersToday: 2, todayPlays: 0, todaySessions: 0 },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useDashboardStats>);
    mockUseActiveSessions.mockReturnValue({
      data: [],
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useActiveSessions>);

    renderDashboard();

    expect(screen.getByText('dashboard.activeUsers')).toBeInTheDocument();
    expect(screen.queryByText('dashboard.dayStreak')).not.toBeInTheDocument();
  });
});
