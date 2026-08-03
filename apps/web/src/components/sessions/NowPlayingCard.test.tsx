import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { DEFAULT_STREAM_DETAILS, type ActiveSession } from '@tracearr/shared';
import { NowPlayingCard } from './NowPlayingCard';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { role: 'viewer' } }),
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: () => ({ isMultiServer: false }),
}));

vi.mock('@/hooks/useServerColorMap', () => ({
  useServerColorMap: () => new Map([['server-1', '#8b5cf6']]),
}));

vi.mock('@/hooks/useEstimatedProgress', () => ({
  useEstimatedProgress: () => ({ estimatedProgressMs: 600_000, progressPercent: 50 }),
}));

vi.mock('./TerminateSessionDialog', () => ({
  TerminateSessionDialog: () => null,
}));

const session: ActiveSession = {
  ...DEFAULT_STREAM_DETAILS,
  id: 'session-1',
  serverId: 'server-1',
  serverUserId: 'user-1',
  sessionKey: 'key-1',
  state: 'playing',
  mediaType: 'episode',
  mediaTitle: 'A Cowboy Saint',
  grandparentTitle: 'Dutton Ranch',
  seasonNumber: 1,
  episodeNumber: 7,
  year: 2026,
  thumbPath: '/poster.jpg',
  ratingKey: 'rating-1',
  serverVersionKey: null,
  parentRatingKey: null,
  grandparentRatingKey: null,
  mediaId: null,
  showMediaId: null,
  imdbId: null,
  tmdbId: null,
  tvdbId: null,
  externalSessionId: null,
  startedAt: new Date('2026-08-03T12:00:00Z'),
  stoppedAt: null,
  durationMs: 600_000,
  totalDurationMs: 1_200_000,
  progressMs: 600_000,
  lastPausedAt: null,
  pausedDurationMs: 0,
  referenceId: null,
  watched: false,
  ipAddress: '24.114.72.18',
  geoCity: 'Toronto',
  geoRegion: 'ON',
  geoCountry: 'CA',
  geoContinent: 'NA',
  geoPostal: null,
  geoLat: 43.65,
  geoLon: -79.38,
  geoAsnNumber: null,
  geoAsnOrganization: null,
  playerName: 'Living Room',
  deviceId: 'device-1',
  product: 'Plex',
  device: 'Apple TV',
  platform: 'tvOS',
  quality: '1080p',
  isTranscode: true,
  videoDecision: 'transcode',
  audioDecision: 'copy',
  bitrate: 8000,
  channelTitle: null,
  channelIdentifier: null,
  channelThumb: null,
  artistName: null,
  albumName: null,
  trackNumber: null,
  discNumber: null,
  sourceVideoCodec: 'hevc',
  sourceVideoWidth: 3840,
  sourceVideoHeight: 2160,
  streamVideoCodec: 'h264',
  streamVideoDetails: { width: 1920, height: 1080 },
  sourceAudioCodec: 'eac3',
  sourceAudioChannels: 6,
  streamAudioCodec: 'eac3',
  streamAudioDetails: { channels: 6 },
  transcodeInfo: { hwEncoding: 'nvenc' },
  subtitleInfo: { decision: 'burn', codec: 'srt', language: 'English' },
  user: { id: 'user-1', username: 'michael', thumbUrl: null, identityName: 'Michael A.' },
  server: { id: 'server-1', name: 'Montreal Plex', type: 'plex' },
  canTerminate: true,
};

describe('NowPlayingCard', () => {
  it('renders the approved compact stream details and full-width progress strip', () => {
    render(
      <MemoryRouter>
        <NowPlayingCard session={session} />
      </MemoryRouter>
    );

    expect(screen.getByText('Dutton Ranch')).toBeInTheDocument();
    expect(screen.getByText('S01 E07')).toBeInTheDocument();
    expect(screen.getByText('A Cowboy Saint')).toBeInTheDocument();
    expect(screen.getAllByText('HW Transcode · Video')).toHaveLength(2);
    expect(screen.getByText('HEVC 4K → H.264 1080p')).toBeInTheDocument();
    expect(screen.getByText('Direct Stream · EAC3 5.1')).toBeInTheDocument();
    expect(screen.getByText('Burn · SRT · English')).toBeInTheDocument();
    expect(screen.getByText('Toronto, ON · 24.114.72.18')).toBeInTheDocument();
    expect(screen.getByText('~8.0 Mbps')).toBeInTheDocument();
    expect(screen.getByText('Montreal Plex')).toBeInTheDocument();

    const progress = screen.getByRole('progressbar', { name: /dutton ranch playback progress/i });
    expect(progress).toHaveAttribute('aria-valuenow', '50');
    expect(progress).toHaveClass('w-full');
    expect(progress.firstElementChild).toHaveStyle({ width: '50%' });
  });

  it('identifies a subtitle-only transcode', () => {
    render(
      <MemoryRouter>
        <NowPlayingCard
          session={{
            ...session,
            videoDecision: 'directplay',
            audioDecision: 'directplay',
            transcodeInfo: null,
          }}
        />
      </MemoryRouter>
    );

    expect(screen.getAllByText('Transcode · Subtitles')).toHaveLength(2);
  });
});
