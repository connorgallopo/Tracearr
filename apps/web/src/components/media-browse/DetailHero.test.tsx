import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { initI18n } from '@tracearr/translations';
import type { MediaAvailabilityEntry, MediaRequestEntry } from '@tracearr/shared';
import { DetailHero, hexToHslTriple, type HeroServerLookupEntry } from './DetailHero';
import type { MediaDetailData, MediaDetailStub } from '@/hooks/queries';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const serverById = new Map<string, HeroServerLookupEntry>([
  ['srv-plex', { name: 'Plex', type: 'plex', color: '#e5a00d', url: 'https://plex.example.com' }],
  [
    'srv-jf',
    { name: 'Jellyfin', type: 'jellyfin', color: '#8a5cf6', url: 'https://jf.example.com' },
  ],
]);

const stub: MediaDetailStub = {
  mediaId: 'media-1',
  title: 'Severance',
  year: 2022,
  posterUrl: '/api/v1/images/proxy?server=srv-plex&url=%2Flibrary%2Fthumb%2F1',
  posterVersion: 'v1',
  dominantColor: '#1f6f6f',
  servers: [],
};

function renderHero(overrides: Partial<React.ComponentProps<typeof DetailHero>> = {}) {
  const props: React.ComponentProps<typeof DetailHero> = {
    data: undefined,
    stub: undefined,
    isLoading: false,
    isError: false,
    onRetry: vi.fn(),
    serverById,
    onFullHistoryClick: vi.fn(),
    ...overrides,
  };
  return render(
    <MemoryRouter>
      <DetailHero {...props} />
    </MemoryRouter>
  );
}

function fullDetail(overrides: Partial<MediaDetailData> = {}): MediaDetailData {
  return {
    id: 'media-1',
    mediaType: 'show',
    title: 'Severance',
    year: 2022,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    genres: ['Sci-Fi', 'Thriller'],
    showMediaId: null,
    mergedIds: [],
    availability: [
      {
        serverId: 'srv-plex',
        serverType: 'plex',
        libraryId: 'lib-1',
        libraryName: 'Movies',
        ratingKey: 'rk-1',
        addedAt: '2025-03-12T00:00:00Z',
        removedAt: null,
        videoResolution: '4k',
        fileSize: 126_000_000_000,
        episodeFileSize: null,
        episodeResolutions: null,
        episodeCount: null,
        versions: [],
        replaces: null,
      },
    ],
    seasonCount: 2,
    episodeCount: 19,
    posterUrl: null,
    posterVersion: null,
    dominantColor: null,
    servers: [],
    ...overrides,
  };
}

function requestEntry(overrides: Partial<MediaRequestEntry> = {}): MediaRequestEntry {
  return {
    id: 'req-1',
    serverId: 'srv-plex',
    status: 'completed',
    requestedAt: '2026-01-08T12:00:00.000Z',
    availableAt: '2026-01-08T12:02:00.000Z',
    waitMs: 2 * 60 * 1000,
    deletedAt: null,
    seasons: null,
    is4k: false,
    isAutoRequest: false,
    watchedState: 'unwatched',
    requester: {
      serverUserId: 'su-1',
      userId: 'u-1',
      serverId: 'srv-plex',
      username: 'agelwarg',
      identityName: 'Alice',
      thumb: null,
    },
    ...overrides,
  };
}

describe('hexToHslTriple', () => {
  it('converts a hex color to an unwrapped H S% L% triple', () => {
    expect(hexToHslTriple('#1f6f6f')).toMatch(/^\d+ \d+% \d+%$/);
  });

  it('returns null for an invalid hex string', () => {
    expect(hexToHslTriple('not-a-color')).toBeNull();
  });
});

describe('DetailHero', () => {
  it('renders a full skeleton with no title, no stub, and no data', () => {
    renderHero({ isLoading: true });
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('paints the title and poster from the stub while the full detail is still loading', () => {
    const { container } = renderHero({ stub, isLoading: true });

    expect(screen.getByRole('heading', { level: 1, name: 'Severance' })).toBeInTheDocument();
    const img = container.querySelector('img');
    expect(img?.src).toContain('width=360');
    expect(img?.src).toContain('height=540');
    expect(img?.src).toContain('v=v1');
    expect(img?.src).not.toContain('lqip');
    expect(img?.hasAttribute('srcset')).toBe(false);
  });

  it('shows a section skeleton for meta/availability/actions while only the stub has painted', () => {
    renderHero({ stub, isLoading: true });

    expect(screen.queryByRole('button', { name: /Full history/ })).not.toBeInTheDocument();
  });

  it('renders the breadcrumb, meta line, availability rows and actions once full data loads', () => {
    renderHero({ data: fullDetail(), stub });

    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByText(/2 seasons/)).toBeInTheDocument();
    expect(screen.getByText(/19 episodes/)).toBeInTheDocument();
    expect(screen.getByText('Plex')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Full history' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open on server/ })).toHaveAttribute(
      'href',
      'https://plex.example.com'
    );
  });

  it('strikes through and dims a removed-but-not-everywhere availability row', () => {
    const availability: MediaAvailabilityEntry[] = [
      {
        serverId: 'srv-plex',
        serverType: 'plex',
        libraryId: 'lib-1',
        libraryName: 'Movies',
        ratingKey: 'rk-1',
        addedAt: '2025-03-12T00:00:00Z',
        removedAt: null,
        videoResolution: '4k',
        fileSize: 1000,
        episodeFileSize: null,
        episodeResolutions: null,
        episodeCount: null,
        versions: [],
        replaces: null,
      },
      {
        serverId: 'srv-jf',
        serverType: 'jellyfin',
        libraryId: 'lib-2',
        libraryName: 'Movies',
        ratingKey: 'rk-2',
        addedAt: '2025-01-01T00:00:00Z',
        removedAt: '2026-06-08T00:00:00Z',
        videoResolution: '1080p',
        fileSize: 1_932_735_283,
        episodeFileSize: null,
        episodeResolutions: null,
        episodeCount: null,
        versions: [],
        replaces: null,
      },
    ];
    renderHero({ data: fullDetail({ availability }) });

    // The removed copy keeps its added date, resolution, and size so an
    // upgrade reads as one (struck-through 1080p, active 4k)
    const caption = screen.getByText(/added .+ – removed .+ · 1080p · 1\.8 GB/);
    expect(caption).toHaveClass('line-through');
  });

  it('renders a witnessed replacement as one line dated by the removal event', () => {
    const availability: MediaAvailabilityEntry[] = [
      {
        serverId: 'srv-plex',
        serverType: 'plex',
        libraryId: 'lib-1',
        libraryName: 'Movies',
        ratingKey: 'rk-2',
        // The server's back-dated claim - the caption must never show this date
        addedAt: '2026-08-01T12:00:00Z',
        removedAt: null,
        videoResolution: '4k',
        fileSize: 5_261_334_938,
        episodeFileSize: null,
        episodeResolutions: null,
        episodeCount: null,
        versions: [],
        replaces: {
          addedAt: '2026-08-06T12:00:00Z',
          removedAt: '2026-08-13T12:00:00Z',
          videoResolution: '1080p',
          fileSize: 1_932_735_283,
        },
      },
    ];
    renderHero({ data: fullDetail({ availability }) });

    const caption = screen.getByText(
      'added Aug 6, 2026 · 1080p · 1.8 GB · replaced Aug 13, 2026 · 4k · 4.9 GB'
    );
    expect(caption).not.toHaveClass('line-through');
  });

  it('removed-everywhere variant: no poster fetch, no Open on server action, and a removal caption', () => {
    const availability: MediaAvailabilityEntry[] = [
      {
        serverId: 'srv-plex',
        serverType: 'plex',
        libraryId: 'lib-1',
        libraryName: 'Movies',
        ratingKey: 'rk-1',
        addedAt: '2025-03-12T00:00:00Z',
        removedAt: '2026-06-08T00:00:00Z',
        videoResolution: '4k',
        fileSize: 1000,
        episodeFileSize: null,
        episodeResolutions: null,
        episodeCount: null,
        versions: [],
        replaces: null,
      },
    ];
    const { container } = renderHero({ data: fullDetail({ availability }), stub });

    // The poster falls back to the initials tile - no <img> attempted, even
    // though the stub carries a posterUrl.
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open on server/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open on server/ })).not.toBeInTheDocument();
    expect(screen.getByText('No longer available on any connected server')).toBeInTheDocument();
  });

  it('renders an inline error with retry when the detail fetch fails and there is no stub at all', () => {
    const onRetry = vi.fn();
    renderHero({ isError: true, onRetry });

    screen.getByRole('button', { name: /Try again/ }).click();
    expect(onRetry).toHaveBeenCalled();
  });

  it('renders the request line naming the requester when a request is passed', () => {
    renderHero({ data: fullDetail(), stub, request: requestEntry() });

    expect(screen.getByText(/Requested by Alice/)).toBeInTheDocument();
  });

  it('falls back to the server username when the requester has no identity name', () => {
    renderHero({
      data: fullDetail(),
      stub,
      request: requestEntry({
        requester: {
          serverUserId: 'su-1',
          userId: null,
          serverId: 'srv-plex',
          username: 'agelwarg',
          identityName: null,
          thumb: null,
        },
      }),
    });

    expect(screen.getByText(/Requested by agelwarg/)).toBeInTheDocument();
  });

  it('renders no request line without a request', () => {
    renderHero({ data: fullDetail(), stub });

    expect(screen.queryByText(/Requested by/)).not.toBeInTheDocument();
  });
});
