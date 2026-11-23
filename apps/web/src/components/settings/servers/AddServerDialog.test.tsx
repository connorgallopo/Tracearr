import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  LatestImportStatus,
  ServerHistoryImportProgress,
  ServerHistoryImportResult,
  ServerType,
} from '@tracearr/shared';
import { resources } from '@tracearr/translations';
import { api } from '@/lib/api';
import { AddServerDialog } from './AddServerDialog';
import { useAddServer, type AddServerForm } from './useAddServer';

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
  useServers: () => ({ data: servers, isLoading: false, refetch: vi.fn() }),
  useSettings: () => ({ data: {}, isLoading: false }),
  useUpdateSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useSocket', () => ({ useSocket: () => ({ socket: null }) }));

const $fetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/authClient', () => ({ authClient: { $fetch } }));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { role: 'owner' }, refetch: vi.fn() }),
}));

vi.mock('@/lib/api', () => {
  const importer = () => ({
    test: vi.fn(),
    start: vi.fn(),
    getActive: vi.fn().mockResolvedValue({ active: false, latest: null }),
  });
  return {
    api: {
      servers: { create: vi.fn() },
      import: {
        tautulli: importer(),
        jellystat: importer(),
        playbackReporting: importer(),
        serverHistory: importer(),
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

function siloPairing(overrides: Partial<AddServerForm['silo']> = {}): AddServerForm['silo'] {
  return {
    start: vi.fn(),
    starting: false,
    pairing: null,
    check: null,
    submitPin: vi.fn(),
    submittingPin: false,
    cancel: vi.fn(),
    error: null,
    reset: vi.fn(),
    ...overrides,
  };
}

const siloCode = {
  handle: 'h'.repeat(43),
  userCode: '1234-5678',
  link: 'https://silo.example.com/activate?code=12345678',
  expiresIn: 600,
  interval: 1,
};

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
    leaveKeyFields: vi.fn(),
    startPairing: vi.fn(),
    tofa: tofaSignIn(),
    silo: siloPairing(),
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

function AddServerFromList({ onAdded }: { onAdded: (server: { id: string }) => void }) {
  const form = useAddServer({ onAdded });
  return <AddServerDialog open onOpenChange={vi.fn()} form={form} />;
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

  it('asks Silo for its address, public address, name and an API key with the scopes it needs', () => {
    render(<AddServerDialog {...props({ serverType: 'silo' })} />);

    expect(screen.getByLabelText('servers.serverUrl')).toHaveAttribute(
      'placeholder',
      'servers.serverUrlPlaceholderSilo'
    );
    expect(screen.getByLabelText('servers.publicUrl')).toBeInTheDocument();
    expect(screen.getByLabelText('servers.serverName')).toBeInTheDocument();
    expect(screen.getByLabelText('common:labels.apiKey')).toBeInTheDocument();
    expect(screen.getByText('servers.apiKeyHelpSilo')).toBeInTheDocument();

    const english = resources.en.settings.servers;
    expect(english.serverUrlPlaceholderSilo).toBe('http://192.168.1.100:8090');
    for (const scope of ['admin:monitor:read', 'admin:sessions:control', 'libraries:read']) {
      expect(english.apiKeyHelpSilo).toContain(scope);
    }
  });

  it('adds a Silo server through the server type list with the pasted key', async () => {
    vi.mocked(api.servers.create).mockResolvedValueOnce({ id: 'silo-1', type: 'silo' } as never);
    const onAdded = vi.fn();
    render(<AddServerFromList onAdded={onAdded} />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
      ),
    });

    await userEvent.click(screen.getByRole('combobox', { name: 'servers.serverType' }));
    await userEvent.click(screen.getByRole('option', { name: 'Silo' }));
    await userEvent.click(screen.getByRole('button', { name: 'servers.pairing.useApiKey' }));
    await userEvent.type(screen.getByLabelText('servers.serverUrl'), 'http://192.168.1.30:8090');
    await userEvent.type(screen.getByLabelText('servers.serverName'), 'Basement');
    await userEvent.type(screen.getByLabelText('common:labels.apiKey'), 'silo-key');
    await userEvent.click(screen.getByRole('button', { name: 'servers.connectServer' }));

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ id: 'silo-1', type: 'silo' }));
    expect(api.servers.create).toHaveBeenCalledWith({
      name: 'Basement',
      type: 'silo',
      url: 'http://192.168.1.30:8090',
      token: 'silo-key',
    });
  });

  it('asks Silo for its address and name, then offers a code instead of a key field', async () => {
    const startPairing = vi.fn();
    render(<AddServerDialog {...props({ serverType: 'silo', keyFields: false, startPairing })} />);

    expect(screen.getByLabelText('servers.serverUrl')).toBeInTheDocument();
    expect(screen.getByLabelText('servers.publicUrl')).toBeInTheDocument();
    expect(screen.getByLabelText('servers.serverName')).toBeInTheDocument();
    expect(screen.queryByLabelText('common:labels.apiKey')).toBeNull();
    expect(screen.queryByRole('button', { name: 'servers.connectServer' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'servers.pairing.getCode' }));
    expect(startPairing).toHaveBeenCalled();
  });

  it('shows the code in place of the button while Silo waits for approval', () => {
    render(
      <AddServerDialog
        {...props({
          serverType: 'silo',
          keyFields: false,
          silo: siloPairing({ pairing: siloCode, check: { status: 'pending', opened: false } }),
        })}
      />
    );

    expect(screen.getByText('1234 5678')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'servers.pairing.getCode' })).toBeNull();
    expect(screen.getByRole('button', { name: 'servers.pairing.useApiKey' })).toBeInTheDocument();
  });

  it('switches Silo between the code and a pasted key', async () => {
    render(<AddServerFromList onAdded={vi.fn()} />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
      ),
    });

    await userEvent.click(screen.getByRole('combobox', { name: 'servers.serverType' }));
    await userEvent.click(screen.getByRole('option', { name: 'Silo' }));
    expect(screen.queryByLabelText('common:labels.apiKey')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'servers.pairing.useApiKey' }));
    expect(screen.getByLabelText('common:labels.apiKey')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'servers.pairing.getCode' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'servers.pairing.useCode' }));
    expect(screen.queryByLabelText('common:labels.apiKey')).toBeNull();
    expect(screen.getByRole('button', { name: 'servers.pairing.getCode' })).toBeInTheDocument();
  });

  it('asks for an admin when a Silo member approved the code', async () => {
    const startPairing = vi.fn();
    render(
      <AddServerDialog
        {...props({
          serverType: 'silo',
          keyFields: false,
          startPairing,
          silo: siloPairing({ pairing: siloCode, check: { status: 'not-admin' } }),
        })}
      />
    );

    expect(screen.getByText('servers.pairing.notAdmin')).toBeInTheDocument();
    expect(screen.queryByText('1234 5678')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'servers.pairing.newCode' }));
    expect(startPairing).toHaveBeenCalled();
  });

  it('asks for the Silo profile PIN and sends it', async () => {
    const submitPin = vi.fn();
    const { rerender } = render(
      <AddServerDialog
        {...props({
          serverType: 'silo',
          keyFields: false,
          silo: siloPairing({
            pairing: siloCode,
            check: { status: 'needs-pin', wrongPin: false },
            submitPin,
          }),
        })}
      />
    );

    expect(screen.getByText('servers.pairing.pinNeeded')).toBeInTheDocument();
    expect(screen.queryByText('servers.pairing.wrongPin')).toBeNull();
    await userEvent.type(screen.getByLabelText('servers.pairing.pinLabel'), '1234');
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.continue' }));
    expect(submitPin).toHaveBeenCalledWith('1234');

    rerender(
      <AddServerDialog
        {...props({
          serverType: 'silo',
          keyFields: false,
          silo: siloPairing({ pairing: siloCode, check: { status: 'needs-pin', wrongPin: true } }),
        })}
      />
    );
    expect(screen.getByText('servers.pairing.wrongPin')).toBeInTheDocument();
  });

  it('says Silo locked the profile and offers a new code', () => {
    render(
      <AddServerDialog
        {...props({
          serverType: 'silo',
          keyFields: false,
          silo: siloPairing({ pairing: siloCode, check: { status: 'pin-locked' } }),
        })}
      />
    );

    expect(screen.getByText('servers.pairing.pinLocked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'servers.pairing.newCode' })).toBeInTheDocument();
  });

  it('adds a Silo server by code the way a key add does, warning first when it cannot stop streams', async () => {
    const silo = { id: 'silo-1', type: 'silo', name: 'Basement', canStopStreams: false };
    $fetch.mockImplementation((url: string) =>
      Promise.resolve({
        data:
          url === '/silo/pair/start'
            ? siloCode
            : { status: 'added', server: silo, canStopStreams: false },
        error: null,
      })
    );
    const onAdded = vi.fn();
    render(<AddServerFromList onAdded={onAdded} />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
      ),
    });

    await userEvent.click(screen.getByRole('combobox', { name: 'servers.serverType' }));
    await userEvent.click(screen.getByRole('option', { name: 'Silo' }));
    await userEvent.type(screen.getByLabelText('servers.serverUrl'), 'http://192.168.1.30:8090');
    await userEvent.type(screen.getByLabelText('servers.serverName'), 'Basement');
    await userEvent.click(screen.getByRole('button', { name: 'servers.pairing.getCode' }));

    expect(await screen.findByText('servers.cannotStopStreams')).toBeInTheDocument();
    expect($fetch).toHaveBeenCalledWith('/silo/pair/start', {
      method: 'POST',
      body: { purpose: 'add-server', url: 'http://192.168.1.30:8090', name: 'Basement' },
    });
    expect(onAdded).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.continue' }));
    expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ id: 'silo-1', type: 'silo' }));
    expect($fetch).not.toHaveBeenCalledWith('/silo/pair/cancel', expect.anything());
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
    const waiting: LatestImportStatus<ServerHistoryImportProgress, ServerHistoryImportResult> = {
      state: 'waitingForLibrarySync',
      librarySync: { state: 'running', progress: 42 },
    };
    vi.mocked(api.import.serverHistory.getActive).mockResolvedValueOnce({
      active: true,
      jobId: 'held-import-tofa-1',
      latest: waiting,
    });
    renderImportStep('tofa-1', 'tofa');

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('import.waitingForLibrarySyncPercent')
    );
    expect(api.import.serverHistory.getActive).toHaveBeenCalledWith('tofa-1');
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
