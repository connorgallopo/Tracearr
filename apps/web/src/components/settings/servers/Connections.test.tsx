import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DragEndEvent } from '@dnd-kit/core';
import type { Server } from '@tracearr/shared';
import { Connections } from './Connections';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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

vi.mock('@/components/settings/servers/ServerRow', () => ({
  ServerRow: ({ server, onDelete }: { server: Server; onDelete: () => void }) => (
    <div>
      {server.name}
      <button onClick={onDelete}>remove-{server.id}</button>
    </div>
  ),
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
  tokenStorage: { setTokens: vi.fn() },
}));

vi.mock('@/components/settings/servers/AddServerDialog', () => ({
  AddServerDialog: (props: {
    open: boolean;
    onServerTypeChange: (type: 'jellyfin') => void;
    onServerUrlChange: (value: string) => void;
    onServerNameChange: (value: string) => void;
    onApiKeyChange: (value: string) => void;
    onPublicUrlChange: (value: string) => void;
    onConnect: () => void;
  }) =>
    props.open ? (
      <div>
        <button
          onClick={() => {
            props.onServerTypeChange('jellyfin');
            props.onServerUrlChange('http://192.168.1.20:8096');
            props.onServerNameChange('Attic');
            props.onApiKeyChange('key-1');
            props.onPublicUrlChange(' jellyfin.example.com ');
          }}
        >
          fill jellyfin
        </button>
        <button onClick={props.onConnect}>connect</button>
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
const reorderMutate = vi.fn();
const invalidateQueries = vi.fn();

vi.mock('@/hooks/queries', () => ({
  useDeleteServer: vi.fn(() => ({ mutate: deleteMutate, isPending: false })),
  useReorderServers: vi.fn(() => ({ mutate: reorderMutate, isPending: false })),
  useServers: vi.fn(),
  useSyncServer: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdateServer: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return { ...actual, useQueryClient: () => ({ invalidateQueries }) };
});

import { useServers } from '@/hooks/queries';
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
});
