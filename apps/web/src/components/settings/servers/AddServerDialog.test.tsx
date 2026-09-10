import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddServerDialog } from './AddServerDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/auth/PlexServerSelector', () => ({
  PlexServerSelector: () => <div>plex server selector</div>,
}));

function props(overrides: Partial<React.ComponentProps<typeof AddServerDialog>> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    isOwner: true,
    serverType: 'jellyfin' as const,
    onServerTypeChange: vi.fn(),
    serverUrl: '',
    onServerUrlChange: vi.fn(),
    publicUrl: '',
    onPublicUrlChange: vi.fn(),
    serverName: '',
    onServerNameChange: vi.fn(),
    apiKey: '',
    onApiKeyChange: vi.fn(),
    isConnecting: false,
    connectError: null,
    onConnect: vi.fn(),
    plexStep: 'loading' as const,
    plexAccounts: [],
    selectedPlexAccountId: null,
    onSelectPlexAccount: vi.fn(),
    plexServers: [],
    connectingPlexServer: null,
    onSelectPlexServer: vi.fn(),
    onTestPlexUrl: vi.fn(),
    ...overrides,
  };
}

describe('AddServerDialog', () => {
  it('labels the four Jellyfin fields and reports what was typed', async () => {
    const onServerUrlChange = vi.fn();
    const onPublicUrlChange = vi.fn();
    render(<AddServerDialog {...props({ onServerUrlChange, onPublicUrlChange })} />);

    expect(screen.getByLabelText('servers.serverUrl')).toBeInTheDocument();
    expect(screen.getByLabelText('servers.publicUrl')).toBeInTheDocument();
    expect(screen.getByLabelText('servers.serverName')).toBeInTheDocument();
    expect(screen.getByLabelText('common:labels.apiKey')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('servers.serverUrl'), 'h');
    expect(onServerUrlChange).toHaveBeenCalledWith('h');
    await userEvent.type(screen.getByLabelText('servers.publicUrl'), 'j');
    expect(onPublicUrlChange).toHaveBeenCalledWith('j');
  });

  it('surfaces a connect failure as an alert', () => {
    render(<AddServerDialog {...props({ connectError: 'Connection refused' })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Connection refused');
  });

  it('offers connect for Jellyfin and not for Plex', () => {
    const { rerender } = render(<AddServerDialog {...props()} />);
    expect(screen.getByRole('button', { name: 'servers.connectServer' })).toBeInTheDocument();

    rerender(<AddServerDialog {...props({ serverType: 'plex', plexStep: 'select' })} />);
    expect(screen.queryByRole('button', { name: 'servers.connectServer' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('servers.publicUrl')).not.toBeInTheDocument();
  });

  it('tells the owner when no Plex account is linked', () => {
    render(<AddServerDialog {...props({ serverType: 'plex', plexStep: 'no-accounts' })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('servers.noPlexAccountsLinked');
  });

  it('shows one account picker when several Plex accounts are linked', async () => {
    const onSelectPlexAccount = vi.fn();
    render(
      <AddServerDialog
        {...props({
          serverType: 'plex',
          plexStep: 'select',
          selectedPlexAccountId: 'a',
          onSelectPlexAccount,
          plexAccounts: [
            { id: 'a', plexUsername: 'alice', plexEmail: null },
            { id: 'b', plexUsername: 'bob', plexEmail: null },
          ],
        })}
      />
    );

    await userEvent.click(screen.getByRole('combobox', { name: 'servers.plexAccount' }));
    await userEvent.click(screen.getByRole('option', { name: 'bob' }));

    expect(onSelectPlexAccount).toHaveBeenCalledWith('b');
  });
});
