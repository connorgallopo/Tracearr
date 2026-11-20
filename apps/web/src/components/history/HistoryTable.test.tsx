import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ComponentProps } from 'react';
import type { SessionWithDetails } from '@tracearr/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { HistoryTable } from './HistoryTable';
import { DEFAULT_COLUMN_VISIBILITY } from './historyColumns';

const { t } = vi.hoisted(() => ({ t: vi.fn((key: string) => key) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

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
  options?: Pick<
    ComponentProps<typeof HistoryTable>,
    'sortBy' | 'sortDir' | 'onSortChange' | 'profileNames' | 'isMultiServer'
  >
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
          {...options}
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

  it('names the profile in its own column when given the names', () => {
    renderTable({ profileId: 'p-robin' }, undefined, {
      profileNames: new Map([['p-robin', 'Robin']]),
    });

    expect(screen.getByRole('columnheader', { name: 'labels.profile' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Robin' })).toBeInTheDocument();
  });

  it('names a play whose profile has no row by the name it stored', () => {
    renderTable({ profileId: null, profileName: 'Kids' }, undefined, { profileNames: new Map() });

    expect(screen.getByRole('cell', { name: 'Kids' })).toBeInTheDocument();
  });

  it('shows the missing-value marker for a play with no profile', () => {
    renderTable({ profileId: null }, undefined, { profileNames: new Map() });
    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent);
    const cells = screen.getAllByRole('cell');
    expect(cells[headers.indexOf('labels.profile')]).toHaveTextContent(/^\u2014$/);
  });

  it('mutes a removed profile over the account avatar and says so in its title', () => {
    renderTable({ nonMainProfile: { name: 'Sam', thumbUrl: null, removed: true } });

    const profile = screen.getByRole('img', { name: 'labels.profileRemoved' });
    expect(profile).toHaveAttribute('title', 'labels.profileRemoved');
    expect(t).toHaveBeenCalledWith('labels.profileRemoved', { name: 'Sam' });
    expect(screen.getByRole('link', { name: /alice/ })).not.toHaveTextContent('Sam');
  });

  it('keeps room for the content column past the fixed columns, so a narrow window scrolls', () => {
    renderTable({}, undefined, { isMultiServer: true, profileNames: new Map() });

    const fixedWidth = screen
      .getAllByRole('columnheader')
      .filter((header) => header.style.width.endsWith('px'))
      .reduce((sum, header) => sum + parseFloat(header.style.width), 0);
    const tableMinWidth = parseFloat(screen.getByRole('table').style.minWidth);
    expect(tableMinWidth - fixedWidth).toBeGreaterThanOrEqual(280);
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
