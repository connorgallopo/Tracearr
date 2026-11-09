import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SetupStatus } from '@tracearr/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const auth = vi.hoisted(() => ({ isAuthenticated: false, isLoading: false }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));

const setup = vi.hoisted(() => ({ data: undefined as unknown, all: undefined as unknown }));
vi.mock('@/hooks/queries/useSetup', () => ({
  useSetupStatus: (all: boolean) => {
    setup.all = all;
    return { data: setup.data, isLoading: false };
  },
}));

const signInEmail = vi.hoisted(() => vi.fn());
vi.mock('@/lib/authClient', () => ({
  authClient: { signIn: { email: signInEmail, username: vi.fn() } },
}));
vi.mock('@/lib/api', () => ({ api: {}, BASE_URL: '/' }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/brand/Logo', () => ({ LogoIcon: () => null }));
vi.mock('@/components/auth/MemberLogin', () => ({
  MemberLogin: ({
    servers,
    onSignedIn,
  }: {
    servers: { name: string }[];
    onSignedIn: () => Promise<void>;
  }) => (
    <div>
      member form: {servers.map((s) => s.name).join(', ')}
      <button type="button" onClick={() => void onSignedIn()}>
        finish
      </button>
    </div>
  ),
}));

import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Login } from './Login';

const jellyfin = { id: 'jf', name: 'Jelly', type: 'jellyfin' as const, quickConnect: true };
const plexMember = { id: 'px', name: 'Plexy', type: 'plex' as const, quickConnect: false };

function status(
  methods: Partial<SetupStatus['authMethods']>,
  memberLoginServers: SetupStatus['memberLoginServers'] = []
): SetupStatus {
  return {
    needsSetup: false,
    requiresClaimCode: false,
    hasServers: true,
    hasJellyfinServers: true,
    hasPasswordAuth: true,
    authMethods: {
      local: false,
      plex: false,
      oidc: false,
      oidcProviderName: null,
      member: false,
      ssoOnly: false,
      ...methods,
    },
    memberLoginServers,
  };
}

function renderLogin(url = '/login', client = new QueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Login />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const plexButton = () => screen.queryByRole('button', { name: /settings:plex.signInWithPlex/ });

describe('Login blocks', () => {
  beforeEach(() => {
    auth.isAuthenticated = false;
    setup.data = undefined;
    vi.clearAllMocks();
  });

  it('puts the account form and the media server form behind tabs when both are on', async () => {
    setup.data = status({ local: true, member: true }, [jellyfin]);
    renderLogin();

    expect(screen.getByLabelText('pages:login.usernameOrEmail')).toBeInTheDocument();
    expect(screen.queryByText(/member form/)).toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: 'pages:login.member.tabMember' }));

    expect(screen.getByText('member form: Jelly')).toBeInTheDocument();
    expect(screen.queryByLabelText('pages:login.usernameOrEmail')).toBeNull();
  });

  it('shows the member form alone, without tabs or a divider, when it is the only method', () => {
    setup.data = status({ member: true }, [jellyfin]);
    renderLogin();

    expect(screen.getByText('member form: Jelly')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByText('common:or')).toBeNull();
    expect(screen.queryByText('pages:login.localDisabledHint')).toBeNull();
  });

  it('keeps Plex servers out of the media server form', () => {
    setup.data = status({ member: true }, [plexMember, jellyfin]);
    renderLogin();

    expect(screen.getByText('member form: Jelly')).toBeInTheDocument();
  });

  it('hides the Plex button unless the owner uses Plex or a member server is Plex', () => {
    setup.data = status({ local: true });
    const { unmount } = renderLogin();
    expect(plexButton()).toBeNull();
    unmount();

    setup.data = status({ local: true, member: true }, [plexMember]);
    renderLogin();
    expect(plexButton()).toBeInTheDocument();
  });

  it('draws the divider only when buttons sit above a form', () => {
    setup.data = status({ plex: true });
    const { unmount } = renderLogin();
    expect(screen.queryByText('common:or')).toBeNull();
    expect(screen.getByText('pages:login.localDisabledHint')).toBeInTheDocument();
    unmount();

    setup.data = status({ plex: true, local: true });
    renderLogin();
    expect(screen.getByText('common:or')).toBeInTheDocument();
  });

  it('shows only the SSO button while SSO-only hides the other methods', () => {
    setup.data = status({ oidc: true, oidcProviderName: 'Authentik', ssoOnly: true });
    renderLogin();

    expect(screen.getByRole('button', { name: /pages:login.continueWith/ })).toBeInTheDocument();
    expect(screen.queryByText('pages:login.localDisabledHint')).toBeNull();
    expect(screen.queryByLabelText('pages:login.usernameOrEmail')).toBeNull();
    expect(plexButton()).toBeNull();
  });

  it('drops what the previous person left in the cache when a sign-in finishes', async () => {
    setup.data = status({ member: true }, [jellyfin]);
    const client = new QueryClient();
    client.setQueryData(['stats', 'me', 'UTC'], { daysWatched: 9 });
    client.setQueryData(['auth', 'me'], { userId: 'u1' });
    renderLogin('/login', client);

    await userEvent.click(screen.getByRole('button', { name: 'finish' }));

    expect(client.getQueryData(['stats', 'me', 'UTC'])).toBeUndefined();
    expect(client.getQueryState(['auth', 'me'])).toBeDefined();
  });

  it('says a refused member sign-in plainly and any other callback error generically', () => {
    setup.data = status({ local: true, oidc: true });
    const { unmount } = renderLogin('/login?error=MEMBER_LOGIN_REFUSED');
    expect(screen.getByText('pages:login.member.refused')).toBeInTheDocument();
    unmount();

    renderLogin('/login?error=access_denied');
    expect(screen.getByText('pages:login.oidcError')).toBeInTheDocument();
  });

  it('polls Plex with the handle it was given and stops when the sign-in expired', async () => {
    setup.data = status({ plex: true });
    const checkPlexPin = vi.fn().mockResolvedValue({ authorized: false, expired: true });
    Object.assign(api, {
      auth: {
        initiatePlex: vi.fn().mockResolvedValue({ handle: 'h-1', authUrl: 'https://app.plex.tv' }),
        checkPlexPin,
      },
    });
    vi.spyOn(window, 'open').mockReturnValue(null);
    renderLogin();

    await userEvent.click(screen.getByRole('button', { name: /settings:plex.signInWithPlex/ }));

    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('pages:login.plexExpired'));
    expect(checkPlexPin).toHaveBeenCalledOnce();
    expect(checkPlexPin).toHaveBeenCalledWith({ handle: 'h-1' });
    expect(plexButton()).toBeInTheDocument();
  });

  it('asks for every server with ?all and lists what comes back', () => {
    setup.data = status({ member: true }, [jellyfin, { ...jellyfin, id: 'jf2', name: 'Shed' }]);
    const { unmount } = renderLogin('/login?all');
    expect(setup.all).toBe(true);
    expect(screen.getByText('member form: Jelly, Shed')).toBeInTheDocument();
    unmount();

    renderLogin('/login');
    expect(setup.all).toBe(false);
  });

  it('toasts not permitted from an OIDC redirect instead of showing it inline', () => {
    setup.data = status({ local: true, oidc: true });
    renderLogin('/login?error=MEMBER_NOT_PERMITTED');

    expect(toast.error).toHaveBeenCalledWith('pages:login.member.notPermitted', {
      id: 'MEMBER_NOT_PERMITTED',
    });
    expect(screen.queryByText('pages:login.member.notPermitted')).toBeNull();
    expect(screen.queryByText('pages:login.oidcError')).toBeNull();
  });

  it('toasts not permitted for a correct password the owner keeps out, and keeps other errors inline', async () => {
    setup.data = status({ local: true });
    signInEmail.mockResolvedValueOnce({
      error: { code: 'MEMBER_NOT_PERMITTED', message: 'server copy' },
    });
    renderLogin();

    await userEvent.type(screen.getByLabelText('pages:login.usernameOrEmail'), 'dana@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'pw');
    await userEvent.click(screen.getByRole('button', { name: /signIn/i }));

    expect(toast.error).toHaveBeenCalledWith('pages:login.member.notPermitted', {
      id: 'MEMBER_NOT_PERMITTED',
    });
    expect(screen.queryByText('server copy')).toBeNull();

    signInEmail.mockResolvedValueOnce({ error: { code: 'INVALID', message: 'Wrong password' } });
    await userEvent.click(screen.getByRole('button', { name: /signIn/i }));
    expect(await screen.findByText('Wrong password')).toBeInTheDocument();
  });

  it('returns a signed-in user to the page that sent them to login', () => {
    auth.isAuthenticated = true;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter
          initialEntries={[
            {
              pathname: '/login',
              state: { from: { pathname: '/settings', search: '?tab=1', hash: '' } },
            },
          ]}
        >
          <Routes>
            <Route path="login" element={<Login />} />
            <Route path="settings" element={<p>settings page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(screen.getByText('settings page')).toBeInTheDocument();
  });
});
