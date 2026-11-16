import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  OwnerLinkServer,
  RequestService,
  Server,
  ServerConnectionStatus,
} from '@tracearr/shared';

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

vi.mock('@/hooks/queries', () => ({
  useUpdateRequestService: vi.fn(),
  useDeleteRequestService: vi.fn(),
  useSyncRequestService: vi.fn(),
  useUnlinkOwnerAccount: vi.fn(),
}));

vi.mock('@/components/settings/request-services/LinkDialog', () => ({
  LinkDialog: () => <div>seerr link dialog</div>,
}));

vi.mock('./OwnerLinkDialog', () => ({
  OwnerLinkDialog: () => <div>owner link dialog</div>,
  TofaOwnerLinkDialog: () => <div>tofa owner link dialog</div>,
}));

vi.mock('./RealtimeSetupDialog', () => ({
  RealtimeSetupDialog: ({ mode }: { mode: string }) => <div>realtime dialog {mode}</div>,
}));

import {
  useDeleteRequestService,
  useSyncRequestService,
  useUnlinkOwnerAccount,
  useUpdateRequestService,
} from '@/hooks/queries';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useRestoreFocus } from '@/hooks/useRestoreFocus';
import { ServerRow } from './ServerRow';

function server(overrides: Partial<Server> = {}): Server {
  return {
    id: 'server-1',
    name: 'Basement Jellyfin',
    type: 'jellyfin',
    url: 'http://jelly.local:8096',
    color: '#3B82F6',
    createdAt: new Date('2026-01-15T12:00:00.000Z'),
    updatedAt: new Date('2026-01-15T12:00:00.000Z'),
    ...overrides,
  } as Server;
}

function service(overrides: Partial<RequestService> = {}): RequestService {
  return {
    id: 'rs-1',
    serverId: 'server-1',
    type: 'seerr',
    name: 'Seerr',
    url: 'https://seerr.lan',
    enabled: true,
    configStatus: 'ok',
    remoteServerId: 'remote-abc',
    version: '2.7.0',
    lastSyncAt: '2026-09-11T10:00:00.000Z',
    lastFullSyncAt: '2026-09-11T10:00:00.000Z',
    lastSyncError: null,
    counts: { requests: 312, unmatchedMedia: 0, unmatchedUsers: 0 },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-11T10:00:00.000Z',
    ...overrides,
  };
}

function ownerLink(linked: OwnerLinkServer['linked']): OwnerLinkServer {
  return { serverId: 'server-1', linked, candidates: [] };
}

function status(overrides: Partial<ServerConnectionStatus>): ServerConnectionStatus {
  return {
    mode: 'polling',
    pluginVersion: null,
    pluginUpdateAvailable: false,
    pluginIssue: null,
    ...overrides,
  } as ServerConnectionStatus;
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

async function openMenu(name = 'Basement Jellyfin') {
  const user = userEvent.setup();
  await user.click(
    screen.getByRole('button', { name: `servers.actionsFor:${JSON.stringify({ name })}` })
  );
  return user;
}

function menuItems() {
  return screen.getAllByRole('menuitem').map((item) => item.textContent);
}

const unlinkMutate = vi.fn();
const syncMutate = vi.fn();

describe('ServerRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useUpdateRequestService).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateRequestService>);
    vi.mocked(useDeleteRequestService).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useDeleteRequestService>);
    vi.mocked(useSyncRequestService).mockReturnValue({
      mutate: syncMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useSyncRequestService>);
    vi.mocked(useUnlinkOwnerAccount).mockReturnValue({
      mutate: unlinkMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useUnlinkOwnerAccount>);
  });

  it('puts the url, version and added date on one plain meta line', () => {
    renderRow({ server: server({ version: '10.11.2' }) });

    expect(screen.getByText('Basement Jellyfin')).toBeInTheDocument();
    expect(
      screen.getByText(
        'http://jelly.local:8096 · servers.version.installed:{"version":"10.11.2"} · servers.added:{"date":"Jan 15, 2026"}'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('names the sync button and the menu after the server, and syncs', async () => {
    const onSync = vi.fn();
    renderRow({ onSync });

    await userEvent
      .setup()
      .click(
        screen.getByRole('button', { name: 'servers.syncNamed:{"name":"Basement Jellyfin"}' })
      );
    expect(onSync).toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'servers.actionsFor:{"name":"Basement Jellyfin"}' })
    ).toBeInTheDocument();
  });

  it('says Syncing while the server sync runs', () => {
    renderRow({ isSyncing: true });

    expect(screen.getByRole('button', { name: 'servers.syncing' })).toBeDisabled();
  });

  it('puts touch-none on the drag handle only, and offers it only when reordering is allowed', () => {
    const { unmount } = renderRow({ isDraggable: false });
    expect(screen.queryByRole('button', { name: 'servers.reorder' })).not.toBeInTheDocument();
    unmount();

    renderRow({ isDraggable: true });
    expect(screen.getByRole('button', { name: 'servers.reorder' })).toHaveClass('touch-none');
    expect(screen.getByRole('listitem')).not.toHaveClass('touch-none');
  });

  describe('menu', () => {
    it('holds edit, open, the request items and historical for a tofa row', async () => {
      renderRow({
        server: server({ name: 'Den', type: 'tofa' }),
        isOwner: true,
        requestService: { service: service({ type: 'tofa', name: 'Den', version: null }) },
        ownerLink: ownerLink({ serverUserId: 'su-1', username: 'gallapagos', canUnlink: false }),
      });
      await openMenu('Den');

      expect(menuItems()).toEqual([
        'common:actions.edit',
        'servers.openServer',
        'requests.syncRequestsNow',
        'requests.pause',
        'servers.markHistorical',
        'common:actions.remove',
      ]);
      expect(screen.getAllByRole('separator')).toHaveLength(3);
    });

    it('adds the Seerr items for a Plex row with Seerr linked', async () => {
      renderRow({
        server: server({ name: 'Living Room Plex', type: 'plex' }),
        isOwner: true,
        requestService: { service: service() },
      });
      await openMenu('Living Room Plex');

      expect(menuItems()).toEqual([
        'common:actions.edit',
        'servers.openServer',
        'requests.syncRequestsNow',
        'requests.dialog.titleEdit',
        'requests.pause',
        'requests.unlinkSeerr',
        'servers.markHistorical',
        'common:actions.remove',
      ]);
    });

    it('keeps setup out of the menu for a Jellyfin row with nothing linked', async () => {
      renderRow({
        isOwner: true,
        requestService: { service: undefined },
        ownerLink: ownerLink(null),
      });
      await openMenu();

      expect(menuItems()).toEqual([
        'common:actions.edit',
        'servers.openServer',
        'servers.markHistorical',
        'common:actions.remove',
      ]);
      expect(screen.getAllByRole('separator')).toHaveLength(2);
    });

    it('unlinks a linked account from the menu after the confirm', async () => {
      renderRow({
        isOwner: true,
        ownerLink: ownerLink({ serverUserId: 'su-1', username: 'cgallopo', canUnlink: true }),
      });
      const user = await openMenu();

      expect(menuItems()).toEqual([
        'common:actions.edit',
        'servers.openServer',
        'servers.ownerAccount.unlinkNamed:{"username":"cgallopo"}',
        'servers.markHistorical',
        'common:actions.remove',
      ]);
      await user.click(
        screen.getByRole('menuitem', {
          name: 'servers.ownerAccount.unlinkNamed:{"username":"cgallopo"}',
        })
      );
      expect(unlinkMutate).not.toHaveBeenCalled();
      const dialog = screen.getByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'servers.ownerAccount.unlink' }));
      expect(unlinkMutate).toHaveBeenCalledWith('su-1');
    });

    it('offers Resume on a historical row', async () => {
      const onSetHistorical = vi.fn();
      renderRow({
        server: server({ historicalAt: '2026-09-01T12:00:00.000Z' }),
        isOwner: true,
        onSetHistorical,
      });
      const user = await openMenu();

      expect(menuItems()).toEqual([
        'common:actions.edit',
        'servers.openServer',
        'servers.resume',
        'common:actions.remove',
      ]);
      await user.click(screen.getByRole('menuitem', { name: 'servers.resume' }));
      expect(onSetHistorical).toHaveBeenCalledWith(false);
    });

    it('gives a non-owner edit, open and remove only', async () => {
      renderRow({ isOwner: false });
      await openMenu();

      expect(menuItems()).toEqual([
        'common:actions.edit',
        'servers.openServer',
        'common:actions.remove',
      ]);
    });

    it('calls what the row actions called before they moved into the menu', async () => {
      const onEdit = vi.fn();
      const onDelete = vi.fn();
      const onSetHistorical = vi.fn();
      renderRow({ isOwner: true, onEdit, onDelete, onSetHistorical });

      let user = await openMenu();
      expect(screen.getByRole('menuitem', { name: 'servers.openServer' })).toHaveAttribute(
        'href',
        'http://jelly.local:8096'
      );
      await user.click(screen.getByRole('menuitem', { name: 'common:actions.edit' }));
      expect(onEdit).toHaveBeenCalled();

      user = await openMenu();
      await user.click(screen.getByRole('menuitem', { name: 'servers.markHistorical' }));
      expect(onSetHistorical).toHaveBeenCalledWith(true);

      user = await openMenu();
      await user.click(screen.getByRole('menuitem', { name: 'common:actions.remove' }));
      expect(onDelete).toHaveBeenCalled();
    });

    it('returns focus to the menu trigger when a dialog it opened closes', async () => {
      function WithEditDialog() {
        const [open, setOpen] = useState(false);
        const focusHandlers = useRestoreFocus();
        return (
          <>
            <ServerRow
              server={server()}
              onSync={vi.fn()}
              onDelete={vi.fn()}
              onEdit={() => setOpen(true)}
              onSetHistorical={vi.fn()}
            />
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogContent {...focusHandlers}>
                <DialogTitle>edit server dialog</DialogTitle>
                <DialogDescription>edit</DialogDescription>
              </DialogContent>
            </Dialog>
          </>
        );
      }
      render(<WithEditDialog />);
      const user = await openMenu();

      await user.click(screen.getByRole('menuitem', { name: 'common:actions.edit' }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: 'servers.actionsFor:{"name":"Basement Jellyfin"}' })
        )
      );
    });

    it('returns focus to the menu trigger when a confirm it opened is cancelled', async () => {
      renderRow({ isOwner: true, requestService: { service: service() } });
      const user = await openMenu();

      await user.click(screen.getByRole('menuitem', { name: 'requests.unlinkSeerr' }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'common:actions.cancel' }));

      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: 'servers.actionsFor:{"name":"Basement Jellyfin"}' })
        )
      );
    });

    it('queues the request sync from the row menu', async () => {
      renderRow({ isOwner: true, requestService: { service: service() } });
      const user = await openMenu();

      await user.click(screen.getByRole('menuitem', { name: 'requests.syncRequestsNow' }));
      expect(syncMutate).toHaveBeenCalledWith('rs-1');
    });
  });

  describe('facts', () => {
    it('offers setup links on the empty Requests and Your account facts', async () => {
      const user = userEvent.setup();
      renderRow({
        isOwner: true,
        requestService: { service: undefined },
        ownerLink: ownerLink(null),
      });

      expect(screen.getByText('requests.label').tagName).toBe('DT');
      await user.click(screen.getByRole('button', { name: 'requests.link' }));
      expect(screen.getByText('seerr link dialog')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'servers.ownerAccount.linkYours' }));
      expect(screen.getByText('owner link dialog')).toBeInTheDocument();
    });

    it('badges the tofa sign-in that stays linked instead of offering an unlink', () => {
      renderRow({
        server: server({ type: 'tofa' }),
        isOwner: true,
        ownerLink: ownerLink({ serverUserId: 'su-1', username: 'gallapagos', canUnlink: false }),
      });

      expect(screen.getByText('gallapagos')).toBeInTheDocument();
      expect(
        screen.getByText('servers.ownerAccount.signInBadge:{"server":"tofa"}')
      ).toHaveAttribute('tabindex', '0');
    });

    it('shows no facts to a non-owner', () => {
      renderRow();

      expect(screen.queryByText('requests.label')).not.toBeInTheDocument();
      expect(screen.queryByText('servers.ownerAccount.label')).not.toBeInTheDocument();
    });
  });

  describe('status badges', () => {
    it('shows Checking connection until a Jellyfin status arrives', () => {
      renderRow();

      expect(screen.getByText('servers.checkingConnection')).toBeInTheDocument();
    });

    it('badges Jellyfin real-time with the plugin version in a keyboard-reachable tooltip', async () => {
      renderRow({ connectionStatus: status({ mode: 'realtime', pluginVersion: '1.4.0' }) });

      const badge = screen.getByText('servers.realtime');
      await userEvent.setup().tab();
      expect(badge).toHaveFocus();
      expect(
        (await screen.findAllByText('servers.realtimePlugin:{"version":"1.4.0"}')).length
      ).toBeGreaterThan(0);
      expect(screen.queryByRole('button', { name: 'servers.setupRealtimeShort' })).toBeNull();
    });

    it('badges polling and offers the one setup link', async () => {
      renderRow({ connectionStatus: status({ mode: 'polling' }) });

      expect(screen.getByText('servers.pollingMode')).toBeInTheDocument();
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'servers.setupRealtimeShort' }));
      expect(screen.getByText('realtime dialog setup')).toBeInTheDocument();
    });

    it('turns a plugin issue into a danger badge that opens setup', async () => {
      renderRow({ connectionStatus: status({ mode: 'polling', pluginIssue: 'blocked' }) });

      const badge = screen.getByRole('button', { name: 'servers.realtimeError' });
      expect(badge).toHaveClass('text-destructive');
      await userEvent.setup().click(badge);
      expect(screen.getByText('realtime dialog setup')).toBeInTheDocument();
    });

    it('keeps the plugin version in a tooltip on the error and update badges', async () => {
      renderRow({
        connectionStatus: status({
          mode: 'polling',
          pluginIssue: 'blocked',
          pluginVersion: '1.4.0',
          pluginUpdateAvailable: true,
        }),
      });
      const user = userEvent.setup();

      await user.tab();
      expect(screen.getByRole('button', { name: 'servers.realtimeError' })).toHaveFocus();
      expect(
        (await screen.findAllByText('servers.realtimePlugin:{"version":"1.4.0"}')).length
      ).toBeGreaterThan(0);
      await user.tab();
      expect(screen.getByRole('button', { name: 'servers.pluginUpdateAvailable' })).toHaveFocus();
      expect(
        (await screen.findAllByText('servers.realtimePlugin:{"version":"1.4.0"}')).length
      ).toBeGreaterThan(0);
    });

    it('opens the update dialog from the plugin update badge', async () => {
      renderRow({
        connectionStatus: status({ mode: 'realtime', pluginUpdateAvailable: true }),
      });

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'servers.pluginUpdateAvailable' }));
      expect(screen.getByText('realtime dialog update')).toBeInTheDocument();
    });

    it('badges tofa real-time with no plugin wording', () => {
      renderRow({
        server: server({ type: 'tofa' }),
        connectionStatus: status({ mode: 'realtime' }),
      });

      expect(screen.getByText('servers.realtime')).not.toHaveAttribute('tabindex');
      expect(screen.queryByText(/realtimeBuiltIn|setupRealtime/)).not.toBeInTheDocument();
    });

    it('says nothing about real-time for a Plex server', () => {
      renderRow({ server: server({ type: 'plex' }) });

      expect(screen.queryByText('servers.checkingConnection')).not.toBeInTheDocument();
      expect(screen.queryByText('servers.realtime')).not.toBeInTheDocument();
    });

    it('badges an available server update', () => {
      renderRow({ server: server({ version: '10.11.1', latestVersion: '10.11.2' }) });

      expect(
        screen.getByText('servers.version.updateBadge:{"version":"10.11.2"}')
      ).toBeInTheDocument();
    });

    it('sends a key that cannot stop streams to Edit', async () => {
      const onEdit = vi.fn();
      renderRow({ server: server({ type: 'tofa', canStopStreams: false }), onEdit });

      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: /servers\.cannotStopStreamsBadge/ }));
      expect(onEdit).toHaveBeenCalled();
    });

    it('badges a historical row, dims its icon, hides real-time and disables sync', () => {
      renderRow({
        server: server({ historicalAt: '2026-09-01T12:00:00.000Z' }),
        connectionStatus: status({ mode: 'realtime' }),
      });

      expect(screen.getByText('servers.historical')).toBeInTheDocument();
      expect(
        screen.getByText(/servers\.historicalSince:\{"date":"Sep 1, 2026"\}/)
      ).toBeInTheDocument();
      expect(screen.queryByText(/servers\.added/)).not.toBeInTheDocument();
      expect(screen.queryByText('servers.realtime')).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'servers.syncNamed:{"name":"Basement Jellyfin"}' })
      ).toBeDisabled();
      expect(screen.getByRole('listitem').querySelector('.opacity-60')).not.toBeNull();
    });
  });
});
