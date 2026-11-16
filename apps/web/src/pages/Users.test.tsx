import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
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
  useSettings: () => ({ data: { loginMethods: { member: true } } }),
  useUserFull: vi.fn(),
  useUpdateUser: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateUserIdentity: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/queries/useImpersonation', () => ({
  useViewAs: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

import { useUserFull, useUsers } from '@/hooks/queries';
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
      <Routes>
        <Route path="/users" element={<Users />} />
        <Route path="/users/:id" element={<p>user detail page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

const twoServers = [
  { id: 'server-1', name: 'Server One' },
  { id: 'server-2', name: 'Server Two' },
];

describe('Users', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useUserFull).mockReturnValue({ data: undefined } as unknown as ReturnType<
      typeof useUserFull
    >);
    mockUseServer.mockReturnValue({
      selectedServerIds: [],
      selectedServers: [],
      servers: [{ id: 'server-1', name: 'Server One' }],
    } as unknown as ReturnType<typeof useServer>);
    mockUseAuth.mockReturnValue({
      user: { role: 'member' },
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

    await userEvent.click(screen.getByRole('button', { name: /actions.tryAgain/ }));
    expect(refetch).toHaveBeenCalled();
  });

  it('wires a role header click into orderBy on the query, not a client-only sort', async () => {
    mockList([aliceRow], 1);

    renderUsers();

    await userEvent.click(screen.getByText('pages:userDetail.access.role'));

    const lastCall = lastQueryParams();
    expect(lastCall).toMatchObject({ orderBy: 'role' });
    expect(['asc', 'desc']).toContain(lastCall?.orderDir);
  });

  it('renders role, sign-in, flags, joined and last activity columns and no servers column on a single server', () => {
    mockList([{ ...aliceRow, loginAccess: 'allow', lastLoginAt: null }], 1);

    renderUsers();

    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent);
    expect(headers).toEqual([
      '',
      'common:labels.user',
      'pages:userDetail.access.role',
      'pages:userDetail.access.signIn',
      'common:labels.status',
      'common:labels.joined',
      'common:labels.lastActivity',
      '',
    ]);
    expect(screen.getByText('pages:userDetail.access.roleMember')).toBeInTheDocument();
    expect(screen.getByText('pages:userDetail.access.signInAllow')).toBeInTheDocument();
    expect(screen.getByText('pages:users.signInOn')).toBeInTheDocument();
    expect(screen.getByText(/pages:users\.neverSignedIn/)).toBeInTheDocument();
    expect(screen.queryByText('common:count.server')).not.toBeInTheDocument();
  });

  it('shows a servers count column when more than one server is configured', () => {
    mockUseServer.mockReturnValue({
      selectedServerIds: [],
      selectedServers: [],
      servers: twoServers,
    } as unknown as ReturnType<typeof useServer>);
    mockList([{ ...aliceRow, email: 'alice@example.com', identityServers: twoServers }], 1);

    renderUsers();

    expect(screen.getByText(/common:count\.server/)).toBeInTheDocument();
    expect(screen.getByText(/alice@example\.com/)).toBeInTheDocument();
    expect(screen.getByText('pages:users.merged')).toBeInTheDocument();
  });

  it('shows the trust badge in flags only below 100 and links N pending to the filtered violations page', () => {
    mockList(
      [
        { ...aliceRow, pendingViolations: 2 },
        {
          ...aliceRow,
          id: 'su-2',
          userId: 'u-2',
          username: 'bob',
          identityName: 'Bob',
          identityTrustScore: 100,
          trustScore: 100,
          pendingViolations: 0,
        },
      ],
      2
    );

    renderUsers();

    expect(screen.getByText('80')).toBeInTheDocument();
    expect(screen.queryByText('100')).not.toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'pages:users.pendingLink' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/violations?people=u-1&status=pending');
  });

  it('sends role, signIn and pendingOnly filters and resets to page 1', async () => {
    mockList([aliceRow], 250);

    renderUsers();

    await userEvent.click(screen.getByRole('button', { name: 'common:actions.next' }));
    expect(lastQueryParams()).toMatchObject({ page: 2 });

    await userEvent.click(screen.getByRole('button', { name: /filters/i }));
    await userEvent.click(screen.getByRole('combobox', { name: 'pages:userDetail.access.role' }));
    await userEvent.click(
      screen.getByRole('option', { name: 'pages:userDetail.access.roleAdmin' })
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'pages:userDetail.access.signIn' }));
    await userEvent.click(
      screen.getByRole('option', { name: 'pages:userDetail.access.signInAllow' })
    );
    await userEvent.click(screen.getByRole('switch', { name: 'pages:users.filterPendingOnly' }));

    await waitFor(() =>
      expect(lastQueryParams()).toMatchObject({
        role: 'admin',
        signIn: 'allow',
        pendingOnly: true,
        page: 1,
      })
    );
  });

  it('sorts by trust score, lowest first, from the Status header', async () => {
    mockList([aliceRow], 1);

    renderUsers();

    await userEvent.click(screen.getByText('common:labels.status'));

    expect(lastQueryParams()).toMatchObject({ orderBy: 'trustScore', orderDir: 'asc' });
  });

  it('opens the row menu without navigating', async () => {
    mockUseAuth.mockReturnValue({
      user: { role: 'owner' },
    } as unknown as ReturnType<typeof useAuth>);
    mockList([aliceRow], 1);

    renderUsers();

    await userEvent.click(screen.getByRole('button', { name: 'pages:users.rowActions' }));

    expect(
      await screen.findByRole('menuitem', { name: 'pages:userDetail.editIdentity' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'pages:userDetail.adjustTrustScore' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'pages:userDetail.access.viewAs' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'pages:users.menuOpenViolations' })
    ).toHaveAttribute('href', '/violations?people=u-1');
    expect(screen.queryByText('user detail page')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('menuitem', { name: 'pages:userDetail.editIdentity' }));
    expect(screen.queryByText('user detail page')).not.toBeInTheDocument();
  });

  it('holds Edit identity closed until the person has loaded, then seeds their contact email', async () => {
    mockUseAuth.mockReturnValue({
      user: { role: 'owner' },
    } as unknown as ReturnType<typeof useAuth>);
    mockList([aliceRow], 1);

    renderUsers();
    await userEvent.click(screen.getByRole('button', { name: 'pages:users.rowActions' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'pages:userDetail.editIdentity' })
    );

    expect(vi.mocked(useUserFull)).toHaveBeenLastCalledWith('su-1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it("opens Edit identity with the loaded contact email and the Tracearr user's username", async () => {
    mockUseAuth.mockReturnValue({
      user: { role: 'owner' },
    } as unknown as ReturnType<typeof useAuth>);
    vi.mocked(useUserFull).mockImplementation(
      (id: string) =>
        ({
          data: id
            ? { identity: { contactEmail: 'alice@news.example', username: 'ally' } }
            : undefined,
        }) as unknown as ReturnType<typeof useUserFull>
    );
    mockList([aliceRow], 1);

    renderUsers();
    await userEvent.click(screen.getByRole('button', { name: 'pages:users.rowActions' }));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'pages:userDetail.editIdentity' })
    );

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByDisplayValue('alice@news.example')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('ally')).toBeInTheDocument();
  });

  it('sends the search box to the server and returns to the first page once it settles', async () => {
    mockList([aliceRow], 250);

    renderUsers();

    await userEvent.click(screen.getByRole('button', { name: 'common:actions.next' }));
    expect(lastQueryParams()).toMatchObject({ page: 2 });

    await userEvent.type(screen.getByPlaceholderText('common:search.searchUsers'), 'bob');

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
          pendingOnly: false,
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

  it('marks a historical server in the server filter and lists it after live ones', async () => {
    mockUseServer.mockReturnValue({
      selectedServerIds: [],
      selectedServers: [],
      servers: [
        { id: 'server-old', name: 'Old Plex', historicalAt: '2026-09-01T12:00:00.000Z' },
        { id: 'server-1', name: 'Server One', historicalAt: null },
      ],
    } as unknown as ReturnType<typeof useServer>);
    mockList([], 0);

    renderUsers();
    await userEvent.click(screen.getByRole('button', { name: /filters/i }));
    await userEvent.click(screen.getByRole('combobox', { name: 'pages:users.filterHasAccessTo' }));

    expect(screen.getByText('common:serverSelector.historical')).toBeInTheDocument();
    const names = screen.getAllByRole('option').map((option) => option.textContent);
    expect(names).toEqual(['Server One', 'Old Plex']);
  });
});
