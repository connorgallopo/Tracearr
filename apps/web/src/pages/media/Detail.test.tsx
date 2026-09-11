import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as ReactRouter from 'react-router';
import type { MediaRequestEntry } from '@tracearr/shared';
import { ApiError } from '@/lib/api';
import { MediaDetail } from './Detail';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof ReactRouter>('react-router');
  return { ...actual, useParams: vi.fn() };
});

vi.mock('@/hooks/queries', () => ({
  useMediaDetail: vi.fn(),
  useMediaStats: vi.fn(),
  useMediaWatchers: vi.fn(),
  useSeasonHeat: vi.fn(),
  useMediaPlatforms: vi.fn(),
  useMediaHistory: vi.fn(),
  useMediaRequests: vi.fn(),
  useSession: vi.fn(),
  findCachedMediaStub: vi.fn(),
}));

// Stub the sheet: it drags in leaflet, and only its wiring matters here.
vi.mock('@/components/history/SessionDetailSheet', () => ({
  SessionDetailSheet: ({ session, open }: { session: { id: string } | null; open: boolean }) =>
    open && session ? <div data-testid="session-sheet">{session.id}</div> : null,
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => options.count * options.estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        start: index * options.estimateSize(),
        key: index,
      })),
    measure: vi.fn(),
    measureElement: vi.fn(),
  }),
}));

import { useParams } from 'react-router';
import {
  useMediaDetail,
  useMediaStats,
  useMediaWatchers,
  useSeasonHeat,
  useMediaPlatforms,
  useMediaHistory,
  useMediaRequests,
  useSession,
  findCachedMediaStub,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';

const mockUseParams = vi.mocked(useParams);
const mockUseMediaDetail = vi.mocked(useMediaDetail);
const mockUseMediaStats = vi.mocked(useMediaStats);
const mockUseMediaWatchers = vi.mocked(useMediaWatchers);
const mockUseSeasonHeat = vi.mocked(useSeasonHeat);
const mockUseMediaPlatforms = vi.mocked(useMediaPlatforms);
const mockUseMediaHistory = vi.mocked(useMediaHistory);
const mockUseMediaRequests = vi.mocked(useMediaRequests);
const mockUseSession = vi.mocked(useSession);
const mockFindCachedMediaStub = vi.mocked(findCachedMediaStub);
const mockUseServer = vi.mocked(useServer);

function pendingQuery(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    isLoading: true,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  } as never;
}

function requestEntry(overrides: Partial<MediaRequestEntry> = {}): MediaRequestEntry {
  return {
    id: 'req-1',
    serverId: 'srv-1',
    status: 'completed',
    requestedAt: '2026-01-08T12:00:00.000Z',
    availableAt: '2026-01-08T12:02:00.000Z',
    waitMs: 120_000,
    deletedAt: null,
    seasons: null,
    is4k: false,
    isAutoRequest: false,
    watchedState: 'unwatched',
    requester: {
      serverUserId: 'su-1',
      userId: 'u-1',
      serverId: 'srv-1',
      username: 'agelwarg',
      identityName: 'Alice',
      thumb: null,
    },
    ...overrides,
  };
}

function detailQuery(mediaType: string) {
  return pendingQuery({
    isLoading: false,
    data: {
      id: 'media-1',
      mediaType,
      title: 'Arrival',
      year: 2016,
      genres: [],
      availability: [],
      seasonCount: null,
      episodeCount: null,
      posterUrl: null,
      posterVersion: null,
      dominantColor: null,
      servers: [],
    },
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MediaDetail />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('MediaDetail page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseParams.mockReturnValue({ id: 'media-1' });
    mockUseServer.mockReturnValue({
      selectedServerIds: ['srv-1'],
      servers: [
        {
          id: 'srv-1',
          name: 'Plex',
          type: 'plex',
          url: 'https://plex.example.com',
          color: '#e5a00d',
        },
      ],
    } as unknown as ReturnType<typeof useServer>);
    mockFindCachedMediaStub.mockReturnValue(undefined);
    mockUseMediaDetail.mockReturnValue(pendingQuery());
    mockUseMediaStats.mockReturnValue(pendingQuery());
    mockUseMediaWatchers.mockReturnValue(pendingQuery());
    mockUseSeasonHeat.mockReturnValue(pendingQuery());
    mockUseMediaPlatforms.mockReturnValue(pendingQuery());
    mockUseMediaHistory.mockReturnValue(
      pendingQuery({ hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn() })
    );
    mockUseMediaRequests.mockReturnValue(pendingQuery({ data: { data: [] }, isLoading: false }));
    mockUseSession.mockReturnValue(pendingQuery({ isLoading: false }));
  });

  it('renders a not-found state for an unknown/removed media id', () => {
    mockUseMediaDetail.mockReturnValue(
      pendingQuery({ isLoading: false, isError: true, error: new ApiError('Not Found', 404) })
    );

    renderPage();

    expect(screen.getByText('media.detail.notFound.title')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('paints the hero from a cached stub immediately while every other section stays in its own loading state', () => {
    mockFindCachedMediaStub.mockReturnValue({
      mediaId: 'media-1',
      title: 'Severance',
      year: 2022,
      posterUrl: '/poster.jpg',
      posterVersion: 'v1',
      dominantColor: '#1f6f6f',
      servers: [],
    });
    mockUseMediaDetail.mockReturnValue(
      pendingQuery({
        data: {
          id: 'media-1',
          title: 'Severance',
          year: 2022,
          posterUrl: '/poster.jpg',
          posterVersion: 'v1',
          dominantColor: '#1f6f6f',
          servers: [],
        },
      })
    );

    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Severance' })).toBeInTheDocument();
    // Watchers/season-heat/platforms/history are all still pending - none of
    // their headings/tables should be blocking the page.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('is whole-audience and server-scoped: every hook receives the selected server ids and no lens picker renders', () => {
    renderPage();

    expect(mockUseMediaDetail).toHaveBeenCalledWith('media-1', ['srv-1'], 'all', undefined);
    expect(mockUseMediaStats).toHaveBeenCalledWith('media-1', ['srv-1']);
    expect(mockUseMediaWatchers).toHaveBeenCalledWith('media-1', ['srv-1']);
    expect(mockUseMediaPlatforms).toHaveBeenCalledWith('media-1', ['srv-1']);
    expect(mockUseMediaHistory).toHaveBeenCalledWith('media-1', ['srv-1']);
    // useMediaDetail's third argument is the fixed 'all' lens, never a
    // per-user selection - there is no lens state anywhere on this page.
    expect(mockUseMediaDetail).toHaveBeenCalledWith('media-1', ['srv-1'], 'all', undefined);
  });

  it('shows who watched each play in the history panel', () => {
    mockUseMediaHistory.mockReturnValue(
      pendingQuery({
        isLoading: false,
        data: {
          pages: [
            {
              data: [
                {
                  id: 'chain-1',
                  server_id: 'srv-1',
                  server_name: 'Plex',
                  media_title: 'Severance',
                  started_at: '2026-07-01T12:00:00.000Z',
                  duration_ms: 2_700_000,
                  watched: true,
                  user: {
                    id: 'user-1',
                    server_user_id: 'server-user-1',
                    username: 'ari',
                    thumb_url: null,
                  },
                },
              ],
            },
          ],
        },
        hasNextPage: false,
        isFetchingNextPage: false,
        fetchNextPage: vi.fn(),
      })
    );

    renderPage();

    expect(screen.getByText('media.detail.history.columns.user')).toBeInTheDocument();
    expect(screen.getByText('ari')).toBeInTheDocument();
  });

  it('links the history user cell to that user profile without triggering the row click', () => {
    mockUseMediaHistory.mockReturnValue(
      pendingQuery({
        isLoading: false,
        data: {
          pages: [
            {
              data: [
                {
                  id: 'chain-1',
                  server_id: 'srv-1',
                  server_name: 'Plex',
                  media_title: 'Severance',
                  started_at: '2026-07-01T12:00:00.000Z',
                  duration_ms: 2_700_000,
                  watched: true,
                  user: {
                    id: 'user-1',
                    server_user_id: 'server-user-1',
                    username: 'ari',
                    thumb_url: null,
                  },
                },
              ],
            },
          ],
        },
        hasNextPage: false,
        isFetchingNextPage: false,
        fetchNextPage: vi.fn(),
      })
    );

    renderPage();

    const link = screen.getByRole('link', { name: /ari/ });
    expect(link).toHaveAttribute('href', '/users/server-user-1');
    fireEvent.click(link);
    // stopPropagation keeps the row's session selection from firing.
    expect(mockUseSession).not.toHaveBeenCalledWith('chain-1');
  });

  it('opens the session slideout with the fetched chain session when a history row is activated', () => {
    mockUseMediaHistory.mockReturnValue(
      pendingQuery({
        isLoading: false,
        data: {
          pages: [
            {
              data: [
                {
                  id: 'chain-1',
                  server_id: 'srv-1',
                  server_name: 'Plex',
                  media_title: 'Severance',
                  started_at: '2026-07-01T12:00:00.000Z',
                  duration_ms: 2_700_000,
                  watched: true,
                  user: {
                    id: 'user-1',
                    server_user_id: 'server-user-1',
                    username: 'ari',
                    thumb_url: null,
                  },
                },
              ],
            },
          ],
        },
        hasNextPage: false,
        isFetchingNextPage: false,
        fetchNextPage: vi.fn(),
      })
    );
    mockUseSession.mockImplementation((id: string) =>
      pendingQuery({
        isLoading: false,
        data: id === 'chain-1' ? { id: 'chain-1' } : undefined,
      })
    );

    renderPage();

    expect(screen.queryByTestId('session-sheet')).not.toBeInTheDocument();
    const [, dataRow] = screen.getAllByRole('row');
    expect(dataRow).toHaveAttribute('tabindex', '0');
    fireEvent.click(dataRow!);

    // The row click selects the chain id; the session hook is asked for it
    // and the sheet opens with the fetched session.
    expect(mockUseSession).toHaveBeenCalledWith('chain-1');
    expect(screen.getByTestId('session-sheet')).toHaveTextContent('chain-1');
  });

  it('activates a history row from the keyboard with Enter', () => {
    mockUseMediaHistory.mockReturnValue(
      pendingQuery({
        isLoading: false,
        data: {
          pages: [
            {
              data: [
                {
                  id: 'chain-1',
                  server_id: 'srv-1',
                  server_name: 'Plex',
                  media_title: 'Severance',
                  started_at: '2026-07-01T12:00:00.000Z',
                  duration_ms: 2_700_000,
                  watched: true,
                  user: {
                    id: 'user-1',
                    server_user_id: 'server-user-1',
                    username: 'ari',
                    thumb_url: null,
                  },
                },
              ],
            },
          ],
        },
        hasNextPage: false,
        isFetchingNextPage: false,
        fetchNextPage: vi.fn(),
      })
    );
    mockUseSession.mockImplementation((id: string) =>
      pendingQuery({
        isLoading: false,
        data: id === 'chain-1' ? { id: 'chain-1' } : undefined,
      })
    );

    renderPage();

    const [, dataRow] = screen.getAllByRole('row');
    fireEvent.keyDown(dataRow!, { key: 'Enter' });
    expect(screen.getByTestId('session-sheet')).toHaveTextContent('chain-1');
  });

  it('sizes the history header and its rows off one shared column template, so they cannot drift out of alignment', () => {
    mockUseMediaHistory.mockReturnValue(
      pendingQuery({
        isLoading: false,
        data: {
          pages: [
            {
              data: [
                {
                  id: 'chain-1',
                  server_id: 'srv-1',
                  server_name: 'Plex',
                  media_title: 'Severance',
                  started_at: '2026-07-01T12:00:00.000Z',
                  duration_ms: 2_700_000,
                  watched: true,
                  user: {
                    id: 'user-1',
                    server_user_id: 'server-user-1',
                    username: 'ari',
                    thumb_url: null,
                  },
                },
              ],
            },
          ],
        },
        hasNextPage: false,
        isFetchingNextPage: false,
        fetchNextPage: vi.fn(),
      })
    );

    renderPage();

    const table = screen.getByRole('table', { name: 'media.detail.history.title' });
    expect(table).toBeInTheDocument();
    const [headerRow, dataRow] = screen.getAllByRole('row');
    const headerColumns = (headerRow as HTMLElement).style.gridTemplateColumns;
    const rowColumns = (dataRow as HTMLElement).style.gridTemplateColumns;
    expect(headerColumns).toBeTruthy();
    expect(headerColumns).toBe(rowColumns);
    // The flexible content column keeps a real floor instead of collapsing to 0.
    expect(headerColumns).toContain('minmax(200px');
  });

  it("sizes a history row to the grid template's own content width, not a flat 100% of the rowgroup, so its border/hover still cover the row once scrolled horizontally", () => {
    mockUseMediaHistory.mockReturnValue(
      pendingQuery({
        isLoading: false,
        data: {
          pages: [
            {
              data: [
                {
                  id: 'chain-1',
                  server_id: 'srv-1',
                  server_name: 'Plex',
                  media_title: 'Severance',
                  started_at: '2026-07-01T12:00:00.000Z',
                  duration_ms: 2_700_000,
                  watched: true,
                  user: {
                    id: 'user-1',
                    server_user_id: 'server-user-1',
                    username: 'ari',
                    thumb_url: null,
                  },
                },
              ],
            },
          ],
        },
        hasNextPage: false,
        isFetchingNextPage: false,
        fetchNextPage: vi.fn(),
      })
    );

    renderPage();

    const [, dataRow] = screen.getAllByRole('row');
    const style = (dataRow as HTMLElement).style;
    expect(style.width).toBe('max-content');
    expect(style.minWidth).toBe('100%');
  });

  it('does not render the season heat panel for a movie', () => {
    mockUseMediaDetail.mockReturnValue(
      pendingQuery({
        isLoading: false,
        data: {
          id: 'media-1',
          mediaType: 'movie',
          title: 'Arrival',
          year: 2016,
          genres: [],
          availability: [],
          seasonCount: null,
          episodeCount: null,
          posterUrl: null,
          posterVersion: null,
          dominantColor: null,
          servers: [],
        },
      })
    );

    renderPage();

    expect(mockUseSeasonHeat).toHaveBeenCalledWith('media-1', ['srv-1'], false);
    expect(screen.queryByText('media.detail.seasons.title')).not.toBeInTheDocument();
  });

  it('shows the requests panel for a title that has requests', () => {
    mockUseMediaDetail.mockReturnValue(detailQuery('movie'));
    mockUseMediaRequests.mockReturnValue(
      pendingQuery({ isLoading: false, data: { data: [requestEntry()] } })
    );

    renderPage();

    expect(mockUseMediaRequests).toHaveBeenCalledWith('media-1', ['srv-1']);
    expect(screen.getByRole('heading', { name: 'requests.mediaPanel.title' })).toBeInTheDocument();
  });

  it('names the earliest request that is still live in the hero line', () => {
    mockUseMediaDetail.mockReturnValue(detailQuery('movie'));
    mockUseMediaRequests.mockReturnValue(
      pendingQuery({
        isLoading: false,
        data: {
          data: [
            requestEntry({
              id: 'req-removed',
              requestedAt: '2026-01-02T12:00:00.000Z',
              deletedAt: '2026-01-20T12:00:00.000Z',
              requester: { ...requestEntry().requester, identityName: 'Removed Rita' },
            }),
            requestEntry({
              id: 'req-later',
              requestedAt: '2026-01-20T12:00:00.000Z',
              requester: { ...requestEntry().requester, identityName: 'Later Leo' },
            }),
            requestEntry({
              id: 'req-earliest',
              requestedAt: '2026-01-05T12:00:00.000Z',
              requester: { ...requestEntry().requester, identityName: 'Earliest Eve' },
            }),
          ],
        },
      })
    );

    renderPage();

    expect(screen.getByText(/"name":"Earliest Eve"/)).toBeInTheDocument();
  });

  it('drops the requests panel on an episode, where the request belongs to the show', () => {
    mockUseMediaDetail.mockReturnValue(detailQuery('episode'));
    mockUseMediaRequests.mockReturnValue(
      pendingQuery({ isLoading: false, data: { data: [requestEntry()] } })
    );

    renderPage();

    expect(
      screen.queryByRole('heading', { name: 'requests.mediaPanel.title' })
    ).not.toBeInTheDocument();
  });
});
