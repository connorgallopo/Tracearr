import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { initI18n } from '@tracearr/translations';
import type { MediaRequestEntry } from '@tracearr/shared';
import { MediaRequestsPanel } from './MediaRequestsPanel';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

function makeEntry(overrides: Partial<MediaRequestEntry> = {}): MediaRequestEntry {
  return {
    id: 'r1',
    serverId: 's1',
    status: 'completed',
    requestedAt: '2026-01-01T00:00:00.000Z',
    availableAt: '2026-01-02T00:00:00.000Z',
    waitMs: 24 * 60 * 60 * 1000,
    deletedAt: null,
    seasons: null,
    is4k: false,
    isAutoRequest: false,
    watchedState: 'unwatched',
    requester: {
      serverUserId: 'u1',
      userId: 'u1',
      serverId: 's1',
      username: 'alice',
      identityName: 'Alice',
      thumb: null,
    },
    ...overrides,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof MediaRequestsPanel>> = {}) {
  return render(
    <MemoryRouter>
      <MediaRequestsPanel
        rows={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        {...props}
      />
    </MemoryRouter>
  );
}

describe('MediaRequestsPanel', () => {
  it('renders nothing when the query resolved with no rows', () => {
    const { container } = renderPanel();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the rows are still undefined and no fetch is in flight', () => {
    const { container } = renderPanel({ rows: undefined });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the first fetch is still in flight', () => {
    const { container } = renderPanel({ rows: undefined, isLoading: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the heading and a row per request', () => {
    renderPanel({ rows: [makeEntry(), makeEntry({ id: 'r2' })] });

    expect(screen.getByRole('heading', { name: 'Requests' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Alice/ })).toHaveLength(2);
  });

  it('shows an inline error with retry when the request fetch fails', () => {
    const onRetry = vi.fn();
    renderPanel({ isError: true, onRetry });

    screen.getByRole('button', { name: /Try again/ }).click();
    expect(onRetry).toHaveBeenCalled();
  });
});
