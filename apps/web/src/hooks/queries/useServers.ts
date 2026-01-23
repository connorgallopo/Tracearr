import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SERVER_STATS_CONFIG, type Server, type ServerResourceDataPoint } from '@tracearr/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';
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
    }) => api.servers.updateUrl(id, url, clientIdentifier),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['servers', 'list'] });
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
      // Invalidate watch sync users - server sync may update Plex tokens which affects user mappings
      void queryClient.invalidateQueries({ queryKey: ['watchSync'] });

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

/**
 * Hook for fetching server resource statistics with fixed 2-minute window
 * Polls every 10 seconds, displays last 2 minutes of data (12 points)
 * X-axis is static (2m → NOW), data slides through as new points arrive
 *
 * @param serverId - Server ID to fetch stats for
 * @param enabled - Whether polling is enabled (typically tied to component mount)
 */
export function useServerStatistics(serverId: string | undefined, enabled: boolean = true) {
  // Accumulate data points across polls, keyed by timestamp for deduplication
  const dataMapRef = useRef<Map<number, ServerResourceDataPoint>>(new Map());

  // Merge new data with existing, keep most recent DATA_POINTS
  const mergeData = useCallback((newData: ServerResourceDataPoint[]) => {
    const map = dataMapRef.current;

    // Add/update data points
    for (const point of newData) {
      map.set(point.at, point);
    }

    // Sort by timestamp descending (newest first), keep DATA_POINTS
    const sorted = Array.from(map.values())
      .sort((a, b) => b.at - a.at)
      .slice(0, SERVER_STATS_CONFIG.DATA_POINTS);

    // Rebuild map with only kept points
    dataMapRef.current = new Map(sorted.map((p) => [p.at, p]));

    // Return in ascending order (oldest first) for chart rendering
    return sorted.reverse();
  }, []);

  const query = useQuery({
    queryKey: ['servers', 'statistics', serverId],
    queryFn: async () => {
      if (!serverId) throw new Error('Server ID required');
      const response = await api.servers.statistics(serverId);
      // Merge with accumulated data
      const mergedData = mergeData(response.data);
      return {
        ...response,
        data: mergedData,
      };
    },
    enabled: enabled && !!serverId,
    // Poll every 10 seconds
    refetchInterval: SERVER_STATS_CONFIG.POLL_INTERVAL_SECONDS * 1000,
    // Don't poll when tab is hidden
    refetchIntervalInBackground: false,
    // Don't refetch on window focus (we have interval polling)
    refetchOnWindowFocus: false,
    // Keep previous data while fetching new
    placeholderData: (prev) => prev,
    // Data is fresh until next poll
    staleTime: SERVER_STATS_CONFIG.POLL_INTERVAL_SECONDS * 1000 - 500,
  });

  // Calculate averages from windowed data
  const dataPoints = query.data?.data;
  const dataLength = dataPoints?.length ?? 0;
  const averages =
    dataPoints && dataLength > 0
      ? {
          hostCpu: Math.round(
            dataPoints.reduce((sum: number, p) => sum + p.hostCpuUtilization, 0) / dataLength
          ),
          processCpu: Math.round(
            dataPoints.reduce((sum: number, p) => sum + p.processCpuUtilization, 0) / dataLength
          ),
          hostMemory: Math.round(
            dataPoints.reduce((sum: number, p) => sum + p.hostMemoryUtilization, 0) / dataLength
          ),
          processMemory: Math.round(
            dataPoints.reduce((sum: number, p) => sum + p.processMemoryUtilization, 0) / dataLength
          ),
        }
      : null;

  return {
    ...query,
    averages,
  };
}
