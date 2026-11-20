import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { History } from './History';
import type { HistoryFilters } from '@/hooks/queries';
import type { TimeRangeValue } from '@/components/ui/time-range-picker';
import type { ColumnVisibility, HistoryColumnId } from '@/components/history/historyColumns';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const queries = vi.hoisted(() => ({
  useHistorySessions: vi.fn((_filters: unknown) => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  })),
  useHistoryAggregates: vi.fn((_filters: unknown) => ({
    isLoading: false,
    isFetching: false,
    isError: false,
  })),
}));

vi.mock('@/hooks/queries', () => ({
  useHistorySessions: queries.useHistorySessions,
  useHistoryAggregates: queries.useHistoryAggregates,
  useFilterOptions: () => ({ data: undefined, isLoading: false }),
  useSession: () => ({ data: undefined }),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { role: 'owner' } }) }));
vi.mock('@/hooks/useServer', () => ({
  useServer: () => ({ selectedServerIds: [], isMultiServer: false }),
}));

const bar = vi.hoisted(() => ({
  props: null as null | {
    filters: HistoryFilters;
    onFiltersChange: (filters: HistoryFilters) => void;
    onTimeRangeChange: (range: TimeRangeValue) => void;
    columnVisibility: ColumnVisibility;
    onColumnToggle: (column: HistoryColumnId, shown: boolean) => void;
  },
}));

vi.mock('@/components/history/HistoryFilters', () => ({
  HistoryFiltersBar: (props: NonNullable<typeof bar.props>) => {
    bar.props = props;
    return null;
  },
}));
const table = vi.hoisted(() => ({
  onSortChange: null as null | ((column: 'startedAt' | 'durationMs' | 'mediaTitle') => void),
}));

vi.mock('@/components/history/HistoryTable', () => ({
  HistoryTable: (props: { onSortChange: NonNullable<typeof table.onSortChange> }) => {
    table.onSortChange = props.onSortChange;
    return null;
  },
}));
vi.mock('@/components/history/HistoryAggregates', () => ({ HistoryAggregates: () => null }));
vi.mock('@/components/history/SessionDetailSheet', () => ({ SessionDetailSheet: () => null }));

function LocationProbe() {
  return <output data-testid="search">{useLocation().search}</output>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <History />
      <LocationProbe />
    </MemoryRouter>
  );
}

function writtenParams(view: ReturnType<typeof render>) {
  return new URLSearchParams(view.getByTestId('search').textContent ?? '');
}

function queriedWindowDays(url: string): number {
  queries.useHistorySessions.mockClear();
  render(
    <MemoryRouter initialEntries={[url]}>
      <History />
    </MemoryRouter>
  );
  const filters = queries.useHistorySessions.mock.calls[0]?.[0] as HistoryFilters;
  const end = filters.endDate?.getTime() ?? Date.now();
  return Math.round((end - filters.startDate!.getTime()) / 86_400_000);
}

describe('History date window', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to 30 days with no period in the URL', () => {
    expect(queriedWindowDays('/history')).toBe(30);
  });

  it('queries a 7-day window when the sidebar carries period=week', () => {
    expect(queriedWindowDays('/history?period=week')).toBe(7);
  });

  it('uses the custom range dates through the whole last day', () => {
    expect(queriedWindowDays('/history?period=custom&from=2026-10-01&to=2026-10-11')).toBe(11);
  });

  it('leaves the window open for period=all', () => {
    queries.useHistorySessions.mockClear();
    render(
      <MemoryRouter initialEntries={['/history?period=all']}>
        <History />
      </MemoryRouter>
    );
    const filters = queries.useHistorySessions.mock.calls[0]?.[0] as HistoryFilters;
    expect(filters.startDate).toBeUndefined();
  });

  it('ignores the old startDate and endDate params', () => {
    const url =
      '/history?period=week&startDate=2026-01-01T00:00:00.000Z&endDate=2026-01-21T00:00:00.000Z';
    expect(queriedWindowDays(url)).toBe(7);
  });
});

describe('History URL params', () => {
  it('writes period, from and to for a custom range and nothing else for dates', () => {
    const view = renderAt('/history?search=alice');

    act(() =>
      bar.props?.onTimeRangeChange({
        period: 'custom',
        startDate: new Date(2026, 9, 1),
        endDate: new Date(2026, 9, 11),
      })
    );

    const params = writtenParams(view);
    expect(params.get('period')).toBe('custom');
    expect(params.get('from')).toBe('2026-10-01');
    expect(params.get('to')).toBe('2026-10-11');
    expect(params.get('search')).toBe('alice');
    expect(params.has('startDate')).toBe(false);
    expect(params.has('endDate')).toBe(false);
  });

  it('keeps the range params when another filter changes', () => {
    const view = renderAt('/history?period=custom&from=2026-10-01&to=2026-10-11');

    act(() => bar.props?.onFiltersChange({ ...bar.props.filters, search: 'alice' }));

    const params = writtenParams(view);
    expect(params.get('period')).toBe('custom');
    expect(params.get('from')).toBe('2026-10-01');
    expect(params.get('to')).toBe('2026-10-11');
    expect(params.get('search')).toBe('alice');
    expect(params.has('startDate')).toBe(false);
    expect(params.has('endDate')).toBe(false);
  });

  it('writes period=all when the filters carry no window', () => {
    const view = renderAt('/history?period=custom&from=2026-10-01&to=2026-10-11');

    act(() => bar.props?.onFiltersChange({}));

    const params = writtenParams(view);
    expect(params.get('period')).toBe('all');
    expect(params.has('from')).toBe(false);
  });
});

describe('History location params', () => {
  function queriedFilters(url: string): HistoryFilters {
    queries.useHistorySessions.mockClear();
    renderAt(url);
    return queries.useHistorySessions.mock.calls[0]?.[0] as HistoryFilters;
  }

  it('queries the exact city and region from the URL', () => {
    const filters = queriedFilters(
      '/history?city=Z%C3%BCrich&region=Rh%C3%B4ne-Alpes%20%26%20Co&countries=CH'
    );
    expect(filters).toMatchObject({
      geoCity: 'Zürich',
      geoRegion: 'Rhône-Alpes & Co',
      geoCountries: ['CH'],
    });
  });

  it('queries a missing city and region from noCity and noRegion', () => {
    const filters = queriedFilters('/history?countries=DE&noCity=true&noRegion=true');
    expect(filters).toMatchObject({ geoCityMissing: true, geoRegionMissing: true });
    expect(filters.geoCity).toBeUndefined();
  });

  it('keeps the location keys when another filter changes', () => {
    const view = renderAt(
      '/history?city=Z%C3%BCrich&region=Rh%C3%B4ne-Alpes%20%26%20Co&countries=CH&noCity=true&noRegion=true'
    );

    act(() => bar.props?.onFiltersChange({ ...bar.props.filters, search: 'alice' }));

    const params = writtenParams(view);
    expect(params.get('city')).toBe('Zürich');
    expect(params.get('region')).toBe('Rhône-Alpes & Co');
    expect(params.get('noCity')).toBe('true');
    expect(params.get('noRegion')).toBe('true');
    expect(params.get('search')).toBe('alice');
  });

  it('drops only the removed location key', () => {
    const view = renderAt('/history?city=Ogden&region=Utah&countries=US');

    act(() => {
      const { geoCity: _, ...rest } = bar.props?.filters ?? {};
      bar.props?.onFiltersChange(rest);
    });

    const params = writtenParams(view);
    expect(params.has('city')).toBe(false);
    expect(params.get('region')).toBe('Utah');
    expect(params.get('countries')).toBe('US');
  });
});

describe('History aggregates', () => {
  it('keeps the aggregates query key when the sort changes', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
      queries.useHistoryAggregates.mockClear();
      renderAt('/history?period=week');
      const before = queries.useHistoryAggregates.mock.lastCall?.[0];

      vi.setSystemTime(new Date('2026-10-18T12:05:00Z'));
      act(() => table.onSortChange?.('durationMs'));

      expect(queries.useHistorySessions.mock.lastCall?.[0]).toMatchObject({
        orderBy: 'durationMs',
      });
      expect(queries.useHistoryAggregates.mock.lastCall?.[0]).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('History column choices', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const tableWidth = (width: number) =>
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
  const shownProgress = () => bar.props?.columnVisibility.progress;

  it('lets a column turned on at a wide width drop out once the table is narrow', () => {
    localStorage.setItem('tracearr-history-columns', JSON.stringify({ progress: false }));
    tableWidth(2000);
    const { unmount } = renderAt('/history');
    act(() => bar.props?.onColumnToggle('progress', true));
    expect(shownProgress()).toBe(true);
    unmount();

    tableWidth(1000);
    renderAt('/history');
    expect(shownProgress()).toBe(false);
  });

  it('keeps a column turned on while the table is narrow', () => {
    tableWidth(1000);
    const { unmount } = renderAt('/history');
    expect(shownProgress()).toBe(false);
    act(() => bar.props?.onColumnToggle('progress', true));
    expect(shownProgress()).toBe(true);
    unmount();

    renderAt('/history');
    expect(shownProgress()).toBe(true);
  });

  it('keeps a column the table only fits without, when it is turned on', () => {
    localStorage.setItem(
      'tracearr-history-columns',
      JSON.stringify({ quality: false, progress: false })
    );
    tableWidth(1050);
    renderAt('/history');
    act(() => bar.props?.onColumnToggle('progress', true));

    expect(shownProgress()).toBe(true);
  });

  it('hands a kept column back to the narrow rule when unchecked, so a wide table still shows it', () => {
    tableWidth(1000);
    const { unmount } = renderAt('/history');
    act(() => bar.props?.onColumnToggle('progress', true));
    act(() => bar.props?.onColumnToggle('progress', false));
    expect(shownProgress()).toBe(false);
    unmount();

    tableWidth(2000);
    renderAt('/history');
    expect(shownProgress()).toBe(true);
  });
});
