import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type {
  CreateRequestServiceInput,
  TestRequestServiceInput,
  UpdateRequestServiceInput,
} from '@tracearr/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';

export const REQUESTS_KEY = ['requests'];

export function useMediaRequests(id: string, serverIds: string[]) {
  const sortedServerIds = [...serverIds].sort().join(',');
  return useQuery({
    queryKey: [...REQUESTS_KEY, 'media', id, sortedServerIds],
    queryFn: () => api.library.media.requests(id, serverIds),
    enabled: !!id,
  });
}

export function useUserRequests(
  id: string,
  opts: { scope?: 'identity'; page: number; pageSize: number }
) {
  return useQuery({
    queryKey: [...REQUESTS_KEY, 'user', id, opts.scope ?? 'account', opts.page, opts.pageSize],
    queryFn: () => api.users.requests(id, opts),
    enabled: !!id,
    placeholderData: (prev) => prev,
  });
}

/** Non-owners get a 403, so a retry loop would be pure noise. */
export function useRequestServices(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...REQUESTS_KEY, 'services'],
    queryFn: api.requestServices.list,
    retry: false,
    enabled: options?.enabled ?? true,
  });
}

export function useTestRequestService() {
  return useMutation({
    mutationFn: (data: TestRequestServiceInput) => api.requestServices.test(data),
  });
}

export function useCreateRequestService() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateRequestServiceInput) => api.requestServices.create(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: REQUESTS_KEY });
      toast.success(t('requests.toast.saved'));
    },
    onError: (err) => {
      toast.error(t('requests.toast.failed', { error: err.message }));
    },
  });
}

export function useUpdateRequestService() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateRequestServiceInput }) =>
      api.requestServices.update(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: REQUESTS_KEY });
      toast.success(t('requests.toast.saved'));
    },
    onError: (err) => {
      toast.error(t('requests.toast.failed', { error: err.message }));
    },
  });
}

export function useDeleteRequestService() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.requestServices.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: REQUESTS_KEY });
      toast.success(t('requests.toast.removed'));
    },
    onError: (err) => {
      toast.error(t('requests.toast.failed', { error: err.message }));
    },
  });
}

export function useSyncRequestService() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.requestServices.sync(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: REQUESTS_KEY });
      toast.success(t('requests.toast.syncStarted'));
    },
    onError: (err) => {
      toast.error(t('requests.toast.failed', { error: err.message }));
    },
  });
}
