import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { DownloadsStats, MediaDownloadRow, NonMainProfile } from '@tracearr/shared';
import { StatsDownloads } from './Downloads';
import { useTimeRange } from '@/hooks/useTimeRange';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/hooks/queries', () => ({ useDownloadsStats: vi.fn() }));
vi.mock('@/hooks/useServer', () => ({ useServer: vi.fn() }));
vi.mock('@/hooks/useTimeRange', () => ({ useTimeRange: vi.fn() }));

import { useDownloadsStats } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';

const KIDS: NonMainProfile = { name: 'Kids', thumbUrl: null, removed: false };

const row = (overrides: Partial<MediaDownloadRow> = {}): MediaDownloadRow => ({
  id: 'd-1',
  serverId: 'server-1',
  serverName: 'Server One',
  serverType: 'plex',
  serverUserId: 'su-1',
  username: 'alice',
  identityName: 'Alice',
  thumbUrl: null,
  libraryItemId: 'li-1',
  mediaId: 'm-1',
  title: 'The Movie',
  mediaType: 'movie',
  thumbPath: null,
  app: 'Plex for iOS',
  device: 'iPhone',
  source: 'plex',
  requestCount: 1,
  firstSeenAt: '2026-10-19T10:00:00.000Z',
  lastSeenAt: '2026-10-19T10:30:00.000Z',
  videoResolution: '1080p',
  videoCodec: 'h264',
  videoDynamicRange: null,
  container: 'mkv',
  fileSizeBytes: 3_000_000_000,
  ipAddress: null,
  isLocal: false,
  geoCity: 'Austin',
  geoRegion: null,
  geoCountry: 'US',
  deliveredBytes: 434_000_000,
  deliveredVideoCodec: 'h264',
  deliveredAudioCodec: 'opus',
  deliveredContainer: 'mkv',
  deliveredBitrateKbps: 1200,
  deliveredResolution: null,
  completionPercent: null,
  deviceId: 'dev-1',
  playerName: 'Alice iPhone',
  product: 'Plex for iOS',
  platform: 'iOS',
  ...overrides,
});

const stats = (rows: MediaDownloadRow[]): DownloadsStats => ({
  total: rows.length,
  people: 3,
  totalBytes: 5_000_000_000,
  topTitle: { title: 'The Movie', count: 3, libraryItemId: 'li-1' },
  rows,
  page: 1,
  pageSize: 25,
});

function renderPage(rows: MediaDownloadRow[]) {
  vi.mocked(useDownloadsStats).mockReturnValue({
    data: stats(rows),
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useDownloadsStats>);
  return render(
    <MemoryRouter>
      <StatsDownloads />
    </MemoryRouter>
  );
}

describe('StatsDownloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTimeRange).mockReturnValue({
      apiParams: { period: 'month' },
    } as unknown as ReturnType<typeof useTimeRange>);
    vi.mocked(useServer).mockReturnValue({
      selectedServerIds: ['server-1'],
      selectedServers: [{ id: 'server-1', name: 'Server One', color: '#ff0000' }],
      isMultiServer: true,
    } as unknown as ReturnType<typeof useServer>);
  });

  it('renders four stat cards from the stats', () => {
    renderPage([row(), row({ id: 'd-2' })]);

    expect(screen.getByText('nav:downloads')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('downloads.dataDownloaded')).toBeInTheDocument();
    expect(screen.getByText('4.7 GB')).toBeInTheDocument();
    expect(screen.getByText('downloads.peopleDownloading')).toBeInTheDocument();
    expect(screen.getByText('downloads.mostDownloaded')).toBeInTheDocument();
    expect(screen.getAllByText('The Movie').length).toBeGreaterThan(0);
  });

  it('renders a row with user, title, quality, delivered size, device, location and server', () => {
    renderPage([row()]);

    expect(screen.getByRole('link', { name: /Alice/ })).toHaveAttribute('href', '/users/su-1');
    expect(screen.getAllByRole('link', { name: 'The Movie' })[0]).toHaveAttribute(
      'href',
      '/media/m-1'
    );
    expect(screen.getByText('1080p · H.264')).toBeInTheDocument();
    expect(screen.getByText('413.9 MB')).toBeInTheDocument();
    expect(screen.getByText('Alice iPhone')).toBeInTheDocument();
    expect(screen.getByText(/^Austin, /)).toBeInTheDocument();
    expect(screen.getByText('Server One')).toBeInTheDocument();
  });

  it('badges a download made on a non-main profile', () => {
    renderPage([row({ nonMainProfile: KIDS })]);

    expect(screen.getByRole('img', { name: 'Kids' })).toBeInTheDocument();
  });

  it('shows the delivered line for a converted download and falls back to the file size', () => {
    renderPage([
      row(),
      row({
        id: 'd-2',
        fileSizeBytes: 3_000_000_000,
        deliveredBytes: null,
        deliveredBitrateKbps: null,
        deliveredVideoCodec: null,
        deliveredAudioCodec: null,
        deliveredContainer: null,
        requestCount: 3,
      }),
    ]);

    expect(screen.getAllByText(/downloads.deliveredAs/)).toHaveLength(1);
    expect(screen.getByText(/downloads.deliveredAs/)).toHaveTextContent('1.2 Mbps');
    expect(screen.getByText('2.8 GB')).toBeInTheDocument();
    expect(screen.getByText(/downloads.requests/)).toHaveTextContent('"count":3');
  });

  it('shows Local, a muted dash and the unknown user label where data is missing', () => {
    renderPage([
      row({
        isLocal: true,
        username: null,
        identityName: null,
        serverUserId: null,
        playerName: null,
        product: null,
        platform: null,
        geoCity: null,
        geoCountry: null,
      }),
      row({ id: 'd-2', isLocal: false, geoCity: null, geoCountry: null }),
    ]);

    expect(screen.getByText('downloads.unknownUser')).toBeInTheDocument();
    expect(screen.getByText('labels.local')).toBeInTheDocument();
    expect(screen.getByText(/downloads.appOnDevice/)).toHaveTextContent('Plex for iOS');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows the empty state when there are no rows', () => {
    renderPage([]);

    expect(screen.getByText('downloads.empty')).toBeInTheDocument();
  });

  it('goes back to page 1 when the time range changes', async () => {
    const { rerender } = renderPage(Array.from({ length: 2 }, (_, i) => row({ id: `d-${i}` })));
    vi.mocked(useDownloadsStats).mockReturnValue({
      data: { ...stats([row()]), total: 60 },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useDownloadsStats>);
    rerender(
      <MemoryRouter>
        <StatsDownloads />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByRole('button', { name: 'actions.next' }));
    expect(vi.mocked(useDownloadsStats)).toHaveBeenLastCalledWith(
      { period: 'month' },
      ['server-1'],
      2
    );

    vi.mocked(useTimeRange).mockReturnValue({
      apiParams: { period: 'day' },
    } as unknown as ReturnType<typeof useTimeRange>);
    rerender(
      <MemoryRouter>
        <StatsDownloads />
      </MemoryRouter>
    );

    expect(vi.mocked(useDownloadsStats)).toHaveBeenLastCalledWith(
      { period: 'day' },
      ['server-1'],
      1
    );
  });
});
