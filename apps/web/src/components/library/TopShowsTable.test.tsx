import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TopShow, TopShowsResponse } from '@tracearr/shared';
import { TopShowsTable } from './TopShowsTable';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/server', () => ({ ServerBadge: () => null }));

const show = (mediaId: string, year: number): TopShow => ({
  mediaId,
  showTitle: 'Harbor Lights',
  year,
  thumbPath: null,
  serverId: 'srv-1',
  serverIds: ['srv-1'],
  totalEpisodeViews: 4,
  totalWatchHours: 3,
  uniqueViewers: 1,
  avgCompletionRate: 50,
  episodesPerViewer: 2,
});

const data: TopShowsResponse = {
  items: [show('show-1', 1998), show('show-2', 2024)],
  summary: { totalShows: 2, totalWatchHours: 6 },
  pagination: { page: 1, pageSize: 10, total: 2 },
};

describe('TopShowsTable', () => {
  it('renders two shows that share a title as two rows', () => {
    render(
      <TopShowsTable
        data={data}
        page={1}
        onPageChange={() => undefined}
        sortBy="plays"
        sortOrder="desc"
        onSortChange={() => undefined}
      />
    );
    expect(screen.getAllByText('Harbor Lights')).toHaveLength(2);
    expect(screen.getByText('(1998)')).toBeInTheDocument();
    expect(screen.getByText('(2024)')).toBeInTheDocument();
  });

  it('shows episodes per viewer to one decimal and sorts by it', async () => {
    const onSortChange = vi.fn();
    render(
      <TopShowsTable
        data={{ ...data, items: [{ ...show('show-1', 1998), episodesPerViewer: 4 }] }}
        page={1}
        onPageChange={() => undefined}
        sortBy="plays"
        sortOrder="desc"
        onSortChange={onSortChange}
      />
    );
    expect(screen.getByText('4.0')).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'library.watch.binge.columns.episodesPerViewer' })
    );
    expect(onSortChange).toHaveBeenCalledWith('episodes_per_viewer', 'desc');
  });
});
