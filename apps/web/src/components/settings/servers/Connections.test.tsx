import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DragEndEvent } from '@dnd-kit/core';
import type { Server } from '@tracearr/shared';
import { Connections } from './Connections';
import type { AddServerForm } from './useAddServer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

let capturedOnDragEnd: ((event: DragEndEvent) => void) | undefined;

vi.mock('@dnd-kit/core', async () => {
  const actual = await vi.importActual<typeof import('@dnd-kit/core')>('@dnd-kit/core');
  return {
    ...actual,
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: React.ReactNode;
      onDragEnd: (event: DragEndEvent) => void;
    }) => {
      capturedOnDragEnd = onDragEnd;
      return <div>{children}</div>;
    },
  };
});

const { serverRowProps } = vi.hoisted(() => ({
  serverRowProps: [] as { server: Server; requestService?: unknown; isDraggable?: boolean }[],
}));

vi.mock('@/components/settings/servers/ServerRow', () => ({
  ServerRow: (props: {
    server: Server;
    onDelete: () => void;
    onSetHistorical: (historical: boolean) => void;
    requestService?: unknown;
  }) => {
    serverRowProps.push(props);
    return (
      <div>
        {props.server.name}
        <button onClick={props.onDelete}>remove-{props.server.id}</button>
        <button onClick={() => props.onSetHistorical(true)}>mark-{props.server.id}</button>
        <button onClick={() => props.onSetHistorical(false)}>resume-{props.server.id}</button>
      </div>
    );
  },
}));

const { connectJellyfinWithApiKey } = vi.hoisted(() => ({ connectJellyfinWithApiKey: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: {
    auth: {
      getPlexAccounts: vi.fn().mockResolvedValue({ accounts: [] }),
      getAvailablePlexServers: vi.fn(),
      addPlexServer: vi.fn(),
      testPlexConnection: vi.fn(),
      connectJellyfinWithApiKey,
      connectEmbyWithApiKey: vi.fn(),
    },
  },
}));

vi.mock('@/components/settings/servers/AddServerDialog', () => ({
  AddServerDialog: ({
    open,
    form,
    added,
  }: {
    open: boolean;
    form: AddServerForm;
    added?: { id: string; type: string } | null;
  }) =>
    open ? (
      <div>
        {added && <p>import step for {added.id}</p>}
        <button
          onClick={() => {
            form.changeServerType('jellyfin');
            form.setServerUrl('http://192.168.1.20:8096');
            form.setServerName('Attic');
            form.setApiKey('key-1');
            form.setPublicUrl(' jellyfin.example.com ');
          }}
        >
          fill jellyfin
        </button>
        <button onClick={() => void form.connect()}>connect</button>
      </div>
    ) : null,
}));

vi.mock('@/components/settings/servers/EditServerDialog', () => ({
  EditServerDialog: () => <div>edit server dialog</div>,
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }));
vi.mock('@/hooks/useSocket', () => ({ useSocket: vi.fn() }));

const deleteMutate = vi.fn((_id: string, opts?: { onSuccess?: () => void }) => {
  opts?.onSuccess?.();
});
const setHistoricalMutate = vi.fn((_vars: unknown, opts?: { onSuccess?: () => void }) => {
  opts?.onSuccess?.();
});
const reorderMutate = vi.fn();
const invalidateQueries = vi.fn();

vi.mock('@/hooks/queries', () => ({
  useDeleteServer: vi.fn(() => ({ mutate: deleteMutate, isPending: false })),
  useOwnerLinks: vi.fn(() => ({ data: undefined })),
  useReorderServers: vi.fn(() => ({ mutate: reorderMutate, isPending: false })),
  useRequestServices: vi.fn(),
  useServers: vi.fn(),
  useSetServerHistorical: vi.fn(() => ({
    mutate: setHistoricalMutate,
    isPending: false,
    variables: undefined,
  })),
  useSyncServer: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdateServer: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return { ...actual, useQueryClient: () => ({ invalidateQueries }) };
});

import { useRequestServices, useServers } from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { useSocket } from '@/hooks/useSocket';

function server(overrides: Partial<Server> = {}): Server {
  return {
    id: 'server-1',
    name: 'Server 1',
    type: 'jellyfin',
    url: 'http://jelly.local:8096',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  } as Server;
}

describe('Connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnDragEnd = undefined;
    serverRowProps.length = 0;
    vi.mocked(useRequestServices).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useRequestServices>);
    vi.mocked(useAuth).mockReturnValue({
      user: { role: 'owner' },
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    vi.mocked(useSocket).mockReturnValue({
      serverConnectionStatuses: new Map(),
    } as unknown as ReturnType<typeof useSocket>);
    vi.mocked(useServers).mockReturnValue({
      data: [
        server({ id: 'server-1', name: 'Server 1' }),
        server({ id: 'server-2', name: 'Server 2' }),
      ],
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useServers>);
  });

  it('holds the Seerr line back until the services query has answered', () => {
    vi.mocked(useRequestServices).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useRequestServices>);
    const { rerender } = render(<Connections />);

    expect(serverRowProps).not.toHaveLength(0);
    expect(serverRowProps.every((props) => props.requestService === undefined)).toBe(true);

    const linked = { id: 'rs-1', serverId: 'server-1' };
    vi.mocked(useRequestServices).mockReturnValue({
      data: [linked],
      isLoading: false,
    } as unknown as ReturnType<typeof useRequestServices>);
    serverRowProps.length = 0;
    rerender(<Connections />);

    expect(serverRowProps.map((props) => props.requestService)).toEqual([
      { service: linked },
      { service: undefined },
    ]);
  });

  it('keeps the Seerr line and its query away from a non-owner', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: { role: 'member' },
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);

    render(<Connections />);

    expect(useRequestServices).toHaveBeenCalledWith({ enabled: false });
    expect(serverRowProps).not.toHaveLength(0);
    expect(serverRowProps.every((props) => props.requestService === undefined)).toBe(true);
  });

  it('asks before marking a server historical, then calls the mutation', async () => {
    const user = userEvent.setup();
    render(<Connections />);

    await user.click(screen.getByText('mark-server-1'));
    expect(screen.getByText('servers.markHistoricalConfirm')).toBeInTheDocument();
    expect(setHistoricalMutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'servers.markHistorical' }));
    await waitFor(() =>
      expect(setHistoricalMutate).toHaveBeenCalledWith(
        { id: 'server-1', historical: true },
        expect.anything()
      )
    );
  });

  it('resumes without asking', async () => {
    const user = userEvent.setup();
    render(<Connections />);

    await user.click(screen.getByText('resume-server-2'));

    expect(setHistoricalMutate).toHaveBeenCalledWith({ id: 'server-2', historical: false });
    expect(screen.queryByText('servers.markHistoricalConfirm')).not.toBeInTheDocument();
  });

  it('maps a keyboard drag to the reordered displayOrder payload', () => {
    render(<Connections />);

    expect(capturedOnDragEnd).toBeDefined();

    capturedOnDragEnd?.({
      active: { id: 'server-2' },
      over: { id: 'server-1' },
    } as DragEndEvent);

    expect(reorderMutate).toHaveBeenCalledWith([
      { id: 'server-2', displayOrder: 0 },
      { id: 'server-1', displayOrder: 1 },
    ]);
  });

  it('does nothing when a drag ends back on its own row', () => {
    render(<Connections />);

    capturedOnDragEnd?.({
      active: { id: 'server-1' },
      over: { id: 'server-1' },
    } as DragEndEvent);

    expect(reorderMutate).not.toHaveBeenCalled();
  });

  it('deletes a server and invalidates the Plex accounts a removed server may have freed', async () => {
    render(<Connections />);

    await userEvent.click(screen.getByRole('button', { name: 'remove-server-1' }));
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.remove' }));

    expect(deleteMutate).toHaveBeenCalledWith('server-1', expect.any(Object));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['plex-accounts'] });
  });

  it('names the server in the remove confirm', async () => {
    render(<Connections />);

    await userEvent.click(screen.getByRole('button', { name: 'remove-server-2' }));

    expect(screen.getByText('servers.removeServerTitle:{"name":"Server 2"}')).toBeInTheDocument();
  });

  it('offers reordering only when there is more than one server', () => {
    const { unmount } = render(<Connections />);
    expect(serverRowProps.every((props) => props.isDraggable)).toBe(true);
    unmount();

    vi.mocked(useServers).mockReturnValue({
      data: [server()],
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useServers>);
    serverRowProps.length = 0;
    render(<Connections />);
    expect(serverRowProps.map((props) => props.isDraggable)).toEqual([false]);
  });

  it('sends the trimmed public address with the Jellyfin connect call', async () => {
    connectJellyfinWithApiKey.mockResolvedValue({});
    render(<Connections />);

    await userEvent.click(screen.getByRole('button', { name: 'servers.addServer' }));
    await userEvent.click(screen.getByRole('button', { name: 'fill jellyfin' }));
    await userEvent.click(screen.getByRole('button', { name: 'connect' }));

    await waitFor(() =>
      expect(connectJellyfinWithApiKey).toHaveBeenCalledWith({
        serverUrl: 'http://192.168.1.20:8096',
        serverName: 'Attic',
        apiKey: 'key-1',
        publicUrl: 'jellyfin.example.com',
      })
    );
  });

  it('moves the owner on to the import step for the server just added', async () => {
    connectJellyfinWithApiKey.mockResolvedValue({ serverId: 'jf-new' });
    render(<Connections />);

    await userEvent.click(screen.getByRole('button', { name: 'servers.addServer' }));
    await userEvent.click(screen.getByRole('button', { name: 'fill jellyfin' }));
    await userEvent.click(screen.getByRole('button', { name: 'connect' }));

    expect(await screen.findByText('import step for jf-new')).toBeInTheDocument();
  });

  it('closes the dialog for a member, who cannot import history', async () => {
    vi.mocked(useAuth).mockReturnValue({
      user: { role: 'admin' },
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);
    connectJellyfinWithApiKey.mockResolvedValue({ serverId: 'jf-new' });
    render(<Connections />);

    await userEvent.click(screen.getByRole('button', { name: 'servers.addServer' }));
    await userEvent.click(screen.getByRole('button', { name: 'fill jellyfin' }));
    await userEvent.click(screen.getByRole('button', { name: 'connect' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'connect' })).toBeNull());
    expect(screen.queryByText(/import step/)).toBeNull();
  });
});
