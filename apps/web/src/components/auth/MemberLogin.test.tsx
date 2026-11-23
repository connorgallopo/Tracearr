import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { name?: string }) => (vars?.name ? `${key}:${vars.name}` : key),
  }),
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/authClient', () => ({
  authClient: { $fetch: fetchMock },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/api', () => ({ ApiError: class extends Error {} }));

import { toast } from 'sonner';
import { MemberLogin, type MemberLoginServer } from './MemberLogin';

const jellyfin: MemberLoginServer = {
  id: 'jf-1',
  name: 'Home Jellyfin',
  type: 'jellyfin',
  codeSignIn: true,
  passwordSignIn: true,
};
const jellyfinNoQc: MemberLoginServer = { ...jellyfin, id: 'jf-2', codeSignIn: false };
const emby: MemberLoginServer = {
  id: 'em-1',
  name: 'Den Emby',
  type: 'emby',
  codeSignIn: false,
  passwordSignIn: true,
};
const silo: MemberLoginServer = {
  id: 'si-1',
  name: 'Vault',
  type: 'silo',
  codeSignIn: true,
  passwordSignIn: true,
};
const siloCode = {
  handle: 's1',
  code: '1234-5678',
  link: 'https://silo.example.com/activate?code=12345678',
  interval: 5,
};

const REFUSED = 'Sign-in is not available for this account.';

type Reply = { data?: unknown; error?: { status: number; message?: string; code?: string } };

function serve(routes: Record<string, Reply | (() => Reply)>) {
  fetchMock.mockImplementation((url: string) => {
    const reply = routes[url];
    const resolved = typeof reply === 'function' ? reply() : reply;
    return Promise.resolve({ data: null, error: null, ...resolved });
  });
}

function renderLogin(
  servers: MemberLoginServer[],
  onSignedIn = vi.fn().mockResolvedValue(undefined)
) {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <MemberLogin servers={servers} onSignedIn={onSignedIn} />
    </QueryClientProvider>
  );
  return { ...view, onSignedIn };
}

const calls = (url: string) => fetchMock.mock.calls.filter(([called]) => called === url);

describe('MemberLogin', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.mocked(toast.error).mockClear();
  });

  it('offers a server picker when there are two servers and none when there is one', async () => {
    serve({ '/jellyfin/quick-connect/initiate': { data: { handle: 'h1', code: '123456' } } });
    const { unmount } = renderLogin([jellyfin, emby]);

    expect(screen.getByRole('combobox', { name: 'pages:login.member.server' })).toBeInTheDocument();
    unmount();

    renderLogin([emby]);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('pages:login.member.signingInTo:Den Emby')).toBeInTheDocument();
  });

  it('shows the Quick Connect code once Jellyfin hands one out', async () => {
    serve({
      '/jellyfin/quick-connect/initiate': { data: { handle: 'h1', code: '123456' } },
      '/jellyfin/quick-connect/check': { data: { authorized: false } },
    });
    renderLogin([jellyfin]);

    expect(
      await screen.findByRole('button', { name: 'pages:login.member.copyCode' })
    ).toHaveTextContent('123456');
    expect(screen.getByText('pages:login.member.quickConnectHint')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/jellyfin/quick-connect/initiate', {
      method: 'POST',
      body: { serverId: 'jf-1' },
    });
    await waitFor(() => expect(calls('/jellyfin/quick-connect/check').length).toBeGreaterThan(0));
    expect(fetchMock).toHaveBeenCalledWith('/jellyfin/quick-connect/check', {
      method: 'POST',
      body: { handle: 'h1' },
    });
  });

  it('swaps an expired code for a retry that asks for a new one', async () => {
    serve({
      '/jellyfin/quick-connect/initiate': { data: { handle: 'h1', code: '123456' } },
      '/jellyfin/quick-connect/check': { data: { authorized: false, expired: true } },
    });
    renderLogin([jellyfin]);

    expect(await screen.findByText('pages:login.member.codeExpired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'pages:login.member.copyCode' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'pages:login.member.newCode' }));

    await waitFor(() => expect(calls('/jellyfin/quick-connect/initiate')).toHaveLength(2));
  });

  it('finishes the sign-in once the code is approved', async () => {
    serve({
      '/jellyfin/quick-connect/initiate': { data: { handle: 'h1', code: '123456' } },
      '/jellyfin/quick-connect/check': {
        data: { authorized: true, user: { id: 'u1', username: 'bob', role: 'member' } },
      },
    });
    const { onSignedIn } = renderLogin([jellyfin]);

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
  });

  it('falls through to the password form without a message when Quick Connect is off', async () => {
    serve({ '/jellyfin/quick-connect/initiate': { error: { status: 404, message: 'off' } } });
    renderLogin([jellyfin]);

    expect(await screen.findByLabelText('settings:account.password')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lets the member switch to a password and back', async () => {
    serve({
      '/jellyfin/quick-connect/initiate': { data: { handle: 'h1', code: '123456' } },
      '/jellyfin/quick-connect/check': { data: { authorized: false } },
    });
    renderLogin([jellyfin]);
    await screen.findByRole('button', { name: 'pages:login.member.copyCode' });

    await userEvent.click(screen.getByRole('button', { name: 'pages:login.member.usePassword' }));
    expect(screen.getByLabelText('settings:account.password')).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'pages:login.member.useQuickConnect' })
    );
    expect(
      await screen.findByRole('button', { name: 'pages:login.member.copyCode' })
    ).toBeInTheDocument();
    expect(calls('/jellyfin/quick-connect/initiate')).toHaveLength(2);
  });

  it('posts the password form to the Emby endpoint with the server id', async () => {
    serve({ '/emby/sign-in': { data: { authorized: true } } });
    const { onSignedIn } = renderLogin([emby]);

    await userEvent.type(screen.getByLabelText('pages:login.username'), ' dana ');
    await userEvent.type(screen.getByLabelText('settings:account.password'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.signIn' }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/emby/sign-in', {
      method: 'POST',
      body: { serverId: 'em-1', username: 'dana', password: 'hunter2' },
    });
  });

  it('posts to the Jellyfin endpoint when Quick Connect is not offered', async () => {
    serve({ '/jellyfin/sign-in': { data: { authorized: true } } });
    renderLogin([jellyfinNoQc]);

    await userEvent.type(screen.getByLabelText('pages:login.username'), 'dana');
    await userEvent.type(screen.getByLabelText('settings:account.password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.signIn' }));

    await waitFor(() => expect(calls('/jellyfin/sign-in')).toHaveLength(1));
    expect(calls('/jellyfin/quick-connect/initiate')).toHaveLength(0);
  });

  it('never starts Quick Connect for an Emby server', async () => {
    serve({});
    renderLogin([emby]);

    expect(screen.getByLabelText('settings:account.password')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'pages:login.member.usePassword' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the server sentence under the form and clears it on typing', async () => {
    serve({ '/emby/sign-in': { error: { status: 403, message: REFUSED } } });
    renderLogin([emby]);

    await userEvent.type(screen.getByLabelText('pages:login.username'), 'dana');
    await userEvent.type(screen.getByLabelText('settings:account.password'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.signIn' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(REFUSED);

    await userEvent.type(screen.getByLabelText('settings:account.password'), 'x');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a generic message, not the browser text, when the sign-in request never arrives', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderLogin([emby]);

    await userEvent.type(screen.getByLabelText('pages:login.username'), 'dana');
    await userEvent.type(screen.getByLabelText('settings:account.password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.signIn' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('errors.generic');
  });

  it('does the same when the Quick Connect request never arrives', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderLogin([jellyfin]);

    expect(await screen.findByRole('alert')).toHaveTextContent('errors.generic');
    expect(screen.getByLabelText('settings:account.password')).toBeInTheDocument();
  });

  it('toasts not permitted for a password the server accepted, with nothing inline', async () => {
    serve({
      '/emby/sign-in': {
        error: { status: 403, code: 'MEMBER_NOT_PERMITTED', message: 'server copy' },
      },
    });
    renderLogin([emby]);

    await userEvent.type(screen.getByLabelText('pages:login.username'), 'dana');
    await userEvent.type(screen.getByLabelText('settings:account.password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.signIn' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('pages:login.member.notPermitted', {
        id: 'MEMBER_NOT_PERMITTED',
      })
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('Silo', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows the code 4+4 with Open Silo and the password option, polling at the interval', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      serve({
        '/silo/code/initiate': { data: siloCode },
        '/silo/code/check': { data: { authorized: false } },
      });
      renderLogin([silo]);

      expect(
        await screen.findByRole('button', { name: 'pages:login.member.copyCode' })
      ).toHaveTextContent('1234 5678');
      expect(
        screen.getByRole('link', { name: 'settings:servers.pairing.openSilo' })
      ).toHaveAttribute('href', siloCode.link);
      expect(screen.getByText('settings:servers.pairing.enterAt')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'pages:login.member.usePassword' })
      ).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith('/silo/code/initiate', {
        method: 'POST',
        body: { serverId: 'si-1' },
      });

      await waitFor(() => expect(calls('/silo/code/check')).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(4000);
      expect(calls('/silo/code/check')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1500);
      expect(calls('/silo/code/check')).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledWith('/silo/code/check', {
        method: 'POST',
        body: { handle: 's1' },
      });
    });

    it('goes back from the password form with Use a code instead', async () => {
      serve({
        '/silo/code/initiate': { data: siloCode },
        '/silo/code/check': { data: { authorized: false } },
      });
      renderLogin([silo]);
      await screen.findByRole('button', { name: 'pages:login.member.copyCode' });

      await userEvent.click(screen.getByRole('button', { name: 'pages:login.member.usePassword' }));
      await userEvent.click(
        screen.getByRole('button', { name: 'settings:servers.pairing.useCode' })
      );

      expect(
        await screen.findByRole('button', { name: 'pages:login.member.copyCode' })
      ).toBeInTheDocument();
      expect(calls('/silo/code/initiate')).toHaveLength(2);
    });

    it('shows the password form alone when the code request fails to start', async () => {
      serve({ '/silo/code/initiate': { error: { status: 404, message: 'off' } } });
      renderLogin([silo]);

      expect(await screen.findByLabelText('settings:account.password')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'pages:login.member.copyCode' })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows only the password form when Silo offers no code sign-in', async () => {
      serve({ '/silo/sign-in': { data: { authorized: true } } });
      const { onSignedIn } = renderLogin([{ ...silo, codeSignIn: false }]);

      await userEvent.type(screen.getByLabelText('pages:login.username'), 'dana');
      await userEvent.type(screen.getByLabelText('settings:account.password'), 'pw');
      await userEvent.click(screen.getByRole('button', { name: 'common:actions.signIn' }));

      await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
      expect(fetchMock).toHaveBeenCalledWith('/silo/sign-in', {
        method: 'POST',
        body: { serverId: 'si-1', username: 'dana', password: 'pw' },
      });
      expect(calls('/silo/code/initiate')).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'settings:servers.pairing.useCode' })).toBeNull();
    });

    it('offers no password when Silo reports password sign-in off', async () => {
      serve({
        '/silo/code/initiate': { data: siloCode },
        '/silo/code/check': { data: { authorized: false } },
      });
      renderLogin([{ ...silo, passwordSignIn: false }]);

      await screen.findByRole('button', { name: 'pages:login.member.copyCode' });
      expect(screen.queryByRole('button', { name: 'pages:login.member.usePassword' })).toBeNull();
      expect(screen.queryByLabelText('settings:account.password')).toBeNull();
    });

    it('offers a new code, not a password form, when the code fails and passwords are off', async () => {
      serve({ '/silo/code/initiate': { error: { status: 500, message: 'Sign-in failed.' } } });
      renderLogin([{ ...silo, passwordSignIn: false }]);

      expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in failed.');
      expect(screen.getByText('pages:login.member.signInUnavailable')).toBeInTheDocument();
      expect(screen.queryByLabelText('settings:account.password')).toBeNull();
      await userEvent.click(
        screen.getByRole('button', { name: 'settings:servers.pairing.newCode' })
      );
      await waitFor(() => expect(calls('/silo/code/initiate')).toHaveLength(2));
    });

    it('says sign-in is unavailable when code sign-in is off and passwords are off', async () => {
      serve({ '/silo/code/initiate': { error: { status: 404, message: 'off' } } });
      renderLogin([{ ...silo, passwordSignIn: false }]);

      expect(await screen.findByText('pages:login.member.signInUnavailable')).toBeInTheDocument();
      expect(screen.queryByLabelText('settings:account.password')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('says sign-in is unavailable when the server offers neither a code nor a password', () => {
      serve({});
      renderLogin([{ ...silo, codeSignIn: false, passwordSignIn: false }]);

      expect(screen.getByText('pages:login.member.signInUnavailable')).toBeInTheDocument();
      expect(screen.queryByLabelText('settings:account.password')).toBeNull();
      expect(screen.queryByRole('button', { name: 'settings:servers.pairing.newCode' })).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('finishes the sign-in once the code is approved', async () => {
      serve({
        '/silo/code/initiate': { data: siloCode },
        '/silo/code/check': {
          data: { authorized: true, user: { id: 'u1', username: 'bob', role: 'member' } },
        },
      });
      const { onSignedIn } = renderLogin([silo]);

      await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    });
  });

  it('toasts not permitted once Quick Connect is approved, then offers the password form', async () => {
    serve({
      '/jellyfin/quick-connect/initiate': { data: { handle: 'h1', code: '123456' } },
      '/jellyfin/quick-connect/check': {
        error: { status: 403, code: 'MEMBER_NOT_PERMITTED', message: 'server copy' },
      },
    });
    renderLogin([jellyfin]);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('pages:login.member.notPermitted', {
        id: 'MEMBER_NOT_PERMITTED',
      })
    );
    expect(await screen.findByLabelText('settings:account.password')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
