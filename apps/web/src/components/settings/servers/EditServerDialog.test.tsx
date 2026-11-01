import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Server, ServerLocationEntry } from '@tracearr/shared';
import { EditServerDialog } from './EditServerDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mutateAsync = vi.fn().mockResolvedValue({ entries: [], syncPending: true, syncQueued: true });

vi.mock('@/hooks/queries', () => ({
  usePlexServerConnections: vi.fn(),
  useServerLocations: vi.fn(() => ({
    data: { entries: [], syncPending: false },
    isLoading: false,
    isFetchedAfterMount: true,
  })),
  useUpdateServerLocations: vi.fn(() => ({ mutateAsync, isPending: false })),
  useUpdateServer: vi.fn(() => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    submittedAt: 0,
    variables: undefined,
    error: null,
  })),
}));
vi.mock('@/components/map/LocationPicker', () => ({ LocationPicker: () => <div>map</div> }));
vi.mock('@/components/settings/shared/CountrySelect', () => ({
  CountrySelect: ({
    value,
    onChange,
    id,
  }: {
    value: string;
    onChange: (v: string) => void;
    id?: string;
  }) => <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />,
}));
vi.mock('@/lib/api', () => ({ api: { auth: { testPlexConnection: vi.fn() } } }));
vi.mock('@/components/auth/PlexServerSelector', () => ({
  PlexServerSelector: ({
    onSelect,
    connecting,
  }: {
    onSelect: (uri: string, name: string, clientIdentifier: string) => void;
    connecting?: boolean;
  }) => (
    <button
      type="button"
      disabled={connecting}
      onClick={() => onSelect('https://plex.example:32400', 'Plex', 'client-1')}
    >
      plex server selector
    </button>
  ),
}));

import {
  usePlexServerConnections,
  useServerLocations,
  useUpdateServerLocations,
} from '@/hooks/queries';

const CHICAGO: ServerLocationEntry = {
  effectiveFrom: null,
  lat: 41.8781,
  lon: -87.6298,
  city: 'Chicago',
  region: null,
  country: 'US',
};

function savedLocations(
  entries: ServerLocationEntry[],
  state: { syncPending?: boolean; fetched?: boolean; failed?: boolean } = {}
) {
  vi.mocked(useServerLocations).mockReturnValue({
    data: { entries, syncPending: state.syncPending ?? false },
    isLoading: false,
    isFetchedAfterMount: state.fetched ?? true,
    isError: state.failed ?? false,
  } as unknown as ReturnType<typeof useServerLocations>);
}

function field(label: string, index: number): HTMLElement {
  const element = screen.getAllByLabelText(label)[index];
  if (!element) throw new Error(`${label} #${index} not found`);
  return element;
}

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
    savedLocations([]);
    vi.mocked(useUpdateServerLocations).mockReturnValue({
      mutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateServerLocations>);
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

  it('sends a new API key trimmed and never prefills the saved one', async () => {
    const onUpdate = vi.fn();
    render(
      <EditServerDialog
        server={server({ type: 'emby' })}
        servers={[server()]}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        isUpdating={false}
      />
    );

    const field = screen.getByLabelText('common:labels.apiKey');
    expect(field).toHaveValue('');
    expect(screen.getByRole('button', { name: 'common:actions.update' })).toBeDisabled();

    await userEvent.type(field, ' new-key ');
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.update' }));
    expect(onUpdate).toHaveBeenCalledWith({ apiKey: 'new-key' });
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
    expect(screen.queryByLabelText('common:labels.apiKey')).not.toBeInTheDocument();
  });

  it('saves a new location without touching the server fields and closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onUpdate = vi.fn();
    render(
      <EditServerDialog
        server={server()}
        servers={[server()]}
        onClose={onClose}
        onUpdate={onUpdate}
        isUpdating={false}
      />
    );

    await user.click(screen.getByRole('button', { name: /servers.location.set/ }));
    await user.type(screen.getByLabelText('servers.location.latitude'), '41.8781');
    await user.type(screen.getByLabelText('servers.location.longitude'), '-87.6298');
    await user.type(screen.getByLabelText('servers.location.country'), 'US');
    await user.click(screen.getByRole('button', { name: 'common:actions.update' }));

    expect(mutateAsync).toHaveBeenCalledWith({
      id: 'server-1',
      entries: [
        {
          effectiveFrom: null,
          lat: 41.8781,
          lon: -87.6298,
          city: null,
          region: null,
          country: 'US',
        },
      ],
    });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps save disabled while a location is incomplete', async () => {
    const user = userEvent.setup();
    render(
      <EditServerDialog
        server={server()}
        servers={[server()]}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        isUpdating={false}
      />
    );
    await user.click(screen.getByRole('button', { name: /servers.location.set/ }));
    expect(screen.getByRole('button', { name: 'common:actions.update' })).toBeDisabled();
    expect(screen.getByText('servers.location.incomplete')).toBeInTheDocument();
  });

  it('keeps location edits when the saved locations refetch while open', async () => {
    const user = userEvent.setup();
    const editing = server();
    const props = { servers: [editing], onClose: vi.fn(), onUpdate: vi.fn(), isUpdating: false };
    const { rerender } = render(<EditServerDialog server={editing} {...props} />);

    await user.click(screen.getByRole('button', { name: /servers.location.set/ }));
    await user.type(screen.getByLabelText('servers.location.latitude'), '41.8781');
    savedLocations([], { syncPending: true });
    rerender(<EditServerDialog server={editing} {...props} />);

    expect(screen.getByLabelText('servers.location.latitude')).toHaveValue('41.8781');
    expect(screen.getByText('servers.location.syncPending')).toBeInTheDocument();
  });

  it('stays open and skips the server fields when the location save fails', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onUpdate = vi.fn();
    render(
      <EditServerDialog
        server={server()}
        servers={[server()]}
        onClose={onClose}
        onUpdate={onUpdate}
        isUpdating={false}
      />
    );

    await user.click(screen.getByRole('radio', { name: 'Red' }));
    await user.click(screen.getByRole('button', { name: /servers.location.set/ }));
    await user.type(screen.getByLabelText('servers.location.latitude'), '41.8781');
    await user.type(screen.getByLabelText('servers.location.longitude'), '-87.6298');
    await user.type(screen.getByLabelText('servers.location.country'), 'US');
    await user.click(screen.getByRole('button', { name: 'common:actions.update' }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not save the locations again when a failed server update is retried', async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByRole('radio', { name: 'Red' }));
    await user.click(screen.getByRole('button', { name: /servers.location.set/ }));
    await user.type(screen.getByLabelText('servers.location.latitude'), '41.8781');
    await user.type(screen.getByLabelText('servers.location.longitude'), '-87.6298');
    await user.type(screen.getByLabelText('servers.location.country'), 'US');
    await user.click(screen.getByRole('button', { name: 'common:actions.update' }));
    await user.click(screen.getByRole('button', { name: 'common:actions.update' }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenLastCalledWith({ color: '#EF4444' });
  });

  it('disables the Plex connections while a location is invalid and saves it before switching', async () => {
    vi.mocked(usePlexServerConnections).mockReturnValue({
      data: { server: { name: 'Living Room Plex' } },
      isLoading: false,
    } as unknown as ReturnType<typeof usePlexServerConnections>);
    const order: string[] = [];
    mutateAsync.mockImplementationOnce(async () => {
      await Promise.resolve();
      order.push('locations');
      return { entries: [], syncPending: true, syncQueued: true };
    });
    const onUpdate = vi.fn(() => order.push('update'));
    const user = userEvent.setup();
    render(
      <EditServerDialog
        server={server({ type: 'plex' })}
        servers={[server({ type: 'plex' })]}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        isUpdating={false}
      />
    );

    await user.click(screen.getByRole('button', { name: /servers.location.set/ }));
    expect(screen.getByRole('button', { name: 'plex server selector' })).toBeDisabled();

    await user.type(screen.getByLabelText('servers.location.latitude'), '41.8781');
    await user.type(screen.getByLabelText('servers.location.longitude'), '-87.6298');
    await user.type(screen.getByLabelText('servers.location.country'), 'US');
    await user.click(screen.getByRole('button', { name: 'plex server selector' }));

    expect(mutateAsync).toHaveBeenCalledWith({
      id: 'server-1',
      entries: [
        {
          effectiveFrom: null,
          lat: 41.8781,
          lon: -87.6298,
          city: null,
          region: null,
          country: 'US',
        },
      ],
    });
    expect(order).toEqual(['locations', 'update']);
    expect(onUpdate).toHaveBeenCalledWith({
      name: undefined,
      url: 'https://plex.example:32400',
      clientIdentifier: 'client-1',
      color: undefined,
    });
  });

  it('cannot be closed while a location save is in flight', async () => {
    vi.mocked(useUpdateServerLocations).mockReturnValue({
      mutateAsync,
      isPending: true,
    } as unknown as ReturnType<typeof useUpdateServerLocations>);
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <EditServerDialog
        server={server()}
        servers={[server()]}
        onClose={onClose}
        onUpdate={vi.fn()}
        isUpdating={false}
      />
    );

    expect(screen.getByRole('button', { name: 'common:actions.cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('seeds the locations only from a successful fetch made after the dialog opened', () => {
    savedLocations([], { fetched: false });
    const editing = server();
    const props = { servers: [editing], onClose: vi.fn(), onUpdate: vi.fn(), isUpdating: false };
    const { rerender } = render(<EditServerDialog server={editing} {...props} />);
    expect(screen.queryByRole('button', { name: /servers.location.set/ })).not.toBeInTheDocument();

    savedLocations([], { failed: true });
    rerender(<EditServerDialog server={editing} {...props} />);
    expect(screen.queryByRole('button', { name: /servers.location.set/ })).not.toBeInTheDocument();

    savedLocations([CHICAGO]);
    rerender(<EditServerDialog server={editing} {...props} />);
    expect(screen.getByLabelText('servers.location.latitude')).toHaveValue('41.8781');
  });

  it('sends a dated move from local midnight of the picked day', async () => {
    savedLocations([CHICAGO]);
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <EditServerDialog
        server={server()}
        servers={[server()]}
        onClose={onClose}
        onUpdate={vi.fn()}
        isUpdating={false}
      />
    );

    await user.click(screen.getByRole('button', { name: /servers.location.addMove/ }));
    fireEvent.change(screen.getByLabelText('servers.location.movedOn'), {
      target: { value: '2024-03-01' },
    });
    await user.type(field('servers.location.latitude', 1), '45.5017');
    await user.type(field('servers.location.longitude', 1), '-73.5673');
    await user.type(field('servers.location.country', 1), 'CA');
    await user.click(screen.getByRole('button', { name: 'common:actions.update' }));

    expect(mutateAsync).toHaveBeenCalledWith({
      id: 'server-1',
      entries: [
        CHICAGO,
        {
          effectiveFrom: new Date(2024, 2, 1).toISOString(),
          lat: 45.5017,
          lon: -73.5673,
          city: null,
          region: null,
          country: 'CA',
        },
      ],
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('offers the location from the beginning again when only moves are left', async () => {
    const move: ServerLocationEntry = {
      effectiveFrom: new Date(2024, 2, 1).toISOString(),
      lat: 45.5017,
      lon: -73.5673,
      city: null,
      region: null,
      country: 'CA',
    };
    savedLocations([move]);
    const user = userEvent.setup();
    render(
      <EditServerDialog
        server={server()}
        servers={[server()]}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        isUpdating={false}
      />
    );
    expect(screen.getByRole('button', { name: /servers.location.addMove/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /servers.location.set/ }));
    expect(screen.getByText('servers.location.fromBeginning')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /servers.location.set/ })).not.toBeInTheDocument();
    await user.type(field('servers.location.latitude', 0), '41.8781');
    await user.type(field('servers.location.longitude', 0), '-87.6298');
    await user.type(field('servers.location.country', 0), 'US');
    await user.click(screen.getByRole('button', { name: 'common:actions.update' }));

    expect(mutateAsync).toHaveBeenCalledWith({
      id: 'server-1',
      entries: [
        {
          effectiveFrom: null,
          lat: 41.8781,
          lon: -87.6298,
          city: null,
          region: null,
          country: 'US',
        },
        move,
      ],
    });
  });

  it('sends an empty list when every location is removed, and closes', async () => {
    savedLocations([CHICAGO]);
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onUpdate = vi.fn();
    render(
      <EditServerDialog
        server={server()}
        servers={[server()]}
        onClose={onClose}
        onUpdate={onUpdate}
        isUpdating={false}
      />
    );

    await user.click(screen.getByRole('button', { name: /common:actions\.remove/ }));
    await user.click(screen.getByRole('button', { name: 'common:actions.update' }));

    expect(mutateAsync).toHaveBeenCalledWith({ id: 'server-1', entries: [] });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('locks the URL and API key on a historical server but still renames it', async () => {
    const onUpdate = vi.fn();
    render(
      <EditServerDialog
        server={server({ historicalAt: '2026-09-01T12:00:00.000Z' })}
        servers={[]}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        isUpdating={false}
      />
    );

    expect(field('servers.serverUrl', 0)).toBeDisabled();
    expect(field('common:labels.apiKey', 0)).toBeDisabled();
    expect(screen.getAllByText('servers.resumeFirst').length).toBeGreaterThan(0);

    await userEvent.clear(field('servers.serverName', 0));
    await userEvent.type(field('servers.serverName', 0), 'Old Attic');
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.update' }));

    expect(onUpdate).toHaveBeenCalledWith({
      name: 'Old Attic',
      url: undefined,
      color: undefined,
      publicUrl: undefined,
      apiKey: undefined,
    });
  });

  it('shows a disabled address instead of the Plex connection picker on a historical Plex server', () => {
    vi.mocked(usePlexServerConnections).mockReturnValue({
      data: { server: { name: 'Plex', connections: [] } },
      isLoading: false,
    } as unknown as ReturnType<typeof usePlexServerConnections>);
    render(
      <EditServerDialog
        server={server({ type: 'plex', historicalAt: '2026-09-01T12:00:00.000Z' })}
        servers={[]}
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        isUpdating={false}
      />
    );

    expect(screen.queryByText('plex server selector')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('http://jelly.local:8096')).toBeDisabled();
    expect(usePlexServerConnections).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByText('servers.discoveringConnections')).not.toBeInTheDocument();
  });
});
