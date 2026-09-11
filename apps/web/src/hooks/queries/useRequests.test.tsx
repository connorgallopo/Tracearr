import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api', () => ({
  api: {
    requestServices: {
      list: vi.fn(),
      test: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      sync: vi.fn(),
    },
    library: { media: { requests: vi.fn() } },
    users: { requests: vi.fn() },
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';
import {
  REQUESTS_KEY,
  useMediaRequests,
  useUserRequests,
  useRequestServices,
  useTestRequestService,
  useCreateRequestService,
  useUpdateRequestService,
  useDeleteRequestService,
  useSyncRequestService,
} from './useRequests';

const mockServicesList = vi.mocked(api.requestServices.list);
const mockServicesTest = vi.mocked(api.requestServices.test);
const mockServicesCreate = vi.mocked(api.requestServices.create);
const mockServicesUpdate = vi.mocked(api.requestServices.update);
const mockServicesRemove = vi.mocked(api.requestServices.remove);
const mockServicesSync = vi.mocked(api.requestServices.sync);
const mockMediaRequests = vi.mocked(api.library.media.requests);
const mockUserRequests = vi.mocked(api.users.requests);
const mockToastError = vi.mocked(toast.error);
const mockToastSuccess = vi.mocked(toast.success);

function wrapper(client: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

describe('useMediaRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches requests for a media id and server scope', async () => {
    mockMediaRequests.mockResolvedValueOnce({ data: [] });

    const client = new QueryClient();
    const { result } = renderHook(() => useMediaRequests('m1', ['s2', 's1']), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockMediaRequests).toHaveBeenCalledWith('m1', ['s2', 's1']);
  });

  it('does not fetch without an id', () => {
    const client = new QueryClient();
    renderHook(() => useMediaRequests('', []), { wrapper: wrapper(client) });

    expect(mockMediaRequests).not.toHaveBeenCalled();
  });
});

describe('useUserRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches requests for a user with paging', async () => {
    mockUserRequests.mockResolvedValueOnce({
      data: [],
      total: 0,
      page: 1,
      pageSize: 5,
      summary: { total: 0, approvalRate: null, completed: 0, neverWatched: 0, medianWaitMs: null },
    });

    const client = new QueryClient();
    const { result } = renderHook(() => useUserRequests('u1', { page: 1, pageSize: 5 }), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockUserRequests).toHaveBeenCalledWith('u1', { page: 1, pageSize: 5 });
  });
});

describe('useRequestServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives up after one 403 instead of retrying for every non-owner', async () => {
    mockServicesList.mockRejectedValue(new Error('Forbidden'));

    const client = new QueryClient();
    const { result } = renderHook(() => useRequestServices(), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockServicesList).toHaveBeenCalledTimes(1);
  });
});

describe('request service mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invalidates requests and toasts after a test call', async () => {
    mockServicesTest.mockResolvedValueOnce({
      applicationTitle: 'Overseerr',
      version: '1.0.0',
      mediaServerType: 'plex',
      remoteServerId: 'rid',
      matchedServerId: 's1',
    });

    const client = new QueryClient();
    const { result } = renderHook(() => useTestRequestService(), { wrapper: wrapper(client) });

    result.current.mutate({ url: 'https://seerr.example', apiKey: 'k' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockServicesTest).toHaveBeenCalledWith({ url: 'https://seerr.example', apiKey: 'k' });
  });

  it('invalidates the requests prefix and toasts saved after a create', async () => {
    mockServicesCreate.mockResolvedValueOnce({ id: 'rs1' } as Awaited<
      ReturnType<typeof api.requestServices.create>
    >);

    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => useCreateRequestService(), { wrapper: wrapper(client) });

    result.current.mutate({ serverId: 's1', url: 'https://seerr.example', apiKey: 'k' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: REQUESTS_KEY });
    expect(mockToastSuccess).toHaveBeenCalledWith('requests.toast.saved');
  });

  it('toasts saved after an update', async () => {
    mockServicesUpdate.mockResolvedValueOnce({ id: 'rs1' } as Awaited<
      ReturnType<typeof api.requestServices.update>
    >);

    const client = new QueryClient();
    const { result } = renderHook(() => useUpdateRequestService(), { wrapper: wrapper(client) });

    result.current.mutate({ id: 'rs1', data: { enabled: false } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockToastSuccess).toHaveBeenCalledWith('requests.toast.saved');
  });

  it('toasts removed after a delete', async () => {
    mockServicesRemove.mockResolvedValueOnce(undefined);

    const client = new QueryClient();
    const { result } = renderHook(() => useDeleteRequestService(), { wrapper: wrapper(client) });

    result.current.mutate('rs1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockToastSuccess).toHaveBeenCalledWith('requests.toast.removed');
  });

  it('toasts sync started after a sync', async () => {
    mockServicesSync.mockResolvedValueOnce({ jobId: 'j1' });

    const client = new QueryClient();
    const { result } = renderHook(() => useSyncRequestService(), { wrapper: wrapper(client) });

    result.current.mutate('rs1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockToastSuccess).toHaveBeenCalledWith('requests.toast.syncStarted');
  });

  it('toasts the failure message on error', async () => {
    mockServicesSync.mockRejectedValueOnce(new Error('offline'));

    const client = new QueryClient();
    const { result } = renderHook(() => useSyncRequestService(), { wrapper: wrapper(client) });

    result.current.mutate('rs1');

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockToastError).toHaveBeenCalledWith('requests.toast.failed:{"error":"offline"}');
  });
});
