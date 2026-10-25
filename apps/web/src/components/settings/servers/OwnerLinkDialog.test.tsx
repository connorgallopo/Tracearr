import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OwnerLinkCandidate, OwnerLinkServer, Server } from '@tracearr/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/hooks/queries', () => ({
  useLinkOwnerAccount: vi.fn(),
}));

import { useLinkOwnerAccount } from '@/hooks/queries';
import { OwnerLinkDialog } from './OwnerLinkDialog';

const server = { id: 'srv-1', name: 'Home', type: 'jellyfin' } as unknown as Server;

function candidate(overrides: Partial<OwnerLinkCandidate>): OwnerLinkCandidate {
  return {
    serverUserId: 'su-1',
    username: 'gabriel',
    thumbUrl: null,
    isServerAdmin: false,
    lastActivityAt: null,
    blockedReason: null,
    ...overrides,
  };
}

function renderDialog(candidates: OwnerLinkCandidate[]) {
  const link: OwnerLinkServer = { serverId: 'srv-1', linked: null, candidates };
  return render(<OwnerLinkDialog open onOpenChange={vi.fn()} server={server} link={link} />);
}

const mutate = vi.fn();

describe('OwnerLinkDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useLinkOwnerAccount).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useLinkOwnerAccount>);
  });

  it('pre-selects the only administrator and links only once its username is typed', async () => {
    const user = userEvent.setup();
    renderDialog([
      candidate({ serverUserId: 'su-1', username: 'gabriel', isServerAdmin: true }),
      candidate({ serverUserId: 'su-2', username: 'friend' }),
    ]);
    const submit = screen.getByRole('button', { name: 'servers.ownerAccount.dialog.submit' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: /confirmLabel/ }), 'Gabriel');
    expect(submit).toBeDisabled();
    await user.clear(screen.getByRole('textbox', { name: /confirmLabel/ }));
    await user.type(screen.getByRole('textbox', { name: /confirmLabel/ }), 'gabriel');
    await user.click(submit);

    expect(mutate).toHaveBeenCalledWith('su-1', expect.anything());
  });

  it('selects nothing when there is more than one administrator', () => {
    renderDialog([
      candidate({ serverUserId: 'su-1', username: 'gabriel', isServerAdmin: true }),
      candidate({ serverUserId: 'su-2', username: 'second', isServerAdmin: true }),
    ]);

    expect(screen.queryByRole('textbox', { name: /confirmLabel/ })).not.toBeInTheDocument();
  });

  it('cannot pick an account the server would refuse', async () => {
    const user = userEvent.setup();
    renderDialog([candidate({ username: 'traveler', blockedReason: 'other_accounts' })]);

    await user.click(screen.getByText('traveler'));

    expect(screen.getByText('servers.ownerAccount.dialog.otherAccounts')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /confirmLabel/ })).not.toBeInTheDocument();
  });
});
