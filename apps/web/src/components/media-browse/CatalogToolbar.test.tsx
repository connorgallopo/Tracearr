import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatMediaTech } from '@tracearr/shared';
import {
  CatalogToolbar,
  DEFAULT_GRID_FILTERS,
  loadPersistedFilters,
  persistFilters,
  validatePersistedFilters,
  type PersistedGridFilters,
} from './CatalogToolbar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

describe('validatePersistedFilters', () => {
  it('drops a persisted server id that no longer exists', () => {
    const filters: PersistedGridFilters = { sort: 'title', serverId: 'gone-server' };
    const result = validatePersistedFilters(filters, {
      serverIds: ['srv-1', 'srv-2'],
      genres: undefined,
      libraryKeys: undefined,
    });
    expect(result.serverId).toBeUndefined();
  });

  it('keeps a persisted server id that still exists', () => {
    const filters: PersistedGridFilters = { sort: 'title', serverId: 'srv-1' };
    const result = validatePersistedFilters(filters, {
      serverIds: ['srv-1', 'srv-2'],
      genres: undefined,
      libraryKeys: undefined,
    });
    expect(result.serverId).toBe('srv-1');
  });

  it('drops an unknown genre once the genre list has loaded', () => {
    const filters: PersistedGridFilters = { sort: 'title', genre: 'Noir' };
    const result = validatePersistedFilters(filters, {
      serverIds: [],
      genres: ['Action', 'Comedy'],
      libraryKeys: undefined,
    });
    expect(result.genre).toBeUndefined();
  });

  it('skips genre validation while the genre list has not loaded yet', () => {
    const filters: PersistedGridFilters = { sort: 'title', genre: 'Noir' };
    const result = validatePersistedFilters(filters, {
      serverIds: [],
      genres: undefined,
      libraryKeys: undefined,
    });
    expect(result.genre).toBe('Noir');
  });

  it('drops a persisted library key that no longer resolves', () => {
    const filters: PersistedGridFilters = { sort: 'title', libraryKey: 'srv-1:lib-gone' };
    const result = validatePersistedFilters(filters, {
      serverIds: ['srv-1'],
      genres: undefined,
      libraryKeys: ['srv-1:lib-1'],
    });
    expect(result.libraryKey).toBeUndefined();
  });

  it('keeps a persisted library key that still resolves', () => {
    const filters: PersistedGridFilters = { sort: 'title', libraryKey: 'srv-1:lib-1' };
    const result = validatePersistedFilters(filters, {
      serverIds: ['srv-1'],
      genres: undefined,
      libraryKeys: ['srv-1:lib-1'],
    });
    expect(result.libraryKey).toBe('srv-1:lib-1');
  });

  it('skips library validation while the library list has not loaded yet', () => {
    const filters: PersistedGridFilters = { sort: 'title', libraryKey: 'srv-1:lib-1' };
    const result = validatePersistedFilters(filters, {
      serverIds: ['srv-1'],
      genres: undefined,
      libraryKeys: undefined,
    });
    expect(result.libraryKey).toBe('srv-1:lib-1');
  });

  it('drops a library key that belongs to a different server than the server filter', () => {
    const filters: PersistedGridFilters = {
      sort: 'title',
      serverId: 'srv-1',
      libraryKey: 'srv-2:lib-1',
    };
    const result = validatePersistedFilters(filters, {
      serverIds: ['srv-1', 'srv-2'],
      genres: undefined,
      libraryKeys: ['srv-2:lib-1'],
    });
    expect(result.serverId).toBe('srv-1');
    expect(result.libraryKey).toBeUndefined();
  });

  it('leaves other fields untouched', () => {
    const filters: PersistedGridFilters = {
      sort: 'added',
      resolution: '4K',
      yearFrom: 2000,
      serverId: 'srv-1',
    };
    const result = validatePersistedFilters(filters, {
      serverIds: ['srv-1'],
      genres: ['Action'],
      libraryKeys: undefined,
    });
    expect(result).toEqual(filters);
  });
});

describe('loadPersistedFilters / persistFilters', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns the defaults when nothing is persisted', () => {
    expect(loadPersistedFilters('movie')).toEqual(DEFAULT_GRID_FILTERS);
  });

  it('round-trips a persisted filter blob per media type', () => {
    const filters: PersistedGridFilters = { sort: 'added', genre: 'Action', yearFrom: 2010 };
    persistFilters('movie', filters);
    expect(loadPersistedFilters('movie')).toEqual(filters);
    expect(loadPersistedFilters('show')).toEqual(DEFAULT_GRID_FILTERS);
  });

  it('falls back to defaults on corrupted storage', () => {
    localStorage.setItem('tracearr_media_filters_movie', '{not json');
    expect(loadPersistedFilters('movie')).toEqual(DEFAULT_GRID_FILTERS);
  });
});

describe('CatalogToolbar', () => {
  const baseProps = {
    type: 'movie' as const,
    onTypeChange: vi.fn(),
    search: '',
    onSearchChange: vi.fn(),
    filters: DEFAULT_GRID_FILTERS,
    onFiltersChange: vi.fn(),
    genres: [],
    servers: [{ id: 'srv-1', name: 'Plex' }],
    libraries: [],
    videoCodecs: ['HEVC', 'H.264'],
    audioCodecs: ['EAC3', 'TRUEHD'],
    audioChannelOptions: ['Stereo', '5.1'],
    loadedCount: 10,
    totalItems: 100,
    totalFileSize: 5_000_000_000,
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers movies, TV shows and artists, and calls onTypeChange with the pick', async () => {
    const user = userEvent.setup();
    render(<CatalogToolbar {...baseProps} />);
    expect(screen.getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      'common:media.movie_plural',
      'common:media.tvShows',
      'common:media.artist_plural',
    ]);
    await user.click(screen.getByRole('radio', { name: 'common:media.artist_plural' }));
    expect(baseProps.onTypeChange).toHaveBeenCalledWith('artist');
  });

  it('leaves the watched, file and year filters and the year sort out for artists', async () => {
    const user = userEvent.setup();
    render(<CatalogToolbar {...baseProps} type="artist" />);

    await user.click(screen.getByRole('combobox', { name: 'media.grid.toolbar.sortLabel' }));
    expect(screen.queryByRole('option', { name: 'media.grid.toolbar.sort.year' })).toBeNull();
    expect(screen.getByRole('option', { name: 'media.grid.toolbar.sort.plays' })).toBeVisible();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: /media.grid.toolbar.filtersLabel/ }));
    for (const label of [
      'watchedLabel',
      'resolutionLabel',
      'videoCodecLabel',
      'hdrLabel',
      'audioCodecLabel',
      'audioChannelsLabel',
      'atmosLabel',
    ]) {
      expect(screen.queryByRole('combobox', { name: `media.grid.toolbar.${label}` })).toBeNull();
    }
    for (const label of ['yearFromLabel', 'yearToLabel', 'sizeGbMinLabel', 'sizeGbMaxLabel']) {
      expect(screen.queryByRole('spinbutton', { name: `media.grid.toolbar.${label}` })).toBeNull();
    }
    expect(screen.getByRole('combobox', { name: 'media.grid.toolbar.genreLabel' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'media.grid.toolbar.serverLabel' })).toBeVisible();
  });

  it('counts artists without a size on the artist grid', () => {
    render(<CatalogToolbar {...baseProps} type="artist" totalFileSize={0} />);
    expect(screen.getByText('media.genres.sheet.artistCount:{"count":100}')).toBeInTheDocument();
    expect(screen.queryByText(/countTotal/)).toBeNull();
  });

  it('debounces search input before calling onSearchChange', async () => {
    const onSearchChange = vi.fn();
    const user = userEvent.setup();
    render(<CatalogToolbar {...baseProps} onSearchChange={onSearchChange} />);
    const input = screen.getByLabelText('media.grid.toolbar.searchLabel');
    await user.type(input, 'dune');
    expect(onSearchChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onSearchChange).toHaveBeenCalledWith('dune'), { timeout: 1000 });
  });

  it('labels the watched filter chip plainly - watched always means anyone now, no per-identity lens', async () => {
    render(
      <CatalogToolbar {...baseProps} filters={{ ...DEFAULT_GRID_FILTERS, watched: 'unwatched' }} />
    );
    expect(screen.getByText('media.grid.toolbar.watched.unwatched')).toBeInTheDocument();
  });

  it('renders a chip for an active filter and removes it', async () => {
    const onFiltersChange = vi.fn();
    const user = userEvent.setup();
    render(
      <CatalogToolbar
        {...baseProps}
        filters={{ ...DEFAULT_GRID_FILTERS, resolution: '4K' }}
        onFiltersChange={onFiltersChange}
      />
    );
    expect(screen.getByText('4K')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', {
        name: 'common:filters.remove:{"label":"4K"}',
      })
    );
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: undefined })
    );
  });

  it('renders an HDR chip and removes it', async () => {
    const onFiltersChange = vi.fn();
    const user = userEvent.setup();
    render(
      <CatalogToolbar
        {...baseProps}
        filters={{ ...DEFAULT_GRID_FILTERS, hdr: true }}
        onFiltersChange={onFiltersChange}
      />
    );
    expect(screen.getByText('media.grid.toolbar.hdrChip')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', {
        name: 'common:filters.remove:{"label":"media.grid.toolbar.hdrChip"}',
      })
    );
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ hdr: undefined }));
  });

  it('renders an Atmos chip and removes it', async () => {
    const onFiltersChange = vi.fn();
    const user = userEvent.setup();
    render(
      <CatalogToolbar
        {...baseProps}
        filters={{ ...DEFAULT_GRID_FILTERS, atmos: true }}
        onFiltersChange={onFiltersChange}
      />
    );
    expect(screen.getByText('media.grid.toolbar.atmosChip')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', {
        name: 'common:filters.remove:{"label":"media.grid.toolbar.atmosChip"}',
      })
    );
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ atmos: undefined }));
  });

  it('renders a codec chip with the chart display name and removes it', async () => {
    const onFiltersChange = vi.fn();
    const user = userEvent.setup();
    const label = formatMediaTech('TRUEHD');
    render(
      <CatalogToolbar
        {...baseProps}
        filters={{ ...DEFAULT_GRID_FILTERS, audioCodec: 'TRUEHD' }}
        onFiltersChange={onFiltersChange}
      />
    );
    expect(screen.getByText(label)).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: `common:filters.remove:{"label":"${label}"}` })
    );
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ audioCodec: undefined })
    );
  });

  it('renders a library chip using the server and library name, and removes it', async () => {
    const onFiltersChange = vi.fn();
    const user = userEvent.setup();
    render(
      <CatalogToolbar
        {...baseProps}
        libraries={[
          {
            serverId: 'srv-1',
            serverName: 'Plex',
            libraryId: 'lib-1',
            name: 'Movies',
            mediaType: 'movie',
          },
        ]}
        filters={{ ...DEFAULT_GRID_FILTERS, libraryKey: 'srv-1:lib-1' }}
        onFiltersChange={onFiltersChange}
      />
    );
    expect(screen.getByText('Plex - Movies')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', {
        name: 'common:filters.remove:{"label":"Plex - Movies"}',
      })
    );
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ libraryKey: undefined })
    );
  });

  it('renders a size-on-disk range chip when both bounds are set', () => {
    render(
      <CatalogToolbar
        {...baseProps}
        filters={{ ...DEFAULT_GRID_FILTERS, sizeGbMin: 5, sizeGbMax: 50 }}
      />
    );
    expect(
      screen.getByText('media.grid.toolbar.sizeChipRange:{"min":5,"max":50}')
    ).toBeInTheDocument();
  });

  it('renders a size-on-disk minimum-only chip and removes both bounds together', async () => {
    const onFiltersChange = vi.fn();
    const user = userEvent.setup();
    render(
      <CatalogToolbar
        {...baseProps}
        filters={{ ...DEFAULT_GRID_FILTERS, sizeGbMin: 5 }}
        onFiltersChange={onFiltersChange}
      />
    );
    const label = 'media.grid.toolbar.sizeChipAtLeast:{"min":5}';
    expect(screen.getByText(label)).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', {
        name: `common:filters.remove:${JSON.stringify({ label })}`,
      })
    );
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ sizeGbMin: undefined, sizeGbMax: undefined })
    );
  });

  it('renders an added-range chip and removes the range', async () => {
    const onFiltersChange = vi.fn();
    const user = userEvent.setup();
    render(
      <CatalogToolbar
        {...baseProps}
        filters={{ ...DEFAULT_GRID_FILTERS, added: { from: '2026-10-01' } }}
        onFiltersChange={onFiltersChange}
      />
    );
    const chip = screen.getByText(/^media\.grid\.toolbar\.addedLabel: common:filters\.dateAfter/);
    await user.click(
      screen.getByRole('button', {
        name: `common:filters.remove:${JSON.stringify({ label: chip.textContent })}`,
      })
    );
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ added: undefined }));
  });

  it('shows the active filter count including HDR, library and size-on-disk', () => {
    render(
      <CatalogToolbar
        {...baseProps}
        filters={{ ...DEFAULT_GRID_FILTERS, hdr: true, libraryKey: 'srv-1:lib-1', sizeGbMin: 5 }}
      />
    );
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('passes count (not total) to the count line so i18next plural forms resolve', () => {
    render(<CatalogToolbar {...baseProps} />);
    expect(
      screen.getByText('media.grid.toolbar.countTotal:{"count":100,"size":"4.7 GB"}')
    ).toBeInTheDocument();
  });

  it('opens the filters popover and toggles HDR only', async () => {
    const onFiltersChange = vi.fn();
    const user = userEvent.setup();
    render(<CatalogToolbar {...baseProps} onFiltersChange={onFiltersChange} />);
    await user.click(screen.getByRole('button', { name: /media.grid.toolbar.filtersLabel/ }));
    await user.click(screen.getByLabelText('media.grid.toolbar.hdrLabel'));
    await user.click(await screen.findByText('media.grid.toolbar.hdrOnly'));
    expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ hdr: true }));
  });

  it('debounces size-on-disk inputs before calling onFiltersChange', async () => {
    const onFiltersChange = vi.fn();
    const user = userEvent.setup();
    render(<CatalogToolbar {...baseProps} onFiltersChange={onFiltersChange} />);
    await user.click(screen.getByRole('button', { name: /media.grid.toolbar.filtersLabel/ }));
    const input = await screen.findByLabelText('media.grid.toolbar.sizeGbMinLabel');
    await user.type(input, '5');
    expect(onFiltersChange).not.toHaveBeenCalled();
    await waitFor(
      () => expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ sizeGbMin: 5 })),
      { timeout: 1000 }
    );
  });

  it('swaps inverted size bounds and clamps values past the schema max', async () => {
    const onFiltersChange = vi.fn();
    const user = userEvent.setup();
    render(
      <CatalogToolbar
        {...baseProps}
        filters={{ sort: 'title', sizeGbMin: 50 }}
        onFiltersChange={onFiltersChange}
      />
    );
    await user.click(screen.getByRole('button', { name: /media.grid.toolbar.filtersLabel/ }));
    const maxInput = await screen.findByLabelText('media.grid.toolbar.sizeGbMaxLabel');
    await user.type(maxInput, '5');
    await waitFor(
      () =>
        expect(onFiltersChange).toHaveBeenCalledWith(
          expect.objectContaining({ sizeGbMin: 5, sizeGbMax: 50 })
        ),
      { timeout: 1000 }
    );

    onFiltersChange.mockClear();
    await user.clear(maxInput);
    await user.type(maxInput, '99999');
    await waitFor(
      () =>
        expect(onFiltersChange).toHaveBeenCalledWith(expect.objectContaining({ sizeGbMax: 10000 })),
      { timeout: 1000 }
    );
  });

  it("only offers the selected server's libraries and clears a cross-server library filter", async () => {
    const onFiltersChange = vi.fn();
    const user = userEvent.setup();
    const twoServers = [
      { id: 'srv-1', name: 'Plex' },
      { id: 'srv-2', name: 'Jellyfin' },
    ];
    const twoLibraries = [
      {
        serverId: 'srv-1',
        serverName: 'Plex',
        libraryId: 'lib-1',
        name: 'Movies',
        mediaType: 'movie',
      },
      {
        serverId: 'srv-2',
        serverName: 'Jellyfin',
        libraryId: 'lib-2',
        name: 'Films',
        mediaType: 'movies',
      },
    ];
    const { rerender } = render(
      <CatalogToolbar
        {...baseProps}
        servers={twoServers}
        libraries={twoLibraries}
        filters={{ sort: 'title', serverId: 'srv-1' }}
        onFiltersChange={onFiltersChange}
      />
    );
    await user.click(screen.getByRole('button', { name: /media.grid.toolbar.filtersLabel/ }));
    await user.click(screen.getByLabelText('media.grid.toolbar.libraryLabel'));
    expect(await screen.findByText('Movies')).toBeInTheDocument();
    expect(screen.queryByText('Films')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    rerender(
      <CatalogToolbar
        {...baseProps}
        servers={twoServers}
        libraries={twoLibraries}
        filters={{ sort: 'title', libraryKey: 'srv-2:lib-2' }}
        onFiltersChange={onFiltersChange}
      />
    );
    await user.click(screen.getByLabelText('media.grid.toolbar.serverLabel'));
    await user.click(await screen.findByRole('option', { name: 'Plex' }));
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'srv-1', libraryKey: undefined })
    );
  });

  it('groups the library select by server when more than one server has libraries', async () => {
    const user = userEvent.setup();
    render(
      <CatalogToolbar
        {...baseProps}
        servers={[
          { id: 'srv-1', name: 'Plex' },
          { id: 'srv-2', name: 'Jellyfin' },
        ]}
        libraries={[
          {
            serverId: 'srv-1',
            serverName: 'Plex',
            libraryId: 'lib-1',
            name: 'Movies',
            mediaType: 'movie',
          },
          {
            serverId: 'srv-2',
            serverName: 'Jellyfin',
            libraryId: 'lib-2',
            name: 'Films',
            mediaType: 'movies',
          },
        ]}
      />
    );
    await user.click(screen.getByRole('button', { name: /media.grid.toolbar.filtersLabel/ }));
    await user.click(screen.getByLabelText('media.grid.toolbar.libraryLabel'));
    expect(await screen.findByText('Plex')).toBeInTheDocument();
    expect(screen.getByText('Jellyfin')).toBeInTheDocument();
  });

  it('merges a debounced year commit onto the latest filters instead of a stale snapshot', async () => {
    const user = userEvent.setup();
    const commits = vi.fn();
    function Wrapper() {
      const [filters, setFilters] = useState<PersistedGridFilters>(DEFAULT_GRID_FILTERS);
      return (
        <CatalogToolbar
          {...baseProps}
          filters={filters}
          onFiltersChange={(next) => {
            commits(next);
            setFilters(next);
          }}
        />
      );
    }
    render(<Wrapper />);
    await user.click(screen.getByRole('button', { name: /media.grid.toolbar.filtersLabel/ }));
    const yearFromInput = await screen.findByLabelText('media.grid.toolbar.yearFromLabel');
    await user.type(yearFromInput, '2015');
    // HDR commits immediately, inside the year debounce's 400ms window.
    await user.click(screen.getByLabelText('media.grid.toolbar.hdrLabel'));
    await user.click(await screen.findByText('media.grid.toolbar.hdrOnly'));

    await waitFor(
      () => {
        const calls = commits.mock.calls;
        const lastCommit = calls[calls.length - 1]?.[0] as PersistedGridFilters | undefined;
        expect(lastCommit).toMatchObject({ hdr: true, yearFrom: 2015 });
      },
      { timeout: 1000 }
    );
  });

  it('does not render the library select when there are no libraries', async () => {
    const user = userEvent.setup();
    render(<CatalogToolbar {...baseProps} libraries={[]} />);
    await user.click(screen.getByRole('button', { name: /media.grid.toolbar.filtersLabel/ }));
    expect(await screen.findByLabelText('media.grid.toolbar.hdrLabel')).toBeInTheDocument();
    expect(screen.queryByLabelText('media.grid.toolbar.libraryLabel')).not.toBeInTheDocument();
  });

  it('badges a historical server in the server select and lists it after live ones', async () => {
    const user = userEvent.setup();
    render(
      <CatalogToolbar
        {...baseProps}
        servers={[
          { id: 'srv-old', name: 'Old Plex', historicalAt: '2026-09-01T12:00:00.000Z' },
          { id: 'srv-1', name: 'Plex', historicalAt: null },
        ]}
      />
    );
    await user.click(screen.getByRole('button', { name: /media.grid.toolbar.filtersLabel/ }));
    await user.click(screen.getByRole('combobox', { name: 'media.grid.toolbar.serverLabel' }));

    const names = screen.getAllByRole('option').map((option) => option.textContent);
    expect(names.slice(1)).toEqual(['Plex', 'Old Plexcommon:serverSelector.historical']);
  });
});
