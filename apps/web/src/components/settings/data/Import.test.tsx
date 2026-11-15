import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { TofaBackfillStatus } from '@tracearr/shared';
import { Import, ImportSources } from './Import';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { percent?: number }) =>
      opts?.percent === undefined ? key : `${key} ${opts.percent}`,
  }),
}));

vi.mock('@/hooks/queries', () => ({
  useServers: vi.fn(),
  useSettings: vi.fn(() => ({ data: {}, isLoading: false })),
  useUpdateSettings: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

const socketState = vi.hoisted(() => ({ socket: null as unknown }));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => socketState }));

// Import.tsx's mount effects reach into api.import.tautulli/jellystat/playbackReporting,
// not flat api.import.* names; a missing nested key throws when they call it, not at import time.
vi.mock('@/lib/api', () => ({
  api: {
    import: {
      tautulli: {
        test: vi.fn(),
        start: vi.fn(),
        getActive: vi.fn().mockResolvedValue({ active: false }),
      },
      jellystat: {
        start: vi.fn(),
        getActive: vi.fn().mockResolvedValue({ active: false }),
      },
      playbackReporting: {
        test: vi.fn(),
        start: vi.fn(),
        getActive: vi.fn().mockResolvedValue({ active: false }),
      },
      tofa: {
        start: vi.fn(),
        getActive: vi.fn().mockResolvedValue({ active: false, backfill: null }),
      },
    },
  },
}));

import { api } from '@/lib/api';
import { useServers } from '@/hooks/queries';

function Providers({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function renderImport() {
  return render(<Import />, { wrapper: Providers });
}

function withTofaImport(backfill: TofaBackfillStatus) {
  vi.mocked(useServers).mockReturnValue({
    data: [{ id: 'tofa-1', name: 'Den', type: 'tofa' }],
    isLoading: false,
  } as unknown as ReturnType<typeof useServers>);
  vi.mocked(api.import.tofa.getActive).mockResolvedValue({ active: false, backfill });
}

function heldImport(percent: number) {
  return {
    active: true,
    jobId: 'job-1',
    state: 'delayed',
    waiting: {
      state: 'waitingForLibrarySync' as const,
      librarySync: { state: 'running' as const, progress: percent },
    },
  };
}

describe('Import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketState.socket = null;
    vi.mocked(api.import.jellystat.getActive).mockResolvedValue({ active: false });
    vi.mocked(api.import.playbackReporting.getActive).mockResolvedValue({ active: false });
  });

  it('points a reader with no servers at the connections page', () => {
    vi.mocked(useServers).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);

    renderImport();

    expect(screen.getByText('import.noServers')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'servers.addServer' })).toHaveAttribute(
      'href',
      '/settings/servers/connections'
    );
  });

  it('numbers every step marker, including the third', () => {
    vi.mocked(useServers).mockReturnValue({
      data: [
        { id: 'jf-1', name: 'Jelly', type: 'jellyfin' },
        { id: 'jf-2', name: 'Den', type: 'jellyfin' },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);

    renderImport();

    // Playback Reporting and Jellystat both render here and both start with
    // steps 1 and 2 on the shared StepBadge, so those numbers appear twice.
    expect(screen.getAllByText('1')).toHaveLength(2);
    expect(screen.getAllByText('2')).toHaveLength(2);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('targets the only server without asking, so Jellystat has two steps', () => {
    vi.mocked(useServers).mockReturnValue({
      data: [{ id: 'jf-1', name: 'Jelly', type: 'jellyfin' }],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);

    renderImport();

    expect(screen.queryByText('import.selectJellyfinServer')).toBeNull();
    expect(screen.queryByText('3')).toBeNull();
  });

  it('states the skipped-records caveat as a warning notice', () => {
    vi.mocked(useServers).mockReturnValue({
      data: [{ id: 'jf-1', name: 'Jelly', type: 'jellyfin' }],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);

    renderImport();

    // Two matches: PlaybackReportingImportSection (out of scope for this task,
    // untouched) carries its own hardcoded copy of the same caveat text.
    const notices = screen.getAllByText('import.recordsMayBeSkipped');
    const jellystatNotice = notices
      .map((node) => node.closest('[data-slot="alert"]'))
      .find((alert) => alert?.getAttribute('data-variant') === 'warning');
    expect(jellystatNotice).toHaveAttribute('data-variant', 'warning');
  });

  it('accepts a Jellystat .jsonl backup as well as .json and asks for a full backup', () => {
    vi.mocked(useServers).mockReturnValue({
      data: [{ id: 'jf-1', name: 'Jelly', type: 'jellyfin' }],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);

    const { container } = renderImport();

    const input = container.querySelector('input[type="file"][accept]');
    expect(input).toHaveAttribute('accept', '.json,.jsonl');
    expect(screen.getByText('import.exportFullBackupHint')).toBeInTheDocument();
    expect(screen.getByText('import.exportFullBackupHelp')).toBeInTheDocument();
  });

  it('offers a tofa server its own history import and no Tautulli or Jellystat', async () => {
    vi.mocked(useServers).mockReturnValue({
      data: [{ id: 'tofa-1', name: 'Den', type: 'tofa' }],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);
    vi.mocked(api.import.tofa.getActive).mockResolvedValue({ active: false, backfill: null });
    vi.mocked(api.import.tofa.start).mockResolvedValue({ status: 'queued', message: '' });

    renderImport();

    expect(screen.queryByText('import.noServers')).not.toBeInTheDocument();
    expect(screen.queryByText('import.tautulliUrl')).not.toBeInTheDocument();
    expect(screen.queryByText('import.playbackReporting')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'import.importTofaHistory' }));
    expect(api.import.tofa.start).toHaveBeenCalledWith('tofa-1');
  });

  it.each([
    { source: 'tautulli', server: { id: 'plex-1', name: 'Den', type: 'plex' } },
    { source: 'jellystat', server: { id: 'jf-1', name: 'Jelly', type: 'jellyfin' } },
    { source: 'playbackReporting', server: { id: 'jf-1', name: 'Jelly', type: 'jellyfin' } },
  ] as const)('counts a running $source import as started', async ({ source, server }) => {
    vi.mocked(useServers).mockReturnValue({
      data: [server],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);
    vi.mocked(api.import[source].getActive).mockResolvedValueOnce({ active: true, jobId: 'job-1' });
    const onStarted = vi.fn();

    render(<ImportSources serverType={server.type} onStarted={onStarted} />, {
      wrapper: Providers,
    });

    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(api.import[source].getActive).toHaveBeenCalledTimes(1);
  });

  it.each(['jellystat', 'playbackReporting'] as const)(
    'says a held %s import waits for the library sync, with no Start button for it',
    async (source) => {
      vi.mocked(useServers).mockReturnValue({
        data: [{ id: 'jf-1', name: 'Jelly', type: 'jellyfin' }],
        isLoading: false,
      } as unknown as ReturnType<typeof useServers>);
      vi.mocked(api.import[source].getActive).mockResolvedValueOnce(heldImport(40));

      renderImport();

      expect(await screen.findByText('import.waitingForLibrarySyncPercent 40')).toBeInTheDocument();
      expect(screen.queryByText('import.importInProgressGeneric')).toBeNull();
      expect(screen.queryByRole('button', { name: 'import.importing' })).toBeNull();
      // The other Jellyfin importer keeps its own Start button
      expect(screen.getAllByRole('button', { name: 'import.startImport' })).toHaveLength(1);
    }
  );

  it.each(['jellystat', 'playbackReporting'] as const)(
    'follows a held %s import as the sync moves, and shows it importing once released',
    async (source) => {
      vi.mocked(useServers).mockReturnValue({
        data: [{ id: 'jf-1', name: 'Jelly', type: 'jellyfin' }],
        isLoading: false,
      } as unknown as ReturnType<typeof useServers>);
      const getActive = vi.mocked(api.import[source].getActive);
      getActive.mockResolvedValue(heldImport(40));
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <ImportSources serverType="jellyfin" />
          </MemoryRouter>
        </QueryClientProvider>
      );
      expect(await screen.findByText('import.waitingForLibrarySyncPercent 40')).toBeInTheDocument();

      getActive.mockResolvedValue(heldImport(75));
      await queryClient.invalidateQueries({ queryKey: ['import'] });
      expect(await screen.findByText('import.waitingForLibrarySyncPercent 75')).toBeInTheDocument();

      getActive.mockResolvedValue({
        active: true,
        jobId: 'job-1',
        state: 'waiting',
        waiting: null,
      });
      await queryClient.invalidateQueries({ queryKey: ['import'] });
      await waitFor(() =>
        expect(screen.queryByText(/import\.waitingForLibrarySync/)).not.toBeInTheDocument()
      );
      expect(screen.getByText('import.importInProgressGeneric')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'import.importing' })).toBeDisabled();
    }
  );

  it.each([
    ['jellystat', 'import:jellystat:progress'],
    ['playbackReporting', 'import:playbackreporting:progress'],
  ] as const)(
    'asks again at once when %s progress arrives while the import shows as waiting',
    async (source, event) => {
      const handlers = new Map<string, (progress: unknown) => void>();
      socketState.socket = {
        on: (name: string, handler: (progress: unknown) => void) => handlers.set(name, handler),
        off: vi.fn(),
      };
      vi.mocked(useServers).mockReturnValue({
        data: [{ id: 'jf-1', name: 'Jelly', type: 'jellyfin' }],
        isLoading: false,
      } as unknown as ReturnType<typeof useServers>);
      const getActive = vi.mocked(api.import[source].getActive);
      getActive.mockResolvedValue(heldImport(40));

      render(<ImportSources serverType="jellyfin" />, { wrapper: Providers });
      expect(await screen.findByText('import.waitingForLibrarySyncPercent 40')).toBeInTheDocument();

      getActive.mockResolvedValue({ active: true, jobId: 'job-1', state: 'active', waiting: null });
      act(() => handlers.get(event)?.({ status: 'processing', message: 'Importing 10 plays' }));

      expect(await screen.findByText('Importing 10 plays')).toBeInTheDocument();
      expect(screen.queryByText(/import\.waitingForLibrarySync/)).not.toBeInTheDocument();
    }
  );

  it('counts a running tofa import as started and shows its progress', async () => {
    withTofaImport({
      state: 'running',
      progress: {
        status: 'processing',
        fetchedRecords: 200,
        processedRecords: 50,
        importedRecords: 40,
        skippedRecords: 10,
        duplicateRecords: 0,
        unknownUserRecords: 10,
        activeRecords: 0,
        errorRecords: 0,
        message: 'Processing: 50 plays',
      },
    });
    const onStarted = vi.fn();

    render(<ImportSources serverType="tofa" onStarted={onStarted} />, { wrapper: Providers });

    expect(await screen.findByText('Processing: 50 plays')).toBeInTheDocument();
    expect(screen.getByText('50 / 200')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'import.importing' })).toBeDisabled();
    expect(onStarted).toHaveBeenCalled();
  });

  it('says a held tofa import waits for the library sync rather than importing', async () => {
    withTofaImport({ state: 'waitingForLibrarySync', librarySync: null });

    renderImport();

    expect(await screen.findByText('import.waitingForLibrarySync')).toBeInTheDocument();
    expect(screen.queryByText('import.importInProgressGeneric')).toBeNull();
    expect(screen.queryByRole('button', { name: 'import.importing' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'import.importTofaHistory' })).toBeNull();
  });

  it('shows a finished tofa import with its result and offers no second import', async () => {
    withTofaImport({
      state: 'complete',
      result: {
        success: true,
        imported: 120,
        skipped: 30,
        duplicates: 25,
        errors: 0,
        message: 'Import complete: 120 imported',
      },
      finishedAt: 1_700_000_000_000,
    });

    renderImport();

    expect(await screen.findByText('Import complete: 120 imported')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('import.duplicates')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'import.importTofaHistory' })).toBeNull();
  });

  it('offers the tofa import again after one failed', async () => {
    withTofaImport({ state: 'failed', message: 'tofa answered 500' });

    renderImport();

    expect(await screen.findByText('tofa answered 500')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'import.importTofaHistory' })).toBeEnabled();
  });

  it('shows only the importer for the server type it is given', () => {
    vi.mocked(useServers).mockReturnValue({
      data: [
        { id: 'plex-1', name: 'Den', type: 'plex' },
        { id: 'jf-1', name: 'Jelly', type: 'jellyfin' },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);

    const { unmount } = render(<ImportSources serverType="plex" />, { wrapper: Providers });
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByLabelText('import.tautulliUrl')).toBeInTheDocument();
    expect(screen.queryByText('import.playbackReporting')).not.toBeInTheDocument();
    unmount();

    render(<ImportSources serverType="jellyfin" />, { wrapper: Providers });
    expect(screen.queryByLabelText('import.tautulliUrl')).not.toBeInTheDocument();
    expect(screen.getByText('import.uploadJellystatBackup')).toBeInTheDocument();
  });
});
