import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddServerDialog } from './AddServerDialog';
import type { AddServerForm } from './useAddServer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/auth/PlexServerSelector', () => ({
  PlexServerSelector: () => <div>plex server selector</div>,
}));

const attic = { id: 'srv-1', name: 'Attic', online: true, localAddress: 'http://10.0.0.5:33333' };

function tofaSignIn(overrides: Partial<AddServerForm['tofa']> = {}): AddServerForm['tofa'] {
  return {
    step: 'idle',
    verificationUri: null,
    userCode: null,
    expiresAt: null,
    username: null,
    servers: [],
    connectingTo: null,
    unreachable: null,
    error: null,
    start: vi.fn(),
    cancel: vi.fn(),
    connect: vi.fn(),
    ...overrides,
  };
}

function form(overrides: Partial<AddServerForm> = {}): AddServerForm {
  return {
    isOwner: true,
    serverType: 'jellyfin',
    changeServerType: vi.fn(),
    serverUrl: '',
    setServerUrl: vi.fn(),
    publicUrl: '',
    setPublicUrl: vi.fn(),
    serverName: '',
    setServerName: vi.fn(),
    apiKey: '',
    setApiKey: vi.fn(),
    isConnecting: false,
    connectError: null,
    connect: vi.fn(),
    addedWithoutStop: false,
    keyFields: true,
    enterKeyFields: vi.fn(),
    tofa: tofaSignIn(),
    plexStep: 'loading',
    plexAccounts: [],
    selectedPlexAccountId: null,
    selectPlexAccount: vi.fn(),
    plexServers: [],
    connectingPlexServer: null,
    selectPlexServer: vi.fn(),
    testPlexUrl: vi.fn(),
    loadPlexAccounts: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  };
}

function props(overrides: Partial<AddServerForm> = {}) {
  return { open: true, onOpenChange: vi.fn(), form: form(overrides) };
}

describe('AddServerDialog', () => {
  it('labels the four Jellyfin fields and reports what was typed', async () => {
    const setServerUrl = vi.fn();
    const setPublicUrl = vi.fn();
    render(<AddServerDialog {...props({ setServerUrl, setPublicUrl })} />);

    expect(screen.getByLabelText('servers.serverUrl')).toBeInTheDocument();
    expect(screen.getByLabelText('servers.publicUrl')).toBeInTheDocument();
    expect(screen.getByLabelText('servers.serverName')).toBeInTheDocument();
    expect(screen.getByLabelText('common:labels.apiKey')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('servers.serverUrl'), 'h');
    expect(setServerUrl).toHaveBeenCalledWith('h');
    await userEvent.type(screen.getByLabelText('servers.publicUrl'), 'j');
    expect(setPublicUrl).toHaveBeenCalledWith('j');
  });

  it('surfaces a connect failure as an alert', () => {
    render(<AddServerDialog {...props({ connectError: 'Connection refused' })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Connection refused');
  });

  it('offers connect for Jellyfin and not for Plex', () => {
    const { rerender } = render(<AddServerDialog {...props()} />);
    expect(screen.getByRole('button', { name: 'servers.connectServer' })).toBeInTheDocument();

    rerender(
      <AddServerDialog {...props({ serverType: 'plex', plexStep: 'select', keyFields: false })} />
    );
    expect(screen.queryByRole('button', { name: 'servers.connectServer' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('servers.publicUrl')).not.toBeInTheDocument();
  });

  it('add server connects tofa through sign-in', async () => {
    const start = vi.fn();
    const enterKeyFields = vi.fn();
    const { rerender } = render(
      <AddServerDialog
        {...props({
          serverType: 'tofa',
          keyFields: false,
          enterKeyFields,
          tofa: tofaSignIn({ start }),
        })}
      />
    );

    expect(screen.queryByLabelText('common:labels.apiKey')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'servers.connectServer' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'pages:tofa.signIn' }));
    expect(start).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'pages:tofa.manual' }));
    expect(enterKeyFields).toHaveBeenCalled();

    const connect = vi.fn();
    rerender(
      <AddServerDialog
        {...props({
          serverType: 'tofa',
          keyFields: false,
          tofa: tofaSignIn({ step: 'select-server', username: 'dana', servers: [attic], connect }),
        })}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.connect' }));
    expect(connect).toHaveBeenCalledWith('srv-1', undefined);
  });

  it('offers check again and the manual fields when the tofa account owns no servers', async () => {
    const start = vi.fn();
    const enterKeyFields = vi.fn();
    render(
      <AddServerDialog
        {...props({
          serverType: 'tofa',
          keyFields: false,
          enterKeyFields,
          tofa: tofaSignIn({ step: 'no-servers', username: 'dana', start }),
        })}
      />
    );

    expect(screen.getByText('pages:tofa.noServersTitle')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'pages:setup.checkAgain' }));
    expect(start).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'pages:tofa.manual' }));
    expect(enterKeyFields).toHaveBeenCalled();
  });

  it('asks tofa for its URL and an API key, with where to make one, and for no public address', () => {
    render(<AddServerDialog {...props({ serverType: 'tofa' })} />);

    expect(screen.getByLabelText('servers.serverUrl')).toBeInTheDocument();
    expect(screen.getByLabelText('common:labels.apiKey')).toBeInTheDocument();
    expect(screen.getByText('servers.apiKeyHelpTofa')).toBeInTheDocument();
    expect(screen.queryByLabelText('servers.publicUrl')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'servers.connectServer' })).toBeInTheDocument();
  });

  it('says a connected key cannot stop streams and offers only to close', () => {
    render(<AddServerDialog {...props({ serverType: 'tofa', addedWithoutStop: true })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('servers.cannotStopStreams');
    expect(screen.getByLabelText('common:labels.apiKey')).not.toBeVisible();
    expect(screen.queryByRole('button', { name: 'servers.connectServer' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common:actions.close' })).toBeInTheDocument();
  });

  it('offers a member every server type but Plex', async () => {
    render(<AddServerDialog {...props({ isOwner: false })} />);

    await userEvent.click(screen.getByRole('combobox', { name: 'servers.serverType' }));

    expect(screen.queryByRole('option', { name: 'Plex' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'tofa' })).toBeInTheDocument();
  });

  it('tells the owner when no Plex account is linked', () => {
    render(<AddServerDialog {...props({ serverType: 'plex', plexStep: 'no-accounts' })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('servers.noPlexAccountsLinked');
  });

  it('shows one account picker when several Plex accounts are linked', async () => {
    const selectPlexAccount = vi.fn();
    render(
      <AddServerDialog
        {...props({
          serverType: 'plex',
          plexStep: 'select',
          selectedPlexAccountId: 'a',
          selectPlexAccount,
          plexAccounts: [
            { id: 'a', plexUsername: 'alice', plexEmail: null },
            { id: 'b', plexUsername: 'bob', plexEmail: null },
          ],
        })}
      />
    );

    await userEvent.click(screen.getByRole('combobox', { name: 'servers.plexAccount' }));
    await userEvent.click(screen.getByRole('option', { name: 'bob' }));

    expect(selectPlexAccount).toHaveBeenCalledWith('b');
  });
});
