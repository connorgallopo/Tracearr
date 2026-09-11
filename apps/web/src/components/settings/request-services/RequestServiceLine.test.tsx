import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RequestService, Server } from '@tracearr/shared';
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
import { RequestServiceLine } from './RequestServiceLine';

const server = {
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

const updateMutate = vi.fn();
const deleteMutate = vi.fn();
const syncMutate = vi.fn();

function renderLine(linked: RequestService | undefined) {
  return render(
    <TooltipProvider>
      <RequestServiceLine server={server} service={linked} />
    </TooltipProvider>
  );
}

const MENU = 'requests.menuLabel:{"server":"Plex"}';

describe('RequestServiceLine', () => {
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
    renderLine(undefined);

    expect(screen.getByText('requests.label')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'requests.link' }));

    expect(screen.getByText(/link dialog new/)).toBeInTheDocument();
  });

  it('names the service, its host, when it last synced and how many requests it holds', () => {
    renderLine(service());

    expect(screen.getByText('Overseerr')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'seerr.example.com:5055' })).toHaveAttribute(
      'href',
      'https://seerr.example.com:5055'
    );
    expect(screen.getByText(/requests\.syncedAgo/)).toBeInTheDocument();
    expect(screen.getByText('requests.counts.requests:{"count":42}')).toBeInTheDocument();
  });

  it('says nothing about unmatched rows when there are none', () => {
    renderLine(service({ counts: { requests: 42, unmatchedMedia: 0, unmatchedUsers: 0 } }));

    expect(screen.queryByText(/unmatched/)).not.toBeInTheDocument();
  });

  it('puts unmatched rows on the warning token', () => {
    renderLine(service());

    expect(screen.getByText(/unmatchedMedia/)).toHaveClass('text-warning');
    expect(screen.getByText(/unmatchedUsers/)).toHaveClass('text-warning');
  });

  it('shortens a branch build to its channel', () => {
    renderLine(service({ version: 'develop-4fc265b60b67796b7b688571bf30f0a513b8bcb6' }));

    expect(screen.getByText('develop')).toBeInTheDocument();
  });

  it('queues a sync for this service', async () => {
    const user = userEvent.setup();
    renderLine(service());

    await user.click(screen.getByRole('button', { name: MENU }));
    await user.click(screen.getByRole('menuitem', { name: 'requests.syncNow' }));

    expect(syncMutate).toHaveBeenCalledWith('rs-1');
  });

  it('flips the enabled flag from the menu', async () => {
    const user = userEvent.setup();
    renderLine(service());

    await user.click(screen.getByRole('button', { name: MENU }));
    await user.click(screen.getByRole('menuitem', { name: 'requests.disable' }));

    expect(updateMutate).toHaveBeenCalledWith({ id: 'rs-1', data: { enabled: false } });
  });

  it('unlinks only after the confirmation', async () => {
    const user = userEvent.setup();
    renderLine(service());

    await user.click(screen.getByRole('button', { name: MENU }));
    await user.click(screen.getByRole('menuitem', { name: 'requests.unlink' }));
    expect(deleteMutate).not.toHaveBeenCalled();

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('requests.confirmUnlink.title');
    await user.click(within(dialog).getByRole('button', { name: 'requests.unlink' }));

    expect(deleteMutate).toHaveBeenCalledWith('rs-1');
  });
});
