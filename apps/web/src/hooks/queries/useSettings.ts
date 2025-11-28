import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Settings } from '@tracearr/shared';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: api.settings.get,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (data: Partial<Settings>) => api.settings.update(data),
    onMutate: async (newSettings) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['settings'] });

      // Snapshot the previous value
      const previousSettings = queryClient.getQueryData<Settings>(['settings']);

      // Optimistically update to the new value
      queryClient.setQueryData<Settings>(['settings'], (old) => {
        if (!old) return old;
        return { ...old, ...newSettings };
      });

      return { previousSettings };
    },
    onError: (err, newSettings, context) => {
      // Rollback on error
      if (context?.previousSettings) {
        queryClient.setQueryData(['settings'], context.previousSettings);
      }
      toast({
        title: 'Failed to Update Settings',
        description: (err as Error).message,
        variant: 'destructive',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast({
        title: 'Settings Updated',
        description: 'Your settings have been saved.',
      });
    },
  });
}
