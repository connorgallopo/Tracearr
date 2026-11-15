import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  LatestImportStatus,
  ServerType,
  TofaImportProgress,
  TofaImportResult,
} from '@tracearr/shared';
import { api } from '@/lib/api';
import { AddServerDialog } from './AddServerDialog';
import type { AddServerForm } from './useAddServer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const servers = [
  { id: 'plex-1', name: 'Den', type: 'plex' },
  { id: 'plex-2', name: 'Loft', type: 'plex' },
  { id: 'jf-1', name: 'Attic', type: 'jellyfin' },
  { id: 'tofa-1', name: 'Shed', type: 'tofa' },
];

vi.mock('@/hooks/queries', () => ({
  usePlexAccounts: () => ({ data: { accounts: [], clientIdentifier: 'client-1' } }),
  useServers: () => ({ data: servers, isLoading: false }),
  useSettings: () => ({ data: {}, isLoading: false }),
  useUpdateSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useSocket', () => ({ useSocket: () => ({ socket: null }) }));

vi.mock('@/lib/api', () => {
  const importer = () => ({
    test: vi.fn(),
    start: vi.fn(),
    getActive: vi.fn().mockResolvedValue({ active: false, latest: null }),
  });
  return {
    api: {
      import: {
        tautulli: importer(),
        jellystat: importer(),
        playbackReporting: importer(),
        tofa: importer(),
      },
    },
  };
});

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
    busy: false,
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
    continueAdded: vi.fn(),
    ...overrides,
  };
}

function props(overrides: Partial<AddServerForm> = {}) {
  return { open: true, onOpenChange: vi.fn(), form: form(overrides) };
}

function renderImportStep(id: string, type: ServerType) {
  const dialog = { ...props(), added: { id, type } };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<AddServerDialog {...dialog} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    ),
  });
  return dialog;
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
    render(
      <AddServerDialog {...props({ serverType: 'tofa', addedWithoutStop: true, isOwner: false })} />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('servers.cannotStopStreams');
    expect(screen.getByLabelText('common:labels.apiKey')).not.toBeVisible();
    expect(screen.queryByRole('button', { name: 'servers.connectServer' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common:actions.close' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'common:actions.continue' })).toBeNull();
  });

  it('lets the owner go on from that notice to the import step', async () => {
    const continueAdded = vi.fn();
    render(
      <AddServerDialog {...props({ serverType: 'tofa', addedWithoutStop: true, continueAdded })} />
    );

    await userEvent.click(screen.getByRole('button', { name: 'common:actions.continue' }));
    expect(continueAdded).toHaveBeenCalled();
  });

  it('offers a Plex server Tautulli for that server alone, with focus on the step', () => {
    renderImportStep('plex-1', 'plex');

    expect(screen.getByRole('heading', { name: 'pages:setup.importTitle' })).toHaveFocus();
    expect(screen.getByLabelText('import.tautulliUrl')).toBeInTheDocument();
    expect(screen.queryByText('import.selectPlexServer')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByText('import.playbackReporting')).toBeNull();
  });

  it('offers a Jellyfin server Playback Reporting and Jellystat', () => {
    renderImportStep('jf-1', 'jellyfin');

    expect(screen.getByText('import.playbackReporting')).toBeInTheDocument();
    expect(screen.getByText('import.uploadJellystatBackup')).toBeInTheDocument();
    expect(screen.queryByLabelText('import.tautulliUrl')).toBeNull();
  });

  it('shows a tofa server its held import waiting on the library sync, and no second import', async () => {
    const waiting: LatestImportStatus<TofaImportProgress, TofaImportResult> = {
      state: 'waitingForLibrarySync',
      librarySync: { state: 'running', progress: 42 },
    };
    vi.mocked(api.import.tofa.getActive).mockResolvedValueOnce({
      active: true,
      jobId: 'held-import-tofa-1',
      latest: waiting,
    });
    renderImportStep('tofa-1', 'tofa');

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('import.waitingForLibrarySyncPercent')
    );
    expect(api.import.tofa.getActive).toHaveBeenCalledWith('tofa-1');
    expect(screen.queryByRole('button', { name: 'import.importing' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'import.importTofaHistory' })).toBeNull();
    expect(screen.getByRole('button', { name: 'common:actions.close' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'common:actions.skip' })).toBeNull();
  });

  it('skip closes the import step without starting anything', async () => {
    const dialog = renderImportStep('plex-1', 'plex');
    await waitFor(() => expect(api.import.tautulli.getActive).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: 'common:actions.skip' }));

    expect(dialog.onOpenChange).toHaveBeenCalledWith(false);
    for (const importer of Object.values(api.import)) {
      expect(importer.start).not.toHaveBeenCalled();
    }
  });

  it('offers a member every server type but Plex', async () => {
    render(<AddServerDialog {...props({ isOwner: false })} />);

    await userEvent.click(screen.getByRole('combobox', { name: 'servers.serverType' }));

    expect(screen.queryByRole('option', { name: 'Plex' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'tofa' })).toBeInTheDocument();
  });

  it('offers the owner a Plex account link when none is linked', () => {
    render(<AddServerDialog {...props({ serverType: 'plex', plexStep: 'no-accounts' })} />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
      ),
    });

    expect(screen.getByText('setup.linkPlexTitle')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'settings.plex.linkPlexAccount' })
    ).toBeInTheDocument();
  });

  it('stays open with cancel disabled while a server connects', async () => {
    const dialog = props({ isConnecting: true, busy: true });
    render(<AddServerDialog {...dialog} />);

    expect(screen.getByRole('button', { name: 'common:actions.cancel' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(dialog.onOpenChange).not.toHaveBeenCalled();
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
