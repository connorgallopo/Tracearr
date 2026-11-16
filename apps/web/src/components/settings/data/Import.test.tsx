import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { act, configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { LatestImportStatus, TofaImportProgress, TofaImportResult } from '@tracearr/shared';
import { Import, ImportSources } from './Import';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts === undefined ? key : [key, ...Object.values(opts)].join(' '),
  }),
}));

vi.mock('@/hooks/queries', () => ({
  useServers: vi.fn(),
  useSettings: vi.fn(() => ({
    data: { tautulliUrl: 'http://tautulli:8181', tautulliApiKey: 'key' },
    isLoading: false,
  })),
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
        getActive: vi.fn().mockResolvedValue({ active: false, latest: null }),
      },
      jellystat: {
        start: vi.fn(),
        getActive: vi.fn().mockResolvedValue({ active: false, latest: null }),
      },
      playbackReporting: {
        test: vi.fn(),
        start: vi.fn(),
        getActive: vi.fn().mockResolvedValue({ active: false, latest: null }),
      },
      tofa: {
        start: vi.fn(),
        getActive: vi.fn().mockResolvedValue({ active: false, latest: null }),
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

function withTofaImport(latest: LatestImportStatus<TofaImportProgress, TofaImportResult>) {
  vi.mocked(useServers).mockReturnValue({
    data: [{ id: 'tofa-1', name: 'Den', type: 'tofa' }],
    isLoading: false,
  } as unknown as ReturnType<typeof useServers>);
  vi.mocked(api.import.tofa.getActive).mockResolvedValue({ active: false, latest });
}

function heldImport(percent: number) {
  const waiting = {
    state: 'waitingForLibrarySync' as const,
    librarySync: { state: 'running' as const, progress: percent },
  };
  return { active: true, jobId: 'job-1', state: 'delayed', waiting, latest: waiting };
}

const running = { state: 'running' as const, progress: null };

describe('Import', () => {
  // The card's live region repeats its message for screen readers; text queries look at the card
  beforeAll(() => configure({ defaultIgnore: 'script, style, [role="status"]' }));
  afterAll(() => configure({ defaultIgnore: 'script, style' }));

  beforeEach(() => {
    vi.clearAllMocks();
    socketState.socket = null;
    vi.mocked(api.import.tautulli.getActive).mockResolvedValue({ active: false, latest: null });
    vi.mocked(api.import.jellystat.getActive).mockResolvedValue({ active: false, latest: null });
    vi.mocked(api.import.playbackReporting.getActive).mockResolvedValue({
      active: false,
      latest: null,
    });
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
    vi.mocked(api.import.tofa.getActive).mockResolvedValue({ active: false, latest: null });
    vi.mocked(api.import.tofa.start).mockResolvedValue({ status: 'queued', message: '' });

    renderImport();

    expect(screen.queryByText('import.noServers')).not.toBeInTheDocument();
    expect(screen.queryByText('import.tautulliUrl')).not.toBeInTheDocument();
    expect(screen.queryByText('import.playbackReporting')).not.toBeInTheDocument();
    // The live region is in place before the first state, so that state is announced
    const region = screen.getByRole('status');
    expect(region).toBeEmptyDOMElement();
    await userEvent.click(screen.getByRole('button', { name: 'import.importTofaHistory' }));
    expect(api.import.tofa.start).toHaveBeenCalledWith('tofa-1');
    expect(region).toHaveTextContent('import.importing');
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
    vi.mocked(api.import[source].getActive).mockResolvedValueOnce({
      active: true,
      jobId: 'job-1',
      latest: running,
    });
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
        state: 'active',
        waiting: null,
        latest: running,
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

      getActive.mockResolvedValue({
        active: true,
        jobId: 'job-1',
        state: 'active',
        waiting: null,
        latest: running,
      });
      act(() =>
        handlers.get(event)?.({
          serverId: 'jf-1',
          status: 'processing',
          message: 'Importing 10 plays',
        })
      );

      expect(await screen.findByText('Importing 10 plays')).toBeInTheDocument();
      expect(screen.queryByText(/import\.waitingForLibrarySync/)).not.toBeInTheDocument();
    }
  );

  it('counts a running tofa import as started and shows its progress', async () => {
    withTofaImport({
      state: 'running',
      progress: {
        serverId: 'tofa-1',
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

  it('shows a finished tofa import with its result and offers a second import', async () => {
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
    expect(screen.getByText('import.duplicates 25')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'import.importTofaHistory' })).toBeEnabled();
  });

  const sources = [
    {
      source: 'tautulli',
      server: { id: 'plex-1', name: 'Den', type: 'plex' },
      label: 'import.startImport',
    },
    {
      source: 'jellystat',
      server: { id: 'jf-1', name: 'Jelly', type: 'jellyfin' },
      label: 'import.startImport',
    },
    {
      source: 'playbackReporting',
      server: { id: 'jf-1', name: 'Jelly', type: 'jellyfin' },
      label: 'import.startImport',
    },
    {
      source: 'tofa',
      server: { id: 'tofa-1', name: 'Den', type: 'tofa' },
      label: 'import.importTofaHistory',
    },
  ] as const;

  function withImport(
    { source, server }: (typeof sources)[number],
    latest: LatestImportStatus<never, never>
  ) {
    vi.mocked(useServers).mockReturnValue({
      data: [server],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);
    vi.mocked(api.import[source].getActive).mockResolvedValue({ active: false, latest });
    render(<ImportSources serverType={server.type} />, { wrapper: Providers });
  }

  // The other Jellyfin importer keeps its own Start button
  const otherStartButtons = (server: { type: string }) => (server.type === 'jellyfin' ? 1 : 0);

  it.each(sources)(
    'says a $source import waiting for the library sync starts on its own, with nothing to start',
    async (entry) => {
      withImport(entry, { state: 'waitingForLibrarySync', librarySync: null });

      expect(await screen.findByText('import.waitingForLibrarySync')).toBeInTheDocument();
      expect(screen.getAllByRole('status').map((region) => region.textContent)).toContain(
        'import.waitingForLibrarySync'
      );
      expect(screen.queryAllByRole('button', { name: entry.label })).toHaveLength(
        otherStartButtons(entry.server)
      );
    }
  );

  it.each(sources)(
    'says a $source import retries with the reason and the attempt to come, with nothing to start',
    async (entry) => {
      withImport(entry, { state: 'retrying', attempt: 1, attempts: 3, reason: 'unreachable' });

      expect(await screen.findByText('import.importRetrying unreachable 2 3')).toBeInTheDocument();
      expect(screen.queryAllByRole('button', { name: entry.label })).toHaveLength(
        otherStartButtons(entry.server)
      );
      expect(screen.queryByRole('button', { name: 'import.startAgain' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'import.importing' })).toBeNull();
    }
  );

  it.each(sources)(
    'says why a $source import failed and starts it again from Start again',
    async (entry) => {
      withImport(entry, { state: 'failed', reason: 'key rejected' });

      expect(await screen.findByText('import.importFailedReason key rejected')).toBeInTheDocument();
      const again = screen.getByRole('button', { name: 'import.startAgain' });
      if (entry.source === 'jellystat') {
        // The backup went with the failed import, so it is asked for again
        expect(again).toBeDisabled();
        const backup = new File(['[]'], 'backup.json', { type: 'application/json' });
        const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
        if (!picker) throw new Error('no file picker');
        await userEvent.upload(picker, backup);
      }
      await userEvent.click(again);

      const start = {
        tautulli: ['plex-1', false, false],
        jellystat: ['jf-1', expect.any(File), true, false],
        playbackReporting: ['jf-1', expect.any(String), true, false],
        tofa: ['tofa-1'],
      }[entry.source];
      expect(api.import[entry.source].start).toHaveBeenCalledWith(...start);
    }
  );

  it('announces a run once, then its retry and its failure, as its socket channel says', async () => {
    const handlers = new Map<string, (progress: unknown) => void>();
    socketState.socket = {
      on: (name: string, handler: (progress: unknown) => void) => handlers.set(name, handler),
      off: vi.fn(),
    };
    withTofaImport({ state: 'running', progress: null });

    renderImport();
    expect(await screen.findByText('import.importInProgressGeneric')).toBeInTheDocument();
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('import.importing');

    const emit = (progress: object) =>
      act(() => handlers.get('import:tofa:progress')?.({ serverId: 'tofa-1', ...progress }));
    const page = (processed: number) => ({
      status: 'processing',
      message: `Processing: ${processed} plays`,
      fetchedRecords: 200,
      processedRecords: processed,
      importedRecords: processed,
      skippedRecords: 0,
      errorRecords: 0,
    });
    emit(page(50));
    emit(page(100));
    expect(screen.getByText('Processing: 100 plays')).toBeInTheDocument();
    expect(region).toHaveTextContent(/^import\.importing$/);
    emit({
      status: 'retrying',
      message: 'Attempt 1 of 3 failed',
      retry: { attempt: 1, attempts: 3, reason: 'tofa answered 503' },
    });
    expect(screen.getByText('import.importRetrying tofa answered 503 2 3')).toBeInTheDocument();
    expect(region).toHaveTextContent('import.importRetrying tofa answered 503 2 3');
    expect(screen.queryByRole('button', { name: 'import.importTofaHistory' })).toBeNull();

    emit({ status: 'error', message: 'Import failed: tofa answered 503' });
    expect(region).toHaveTextContent('Import failed: tofa answered 503');
    expect(screen.getByRole('button', { name: 'import.startAgain' })).toBeEnabled();
  });

  it('shows a tofa server its own live progress, never that of another server', async () => {
    const handlers = new Map<string, (progress: unknown) => void>();
    socketState.socket = {
      on: (name: string, handler: (progress: unknown) => void) => handlers.set(name, handler),
      off: vi.fn(),
    };
    vi.mocked(useServers).mockReturnValue({
      data: [
        { id: 'tofa-1', name: 'Den', type: 'tofa' },
        { id: 'tofa-2', name: 'Attic', type: 'tofa' },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);
    vi.mocked(api.import.tofa.getActive).mockResolvedValue({ active: false, latest: null });
    const onStarted = vi.fn();

    render(<ImportSources serverType="tofa" onStarted={onStarted} />, { wrapper: Providers });
    expect(screen.getByRole('combobox', { name: 'import.targetServer' })).toHaveTextContent('Den');

    act(() =>
      handlers.get('import:tofa:progress')?.({
        serverId: 'tofa-2',
        status: 'processing',
        message: 'Processing: 50 plays',
        fetchedRecords: 200,
        processedRecords: 50,
        importedRecords: 50,
        skippedRecords: 0,
        errorRecords: 0,
      })
    );
    expect(screen.queryByText('Processing: 50 plays')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'import.importTofaHistory' })).toBeEnabled();
    expect(onStarted).not.toHaveBeenCalled();

    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'import.targetServer' }));
    await user.click(await screen.findByRole('option', { name: /Attic/ }));

    expect(screen.getByText('Processing: 50 plays')).toBeInTheDocument();
  });

  it('says a picked file is not a Jellystat backup at the dropzone, and leaves the import unstarted', async () => {
    vi.mocked(useServers).mockReturnValue({
      data: [{ id: 'jf-1', name: 'Jelly', type: 'jellyfin' }],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);
    const { container } = renderImport();
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!picker) throw new Error('no file picker');

    await userEvent
      .setup({ applyAccept: false })
      .upload(picker, new File(['x'], 'notes.txt', { type: 'text/plain' }));

    expect(screen.getByText('import.pleaseSelectBackupFile')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'import.startAgain' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'import.startImport' })).toHaveLength(2);
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
