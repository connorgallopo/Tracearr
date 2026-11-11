import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Server, ServerConnectionStatus } from '@tracearr/shared';
import { ServerRow } from './ServerRow';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/components/settings/request-services', () => ({
  RequestServiceLine: () => <div>request service line</div>,
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
      onSetHistorical={vi.fn()}
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
        onSetHistorical={vi.fn()}
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

  it('carries the Seerr line only for callers that pass one', () => {
    renderRow();
    expect(screen.queryByText('request service line')).not.toBeInTheDocument();

    renderRow({ requestService: { service: undefined } });
    expect(screen.getByText('request service line')).toBeInTheDocument();
  });

  it('greys a historical row, badges it, hides the connection line and disables sync', () => {
    renderRow({ server: server({ historicalAt: '2026-09-01T12:00:00.000Z' }) });

    expect(screen.getByText('servers.historical')).toBeInTheDocument();
    expect(screen.getByText('servers.historicalSince:{"date":"Sep 1, 2026"}')).toBeInTheDocument();
    expect(screen.queryByText('servers.checkingConnection')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common:actions.sync' })).toBeDisabled();
    expect(screen.getByRole('listitem').querySelector('.opacity-60')).not.toBeNull();
  });

  it('offers Mark as historical on a live row and Resume on a historical one', async () => {
    const user = userEvent.setup();
    const onSetHistorical = vi.fn();
    const { unmount } = renderRow({ onSetHistorical, isOwner: true });

    await user.click(screen.getByRole('button', { name: 'servers.moreActions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'servers.markHistorical' }));
    expect(onSetHistorical).toHaveBeenCalledWith(true);
    unmount();

    renderRow({
      server: server({ historicalAt: '2026-09-01T12:00:00.000Z' }),
      onSetHistorical,
      isOwner: true,
    });
    await user.click(screen.getByRole('button', { name: 'servers.moreActions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'servers.resume' }));
    expect(onSetHistorical).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('button', { name: 'common:actions.remove' })).toBeInTheDocument();
  });

  it('hides the historical menu from a non-owner', () => {
    renderRow({ isOwner: false });

    expect(screen.queryByRole('button', { name: 'servers.moreActions' })).not.toBeInTheDocument();
  });

  it('says nothing about realtime for a Plex server', () => {
    renderRow({ server: server({ type: 'plex' }) });

    expect(screen.queryByText('servers.checkingConnection')).not.toBeInTheDocument();
  });

  it('shows tofa live over its own connection, with no plugin to set up', () => {
    renderRow({
      server: server({ type: 'tofa' }),
      connectionStatus: { mode: 'realtime' } as ServerConnectionStatus,
    });

    expect(screen.getByText('servers.realtimeActive')).toBeInTheDocument();
    expect(screen.getByText('servers.realtimeBuiltIn:{"server":"tofa"}')).toBeInTheDocument();
    expect(screen.queryByText('servers.setupRealtime')).not.toBeInTheDocument();
  });

  it('marks a tofa key that cannot stop streams, without a no-sign-in line', () => {
    renderRow({ server: server({ type: 'tofa', canStopStreams: false }), isOwner: true });

    expect(screen.queryByText('servers.noSignIn:{"server":"tofa"}')).not.toBeInTheDocument();
    expect(screen.getByText('servers.cannotStopStreams')).toBeInTheDocument();
  });
});
