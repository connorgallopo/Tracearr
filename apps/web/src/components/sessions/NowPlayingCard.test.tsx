import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { ActiveSession } from '@tracearr/shared';
import { NowPlayingCard } from './NowPlayingCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { role: 'member' } }) }));
vi.mock('@/hooks/useServer', () => ({ useServer: () => ({ isMultiServer: false }) }));
vi.mock('@/hooks/useServerColorMap', () => ({ useServerColorMap: () => new Map() }));

// The dialog opens a mutation on mount, which would need a query client here
vi.mock('./TerminateSessionDialog', () => ({ TerminateSessionDialog: () => null }));

function renderCard(overrides: Partial<ActiveSession>, onClick?: () => void) {
  const session = {
    id: 'session-1',
    serverId: 'server-1',
    server: { id: 'server-1', name: 'Basement', type: 'plex' },
    user: { id: 'su-1', username: 'alice', thumbUrl: null, identityName: null },
    state: 'playing',
    mediaType: 'movie',
    mediaTitle: 'Heat',
    thumbPath: null,
    progressMs: 0,
    totalDurationMs: 7_200_000,
    isTranscode: false,
    transcodeInfo: null,
    canTerminate: false,
    playerName: null,
    product: null,
    device: null,
    platform: null,
    ...overrides,
  } as unknown as ActiveSession;

  render(
    <MemoryRouter>
      <NowPlayingCard session={session} onClick={onClick} />
    </MemoryRouter>
  );
  return screen.getByTestId('device-icon');
}

describe('NowPlayingCard device icon', () => {
  it('names the client on hover', () => {
    expect(renderCard({ playerName: "Emily's Fire TV" })).toHaveAttribute(
      'title',
      "Emily's Fire TV"
    );
  });

  it('builds a name from the app and hardware when the client sent none', () => {
    expect(renderCard({ product: 'Plex for Roku', device: '50S425' })).toHaveAttribute(
      'title',
      'Plex for Roku - 50S425'
    );
  });

  it('carries no hover text when the session reports no device at all', () => {
    expect(renderCard({})).not.toHaveAttribute('title');
  });
});

describe('NowPlayingCard transcoder bar and buffering', () => {
  it('draws the transcoder segment ahead of the playhead', () => {
    renderCard({ progressMs: 720_000, transcodeInfo: { maxOffsetAvailable: 1800 } });
    expect(screen.getByTestId('progress-buffered')).toHaveStyle({ width: '25%' });
  });

  it('falls back to transcode percent when the server gives no offset (Jellyfin)', () => {
    renderCard({ progressMs: 720_000, transcodeInfo: { progress: 40 } });
    expect(screen.getByTestId('progress-buffered')).toHaveStyle({ width: '40%' });
  });

  it('draws nothing for direct play', () => {
    renderCard({ progressMs: 720_000, transcodeInfo: null });
    expect(screen.queryByTestId('progress-buffered')).toBeNull();
  });

  it('draws nothing when the transcoder is behind the playhead', () => {
    renderCard({ progressMs: 720_000, transcodeInfo: { maxOffsetAvailable: 300 } });
    expect(screen.queryByTestId('progress-buffered')).toBeNull();
  });

  it('shows when a playing stream ends on hovering its remaining time', async () => {
    renderCard({ state: 'playing', progressMs: 600_000 });
    await userEvent.hover(screen.getByText(/^-\d/));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('playback.endsAt');
  });

  it('labels a buffering session', () => {
    renderCard({ state: 'playing', buffering: true });
    expect(screen.getByText('playback.buffering')).toBeInTheDocument();
  });
});

describe('NowPlayingCard title links', () => {
  it('links the show name and the episode line to their media pages', () => {
    renderCard({
      mediaType: 'episode',
      mediaTitle: 'Pilot',
      grandparentTitle: 'Lost',
      seasonNumber: 1,
      episodeNumber: 2,
      mediaId: 'episode-1',
      showMediaId: 'show-1',
    });

    expect(screen.getByRole('link', { name: 'Lost' })).toHaveAttribute('href', '/media/show-1');
    expect(screen.getByRole('link', { name: /Pilot/ })).toHaveAttribute('href', '/media/episode-1');
  });

  it('follows the title link without opening the slide-out', () => {
    const onClick = vi.fn();
    renderCard({ mediaId: 'movie-1' }, onClick);

    fireEvent.click(screen.getByRole('link', { name: 'Heat' }));
    expect(onClick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('alice'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
