import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ComponentProps } from 'react';
import type { SessionWithDetails } from '@tracearr/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { HistoryTable } from './HistoryTable';
import { DEFAULT_COLUMN_VISIBILITY } from './HistoryFilters';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useServerColorMap', () => ({ useServerColorMap: () => new Map() }));

// jsdom cannot lay out the real scroll container, so every row is rendered.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => options.count * options.estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: index,
        start: index * options.estimateSize(),
        size: options.estimateSize(),
      })),
    measureElement: vi.fn(),
  }),
}));

function renderTable(
  overrides: Partial<SessionWithDetails>,
  onSessionClick?: (session: SessionWithDetails) => void,
  sort?: Pick<ComponentProps<typeof HistoryTable>, 'sortBy' | 'sortDir' | 'onSortChange'>
) {
  const session = {
    id: 'session-1',
    serverId: 'server-1',
    serverUserId: 'su-1',
    server: { id: 'server-1', name: 'Jelly', type: 'jellyfin' },
    user: { id: 'su-1', username: 'alice', thumbUrl: null, identityName: null },
    state: 'stopped',
    mediaType: 'movie',
    mediaTitle: 'Heat',
    startedAt: new Date('2024-01-01T20:00:00Z'),
    stoppedAt: new Date('2024-01-01T21:55:00Z'),
    durationMs: 6_900_000,
    totalDurationMs: 7_200_000,
    watched: true,
    geoLat: null,
    geoLon: null,
    ...overrides,
  } as unknown as SessionWithDetails;

  return render(
    <MemoryRouter>
      <TooltipProvider>
        <HistoryTable
          sessions={[session]}
          onSessionClick={onSessionClick}
          columnVisibility={{ ...DEFAULT_COLUMN_VISIBILITY, progress: true }}
          {...sort}
        />
      </TooltipProvider>
    </MemoryRouter>
  );
}

describe('HistoryTable', () => {
  it('shows no percentage and no engagement badge for a play with a length but no position', () => {
    renderTable({ progressMs: null });

    expect(screen.getByText('Heat')).toBeInTheDocument();
    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();
    expect(screen.queryByText('pages:yourStats.tier.abandoned')).not.toBeInTheDocument();
  });

  it('shows 0% and the abandoned badge for a play whose position is a measured 0', () => {
    renderTable({ progressMs: 0 });

    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByText('pages:yourStats.tier.abandoned')).toBeInTheDocument();
  });

  it('says played on a finished track and watched on a finished episode', () => {
    const { unmount } = renderTable({
      mediaType: 'track',
      progressMs: 200_000,
      totalDurationMs: 210_000,
    });
    expect(screen.getByText('common:playback.played')).toBeInTheDocument();
    expect(screen.queryByText('common:playback.watched')).not.toBeInTheDocument();
    unmount();

    renderTable({ mediaType: 'episode', progressMs: 2_500_000, totalDurationMs: 2_700_000 });
    expect(screen.getByText('common:playback.watched')).toBeInTheDocument();
  });

  it('marks a play with several segments by its count, and a single one not at all', () => {
    const { unmount } = renderTable({ segmentCount: 3 });
    expect(screen.getByLabelText('count.segment')).toHaveTextContent('3');
    unmount();

    renderTable({ segmentCount: 1 });
    expect(screen.queryByLabelText('count.segment')).not.toBeInTheDocument();
  });

  it('sorts the data table from its date header', () => {
    const onSortChange = vi.fn();
    renderTable({}, undefined, { sortBy: 'startedAt', sortDir: 'desc', onSortChange });

    const dateHeader = screen.getByRole('columnheader', { name: 'labels.date' });
    expect(dateHeader).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(screen.getByRole('button', { name: 'labels.date' }));
    expect(onSortChange).toHaveBeenCalledWith('startedAt');
  });

  it('heads the empty table with translated column names and empty copy', () => {
    render(
      <MemoryRouter>
        <TooltipProvider>
          <HistoryTable sessions={[]} columnVisibility={DEFAULT_COLUMN_VISIBILITY} />
        </TooltipProvider>
      </MemoryRouter>
    );

    expect(screen.getByRole('columnheader', { name: 'labels.date' })).toBeInTheDocument();
    expect(screen.getByText('empty.noSessionsFound')).toBeInTheDocument();
    expect(screen.getByText('pages:violations.tryAdjustingFilters')).toBeInTheDocument();
  });

  it('links the show and the episode without opening the row', () => {
    const onSessionClick = vi.fn();
    renderTable(
      {
        mediaType: 'episode',
        mediaTitle: 'Pilot',
        grandparentTitle: 'Lost',
        seasonNumber: 1,
        episodeNumber: 2,
        mediaId: 'episode-1',
        showMediaId: 'show-1',
      },
      onSessionClick
    );

    expect(screen.getByRole('link', { name: 'Lost' })).toHaveAttribute('href', '/media/show-1');
    fireEvent.click(screen.getByRole('link', { name: /Pilot/ }));

    expect(screen.getByRole('link', { name: /Pilot/ })).toHaveAttribute('href', '/media/episode-1');
    expect(onSessionClick).not.toHaveBeenCalled();
  });
});
