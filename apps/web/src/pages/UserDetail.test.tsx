import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { UserDetail } from './UserDetail';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('highcharts', () => ({ default: {} }));
vi.mock('highcharts-react-official', () => ({ HighchartsReact: () => null }));

vi.mock('@/components/history/HistoryTable', () => ({
  HistoryTable: ({ sessions }: { sessions: { id: string; mediaTitle: string }[] }) => (
    <ul aria-label="sessions">
      {sessions.map((session) => (
        <li key={session.id}>{session.mediaTitle}</li>
      ))}
    </ul>
  ),
}));

vi.mock('@/hooks/queries', () => ({
  useUserFull: vi.fn(),
  useUserRangeStats: vi.fn(),
  useUserSessions: vi.fn(),
  useUserDownloads: vi.fn(),
  useViolations: vi.fn(),
  useUserTerminations: vi.fn(),
  useRequestsConfigured: vi.fn(),
  useSplitServerUser: () => ({ mutate: vi.fn(), isPending: false }),
  useSettings: () => ({ data: { loginMethods: { member: true } } }),
  useUpdateUser: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateUserIdentity: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateUserAccess: () => ({ mutate: vi.fn(), isPending: false, reset: vi.fn() }),
}));

vi.mock('@/hooks/queries/useRequests', () => ({
  useUserRequests: vi.fn(),
}));

vi.mock('@/hooks/queries/useImpersonation', () => ({
  useViewAs: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

vi.mock('@/hooks/useServer', () => ({ useServer: vi.fn() }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }));

import {
  useRequestsConfigured,
  useUserFull,
  useUserRangeStats,
  useUserDownloads,
  useUserSessions,
  useUserTerminations,
  useViolations,
} from '@/hooks/queries';
import { useUserRequests } from '@/hooks/queries/useRequests';
import { useServer } from '@/hooks/useServer';
import { useAuth } from '@/hooks/useAuth';

const mockUseUserFull = vi.mocked(useUserFull);
const mockUseUserRangeStats = vi.mocked(useUserRangeStats);
const mockUseUserRequests = vi.mocked(useUserRequests);
const mockUseAuth = vi.mocked(useAuth);

const session = (id: string) => ({
  id,
  serverId: 'server-1',
  serverName: 'Server One',
  mediaTitle: `Title ${id}`,
  startedAt: '2026-10-01T00:00:00.000Z',
});

const fullData = {
  user: {
    id: 'su-1',
    userId: 'u-1',
    serverId: 'server-1',
    serverName: 'Server One',
    username: 'alice',
    identityName: 'Alice',
    email: 'alice@example.com',
    thumbUrl: null,
    trustScore: 80,
    role: 'member',
    loginAccess: 'default',
    loginCount: 0,
    lastLoginAt: null,
    joinedAt: '2024-01-02T00:00:00.000Z',
    createdAt: '2024-01-02T00:00:00.000Z',
    lastActivityAt: null,
    removedAt: null,
    stats: { totalSessions: 12, totalWatchTime: 0 },
  },
  identity: {
    userId: 'u-1',
    username: 'alice',
    aggregateTrustScore: 80,
    totalViolations: 1,
    contactEmail: null,
    serverUsers: [
      {
        id: 'su-1',
        serverId: 'server-1',
        serverName: 'Server One',
        serverType: 'plex',
        username: 'alice',
        thumbUrl: null,
        trustScore: 80,
        sessionCount: 12,
        removedAt: null,
        mergedIn: false,
      },
    ],
    stats: { totalSessions: 12, totalWatchTime: 0 },
  },
  sessions: { data: ['s1', 's2', 's3', 's4', 's5', 's6'].map(session), total: 12, hasMore: true },
  locations: [],
  devices: [],
  violations: { data: [], total: 3, hasMore: false },
  terminations: { data: [], total: 0, hasMore: false },
};

const rangeStats = {
  range: { start: null, end: '2026-10-19', priorStart: null, priorEnd: null },
  plays: 112,
  priorPlays: 100,
  watchMs: 3_600_000,
  priorWatchMs: null,
  finishedRate: 60,
  abandonedRate: 10,
  directPlayRate: 75,
  transcodes: 4,
  bytes: 1024,
  avgBitrateKbps: 8000,
  activeDays: 5,
  daysInRange: 30,
  currentStreak: 2,
  playsByDay: [{ date: '2026-10-01', count: 3 }],
  priorPlaysByDay: [{ date: '2026-09-01', count: 2 }],
  serverAvgPlaysByDay: [{ date: '2026-10-01', count: 1 }],
  playsByDow: [],
  playsByHour: [],
  serverPeakHour: 21,
  personPeakHour: 22,
  mediaTypeSplit: { movie: 2, episode: 8, track: 0, other: 0 },
  topGenres: [{ genre: 'Drama', plays: 6 }],
  mostFinished: [
    {
      mediaId: 'm-1',
      title: 'The Show',
      type: 'show',
      finished: 4,
      thumbPath: null,
      serverId: 'server-1',
    },
  ],
  devices: [],
  locations: [],
};

const violation = {
  id: 'v-1',
  rule: { id: 'r-1', name: 'Too many streams', type: null },
  severity: 'high',
  createdAt: '2026-10-01T00:00:00.000Z',
  acknowledgedAt: null,
  server: { id: 'server-1', name: 'Server One', type: 'plex' },
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function renderDetail(path = '/users/su-1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/users/:id"
          element={
            <>
              <UserDetail />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('UserDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUserFull.mockReturnValue({ data: fullData, isLoading: false } as unknown as ReturnType<
      typeof useUserFull
    >);
    mockUseUserRangeStats.mockReturnValue({
      data: rangeStats,
      isLoading: false,
    } as unknown as ReturnType<typeof useUserRangeStats>);
    vi.mocked(useUserSessions).mockReturnValue({
      data: { data: fullData.sessions.data, total: 12 },
      isLoading: false,
    } as unknown as ReturnType<typeof useUserSessions>);
    vi.mocked(useUserDownloads).mockReturnValue({
      data: { data: [], total: 4 },
      isLoading: false,
    } as unknown as ReturnType<typeof useUserDownloads>);
    vi.mocked(useViolations).mockReturnValue({
      data: { data: [violation], meta: { page: 1, pageSize: 10, total: 1 } },
      isLoading: false,
    } as unknown as ReturnType<typeof useViolations>);
    vi.mocked(useUserTerminations).mockReturnValue({
      data: { data: [], total: 0 },
      isLoading: false,
    } as unknown as ReturnType<typeof useUserTerminations>);
    mockUseUserRequests.mockReturnValue({
      data: { data: [], total: 2, summary: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useUserRequests>);
    vi.mocked(useRequestsConfigured).mockReturnValue({
      data: { configured: false },
    } as unknown as ReturnType<typeof useRequestsConfigured>);
    vi.mocked(useServer).mockReturnValue({
      servers: [{ id: 'server-1', name: 'Server One', type: 'plex' }],
      selectedServers: [],
      selectedServerIds: [],
    } as unknown as ReturnType<typeof useServer>);
    mockUseAuth.mockReturnValue({ user: { role: 'owner' } } as unknown as ReturnType<
      typeof useAuth
    >);
  });

  it('renders the name as the page heading with the trust badge and the facts line', () => {
    renderDetail();

    expect(screen.getByRole('heading', { level: 1, name: 'Alice' })).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
    const facts = screen.getByTestId('user-facts');
    expect(facts.textContent).not.toMatch(/(^|\s)@/);
    expect(facts).toHaveTextContent('alice@example.com');
    expect(facts).toHaveTextContent('pages:userDetail.access.roleMember');
    expect(facts).toHaveTextContent('common:labels.joined');
    expect(screen.getByRole('link', { name: 'nav:users' })).toHaveAttribute('href', '/users');
  });

  it('names a person without a display name by their Tracearr username alone', async () => {
    mockUseUserFull.mockReturnValue({
      data: {
        ...fullData,
        user: { ...fullData.user, identityName: null, username: 'aaron_tofa' },
        identity: { ...fullData.identity, username: 'zoe' },
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useUserFull>);
    renderDetail();

    expect(screen.getByRole('heading', { level: 1, name: 'zoe' })).toBeInTheDocument();
    expect(screen.queryByText(/aaron_tofa/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'pages:userDetail.editIdentity' }));
    expect(await screen.findByPlaceholderText('zoe')).toBeInTheDocument();
  });

  it('renders six stat cards with deltas from the range stats', () => {
    renderDetail();

    const cards = screen.getByTestId('range-stat-cards');
    expect(cards.children).toHaveLength(6);
    expect(within(cards).getByText('+12%')).toBeInTheDocument();
    expect(within(cards).getByText('pages:userDetail.cards.vsPrior')).toBeInTheDocument();
  });

  it('defaults to the overview tab and syncs ?tab=sessions on click with replace', async () => {
    renderDetail('/users/su-1?period=week');

    expect(screen.getByRole('tab', { name: /nav:overview/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByTestId('location')).toHaveTextContent('?period=week');

    await userEvent.click(screen.getByRole('tab', { name: /common:labels.sessions/ }));

    expect(screen.getByTestId('location')).toHaveTextContent('?period=week&tab=sessions');
    expect(screen.getByRole('tab', { name: /common:labels.sessions/ })).toHaveTextContent('12');
    expect(screen.getByRole('tab', { name: /nav:violations/ })).toHaveTextContent('3');
  });

  it('shows the downloads tab with its count between violations and access, and hides it at zero', () => {
    renderDetail();

    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    const downloads = screen.getByRole('tab', { name: /pages:userDetail.tabs.downloads/ });
    expect(downloads).toHaveTextContent('4');
    expect(tabs.indexOf(downloads.textContent)).toBe(
      tabs.findIndex((label) => label?.includes('nav:violations')) + 1
    );
    expect(tabs[tabs.length - 1]).toContain('pages:userDetail.tabs.access');
  });

  it('has no downloads tab when the person has none', () => {
    vi.mocked(useUserDownloads).mockReturnValue({
      data: { data: [], total: 0 },
      isLoading: false,
    } as unknown as ReturnType<typeof useUserDownloads>);

    renderDetail();

    expect(
      screen.queryByRole('tab', { name: /pages:userDetail.tabs.downloads/ })
    ).not.toBeInTheDocument();
  });

  it('falls back to overview for an unknown tab value', () => {
    renderDetail('/users/su-1?tab=nope');

    expect(screen.getByRole('tab', { name: /nav:overview/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('hides the requests tab when no request service is configured and the access tab for non-owners', () => {
    mockUseUserRequests.mockReturnValue({
      data: { data: [], total: 0, summary: null },
      isLoading: false,
    } as unknown as ReturnType<typeof useUserRequests>);
    mockUseAuth.mockReturnValue({ user: { role: 'admin' } } as unknown as ReturnType<
      typeof useAuth
    >);

    renderDetail();

    expect(screen.queryByRole('tab', { name: /nav:requests/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: /pages:userDetail.tabs.access/ })
    ).not.toBeInTheDocument();
  });

  it('keeps the requests tab for a configured request service even with no requests', async () => {
    vi.mocked(useRequestsConfigured).mockReturnValue({
      data: { configured: true },
    } as unknown as ReturnType<typeof useRequestsConfigured>);
    mockUseUserRequests.mockReturnValue({
      data: { data: [], total: 0, summary: null },
      isLoading: false,
    } as unknown as ReturnType<typeof useUserRequests>);

    renderDetail();
    await userEvent.click(screen.getByRole('tab', { name: /nav:requests/ }));

    expect(screen.getByText('pages:requests.userCard.empty')).toBeInTheDocument();
  });

  it("shows the access tab on the owner's own row without the sign-in controls", async () => {
    mockUseUserFull.mockReturnValue({
      data: { ...fullData, user: { ...fullData.user, role: 'owner' } },
      isLoading: false,
    } as unknown as ReturnType<typeof useUserFull>);

    renderDetail('/users/su-1?tab=access');

    expect(screen.getByRole('tab', { name: /pages:userDetail.tabs.access/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.queryByText('pages:userDetail.access.title')).not.toBeInTheDocument();
  });

  it('shows an admin the access tab on a merged identity with linked accounts and no controls', () => {
    mockUseAuth.mockReturnValue({ user: { role: 'admin' } } as unknown as ReturnType<
      typeof useAuth
    >);
    const second = {
      ...fullData.identity.serverUsers[0],
      id: 'su-2',
      serverId: 'server-2',
      serverName: 'Server Two',
      mergedIn: true,
    };
    mockUseUserFull.mockReturnValue({
      data: {
        ...fullData,
        identity: {
          ...fullData.identity,
          serverUsers: [...fullData.identity.serverUsers, second],
        },
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useUserFull>);

    renderDetail('/users/su-1?tab=access');

    expect(screen.getByText('pages:userDetail.linkedAccounts')).toBeInTheDocument();
    expect(screen.queryByText('pages:userDetail.access.title')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'pages:userDetail.splitAccount' })
    ).not.toBeInTheDocument();
  });

  it('shows the requests and access tabs for an owner viewing someone with requests', () => {
    renderDetail();

    expect(screen.getByRole('tab', { name: /nav:requests/ })).toHaveTextContent('2');
    expect(screen.getByRole('tab', { name: /pages:userDetail.tabs.access/ })).toBeInTheDocument();
  });

  it('renders overview sections: plays over time with prior and server average, when, what, most finished, where, recent sessions', () => {
    renderDetail();

    for (const heading of [
      'pages:userDetail.overview.playsOverTime',
      'common:labels.when',
      'pages:userDetail.overview.what',
      'pages:userDetail.overview.mostFinished',
      'pages:userDetail.overview.where',
      'common:labels.recentSessions',
    ]) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
    const recent = screen.getByRole('list', { name: 'sessions' });
    expect(within(recent).getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('Drama')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /The Show/ })).toHaveAttribute('href', '/media/m-1');
  });

  it('links violation rows to the violation page', async () => {
    renderDetail('/users/su-1?tab=violations');

    expect(screen.getByRole('link', { name: 'Too many streams' })).toHaveAttribute(
      'href',
      '/violations/v-1'
    );
    expect(vi.mocked(useViolations)).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 'u-1', page: 1 })
    );
  });

  it('keeps scope=identity on tab changes', async () => {
    renderDetail();

    await userEvent.click(screen.getByRole('tab', { name: /common:labels.sessions/ }));

    expect(mockUseUserRangeStats).toHaveBeenLastCalledWith(
      'su-1',
      expect.objectContaining({ scope: 'identity' }),
      []
    );
    expect(vi.mocked(useUserSessions)).toHaveBeenLastCalledWith(
      'su-1',
      expect.objectContaining({ scope: 'identity', page: 1 })
    );
  });
});
