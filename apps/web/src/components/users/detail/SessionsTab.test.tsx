import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProfileFilterOption } from '@tracearr/shared';
import { SessionsTab } from './SessionsTab';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/history/HistoryTable', () => ({
  HistoryTable: ({
    sessions,
    showProfile,
  }: {
    sessions: { id: string }[];
    showProfile: boolean;
  }) => (
    <p>
      {sessions.map((session) => session.id).join(',')}
      {showProfile && ' with the profile column'}
    </p>
  ),
}));
vi.mock('@/hooks/useServer', () => ({ useServer: () => ({ servers: [] }) }));
vi.mock('@/hooks/queries', () => ({ useUserSessions: vi.fn() }));

import { useUserSessions } from '@/hooks/queries';

const robin: ProfileFilterOption = {
  id: 'p-robin',
  name: 'Robin',
  serverUserId: 'su-1',
  accountUsername: 'alice',
  serverName: 'Den',
  removed: false,
};

function renderTab(profiles: ProfileFilterOption[]) {
  render(
    <SessionsTab
      userId="su-1"
      scope="identity"
      user={{ id: 'su-1', username: 'alice', thumbUrl: null }}
      personName="alice"
      profiles={profiles}
      showServer={false}
      onSessionClick={vi.fn()}
    />
  );
}

describe('SessionsTab', () => {
  it('pages through the sessions ten at a time', async () => {
    vi.mocked(useUserSessions).mockReturnValue({
      data: { data: [{ id: 's-1', serverId: 'server-1' }], total: 25 },
      isLoading: false,
    } as unknown as ReturnType<typeof useUserSessions>);

    renderTab([]);

    expect(screen.getByText('s-1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'actions.next' }));

    expect(vi.mocked(useUserSessions)).toHaveBeenLastCalledWith('su-1', {
      page: 2,
      pageSize: 10,
      scope: 'identity',
    });
  });

  it('pages the picked profile from its first page', async () => {
    vi.mocked(useUserSessions).mockReturnValue({
      data: { data: [], total: 25 },
      isLoading: false,
    } as unknown as ReturnType<typeof useUserSessions>);

    renderTab([robin, { ...robin, id: 'p-sam', name: 'Sam', removed: true }]);
    await userEvent.click(screen.getByRole('button', { name: 'actions.next' }));
    await userEvent.click(screen.getByRole('combobox', { name: 'common:labels.profiles' }));
    await userEvent.click(screen.getByRole('option', { name: 'Robin' }));

    expect(vi.mocked(useUserSessions)).toHaveBeenLastCalledWith('su-1', {
      page: 1,
      pageSize: 10,
      scope: 'identity',
      profileIds: ['p-robin'],
    });
  });

  it('names the profile on each row, without a pick, for an account with one profile', () => {
    vi.mocked(useUserSessions).mockReturnValue({
      data: { data: [{ id: 's-1', serverId: 'server-1' }], total: 1 },
      isLoading: false,
    } as unknown as ReturnType<typeof useUserSessions>);

    renderTab([robin]);

    expect(screen.getByText('s-1 with the profile column')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
