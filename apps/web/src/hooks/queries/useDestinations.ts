import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type {
  CreateDestinationInput,
  DestinationKind,
  DestinationTestResult,
  UpdateDestinationInput,
} from '@tracearr/shared';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';

export const DESTINATIONS_KEY = ['destinations'];

/** Non-owners get a 403 and this mounts inside useSocket for everyone, so a retry loop would be pure noise. */
export function useDestinations(enabled = true) {
  return useQuery({
    queryKey: DESTINATIONS_KEY,
    queryFn: api.destinations.list,
    staleTime: 1000 * 60 * 5,
    enabled,
    retry: false,
  });
}

/** A 409 delete names what still uses the destination under one key per kind of user. */
function namesFrom(error: Error, key: 'rules' | 'newsletters'): string[] | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const names = error.body[key];
  if (!Array.isArray(names)) return null;
  return names.filter((name): name is string => typeof name === 'string');
}

function testSentToast(t: TFunction<'notifications'>, result: DestinationTestResult): string {
  return result.sentTo
    ? t('toast.success.destinationTestSentTo', { address: result.sentTo })
    : t('toast.success.destinationTestSent');
}

export function useCreateDestination() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateDestinationInput) => api.destinations.create(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DESTINATIONS_KEY });
      toast.success(t('toast.success.destinationSaved'));
    },
    onError: (err) => {
      toast.error(t('toast.error.destinationSaveFailed', { error: err.message }));
    },
  });
}

export function useUpdateDestination() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateDestinationInput }) =>
      api.destinations.update(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DESTINATIONS_KEY });
      toast.success(t('toast.success.destinationSaved'));
    },
    onError: (err) => {
      toast.error(t('toast.error.destinationSaveFailed', { error: err.message }));
    },
  });
}

export function useDeleteDestination() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.destinations.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DESTINATIONS_KEY });
      toast.success(t('toast.success.destinationDeleted'));
    },
    onError: (err) => {
      const rules = namesFrom(err, 'rules');
      if (rules) {
        toast.error(t('toast.error.destinationInUse', { rules: rules.join(', ') }));
        return;
      }
      const newsletters = namesFrom(err, 'newsletters');
      if (newsletters) {
        toast.error(
          t('toast.error.destinationUsedByNewsletters', { names: newsletters.join(', ') })
        );
        return;
      }
      toast.error(t('toast.error.destinationDeleteFailed', { error: err.message }));
    },
  });
}

export function useTestDestination() {
  const { t } = useTranslation('notifications');

  return useMutation({
    mutationFn: (id: string) => api.destinations.test(id),
    onSuccess: (result) => {
      toast.success(testSentToast(t, result));
    },
    onError: (err) => {
      toast.error(t('toast.error.destinationTestFailed', { error: err.message }));
    },
  });
}

export function useTestUnsavedDestination() {
  const { t } = useTranslation('notifications');

  return useMutation({
    mutationFn: (data: { type: DestinationKind; config: Record<string, unknown> }) =>
      api.destinations.testUnsaved(data),
    onSuccess: (result) => {
      toast.success(testSentToast(t, result));
    },
    onError: (err) => {
      toast.error(t('toast.error.destinationTestFailed', { error: err.message }));
    },
  });
}
