import { beforeAll, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { initI18n } from '@tracearr/translations';
import type { HistoryFilterOptions } from '@tracearr/shared';
import { HistoryFiltersBar, DEFAULT_COLUMN_VISIBILITY } from './HistoryFilters';
import type { HistoryFilters } from '@/hooks/queries/useHistory';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const mergedPerson = {
  id: 'su-representative',
  username: 'alice_plex',
  thumbUrl: null,
  serverId: 'server-1',
  identityName: 'Alice',
  serverUserIds: ['su-representative', 'su-secondary'],
};

const soloPerson = {
  id: 'su-bob',
  username: 'bob',
  thumbUrl: null,
  serverId: 'server-1',
  identityName: null,
  serverUserIds: ['su-bob'],
};

const filterOptions: HistoryFilterOptions = {
  platforms: [],
  products: [],
  devices: [],
  countries: [],
  cities: [],
  users: [mergedPerson, soloPerson],
  profiles: [],
};

function renderBar(
  filters: HistoryFilters,
  overrides: Partial<HistoryFilters> = {},
  isFetching?: boolean
) {
  const onFiltersChange = vi.fn();
  const view = render(
    <HistoryFiltersBar
      filters={{ ...filters, ...overrides }}
      onFiltersChange={onFiltersChange}
      timeRange={{ period: 'month' }}
      onTimeRangeChange={vi.fn()}
      filterOptions={filterOptions}
      columnVisibility={DEFAULT_COLUMN_VISIBILITY}
      onColumnVisibilityChange={vi.fn()}
      isFetching={isFetching}
    />
  );
  return { onFiltersChange, container: view.container };
}

describe('HistoryFiltersBar', () => {
  it('shows one chip for a merged person even though both of their account ids are selected', () => {
    renderBar({ serverUserIds: ['su-representative', 'su-secondary'] });

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
  });

  it('toggling the merged person on adds both of their account ids to the filter', async () => {
    const { onFiltersChange } = renderBar({});

    await userEvent.click(screen.getByRole('button', { name: /filters/i }));
    await waitFor(() => expect(screen.getByText('Users')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Users'));
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Alice'));

    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUserIds: expect.arrayContaining(['su-representative', 'su-secondary']),
      })
    );
    const calls = onFiltersChange.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as HistoryFilters;
    expect(lastCall.serverUserIds).toHaveLength(2);
  });

  it('toggling an already-selected merged person off removes both of their account ids', async () => {
    const { onFiltersChange } = renderBar({
      serverUserIds: ['su-representative', 'su-secondary', 'su-bob'],
    });

    await userEvent.click(screen.getByRole('button', { name: /filters/i }));
    await waitFor(() => expect(screen.getByText('Users')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Users'));
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Alice'));

    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ serverUserIds: ['su-bob'] })
    );
  });

  it('shows the refresh indicator while a background fetch is in flight', () => {
    const { container } = renderBar({}, {}, true);

    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('hides the refresh indicator once no fetch is in flight', () => {
    const { container } = renderBar({}, {}, false);

    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
  });

  it('sets the network filter from the menu', async () => {
    const { onFiltersChange } = renderBar({});

    await userEvent.click(screen.getByRole('button', { name: /filters/i }));
    await waitFor(() => expect(screen.getByText('Network')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Local' }));

    expect(onFiltersChange).toHaveBeenLastCalledWith(expect.objectContaining({ network: 'local' }));
  });

  it('clears the network filter when the selected option is clicked again', async () => {
    const { onFiltersChange } = renderBar({ network: 'local' });

    await userEvent.click(screen.getByRole('button', { name: /filters/i }));
    await waitFor(() => expect(screen.getByText('Network')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Local' }));

    const calls = onFiltersChange.mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as HistoryFilters;
    expect(lastCall.network).toBeUndefined();
  });

  it('lets the user pick trailers', async () => {
    const { onFiltersChange } = renderBar({});

    await userEvent.click(screen.getByRole('button', { name: /filters/i }));
    await waitFor(() => expect(screen.getByText('Network')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Trailers' }));

    expect(onFiltersChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mediaTypes: ['trailer'] })
    );
  });

  const renderMemberBar = () =>
    render(
      <HistoryFiltersBar
        filters={{}}
        onFiltersChange={vi.fn()}
        timeRange={{ period: 'month' }}
        onTimeRangeChange={vi.fn()}
        filterOptions={filterOptions}
        columnVisibility={DEFAULT_COLUMN_VISIBILITY}
        onColumnVisibilityChange={vi.fn()}
        isMember
      />
    );

  it('has no Users filter for a member', async () => {
    renderMemberBar();

    await userEvent.click(screen.getByRole('button', { name: /Filters/ }));

    expect(screen.queryByText('Users')).not.toBeInTheDocument();
    expect(screen.getByText('Platforms')).toBeInTheDocument();
  });

  it('has no User column toggle for a member', async () => {
    renderMemberBar();

    await userEvent.click(screen.getByRole('button', { name: /Columns/ }));

    expect(screen.queryByRole('menuitemcheckbox', { name: 'User' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Date' })).toBeInTheDocument();
  });
  it('shows the city and region as chips and removes only the one clicked', async () => {
    const { onFiltersChange } = renderBar({
      geoCountries: ['US'],
      geoCity: 'Ogden',
      geoRegion: 'Utah',
    });

    const cityChip = screen.getByText('Ogden').closest('[data-slot="badge"]');
    expect(screen.getByText('Utah')).toBeInTheDocument();
    if (!(cityChip instanceof HTMLElement)) throw new Error('no city chip');
    await userEvent.click(within(cityChip).getByRole('button'));

    expect(onFiltersChange).toHaveBeenCalledWith({ geoCountries: ['US'], geoRegion: 'Utah' });
  });

  it('shows a missing city and region as Unknown chips', async () => {
    const { onFiltersChange } = renderBar({ geoCityMissing: true, geoRegionMissing: true });

    const chips = screen.getAllByText('Unknown');
    expect(chips).toHaveLength(2);
    const regionChip = chips[1]?.closest('[data-slot="badge"]');
    if (!(regionChip instanceof HTMLElement)) throw new Error('no region chip');
    await userEvent.click(within(regionChip).getByRole('button'));

    expect(onFiltersChange).toHaveBeenCalledWith({ geoCityMissing: true });
  });
});
