import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { SettingsResponse, StorageWarning } from '@tracearr/shared';
import { toast } from 'sonner';
import { api, type SettingsUpdate } from '@/lib/api';

// API Key queries and mutations
export function useApiKey() {
  return useQuery({
    queryKey: ['apiKey'],
    queryFn: api.settings.getApiKey,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useRegenerateApiKey() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.settings.regenerateApiKey,
    onSuccess: (data) => {
      queryClient.setQueryData(['apiKey'], data);
      toast.success(t('toast.success.apiKeyGenerated.title'), {
        description: t('toast.success.apiKeyGenerated.message'),
      });
    },
    onError: (err) => {
      toast.error(t('toast.error.apiKeyGenerateFailed'), { description: err.message });
    },
  });
}

/** GET /settings is owner only; other viewers pass `enabled: false` rather than collect 403s. */
export function useSettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['settings'],
    queryFn: api.settings.get,
    enabled: options.enabled ?? true,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useImageCacheStatus() {
  return useQuery({
    queryKey: ['settings', 'image-cache'],
    queryFn: api.settings.getImageCache,
    staleTime: 60_000,
  });
}

/**
 * The server checks storage once per boot, so the only time the answer can change is
 * after a restart, which the reconnect marks.
 */
export function useStorageWarning() {
  return useQuery({
    queryKey: ['storage-warning'],
    queryFn: api.settings.getStorageWarning,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: 'always',
  });
}

export function useDismissStorageWarning() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.settings.dismissStorageWarning,
    onSuccess: () => {
      queryClient.setQueryData<StorageWarning>(
        ['storage-warning'],
        (old) => old && { ...old, dismissed: true }
      );
    },
  });
}

interface UpdateSettingsOptions {
  silent?: boolean;
}

export function useUpdateSettings(options: UpdateSettingsOptions = {}) {
  const { silent = false } = options;
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: SettingsUpdate) => api.settings.update(data),
    onMutate: async (newSettings) => {
      await queryClient.cancelQueries({ queryKey: ['settings'] });

      // Snapshot the previous value
      const previousSettings = queryClient.getQueryData<SettingsResponse>(['settings']);

      // Optimistically update to the new value
      queryClient.setQueryData<SettingsResponse>(['settings'], (old) => {
        if (!old) return old;
        return {
          ...old,
          ...newSettings,
          loginMethods: { ...old.loginMethods, ...newSettings.loginMethods },
        };
      });

      return { previousSettings };
    },
    onError: (err, newSettings, context) => {
      // Rollback on error
      if (context?.previousSettings) {
        queryClient.setQueryData(['settings'], context.previousSettings);
      }
      if (!silent) {
        toast.error(t('toast.error.settingsUpdateFailed'), { description: err.message });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      if (!silent) {
        toast.success(t('toast.success.settingsUpdated.title'), {
          description: t('toast.success.settingsUpdated.message'),
        });
      }
    },
  });
}
