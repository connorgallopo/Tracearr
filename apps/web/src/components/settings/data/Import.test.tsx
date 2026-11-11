import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { Import, ImportSources } from './Import';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/queries', () => ({
  useServers: vi.fn(),
  useSettings: vi.fn(() => ({ data: {}, isLoading: false })),
  useUpdateSettings: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock('@/hooks/useSocket', () => ({ useSocket: () => ({ socket: null }) }));

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
        getActive: vi.fn().mockResolvedValue({ active: false }),
      },
    },
  },
}));

import { api } from '@/lib/api';
import { useServers } from '@/hooks/queries';

function renderImport() {
  return render(
    <MemoryRouter>
      <Import />
    </MemoryRouter>
  );
}

describe('Import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.mocked(api.import.tofa.getActive).mockResolvedValue({ active: false });
    vi.mocked(api.import.tofa.start).mockResolvedValue({ status: 'queued', message: '' });

    renderImport();

    expect(screen.queryByText('import.noServers')).not.toBeInTheDocument();
    expect(screen.queryByText('import.tautulliUrl')).not.toBeInTheDocument();
    expect(screen.queryByText('import.playbackReporting')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'import.importTofaHistory' }));
    expect(api.import.tofa.start).toHaveBeenCalledWith('tofa-1');
  });

  it('shows only the importer for the server type it is given', () => {
    vi.mocked(useServers).mockReturnValue({
      data: [
        { id: 'plex-1', name: 'Den', type: 'plex' },
        { id: 'jf-1', name: 'Jelly', type: 'jellyfin' },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);

    const { unmount } = render(
      <MemoryRouter>
        <ImportSources serverType="plex" />
      </MemoryRouter>
    );
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByLabelText('import.tautulliUrl')).toBeInTheDocument();
    expect(screen.queryByText('import.playbackReporting')).not.toBeInTheDocument();
    unmount();

    render(
      <MemoryRouter>
        <ImportSources serverType="jellyfin" />
      </MemoryRouter>
    );
    expect(screen.queryByLabelText('import.tautulliUrl')).not.toBeInTheDocument();
    expect(screen.getByText('import.uploadJellystatBackup')).toBeInTheDocument();
  });
});
