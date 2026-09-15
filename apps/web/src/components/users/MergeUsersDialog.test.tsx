import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MergeUsersDialog, type MergeUsersDialogProps } from './MergeUsersDialog';
import type { MergeCandidate } from './mergeSelection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useServerColorMap', () => ({
  useServerColorMap: () => new Map(),
}));

const candidates: [MergeCandidate, MergeCandidate] = [
  {
    userId: 'user-a',
    displayName: 'Bob (Plex)',
    username: 'bob',
    emails: ['bob@example.com'],
    loginCapable: false,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    sessionCount: 12,
    serverUsers: [],
  },
  {
    userId: 'user-b',
    displayName: 'Bob (Jellyfin)',
    username: 'bob-jf',
    emails: [],
    loginCapable: false,
    lastActivityAt: null,
    sessionCount: 3,
    serverUsers: [],
  },
];

function renderDialog(overrides: Partial<MergeUsersDialogProps> = {}) {
  const onConfirm = vi.fn();
  const props: MergeUsersDialogProps = {
    open: true,
    onOpenChange: vi.fn(),
    candidates,
    defaultTargetUserId: 'user-b',
    requiredTargetUserId: null,
    match: { type: 'email', value: 'bob@example.com', onUsername: false },
    sameServer: null,
    isLoading: false,
    onConfirm,
    ...overrides,
  };
  const view = render(<MergeUsersDialog {...props} />);
  return { onConfirm, props, ...view };
}

const kept = () => within(screen.getByRole('region', { name: 'pages:users.mergeKeep' }));
const confirmButton = () => screen.getByRole('button', { name: 'pages:users.mergeConfirmInto' });
const swapButton = () => screen.getByRole('button', { name: 'pages:users.mergeSwap' });
const acknowledgement = () =>
  screen.getByRole('checkbox', { name: 'pages:users.mergeIrreversibleAcknowledge' });

describe('MergeUsersDialog', () => {
  it('keeps the suggested identity by default and merges the other into it', async () => {
    const { onConfirm } = renderDialog();

    expect(kept().getByText('Bob (Jellyfin)')).toBeInTheDocument();
    await userEvent.click(confirmButton());

    expect(onConfirm).toHaveBeenCalledWith({
      sourceUserId: 'user-a',
      targetUserId: 'user-b',
      confirmSameServerCombine: false,
    });
  });

  it('swaps which identity is kept', async () => {
    const { onConfirm } = renderDialog();

    await userEvent.click(swapButton());
    expect(kept().getByText('Bob (Plex)')).toBeInTheDocument();
    await userEvent.click(confirmButton());

    expect(onConfirm).toHaveBeenCalledWith({
      sourceUserId: 'user-b',
      targetUserId: 'user-a',
      confirmSameServerCombine: false,
    });
  });

  it('keeps a login-capable identity over the suggested default and locks the swap', () => {
    renderDialog({
      candidates: [{ ...candidates[0], loginCapable: true }, candidates[1]],
      requiredTargetUserId: 'user-a',
    });

    expect(kept().getByText('Bob (Plex)')).toBeInTheDocument();
    expect(swapButton()).toBeDisabled();
    expect(screen.getByText('pages:users.mergeRequired')).toBeInTheDocument();
  });

  it('asks about a suggestion with its reason and highlights the shared email', () => {
    renderDialog();

    expect(screen.getByText('pages:users.mergeTitleSuggestion')).toBeInTheDocument();
    expect(screen.getByText('pages:users.mergeReasonEmail')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com').tagName).toBe('MARK');
    expect(screen.getByText('pages:users.mergeDeleted')).toBeInTheDocument();
  });

  it('does not repeat an email that is the username, and highlights the username instead', () => {
    renderDialog({
      candidates: [
        candidates[0],
        { ...candidates[1], username: 'Bob@Example.com', emails: ['bob@example.com'] },
      ],
    });

    const jellyfin = within(screen.getByRole('region', { name: 'pages:users.mergeKeep' }));
    expect(jellyfin.getByText('Bob@Example.com').tagName).toBe('MARK');
    expect(jellyfin.queryByText('bob@example.com')).not.toBeInTheDocument();
  });

  it('gives the username reason when the shared email is an account username', () => {
    renderDialog({ match: { type: 'email', value: 'bob@example.com', onUsername: true } });

    expect(screen.getByText('pages:users.mergeReasonEmailUsername')).toBeInTheDocument();
    expect(screen.queryByText('pages:users.mergeReasonEmail')).not.toBeInTheDocument();
  });

  it('asks the bulk question without a reason and skips unknown session counts', () => {
    renderDialog({
      match: null,
      candidates: [
        { ...candidates[0], sessionCount: undefined },
        { ...candidates[1], sessionCount: undefined },
      ],
    });

    expect(screen.getByText('pages:users.mergeTitleBulk')).toBeInTheDocument();
    expect(screen.queryByText('pages:users.mergeReasonEmail')).not.toBeInTheDocument();
    expect(screen.queryByText(/pages:users\.mergeSessions/)).not.toBeInTheDocument();
    expect(screen.getByText('pages:users.mergeMovesNoCount')).toBeInTheDocument();
  });

  it('requires the acknowledgement before a same-server combine, naming the server', async () => {
    const { onConfirm } = renderDialog({ sameServer: { serverName: 'Living Room Plex' } });

    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('pages:users.mergeIrreversibleTitle')).toBeInTheDocument();
    expect(screen.getByText('Living Room Plex')).toBeInTheDocument();
    expect(screen.getByText('pages:users.mergeRulesKept')).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();

    await userEvent.click(acknowledgement());
    await userEvent.click(confirmButton());

    expect(onConfirm).toHaveBeenCalledWith({
      sourceUserId: 'user-a',
      targetUserId: 'user-b',
      confirmSameServerCombine: true,
    });
  });

  it('falls back to generic copy when the same-server name is unknown', () => {
    renderDialog({ sameServer: { serverName: null } });

    expect(screen.getByText('pages:users.mergeServerUnknown')).toBeInTheDocument();
  });

  it('disables the swap, acknowledgement and confirm while the merge is pending', () => {
    renderDialog({ sameServer: { serverName: 'Living Room Plex' }, isLoading: true });

    expect(swapButton()).toBeDisabled();
    expect(acknowledgement()).toBeDisabled();
    expect(confirmButton()).toBeDisabled();
  });

  it('keeps the acknowledgement when a re-render passes the same pair as a new array', async () => {
    const { props, rerender } = renderDialog({ sameServer: { serverName: 'Living Room Plex' } });

    await userEvent.click(acknowledgement());
    rerender(
      <MergeUsersDialog {...props} candidates={[{ ...candidates[0] }, { ...candidates[1] }]} />
    );

    expect(acknowledgement()).toBeChecked();
  });

  it('marks an identity as removed only when every account is removed', () => {
    renderDialog({
      candidates: [
        {
          ...candidates[0],
          serverUsers: [
            {
              id: 'su-1',
              serverId: 's1',
              serverName: 'Plex',
              removedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
        {
          ...candidates[1],
          serverUsers: [
            {
              id: 'su-2',
              serverId: 's1',
              serverName: 'Plex',
              removedAt: '2026-01-01T00:00:00.000Z',
            },
            { id: 'su-3', serverId: 's2', serverName: 'Jellyfin', removedAt: null },
          ],
        },
      ],
    });

    expect(screen.getAllByText('pages:users.mergeServerAccountRemoved')).toHaveLength(1);
  });
});
