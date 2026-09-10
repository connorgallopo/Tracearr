import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Import } from './Import';

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
        getActive: vi.fn(),
      },
      jellystat: {
        start: vi.fn(),
        getActive: vi.fn(),
      },
      playbackReporting: {
        test: vi.fn(),
        start: vi.fn(),
        getActive: vi.fn(),
      },
    },
  },
}));

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
      data: [{ id: 'jf-1', name: 'Jelly', type: 'jellyfin' }],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);

    renderImport();

    // Playback Reporting and Jellystat both render here and both start with
    // steps 1 and 2 on the shared StepBadge, so those numbers appear twice.
    expect(screen.getAllByText('1')).toHaveLength(2);
    expect(screen.getAllByText('2')).toHaveLength(2);
    expect(screen.getByText('3')).toBeInTheDocument();
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
});
