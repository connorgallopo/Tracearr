import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { initI18n } from '@tracearr/translations';
import type { MediaWatcherEntry } from '@tracearr/shared';
import { WatchersTable } from './WatchersTable';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

function watcher(overrides: Partial<MediaWatcherEntry> = {}): MediaWatcherEntry {
  return {
    user: {
      serverUserId: 's1',
      userId: 'u1',
      serverId: 'srv-1',
      username: 'sarah',
      identityName: 'Sarah',
      thumb: 'https://plex.tv/users/sarah/avatar',
      thumbServerId: null,
    },
    plays: 38,
    watchTimeMs: 1000,
    completionPct: 100,
    lastWatchedDay: '2020-01-01',
    distinctEpisodesWatched: 19,
    ...overrides,
  };
}

function renderTable(props: Partial<React.ComponentProps<typeof WatchersTable>> = {}) {
  const merged: React.ComponentProps<typeof WatchersTable> = {
    watchers: undefined,
    isLoading: false,
    isError: false,
    onRetry: vi.fn(),
    mediaType: 'show',
    episodeCount: 19,
    ...props,
  };
  return render(
    <MemoryRouter>
      <WatchersTable {...merged} />
    </MemoryRouter>
  );
}

describe('WatchersTable', () => {
  it('shows the empty-state copy when nobody has watched yet', () => {
    renderTable({ watchers: [] });

    expect(screen.getByText('No one has watched this yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says played, not watched, on an artist page', () => {
    const empty = renderTable({ mediaType: 'artist', watchers: [] });
    expect(screen.getByText('No one has played this yet.')).toBeInTheDocument();
    empty.unmount();

    renderTable({ mediaType: 'artist', episodeCount: null, watchers: [watcher()] });
    expect(screen.getByRole('columnheader', { name: 'Last played' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Last watched' })).toBeNull();
  });

  it('shows an inline error with retry on failure', () => {
    const onRetry = vi.fn();
    renderTable({ isError: true, onRetry });
    screen.getByRole('button', { name: /try again/i }).click();
    expect(onRetry).toHaveBeenCalled();
  });

  it('renders a real table with an accessible completion progressbar', () => {
    renderTable({ watchers: [watcher({ completionPct: 74 })] });

    expect(screen.getByRole('table')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '74');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('links each watcher name to their user profile', () => {
    renderTable({ watchers: [watcher()] });

    const link = screen.getByRole('link', { name: /Sarah/ });
    expect(link).toHaveAttribute('href', '/users/s1');
  });

  it('renders the watcher avatar from their thumbnail with an initial fallback', () => {
    renderTable({ watchers: [watcher()] });

    // Radix Avatar defers the <img> until it loads in a browser; in jsdom the
    // fallback initial renders, which is the accessible representation anyway.
    expect(screen.getByText('S')).toBeInTheDocument();
  });

  it('renders an Episodes column for shows using the total episode count as denominator', () => {
    renderTable({ watchers: [watcher({ distinctEpisodesWatched: 14 })] });

    expect(screen.getByRole('columnheader', { name: 'Episodes' })).toBeInTheDocument();
    expect(screen.getByText('14 / 19')).toBeInTheDocument();
  });

  it('omits the Episodes column for a movie', () => {
    renderTable({ watchers: [watcher()], mediaType: 'movie', episodeCount: null });

    expect(screen.queryByRole('columnheader', { name: 'Episodes' })).not.toBeInTheDocument();
  });

  it('has no Servers column - serverId only feeds the avatar proxy, never a column', () => {
    renderTable({ watchers: [watcher()] });

    expect(screen.queryByRole('columnheader', { name: 'Servers' })).not.toBeInTheDocument();
  });
});
