import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router';
import { LibraryStorage } from './Storage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

const mockUseLibraryStorageScoped = vi.hoisted(() => vi.fn());
const mockUseLibraryStale = vi.hoisted(() => vi.fn());
const mockUseLibraryRoi = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => ({ data: undefined, isLoading: false }))
);
const mockRoiTable = vi.hoisted(() => vi.fn((_props: unknown) => null));
const mockUseMultiServerQuery = vi.hoisted(() => vi.fn());
const mockLibrariesTable = vi.hoisted(() => vi.fn((_props: unknown) => null));
vi.mock('@/hooks/queries', () => ({
  useLibraryDuplicates: () => ({ data: undefined, isLoading: false, isError: false }),
  useLibraryStale: mockUseLibraryStale,
  useLibraryRoi: mockUseLibraryRoi,
  useLibraryStatus: () => ({
    byServer: new Map([['srv-1', { data: { isSynced: true } }]]),
    isLoading: false,
  }),
  useLibraryStorageScoped: mockUseLibraryStorageScoped,
}));
vi.mock('@/hooks/useMultiServerQuery', () => ({ useMultiServerQuery: mockUseMultiServerQuery }));

const serverState = vi.hoisted(() => ({
  selectedServerIds: ['srv-1'],
  selectedServers: [{ id: 'srv-1', name: 'Den' }],
  servers: [{ id: 'srv-1' }],
  isMultiServer: false,
}));
vi.mock('@/hooks/useServer', () => ({ useServer: () => serverState }));

vi.mock('@/components/library', () => ({
  ErrorState: () => null,
  InlineErrorState: ({ message }: { message: string }) => <p>{message}</p>,
  LibraryEmptyState: () => null,
  DuplicatesTable: () => null,
  StaleContentTabs: () => <div data-testid="stale-tabs" />,
  RoiTable: mockRoiTable,
  StorageLibrariesTable: mockLibrariesTable,
}));
vi.mock('@/components/charts', () => ({ StoragePredictionChart: () => null }));
vi.mock('@/components/server', () => ({ PerServerCardGrid: () => null }));
vi.mock('@/lib/api', () => ({
  api: { library: { storage: vi.fn() }, servers: { sync: vi.fn() } },
}));

const GB = 1024 ** 3;

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Link to="/library/storage?period=year">change range</Link>
      <LibraryStorage />
    </MemoryRouter>
  );
}

const ONE_SERVER = { ...serverState };

function storageResponse(libraries: unknown[]) {
  return {
    current: { totalSizeBytes: 500 * GB, totalItems: 812, lastUpdated: null },
    history: [],
    growthRate: null,
    predictions: {},
    libraries,
  };
}

describe('LibraryStorage', () => {
  beforeEach(() => {
    Object.assign(serverState, ONE_SERVER);
    mockUseMultiServerQuery.mockReturnValue({ byServer: new Map(), isLoading: false });
    mockUseLibraryStorageScoped.mockReturnValue({ data: undefined, isLoading: false });
    mockUseLibraryStale.mockReturnValue({
      isLoading: false,
      data: {
        summary: {
          neverWatched: { count: 3, sizeBytes: 12 * GB },
          stale: { count: 5, sizeBytes: 40 * GB },
        },
      },
    });
  });

  it('has no Dead Weight section; the stale card counts never-watched plus stale', () => {
    renderAt('/library/storage');

    expect(screen.queryByText(/deadWeight/)).not.toBeInTheDocument();
    expect(screen.getByText('library.storage.itemCount:{"count":8}')).toBeInTheDocument();
    expect(screen.getByText('library.storage.unusedSize:{"size":"52 GB"}')).toBeInTheDocument();
    expect(mockUseLibraryStale).toHaveBeenCalledWith(['srv-1'], null, 90, 'all', 1, 1);
  });

  it("lists each server's libraries tagged with that server", () => {
    const movies = {
      libraryId: '1',
      name: 'Movies',
      mediaType: 'movie',
      itemCount: 812,
      sizeBytes: 500 * GB,
    };
    mockUseMultiServerQuery.mockReturnValue({
      byServer: new Map([['srv-1', { isLoading: false, data: storageResponse([movies]) }]]),
      isLoading: false,
    });

    renderAt('/library/storage');

    expect(screen.getByText('library.storage.libraries.title')).toBeInTheDocument();
    expect(mockLibrariesTable.mock.lastCall?.[0]).toMatchObject({
      rows: [{ ...movies, serverId: 'srv-1', serverName: 'Den' }],
      isLoading: false,
    });
  });

  it('keeps the libraries that loaded and names the server whose storage failed', () => {
    Object.assign(serverState, {
      selectedServerIds: ['srv-1', 'srv-2'],
      selectedServers: [
        { id: 'srv-1', name: 'Den' },
        { id: 'srv-2', name: 'Loft' },
      ],
      isMultiServer: true,
    });
    const movies = {
      libraryId: '1',
      name: 'Movies',
      mediaType: 'movie',
      itemCount: 812,
      sizeBytes: GB,
    };
    mockUseMultiServerQuery.mockReturnValue({
      byServer: new Map([
        ['srv-1', { isLoading: false, isError: false, data: storageResponse([movies]) }],
        ['srv-2', { isLoading: false, isError: true, error: new Error('boom'), data: undefined }],
      ]),
      isLoading: false,
    });

    renderAt('/library/storage');

    expect(mockLibrariesTable.mock.lastCall?.[0]).toMatchObject({
      rows: [{ ...movies, serverId: 'srv-1', serverName: 'Den' }],
    });
    expect(
      screen.getByText('library.storage.libraries.serverFailed:{"servers":"Loft"}')
    ).toBeInTheDocument();
  });

  it('passes a custom range to the storage queries as its start and end', () => {
    renderAt('/library/storage?period=custom&from=2026-03-02&to=2026-03-05');
    const start = '2026-03-02T00:00:00.000Z';
    const end = '2026-03-06T00:00:00.000Z';

    expect(mockUseLibraryStorageScoped).toHaveBeenLastCalledWith(
      ['srv-1'],
      '30d',
      false,
      start,
      end
    );
    const factory = mockUseMultiServerQuery.mock.calls[0]?.[1];
    expect(factory('srv-1').queryKey).toEqual([
      'library',
      'storage',
      'srv-1',
      undefined,
      '30d',
      start,
      end,
    ]);
  });

  it('returns the ROI table to page 1 when the range changes', () => {
    renderAt('/library/storage?period=week');
    const roiPage = () => mockUseLibraryRoi.mock.lastCall?.[5];
    const table = () => mockRoiTable.mock.lastCall?.[0] as { onPageChange: (page: number) => void };

    act(() => table().onPageChange(4));
    expect(roiPage()).toBe(4);

    fireEvent.click(screen.getByText('change range'));
    expect(mockUseLibraryRoi.mock.lastCall?.[2]).toBe('1y');
    expect(roiPage()).toBe(1);
  });
});
