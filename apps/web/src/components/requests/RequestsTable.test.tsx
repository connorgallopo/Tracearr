import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { initI18n } from '@tracearr/translations';
import type { MediaRequestEntry, UserRequestEntry } from '@tracearr/shared';
import { RequestsTable } from './RequestsTable';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

function renderTable(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function makeMediaEntry(overrides: Partial<MediaRequestEntry> = {}): MediaRequestEntry {
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

function makeUserEntry(overrides: Partial<UserRequestEntry> = {}): UserRequestEntry {
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
    media: { mediaId: 'm1', title: 'Arrival', year: 2016, mediaType: 'movie' },
    ...overrides,
  };
}

describe('RequestsTable', () => {
  it('shows a loading skeleton while rows are undefined', () => {
    const { container } = renderTable(
      <RequestsTable
        subject="media"
        rows={[]}
        isLoading
        isError={false}
        onRetry={vi.fn()}
        emptyTitle="No requests"
      />
    );
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('shows an inline error with retry on failure', () => {
    const onRetry = vi.fn();
    renderTable(
      <RequestsTable
        subject="media"
        rows={[]}
        isLoading={false}
        isError
        onRetry={onRetry}
        emptyTitle="No requests"
      />
    );
    screen.getByRole('button', { name: /Try again/ }).click();
    expect(onRetry).toHaveBeenCalled();
  });

  it('shows the empty state title when there are no rows', () => {
    renderTable(
      <RequestsTable
        subject="media"
        rows={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        emptyTitle="No requests yet"
      />
    );
    expect(screen.getByText('No requests yet')).toBeInTheDocument();
  });

  it('shows the requester name linked to their user page for the media subject', () => {
    renderTable(
      <RequestsTable
        subject="media"
        rows={[makeMediaEntry()]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        emptyTitle="No requests"
      />
    );
    const link = screen.getByRole('link', { name: /Alice/ });
    expect(link).toHaveAttribute('href', '/users/u1');
  });

  it('links the title to the media page when mediaId is set for the user subject', () => {
    renderTable(
      <RequestsTable
        subject="user"
        rows={[makeUserEntry()]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        emptyTitle="No requests"
      />
    );
    const link = screen.getByRole('link', { name: 'Arrival' });
    expect(link).toHaveAttribute('href', '/media/m1');
  });

  it('shows the title as plain text when mediaId is null for the user subject', () => {
    renderTable(
      <RequestsTable
        subject="user"
        rows={[
          makeUserEntry({
            media: { mediaId: null, title: 'Old Title', year: null, mediaType: 'movie' },
          }),
        ]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        emptyTitle="No requests"
      />
    );
    expect(screen.getByText('Old Title')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Old Title' })).not.toBeInTheDocument();
  });

  it('renders the watched badge with the by-you accessible name for a self watch', () => {
    renderTable(
      <RequestsTable
        subject="media"
        rows={[makeMediaEntry({ status: 'completed', watchedState: 'watched' })]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        emptyTitle="No requests"
      />
    );
    expect(screen.getByText('Watched by you')).toBeInTheDocument();
  });

  it('renders no watched badge for an unwatched row', () => {
    const { container } = renderTable(
      <RequestsTable
        subject="media"
        rows={[makeMediaEntry({ watchedState: 'unwatched' })]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        emptyTitle="No requests"
      />
    );
    expect(container.querySelector('.bg-success, .bg-warning')).not.toBeInTheDocument();
  });
});
