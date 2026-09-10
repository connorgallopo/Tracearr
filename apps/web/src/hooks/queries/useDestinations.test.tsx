import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type * as ApiModule from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const { ApiError } = await vi.importActual<typeof ApiModule>('@/lib/api');
  return {
    api: {
      destinations: {
        list: vi.fn(),
        create: vi.fn(),
        remove: vi.fn(),
        test: vi.fn(),
        testUnsaved: vi.fn(),
      },
    },
    ApiError,
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

import { api, ApiError } from '@/lib/api';
import { toast } from 'sonner';
import {
  useCreateDestination,
  useDeleteDestination,
  useDestinations,
  useTestDestination,
  useTestUnsavedDestination,
} from './useDestinations';

const mockList = vi.mocked(api.destinations.list);
const mockCreate = vi.mocked(api.destinations.create);
const mockRemove = vi.mocked(api.destinations.remove);
const mockTestSaved = vi.mocked(api.destinations.test);
const mockTestUnsaved = vi.mocked(api.destinations.testUnsaved);
const mockToastError = vi.mocked(toast.error);
const mockToastSuccess = vi.mocked(toast.success);

function wrapper(client: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

describe('useDestinations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives up after one 403 instead of retrying for every non-owner', async () => {
    mockList.mockRejectedValue(new ApiError('Forbidden', 403));

    const client = new QueryClient();
    const { result } = renderHook(() => useDestinations(), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it('does not fetch while disabled', () => {
    const client = new QueryClient();
    renderHook(() => useDestinations(false), { wrapper: wrapper(client) });

    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('destination mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invalidates the list after a create', async () => {
    mockCreate.mockResolvedValueOnce({ id: 'd1' } as Awaited<
      ReturnType<typeof api.destinations.create>
    >);

    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => useCreateDestination(), { wrapper: wrapper(client) });

    result.current.mutate({
      name: 'Discord',
      type: 'discord',
      config: { webhookUrl: 'https://discord.com/api/webhooks/x' },
      events: [],
      enabled: true,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['destinations'] });
  });

  it('names the blocking rules when a delete comes back 409', async () => {
    mockRemove.mockRejectedValueOnce(
      new ApiError('Used by 2 rule(s)', 409, { rules: ['No 4K transcodes', 'Household limit'] })
    );

    const client = new QueryClient();
    const { result } = renderHook(() => useDeleteDestination(), { wrapper: wrapper(client) });

    result.current.mutate('d1');

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockToastError).toHaveBeenCalledWith(
      'toast.error.destinationInUse:{"rules":"No 4K transcodes, Household limit"}'
    );
  });

  it('falls back to the plain failure toast for any other delete error', async () => {
    mockRemove.mockRejectedValueOnce(new ApiError('Not Found', 404));

    const client = new QueryClient();
    const { result } = renderHook(() => useDeleteDestination(), { wrapper: wrapper(client) });

    result.current.mutate('d1');

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockToastError).toHaveBeenCalledWith(
      'toast.error.destinationDeleteFailed:{"error":"Not Found"}'
    );
  });

  it('names the blocking newsletters when a delete comes back 409 with newsletters', async () => {
    mockRemove.mockRejectedValueOnce(
      new ApiError('Used by 2 newsletter(s)', 409, { newsletters: ['Weekly', 'Monthly'] })
    );

    const client = new QueryClient();
    const { result } = renderHook(() => useDeleteDestination(), { wrapper: wrapper(client) });

    result.current.mutate('d1');

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockToastError).toHaveBeenCalledWith(
      'toast.error.destinationUsedByNewsletters:{"names":"Weekly, Monthly"}'
    );
  });

  it('says where a saved test went when the server names an address', async () => {
    mockTestSaved.mockResolvedValueOnce({ success: true, sentTo: 'plex@example.com' });

    const client = new QueryClient();
    const { result } = renderHook(() => useTestDestination(), { wrapper: wrapper(client) });

    result.current.mutate('d1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockToastSuccess).toHaveBeenCalledWith(
      'toast.success.destinationTestSentTo:{"address":"plex@example.com"}'
    );
  });

  it('keeps the plain toast for an unsaved test that names no address', async () => {
    mockTestUnsaved.mockResolvedValueOnce({ success: true });

    const client = new QueryClient();
    const { result } = renderHook(() => useTestUnsavedDestination(), {
      wrapper: wrapper(client),
    });

    result.current.mutate({ type: 'discord', config: { webhookUrl: 'https://x' } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockToastSuccess).toHaveBeenCalledWith('toast.success.destinationTestSent');
  });
});
