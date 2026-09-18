import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { SessionWithDetails } from '@tracearr/shared';
import { SessionDetailSheet } from './SessionDetailSheet';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderSheet(overrides: Partial<SessionWithDetails>) {
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
    stoppedAt: new Date('2024-01-01T21:00:00Z'),
    durationMs: 3_600_000,
    progressMs: null,
    totalDurationMs: null,
    geoLat: null,
    geoLon: null,
    ...overrides,
  } as unknown as SessionWithDetails;

  return render(
    <MemoryRouter>
      <SessionDetailSheet session={session} open onOpenChange={vi.fn()} />
    </MemoryRouter>
  );
}

describe('SessionDetailSheet', () => {
  it('shows no progress percentage for a play without a total', () => {
    renderSheet({ progressMs: 3_600_000, totalDurationMs: null });

    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows no progress percentage for a play with a total but no position', () => {
    renderSheet({ progressMs: null, totalDurationMs: 5_400_000 });

    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows 0% for a play whose position is a measured 0', () => {
    renderSheet({ progressMs: 0, totalDurationMs: 5_400_000 });

    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('shows the progress percentage when the play has a total', () => {
    renderSheet({ progressMs: 2_700_000, totalDurationMs: 5_400_000 });

    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });
});
