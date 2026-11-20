import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ServerUserFullDetail, UserRangeStats } from '@tracearr/shared';
import type { PlaysComparison } from '@/components/charts/PlaysChart';
import type { TimeRangePeriod } from '@/components/ui/time-range-picker';
import { OverviewTab } from './OverviewTab';

const { charted } = vi.hoisted(() => ({ charted: [] as PlaysComparison[][] }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/charts/PlaysChart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/charts/PlaysChart')>()),
  PlaysChart: ({ comparisons }: { comparisons: PlaysComparison[] }) => {
    charted.push(comparisons);
    return null;
  },
}));
vi.mock('./WhenCard', () => ({ WhenCard: () => null }));
vi.mock('./WhatCard', () => ({ WhatCard: () => null }));
vi.mock('./WhereCard', () => ({ WhereCard: () => null }));
vi.mock('./MostFinishedCard', () => ({ MostFinishedCard: () => null }));
vi.mock('./SessionsTab', () => ({ UserSessionsTable: () => null }));

const detail = {
  user: { identityName: null },
  identity: { username: 'alice' },
  sessions: { data: [], total: 0 },
  devices: [],
  locations: [],
  profiles: [
    {
      id: 'p-robin',
      name: 'Robin',
      serverUserId: 'su-1',
      accountUsername: 'alice_tofa',
      serverName: 'Den',
      main: true,
      removed: false,
    },
    {
      id: 'p-sam',
      name: 'Sam',
      serverUserId: 'su-1',
      accountUsername: 'alice_tofa',
      serverName: 'Den',
      main: false,
      removed: true,
    },
  ],
} as unknown as ServerUserFullDetail;

function renderTab(stats: UserRangeStats, period: TimeRangePeriod = 'week') {
  return render(
    <OverviewTab
      stats={stats}
      isLoading={false}
      period={period}
      detail={detail}
      showServer={false}
      profiles={[]}
      onSessionClick={vi.fn()}
      onShowSessions={vi.fn()}
    />
  );
}

describe('OverviewTab', () => {
  it('lays the prior range over the current buckets and adds the server average', () => {
    const stats = {
      playsByDay: [
        { date: '2026-10-01', count: 1 },
        { date: '2026-10-02', count: 2 },
      ],
      priorPlaysByDay: [
        { date: '2026-09-29', count: 5 },
        { date: '2026-09-30', count: 6 },
      ],
      serverAvgPlaysByDay: [{ date: '2026-10-01', count: 0.5 }],
      profiles: [],
    } as unknown as UserRangeStats;

    renderTab(stats);

    const [prior, average] = charted[charted.length - 1] ?? [];
    expect(prior).toMatchObject({
      name: 'pages:userDetail.overview.priorRange',
      dashStyle: 'ShortDash',
      data: [
        { date: '2026-10-01', count: 5 },
        { date: '2026-10-02', count: 6 },
      ],
    });
    expect(average).toMatchObject({ name: 'pages:userDetail.overview.serverAverage' });
  });

  it('drops a prior bucket the current range has no slot for instead of drawing it backwards', () => {
    const week = (date: string) => ({ date, count: 1 });
    const stats = {
      playsByDay: ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'].map(week),
      priorPlaysByDay: [
        '2026-07-27',
        '2026-08-03',
        '2026-08-10',
        '2026-08-17',
        '2026-08-24',
        '2026-08-31',
      ].map(week),
      serverAvgPlaysByDay: [],
      profiles: [],
    } as unknown as UserRangeStats;

    renderTab(stats, 'custom');

    const [prior] = charted[charted.length - 1] ?? [];
    expect(prior?.data.map((point) => point.date)).toEqual([
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
    ]);
  });

  it('splits plays by profile once a second profile has played, the main one named as its account', () => {
    const robin = {
      profileId: 'p-robin',
      name: 'Robin',
      removed: false,
      plays: 3,
      watchMs: 5_400_000,
    };
    const sam = { profileId: 'p-sam', name: 'Sam', removed: true, plays: 1, watchMs: 600_000 };
    const withProfiles = (profiles: UserRangeStats['profiles']) =>
      ({
        playsByDay: [],
        priorPlaysByDay: [],
        serverAvgPlaysByDay: [],
        profiles,
      }) as unknown as UserRangeStats;

    const { unmount } = renderTab(withProfiles([robin]));
    expect(screen.queryByText('labels.profiles')).not.toBeInTheDocument();
    unmount();

    renderTab(withProfiles([robin, sam]));
    expect(screen.getByText('labels.profiles')).toBeInTheDocument();
    expect(screen.getByText('alice_tofa')).toBeInTheDocument();
    expect(screen.queryByText('Robin')).not.toBeInTheDocument();
    expect(screen.getByText('1h 30m')).toBeInTheDocument();
    expect(screen.getByText('labels.profileRemoved')).toBeInTheDocument();
  });
});
