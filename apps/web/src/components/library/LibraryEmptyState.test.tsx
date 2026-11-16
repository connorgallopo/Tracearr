import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { WS_EVENTS, type Server } from '@tracearr/shared';
import { initI18n } from '@tracearr/translations';
import { LibraryEmptyState } from './LibraryEmptyState';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));
vi.mock('@/hooks/queries', () => ({
  useLibraryStatus: vi.fn(),
}));
vi.mock('@/hooks/useSocket', () => ({
  useSocket: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  api: {
    servers: { sync: vi.fn() },
    maintenance: { startJob: vi.fn() },
  },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { useServer } from '@/hooks/useServer';
import { useLibraryStatus } from '@/hooks/queries';
import { useSocket } from '@/hooks/useSocket';
import { api } from '@/lib/api';

const mockUseServer = vi.mocked(useServer);
const mockUseLibraryStatus = vi.mocked(useLibraryStatus);
const mockUseSocket = vi.mocked(useSocket);

function server(id: string, name: string): Server {
  return {
    id,
    name,
    type: 'plex',
    url: '',
    color: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

interface StatusData {
  isSynced: boolean;
  isSyncRunning: boolean;
  isSyncQueued?: boolean;
  needsBackfill: boolean;
  isBackfillRunning: boolean;
  backfillDays: number | null;
}

function statusResult(byServer: Record<string, StatusData | undefined>, isLoading = false) {
  const map = new Map();
  for (const [id, data] of Object.entries(byServer)) {
    map.set(id, { data, isLoading: false, isError: false, refetch: vi.fn() });
  }
  return { byServer: map, isLoading, isFetching: false, error: null };
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function useServerReturn(selectedServerIds: string[], selectedServers: Server[]) {
  return {
    servers: selectedServers,
    selectedServerIds,
    selectedServers,
    isMultiServer: selectedServerIds.length > 1,
    isAllServersSelected: true,
    isLoading: false,
    isFetching: false,
    toggleServer: vi.fn(),
    selectAllServers: vi.fn(),
    deselectAllExcept: vi.fn(),
    refetch: vi.fn(),
    selectedServerId: selectedServerIds.length === 1 ? (selectedServerIds[0] ?? null) : null,
    selectedServer: null,
    selectServer: vi.fn(),
  } as unknown as ReturnType<typeof useServer>;
}

describe('LibraryEmptyState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSocket.mockReturnValue({ socket: null } as unknown as ReturnType<typeof useSocket>);
  });

  it('shows a loading state while status is still being fetched', () => {
    mockUseServer.mockReturnValue(useServerReturn(['s1'], [server('s1', 'Plex')]));
    mockUseLibraryStatus.mockReturnValue(statusResult({}, true));

    render(<LibraryEmptyState />, { wrapper: wrapper() });

    expect(screen.getByText('Checking library status...')).toBeInTheDocument();
  });

  it('single server not synced: shows a sync button that syncs that server', async () => {
    mockUseServer.mockReturnValue(useServerReturn(['s1'], [server('s1', 'Plex')]));
    mockUseLibraryStatus.mockReturnValue(
      statusResult({
        s1: {
          isSynced: false,
          isSyncRunning: false,
          needsBackfill: false,
          isBackfillRunning: false,
          backfillDays: null,
        },
      })
    );
    vi.mocked(api.servers.sync).mockResolvedValue({} as never);

    render(<LibraryEmptyState />, { wrapper: wrapper() });

    expect(screen.getByText('Library not synced yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Sync Now/i }));

    await waitFor(() => expect(api.servers.sync).toHaveBeenCalledWith('s1'));
  });

  it('single server with a queued sync: says the sync is queued and keeps Sync Now', () => {
    mockUseServer.mockReturnValue(useServerReturn(['s1'], [server('s1', 'Plex')]));
    mockUseLibraryStatus.mockReturnValue(
      statusResult({
        s1: {
          isSynced: false,
          isSyncRunning: false,
          isSyncQueued: true,
          needsBackfill: false,
          isBackfillRunning: false,
          backfillDays: null,
        },
      })
    );

    render(<LibraryEmptyState />, { wrapper: wrapper() });

    expect(screen.getByText('Library sync queued')).toBeInTheDocument();
    expect(screen.queryByText('Library not synced yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sync Now/i })).toBeInTheDocument();
  });

  it('refetches status once a queued sync reports it is running', () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const socket = {
      on: vi.fn((event: string, cb: (payload: unknown) => void) => handlers.set(event, cb)),
      off: vi.fn(),
    };
    mockUseSocket.mockReturnValue({ socket } as unknown as ReturnType<typeof useSocket>);
    mockUseServer.mockReturnValue(
      useServerReturn(['s1', 's2'], [server('s1', 'Plex'), server('s2', 'Jellyfin')])
    );
    const notSynced = {
      isSynced: false,
      isSyncRunning: false,
      needsBackfill: false,
      isBackfillRunning: false,
      backfillDays: null,
    };
    mockUseLibraryStatus.mockReturnValue(
      statusResult({ s1: { ...notSynced, isSyncQueued: true }, s2: notSynced })
    );
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();

    render(
      <QueryClientProvider client={client}>
        <LibraryEmptyState />
      </QueryClientProvider>
    );
    const onSync = handlers.get(WS_EVENTS.LIBRARY_SYNC_PROGRESS);

    onSync?.({ serverId: 's2', status: 'running' });
    onSync?.({ serverId: 's1', status: 'complete' });
    expect(invalidate).not.toHaveBeenCalled();

    onSync?.({ serverId: 's1', status: 'running' });
    expect(invalidate).toHaveBeenCalledWith(
      { queryKey: ['library', 'status'] },
      { cancelRefetch: false }
    );
  });

  it('multi-server: a server with a queued sync reads Queued, not Not synced yet', () => {
    mockUseServer.mockReturnValue(
      useServerReturn(['s1', 's2'], [server('s1', 'Plex'), server('s2', 'Jellyfin')])
    );
    const notSynced = {
      isSynced: false,
      isSyncRunning: false,
      needsBackfill: false,
      isBackfillRunning: false,
      backfillDays: null,
    };
    mockUseLibraryStatus.mockReturnValue(
      statusResult({ s1: { ...notSynced, isSyncQueued: true }, s2: notSynced })
    );

    render(<LibraryEmptyState />, { wrapper: wrapper() });

    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getAllByText('Not synced yet')).toHaveLength(1);
  });

  it('single server synced with an empty library: shows a media-appropriate message, not "not synced"', () => {
    mockUseServer.mockReturnValue(useServerReturn(['s1'], [server('s1', 'Plex')]));
    mockUseLibraryStatus.mockReturnValue(
      statusResult({
        s1: {
          isSynced: true,
          isSyncRunning: false,
          needsBackfill: false,
          isBackfillRunning: false,
          backfillDays: null,
        },
      })
    );

    render(<LibraryEmptyState />, { wrapper: wrapper() });

    expect(screen.queryByText('Library not synced yet')).not.toBeInTheDocument();
    expect(screen.getByText('No movies or shows yet')).toBeInTheDocument();
  });

  it('single server synced but needing backfill: shows the Generate History action', async () => {
    mockUseServer.mockReturnValue(useServerReturn(['s1'], [server('s1', 'Plex')]));
    mockUseLibraryStatus.mockReturnValue(
      statusResult({
        s1: {
          isSynced: true,
          isSyncRunning: false,
          needsBackfill: true,
          isBackfillRunning: false,
          backfillDays: 30,
        },
      })
    );
    vi.mocked(api.maintenance.startJob).mockResolvedValue({} as never);

    render(<LibraryEmptyState />, { wrapper: wrapper() });

    expect(screen.getByText('Historical data available')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Generate History/i }));

    await waitFor(() =>
      expect(api.maintenance.startJob).toHaveBeenCalledWith('backfill_library_snapshots')
    );
  });

  it('multi-server: lists each unsynced server with its own working Sync Now action', async () => {
    mockUseServer.mockReturnValue(
      useServerReturn(['s1', 's2'], [server('s1', 'Plex'), server('s2', 'Jellyfin')])
    );
    mockUseLibraryStatus.mockReturnValue(
      statusResult({
        s1: {
          isSynced: false,
          isSyncRunning: false,
          needsBackfill: false,
          isBackfillRunning: false,
          backfillDays: null,
        },
        s2: {
          isSynced: false,
          isSyncRunning: false,
          needsBackfill: false,
          isBackfillRunning: false,
          backfillDays: null,
        },
      })
    );
    vi.mocked(api.servers.sync).mockResolvedValue({} as never);

    render(<LibraryEmptyState />, { wrapper: wrapper() });

    expect(screen.getByText('Plex')).toBeInTheDocument();
    expect(screen.getByText('Jellyfin')).toBeInTheDocument();

    const syncButtons = screen.getAllByRole('button', { name: /Sync Now/i });
    expect(syncButtons).toHaveLength(2);

    await userEvent.click(syncButtons[0]!);
    await waitFor(() => expect(api.servers.sync).toHaveBeenCalledWith('s1'));
    expect(api.servers.sync).not.toHaveBeenCalledWith('s2');
  });

  it('multi-server: servers that only need backfill are listed under the shared Generate History action', () => {
    mockUseServer.mockReturnValue(
      useServerReturn(['s1', 's2'], [server('s1', 'Plex'), server('s2', 'Jellyfin')])
    );
    mockUseLibraryStatus.mockReturnValue(
      statusResult({
        s1: {
          isSynced: false,
          isSyncRunning: false,
          needsBackfill: false,
          isBackfillRunning: false,
          backfillDays: null,
        },
        s2: {
          isSynced: true,
          isSyncRunning: false,
          needsBackfill: true,
          isBackfillRunning: false,
          backfillDays: 10,
        },
      })
    );

    render(<LibraryEmptyState />, { wrapper: wrapper() });

    // s1 needs a per-server sync button, s2 is listed as needing the shared backfill
    expect(screen.getAllByRole('button', { name: /Sync Now/i })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Generate History/i })).toBeInTheDocument();
    expect(screen.getByText('Jellyfin')).toBeInTheDocument();
  });

  it('multi-server: backfill running globally shows the shared progress panel, not the per-server list', () => {
    mockUseServer.mockReturnValue(
      useServerReturn(['s1', 's2'], [server('s1', 'Plex'), server('s2', 'Jellyfin')])
    );
    mockUseLibraryStatus.mockReturnValue(
      statusResult({
        s1: {
          isSynced: true,
          isSyncRunning: false,
          needsBackfill: true,
          isBackfillRunning: true,
          backfillDays: 10,
        },
        s2: {
          isSynced: true,
          isSyncRunning: false,
          needsBackfill: true,
          isBackfillRunning: true,
          backfillDays: 10,
        },
      })
    );

    render(<LibraryEmptyState />, { wrapper: wrapper() });

    expect(screen.getByText('Generating historical data...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sync Now/i })).not.toBeInTheDocument();
  });
});
