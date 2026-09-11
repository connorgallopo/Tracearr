import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { initI18n } from '@tracearr/translations';
import type { UserRequestEntry, UserRequestsResponse } from '@tracearr/shared';

vi.mock('@/hooks/queries/useRequests', () => ({ useUserRequests: vi.fn() }));

import { useUserRequests } from '@/hooks/queries/useRequests';
import { UserRequestsCard } from './UserRequestsCard';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const mockUseUserRequests = vi.mocked(useUserRequests);

function makeEntry(id: string): UserRequestEntry {
  return {
    id,
    serverId: 's1',
    status: 'completed',
    requestedAt: '2026-01-01T12:00:00.000Z',
    availableAt: '2026-01-02T12:00:00.000Z',
    waitMs: 24 * 60 * 60 * 1000,
    deletedAt: null,
    seasons: null,
    is4k: false,
    isAutoRequest: false,
    watchedState: 'unwatched',
    media: { mediaId: `m-${id}`, title: `Title ${id}`, year: 2016, mediaType: 'movie' },
  };
}

function response(total: number, rowCount: number): UserRequestsResponse {
  return {
    data: Array.from({ length: rowCount }, (_, index) => makeEntry(String(index))),
    total,
    page: 1,
    pageSize: rowCount,
    summary: {
      total,
      approvalRate: 0.8,
      completed: total,
      neverWatched: 1,
      medianWaitMs: 60 * 60 * 1000,
    },
  };
}

function mockQuery(
  data: UserRequestsResponse | undefined,
  overrides: Record<string, unknown> = {}
) {
  mockUseUserRequests.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useUserRequests>);
}

function renderCard() {
  return render(
    <MemoryRouter>
      <UserRequestsCard serverUserId="su-1" scope="identity" />
    </MemoryRouter>
  );
}

describe('UserRequestsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing once the query resolves with no requests', () => {
    mockQuery(response(0, 0));

    const { container } = renderCard();

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the first fetch is still in flight', () => {
    mockQuery(undefined, { isLoading: true });

    const { container } = renderCard();

    expect(container).toBeEmptyDOMElement();
  });

  it('asks for the first five rows under the identity scope', () => {
    mockQuery(response(3, 3));

    renderCard();

    expect(mockUseUserRequests).toHaveBeenCalledWith('su-1', {
      scope: 'identity',
      page: 1,
      pageSize: 5,
    });
    expect(screen.getByRole('heading', { name: 'Requests' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Title/ })).toHaveLength(3);
  });

  it('offers the view-all button with the remaining count when there are more than five', () => {
    mockQuery(response(12, 5));

    renderCard();

    expect(screen.getByRole('button', { name: 'View all (7 more)' })).toBeInTheDocument();
  });

  it('raises the page size and flips the button label once expanded', async () => {
    mockQuery(response(12, 5));

    renderCard();
    await userEvent.setup().click(screen.getByRole('button', { name: 'View all (7 more)' }));

    expect(mockUseUserRequests).toHaveBeenLastCalledWith('su-1', {
      scope: 'identity',
      page: 1,
      pageSize: 50,
    });
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('offers only what expanding shows once the total passes the expanded page size', () => {
    mockQuery(response(80, 5));

    renderCard();

    expect(screen.getByRole('button', { name: 'View all (45 more)' })).toBeInTheDocument();
  });

  it('keeps the card up with an inline error when the fetch fails', () => {
    const refetch = vi.fn();
    mockQuery(undefined, { isError: true, refetch });

    renderCard();

    screen.getByRole('button', { name: /Try again/ }).click();
    expect(refetch).toHaveBeenCalled();
  });
});
