import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ServerResourceDataPoint } from '@tracearr/shared';

vi.mock('@/lib/api', () => ({
  api: { servers: { locations: vi.fn(), setHistorical: vi.fn(), liveStats: vi.fn() } },
}));

import { api } from '@/lib/api';
import { useServerLiveStats, useServerLocations, useSetServerHistorical } from './useServers';

const mockLocations = vi.mocked(api.servers.locations);
const mockSetHistorical = vi.mocked(api.servers.setHistorical);
const liveStats = vi.mocked(api.servers.liveStats);

function wrapper(client: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

describe('useServerLocations', () => {
  it('refetches each time a server is opened, even when its cached locations are fresh', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 60_000, retry: false } },
    });
    client.setQueryData(['servers', 'locations', 'server-1'], { entries: [], syncPending: false });
    const saved = { effectiveFrom: null, lat: 1, lon: 2, city: null, region: null, country: 'US' };
    mockLocations.mockResolvedValue({ entries: [saved], syncPending: false });

    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useServerLocations(id),
      { initialProps: { id: undefined as string | undefined }, wrapper: wrapper(client) }
    );
    rerender({ id: 'server-1' });

    await waitFor(() => expect(result.current.isFetchedAfterMount).toBe(true));
    expect(mockLocations).toHaveBeenCalledWith('server-1');
    expect(result.current.data?.entries).toEqual([saved]);
  });
});

describe('useSetServerHistorical', () => {
  it('refetches the server list when the switch fails after the row was updated', async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    mockSetHistorical.mockRejectedValue(new Error('Internal Server Error'));

    const { result } = renderHook(() => useSetServerHistorical(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync({ id: 'server-1', historical: true }).catch(() => {});
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['servers', 'list'] });
  });
});

const NOW_MS = Date.parse('2026-11-21T18:00:00Z');
const NOW = NOW_MS / 1000;

function response(statistics: ServerResourceDataPoint[]) {
  return {
    serverId: 'silo-1',
    statistics,
    bandwidth: [],
    bandwidthSamples: [],
    bandwidthAccounts: [],
    bandwidthDevices: [],
    fetchedAt: new Date().toISOString(),
  };
}

const siloPoint = (at: number): ServerResourceDataPoint => ({
  at,
  timespan: 5,
  hostCpuUtilization: 3,
  processCpuUtilization: null,
  hostMemoryUtilization: 9,
  processMemoryUtilization: 3,
});

describe('useServerLiveStats', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('averages a server that reports no process CPU as no reading, not zero', async () => {
    liveStats.mockResolvedValue(response([siloPoint(NOW - 5), siloPoint(NOW)]));

    const { result } = renderHook(() => useServerLiveStats('silo-1'), {
      wrapper: wrapper(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    });

    await waitFor(() => expect(result.current.statisticsAverages).not.toBeNull());
    expect(result.current.statisticsAverages).toEqual({
      hostCpu: 3,
      processCpu: null,
      hostMemory: 9,
      processMemory: 3,
    });
  });

  it('charts the first point read after the empty-stats backoff, then polls at chart speed', async () => {
    liveStats.mockResolvedValueOnce(response([]));

    const { result } = renderHook(() => useServerLiveStats('silo-1'), {
      wrapper: wrapper(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    });
    await waitFor(() => expect(liveStats).toHaveBeenCalledTimes(1));

    liveStats.mockResolvedValue(response([siloPoint(NOW + 30)]));
    await act(() => vi.advanceTimersByTimeAsync(29_000));
    expect(liveStats).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await waitFor(() => expect(result.current.statistics).toHaveLength(1));

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(liveStats).toHaveBeenCalledTimes(3);
  });
});
