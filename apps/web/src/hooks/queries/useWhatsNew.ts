import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WhatsNewState } from '@tracearr/shared';
import { api } from '@/lib/api';

export const WHATS_NEW_KEY = ['whats-new'] as const;

export function useWhatsNew() {
  return useQuery<WhatsNewState>({
    queryKey: WHATS_NEW_KEY,
    queryFn: () => api.whatsNew.get(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useDismissWhatsNew() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.whatsNew.dismiss(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WHATS_NEW_KEY }),
  });
}
