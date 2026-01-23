import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { WatchSyncConfig } from '@tracearr/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';

// Query keys
export const watchSyncKeys = {
  all: ['watchSync'] as const,
  configs: () => [...watchSyncKeys.all, 'configs'] as const,
  config: (id: string) => [...watchSyncKeys.configs(), id] as const,
  users: (configId: string) => [...watchSyncKeys.config(configId), 'users'] as const,
  progress: () => [...watchSyncKeys.all, 'progress'] as const,
  history: () => [...watchSyncKeys.all, 'history'] as const,
};

// Get all sync configurations
export function useWatchSyncConfigs() {
  return useQuery({
    queryKey: watchSyncKeys.configs(),
    queryFn: api.watchSync.getConfigs,
    staleTime: 1000 * 60, // 1 minute
  });
}

// Get a single sync configuration
export function useWatchSyncConfig(id: string) {
  return useQuery({
    queryKey: watchSyncKeys.config(id),
    queryFn: () => api.watchSync.getConfig(id),
    enabled: !!id,
    staleTime: 1000 * 60,
  });
}

// Create a new sync configuration
export function useCreateWatchSyncConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.watchSync.createConfig,
    onSuccess: (data) => {
      queryClient.setQueryData<WatchSyncConfig[]>(watchSyncKeys.configs(), (old) => {
        if (!old) return [data.config];
        return [...old, data.config];
      });
      toast.success('Sync Configuration Created', {
        description: 'Watch sync configuration has been created.',
      });
    },
    onError: (err) => {
      toast.error('Failed to Create Configuration', { description: err.message });
    },
  });
}

// Update a sync configuration
export function useUpdateWatchSyncConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: {
        enabled?: boolean;
        dryRun?: boolean;
        syncMovies?: boolean;
        syncShows?: boolean;
        syncInProgress?: boolean;
        intervalMinutes?: number;
      };
    }) => api.watchSync.updateConfig(id, data),
    onSuccess: (result, { id }) => {
      // Update the config in the list
      queryClient.setQueryData<WatchSyncConfig[]>(watchSyncKeys.configs(), (old) => {
        if (!old) return old;
        return old.map((c) => (c.id === id ? result.config : c));
      });
      // Also update the individual config cache
      queryClient.setQueryData(watchSyncKeys.config(id), result);
      toast.success('Configuration Updated', {
        description: 'Watch sync settings have been saved.',
      });
    },
    onError: (err) => {
      toast.error('Failed to Update Configuration', { description: err.message });
    },
  });
}

// Delete a sync configuration
export function useDeleteWatchSyncConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.watchSync.deleteConfig,
    onSuccess: (_, deletedId) => {
      queryClient.setQueryData<WatchSyncConfig[]>(watchSyncKeys.configs(), (old) => {
        if (!old) return old;
        return old.filter((c) => c.id !== deletedId);
      });
      queryClient.removeQueries({ queryKey: watchSyncKeys.config(deletedId) });
      toast.success('Configuration Deleted', {
        description: 'Watch sync configuration has been removed.',
      });
    },
    onError: (err) => {
      toast.error('Failed to Delete Configuration', { description: err.message });
    },
  });
}

// Trigger a manual sync (preview or auto)
export function useTriggerWatchSync() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.watchSync.triggerSync,
    onMutate: () => {
      // Immediately start polling for progress
      void queryClient.invalidateQueries({ queryKey: watchSyncKeys.progress() });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: watchSyncKeys.progress() });
      const message = result.dryRun
        ? 'Preview started - review items and approve to sync'
        : 'Auto sync has been started';
      toast.success(result.dryRun ? 'Preview Started' : 'Sync Started', { description: message });
    },
    onError: (err) => {
      // If already running, invalidate progress to show current status
      void queryClient.invalidateQueries({ queryKey: watchSyncKeys.progress() });
      toast.error('Failed to Start Sync', { description: err.message });
    },
  });
}

// Sync selected preview items (approval workflow)
export function useSyncSelectedItems() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      configId,
      items,
    }: {
      configId: string;
      items: Array<{
        targetServerItemId: string;
        targetServerUserId: string;
        action: 'mark_watched' | 'update_progress';
        sourceProgressMs?: number;
        sourceViewedAt?: string;
        sourceTitle: string;
      }>;
    }) => api.watchSync.syncSelected(configId, items),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: watchSyncKeys.history() });
      void queryClient.invalidateQueries({ queryKey: watchSyncKeys.configs() });
      const { synced, errors } = result.result;
      if (errors > 0) {
        toast.warning('Sync Completed with Errors', {
          description: `${synced} items synced, ${errors} errors`,
        });
      } else {
        toast.success('Sync Complete', {
          description: `${synced} items synced successfully`,
        });
      }
    },
    onError: (err) => {
      toast.error('Failed to Sync Items', { description: err.message });
    },
  });
}

// Get users available for mapping
export function useWatchSyncUsers(configId: string) {
  return useQuery({
    queryKey: watchSyncKeys.users(configId),
    queryFn: () => api.watchSync.getUsers(configId),
    enabled: !!configId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

// Add a user mapping
export function useAddWatchSyncUserMapping() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      configId,
      data,
    }: {
      configId: string;
      data: {
        sourceServerUserId: string;
        targetServerUserId: string;
        enabled?: boolean;
      };
    }) => api.watchSync.addUserMapping(configId, data),
    onSuccess: () => {
      // Invalidate ALL watch sync queries since reverse mapping may have been created on sibling config
      void queryClient.invalidateQueries({ queryKey: watchSyncKeys.all });
      toast.success('User Mapping Added', {
        description: 'User has been mapped for watch sync.',
      });
    },
    onError: (err) => {
      toast.error('Failed to Add User Mapping', { description: err.message });
    },
  });
}

// Remove a user mapping
export function useRemoveWatchSyncUserMapping() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ configId, mappingId }: { configId: string; mappingId: string }) =>
      api.watchSync.removeUserMapping(configId, mappingId),
    onSuccess: () => {
      // Invalidate ALL watch sync queries since reverse mapping may have been removed from sibling config
      void queryClient.invalidateQueries({ queryKey: watchSyncKeys.all });
      toast.success('User Mapping Removed', {
        description: 'User mapping has been removed.',
      });
    },
    onError: (err) => {
      toast.error('Failed to Remove User Mapping', { description: err.message });
    },
  });
}

// Get current sync progress
export function useWatchSyncProgress() {
  return useQuery({
    queryKey: watchSyncKeys.progress(),
    queryFn: api.watchSync.getProgress,
    refetchInterval: (query) => {
      const progress = query.state.data?.progress;
      // Poll every 1 second while sync is actively running
      if (
        progress &&
        progress.status !== 'complete' &&
        progress.status !== 'error' &&
        progress.status !== 'idle'
      ) {
        return 1000;
      }
      // Poll every 5 seconds otherwise to catch newly started syncs
      return 5000;
    },
    staleTime: 500,
  });
}

// Get sync history
export function useWatchSyncHistory() {
  return useQuery({
    queryKey: watchSyncKeys.history(),
    queryFn: api.watchSync.getHistory,
    staleTime: 1000 * 60, // 1 minute
  });
}
