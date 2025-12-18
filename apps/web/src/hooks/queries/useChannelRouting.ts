import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { NotificationChannelRouting, NotificationEventType } from '@tracearr/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';

export function useChannelRouting() {
  return useQuery({
    queryKey: ['channelRouting'],
    queryFn: api.channelRouting.getAll,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useUpdateChannelRouting() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      eventType,
      ...data
    }: {
      eventType: NotificationEventType;
      discordEnabled?: boolean;
      webhookEnabled?: boolean;
      webToastEnabled?: boolean;
    }) => api.channelRouting.update(eventType, data),
    onMutate: async ({ eventType, discordEnabled, webhookEnabled, webToastEnabled }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['channelRouting'] });

      // Snapshot the previous value
      const previousRouting = queryClient.getQueryData<NotificationChannelRouting[]>([
        'channelRouting',
      ]);

      // Optimistically update
      queryClient.setQueryData<NotificationChannelRouting[]>(['channelRouting'], (old) => {
        if (!old) return old;
        return old.map((routing) => {
          if (routing.eventType !== eventType) return routing;
          return {
            ...routing,
            ...(discordEnabled !== undefined && { discordEnabled }),
            ...(webhookEnabled !== undefined && { webhookEnabled }),
            ...(webToastEnabled !== undefined && { webToastEnabled }),
          };
        });
      });

      return { previousRouting };
    },
    onError: (err, _variables, context) => {
      // Rollback on error
      if (context?.previousRouting) {
        queryClient.setQueryData(['channelRouting'], context.previousRouting);
      }
      toast.error('Failed to Update Routing', { description: err.message });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['channelRouting'] });
    },
  });
}
