import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RequestService, Server } from '@tracearr/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/hooks/queries', () => ({
  useServers: vi.fn(),
  useRequestServices: vi.fn(),
  useCreateRequestService: vi.fn(),
  useUpdateRequestService: vi.fn(),
  useDeleteRequestService: vi.fn(),
  useSyncRequestService: vi.fn(),
  useTestRequestService: vi.fn(),
}));

import {
  useServers,
  useRequestServices,
  useUpdateRequestService,
  useDeleteRequestService,
  useSyncRequestService,
} from '@/hooks/queries';
import { RequestServicesManager } from './RequestServicesManager';

const servers = [
  {
    id: 'srv-1',
    name: 'Plex',
    type: 'plex',
    url: 'https://plex.example.com',
    machineIdentifier: 'local-abc',
  },
  {
    id: 'srv-2',
    name: 'Jellyfin',
    type: 'jellyfin',
    url: 'https://jf.example.com',
    machineIdentifier: 'local-def',
  },
] as unknown as Server[];

function service(overrides: Partial<RequestService> = {}): RequestService {
  return {
    id: 'rs-1',
    serverId: 'srv-1',
    type: 'seerr',
    name: 'Overseerr',
    url: 'https://seerr.example.com',
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

function mockQueries(services: RequestService[]) {
  vi.mocked(useServers).mockReturnValue({
    data: servers,
    isLoading: false,
  } as unknown as ReturnType<typeof useServers>);
  vi.mocked(useRequestServices).mockReturnValue({
    data: services,
    isLoading: false,
  } as unknown as ReturnType<typeof useRequestServices>);
}

describe('RequestServicesManager', () => {
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
    mockQueries([service()]);
  });

  it('lists one row per server, linked or not', () => {
    render(<RequestServicesManager />);

    expect(screen.getByText('Plex')).toBeInTheDocument();
    expect(screen.getByText('Jellyfin')).toBeInTheDocument();

    expect(screen.getByText('https://seerr.example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'requests.syncNow' })).toBeInTheDocument();

    expect(screen.getByText('requests.notLinked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'requests.link' })).toBeInTheDocument();
  });

  it('shows the counts and the needs-key badge when the stored key cannot be read', () => {
    mockQueries([service({ configStatus: 'reencrypt' })]);

    render(<RequestServicesManager />);

    expect(screen.getByText(/requests.counts.requests.*42/)).toBeInTheDocument();
    expect(screen.getByText('requests.needsKey')).toBeInTheDocument();
  });

  it('reports the last sync failure under the row', () => {
    mockQueries([service({ lastSyncError: 'connect ECONNREFUSED' })]);

    render(<RequestServicesManager />);

    expect(screen.getByText(/connect ECONNREFUSED/)).toBeInTheDocument();
  });

  it('leaves the time out of the failure line when the service has never synced', () => {
    mockQueries([service({ lastSyncAt: null, lastSyncError: 'connect ECONNREFUSED' })]);

    render(<RequestServicesManager />);

    expect(screen.getByText(/requests.lastErrorNoTime/)).toBeInTheDocument();
  });

  it('flips the enabled switch through the update mutation', async () => {
    render(<RequestServicesManager />);

    await userEvent.setup().click(screen.getByRole('switch'));

    expect(updateMutate).toHaveBeenCalledWith({ id: 'rs-1', data: { enabled: false } });
  });

  it('queues a sync for that service', async () => {
    render(<RequestServicesManager />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'requests.syncNow' }));

    expect(syncMutate).toHaveBeenCalledWith('rs-1');
  });

  it('deletes the link only after the unlink confirmation', async () => {
    const user = userEvent.setup();
    render(<RequestServicesManager />);

    await user.click(screen.getByRole('button', { name: 'requests.unlink' }));
    expect(deleteMutate).not.toHaveBeenCalled();

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('requests.confirmUnlink.title');
    await user.click(within(dialog).getByRole('button', { name: 'requests.unlink' }));

    expect(deleteMutate).toHaveBeenCalledWith('rs-1');
  });
});
