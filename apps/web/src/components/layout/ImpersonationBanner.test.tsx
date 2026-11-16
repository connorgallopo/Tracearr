import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { name?: string }) => (vars?.name ? `${key}:${vars.name}` : key),
  }),
}));

const auth = vi.hoisted(() => ({
  user: null as { username: string; name?: string | null; impersonatedBy?: string } | null,
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: auth.user }) }));

vi.mock('@/lib/authClient', () => ({
  authClient: { admin: { stopImpersonating: vi.fn() } },
}));

import { authClient } from '@/lib/authClient';
import { ImpersonationBanner } from './ImpersonationBanner';

const stopImpersonating = vi.mocked(authClient.admin.stopImpersonating);

function renderBanner() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ImpersonationBanner />
    </QueryClientProvider>
  );
}

describe('ImpersonationBanner', () => {
  beforeEach(() => {
    stopImpersonating.mockReset();
  });

  it('renders nothing for a normal session', () => {
    auth.user = { username: 'alice' };
    const { container } = renderBanner();

    expect(container).toBeEmptyDOMElement();
  });

  it('names the member being viewed and offers a stop button', () => {
    auth.user = { username: 'bob', impersonatedBy: 'owner-1' };
    renderBanner();

    expect(screen.getByText('impersonation.banner:bob')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'impersonation.stopLabel:bob' })).toBeEnabled();
  });

  it('names the member by their display name when they have one', () => {
    auth.user = { username: 'bob', name: 'Bob Ray', impersonatedBy: 'owner-1' };
    renderBanner();

    expect(screen.getByText('impersonation.banner:Bob Ray')).toBeInTheDocument();
  });

  it('shows the failure in place of the message and keeps the button for a retry', async () => {
    auth.user = { username: 'bob', impersonatedBy: 'owner-1' };
    stopImpersonating.mockResolvedValue({
      data: null,
      error: { message: 'Session expired', status: 401, statusText: 'Unauthorized' },
    } as never);
    renderBanner();

    await userEvent.click(screen.getByRole('button', { name: 'impersonation.stopLabel:bob' }));

    expect(await screen.findByText('Session expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'impersonation.stopLabel:bob' })).toBeEnabled();
  });
});
