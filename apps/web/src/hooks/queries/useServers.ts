import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SERVER_STATS_CONFIG, type ServerResourceDataPoint } from '@tracearr/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useRef, useCallback } from 'react';

export function useServers() {
  return useQuery({
    queryKey: ['servers', 'list'],
    queryFn: api.servers.list,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useCreateServer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { name: string; type: string; url: string; token: string }) =>
      api.servers.create(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['servers', 'list'] });
      toast.success('Server Added', { description: 'The server has been added successfully.' });
    },
    onError: (error: Error) => {
      toast.error('Failed to Add Server', { description: error.message });
    },
  });
}

export function useDeleteServer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.servers.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['servers', 'list'] });
      toast.success('Server Removed', { description: 'The server has been removed successfully.' });
    },
    onError: (error: Error) => {
      toast.error('Failed to Remove Server', { description: error.message });
    },
  });
}

export function useSyncServer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.servers.sync(id),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['servers', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['users', 'list'] });

      // Show detailed results
      const parts: string[] = [];
      if (data.usersAdded > 0) parts.push(`${data.usersAdded} users added`);
      if (data.usersUpdated > 0) parts.push(`${data.usersUpdated} users updated`);
      if (data.librariesSynced > 0) parts.push(`${data.librariesSynced} libraries`);
      if (data.errors.length > 0) parts.push(`${data.errors.length} errors`);

      const description = parts.length > 0 ? parts.join(', ') : 'No changes detected';

      if (data.errors.length > 0) {
        toast.warning(data.success ? 'Sync Completed with Errors' : 'Sync Completed with Errors', {
          description,
        });
        // Log errors to console for debugging
        console.error('Sync errors:', data.errors);
      } else {
        toast.success('Server Synced', { description });
      }
    },
    onError: (error: Error) => {
      toast.error('Sync Failed', { description: error.message });
    },
  });
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
  const dataPoints = query.data?.data as ServerResourceDataPoint[] | undefined;
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
