import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  SERVER_STATS_CONFIG,
  BANDWIDTH_STATS_CONFIG,
  liveStatsRetentionSeconds,
  type Server,
  type ServerResourceDataPoint,
  type ServerBandwidthDataPoint,
} from '@tracearr/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useMultiServerQuery } from '@/hooks/useMultiServerQuery';
import { useRef, useCallback, useEffect } from 'react';

export function useServers() {
  return useQuery({
    queryKey: ['servers', 'list'],
    queryFn: api.servers.list,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useCreateServer() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { name: string; type: string; url: string; token: string }) =>
      api.servers.create(data),
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['servers', 'list'] });
      toast.success(t('toast.success.serverAdded.title'), {
        description: t('toast.success.serverAdded.message', { name: variables.name }),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.serverAddFailed'), { description: error.message });
    },
  });
}

export function useDeleteServer() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.servers.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['servers', 'list'] });
      toast.success(t('toast.success.serverRemoved.title'), {
        description: t('toast.success.serverRemoved.message'),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.serverRemoveFailed'), { description: error.message });
    },
  });
}

export function useUpdateServer() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      name,
      url,
      clientIdentifier,
      color,
      publicUrl,
    }: {
      id: string;
      name?: string;
      url?: string;
      clientIdentifier?: string;
      color?: string | null;
      publicUrl?: string | null;
    }) => api.servers.update(id, { name, url, clientIdentifier, color, publicUrl }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['servers', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['plex', 'server-connections'] });
      toast.success(t('toast.success.serverUpdated.title'), {
        description: t('toast.success.serverUpdated.message'),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.serverUpdateFailed'), { description: error.message });
    },
  });
}

/** @deprecated Use useUpdateServer */
export function useUpdateServerUrl() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      url,
      clientIdentifier,
    }: {
      id: string;
      url: string;
      clientIdentifier?: string;
    }) => api.servers.update(id, { url, clientIdentifier }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['servers', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['plex', 'server-connections'] });
      toast.success(t('toast.success.serverUrlUpdated.title'), {
        description: t('toast.success.serverUrlUpdated.message'),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.serverUrlUpdateFailed'), { description: error.message });
    },
  });
}

/**
 * Hook for fetching available connections for an existing Plex server
 * Used when editing the server URL to show available connection options
 */
export function usePlexServerConnections(serverId: string | undefined) {
  return useQuery({
    queryKey: ['plex', 'server-connections', serverId],
    queryFn: async () => {
      if (!serverId) throw new Error('serverId required');
      return api.auth.getPlexServerConnections(serverId);
    },
    enabled: !!serverId,
    staleTime: 1000 * 30, // 30 seconds - connections may change
    retry: 1,
  });
}

export function useSyncServer() {
  const { t } = useTranslation(['notifications', 'common']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.servers.sync(id),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['servers', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['users', 'list'] });

      // Show detailed results
      const parts: string[] = [];
      if (data.usersAdded > 0) parts.push(t('common:count.usersAdded', { count: data.usersAdded }));
      if (data.usersUpdated > 0)
        parts.push(t('common:count.usersUpdated', { count: data.usersUpdated }));
      if (data.librariesSynced > 0)
        parts.push(t('common:count.library', { count: data.librariesSynced }));
      if (data.errors.length > 0)
        parts.push(t('common:count.error', { count: data.errors.length }));

      const description =
        parts.length > 0 ? parts.join(', ') : t('common:messages.noChangesDetected');

      if (data.errors.length > 0) {
        toast.warning(t('notifications:toast.success.syncCompletedWithErrors.title'), {
          description,
        });
        // Log errors to console for debugging
        console.error('Sync errors:', data.errors);
      } else {
        toast.success(t('notifications:toast.success.serverSynced.title'), { description });
      }
    },
    onError: (error: Error) => {
      toast.error(t('notifications:toast.error.serverSyncFailed'), { description: error.message });
    },
  });
}

export function useReorderServers() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOrderRef = useRef<{ id: string; displayOrder: number }[] | null>(null);

  const mutation = useMutation({
    mutationFn: (servers: { id: string; displayOrder: number }[]) => api.servers.reorder(servers),
    onMutate: async (newOrder) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['servers', 'list'] });

      // Snapshot the previous value
      const previousServers = queryClient.getQueryData<Server[]>(['servers', 'list']);

      // Optimistically update to the new value
      if (previousServers) {
        const reordered = [...previousServers].sort((a, b) => {
          const aOrder = newOrder.find((s) => s.id === a.id)?.displayOrder ?? 0;
          const bOrder = newOrder.find((s) => s.id === b.id)?.displayOrder ?? 0;
          return aOrder - bOrder;
        });
        queryClient.setQueryData(['servers', 'list'], reordered);
      }

      // Return context with the previous servers
      return { previousServers };
    },
    onError: (error: Error, _newOrder, context) => {
      // Rollback on error
      if (context?.previousServers) {
        queryClient.setQueryData(['servers', 'list'], context.previousServers);
      }
      toast.error(t('toast.error.serverReorderFailed'), { description: error.message });
    },
    onSuccess: () => {
      // Invalidate to ensure we have the latest data
      void queryClient.invalidateQueries({ queryKey: ['servers', 'list'] });
    },
  });

  // Cleanup debounce timer on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Use ref to avoid stale closure issues with mutation
  const mutateRef = useRef(mutation.mutate);
  mutateRef.current = mutation.mutate;

  // Debounced mutation function to avoid excessive API calls during drag
  const debouncedMutate = useCallback(
    (servers: { id: string; displayOrder: number }[]) => {
      // Store pending order in ref to use latest value when timer fires
      pendingOrderRef.current = servers;

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        if (pendingOrderRef.current) {
          mutateRef.current(pendingOrderRef.current);
          pendingOrderRef.current = null;
        }
      }, 500);
    },
    [] // No dependencies - uses refs to avoid stale closures
  );

  return {
    ...mutation,
    mutate: debouncedMutate,
  };
}

// Rolling window keyed by timestamp, oldest first. Bounded by time, not by
// `maxPoints`, which is only a memory ceiling. Ages against the server clock,
// which every point is now stamped with - Plex's are shifted onto it at the
// API, plugin samples at ingest.
export function mergeWindow<T extends { at: number }>(
  ref: { current: Map<number, T> },
  newData: T[],
  nowSeconds: number,
  windowSeconds: number,
  maxPoints: number
): T[] {
  const map = ref.current;

  for (const point of newData) {
    map.set(point.at, point);
  }

  const cutoff = nowSeconds - liveStatsRetentionSeconds(windowSeconds);
  const kept = Array.from(map.values())
    .sort((a, b) => b.at - a.at)
    .filter((p) => p.at >= cutoff)
    .slice(0, maxPoints);

  ref.current = new Map(kept.map((p) => [p.at, p]));

  return kept.reverse();
}

// Charts anchor to Tracearr's clock, not the browser's
function serverClock(fetchedAt: string) {
  const parsed = Date.parse(fetchedAt);
  const serverNow = Number.isFinite(parsed) ? parsed : Date.now();
  return { clockSkewMs: serverNow - Date.now(), serverNowSeconds: Math.floor(serverNow / 1000) };
}

function inWindow<T extends { at: number }>(
  points: T[] | undefined,
  serverNow: number,
  windowSeconds: number
): T[] {
  return (points ?? []).filter((p) => serverNow - p.at <= windowSeconds);
}

function averageOf(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length > 0
    ? Math.round(present.reduce((sum, v) => sum + v, 0) / present.length)
    : null;
}

// Servers with no live-stats source (no plugin, or offline) back off to this
// cadence instead of hammering at chart speed; data appearing restores it
const EMPTY_STATS_BACKOFF_MS = 30_000;

interface LiveStatsData {
  statistics: unknown[];
  bandwidth: unknown[];
}

function liveStatsInterval(pollMs: number) {
  return (query: { state: { data?: LiveStatsData } }) => {
    const data = query.state.data;
    const empty = !data || (data.statistics.length === 0 && data.bandwidth.length === 0);
    return empty ? EMPTY_STATS_BACKOFF_MS : pollMs;
  };
}

/**
 * Combined live server stats (CPU/RAM + bandwidth), one request per tick.
 * Cadence is fixed: both endpoints serve a rolling window and points merge by
 * timestamp, so polling faster returns the same samples.
 */
export function useServerLiveStats(serverId: string | undefined, enabled: boolean = true) {
  const statsMapRef = useRef<Map<number, ServerResourceDataPoint>>(new Map());
  const bandwidthMapRef = useRef<Map<number, ServerBandwidthDataPoint>>(new Map());

  // A server switch must not blend the previous server's window into the next
  const lastServerIdRef = useRef(serverId);
  if (lastServerIdRef.current !== serverId) {
    lastServerIdRef.current = serverId;
    statsMapRef.current = new Map();
    bandwidthMapRef.current = new Map();
  }

  const query = useQuery({
    queryKey: ['servers', 'live-stats', serverId],
    queryFn: async () => {
      if (!serverId) throw new Error('Server ID required');
      const response = await api.servers.liveStats(serverId);
      const clock = serverClock(response.fetchedAt);
      return {
        ...response,
        ...clock,
        statistics: mergeWindow(
          statsMapRef,
          response.statistics,
          clock.serverNowSeconds,
          SERVER_STATS_CONFIG.WINDOW_SECONDS,
          SERVER_STATS_CONFIG.MAX_POINTS
        ),
        bandwidth: mergeWindow(
          bandwidthMapRef,
          response.bandwidth,
          clock.serverNowSeconds,
          BANDWIDTH_STATS_CONFIG.WINDOW_SECONDS,
          BANDWIDTH_STATS_CONFIG.MAX_POINTS
        ),
      };
    },
    enabled: enabled && !!serverId,
    refetchInterval: liveStatsInterval(SERVER_STATS_CONFIG.POLL_INTERVAL_SECONDS * 1000),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
    staleTime: SERVER_STATS_CONFIG.POLL_INTERVAL_SECONDS * 1000 - 500,
  });

  const statistics = query.data?.statistics;
  const serverNow = query.data?.serverNowSeconds ?? 0;

  // Only what's still on screen, so a stalled server's numbers decay with it
  const recentStats = inWindow(
    statistics,
    serverNow,
    liveStatsRetentionSeconds(SERVER_STATS_CONFIG.WINDOW_SECONDS)
  );
  const statisticsAverages =
    recentStats.length > 0
      ? {
          hostCpu: averageOf(recentStats.map((p) => p.hostCpuUtilization)),
          processCpu: Math.round(
            recentStats.reduce((sum, p) => sum + p.processCpuUtilization, 0) / recentStats.length
          ),
          hostMemory: averageOf(recentStats.map((p) => p.hostMemoryUtilization)),
          processMemory: Math.round(
            recentStats.reduce((sum, p) => sum + p.processMemoryUtilization, 0) / recentStats.length
          ),
        }
      : null;

  const bandwidth = query.data?.bandwidth;
  const recentBandwidth = inWindow(
    bandwidth,
    serverNow,
    liveStatsRetentionSeconds(BANDWIDTH_STATS_CONFIG.WINDOW_SECONDS)
  );
  // Over the window, not the row count - idle seconds have no row but count
  const bandwidthAverages =
    recentBandwidth.length > 0
      ? {
          local: Math.round(
            recentBandwidth.reduce((sum, p) => sum + p.lanBytes / p.timespan, 0) /
              BANDWIDTH_STATS_CONFIG.WINDOW_SECONDS
          ),
          remote: Math.round(
            recentBandwidth.reduce((sum, p) => sum + p.wanBytes / p.timespan, 0) /
              BANDWIDTH_STATS_CONFIG.WINDOW_SECONDS
          ),
        }
      : null;

  return {
    ...query,
    clockSkewMs: query.data?.clockSkewMs ?? 0,
    statistics,
    statisticsAverages,
    bandwidth,
    bandwidthAverages,
    bandwidthSamples: query.data?.bandwidthSamples,
    bandwidthAccounts: query.data?.bandwidthAccounts,
    bandwidthDevices: query.data?.bandwidthDevices,
  };
}

export interface ServerLiveStatsSeries {
  serverId: string;
  statistics: ServerResourceDataPoint[];
  bandwidth: ServerBandwidthDataPoint[];
}

/**
 * Live stats for several servers at once, one query per server sharing the
 * single-server cache keys. Each server accumulates its own rolling window.
 *
 * @param serverIds - Servers to poll (Plex plus any Jellyfin/Emby running the
 *   SSE plugin; servers with no stats source surface as empty series)
 * @param enabled - Whether polling is enabled
 */
export function useMultiServerLiveStats(serverIds: string[], enabled: boolean = true) {
  const statsWindowsRef = useRef(
    new Map<string, { current: Map<number, ServerResourceDataPoint> }>()
  );
  const bandwidthWindowsRef = useRef(
    new Map<string, { current: Map<number, ServerBandwidthDataPoint> }>()
  );

  // Prune windows for deselected servers so re-adding one later starts clean
  const idsKey = serverIds.join(',');
  const lastIdsKeyRef = useRef(idsKey);
  if (lastIdsKeyRef.current !== idsKey) {
    lastIdsKeyRef.current = idsKey;
    const keep = new Set(serverIds);
    for (const store of [statsWindowsRef.current, bandwidthWindowsRef.current]) {
      for (const key of Array.from(store.keys())) {
        if (!keep.has(key)) store.delete(key);
      }
    }
  }

  const windowFor = useCallback(function <T>(
    store: Map<string, { current: Map<number, T> }>,
    serverId: string
  ): { current: Map<number, T> } {
    let ref = store.get(serverId);
    if (!ref) {
      ref = { current: new Map<number, T>() };
      store.set(serverId, ref);
    }
    return ref;
  }, []);

  const { byServer, isLoading } = useMultiServerQuery<
    Awaited<ReturnType<typeof api.servers.liveStats>> & ReturnType<typeof serverClock>
  >(enabled ? serverIds : [], (serverId) => ({
    queryKey: ['servers', 'live-stats', serverId],
    queryFn: async () => {
      const response = await api.servers.liveStats(serverId);
      const clock = serverClock(response.fetchedAt);
      return {
        ...response,
        ...clock,
        statistics: mergeWindow(
          windowFor(statsWindowsRef.current, serverId),
          response.statistics,
          clock.serverNowSeconds,
          SERVER_STATS_CONFIG.WINDOW_SECONDS,
          SERVER_STATS_CONFIG.MAX_POINTS
        ),
        bandwidth: mergeWindow(
          windowFor(bandwidthWindowsRef.current, serverId),
          response.bandwidth,
          clock.serverNowSeconds,
          BANDWIDTH_STATS_CONFIG.WINDOW_SECONDS,
          BANDWIDTH_STATS_CONFIG.MAX_POINTS
        ),
      };
    },
    refetchInterval: liveStatsInterval(SERVER_STATS_CONFIG.POLL_INTERVAL_SECONDS * 1000),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
    staleTime: SERVER_STATS_CONFIG.POLL_INTERVAL_SECONDS * 1000 - 500,
  }));

  const series: ServerLiveStatsSeries[] = serverIds.map((serverId) => {
    const result = byServer.get(serverId);
    return {
      serverId,
      statistics: result?.data?.statistics ?? [],
      bandwidth: result?.data?.bandwidth ?? [],
    };
  });

  // Every response carries Tracearr's clock, so any server's is the anchor
  const clockSkewMs =
    serverIds.map((id) => byServer.get(id)?.data?.clockSkewMs).find((v) => v != null) ?? 0;

  return { series, clockSkewMs, isLoading };
}
