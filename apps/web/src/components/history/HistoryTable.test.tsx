// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { SessionWithDetails } from '@tracearr/shared';
import { DEFAULT_COLUMN_VISIBILITY } from './HistoryFilters';
import { HistoryTable } from './HistoryTable';
import { TooltipProvider } from '@/components/ui/tooltip';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 53,
    getVirtualItems: () =>
      count > 0
        ? [
            {
              index: 0,
              key: 0,
              start: 0,
              end: 53,
              size: 53,
              lane: 0,
            },
          ]
        : [],
    measureElement: vi.fn(),
  }),
}));

vi.mock('@/hooks/useServerColorMap', () => ({
  useServerColorMap: () => new Map(),
}));

function makeSession(overrides: Partial<SessionWithDetails> = {}): SessionWithDetails {
  return {
    id: 'session-1',
    serverId: 'server-1',
    serverUserId: 'user-1',
    sessionKey: 'sk-1',
    state: 'stopped',
    mediaType: 'movie',
    mediaTitle: 'Very Long Movie Name That Should Be Truncated On Mobile Layout',
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    year: 2026,
    thumbPath: null,
    serverVersionKey: null,
    parentRatingKey: null,
    grandparentRatingKey: null,
    mediaId: null,
    showMediaId: null,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    startedAt: new Date(),
    stoppedAt: new Date(),
    durationMs: 120_000,
    totalDurationMs: 7_200_000,
    progressMs: 2_100_000,
    lastPausedAt: null,
    pausedDurationMs: 0,
    referenceId: null,
    watched: false,
    ipAddress: '127.0.0.1',
    geoCity: null,
    geoRegion: null,
    geoCountry: null,
    geoContinent: null,
    geoPostal: null,
    geoLat: null,
    geoLon: null,
    geoAsnNumber: null,
    geoAsnOrganization: null,
    playerName: 'Player',
    deviceId: 'device-1',
    product: 'App',
    device: 'Phone',
    platform: 'iOS',
    quality: null,
    isTranscode: false,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
    bitrate: null,
    sourceVideoCodec: null,
    sourceAudioCodec: null,
    sourceAudioChannels: null,
    sourceVideoWidth: null,
    sourceVideoHeight: null,
    sourceVideoDetails: null,
    sourceAudioDetails: null,
    streamVideoCodec: null,
    streamAudioCodec: null,
    streamVideoDetails: null,
    streamAudioDetails: null,
    transcodeInfo: null,
    subtitleInfo: null,
    channelTitle: null,
    channelIdentifier: null,
    channelThumb: null,
    artistName: null,
    albumName: null,
    trackNumber: null,
    discNumber: null,
    user: {
      id: 'user-1',
      username: 'alice',
      thumbUrl: null,
      identityName: null,
    },
    server: {
      id: 'server-1',
      name: 'Plex',
      type: 'plex',
    },
    ...overrides,
  };
}

describe('HistoryTable content layout', () => {
  it('keeps content readable by restoring a scrollable minimum table width', () => {
    render(
      <TooltipProvider>
        <MemoryRouter>
          <HistoryTable sessions={[makeSession()]} columnVisibility={DEFAULT_COLUMN_VISIBILITY} />
        </MemoryRouter>
      </TooltipProvider>
    );

    const table = screen.getByRole('table');
    expect(table.className).toContain('w-full');
    expect(table).toHaveStyle({ minWidth: '1264px' });

    const title = screen.getByText(
      'Very Long Movie Name That Should Be Truncated On Mobile Layout'
    );
    expect(title.className).toContain('truncate');
    expect(title.className).toContain('min-w-0');
    expect(title.className).toContain('flex-1');

    const contentHeader = screen.getByRole('columnheader', { name: 'Content' });
    expect(contentHeader).toHaveStyle({ width: '300px', minWidth: '300px' });

    const contentCell = title.closest('td');
    expect(contentCell).not.toBeNull();
    expect(contentCell).toHaveStyle({ width: '300px', minWidth: '300px' });
    expect(contentCell?.className).toContain('overflow-hidden');
  });

  it('accounts for the server column only in multi-server mode', () => {
    const { rerender } = render(
      <TooltipProvider>
        <MemoryRouter>
          <HistoryTable
            sessions={[makeSession()]}
            columnVisibility={DEFAULT_COLUMN_VISIBILITY}
            isMultiServer
          />
        </MemoryRouter>
      </TooltipProvider>
    );

    expect(screen.getByRole('table')).toHaveStyle({ minWidth: '1414px' });

    rerender(
      <TooltipProvider>
        <MemoryRouter>
          <HistoryTable sessions={[makeSession()]} columnVisibility={DEFAULT_COLUMN_VISIBILITY} />
        </MemoryRouter>
      </TooltipProvider>
    );

    expect(screen.getByRole('table')).toHaveStyle({ minWidth: '1264px' });
  });

  it('recalculates its minimum width when visible columns change', () => {
    render(
      <TooltipProvider>
        <MemoryRouter>
          <HistoryTable
            sessions={[makeSession()]}
            columnVisibility={{ ...DEFAULT_COLUMN_VISIBILITY, content: false, ip: true }}
          />
        </MemoryRouter>
      </TooltipProvider>
    );

    expect(screen.getByRole('table')).toHaveStyle({ minWidth: '1094px' });
  });
});

describe('HistoryTable live content display', () => {
  it('shows the channel as primary and programme as secondary for unified live TV', () => {
    render(
      <TooltipProvider>
        <MemoryRouter>
          <HistoryTable
            sessions={[
              makeSession({
                mediaType: 'live',
                mediaTitle: 'Evening Movie',
                channelTitle: 'Classic Hits TV',
                year: null,
                server: {
                  id: 'server-1',
                  name: 'Dispatcharr',
                  type: 'dispatcharr',
                },
              }),
            ]}
            columnVisibility={DEFAULT_COLUMN_VISIBILITY}
          />
        </MemoryRouter>
      </TooltipProvider>
    );

    expect(screen.getByText('Classic Hits TV')).toBeInTheDocument();
    expect(screen.getByText('Evening Movie')).toBeInTheDocument();
    expect(screen.queryByText('Abandoned')).not.toBeInTheDocument();
    expect(screen.queryByText('Sampled')).not.toBeInTheDocument();
    expect(screen.queryByText('Engaged')).not.toBeInTheDocument();
    expect(screen.queryByText('Watched')).not.toBeInTheDocument();
  });

  it('falls back to the media title when a live session has no channel name', () => {
    render(
      <TooltipProvider>
        <MemoryRouter>
          <HistoryTable
            sessions={[
              makeSession({
                mediaType: 'live',
                mediaTitle: 'Fallback Channel',
                channelTitle: null,
                year: null,
              }),
            ]}
            columnVisibility={DEFAULT_COLUMN_VISIBILITY}
          />
        </MemoryRouter>
      </TooltipProvider>
    );

    expect(screen.getByText('Fallback Channel')).toBeInTheDocument();
  });

  it('does not render engagement badges for Dispatcharr catch-up history rows', () => {
    render(
      <TooltipProvider>
        <MemoryRouter>
          <HistoryTable
            sessions={[
              makeSession({
                mediaType: 'live',
                mediaTitle: 'Morning News',
                channelTitle: 'News 24',
                year: null,
                totalDurationMs: 5_400_000,
                progressMs: 4_900_000,
                dispatcharrPlaybackKind: 'catchup',
                server: {
                  id: 'server-1',
                  name: 'Dispatcharr',
                  type: 'dispatcharr',
                },
              }),
            ]}
            columnVisibility={DEFAULT_COLUMN_VISIBILITY}
          />
        </MemoryRouter>
      </TooltipProvider>
    );

    expect(screen.getByText('News 24')).toBeInTheDocument();
    expect(screen.queryByText('Watched')).not.toBeInTheDocument();
    expect(screen.queryByText('Engaged')).not.toBeInTheDocument();
    expect(screen.queryByText('Sampled')).not.toBeInTheDocument();
    expect(screen.queryByText('Abandoned')).not.toBeInTheDocument();
  });

  it('shows a catch-up icon for Dispatcharr catch-up history rows', () => {
    const { container } = render(
      <TooltipProvider>
        <MemoryRouter>
          <HistoryTable
            sessions={[
              makeSession({
                mediaType: 'live',
                mediaTitle: 'Morning News',
                channelTitle: 'News 24',
                year: null,
                dispatcharrPlaybackKind: 'catchup',
                server: {
                  id: 'server-1',
                  name: 'Dispatcharr',
                  type: 'dispatcharr',
                },
              }),
            ]}
            columnVisibility={DEFAULT_COLUMN_VISIBILITY}
          />
        </MemoryRouter>
      </TooltipProvider>
    );

    expect(screen.getByText('News 24')).toBeInTheDocument();
    expect(screen.getByTitle('Catch-up')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="history-catchup-badge"]')).toBeTruthy();
  });

  it('does not show a catch-up icon for normal Dispatcharr live history rows', () => {
    const { container } = render(
      <TooltipProvider>
        <MemoryRouter>
          <HistoryTable
            sessions={[
              makeSession({
                mediaType: 'live',
                mediaTitle: 'Evening Show',
                channelTitle: 'Live Channel',
                year: null,
                dispatcharrPlaybackKind: 'live',
                server: {
                  id: 'server-1',
                  name: 'Dispatcharr',
                  type: 'dispatcharr',
                },
              }),
            ]}
            columnVisibility={DEFAULT_COLUMN_VISIBILITY}
          />
        </MemoryRouter>
      </TooltipProvider>
    );

    expect(screen.queryByTitle('Catch-up')).not.toBeInTheDocument();
    expect(container.querySelector('[data-testid="history-catchup-badge"]')).toBeNull();
  });

  it('does not show a catch-up icon for non-Dispatcharr history rows', () => {
    const { container } = render(
      <TooltipProvider>
        <MemoryRouter>
          <HistoryTable
            sessions={[
              makeSession({
                mediaType: 'live',
                mediaTitle: 'Catch-up Looking Title',
                channelTitle: 'Plex Live',
                year: null,
                dispatcharrPlaybackKind: 'catchup',
                server: {
                  id: 'server-1',
                  name: 'Plex',
                  type: 'plex',
                },
              }),
            ]}
            columnVisibility={DEFAULT_COLUMN_VISIBILITY}
          />
        </MemoryRouter>
      </TooltipProvider>
    );

    expect(screen.queryByTitle('Catch-up')).not.toBeInTheDocument();
    expect(container.querySelector('[data-testid="history-catchup-badge"]')).toBeNull();
  });
});

function renderTable(overrides: Partial<SessionWithDetails>) {
  const session = {
    id: 'session-1',
    serverId: 'server-1',
    serverUserId: 'su-1',
    server: { id: 'server-1', name: 'Jelly', type: 'jellyfin' },
    user: { id: 'su-1', username: 'alice', thumbUrl: null, identityName: null },
    state: 'stopped',
    mediaType: 'movie',
    mediaTitle: 'Heat',
    startedAt: new Date('2024-01-01T20:00:00Z'),
    stoppedAt: new Date('2024-01-01T21:55:00Z'),
    durationMs: 6_900_000,
    totalDurationMs: 7_200_000,
    watched: true,
    geoLat: null,
    geoLon: null,
    ...overrides,
  } as unknown as SessionWithDetails;

  return render(
    <MemoryRouter>
      <TooltipProvider>
        <HistoryTable
          sessions={[session]}
          columnVisibility={{ ...DEFAULT_COLUMN_VISIBILITY, progress: true }}
        />
      </TooltipProvider>
    </MemoryRouter>
  );
}

describe('HistoryTable', () => {
  it('shows no percentage and no engagement badge for a play with a length but no position', () => {
    renderTable({ progressMs: null });

    expect(screen.getByText('Heat')).toBeInTheDocument();
    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();
    expect(screen.queryByText('Abandoned')).not.toBeInTheDocument();
  });

  it('shows 0% and the abandoned badge for a play whose position is a measured 0', () => {
    renderTable({ progressMs: 0 });

    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByText('Abandoned')).toBeInTheDocument();
  });
});
