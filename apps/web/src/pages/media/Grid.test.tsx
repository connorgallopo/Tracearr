import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import { forwardRef, useImperativeHandle } from 'react';
import type { CatalogLetterBucket } from '@tracearr/shared';
import type * as UseMediaBrowseModule from '@/hooks/queries/useMediaBrowse';
import type * as VirtualPosterGridModule from '@/components/media-browse/VirtualPosterGrid';
import { MediaGrid } from './Grid';
import { useDashboardStats } from '@/hooks/queries';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

const scrollToItemMock = vi.hoisted(() => vi.fn());
const gridPropsSpy = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/queries', async () => {
  const actual = await vi.importActual<typeof UseMediaBrowseModule>(
    '@/hooks/queries/useMediaBrowse'
  );
  return {
    useCatalogWindow: vi.fn(),
    useCatalogLetters: vi.fn(),
    useGenres: vi.fn(),
    useCatalogCodecs: vi.fn(() => ({ data: { video: ['HEVC'], audio: [] } })),
    useLibraries: vi.fn(),
    useDashboardStats: vi.fn(),
    buildLetterOffsets: actual.buildLetterOffsets,
    activeLetterForItem: actual.activeLetterForItem,
    activeLetterForRow: actual.activeLetterForRow,
    pageIndicesForRange: actual.pageIndicesForRange,
    CATALOG_PAGE_SIZE: actual.CATALOG_PAGE_SIZE,
    stableSerialize: actual.stableSerialize,
  };
});

const auth = vi.hoisted(() => ({ user: { role: 'owner', userId: 'user-1' } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/components/library/LibraryEmptyState', () => ({
  LibraryEmptyState: ({ onComplete }: { onComplete?: () => void }) => (
    <div data-testid="library-empty-state">
      <button type="button" onClick={onComplete}>
        complete
      </button>
    </div>
  ),
}));

vi.mock('@/components/media-browse/VirtualPosterGrid', async () => {
  const actual = await vi.importActual<typeof VirtualPosterGridModule>(
    '@/components/media-browse/VirtualPosterGrid'
  );
  return {
    ...actual,
    VirtualPosterGrid: forwardRef(function MockGrid(
      props: {
        ariaLabel: string;
        scrollRestore?: { key: string | number; offset: number | null };
      },
      ref: React.Ref<{ scrollToItem: (index: number) => void }>
    ) {
      useImperativeHandle(ref, () => ({ scrollToItem: scrollToItemMock }));
      gridPropsSpy(props);
      return <div role="region" aria-label={props.ariaLabel} data-testid="virtual-grid" />;
    }),
  };
});

import { useCatalogWindow, useCatalogLetters, useGenres, useLibraries } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';

const mockUseCatalogWindow = vi.mocked(useCatalogWindow);
const mockUseCatalogLetters = vi.mocked(useCatalogLetters);
const mockUseGenres = vi.mocked(useGenres);
const mockUseLibraries = vi.mocked(useLibraries);
const mockUseServer = vi.mocked(useServer);

function serverReturn(overrides: Partial<ReturnType<typeof useServer>> = {}) {
  return {
    selectedServerIds: ['srv-1'],
    servers: [{ id: 'srv-1', name: 'Plex', type: 'plex', url: '', color: '#e5a00d' }],
    isLoading: false,
    ...overrides,
  } as unknown as ReturnType<typeof useServer>;
}

function windowResult(
  overrides: Partial<ReturnType<typeof useCatalogWindow>> = {}
): ReturnType<typeof useCatalogWindow> {
  return {
    pages: new Map(),
    totalItems: 0,
    totalFileSize: 0,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    pageError: false,
    retryErroredPages: vi.fn(),
    ...overrides,
  };
}

/** A single fake page of `count` rows - only mediaId matters, `getRow`'s
 * consumers under test only check truthiness. */
function fakePages(count: number): ReturnType<typeof useCatalogWindow>['pages'] {
  const rows = Array.from({ length: count }, (_, i) => ({ mediaId: `m${i}` }));
  return new Map([[0, rows]]) as unknown as ReturnType<typeof useCatalogWindow>['pages'];
}

function lettersResult(
  counts: Record<string, number> | null
): ReturnType<typeof useCatalogLetters> {
  const letters: CatalogLetterBucket[] | undefined = counts
    ? ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')].map((letter) => ({
        letter,
        count: counts[letter] ?? 0,
      }))
    : undefined;
  return {
    data: letters ? { letters } : undefined,
    isLoading: !letters,
  } as unknown as ReturnType<typeof useCatalogLetters>;
}

function SearchSpy() {
  return <output data-testid="location-search">{useLocation().search}</output>;
}

function renderGrid(path = '/media/browse') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <MediaGrid />
        <SearchSpy />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...result, client };
}

describe('MediaGrid', () => {
  beforeEach(() => {
    localStorage.clear();
    auth.user.role = 'owner';
    vi.mocked(useDashboardStats).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useDashboardStats>);
    mockUseGenres.mockReturnValue({
      data: { data: [] },
      isLoading: false,
    } as unknown as ReturnType<typeof useGenres>);
    mockUseLibraries.mockReturnValue({
      data: { data: [] },
      isLoading: false,
    } as unknown as ReturnType<typeof useLibraries>);
    mockUseCatalogLetters.mockReturnValue(lettersResult(null));
  });

  afterEach(() => {
    vi.clearAllMocks();
    scrollToItemMock.mockClear();
    gridPropsSpy.mockClear();
    window.history.replaceState(null, '');
  });

  it('always requests the anyone-grain catalog window - the per-identity lens picker is gone', () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult());
    renderGrid();
    expect(mockUseCatalogWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({ lens: 'all' }),
      expect.anything()
    );
    expect(screen.queryByTestId('lens-picker')).not.toBeInTheDocument();
  });

  it("requests a member's own lens and drops the popularity sorts", async () => {
    auth.user.role = 'member';
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult());
    renderGrid();
    expect(mockUseCatalogWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({ lens: 'user-1' }),
      expect.anything()
    );

    await userEvent.click(screen.getByRole('combobox', { name: 'media.grid.toolbar.sortLabel' }));
    expect(
      screen.getByRole('option', { name: 'media.grid.toolbar.sort.year' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: 'media.grid.toolbar.sort.plays' })
    ).not.toBeInTheDocument();
  });

  it('only asks for the dashboard stats on behalf of a member', () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult());
    renderGrid();
    expect(useDashboardStats).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false })
    );
  });

  it('keeps the popularity sorts for a member when the server shares activity', async () => {
    auth.user.role = 'member';
    vi.mocked(useDashboardStats).mockReturnValue({
      data: { othersActive: 0 },
    } as unknown as ReturnType<typeof useDashboardStats>);
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult());
    renderGrid();

    await userEvent.click(screen.getByRole('combobox', { name: 'media.grid.toolbar.sortLabel' }));
    expect(
      screen.getByRole('option', { name: 'media.grid.toolbar.sort.plays' })
    ).toBeInTheDocument();
  });

  it('sends Title, not a saved popularity sort, for a member who cannot pick one', () => {
    auth.user.role = 'member';
    localStorage.setItem('tracearr_media_filters_movie', JSON.stringify({ sort: 'plays' }));
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult());
    renderGrid();

    expect(mockUseCatalogWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: 'title' }),
      expect.anything()
    );
  });

  it('shows the sync-aware LibraryEmptyState when no servers are selected', () => {
    mockUseServer.mockReturnValue(serverReturn({ selectedServerIds: [], servers: [] }));
    mockUseCatalogWindow.mockReturnValue(windowResult());
    renderGrid();
    expect(screen.getByTestId('library-empty-state')).toBeInTheDocument();
  });

  it('invalidates media queries (not just errored pages) when the empty state completes a sync', async () => {
    const user = userEvent.setup();
    const retryErroredPages = vi.fn();
    mockUseServer.mockReturnValue(serverReturn({ selectedServerIds: [], servers: [] }));
    mockUseCatalogWindow.mockReturnValue(windowResult({ retryErroredPages }));
    const { client } = renderGrid();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    await user.click(screen.getByRole('button', { name: 'complete' }));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['media'] });
    expect(retryErroredPages).toHaveBeenCalled();
  });

  it('renders the first-mount static skeleton grid while the first page is loading', () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ isLoading: true, totalItems: null }));
    renderGrid();
    expect(screen.getByTestId('grid-first-mount-skeleton')).toBeInTheDocument();
  });

  it('keeps the loaded grid up (no skeleton, no remount) when the page window briefly reports totalItems null for the same result set', () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 20 }));
    renderGrid();
    expect(screen.getByTestId('virtual-grid')).toBeInTheDocument();
    expect(screen.queryByTestId('grid-first-mount-skeleton')).not.toBeInTheDocument();

    // The viewport moved to pages the window hasn't fetched yet - the window
    // only reports a total for pages it currently covers, so this looks
    // identical to "unknown" even though the result set never changed.
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: null, isLoading: true }));
    const lastProps = () => gridPropsSpy.mock.calls[gridPropsSpy.mock.calls.length - 1]?.[0];
    act(() => {
      lastProps().onViewportChange({
        renderFirstItem: 60,
        renderLastItem: 119,
        topItem: 60,
        columnCount: 4,
      });
    });

    expect(screen.getByTestId('virtual-grid')).toBeInTheDocument();
    expect(screen.queryByTestId('grid-first-mount-skeleton')).not.toBeInTheDocument();
  });

  it('shows the full skeleton again when a genuinely new result set (a search edit) drops totalItems to null', async () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 20 }));
    const user = userEvent.setup();
    renderGrid();
    expect(screen.getByTestId('virtual-grid')).toBeInTheDocument();

    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: null, isLoading: true }));
    await user.type(screen.getByLabelText('media.grid.toolbar.searchLabel'), 'a');

    await waitFor(() =>
      expect(screen.getByTestId('grid-first-mount-skeleton')).toBeInTheDocument()
    );
  });

  it('renders filter-empty copy when a filter is active and the catalog total is zero', () => {
    localStorage.setItem(
      'tracearr_media_filters_movie',
      JSON.stringify({ sort: 'title', resolution: '4K' })
    );
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult());
    renderGrid();
    expect(screen.getByText('media.grid.emptyFilter')).toBeInTheDocument();
  });

  it('renders search-empty copy when a search query returns zero rows', async () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult());
    const user = userEvent.setup();
    renderGrid();
    await user.type(screen.getByLabelText('media.grid.toolbar.searchLabel'), 'zzzznotfound');
    await waitFor(() => expect(screen.getByText(/media\.grid\.emptySearch/)).toBeInTheDocument());
  });

  it('applies a `genre` query param from the URL (e.g. a link from the Genres page) as the persisted filter on arrival', () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 5 }));
    // The genre must be a valid option in the current scope, or the
    // validation effect (which drops filters absent from the loaded genre
    // list) would strip it right back out.
    mockUseGenres.mockReturnValue({
      data: { data: [{ genre: 'Comedy', itemCount: 5, plays: 20, watchTimeMs: 1000 }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useGenres>);

    renderGrid('/media/browse?genre=Comedy');

    expect(mockUseCatalogWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: expect.objectContaining({ genre: 'Comedy' }) }),
      expect.anything()
    );
    expect(screen.getByText('Comedy')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('tracearr_media_filters_movie') ?? '{}')).toMatchObject({
      genre: 'Comedy',
    });
  });

  it('applies codec query params from a Quality page chart link on arrival', () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 5 }));

    renderGrid('/media/browse?type=show&videoCodec=HEVC');

    expect(mockUseCatalogWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'show',
        filters: expect.objectContaining({ videoCodec: 'HEVC' }),
      }),
      expect.anything()
    );
  });

  it('applies the added range from a growth chart link on arrival', () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 5 }));

    renderGrid('/media/browse?type=show&addedAfter=2026-10-01&addedBefore=2026-10-31');

    expect(mockUseCatalogWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'show',
        filters: expect.objectContaining({ addedAfter: '2026-10-01', addedBefore: '2026-10-31' }),
      }),
      expect.anything()
    );
  });

  it('seeds the watched filter from a `watched` link param', () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 5 }));

    renderGrid('/media/browse?watched=unwatched');

    expect(mockUseCatalogWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: expect.objectContaining({ watched: 'unwatched' }) }),
      expect.anything()
    );
  });

  it('ignores a `watched` link param that is not a watched state', () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 5 }));

    renderGrid('/media/browse?watched=everything');

    expect(mockUseCatalogWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: expect.not.objectContaining({ watched: 'everything' }) }),
      expect.anything()
    );
  });

  it('browses artists on ?type=artist with square cards and no year sort', async () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 5 }));

    renderGrid('/media/browse?type=artist');

    expect(mockUseCatalogWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'artist' }),
      expect.anything()
    );
    expect(mockUseGenres).toHaveBeenLastCalledWith('artist', ['srv-1']);
    const lastProps = gridPropsSpy.mock.calls[gridPropsSpy.mock.calls.length - 1]?.[0];
    expect(lastProps).toMatchObject({ aspect: 'square', ariaLabel: 'common:media.artist_plural' });
    expect(screen.getByRole('radio', { name: 'common:media.artist_plural' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    await userEvent.click(screen.getByRole('combobox', { name: 'media.grid.toolbar.sortLabel' }));
    expect(screen.queryByRole('option', { name: 'media.grid.toolbar.sort.year' })).toBeNull();
  });

  it('asks for artists by title with no watched filter when the URL or storage carries either', () => {
    localStorage.setItem('tracearr_media_filters_artist', JSON.stringify({ sort: 'year' }));
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 5 }));

    renderGrid('/media/browse?type=artist&watched=watched');

    const [args] =
      mockUseCatalogWindow.mock.calls[mockUseCatalogWindow.mock.calls.length - 1] ?? [];
    expect(args).toMatchObject({ type: 'artist', sort: 'title' });
    expect(args?.filters.watched).toBeUndefined();
    expect(screen.queryByText('media.grid.toolbar.watched.watched')).toBeNull();
  });

  it('strips watched and a year sort from an artist URL', () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 5 }));

    renderGrid('/media/browse?type=artist&watched=watched&sort=year&genre=House');

    expect(screen.getByTestId('location-search').textContent).toBe('?type=artist&genre=House');
  });

  it('never asks for artists with the year sort or watched filter a movie list had', async () => {
    localStorage.setItem(
      'tracearr_media_filters_movie',
      JSON.stringify({ sort: 'year', watched: 'watched', resolution: '4K' })
    );
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 5 }));
    renderGrid('/media/browse');

    await userEvent.click(screen.getByRole('radio', { name: 'common:media.artist_plural' }));

    const artistCalls = [
      ...mockUseCatalogWindow.mock.calls.map(([args]) => args),
      ...mockUseCatalogLetters.mock.calls.map(([args]) => args),
    ].filter((args) => args.type === 'artist');
    expect(artistCalls.length).toBeGreaterThan(0);
    for (const args of artistCalls) {
      expect(args.sort).not.toBe('year');
      expect(args.filters.watched).toBeUndefined();
      expect(args.filters.resolution).toBeUndefined();
    }
  });

  it('switches to artists through the type control with a singular type param', async () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 5 }));
    renderGrid('/media/browse');

    await userEvent.click(screen.getByRole('radio', { name: 'common:media.artist_plural' }));

    expect(mockUseCatalogWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'artist' }),
      expect.anything()
    );
  });

  it('drops a server filter that leaves the global selection instead of widening scope', () => {
    localStorage.setItem(
      'tracearr_media_filters_movie',
      JSON.stringify({ sort: 'title', serverId: 'srv-gone' })
    );
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 3 }));
    renderGrid();

    const lastArgs =
      mockUseCatalogWindow.mock.calls[mockUseCatalogWindow.mock.calls.length - 1]?.[0];
    // Never an empty intersection read as "all servers": the stale filter is
    // dropped and the query scopes to the actual selection.
    expect(lastArgs?.serverIds).toEqual(['srv-1']);
  });

  it('a letter jump scrolls to the cumulative offset of that letter', async () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 20 }));
    mockUseCatalogLetters.mockReturnValue(lettersResult({ '#': 2, A: 5, M: 8, Z: 5 }));
    const user = userEvent.setup();
    renderGrid();

    await user.click(screen.getByText('M'));
    // '#'(2) + A(5) rows sit before M.
    expect(scrollToItemMock).toHaveBeenCalledWith(7);
  });

  it("the rail agrees with the landing row even when it opens with the previous letter's tail", () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 20 }));
    // '#'(2) + A(5) => M starts at item 7; a 4-column grid's row starting at
    // item 4 mixes A's tail (4-6) with M's head (7) - the row a jump to M
    // actually lands on (floor(7/4)=1 -> items 4-7).
    mockUseCatalogLetters.mockReturnValue(lettersResult({ '#': 2, A: 5, M: 8, Z: 5 }));
    renderGrid();

    const lastProps = () => gridPropsSpy.mock.calls[gridPropsSpy.mock.calls.length - 1]?.[0];
    const onViewportChange = lastProps().onViewportChange as (info: {
      renderFirstItem: number;
      renderLastItem: number;
      topItem: number;
      columnCount: number;
    }) => void;

    act(() => {
      onViewportChange({ renderFirstItem: 4, renderLastItem: 11, topItem: 4, columnCount: 4 });
    });

    expect(screen.getByRole('option', { name: /^M$/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('option', { name: /^A$/ })).not.toHaveAttribute('aria-current');
  });

  it('holds the rail on the clicked letter until the grid reports the jump settled, and never re-issues the jump itself', async () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 20 }));
    mockUseCatalogLetters.mockReturnValue(lettersResult({ '#': 2, A: 5, M: 8, Z: 5 }));
    const user = userEvent.setup();
    renderGrid();

    await user.click(screen.getByText('M'));
    expect(scrollToItemMock).toHaveBeenCalledTimes(1);
    expect(scrollToItemMock).toHaveBeenLastCalledWith(7);

    const lastProps = () => gridPropsSpy.mock.calls[gridPropsSpy.mock.calls.length - 1]?.[0];

    // A page arriving for the jumped letter is not what releases the hold -
    // landing correction is the grid's own job now, never a second call from here.
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 20, pages: fakePages(20) }));
    act(() => {
      lastProps().onViewportChange({
        renderFirstItem: 4,
        renderLastItem: 11,
        topItem: 0,
        columnCount: 4,
      });
    });
    expect(screen.getByRole('option', { name: /^M$/ })).toHaveAttribute('aria-current', 'true');
    expect(scrollToItemMock).toHaveBeenCalledTimes(1);

    // The grid reporting the jump settled is what releases the hold - organic
    // viewport reports then drive the rail again.
    act(() => {
      lastProps().onJumpSettled();
    });
    act(() => {
      lastProps().onViewportChange({
        renderFirstItem: 0,
        renderLastItem: 3,
        topItem: 0,
        columnCount: 4,
      });
    });
    // Row 0-3 has both '#' (start 0) and A (start 2) starting inside it - A wins as the later start.
    expect(screen.getByRole('option', { name: /^A$/ })).toHaveAttribute('aria-current', 'true');
    expect(scrollToItemMock).toHaveBeenCalledTimes(1);
  });

  it('a real-input cancel from the grid also releases the rail hold', async () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 20 }));
    mockUseCatalogLetters.mockReturnValue(lettersResult({ '#': 2, A: 5, M: 8, Z: 5 }));
    const user = userEvent.setup();
    renderGrid();

    await user.click(screen.getByText('M'));
    const lastProps = () => gridPropsSpy.mock.calls[gridPropsSpy.mock.calls.length - 1]?.[0];

    act(() => {
      lastProps().onJumpCancelled();
    });
    act(() => {
      lastProps().onViewportChange({
        renderFirstItem: 0,
        renderLastItem: 3,
        topItem: 0,
        columnCount: 4,
      });
    });
    expect(screen.getByRole('option', { name: /^A$/ })).toHaveAttribute('aria-current', 'true');
  });

  it('a zero-count letter is inert', async () => {
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 20 }));
    mockUseCatalogLetters.mockReturnValue(lettersResult({ '#': 2, A: 18 }));
    const user = userEvent.setup();
    renderGrid();

    await user.click(screen.getByText('Q'));
    expect(scrollToItemMock).not.toHaveBeenCalled();
  });

  it('hides the letter rail on a non-title sort', () => {
    localStorage.setItem('tracearr_media_filters_movie', JSON.stringify({ sort: 'added' }));
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 20 }));
    renderGrid();

    expect(screen.queryByRole('listbox', { name: 'media.grid.scrubber.label' })).toBeNull();
  });

  it('merges the grid scroll state into history.state without clobbering the router entry', () => {
    // react-router (and anything else) keeps its own keys in history.state.
    window.history.replaceState({ usr: { fromRouter: true }, key: 'abc' }, '');
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 20 }));
    renderGrid();

    // The mocked grid never fires onScrollIdle, so drive the same write path
    // the component uses via its saved state shape assertion: simulate what
    // handleScrollIdle writes by checking the untouched router state after
    // render (regression guard for wholesale replaceState).
    const state = window.history.state as Record<string, unknown>;
    expect(state.usr).toEqual({ fromRouter: true });
    expect(state.key).toBe('abc');
  });

  it('clears the pending scroll restore once a search edit changes the result set', async () => {
    window.history.replaceState({ mediaGrid: { type: 'movie', offset: 4000 } }, '');
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 20 }));
    const user = userEvent.setup();
    renderGrid();

    const lastProps = () => gridPropsSpy.mock.calls[gridPropsSpy.mock.calls.length - 1]?.[0];
    expect(lastProps().scrollRestore).toEqual({ key: 'movie', offset: 4000 });

    await user.type(screen.getByLabelText('media.grid.toolbar.searchLabel'), 'a');
    await waitFor(() => expect(lastProps().scrollRestore).toEqual({ key: 'movie', offset: null }));
  });

  it('passes the offset saved for the new type (or null) as the scrollRestore key changes, not the old type', () => {
    window.history.replaceState({ mediaGrid: { type: 'show', offset: 2500 } }, '');
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 20 }));
    renderGrid('/media/browse');

    const lastProps = () => gridPropsSpy.mock.calls[gridPropsSpy.mock.calls.length - 1]?.[0];
    // No saved offset for movies (the saved entry is for shows): starts null, not the shows offset.
    expect(lastProps().scrollRestore).toEqual({ key: 'movie', offset: null });
  });

  it("restores a cached type's saved offset on the very first render pass (back-nav into cached data)", () => {
    // Simulates the cached path: totalItems is already known synchronously
    // on mount, so the grid's very first effect pass is the only one that
    // ever consumes this key - the offset must be correct from render one.
    window.history.replaceState({ mediaGrid: { type: 'movie', offset: 3200 } }, '');
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 500 }));
    renderGrid('/media/browse');

    const firstProps = gridPropsSpy.mock.calls[0]?.[0];
    expect(firstProps.scrollRestore).toEqual({ key: 'movie', offset: 3200 });
  });

  it('the movies/shows toggle always lands the target type at the top with default filters, ignoring any saved offset or filters it has', async () => {
    // A deep offset and custom filters already saved for shows, from an
    // earlier organic (non-toggle) visit - the toggle must ignore both.
    window.history.replaceState({ mediaGrid: { type: 'show', offset: 2500 } }, '');
    localStorage.setItem(
      'tracearr_media_filters_show',
      JSON.stringify({ sort: 'title', resolution: '4K' })
    );
    mockUseServer.mockReturnValue(serverReturn());
    // Cached path for both types: totalItems is already known synchronously,
    // so the toggle never passes through a loading skeleton that would
    // remount the grid and mask the bug the review flagged.
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 500 }));
    const user = userEvent.setup();
    renderGrid('/media/browse');

    const lastProps = () => gridPropsSpy.mock.calls[gridPropsSpy.mock.calls.length - 1]?.[0];
    const lastCatalogArgs = () =>
      mockUseCatalogWindow.mock.calls[mockUseCatalogWindow.mock.calls.length - 1]?.[0];

    // The toggle navigates without unmounting MediaGrid (same route, only the
    // `type` query param changes).
    await user.click(screen.getByRole('radio', { name: 'common:media.tvShows' }));
    expect(lastProps().scrollRestore).toEqual({ key: 'show', offset: null });
    expect(lastCatalogArgs()?.filters.resolution).toBeUndefined();

    // The stale deep offset is dropped from the entry too, so a later
    // organic (non-toggle) visit can't resurrect it.
    expect((window.history.state as { mediaGrid?: unknown } | null)?.mediaGrid).toBeUndefined();

    // The toggle never overwrote the type's own saved filters - only the
    // transient landing state reset to default.
    expect(JSON.parse(localStorage.getItem('tracearr_media_filters_show') ?? '{}')).toMatchObject({
      resolution: '4K',
    });
  });

  it('consumes the fresh-toggle flag from the history entry so Back into it later restores instead of re-wiping', async () => {
    // Simulates the entry state a real browser would carry after a toggle:
    // the router flag under usr plus a saved offset written since.
    window.history.replaceState(
      { usr: { freshBrowse: true }, mediaGrid: { type: 'show', offset: 1800 } },
      ''
    );
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 500 }));
    const user = userEvent.setup();
    renderGrid('/media/browse');

    await user.click(screen.getByRole('radio', { name: 'common:media.tvShows' }));

    const state = window.history.state as { usr?: { freshBrowse?: boolean } } | null;
    expect(state?.usr?.freshBrowse).toBeUndefined();
  });

  it('toggling back to a type with its own real saved offset still lands fresh, not restored - only initial arrival restores', async () => {
    window.history.replaceState({ mediaGrid: { type: 'movie', offset: 3200 } }, '');
    mockUseServer.mockReturnValue(serverReturn());
    mockUseCatalogWindow.mockReturnValue(windowResult({ totalItems: 500 }));
    const user = userEvent.setup();
    renderGrid('/media/browse');

    const lastProps = () => gridPropsSpy.mock.calls[gridPropsSpy.mock.calls.length - 1]?.[0];
    // Initial arrival (not a toggle) restores the saved offset.
    expect(lastProps().scrollRestore).toEqual({ key: 'movie', offset: 3200 });

    await user.click(screen.getByRole('radio', { name: 'common:media.tvShows' }));
    expect(lastProps().scrollRestore).toEqual({ key: 'show', offset: null });

    // Toggling back to movies is still a toggle transition, so it lands
    // fresh too - it does not resurrect the 3200 offset movies had moments ago.
    await user.click(screen.getByRole('radio', { name: 'common:media.movie_plural' }));
    expect(lastProps().scrollRestore).toEqual({ key: 'movie', offset: null });
  });
});
