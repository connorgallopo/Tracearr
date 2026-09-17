import { beforeAll, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { initI18n } from '@tracearr/translations';
import { PosterCard, buildPosterSrc } from './PosterCard';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const baseProps = {
  mediaId: 'media-1',
  title: 'The Matrix',
  year: 1999,
  posterUrl:
    '/api/v1/images/proxy?server=srv-1&url=%2Flibrary%2Fthumb%2F1&width=240&height=360&fallback=poster',
  posterVersion: 'abc12345',
  dominantColor: '#123456',
  servers: [
    { serverId: 'srv-1', name: 'Plex', type: 'plex' as const, addedAt: '2024-01-01T00:00:00Z' },
  ],
  resolutionBest: '1080p',
  watchedState: 'watched' as const,
};

function renderCard(overrides: Partial<React.ComponentProps<typeof PosterCard>> = {}) {
  return render(
    <MemoryRouter>
      <PosterCard {...baseProps} {...overrides} />
    </MemoryRouter>
  );
}

describe('PosterCard', () => {
  it('is a single tab stop per card across two rendered cards', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PosterCard {...baseProps} mediaId="media-1" title="First Movie" />
        <PosterCard {...baseProps} mediaId="media-2" title="Second Movie" />
      </MemoryRouter>
    );

    await user.tab();
    expect(screen.getByRole('link', { name: /First Movie/ })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('link', { name: /Second Movie/ })).toHaveFocus();

    // Nothing else should ever receive focus - exactly two tab stops total.
    await user.tab();
    expect(document.body).toHaveFocus();

    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('renders the hover overlay as aria-hidden, inside the poster box so it exactly covers it', () => {
    const { container } = renderCard();
    const poster = container.querySelector('.aspect-\\[2\\/3\\].overflow-hidden');
    expect(poster).not.toBeNull();
    const overlay = poster!.querySelector('[aria-hidden="true"].absolute.inset-0');
    expect(overlay).not.toBeNull();
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
  });

  it('requests the single cached size with the LQIP race and no responsive srcset', () => {
    const { container } = renderCard();
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.src).toContain('width=360');
    expect(img!.src).toContain('height=540');
    expect(img!.src).toContain('v=abc12345');
    expect(img!.src).toContain('lqip=1');
    expect(img!.hasAttribute('srcset')).toBe(false);
    expect(img!.hasAttribute('sizes')).toBe(false);
  });

  it('swaps to the titled fallback on image load failure without retrying', () => {
    const { container } = renderCard();
    const img = container.querySelector('img');
    expect(img).not.toBeNull();

    act(() => {
      img!.dispatchEvent(new Event('error'));
    });

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByText('The Matrix').length).toBeGreaterThan(0);
    // Year lives in the hover overlay's joined meta line now, not under the card.
    expect(screen.getAllByText(/1999/).length).toBeGreaterThan(0);
  });

  it('renders the titled fallback immediately when there is no posterUrl', () => {
    const { container } = renderCard({ posterUrl: null });
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByText('The Matrix').length).toBeGreaterThan(0);
  });

  it('includes the rank in the accessible name on ranked shelves', () => {
    renderCard({ rank: 3, watchedState: 'unwatched' });
    expect(screen.getByRole('link', { name: 'The Matrix (1999), rank 3' })).toBeInTheDocument();
  });

  it('omits the rank suffix when not on a ranked shelf', () => {
    renderCard({ watchedState: 'unwatched' });
    expect(screen.getByRole('link', { name: 'The Matrix (1999)' })).toBeInTheDocument();
  });

  it('renders a shadow-ring ghost rank numeral, not a solid pill', () => {
    renderCard({ rank: 2 });
    const chip = screen.getByText('2');
    expect(chip).toHaveAttribute('aria-hidden', 'true');
    expect(chip).toHaveClass('text-transparent');
    expect(chip.style.textShadow).toContain('hsl(var(--foreground) / 0.45)');
    expect(chip).not.toHaveClass('bg-black/60');
  });

  it('renders the rank numeral outside the clipped poster box so it never gets cut off', () => {
    const { container } = renderCard({ rank: 2 });
    const poster = container.querySelector('.aspect-\\[2\\/3\\].overflow-hidden');
    expect(poster).not.toBeNull();
    expect(poster!.contains(screen.getByText('2'))).toBe(false);
  });

  it('reserves a dedicated lane for the numeral instead of overlapping the poster', () => {
    const { container } = renderCard({ rank: 2 });
    expect(container.firstChild).toHaveClass('pl-9');
    const rankSpan = screen.getByText('2');
    expect(rankSpan).toHaveClass('w-9', 'left-0', 'top-0');
    expect(rankSpan.className).not.toMatch(/-left-/);
  });

  it('renders double-digit ranks at the same size as single digits', () => {
    renderCard({ rank: 12 });
    expect(screen.getByText('12')).toHaveClass('text-[26px]', 'tabular-nums');
    renderCard({ rank: 2 });
    expect(screen.getByText('2')).toHaveClass('text-[26px]');
  });

  it('tracks the poster hover lift on the rank numeral so it never drifts from the poster on hover', () => {
    const { container } = renderCard({ rank: 2 });
    const poster = container.querySelector('.aspect-\\[2\\/3\\].overflow-hidden');
    const rankSpan = screen.getByText('2');
    expect(poster).toHaveClass(
      'transition-transform',
      'duration-200',
      'group-hover:-translate-y-[3px]'
    );
    expect(rankSpan).toHaveClass(
      'transition-transform',
      'duration-200',
      'group-hover:-translate-y-[3px]'
    );
  });

  it('renders a "N new" corner chip for grouped shows with new episodes', () => {
    renderCard({ newEpisodes: 3, watchedState: 'unwatched' });
    const chip = screen.getByText('3 new');
    expect(chip).toHaveAttribute('aria-hidden', 'true');
    expect(chip).toHaveClass('rounded-full', 'backdrop-blur-sm');
    expect(chip).not.toHaveClass('bg-primary', 'text-primary-foreground');
  });

  it('never renders both the rank chip and the new-episodes chip together', () => {
    renderCard({ rank: 1, newEpisodes: 4 });
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.queryByText('4 new')).not.toBeInTheDocument();
  });

  it('omits the new-episodes chip when the count is zero', () => {
    renderCard({ newEpisodes: 0, watchedState: 'unwatched' });
    expect(screen.queryByText('0 new')).not.toBeInTheDocument();
  });

  it('renders no versions chip for a single copy', () => {
    renderCard({ watchedState: 'unwatched' });
    expect(screen.queryByText(/×/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'The Matrix (1999)' })).toBeInTheDocument();
  });

  it('renders a count chip for two copies with the same resolution', () => {
    renderCard({
      watchedState: 'unwatched',
      servers: [
        {
          serverId: 'srv-1',
          name: 'Plex',
          type: 'plex' as const,
          addedAt: '2024-01-01T00:00:00Z',
          videoResolution: '1080p',
        },
        {
          serverId: 'srv-1',
          name: 'Plex',
          type: 'plex' as const,
          addedAt: '2024-02-01T00:00:00Z',
          videoResolution: '1080p',
        },
      ],
    });
    const chip = screen.getByText('2×');
    expect(chip).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('link', { name: 'The Matrix (1999), 2 versions' })).toBeInTheDocument();
  });

  it('hides the versions chip when the server dots already tell the story: one copy per server, same resolution', () => {
    renderCard({
      watchedState: 'unwatched',
      servers: [
        {
          serverId: 'srv-1',
          name: 'Plex',
          type: 'plex' as const,
          addedAt: '2024-01-01T00:00:00Z',
          videoResolution: '1080p',
        },
        {
          serverId: 'srv-2',
          name: 'Jellyfin',
          type: 'jellyfin' as const,
          addedAt: '2024-02-01T00:00:00Z',
          videoResolution: '1080p',
        },
      ],
    });
    expect(screen.queryByText('2×')).not.toBeInTheDocument();
  });

  it('shows both distinct resolutions, best first, when two copies differ', () => {
    renderCard({
      watchedState: 'unwatched',
      servers: [
        {
          serverId: 'srv-1',
          name: 'Plex',
          type: 'plex' as const,
          addedAt: '2024-01-01T00:00:00Z',
          videoResolution: '1080p',
        },
        {
          serverId: 'srv-1',
          name: 'Plex',
          type: 'plex' as const,
          addedAt: '2024-02-01T00:00:00Z',
          videoResolution: '4k',
        },
      ],
    });
    expect(screen.getByText('4K · 1080p')).toBeInTheDocument();
    expect(screen.queryByText('2×')).not.toBeInTheDocument();
  });

  it('falls back to a count chip when more than two distinct resolutions are present', () => {
    renderCard({
      watchedState: 'unwatched',
      servers: [
        {
          serverId: 'srv-1',
          name: 'Plex',
          type: 'plex' as const,
          addedAt: '2024-01-01T00:00:00Z',
          videoResolution: '4k',
        },
        {
          serverId: 'srv-1',
          name: 'Plex',
          type: 'plex' as const,
          addedAt: '2024-02-01T00:00:00Z',
          videoResolution: '1080p',
        },
        {
          serverId: 'srv-1',
          name: 'Plex',
          type: 'plex' as const,
          addedAt: '2024-03-01T00:00:00Z',
          videoResolution: '720p',
        },
      ],
    });
    expect(screen.getByText('3×')).toBeInTheDocument();
  });

  it('appends the watched state to the accessible name when not unwatched', () => {
    renderCard({ watchedState: 'watched' });
    expect(screen.getByRole('link', { name: 'The Matrix (1999), Watched' })).toBeInTheDocument();

    const { unmount } = renderCard({ watchedState: 'partial', mediaId: 'media-2' });
    expect(
      screen.getByRole('link', { name: 'The Matrix (1999), Partially watched' })
    ).toBeInTheDocument();
    unmount();
  });

  it('omits the watched-state suffix from the accessible name when unwatched', () => {
    renderCard({ watchedState: 'unwatched' });
    expect(screen.getByRole('link', { name: 'The Matrix (1999)' })).toBeInTheDocument();
  });

  it('combines rank and watched-state suffixes in the accessible name', () => {
    renderCard({ rank: 3, watchedState: 'watched' });
    expect(
      screen.getByRole('link', { name: 'The Matrix (1999), rank 3, Watched' })
    ).toBeInTheDocument();
  });

  it('renders the fallback glyph over a gradient anchored to dominantColor', () => {
    const { container } = renderCard({ posterUrl: null });
    const small = container.querySelector('small');
    expect(small).not.toBeNull();
    expect(small!.textContent).toBe('The Matrix');
    const fallback = small!.parentElement!;
    // jsdom normalizes hex to rgb() in the serialized style attribute.
    expect(fallback.getAttribute('style')).toContain(
      'linear-gradient(160deg, rgb(18, 52, 86) 0%, rgb(10, 29, 47) 100%)'
    );
  });

  it('falls back to a neutral gradient when there is no dominantColor', () => {
    const { container } = renderCard({ posterUrl: null, dominantColor: null });
    const small = container.querySelector('small');
    const fallback = small!.parentElement!;
    expect(fallback.getAttribute('style')).toContain('linear-gradient(160deg, hsl(var(--muted))');
  });

  it('names the accessible watched suffix "by you" when the requester watched it', () => {
    renderCard({ watchedState: 'watched', watchedStateSelf: 'watched' });
    expect(
      screen.getByRole('link', { name: 'The Matrix (1999), Watched by you' })
    ).toBeInTheDocument();
  });

  it('names the accessible watched suffix "by others" when the requester has not watched it themselves', () => {
    renderCard({ watchedState: 'watched', watchedStateSelf: 'unwatched' });
    expect(
      screen.getByRole('link', { name: 'The Matrix (1999), Watched by others' })
    ).toBeInTheDocument();
  });

  it('falls back to the plain "Watched" suffix when watchedStateSelf is not supplied (shelf cards)', () => {
    renderCard({ watchedState: 'watched', watchedStateSelf: undefined });
    expect(screen.getByRole('link', { name: 'The Matrix (1999), Watched' })).toBeInTheDocument();
  });
});

describe('buildPosterSrc', () => {
  const url =
    '/api/v1/images/proxy?server=srv-1&url=%2Flibrary%2Fthumb%2F1&width=240&height=360&fallback=poster';

  it('always requests the one cached 360x540 size while preserving other params', () => {
    const src = buildPosterSrc(url, 'abc12345');
    const parsed = new URL(src, 'http://localhost');
    expect(parsed.searchParams.get('width')).toBe('360');
    expect(parsed.searchParams.get('height')).toBe('540');
    expect(parsed.searchParams.get('server')).toBe('srv-1');
    expect(parsed.searchParams.get('url')).toBe('/library/thumb/1');
    expect(parsed.searchParams.get('v')).toBe('abc12345');
    expect(parsed.searchParams.has('lqip')).toBe(false);
  });

  it('omits v when there is no posterVersion', () => {
    const src = buildPosterSrc(url, null);
    const parsed = new URL(src, 'http://localhost');
    expect(parsed.searchParams.has('v')).toBe(false);
  });

  it('adds lqip=1 only when asked', () => {
    const src = buildPosterSrc(url, 'abc12345', { lqip: true });
    const parsed = new URL(src, 'http://localhost');
    expect(parsed.searchParams.get('lqip')).toBe('1');
  });
});
