import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { Users } from './Users';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { mockResetTrustMutate, mockMergeMutate } = vi.hoisted(() => ({
  mockResetTrustMutate: vi.fn(),
  mockMergeMutate: vi.fn(),
}));

vi.mock('@/hooks/queries', () => ({
  useUsers: vi.fn(),
  useBulkResetTrust: () => ({ mutate: mockResetTrustMutate, isPending: false }),
  useMergeUsers: () => ({ mutate: mockMergeMutate, isPending: false }),
  useMergeSuggestions: () => ({ data: undefined, isLoading: false }),
  useDismissedMergeSuggestions: () => ({ data: undefined }),
  useDismissMergeSuggestion: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreMergeSuggestion: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

import { useUsers } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useAuth } from '@/hooks/useAuth';

const mockUseUsers = vi.mocked(useUsers);
const mockUseServer = vi.mocked(useServer);
const mockUseAuth = vi.mocked(useAuth);

const aliceRow = {
  id: 'su-1',
  userId: 'u-1',
  serverId: 'server-1',
  serverName: 'Server One',
  username: 'alice',
  identityName: 'Alice',
  identityTrustScore: 80,
  trustScore: 80,
  role: 'member',
  identityServers: [],
  loginCapable: true,
  identityJoinedAt: '2024-01-02T00:00:00.000Z',
  identityLastActivityAt: '2024-05-02T00:00:00.000Z',
};

function mockList(rows: unknown[], total: number) {
  mockUseUsers.mockReturnValue({
    data: { data: rows, meta: { page: 1, pageSize: 100, total } },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useUsers>);
}

function lastQueryParams() {
  const calls = mockUseUsers.mock.calls;
  return calls[calls.length - 1]?.[0];
}

function renderUsers(path = '/users') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Users />
    </MemoryRouter>
  );
}

describe('Users', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseServer.mockReturnValue({
      selectedServerIds: [],
      selectedServers: [],
      servers: [{ id: 'server-1', name: 'Server One' }],
    } as unknown as ReturnType<typeof useServer>);
    mockUseAuth.mockReturnValue({
      user: { role: 'viewer' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('shows the users table once the list has loaded', () => {
    mockList([], 0);

    renderUsers();

    expect(screen.getByText('pages:users.noUsersFound')).toBeInTheDocument();
  });

  it('shows an error state instead of the empty table when the users query fails, and retry refetches it', async () => {
    const refetch = vi.fn();
    mockUseUsers.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('users failed'),
      refetch,
    } as unknown as ReturnType<typeof useUsers>);

    renderUsers();

    expect(screen.queryByText('pages:users.noUsersFound')).not.toBeInTheDocument();
    expect(screen.getByText('common:errors.somethingWentWrong')).toBeInTheDocument();
    expect(screen.getByText('users failed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it('wires a trust score header click into orderBy on the query, not a client-only sort', async () => {
    mockList([aliceRow], 1);

    renderUsers();

    await userEvent.click(screen.getByText('common:labels.trustScore'));

    const lastCall = lastQueryParams();
    expect(lastCall).toMatchObject({ orderBy: 'trustScore' });
    expect(['asc', 'desc']).toContain(lastCall?.orderDir);
  });

  it('sends the search box to the server and returns to the first page once it settles', async () => {
    mockList([aliceRow], 250);

    renderUsers();

    await userEvent.click(screen.getByRole('button', { name: 'common:actions.next' }));
    expect(lastQueryParams()).toMatchObject({ page: 2 });

    await userEvent.type(screen.getByPlaceholderText('pages:users.searchPlaceholder'), 'bob');

    await waitFor(() => expect(lastQueryParams()).toMatchObject({ search: 'bob', page: 1 }));
  });

  it('reads a linked date filter out of the URL and sends it as calendar-date bounds', () => {
    mockList([aliceRow], 1);

    renderUsers('/users?joinedFrom=2024-01-01&joinedTo=2024-02-01&activeFrom=2024-03-04');

    expect(lastQueryParams()).toMatchObject({
      joinedAfter: '2024-01-01',
      joinedBefore: '2024-02-01',
      activeAfter: '2024-03-04',
    });
  });

  it('sends every active filter with a select-all trust reset, not just the server scope', async () => {
    mockUseAuth.mockReturnValue({
      user: { role: 'admin' },
    } as unknown as ReturnType<typeof useAuth>);
    mockList([aliceRow], 250);

    renderUsers('/users?search=bob&hasAccessTo=server-1&joinedFrom=2024-01-01&showRemoved=1');

    await userEvent.click(screen.getByRole('checkbox', { name: 'common:table.selectRow' }));
    await userEvent.click(screen.getByRole('button', { name: 'pages:users.selectAllUsers' }));
    await userEvent.click(screen.getByRole('button', { name: 'pages:users.resetTrustScore' }));

    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'pages:users.resetTrustScore' })
    );

    expect(mockResetTrustMutate).toHaveBeenCalledWith(
      {
        selectAll: true,
        filters: {
          serverIds: undefined,
          hasAccessTo: ['server-1'],
          includeRemoved: true,
          search: 'bob',
          joinedAfter: '2024-01-01',
          joinedBefore: undefined,
          activeAfter: undefined,
          activeBefore: undefined,
        },
      },
      expect.anything()
    );
  });

  it('defaults a bulk merge to the live account over a more recently active removed one', async () => {
    mockUseAuth.mockReturnValue({
      user: { role: 'owner' },
    } as unknown as ReturnType<typeof useAuth>);
    const carolRow = {
      ...aliceRow,
      id: 'su-2',
      userId: 'u-2',
      serverId: 'server-2',
      serverName: 'Server Two',
      username: 'carol',
      identityName: 'Carol',
      loginCapable: false,
      identityLastActivityAt: '2025-01-01T00:00:00.000Z',
      removedAt: '2025-01-02T00:00:00.000Z',
    };
    mockList([carolRow, { ...aliceRow, loginCapable: false }], 2);

    renderUsers();

    for (const index of [0, 1]) {
      const rowCheckbox = screen.getAllByRole('checkbox', { name: 'common:table.selectRow' })[
        index
      ];
      if (!rowCheckbox) throw new Error(`missing row checkbox ${index}`);
      await userEvent.click(rowCheckbox);
    }
    const mergeButton = screen.getByRole('button', { name: 'pages:users.mergeUsers' });
    expect(mergeButton).toBeEnabled();
    await userEvent.click(mergeButton);

    const dialog = await screen.findByRole('alertdialog');
    const kept = within(dialog).getByRole('region', { name: 'pages:users.mergeKeep' });
    expect(within(kept).getByText('Alice')).toBeInTheDocument();

    await userEvent.click(
      within(dialog).getByRole('button', { name: 'pages:users.mergeConfirmInto' })
    );
    expect(mockMergeMutate).toHaveBeenCalledWith(
      { sourceUserId: 'u-2', targetUserId: 'u-1', confirmSameServerCombine: false },
      expect.anything()
    );
  });
});
