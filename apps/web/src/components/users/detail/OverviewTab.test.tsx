import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ServerUserFullDetail, UserRangeStats } from '@tracearr/shared';
import type { PlaysComparison } from '@/components/charts/PlaysChart';
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
    } as UserRangeStats;

    render(
      <OverviewTab
        stats={stats}
        isLoading={false}
        period="week"
        detail={
          {
            user: { identityName: null },
            identity: { username: 'alice' },
            sessions: { data: [], total: 0 },
            devices: [],
            locations: [],
          } as unknown as ServerUserFullDetail
        }
        showServer={false}
        onSessionClick={vi.fn()}
        onShowSessions={vi.fn()}
      />
    );

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
    } as unknown as UserRangeStats;

    render(
      <OverviewTab
        stats={stats}
        isLoading={false}
        period="custom"
        detail={
          {
            user: { identityName: null },
            identity: { username: 'alice' },
            sessions: { data: [], total: 0 },
            devices: [],
            locations: [],
          } as unknown as ServerUserFullDetail
        }
        showServer={false}
        onSessionClick={vi.fn()}
        onShowSessions={vi.fn()}
      />
    );

    const [prior] = charted[charted.length - 1] ?? [];
    expect(prior?.data.map((point) => point.date)).toEqual([
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
    ]);
  });
});
