import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Server, ServerConnectionStatus } from '@tracearr/shared';
import { ServerRow } from './ServerRow';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

function server(overrides: Partial<Server> = {}): Server {
  return {
    id: 'server-1',
    name: 'Basement Jellyfin',
    type: 'jellyfin',
    url: 'http://jelly.local:8096',
    color: '#3B82F6',
    createdAt: new Date('2026-01-15T00:00:00.000Z'),
    updatedAt: new Date('2026-01-15T00:00:00.000Z'),
    ...overrides,
  } as Server;
}

function renderRow(overrides: Partial<React.ComponentProps<typeof ServerRow>> = {}) {
  return render(
    <ServerRow
      server={server()}
      onSync={vi.fn()}
      onDelete={vi.fn()}
      onEdit={vi.fn()}
      {...overrides}
    />
  );
}

describe('ServerRow', () => {
  it('titles the row with the server name and links its url', () => {
    renderRow();

    expect(screen.getByText('Basement Jellyfin')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'http://jelly.local:8096' })).toHaveAttribute(
      'href',
      'http://jelly.local:8096'
    );
  });

  it('names every icon-only action', () => {
    renderRow();

    expect(screen.getByRole('button', { name: 'servers.editServer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common:actions.remove' })).toBeInTheDocument();
  });

  it('offers a named drag handle only when reordering is allowed', () => {
    const { rerender } = renderRow({ isDraggable: false });
    expect(screen.queryByRole('button', { name: 'servers.reorder' })).not.toBeInTheDocument();

    rerender(
      <ServerRow
        server={server()}
        onSync={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        isDraggable
      />
    );
    expect(screen.getByRole('button', { name: 'servers.reorder' })).toBeInTheDocument();
  });

  it('offers realtime setup on the warning token, not a hardcoded amber', () => {
    renderRow({
      connectionStatus: { mode: 'polling', pluginIssue: 'blocked' } as ServerConnectionStatus,
    });

    const trigger = screen.getByRole('button', { name: 'servers.realtimeError' });
    expect(trigger).toHaveClass('text-warning');
  });

  it('says nothing about realtime for a Plex server', () => {
    renderRow({ server: server({ type: 'plex' }) });

    expect(screen.queryByText('servers.checkingConnection')).not.toBeInTheDocument();
  });
});
