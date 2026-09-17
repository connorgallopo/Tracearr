import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import type { MediaAvailabilityEntry } from '@tracearr/shared';
import { CopiesPanel } from './CopiesPanel';
import type { HeroServerLookupEntry } from './DetailHero';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const serverById = new Map<string, HeroServerLookupEntry>([
  ['srv-plex', { name: 'Plex', type: 'plex', color: '#e5a00d', url: 'https://plex.example.com' }],
]);

function renderPanel(overrides: Partial<React.ComponentProps<typeof CopiesPanel>> = {}) {
  const props: React.ComponentProps<typeof CopiesPanel> = {
    availability: undefined,
    isLoading: false,
    isError: false,
    onRetry: vi.fn(),
    serverById,
    ...overrides,
  };
  return render(<CopiesPanel {...props} />);
}

function makeEntry(overrides: Partial<MediaAvailabilityEntry> = {}): MediaAvailabilityEntry {
  return {
    serverId: 'srv-plex',
    serverType: 'plex',
    libraryId: 'lib-1',
    libraryName: 'Movies',
    ratingKey: 'rk-1',
    addedAt: '2025-03-12T00:00:00Z',
    removedAt: null,
    videoResolution: '1080p',
    fileSize: 8_000_000_000,
    episodeFileSize: null,
    episodeResolutions: null,
    versions: [],
    episodeCount: null,
    replaces: null,
    ...overrides,
  };
}

describe('CopiesPanel', () => {
  it('shows a loading skeleton while availability is undefined', () => {
    const { container } = renderPanel({ isLoading: true, availability: undefined });
    expect(container.querySelectorAll('[class*="animate-pulse"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an inline error with retry on failure', () => {
    const onRetry = vi.fn();
    renderPanel({ isError: true, onRetry });
    screen.getByRole('button', { name: /Try again/ }).click();
    expect(onRetry).toHaveBeenCalled();
  });

  it('shows the removed-everywhere copy when there are no active copies', () => {
    renderPanel({
      availability: [makeEntry({ removedAt: '2026-01-01T00:00:00Z' })],
    });
    expect(screen.getByText('No longer available on any connected server')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('lists each active copy with server, library name, quality and size', () => {
    renderPanel({
      availability: [
        makeEntry({ libraryId: 'lib-1', libraryName: 'Movies', videoResolution: '4k' }),
        makeEntry({
          libraryId: 'lib-2',
          libraryName: '4K Movies',
          ratingKey: 'rk-2',
          videoResolution: '1080p',
        }),
      ],
    });

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByText('Plex')).toHaveLength(2);
    expect(screen.getByText('Movies')).toBeInTheDocument();
    expect(screen.getByText('4K Movies')).toBeInTheDocument();
    expect(screen.getByText('4K')).toBeInTheDocument();
    expect(screen.getByText('1080p')).toBeInTheDocument();
  });

  it('falls back to a placeholder when the library name has not synced yet', () => {
    renderPanel({ availability: [makeEntry({ libraryName: null })] });
    expect(screen.getByText('Unknown library')).toBeInTheDocument();
  });

  it('renders the episode rollup for a show copy: summed size, resolution set, and episode count', () => {
    renderPanel({
      availability: [
        makeEntry({
          videoResolution: null,
          fileSize: null,
          episodeFileSize: 18_000_000_000,
          episodeResolutions: ['1080p', '4k'],
          episodeCount: 42,
        }),
      ],
    });

    expect(screen.getByText('1080p · 4K')).toBeInTheDocument();
    expect(screen.getByText('16.8 GB')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Episodes' })).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('caps the resolution set at three entries then +N', () => {
    renderPanel({
      availability: [
        makeEntry({
          videoResolution: null,
          fileSize: null,
          episodeFileSize: 1_000_000_000,
          episodeResolutions: ['4k', '1080p', '720p', '480p', 'sd'],
          episodeCount: 5,
        }),
      ],
    });

    expect(screen.getByText('4K · 1080p · 720p +2')).toBeInTheDocument();
  });

  it('keeps the movie shape: single resolution, own file size, no Episodes column', () => {
    renderPanel({ availability: [makeEntry()] });

    expect(screen.getByText('1080p')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Episodes' })).not.toBeInTheDocument();
  });

  it('excludes removed copies from the table but keeps active ones', () => {
    renderPanel({
      availability: [
        makeEntry({ ratingKey: 'rk-active', removedAt: null }),
        makeEntry({ ratingKey: 'rk-removed', removedAt: '2026-01-01T00:00:00Z' }),
      ],
    });
    const rows = screen.getAllByRole('row');
    // One header row plus exactly one data row (the removed copy is excluded).
    expect(rows).toHaveLength(2);
  });
});
