import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Server } from '@tracearr/shared';
import { EditServerDialog } from './EditServerDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/queries', () => ({ usePlexServerConnections: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { auth: { testPlexConnection: vi.fn() } } }));
vi.mock('@/components/auth/PlexServerSelector', () => ({
  PlexServerSelector: () => <div>plex server selector</div>,
}));

import { usePlexServerConnections } from '@/hooks/queries';

function server(overrides: Partial<Server> = {}): Server {
  return {
    id: 'server-1',
    name: 'Basement Jellyfin',
    type: 'jellyfin',
    url: 'http://jelly.local:8096',
    color: '#3B82F6',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  } as Server;
}

describe('EditServerDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePlexServerConnections).mockReturnValue({
      data: undefined,
      isLoading: false,
    } as unknown as ReturnType<typeof usePlexServerConnections>);
  });

  it('renders nothing when no server is being edited', () => {
    const { container } = render(
      <EditServerDialog
        server={null}
        servers={[]}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        isUpdating={false}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('labels the name and url fields and seeds them from the server', () => {
    render(
      <EditServerDialog
        server={server()}
        servers={[server()]}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        isUpdating={false}
      />
    );

    expect(screen.getByLabelText('servers.serverName')).toHaveValue('Basement Jellyfin');
    expect(screen.getByLabelText('servers.serverUrl')).toHaveValue('http://jelly.local:8096');
  });

  it('marks the saved color checked, matching regardless of stored casing', () => {
    render(
      <EditServerDialog
        server={server({ color: '#3b82f6' })}
        servers={[server()]}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        isUpdating={false}
      />
    );

    expect(screen.getByRole('radio', { name: 'Blue' })).toBeChecked();
  });

  it('sends only what changed', async () => {
    const onUpdate = vi.fn();
    render(
      <EditServerDialog
        server={server()}
        servers={[server()]}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        isUpdating={false}
      />
    );

    await userEvent.click(screen.getByRole('radio', { name: 'Red' }));
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.update' }));

    expect(onUpdate).toHaveBeenCalledWith({ color: '#EF4444' });
  });

  it('seeds the public address, sends it trimmed on save, and clears it with null', async () => {
    const onUpdate = vi.fn();
    render(
      <EditServerDialog
        server={server({ publicUrl: 'https://jellyfin.example.com' })}
        servers={[server()]}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        isUpdating={false}
      />
    );

    const field = screen.getByLabelText('servers.publicUrl');
    expect(field).toHaveValue('https://jellyfin.example.com');
    await userEvent.clear(field);
    await userEvent.type(field, ' members.example.com ');
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.update' }));
    expect(onUpdate).toHaveBeenCalledWith({ publicUrl: 'members.example.com' });

    await userEvent.clear(field);
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.update' }));
    expect(onUpdate).toHaveBeenLastCalledWith({ publicUrl: null });
  });

  it('keeps the save button disabled until something changes', () => {
    render(
      <EditServerDialog
        server={server()}
        servers={[server()]}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        isUpdating={false}
      />
    );

    expect(screen.getByRole('button', { name: 'common:actions.update' })).toBeDisabled();
  });

  it('shows the loading spinner and no URL input while Plex connections load', () => {
    vi.mocked(usePlexServerConnections).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof usePlexServerConnections>);

    render(
      <EditServerDialog
        server={server({ type: 'plex' })}
        servers={[server({ type: 'plex' })]}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        isUpdating={false}
      />
    );

    expect(screen.getByText('servers.discoveringConnections')).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('servers.plexServerUrlPlaceholder')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('plex server selector')).not.toBeInTheDocument();
  });

  it('shows the Plex server selector once connections are found', () => {
    vi.mocked(usePlexServerConnections).mockReturnValue({
      data: { server: { name: 'Living Room Plex' } },
      isLoading: false,
    } as unknown as ReturnType<typeof usePlexServerConnections>);

    render(
      <EditServerDialog
        server={server({ type: 'plex' })}
        servers={[server({ type: 'plex' })]}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        isUpdating={false}
      />
    );

    expect(screen.getByText('plex server selector')).toBeInTheDocument();
  });

  it('falls back to a manual URL input when Plex has no discovered connections', () => {
    vi.mocked(usePlexServerConnections).mockReturnValue({
      data: { server: null },
      isLoading: false,
    } as unknown as ReturnType<typeof usePlexServerConnections>);

    render(
      <EditServerDialog
        server={server({ type: 'plex', url: 'http://plex.local:32400' })}
        servers={[server({ type: 'plex' })]}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        isUpdating={false}
      />
    );

    expect(screen.getByPlaceholderText('servers.plexServerUrlPlaceholder')).toHaveValue(
      'http://plex.local:32400'
    );
    expect(screen.queryByLabelText('servers.publicUrl')).not.toBeInTheDocument();
  });
});
