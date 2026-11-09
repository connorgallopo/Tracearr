import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Server, ServerUserWithIdentity, SettingsResponse } from '@tracearr/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    settings: { get: vi.fn(), update: vi.fn() },
    servers: { list: vi.fn(), update: vi.fn() },
    users: { list: vi.fn(), updateAccess: vi.fn() },
  },
  BASE_URL: '/',
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { api } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { MemberLogin } from './MemberLogin';

const REFUSAL = 'That would leave the owner with no way to sign in.';

const settings = {
  loginMethods: { local: true, plex: false, oidc: true, member: false },
  memberServerActivity: false,
  memberSsoOnly: false,
  oidcConfigured: true,
} as SettingsResponse;

function makeServer(overrides: Partial<Server>): Server {
  return {
    id: 's1',
    name: 'Home',
    type: 'jellyfin',
    url: 'http://home',
    color: '#4488ff',
    allowMemberLogin: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function owner(holds: { hasPassword?: boolean; hasPlexLinked?: boolean }) {
  vi.mocked(useAuth).mockReturnValue({ user: { role: 'owner', ...holds } } as never);
}

function person(overrides: Partial<ServerUserWithIdentity>): ServerUserWithIdentity {
  return {
    id: 'acc-1',
    userId: 'ident-1',
    serverId: 's1',
    username: 'dana',
    identityName: null,
    thumbUrl: null,
    role: 'member',
    loginAccess: 'allow',
    ...overrides,
  } as ServerUserWithIdentity;
}

function people(rows: ServerUserWithIdentity[]) {
  vi.mocked(api.users.list).mockImplementation((params) =>
    Promise.resolve({
      data: params?.signInOverride ? rows.filter((r) => r.loginAccess !== 'default') : rows,
    } as never)
  );
}

function renderPage() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <MemberLogin />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const switchFor = (name: string) => screen.findByRole('switch', { name });

describe('Sign-in settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.settings.get).mockResolvedValue(settings);
    vi.mocked(api.settings.update).mockResolvedValue(settings);
    owner({ hasPassword: true, hasPlexLinked: true });
    people([]);
    vi.mocked(api.servers.list).mockResolvedValue([
      makeServer({ id: 's1', name: 'Home' }),
      makeServer({ id: 's2', name: 'Den', type: 'emby', allowMemberLogin: true }),
      makeServer({ id: 's3', name: 'Old', historicalAt: '2026-01-01T00:00:00.000Z' }),
    ]);
  });

  it('sends only the switch that changed', async () => {
    renderPage();

    await userEvent.click(await switchFor('memberLogin.signIn.plex'));

    await waitFor(() =>
      expect(api.settings.update).toHaveBeenCalledWith({ loginMethods: { plex: true } })
    );
  });

  it('offers single sign-on only when OIDC is configured and saves it without waiting', async () => {
    const { unmount } = renderPage();
    await userEvent.click(await switchFor('memberLogin.signIn.ssoOnly'));
    expect(api.settings.update).toHaveBeenCalledWith({ memberSsoOnly: true });
    unmount();

    vi.mocked(api.settings.get).mockResolvedValue({ ...settings, oidcConfigured: false });
    renderPage();
    await switchFor('memberLogin.signIn.media');
    expect(screen.queryByRole('switch', { name: 'memberLogin.signIn.ssoOnly' })).toBeNull();
  });

  it('shows the refusal under the switch and snaps it back', async () => {
    vi.mocked(api.settings.update).mockRejectedValue(new Error(REFUSAL));
    renderPage();

    const oidc = await switchFor('memberLogin.signIn.oidc');
    expect(oidc).toBeChecked();
    await userEvent.click(oidc);

    expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'memberLogin.signIn.oidc' })).toBeChecked();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('lists live servers only, each with its own switch', async () => {
    renderPage();

    expect(await screen.findByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Den')).toBeInTheDocument();
    expect(screen.queryByText('Old')).toBeNull();
    expect(document.getElementById('allowMemberLogin-s2')).toBeChecked();
  });

  it('saves a server switch through the server update and stays quiet about it', async () => {
    vi.mocked(api.servers.update).mockResolvedValue(makeServer({}));
    renderPage();
    await screen.findByText('Home');

    await userEvent.click(document.getElementById('allowMemberLogin-s1') as HTMLElement);

    await waitFor(() =>
      expect(api.servers.update).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ allowMemberLogin: true })
      )
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('lists only the methods the owner holds', async () => {
    owner({ hasPassword: false, hasPlexLinked: true });
    renderPage();

    await switchFor('memberLogin.signIn.plex');
    expect(screen.queryByRole('switch', { name: 'memberLogin.signIn.local' })).toBeNull();
  });

  it('holds the last method still on instead of letting it be refused', async () => {
    owner({ hasPassword: false, hasPlexLinked: true });
    vi.mocked(api.settings.get).mockResolvedValue({
      ...settings,
      loginMethods: { ...settings.loginMethods, plex: true, oidc: false },
    });
    renderPage();

    const plex = await switchFor('memberLogin.signIn.plex');
    expect(plex).toBeChecked();
    expect(plex).toBeDisabled();
    expect(screen.getByText('memberLogin.signIn.onlyWay')).toBeInTheDocument();
    expect(await switchFor('memberLogin.signIn.oidc')).toBeEnabled();
  });

  it('offers single sign-on only when the deployment has it configured', async () => {
    vi.mocked(api.settings.get).mockResolvedValue({ ...settings, oidcConfigured: false });
    renderPage();

    await switchFor('memberLogin.signIn.plex');
    expect(screen.queryByRole('switch', { name: 'memberLogin.signIn.oidc' })).toBeNull();
  });

  it('lists the server rows under the admins and members switch', async () => {
    renderPage();

    const rows = (await screen.findByText('Home')).closest('.border-l');
    expect(rows).not.toBeNull();
    expect(within(rows as HTMLElement).getByText('Den')).toBeInTheDocument();
    expect(
      within(rows as HTMLElement).queryByRole('switch', { name: 'memberLogin.signIn.media' })
    ).toBeNull();
  });

  it('points to Connections when there are no servers', async () => {
    vi.mocked(api.servers.list).mockResolvedValue([]);
    renderPage();

    const note = await screen.findByText('memberLogin.noServers');
    expect(within(note).getByRole('link')).toHaveAttribute('href', '/settings/servers/connections');
  });

  describe('people set individually', () => {
    it('lists them with their access and role, and sends one person back to default', async () => {
      people([
        person({}),
        person({
          id: 'acc-2',
          userId: 'ident-2',
          username: 'sam',
          role: 'admin',
          loginAccess: 'block',
        }),
      ]);
      vi.mocked(api.users.updateAccess).mockResolvedValue({} as never);
      renderPage();

      expect(
        await screen.findAllByRole('combobox', { name: 'memberLogin.signIn.accessLabel' })
      ).toHaveLength(2);
      expect(
        screen.getAllByRole('combobox', { name: 'memberLogin.signIn.roleLabel' })
      ).toHaveLength(2);
      await waitFor(() =>
        expect(api.users.list).toHaveBeenCalledWith(
          expect.objectContaining({ signInOverride: true })
        )
      );

      await userEvent.click(
        screen.getByRole('button', { name: 'memberLogin.signIn.backToDefault: sam' })
      );

      await waitFor(() =>
        expect(api.users.updateAccess).toHaveBeenCalledWith('acc-2', { loginAccess: 'default' })
      );
    });

    it('changes a role from the row', async () => {
      people([person({})]);
      vi.mocked(api.users.updateAccess).mockResolvedValue({} as never);
      renderPage();

      await userEvent.click(
        await screen.findByRole('combobox', { name: 'memberLogin.signIn.roleLabel' })
      );
      await userEvent.click(
        await screen.findByRole('option', { name: 'memberLogin.signIn.admin' })
      );

      await waitFor(() =>
        expect(api.users.updateAccess).toHaveBeenCalledWith('acc-1', { role: 'admin' })
      );
    });

    it('adds someone not yet listed as Allow or Block', async () => {
      people([
        person({}),
        person({ id: 'acc-2', userId: 'ident-2', username: 'sam', loginAccess: 'default' }),
        person({
          id: 'acc-3',
          userId: 'ident-3',
          username: 'boss',
          role: 'owner',
          loginAccess: 'default',
        }),
      ]);
      vi.mocked(api.users.updateAccess).mockResolvedValue({} as never);
      renderPage();

      await userEvent.click(
        await screen.findByRole('combobox', { name: 'memberLogin.signIn.addPerson' })
      );
      expect(screen.queryByRole('option', { name: 'dana' })).toBeNull();
      expect(screen.queryByRole('option', { name: 'boss' })).toBeNull();
      await userEvent.click(await screen.findByRole('option', { name: 'sam' }));
      await userEvent.click(screen.getByRole('button', { name: 'memberLogin.signIn.block' }));

      await waitFor(() =>
        expect(api.users.updateAccess).toHaveBeenCalledWith('acc-2', { loginAccess: 'block' })
      );
    });
  });
});
