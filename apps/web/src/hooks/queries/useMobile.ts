import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MobileConfig } from '@tracearr/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';

export function useMobileConfig() {
  return useQuery({
    queryKey: ['mobile', 'config'],
    queryFn: api.mobile.get,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useEnableMobile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.mobile.enable,
    onSuccess: (data) => {
      queryClient.setQueryData<MobileConfig>(['mobile', 'config'], data);
      toast.success('Mobile Access Enabled', {
        description: 'Scan the QR code with the Tracearr mobile app to connect.',
      });
    },
    onError: (err) => {
      toast.error('Failed to Enable Mobile Access', { description: err.message });
    },
  });
}

export function useDisableMobile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.mobile.disable,
    onSuccess: () => {
      queryClient.setQueryData<MobileConfig>(['mobile', 'config'], (old) => {
        if (!old) return old;
        return { ...old, isEnabled: false, token: null, sessions: [] };
      });
      toast.success('Mobile Access Disabled', {
        description: 'All mobile sessions have been revoked.',
      });
    },
    onError: (err) => {
      toast.error('Failed to Disable Mobile Access', { description: err.message });
    },
  });
}

export function useGeneratePairToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.mobile.generatePairToken,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mobile', 'config'] });
      toast.success('Pair Token Generated', {
        description: 'Scan the QR code with your mobile device to pair.',
      });
    },
    onError: (err) => {
      toast.error('Failed to Generate Pair Token', { description: err.message });
    },
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionId: string) => api.mobile.revokeSession(sessionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mobile', 'config'] });
      toast.success('Device Removed', { description: 'The device has been disconnected.' });
    },
    onError: (err) => {
      toast.error('Failed to Remove Device', { description: err.message });
    },
  });
}

export function useRevokeMobileSessions() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.mobile.revokeSessions,
    onSuccess: (data) => {
      queryClient.setQueryData<MobileConfig>(['mobile', 'config'], (old) => {
        if (!old) return old;
        return { ...old, sessions: [] };
      });
      toast.success('Sessions Revoked', {
        description: `${data.revokedCount} mobile session(s) have been revoked.`,
      });
    },
    onError: (err) => {
      toast.error('Failed to Revoke Sessions', { description: err.message });
    },
  });
}
