import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionsTab } from './SessionsTab';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/history/HistoryTable', () => ({
  HistoryTable: ({ sessions }: { sessions: { id: string }[] }) => (
    <p>{sessions.map((session) => session.id).join(',')}</p>
  ),
}));
vi.mock('@/hooks/useServer', () => ({ useServer: () => ({ servers: [] }) }));
vi.mock('@/hooks/queries', () => ({ useUserSessions: vi.fn() }));

import { useUserSessions } from '@/hooks/queries';

describe('SessionsTab', () => {
  it('pages through the sessions ten at a time', async () => {
    vi.mocked(useUserSessions).mockReturnValue({
      data: { data: [{ id: 's-1', serverId: 'server-1' }], total: 25 },
      isLoading: false,
    } as unknown as ReturnType<typeof useUserSessions>);

    render(
      <SessionsTab
        userId="su-1"
        scope="identity"
        user={{ id: 'su-1', username: 'alice', thumbUrl: null }}
        personName="alice"
        showServer={false}
        onSessionClick={vi.fn()}
      />
    );

    expect(screen.getByText('s-1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'actions.next' }));

    expect(vi.mocked(useUserSessions)).toHaveBeenLastCalledWith('su-1', {
      page: 2,
      pageSize: 10,
      scope: 'identity',
    });
  });
});
