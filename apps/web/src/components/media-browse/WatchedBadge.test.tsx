import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import { WatchedBadge } from './WatchedBadge';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

describe('WatchedBadge', () => {
  it('renders the check badge with a visually-hidden "watched" label', () => {
    const { container } = render(<WatchedBadge watchedState="watched" />);
    expect(screen.getByText('Watched')).toHaveClass('sr-only');
    expect(container.querySelector('circle')).toBeNull();
  });

  it('renders a distinct partial indicator with a visually-hidden "partially watched" label', () => {
    const { container } = render(<WatchedBadge watchedState="partial" />);
    expect(screen.getByText('Partially watched')).toHaveClass('sr-only');
    expect(screen.queryByText('Watched')).not.toBeInTheDocument();
    expect(container.querySelector('.lucide-check')).toBeNull();
    expect(container.querySelector('svg path')).not.toBeNull();
  });

  it('renders visually distinct markup for watched vs partial (never the same badge)', () => {
    const watched = render(<WatchedBadge watchedState="watched" />);
    const partial = render(<WatchedBadge watchedState="partial" />);
    expect(watched.container.innerHTML).not.toBe(partial.container.innerHTML);
  });

  it('renders nothing for unwatched state', () => {
    const { container } = render(<WatchedBadge watchedState="unwatched" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the partial pie in the warning tone when the requester has no progress of their own', () => {
    const { container } = render(
      <WatchedBadge watchedState="partial" watchedStateSelf="unwatched" />
    );
    expect(container.querySelector('path')).toHaveAttribute('fill', 'hsl(var(--warning))');
  });

  it('renders the partial pie in the success tone when the requester is mid-watch themselves', () => {
    const { container } = render(
      <WatchedBadge watchedState="partial" watchedStateSelf="partial" />
    );
    expect(container.querySelector('path')).toHaveAttribute('fill', 'hsl(var(--success))');
  });

  it('renders the success/green tone with a "watched by you" label when the requester watched it', () => {
    const { container } = render(
      <WatchedBadge watchedState="watched" watchedStateSelf="watched" />
    );
    expect(screen.getByText('Watched by you')).toHaveClass('sr-only');
    expect(container.firstElementChild).toHaveClass('bg-success');
    expect(container.firstElementChild).not.toHaveClass('bg-warning');
  });

  it('renders the warning/orange tone with a "watched by others" label when only someone else watched it', () => {
    const { container } = render(
      <WatchedBadge watchedState="watched" watchedStateSelf="unwatched" />
    );
    expect(screen.getByText('Watched by others')).toHaveClass('sr-only');
    expect(container.firstElementChild).toHaveClass('bg-warning');
    expect(container.firstElementChild).not.toHaveClass('bg-success');
  });

  it('never claims green without requester data: single-tone fallback stays warning', () => {
    const { container } = render(<WatchedBadge watchedState="watched" />);
    expect(screen.getByText('Watched')).toHaveClass('sr-only');
    expect(container.firstElementChild).toHaveClass('bg-warning');
    expect(container.firstElementChild).not.toHaveClass('bg-success');
  });
});
