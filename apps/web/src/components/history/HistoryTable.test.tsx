import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
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
  onSessionClick?: (session: SessionWithDetails) => void
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
    expect(screen.queryByText('Abandoned')).not.toBeInTheDocument();
  });

  it('shows 0% and the abandoned badge for a play whose position is a measured 0', () => {
    renderTable({ progressMs: 0 });

    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByText('Abandoned')).toBeInTheDocument();
  });

  it('lets long content titles shrink within the content column', () => {
    renderTable({ mediaTitle: 'A very long media title that should not overlap the next column' });

    const title = screen.getByText('A very long media title that should not overlap the next column');
    expect(title.closest('span')).toHaveClass('min-w-0', 'flex-1', 'truncate');
  });

  it('keeps fixed-width columns from collapsing into each other on narrow screens', () => {
    renderTable({ mediaTitle: 'Pilot' });

    const table = screen.getByRole('table');
    expect(table).toHaveClass('min-w-[1070px]', 'table-fixed');
    expect(table.parentElement).toHaveClass('overflow-auto');
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
