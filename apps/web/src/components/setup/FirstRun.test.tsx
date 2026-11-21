import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

const $fetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/authClient', () => ({ authClient: { $fetch } }));
vi.mock('@/lib/api', () => ({
  api: { auth: {} },
  BASE_URL: '/',
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly body: Record<string, unknown> = {}
    ) {
      super(message);
    }
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/brand/Logo', () => ({ LogoIcon: () => null }));

import { toast } from 'sonner';
import { SIGN_IN_ERROR_CODES } from '@tracearr/shared';
import { api, ApiError } from '@/lib/api';
import { FirstRun } from './FirstRun';

const plexButton = () => screen.queryByRole('button', { name: /pages:login.continueWith/ });

async function choose(name: string) {
  await userEvent.click(screen.getByRole('radio', { name }));
  await userEvent.click(screen.getByRole('button', { name: 'common:actions.continue' }));
}

const plexServer = {
  name: 'Attic',
  platform: 'Linux',
  version: '1.0',
  clientIdentifier: 'machine-1',
  recommendedUri: 'http://10.0.0.5:32400',
  connections: [
    {
      uri: 'http://10.0.0.5:32400',
      local: true,
      address: '10.0.0.5',
      port: 32400,
      reachable: true,
      latencyMs: 12,
    },
  ],
};

const connectFn = vi.fn();
const popup = { closed: false, close: vi.fn(), location: { assign: vi.fn() } };

function mockPlex(check: object) {
  Object.assign(api, {
    auth: {
      initiatePlex: vi.fn().mockResolvedValue({ handle: 'h-1', authUrl: 'https://app.plex.tv' }),
      checkPlexPin: vi.fn().mockResolvedValue(check),
      connectPlexServer: connectFn,
    },
  });
}

const pickerCheck = {
  authorized: true,
  needsServerSelection: true,
  servers: [plexServer],
  tempToken: 'temp-1',
  username: 'dana',
};

async function reachPlexPicker() {
  mockPlex(pickerCheck);
  render(<FirstRun claimCode={undefined} onSignedIn={vi.fn()} />);
  await choose('Plex');
  await userEvent.click(plexButton()!);
  await screen.findByText('pages:setup.pickerTitle');
}

const tofaServer = { id: 'srv-1', name: 'Attic', online: true, localAddress: null };

function mockTofa(check: object) {
  Object.assign(api, {
    auth: {
      initiateTofa: vi.fn().mockResolvedValue({
        handle: 'h-1',
        verificationUri: 'https://app.tofa.tv/link?code=ABCD',
        userCode: 'ABCD',
        expiresIn: 600,
        interval: 0,
      }),
      checkTofa: vi.fn().mockResolvedValue(check),
      connectTofa: connectFn,
    },
  });
}

const backButton = () => screen.queryByRole('button', { name: 'common:actions.back' });

describe('FirstRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    popup.closed = false;
    vi.spyOn(window, 'open').mockReturnValue(popup as never);
  });

  it('waits for a server choice before moving on', () => {
    render(<FirstRun claimCode={undefined} onSignedIn={vi.fn()} />);

    expect(screen.getAllByRole('radio')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'common:actions.continue' })).toBeDisabled();
    expect(backButton()).toBeNull();
  });

  it('marks the current step and lists done steps with what was chosen', async () => {
    render(<FirstRun claimCode={undefined} onSignedIn={vi.fn()} />);
    await choose('Jellyfin');

    const rail = screen.getByRole('navigation', { name: 'setup.stepsLabel' });
    const items = within(rail).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('Jellyfin');
    expect(within(items[0]!).getByRole('button')).toBeInTheDocument();
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(within(items[1]!).queryByRole('button')).toBeNull();
    expect(items[2]).not.toHaveAttribute('aria-current');
  });

  it('moves focus to the title when the step changes', async () => {
    render(<FirstRun claimCode={undefined} onSignedIn={vi.fn()} />);
    await choose('Jellyfin');

    const title = screen.getByRole('heading', { level: 1 });
    expect(title).toHaveTextContent('pages:setup.ownerTitle');
    expect(title).toHaveFocus();
  });

  it('offers Continue with Plex for Plex and only the account form for the others', async () => {
    render(<FirstRun claimCode={undefined} onSignedIn={vi.fn()} />);

    await choose('Jellyfin');
    expect(plexButton()).toBeNull();
    expect(screen.getByLabelText('settings:account.displayName')).toBeInTheDocument();

    await userEvent.click(backButton()!);
    await choose('Plex');
    expect(plexButton()).toBeInTheDocument();
    expect(screen.getByLabelText('settings:account.displayName')).toBeInTheDocument();
  });

  it('step 2 back keeps the chosen server type', async () => {
    render(<FirstRun claimCode={undefined} onSignedIn={vi.fn()} />);
    await choose('Emby');
    await userEvent.click(backButton()!);

    expect(screen.getByRole('radio', { name: 'Emby' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'common:actions.continue' })).toBeEnabled();
  });

  it('back from waiting cancels the sign-in', async () => {
    mockPlex({ authorized: false });
    render(<FirstRun claimCode={undefined} onSignedIn={vi.fn()} />);
    await choose('Plex');
    await userEvent.click(plexButton()!);
    expect(await screen.findByText('pages:login.waitingForPlex')).toBeInTheDocument();

    await userEvent.click(backButton()!);

    expect(popup.close).toHaveBeenCalled();
    expect(screen.queryByText('pages:login.waitingForPlex')).toBeNull();
    expect(plexButton()).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('pages:setup.ownerTitle');
  });

  it('back from the Plex picker returns to the account step', async () => {
    await reachPlexPicker();
    const rail = screen.getByRole('navigation', { name: 'setup.stepsLabel' });
    expect(within(rail).getAllByRole('listitem')[1]).toHaveTextContent('pages:setup.signedInAs');

    await userEvent.click(backButton()!);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('pages:setup.ownerTitle');
    expect(plexButton()).toBeInTheDocument();
  });

  it('back is disabled while connecting', async () => {
    connectFn.mockReturnValue(new Promise(() => {}));
    await reachPlexPicker();
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.connect' }));

    expect(await screen.findAllByText(/common:states.connecting/)).not.toHaveLength(0);
    expect(backButton()).toBeDisabled();
    const rail = screen.getByRole('navigation', { name: 'setup.stepsLabel' });
    expect(within(rail).queryAllByRole('button')).toHaveLength(0);
  });

  it('back during sign-in start does not begin polling', async () => {
    let resolveStart: (value: { handle: string; authUrl: string }) => void = () => {};
    const checkPlexPin = vi.fn().mockResolvedValue({ authorized: false });
    Object.assign(api, {
      auth: {
        initiatePlex: vi.fn().mockReturnValue(
          new Promise((resolve) => {
            resolveStart = resolve;
          })
        ),
        checkPlexPin,
      },
    });
    render(<FirstRun claimCode={undefined} onSignedIn={vi.fn()} />);
    await choose('Plex');
    await userEvent.click(plexButton()!);
    await userEvent.click(backButton()!);

    resolveStart({ handle: 'h-1', authUrl: 'https://app.plex.tv' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(checkPlexPin).not.toHaveBeenCalled();
    expect(screen.queryByText('setup.codeExpired')).toBeNull();
  });

  it('shows the expired code inline with sign in again', async () => {
    mockPlex({ authorized: false, expired: true });
    render(<FirstRun claimCode={undefined} onSignedIn={vi.fn()} />);
    await choose('Plex');
    await userEvent.click(plexButton()!);

    expect(await screen.findByText('pages:setup.codeExpired')).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();

    mockPlex({ authorized: false });
    await userEvent.click(screen.getByRole('button', { name: 'setup.signInAgain' }));
    expect(await screen.findByText('pages:login.waitingForPlex')).toBeInTheDocument();
    expect(screen.queryByText('pages:setup.codeExpired')).toBeNull();
  });

  it('shows the timed out picker when connect answers expired', async () => {
    connectFn.mockRejectedValue(
      new ApiError('Sign-in expired', 401, { code: SIGN_IN_ERROR_CODES.signInExpired })
    );
    await reachPlexPicker();
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.connect' }));

    expect(await screen.findByText('pages:setup.timedOut')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'setup.signInAgain' })).toBeInTheDocument();
    expect(screen.queryByText('Attic')).toBeNull();
  });

  it('shows connect errors under the picker instead of a toast', async () => {
    connectFn.mockRejectedValue(new Error('Plex refused the connection'));
    await reachPlexPicker();
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.connect' }));

    expect(await screen.findByText('Plex refused the connection')).toBeInTheDocument();
    expect(screen.getByText('Attic')).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('continue with tofa signs in, picks the server and lands on import', async () => {
    mockTofa({
      status: 'select-server',
      tempToken: 'temp-1',
      username: 'dana',
      servers: [tofaServer],
    });
    connectFn.mockResolvedValue({ status: 'signed-in', user: { id: 'u-1' } });
    const onSignedIn = vi.fn().mockResolvedValue(undefined);
    render(<FirstRun claimCode="CLAIM" onSignedIn={onSignedIn} />);
    await choose('tofa');
    await userEvent.click(screen.getByRole('button', { name: 'pages:login.continueWith' }));

    expect(await screen.findByText('pages:setup.pickerTitle')).toBeInTheDocument();
    const rail = screen.getByRole('navigation', { name: 'setup.stepsLabel' });
    expect(within(rail).getAllByRole('listitem')[1]).toHaveTextContent('pages:setup.signedInAs');
    expect(screen.getByText(/pages:tofa.pickerNote/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'common:actions.connect' }));

    expect(connectFn).toHaveBeenCalledWith({
      tempToken: 'temp-1',
      serverId: 'srv-1',
      claimCode: 'CLAIM',
    });
    expect(onSignedIn).toHaveBeenCalledWith(
      'pages:login.connectedTo',
      '/setup?type=tofa&step=import'
    );
  });

  it('keeps the account form when the tofa account owns no servers, and says why', async () => {
    mockTofa({ status: 'no-servers', username: 'dana' });
    render(<FirstRun claimCode={undefined} onSignedIn={vi.fn()} />);
    await choose('tofa');
    await userEvent.click(screen.getByRole('button', { name: 'pages:login.continueWith' }));

    expect(await screen.findByText('pages:tofa.noServersTitle')).toBeInTheDocument();
    expect(screen.getByLabelText('settings:account.displayName')).toBeInTheDocument();
  });

  it('says every server of the tofa account is already connected', async () => {
    mockTofa({ status: 'all-connected', username: 'dana' });
    render(<FirstRun claimCode={undefined} onSignedIn={vi.fn()} />);
    await choose('tofa');
    await userEvent.click(screen.getByRole('button', { name: 'pages:login.continueWith' }));

    expect(await screen.findByText('settings:servers.allServersConnected')).toBeInTheDocument();
    expect(screen.getByLabelText('settings:account.displayName')).toBeInTheDocument();
  });

  it('a failed sign-in start shows inline in setup', async () => {
    mockTofa({ status: 'pending' });
    vi.mocked(api.auth.initiateTofa).mockRejectedValue(new Error('Invalid claim code'));
    render(<FirstRun claimCode="WRONG" onSignedIn={vi.fn()} />);
    await choose('tofa');
    await userEvent.click(screen.getByRole('button', { name: 'pages:login.continueWith' }));

    expect(await screen.findByText('Invalid claim code')).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'setup.signInAgain' })).toBeInTheDocument();
    expect(screen.getByLabelText('settings:account.displayName')).toBeInTheDocument();
  });

  it('sends a new owner on to connect the server they picked', async () => {
    $fetch.mockResolvedValue({ error: null });
    const onSignedIn = vi.fn().mockResolvedValue(undefined);
    render(<FirstRun claimCode={undefined} onSignedIn={onSignedIn} />);

    await choose('tofa');
    await userEvent.type(screen.getByLabelText('settings:account.displayName'), 'Dana');
    await userEvent.type(screen.getByLabelText('pages:login.username'), 'Dana');
    await userEvent.type(screen.getByLabelText('settings:account.email'), 'dana@example.com');
    await userEvent.type(screen.getByLabelText('settings:account.password'), 'longenough');
    await userEvent.click(screen.getByRole('button', { name: 'settings:account.createAccount' }));

    expect($fetch).toHaveBeenCalledWith('/sign-up/email', {
      method: 'POST',
      body: { name: 'Dana', username: 'dana', email: 'dana@example.com', password: 'longenough' },
    });
    expect(onSignedIn).toHaveBeenCalledWith('pages:login.accountCreated', '/setup?type=tofa');
  });
});
