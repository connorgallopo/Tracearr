import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

const auth = vi.hoisted(() => ({
  user: { role: 'owner', username: 'dana' } as { role: string; username?: string } | null,
}));
const servers = vi.hoisted(() => ({
  data: [] as { type: string; name: string }[],
  refetch: vi.fn(),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ ...auth, refetch: vi.fn() }) }));
vi.mock('@/hooks/queries', () => ({
  useServers: () => ({ data: servers.data, refetch: servers.refetch }),
  usePlexAccounts: () => ({ data: { accounts: [], clientIdentifier: 'client-1' } }),
}));

const apiAuth = vi.hoisted(() => ({
  connectJellyfinWithApiKey: vi.fn(),
  getPlexAccounts: vi.fn(),
  initiateTofa: vi.fn(),
  checkTofa: vi.fn(),
  addTofaServer: vi.fn(),
}));
const { connectJellyfinWithApiKey, getPlexAccounts } = apiAuth;
vi.mock('@/lib/api', () => ({ api: { auth: apiAuth } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/brand/Logo', () => ({ LogoIcon: () => null }));
vi.mock('@/components/settings/data/Import', () => ({
  ImportSources: ({ serverType, onStarted }: { serverType: string; onStarted: () => void }) => (
    <button onClick={onStarted}>importers for {serverType}</button>
  ),
}));

import { Setup } from './Setup';

function Dashboard() {
  return <p>dashboard{useLocation().search}</p>;
}

function renderSetup(url: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/setup" element={<Setup />} />
          <Route path="/" element={<Dashboard />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = { role: 'owner', username: 'dana' };
    servers.data = [];
  });

  it('sends anyone but the owner to the dashboard', () => {
    auth.user = { role: 'admin' };
    renderSetup('/setup?type=jellyfin');

    expect(screen.getByText('dashboard')).toBeInTheDocument();
  });

  it('connects the server type picked before sign-up, then offers its history import', async () => {
    connectJellyfinWithApiKey.mockResolvedValue({});
    renderSetup('/setup?type=jellyfin');

    await userEvent.type(screen.getByLabelText('servers.serverUrl'), 'http://10.0.0.5:8096');
    await userEvent.type(screen.getByLabelText('servers.serverName'), 'Attic');
    await userEvent.type(screen.getByLabelText('common:labels.apiKey'), 'key-1');
    await userEvent.click(screen.getByRole('button', { name: 'servers.connectServer' }));

    expect(connectJellyfinWithApiKey).toHaveBeenCalledWith({
      serverUrl: 'http://10.0.0.5:8096',
      serverName: 'Attic',
      apiKey: 'key-1',
    });
    expect(await screen.findByText('importers for jellyfin')).toBeInTheDocument();
  });

  it('a password owner connects tofa through sign-in', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    apiAuth.initiateTofa.mockResolvedValue({
      handle: 'h-1',
      verificationUri: 'https://app.tofa.tv/link?code=ABCD',
      userCode: 'ABCD',
      expiresIn: 600,
      interval: 0,
    });
    apiAuth.checkTofa.mockResolvedValue({
      status: 'select-server',
      tempToken: 'temp-1',
      username: 'dana',
      servers: [{ id: 'srv-1', name: 'Attic', online: true, localAddress: null }],
    });
    apiAuth.addTofaServer.mockResolvedValue({
      status: 'added',
      server: { name: 'Attic', canStopStreams: true },
      canStopStreams: true,
    });
    renderSetup('/setup?type=tofa');

    expect(screen.queryByLabelText('common:labels.apiKey')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'pages:tofa.signIn' }));
    expect(await screen.findByText('pages:setup.pickerTitle')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.connect' }));

    expect(apiAuth.initiateTofa).toHaveBeenCalledWith('add-server');
    expect(apiAuth.addTofaServer).toHaveBeenCalledWith({ tempToken: 'temp-1', serverId: 'srv-1' });
    expect(await screen.findByText('importers for tofa')).toBeInTheDocument();
  });

  it('the rail has no buttons and back and skip wait while a tofa server connects', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    apiAuth.initiateTofa.mockResolvedValue({
      handle: 'h-1',
      verificationUri: 'https://app.tofa.tv/link?code=ABCD',
      userCode: 'ABCD',
      expiresIn: 600,
      interval: 0,
    });
    apiAuth.checkTofa.mockResolvedValue({
      status: 'select-server',
      tempToken: 'temp-1',
      username: 'dana',
      servers: [{ id: 'srv-1', name: 'Attic', online: true, localAddress: null }],
    });
    apiAuth.addTofaServer.mockReturnValue(new Promise(() => {}));
    renderSetup('/setup?type=tofa');
    await userEvent.click(screen.getByRole('button', { name: 'pages:tofa.signIn' }));
    await userEvent.click(await screen.findByRole('button', { name: 'common:actions.connect' }));

    const rail = screen.getByRole('navigation', { name: 'setup.stepsLabel' });
    expect(within(rail).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'common:actions.back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'common:actions.skip' })).toBeDisabled();
  });

  it('back, skip and the rail wait while a Jellyfin key connects', async () => {
    connectJellyfinWithApiKey.mockReturnValue(new Promise(() => {}));
    renderSetup('/setup?type=jellyfin');

    await userEvent.type(screen.getByLabelText('servers.serverUrl'), 'http://10.0.0.5:8096');
    await userEvent.type(screen.getByLabelText('servers.serverName'), 'Attic');
    await userEvent.type(screen.getByLabelText('common:labels.apiKey'), 'key-1');
    await userEvent.click(screen.getByRole('button', { name: 'servers.connectServer' }));

    const rail = screen.getByRole('navigation', { name: 'setup.stepsLabel' });
    expect(within(rail).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'common:actions.back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'common:actions.skip' })).toBeDisabled();
  });

  it('skip waits until a tofa server added through sign-in has been refetched', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    apiAuth.initiateTofa.mockResolvedValue({
      handle: 'h-1',
      verificationUri: 'https://app.tofa.tv/link?code=ABCD',
      userCode: 'ABCD',
      expiresIn: 600,
      interval: 0,
    });
    apiAuth.checkTofa.mockResolvedValue({
      status: 'select-server',
      tempToken: 'temp-1',
      username: 'dana',
      servers: [{ id: 'srv-1', name: 'Attic', online: true, localAddress: null }],
    });
    apiAuth.addTofaServer.mockResolvedValue({
      status: 'added',
      server: { name: 'Attic', canStopStreams: true },
      canStopStreams: true,
    });
    let finishRefetch = () => {};
    servers.refetch.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishRefetch = resolve;
      })
    );
    renderSetup('/setup?type=tofa');
    await userEvent.click(screen.getByRole('button', { name: 'pages:tofa.signIn' }));
    await userEvent.click(await screen.findByRole('button', { name: 'common:actions.connect' }));

    await waitFor(() => expect(servers.refetch).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'common:actions.skip' })).toBeDisabled();

    finishRefetch();
    expect(await screen.findByText('importers for tofa')).toBeInTheDocument();
  });

  it('the manual fields stay one click away', async () => {
    renderSetup('/setup?type=tofa');
    await userEvent.click(screen.getByRole('button', { name: 'pages:tofa.manual' }));

    expect(screen.getByLabelText('servers.serverUrl')).toBeInTheDocument();
    expect(screen.getByLabelText('common:labels.apiKey')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'servers.connectServer' })).toBeInTheDocument();
  });

  it('asks a Plex owner with no linked account to link one', async () => {
    getPlexAccounts.mockResolvedValue({ accounts: [] });
    renderSetup('/setup?type=plex');

    expect(await screen.findByText('setup.linkPlexTitle')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'settings.plex.linkPlexAccount' })
    ).toBeInTheDocument();
  });

  it('skip on step 3 goes to the dashboard', async () => {
    renderSetup('/setup?type=emby');
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.skip' }));

    expect(screen.getByText('dashboard')).toBeInTheDocument();
  });

  it('leaves for the dashboard from the history step without importing', async () => {
    renderSetup('/setup?type=jellyfin&step=import');

    expect(screen.getByText('importers for jellyfin')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.skip' }));
    expect(screen.getByText('dashboard')).toBeInTheDocument();
  });

  it('offers the dashboard, not skip, once an import has started', async () => {
    renderSetup('/setup?type=tofa&step=import');
    await userEvent.click(screen.getByText('importers for tofa'));

    expect(screen.queryByRole('button', { name: 'common:actions.skip' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'pages:setup.goToDashboard' }));
    expect(screen.getByText('dashboard')).toBeInTheDocument();
  });

  it('step 3 back changes the server type and keeps the account', async () => {
    renderSetup('/setup?type=jellyfin');
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.back' }));

    expect(screen.getByRole('radio', { name: 'Jellyfin' })).toBeChecked();
    expect(screen.queryByLabelText('settings:account.displayName')).toBeNull();
    const rail = screen.getByRole('navigation', { name: 'setup.stepsLabel' });
    const account = within(rail).getAllByRole('listitem')[1]!;
    expect(account).toHaveTextContent('setup.signedInAs');
    expect(within(account).queryByRole('button')).toBeNull();

    await userEvent.click(screen.getByRole('radio', { name: 'Emby' }));
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.continue' }));

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('pages:setup.connectTitle');
    expect(screen.getByLabelText('servers.serverUrl')).toBeInTheDocument();
  });

  it('no back once a server is connected', () => {
    servers.data = [{ type: 'jellyfin', name: 'Attic' }];
    renderSetup('/setup?type=jellyfin');

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'pages:setup.connectedTitle'
    );
    expect(screen.queryByRole('button', { name: 'common:actions.back' })).toBeNull();
    const rail = screen.getByRole('navigation', { name: 'setup.stepsLabel' });
    expect(within(rail).queryAllByRole('button')).toHaveLength(0);
  });

  it('step 4 back shows the server as connected', async () => {
    servers.data = [{ type: 'jellyfin', name: 'Attic' }];
    renderSetup('/setup?type=jellyfin&step=import');
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.back' }));

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'pages:setup.connectedTitle'
    );
    expect(screen.queryByText('importers for jellyfin')).toBeNull();
  });
});
