import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { EmailBrandingSettings } from '@tracearr/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';

export const EMAIL_BRANDING_KEY = ['email', 'branding'];
export const EMAIL_SUPPRESSIONS_KEY = ['email', 'suppressions'];

export function useEmailBranding() {
  return useQuery({
    queryKey: EMAIL_BRANDING_KEY,
    queryFn: api.email.branding,
    staleTime: 60_000,
    retry: false,
  });
}

/** PUT replaces the whole block, so the form sends everything it read plus its edits. */
export function useSaveEmailBranding() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: EmailBrandingSettings) => api.email.saveBranding(data),
    onSuccess: (saved) => {
      queryClient.setQueryData(EMAIL_BRANDING_KEY, saved);
      toast.success(t('toast.success.brandingSaved'));
    },
    onError: (err) => {
      toast.error(t('toast.error.brandingSaveFailed', { error: err.message }));
    },
  });
}

export function useEmailSuppressions() {
  return useQuery({
    queryKey: EMAIL_SUPPRESSIONS_KEY,
    queryFn: api.email.suppressions,
    staleTime: 30_000,
    retry: false,
  });
}

export function useAddSuppression() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (address: string) => api.email.addSuppression(address),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: EMAIL_SUPPRESSIONS_KEY });
      toast.success(t('toast.success.suppressionAdded'));
    },
    onError: (err) => {
      toast.error(t('toast.error.suppressionAddFailed', { error: err.message }));
    },
  });
}

export function useRemoveSuppression() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (address: string) => api.email.removeSuppression(address),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: EMAIL_SUPPRESSIONS_KEY });
      toast.success(t('toast.success.suppressionRemoved'));
    },
    onError: (err) => {
      toast.error(t('toast.error.suppressionRemoveFailed', { error: err.message }));
    },
  });
}
