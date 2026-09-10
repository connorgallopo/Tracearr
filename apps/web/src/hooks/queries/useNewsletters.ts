import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type {
  CreateNewsletterInput,
  Newsletter,
  NewsletterPreviewDraftInput,
  NewsletterSendSummary,
  UpdateNewsletterInput,
} from '@tracearr/shared';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';

export const NEWSLETTERS_KEY = ['newsletters'];

export const newsletterKeys = {
  detail: (id: string) => [...NEWSLETTERS_KEY, id],
  sendsAll: (id: string) => [...NEWSLETTERS_KEY, id, 'sends'],
  sends: (id: string, page: number) => [...NEWSLETTERS_KEY, id, 'sends', page],
  recipients: (id: string) => [...NEWSLETTERS_KEY, id, 'recipients'],
  variants: (id: string) => [...NEWSLETTERS_KEY, id, 'variants'],
};

/** No socket event exists for sends, so a list polls while one of its sends is open. */
export const OPEN_SEND_POLL_MS = 5_000;
const OPEN: readonly string[] = ['rendering', 'sending'];

export function hasOpenSend(
  sends: readonly Pick<NewsletterSendSummary, 'outcome'>[] | undefined
): boolean {
  return (sends ?? []).some((send) => OPEN.includes(send.outcome));
}

export function pollWhileOpen(
  sends: readonly Pick<NewsletterSendSummary, 'outcome'>[] | undefined
): number | false {
  return hasOpenSend(sends) ? OPEN_SEND_POLL_MS : false;
}

/** The row without what only the server writes; the copy gets the name it is handed. */
export function duplicateBody(source: Newsletter, name: string): CreateNewsletterInput {
  const { id: _id, createdAt: _c, updatedAt: _u, lastSend: _l, nextRunAt: _n, ...rest } = source;
  return { ...rest, name };
}

const lastSends = (rows: Newsletter[] | undefined) =>
  rows?.flatMap((row) => (row.lastSend ? [row.lastSend] : []));

/** Non-owners get a 403, so a retry loop would be pure noise. */
export function useNewsletters() {
  return useQuery({
    queryKey: NEWSLETTERS_KEY,
    queryFn: api.newsletters.list,
    staleTime: 60_000,
    retry: false,
    refetchInterval: (query) => pollWhileOpen(lastSends(query.state.data)),
  });
}

export function useNewsletter(id: string | undefined) {
  return useQuery({
    queryKey: newsletterKeys.detail(id ?? ''),
    queryFn: () => {
      if (!id) throw new Error('newsletter id required');
      return api.newsletters.get(id);
    },
    enabled: !!id,
    staleTime: 60_000,
    retry: false,
  });
}

export function useNewsletterRecipients(id: string | undefined) {
  return useQuery({
    queryKey: newsletterKeys.recipients(id ?? ''),
    queryFn: () => {
      if (!id) throw new Error('newsletter id required');
      return api.newsletters.recipients(id);
    },
    enabled: !!id,
    staleTime: 30_000,
    retry: false,
  });
}

/** Per-variant counts for the next send; assembled without posters, so it is cheap enough for the editor to keep fresh. */
export function useNewsletterVariants(id: string | undefined) {
  return useQuery({
    queryKey: newsletterKeys.variants(id ?? ''),
    queryFn: () => {
      if (!id) throw new Error('newsletter id required');
      return api.newsletters.variants(id);
    },
    enabled: Boolean(id),
    staleTime: 60_000,
    retry: false,
  });
}

export function useNewsletterSends(id: string, page: number) {
  return useQuery({
    queryKey: newsletterKeys.sends(id, page),
    queryFn: () => api.newsletters.sends(id, page),
    staleTime: 15_000,
    retry: false,
    refetchInterval: (query) => pollWhileOpen(query.state.data?.sends),
  });
}

export function useNewsletterSend(id: string, sendId: string | null) {
  return useQuery({
    queryKey: [...newsletterKeys.sendsAll(id), 'detail', sendId ?? ''],
    queryFn: () => {
      if (!sendId) throw new Error('send id required');
      return api.newsletters.sendDetail(id, sendId);
    },
    enabled: sendId !== null,
    staleTime: 15_000,
    retry: false,
  });
}

export function useCreateNewsletter() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateNewsletterInput) => api.newsletters.create(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NEWSLETTERS_KEY });
      toast.success(t('toast.success.newsletterSaved'));
    },
    onError: (err) => {
      toast.error(t('toast.error.newsletterSaveFailed', { error: err.message }));
    },
  });
}

export function useUpdateNewsletter() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateNewsletterInput }) =>
      api.newsletters.update(id, data),
    onSuccess: (_row, { id }) => {
      void queryClient.invalidateQueries({ queryKey: NEWSLETTERS_KEY });
      void queryClient.invalidateQueries({ queryKey: newsletterKeys.detail(id) });
      toast.success(t('toast.success.newsletterSaved'));
    },
    onError: (err) => {
      toast.error(t('toast.error.newsletterSaveFailed', { error: err.message }));
    },
  });
}

export function useDeleteNewsletter() {
  const { t } = useTranslation(['notifications']);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.newsletters.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NEWSLETTERS_KEY });
      toast.success(t('notifications:toast.success.newsletterDeleted'));
    },
    onError: (err) => {
      toast.error(t('notifications:toast.error.newsletterDeleteFailed', { error: err.message }));
    },
  });
}

const isNameClash = (error: unknown): boolean => error instanceof ApiError && error.status === 409;

/** There is no duplicate endpoint: the copy is a create from the fetched row, renamed, retried once on a clash. */
export function useDuplicateNewsletter() {
  const { t } = useTranslation(['notifications', 'settings']);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<Newsletter> => {
      const source = await api.newsletters.get(id);
      const copyName = t('settings:newsletters.copyOf', { name: source.name }).slice(0, 100);
      try {
        return await api.newsletters.create(duplicateBody(source, copyName));
      } catch (error) {
        if (!isNameClash(error)) throw error;
        return api.newsletters.create(duplicateBody(source, `${copyName.slice(0, 96)} (2)`));
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NEWSLETTERS_KEY });
      toast.success(t('notifications:toast.success.newsletterDuplicated'));
    },
    onError: (err) => {
      toast.error(t('notifications:toast.error.newsletterDuplicateFailed', { error: err.message }));
    },
  });
}

export function usePreviewNewsletter() {
  const { t } = useTranslation('notifications');
  return useMutation({
    mutationFn: (id: string) => api.newsletters.preview(id),
    onError: (err) => {
      toast.error(t('toast.error.newsletterPreviewFailed', { error: err.message }));
    },
  });
}

/** The same render as usePreviewNewsletter, from the form instead of the saved row; nothing is written. */
export function usePreviewDraftNewsletter() {
  const { t } = useTranslation('notifications');
  return useMutation({
    mutationFn: (body: NewsletterPreviewDraftInput) => api.newsletters.previewDraft(body),
    onError: (err) => {
      toast.error(t('toast.error.newsletterPreviewFailed', { error: err.message }));
    },
  });
}

export function useTestNewsletter() {
  const { t } = useTranslation(['notifications']);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      address,
      variantKey,
    }: {
      id: string;
      address: string;
      variantKey?: string;
    }) => api.newsletters.test(id, address, variantKey),
    onSuccess: (_result, { id, address }) => {
      void queryClient.invalidateQueries({ queryKey: newsletterKeys.sendsAll(id) });
      toast.success(t('notifications:toast.success.newsletterTestQueued', { address }));
    },
    onError: (err) => {
      toast.error(t('notifications:toast.error.newsletterTestFailed', { error: err.message }));
    },
  });
}

export function useSendNewsletter() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.newsletters.send(id),
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: newsletterKeys.sendsAll(id) });
      void queryClient.invalidateQueries({ queryKey: NEWSLETTERS_KEY });
      toast.success(t('toast.success.newsletterSendQueued'));
    },
    onError: (err) => {
      toast.error(t('toast.error.newsletterSendFailed', { error: err.message }));
    },
  });
}

export function useNewsletterSendHtml() {
  const { t } = useTranslation('notifications');
  return useMutation({
    mutationFn: ({ id, sendId, variantKey }: { id: string; sendId: string; variantKey?: string }) =>
      api.newsletters.sendHtml(id, sendId, variantKey),
    onError: (err) => {
      toast.error(t('toast.error.newsletterSnapshotFailed', { error: err.message }));
    },
  });
}

export function useRetryFailedSend() {
  const { t } = useTranslation(['notifications']);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, sendId }: { id: string; sendId: string }) =>
      api.newsletters.retryFailed(id, sendId),
    onSuccess: ({ queued }, { id }) => {
      void queryClient.invalidateQueries({ queryKey: newsletterKeys.sendsAll(id) });
      toast.success(t('notifications:toast.success.newsletterRetryQueued', { count: queued }));
    },
    onError: (err) => {
      toast.error(t('notifications:toast.error.newsletterRetryFailed', { error: err.message }));
    },
  });
}
