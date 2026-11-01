import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MostPopularShelfRow, ShelvesResponse } from '@tracearr/shared';
import { MediaOverview } from './Overview';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/hooks/queries', () => ({
  useShelves: vi.fn(),
  useLibraryStats: vi.fn(),
  useLibraryGrowth: vi.fn(),
  useLibraryStatus: vi.fn(),
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));

const auth = vi.hoisted(() => ({ user: { role: 'owner' } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));

vi.mock('@/components/charts', () => ({
  LibraryGrowthChart: () => <div data-testid="library-growth-chart" />,
}));

vi.mock('@/components/library/LibraryEmptyState', () => ({
  LibraryEmptyState: () => <div data-testid="library-empty-state" />,
}));

import {
  useShelves,
  useLibraryStats,
  useLibraryGrowth,
  useLibraryStatus,
  type LibraryStatusResponse,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';

const mockUseShelves = vi.mocked(useShelves);
const mockUseLibraryStats = vi.mocked(useLibraryStats);
const mockUseLibraryGrowth = vi.mocked(useLibraryGrowth);
const mockUseLibraryStatus = vi.mocked(useLibraryStatus);
const mockUseServer = vi.mocked(useServer);

function serverReturn(overrides: Partial<ReturnType<typeof useServer>> = {}) {
  return {
    selectedServerIds: ['srv-1'],
    selectedServers: [{ id: 'srv-1', name: 'Plex', type: 'plex', color: '#e5a00d' }],
    servers: [
      {
        id: 'srv-1',
        name: 'Plex',
        type: 'plex',
        url: '',
        color: '#e5a00d',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    isMultiServer: false,
    isLoading: false,
    ...overrides,
  } as unknown as ReturnType<typeof useServer>;
}

function statsReturn(overrides: Partial<ReturnType<typeof useLibraryStats>> = {}) {
  return {
    data: {
      totalItems: 500,
      totalSizeBytes: 2_000_000_000,
      movieCount: 300,
      episodeCount: 1500,
      showCount: 40,
      asOf: '2024-01-15T12:00:00Z',
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useLibraryStats>;
}

function growthReturn(overrides: Partial<ReturnType<typeof useLibraryGrowth>> = {}) {
  return {
    data: { period: '30d', movies: [], episodes: [], music: [] },
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  } as unknown as ReturnType<typeof useLibraryGrowth>;
}

function statusReturn(
  byServer: Record<string, Partial<LibraryStatusResponse> | undefined> = {
    'srv-1': { isSynced: true, needsBackfill: false, isBackfillRunning: false },
  },
  isLoading = false
) {
  const map = new Map(
    Object.entries(byServer).map(([id, data]) => [id, { data: data as LibraryStatusResponse }])
  );
  return { byServer: map, isLoading, isFetching: false, error: null } as unknown as ReturnType<
    typeof useLibraryStatus
  >;
}

const rowBase = {
  genres: [] as string[],
  posterUrl: 'https://example.com/api/library/poster?serverId=srv-1&path=x',
  posterVersion: null,
  dominantColor: null,
  servers: [
    {
      serverId: 'srv-1',
      addedAt: '2024-01-01T00:00:00Z',
      videoResolution: '1080p',
      fileSize: 1000,
      versionCount: 1,
    },
  ],
  resolutionBest: '1080p',
};

function fullShelves(): ShelvesResponse {
  return {
    period: 'month',
    recentlyAddedMovies: [
      {
        ...rowBase,
        mediaId: 'ram-1',
        mediaType: 'movie',
        title: 'Recently Added Movie',
        year: 2024,
        watchedState: 'unwatched',
        newEpisodes: null,
        newestEpisodeAt: null,
      },
    ],
    recentlyAddedShows: [
      {
        ...rowBase,
        mediaId: 'ras-1',
        mediaType: 'show',
        title: 'Grouped Show',
        year: 2023,
        watchedState: 'partial',
        newEpisodes: 3,
        newestEpisodeAt: '2026-03-04T00:00:00Z',
      },
    ],
    recentlyUpdated: [
      {
        ...rowBase,
        mediaId: 'ru-1',
        mediaType: 'movie',
        title: 'Replaced Movie',
        year: 2021,
        watchedState: 'unwatched',
        replacedEpisodes: null,
        newestEpisodeAt: null,
      },
    ],
    mostPopularMovies: [
      {
        ...rowBase,
        mediaId: 'mpm-1',
        mediaType: 'movie',
        title: 'Popular Movie',
        year: 2022,
        watchedState: 'watched',
        plays: 12,
        viewers: 4,
        rank: 1,
      },
    ],
    mostPopularShows: [
      {
        ...rowBase,
        mediaId: 'mps-1',
        mediaType: 'show',
        title: 'Popular Show',
        year: 2021,
        watchedState: 'watched',
        plays: 8,
        viewers: 2,
        rank: 1,
      },
    ],
    recentlyAddedAlbums: [],
    mostPlayedArtists: [],
    deadWeight: [],
    kpis: {
      watchedInPeriod: { titlesTouched: 12, totalTitles: 48 },
      hoursWatched: 7230,
      newlyAdded: { count: 6, totalBytes: 3_000_000_000, playedCount: 2 },
      deadWeight: { count: 9, totalBytes: 45_000_000_000 },
    },
    meta: { movies: 42, shows: 7, artists: 0, albums: 0, totalFileSize: 123_456_789_000 },
  };
}

function renderOverview(initialEntries: string[] = ['/'], client = new QueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={initialEntries}>
        <MediaOverview />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function mockShelvesReturn(overrides: Partial<ReturnType<typeof useShelves>> = {}) {
  mockUseShelves.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useShelves>);
}

describe('MediaOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user.role = 'owner';
    mockUseServer.mockReturnValue(serverReturn());
    mockUseLibraryStats.mockReturnValue(statsReturn());
    mockUseLibraryGrowth.mockReturnValue(growthReturn());
    mockUseLibraryStatus.mockReturnValue(statusReturn());
  });

  it('renders the library stat cards and growth chart above the shelves', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
    expect(screen.getByTestId('library-growth-chart')).toBeInTheDocument();
  });

  it('puts the last-updated text in the Library Growth card header', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    const header = screen
      .getByText('library.overview.libraryGrowth')
      .closest('[data-slot="card-header"]');
    expect(header).toContainElement(screen.getByText(/library\.overview\.lastUpdated/));
  });

  it('marks the four total stat cards as all-time, leaving the Added card on its own period label', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    // The mocked t() returns the raw key for a call with no interpolation
    // options, lowercased by the component the same way it lowercases the
    // real "All Time" label. Cards render it inside "(...)", so match by
    // substring rather than the full node text.
    const allTimeHints = screen.getAllByText(/common:time\.alltime/);
    // Total Items, Total Size, Movies, Episodes.
    expect(allTimeHints.length).toBe(4);

    // The Added card still carries its own period label, not the all-time hint.
    expect(screen.getByText('library.overview.added')).toBeInTheDocument();
    expect(
      screen.getByText(/library\.overview\.thisMonth|library\.overview\.thisPeriod/)
    ).toBeInTheDocument();
  });

  it('shows a section-scoped error (not a full-page one) when the library stats query fails, while shelves still render', () => {
    mockUseLibraryStats.mockReturnValue(
      statsReturn({ data: undefined, isError: true, error: new Error('stats boom') })
    );
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(screen.getByText('stats boom')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.recentlyAddedMovies')).toBeInTheDocument();
  });

  it('shows a section-scoped loading skeleton for the stats while shelves load independently', () => {
    mockUseLibraryStats.mockReturnValue(statsReturn({ data: undefined, isLoading: true }));
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(screen.getByText('media.landing.shelves.recentlyAddedMovies')).toBeInTheDocument();
    expect(screen.queryByTestId('library-growth-chart')).not.toBeInTheDocument();
  });

  it('shows the sync-aware empty state (not the stats/shelves content) when every selected server needs sync', () => {
    mockUseLibraryStatus.mockReturnValue(
      statusReturn({ 'srv-1': { isSynced: false, needsBackfill: false, isBackfillRunning: false } })
    );
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(screen.getByTestId('library-empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('library-growth-chart')).not.toBeInTheDocument();
    expect(screen.queryByText('media.landing.shelves.recentlyAddedMovies')).not.toBeInTheDocument();
  });

  it('does not banner a session-only server that has no catalog next to a ready library', () => {
    mockUseServer.mockReturnValue(
      serverReturn({
        selectedServerIds: ['srv-1', 'srv-ether'],
        selectedServers: [
          {
            id: 'srv-1',
            name: 'Plex',
            type: 'plex',
            url: '',
            color: '#e5a00d',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: 'srv-ether',
            name: 'Servfrica-Ether',
            type: 'plex',
            url: '',
            color: '#00bcd4',
            librarySyncEnabled: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        isMultiServer: true,
      })
    );
    mockUseLibraryStatus.mockReturnValue(
      statusReturn({
        'srv-1': { isSynced: true, needsBackfill: false, isBackfillRunning: false },
        'srv-ether': { isSynced: false, needsBackfill: false, isBackfillRunning: false },
      })
    );
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(screen.queryByText('library.overview.serversNeedSync')).not.toBeInTheDocument();
    expect(screen.queryByTestId('library-empty-state')).not.toBeInTheDocument();
    expect(screen.getByTestId('library-growth-chart')).toBeInTheDocument();
  });

  it('shows the empty state (not a need-to-sync banner) when the only selected server has library sync off', () => {
    mockUseServer.mockReturnValue(
      serverReturn({
        selectedServerIds: ['srv-ether'],
        selectedServers: [
          {
            id: 'srv-ether',
            name: 'Servfrica-Ether',
            type: 'plex',
            url: '',
            color: '#00bcd4',
            librarySyncEnabled: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      })
    );
    mockUseLibraryStatus.mockReturnValue(
      statusReturn({
        'srv-ether': { isSynced: false, needsBackfill: false, isBackfillRunning: false },
      })
    );
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(screen.getByTestId('library-empty-state')).toBeInTheDocument();
    expect(screen.queryByText('library.overview.serversNeedSync')).not.toBeInTheDocument();
    expect(screen.queryByTestId('library-growth-chart')).not.toBeInTheDocument();
  });

  it('renders all five shelves with their rows', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(screen.getByText('media.landing.shelves.recentlyAddedMovies')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.recentlyAddedShows')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.recentlyUpdated')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.mostPopularMovies')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.mostPopularShows')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Replaced Movie/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Recently Added Movie/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Grouped Show/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Popular Movie/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Popular Show/ })).toBeInTheDocument();
  });

  it('adds the album and artist shelves once the library has artists', () => {
    const data = fullShelves();
    data.meta = { ...data.meta, artists: 2, albums: 3 };
    data.recentlyAddedAlbums = [
      {
        serverId: 'srv-1',
        ratingKey: '9001',
        title: 'Random Access Memories',
        artistTitle: 'Daft Punk',
        artistMediaId: 'artist-1',
        year: 2013,
        posterUrl: '/api/v1/images/proxy?server=srv-1&url=%2Flibrary%2Fmetadata%2F9001%2Fthumb',
        posterVersion: '9f2c41ab',
        addedAt: '2026-10-02T09:30:00.000Z',
      },
      {
        serverId: 'srv-1',
        ratingKey: '9002',
        title: 'Orphan Album',
        artistTitle: null,
        artistMediaId: null,
        year: null,
        posterUrl: null,
        posterVersion: null,
        addedAt: '2026-10-01T09:30:00.000Z',
      },
    ];
    data.mostPlayedArtists = [
      {
        ...rowBase,
        mediaId: 'artist-1',
        mediaType: 'artist',
        title: 'Daft Punk',
        year: null,
        watchedState: 'unwatched',
        albumCount: 4,
        plays: 31,
        viewers: 3,
        rank: 1,
      },
    ];
    mockShelvesReturn({ data });

    renderOverview();

    const albums = screen.getByRole('region', {
      name: 'media.landing.shelves.recentlyAddedAlbums',
    });
    expect(within(albums).getByRole('link', { name: /Random Access Memories/ })).toHaveAttribute(
      'href',
      '/media/artist-1'
    );
    expect(within(albums).getAllByRole('link')).toHaveLength(1);
    expect(albums.querySelector('img')?.getAttribute('src')).toContain('v=9f2c41ab');
    expect(within(albums).getAllByText('Orphan Album').length).toBeGreaterThan(0);
    const artists = screen.getByRole('region', {
      name: 'media.landing.shelves.mostPlayedArtists',
    });
    expect(within(artists).getByRole('link', { name: /Daft Punk/ })).toHaveAttribute(
      'href',
      '/media/artist-1'
    );
    expect(within(artists).getByRole('link', { name: /deadWeight.viewAll/ })).toHaveAttribute(
      'href',
      '/media/browse?type=artist'
    );
  });

  it('leaves the music shelves out when the library has no artists', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(screen.queryByText('media.landing.shelves.recentlyAddedAlbums')).toBeNull();
    expect(screen.queryByText('media.landing.shelves.mostPlayedArtists')).toBeNull();
  });

  it('links the show shelves to Browse with the singular type', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    const shows = screen.getByRole('region', { name: 'media.landing.shelves.mostPopularShows' });
    expect(within(shows).getByRole('link', { name: /deadWeight.viewAll/ })).toHaveAttribute(
      'href',
      '/media/browse?type=show'
    );
  });

  it('shows the heading and an empty note (not a vanished section) when only one type is empty', () => {
    const data = fullShelves();
    data.mostPopularShows = [];
    mockShelvesReturn({ data });

    renderOverview();

    expect(screen.getByText('media.landing.shelves.mostPopularShows')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.emptyMostPopular')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.recentlyAddedMovies')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Popular Movie/ })).toBeInTheDocument();
  });

  it('does not repeat the year in the card meta line (the hover overlay already shows it)', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    // The year appears exactly once - inside the hover overlay's meta line.
    expect(screen.getAllByText(/2022/)).toHaveLength(1);
  });

  it('dates a show card by its newest episode, not by when the series was first added', () => {
    const shelves = fullShelves();
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    mockShelvesReturn({
      data: {
        ...shelves,
        recentlyAddedShows: shelves.recentlyAddedShows.map((row) => ({
          ...row,
          newestEpisodeAt: threeDaysAgo,
        })),
      },
    });

    renderOverview();

    // The series' own copy sits at 2024-01-01, which would read in years.
    expect(screen.getByText('media.landing.card.addedCompactAgo:{"age":"3d"}')).toBeInTheDocument();
  });

  it('reads the shelves period from the time range in the URL', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview(['/?period=year']);

    expect(mockUseShelves).toHaveBeenLastCalledWith(
      ['srv-1'],
      expect.objectContaining({ period: 'year' }),
      false
    );
  });

  it('always requests shelves with dead weight excluded (Storage page owns that computation)', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(mockUseShelves).toHaveBeenCalledWith(['srv-1'], expect.anything(), false);
  });

  it('sends an explicit startDate/endDate for a custom range instead of falling back to 30d', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview(['/?period=custom&from=2026-01-01&to=2026-01-31']);

    expect(mockUseLibraryGrowth).toHaveBeenCalledWith(
      ['srv-1'],
      null,
      '30d',
      '2026-01-01T00:00:00.000Z',
      '2026-01-31T00:00:00.000Z'
    );
  });

  it('sends custom-range shelves as the UTC days picked, whatever the browser zone', () => {
    vi.stubEnv('TZ', 'Pacific/Auckland');
    mockShelvesReturn({ data: fullShelves() });

    renderOverview(['/?period=custom&from=2026-09-01&to=2026-09-30']);

    expect(mockUseShelves).toHaveBeenLastCalledWith(
      ['srv-1'],
      {
        period: 'custom',
        startDate: '2026-09-01T00:00:00.000Z',
        endDate: '2026-09-30T00:00:00.000Z',
      },
      false
    );
    vi.unstubAllEnvs();
  });

  it('sends an explicit 1-day startDate/endDate for the day period instead of silently using 30d', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview(['/?period=day']);

    const [, , calledPeriod, calledStart, calledEnd] = mockUseLibraryGrowth.mock.calls[0]!;
    expect(calledPeriod).toBe('30d');
    expect(calledStart).toBeDefined();
    expect(calledEnd).toBeDefined();
    const spanMs =
      new Date(calledEnd as string).getTime() - new Date(calledStart as string).getTime();
    expect(spanMs).toBe(24 * 60 * 60 * 1000);
  });

  it('renders loading skeletons for the shelves', () => {
    mockShelvesReturn({ data: undefined, isLoading: true });

    renderOverview();

    expect(screen.getByTestId('media-landing-skeleton')).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText('media.landing.shelves.mostPopularShows')).toBeInTheDocument();
    expect(screen.queryByText('media.landing.shelves.recentlyAddedAlbums')).toBeNull();
    expect(screen.queryByText('media.landing.shelves.mostPlayedArtists')).toBeNull();
  });

  it('adds the music shelf skeletons once a cached response says the library has artists', () => {
    mockShelvesReturn({ data: undefined, isLoading: true });
    const client = new QueryClient();
    const cached = fullShelves();
    cached.meta = { ...cached.meta, artists: 3, albums: 7 };
    client.setQueryData(['media', 'shelves', 'srv-1', { period: 'week' }, false], cached);

    renderOverview(['/'], client);

    expect(screen.getByText('media.landing.shelves.recentlyAddedAlbums')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.mostPlayedArtists')).toBeInTheDocument();
  });

  it('renders a single error state for the shelves (not one per shelf) when the shelves query fails', () => {
    mockShelvesReturn({ data: undefined, isError: true, error: new Error('boom') });

    renderOverview();

    expect(screen.queryByText('media.landing.shelves.recentlyAddedMovies')).not.toBeInTheDocument();
    expect(screen.getByText('media.landing.loadError')).toBeInTheDocument();
  });

  it('renders the sync-aware empty state when no servers are selected', () => {
    mockUseServer.mockReturnValue(serverReturn({ selectedServerIds: [] }));
    mockShelvesReturn({ data: undefined });

    renderOverview();

    expect(screen.getByTestId('library-empty-state')).toBeInTheDocument();
  });

  it('renders the sync-aware empty state when the library has no movies or shows', () => {
    mockShelvesReturn({
      data: {
        ...fullShelves(),
        recentlyAddedMovies: [],
        recentlyAddedShows: [],
        recentlyUpdated: [],
        mostPopularMovies: [],
        mostPopularShows: [],
        deadWeight: [],
        meta: { movies: 0, shows: 0, artists: 0, albums: 0, totalFileSize: 0 },
      },
    });

    renderOverview();

    expect(screen.getByTestId('library-empty-state')).toBeInTheDocument();
  });

  it('keeps the shelves up for a music-only library', () => {
    mockShelvesReturn({
      data: {
        ...fullShelves(),
        meta: { movies: 0, shows: 0, artists: 5, albums: 9, totalFileSize: 0 },
      },
    });

    renderOverview();

    expect(screen.queryByTestId('library-empty-state')).toBeNull();
    expect(screen.getByText('media.landing.shelves.mostPlayedArtists')).toBeInTheDocument();
  });

  it('renders self-describing empty shelves on a quiet window instead of vanishing', () => {
    const data = fullShelves();
    data.recentlyAddedMovies = [];
    data.recentlyAddedShows = [];
    data.mostPopularMovies = [];
    data.mostPopularShows = [];
    mockShelvesReturn({ data });

    renderOverview();

    // Every shelf keeps its heading and shows a quiet empty note instead of vanishing.
    expect(screen.getByText('media.landing.shelves.recentlyAddedMovies')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.recentlyAddedShows')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.mostPopularMovies')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.mostPopularShows')).toBeInTheDocument();
    expect(screen.getAllByText('media.landing.shelves.emptyRecentlyAdded')).toHaveLength(2);
    expect(screen.getAllByText('media.landing.shelves.emptyMostPopular')).toHaveLength(2);
  });
});

describe('MediaOverview as a member', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user.role = 'member';
    mockUseServer.mockReturnValue(serverReturn());
    mockUseLibraryStats.mockReturnValue(statsReturn());
    mockUseLibraryGrowth.mockReturnValue(growthReturn());
    mockUseLibraryStatus.mockReturnValue(statusReturn());
  });

  it('shows the counts line and the not-watched link, with no stat cards or growth chart', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(screen.getByText(/library\.overview\.movieCount.*300/)).toBeInTheDocument();
    expect(screen.getByText(/library\.overview\.showCount.*40/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'library.overview.notWatchedByYou' })).toHaveAttribute(
      'href',
      '/media/browse?watched=unwatched'
    );
    expect(screen.queryByText('library.overview.totalItems')).not.toBeInTheDocument();
    expect(screen.queryByTestId('library-growth-chart')).not.toBeInTheDocument();
    expect(screen.queryByText(/library\.overview\.lastUpdated/)).not.toBeInTheDocument();
  });

  it('skips the sync status and growth reads, and asks for a fixed month of shelves', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(mockUseLibraryStatus).toHaveBeenCalledWith([]);
    expect(mockUseLibraryGrowth.mock.calls[0]?.[0]).toEqual([]);
    expect(mockUseShelves).toHaveBeenCalledWith(
      ['srv-1'],
      expect.objectContaining({ period: 'month' }),
      false
    );
  });

  it('shows no sync banner and no sync empty state even when every server is unready', () => {
    mockUseLibraryStatus.mockReturnValue(
      statusReturn({ 'srv-1': { isSynced: false, needsBackfill: true, isBackfillRunning: false } })
    );
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(screen.queryByTestId('library-empty-state')).not.toBeInTheDocument();
    expect(screen.queryByText('library.overview.serversNeedSync')).not.toBeInTheDocument();
    expect(screen.getAllByText('Recently Added Movie').length).toBeGreaterThan(0);
  });

  it('never renders Recently Updated, even when the response has rows for it', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(screen.queryByText('media.landing.shelves.recentlyUpdated')).not.toBeInTheDocument();
    expect(screen.queryByText('Replaced Movie')).not.toBeInTheDocument();
  });

  it('leaves out every shelf with no rows, heading and empty note included', () => {
    const shelves = fullShelves();
    mockShelvesReturn({
      data: { ...shelves, recentlyUpdated: [], mostPopularMovies: [], mostPopularShows: [] },
    });

    renderOverview();

    expect(screen.getByText('media.landing.shelves.recentlyAddedMovies')).toBeInTheDocument();
    for (const key of ['recentlyUpdated', 'mostPopularMovies', 'mostPopularShows']) {
      expect(screen.queryByText(`media.landing.shelves.${key}`)).not.toBeInTheDocument();
    }
    expect(screen.queryByText('media.landing.shelves.emptyMostPopular')).not.toBeInTheDocument();
    expect(
      screen.queryByText('media.landing.shelves.emptyRecentlyUpdated')
    ).not.toBeInTheDocument();
  });

  it('shows a plain empty state with no sync buttons when the library has nothing', () => {
    mockShelvesReturn({
      data: {
        ...fullShelves(),
        meta: { movies: 0, shows: 0, artists: 0, albums: 0, totalFileSize: 0 },
      },
    });

    renderOverview();

    expect(screen.getByText('library.overview.memberEmpty.title')).toBeInTheDocument();
    expect(screen.queryByTestId('library-empty-state')).not.toBeInTheDocument();
  });

  it('renders Most Popular without play or viewer counts when the server leaves them off', () => {
    const shelves = fullShelves();
    const strip = ({ plays: _plays, viewers: _viewers, ...row }: MostPopularShelfRow) => row;
    mockShelvesReturn({
      data: {
        ...shelves,
        mostPopularMovies: shelves.mostPopularMovies.map(strip),
        mostPopularShows: shelves.mostPopularShows.map(strip),
      },
    });

    renderOverview();

    expect(screen.getAllByText('Popular Movie').length).toBeGreaterThan(0);
    expect(screen.queryByText(/common:count\.play/)).not.toBeInTheDocument();
    expect(screen.queryByText(/media\.posterCard\.viewers/)).not.toBeInTheDocument();
  });
});
