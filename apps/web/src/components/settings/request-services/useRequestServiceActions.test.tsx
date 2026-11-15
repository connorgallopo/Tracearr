import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RequestService, Server } from '@tracearr/shared';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TooltipProvider } from '@/components/ui/tooltip';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/hooks/queries', () => ({
  useUpdateRequestService: vi.fn(),
  useDeleteRequestService: vi.fn(),
  useSyncRequestService: vi.fn(),
}));

vi.mock('./LinkDialog', () => ({
  LinkDialog: ({ existing }: { existing?: RequestService }) => (
    <div>link dialog {existing?.id ?? 'new'}</div>
  ),
}));

import {
  useDeleteRequestService,
  useSyncRequestService,
  useUpdateRequestService,
} from '@/hooks/queries';
import { useRequestServiceActions } from './useRequestServiceActions';

const plex = {
  id: 'srv-1',
  name: 'Plex',
  type: 'plex',
  url: 'https://plex.example.com',
} as unknown as Server;

function service(overrides: Partial<RequestService> = {}): RequestService {
  return {
    id: 'rs-1',
    serverId: 'srv-1',
    type: 'seerr',
    name: 'Overseerr',
    url: 'https://seerr.example.com:5055',
    enabled: true,
    configStatus: 'ok',
    remoteServerId: 'remote-abc',
    version: '1.33.2',
    lastSyncAt: '2026-09-11T10:00:00.000Z',
    lastFullSyncAt: '2026-09-11T10:00:00.000Z',
    lastSyncError: null,
    counts: { requests: 42, unmatchedMedia: 2, unmatchedUsers: 1 },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-11T10:00:00.000Z',
    ...overrides,
  };
}

function Harness({
  server,
  requestService,
}: {
  server: Server;
  requestService: { service: RequestService | undefined } | undefined;
}) {
  const { fact, menuItems, dialogs } = useRequestServiceActions(
    server,
    requestService,
    (action) => action
  );
  return (
    <TooltipProvider>
      <div>{fact}</div>
      <DropdownMenu>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>{menuItems}</DropdownMenuContent>
      </DropdownMenu>
      {dialogs}
    </TooltipProvider>
  );
}

function renderFor(linked: RequestService | undefined, server = plex) {
  return render(<Harness server={server} requestService={{ service: linked }} />);
}

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'menu' }));
  return user;
}

const updateMutate = vi.fn();
const deleteMutate = vi.fn();
const syncMutate = vi.fn();

describe('useRequestServiceActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useUpdateRequestService).mockReturnValue({
      mutate: updateMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateRequestService>);
    vi.mocked(useDeleteRequestService).mockReturnValue({
      mutate: deleteMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useDeleteRequestService>);
    vi.mocked(useSyncRequestService).mockReturnValue({
      mutate: syncMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useSyncRequestService>);
  });

  it('offers the link affordance and opens the dialog when nothing is linked', async () => {
    renderFor(undefined);

    await userEvent.setup().click(screen.getByRole('button', { name: 'requests.link' }));

    expect(screen.getByText(/link dialog new/)).toBeInTheDocument();
  });

  it('offers nothing before the services query has answered', () => {
    render(<Harness server={plex} requestService={undefined} />);

    expect(screen.queryByRole('button', { name: 'requests.link' })).not.toBeInTheDocument();
  });

  it('names the service, its host, when it last synced and how many requests it holds', () => {
    renderFor(service());

    expect(screen.getByText('Overseerr')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'seerr.example.com:5055' })).toHaveAttribute(
      'href',
      'https://seerr.example.com:5055'
    );
    expect(screen.getByText(/requests\.syncedAgo/)).toBeInTheDocument();
    expect(screen.getByText('requests.counts.requests:{"count":42}')).toBeInTheDocument();
  });

  it('never shows the unmatched counts, whatever they are', () => {
    renderFor(service({ counts: { requests: 42, unmatchedMedia: 9, unmatchedUsers: 4 } }));

    expect(screen.queryByText(/unmatched/)).not.toBeInTheDocument();
  });

  it('shortens a branch build to its channel', () => {
    renderFor(service({ version: 'develop-4fc265b60b67796b7b688571bf30f0a513b8bcb6' }));

    expect(screen.getByText('develop')).toBeInTheDocument();
  });

  it('badges a failed sync and keeps the time of the last good one', () => {
    renderFor(service({ lastSyncError: 'connect ECONNREFUSED 10.0.0.9:5055' }));

    expect(screen.getByText('requests.syncFailed')).toBeInTheDocument();
    expect(screen.getByText(/requests\.syncedAgo/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'connect ECONNREFUSED 10.0.0.9:5055' })
    ).toBeInTheDocument();
  });

  it('drops the synced time when tofa reports requests turned off', () => {
    const tofa = { ...plex, name: 'Den', type: 'tofa' } as Server;
    renderFor(
      service({
        type: 'tofa',
        version: null,
        lastSyncError: 'Requests are turned off on this tofa server',
      }),
      tofa
    );

    expect(screen.getByText('requests.syncFailed')).toBeInTheDocument();
    expect(screen.queryByText(/requests\.syncedAgo/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Requests are turned off on this tofa server' })
    ).toBeInTheDocument();
  });

  it('queues a sync for this service', async () => {
    renderFor(service());
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: 'requests.syncRequestsNow' }));

    expect(syncMutate).toHaveBeenCalledWith('rs-1');
  });

  it('offers no request sync while paused, and resumes it', async () => {
    renderFor(service({ enabled: false }));
    expect(screen.getByText('requests.paused')).toBeInTheDocument();
    const user = await openMenu();

    expect(
      screen.queryByRole('menuitem', { name: 'requests.syncRequestsNow' })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'requests.resume' }));
    expect(updateMutate).toHaveBeenCalledWith({ id: 'rs-1', data: { enabled: true } });
  });

  it('pauses request sync from the menu', async () => {
    renderFor(service());
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: 'requests.pause' }));

    expect(updateMutate).toHaveBeenCalledWith({ id: 'rs-1', data: { enabled: false } });
  });

  it('opens the link dialog on the existing service to edit it', async () => {
    renderFor(service());
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: 'requests.dialog.titleEdit' }));

    expect(screen.getByText('link dialog rs-1')).toBeInTheDocument();
  });

  it('unlinks only after the confirmation', async () => {
    renderFor(service());
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: 'requests.unlinkSeerr' }));
    expect(deleteMutate).not.toHaveBeenCalled();

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('requests.confirmUnlink.title');
    await user.click(within(dialog).getByRole('button', { name: 'requests.unlink' }));

    expect(deleteMutate).toHaveBeenCalledWith('rs-1');
  });

  it('shows tofa requests with the pause switch and no link, edit or unlink', async () => {
    const tofa = { ...plex, name: 'Den', type: 'tofa' } as Server;
    renderFor(service({ type: 'tofa', name: 'Den', remoteServerId: null, version: null }), tofa);

    expect(screen.queryByText('Den')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    await openMenu();
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'requests.syncRequestsNow',
      'requests.pause',
    ]);
  });

  it('offers no Seerr link on a server whose requests are built in', () => {
    renderFor(undefined, { ...plex, type: 'tofa' } as Server);

    expect(screen.queryByRole('button', { name: 'requests.link' })).not.toBeInTheDocument();
  });
});
