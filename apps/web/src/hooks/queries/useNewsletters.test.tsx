import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Newsletter } from '@tracearr/shared';
import type * as ApiModule from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const { ApiError } = await vi.importActual<typeof ApiModule>('@/lib/api');
  return {
    api: {
      newsletters: {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        test: vi.fn(),
        send: vi.fn(),
        retryFailed: vi.fn(),
      },
    },
    ApiError,
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

import { api, ApiError } from '@/lib/api';
import { toast } from 'sonner';
import {
  NEWSLETTERS_KEY,
  duplicateBody,
  hasOpenSend,
  newsletterKeys,
  pollWhileOpen,
  useDeleteNewsletter,
  useDuplicateNewsletter,
  useRetryFailedSend,
  useTestNewsletter,
  useUpdateNewsletter,
} from './useNewsletters';

const mockGet = vi.mocked(api.newsletters.get);
const mockCreate = vi.mocked(api.newsletters.create);
const mockUpdate = vi.mocked(api.newsletters.update);
const mockRemove = vi.mocked(api.newsletters.remove);
const mockTest = vi.mocked(api.newsletters.test);
const mockRetry = vi.mocked(api.newsletters.retryFailed);

function wrapper(client: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

const source: Newsletter = {
  id: 'n-1',
  name: 'Weekly',
  enabled: true,
  destinationId: 'd-1',
  schedule: { kind: 'weekly', dayOfWeek: 1, time: '09:00' },
  timezone: 'Europe/Berlin',
  window: { kind: 'since_last_send', fallbackDays: 7 },
  scope: { serverIds: [], libraries: [] },
  sections: {
    movies: { enabled: true, max: 12 },
    shows: { enabled: true, max: 12, maxSeasonsPerShow: 8 },
    music: { enabled: true, max: 8 },
    mostWatched: { enabled: false, max: 10 },
  },
  subject: "What's new on {{server_name}} ({{end_date}})",
  senderName: null,
  intro: null,
  outro: null,
  recipients: { members: true, extraAddresses: [], excludeUserIds: [] },
  imageMode: 'auto',
  skipWhenEmpty: true,
  links: { tracearr: false },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  lastSend: null,
  nextRunAt: '2026-09-07T07:00:00.000Z',
};

describe('polling', () => {
  it('polls only while a send is rendering or sending', () => {
    expect(hasOpenSend([{ outcome: 'sent' }, { outcome: 'sending' }])).toBe(true);
    expect(hasOpenSend([{ outcome: 'rendering' }])).toBe(true);
    expect(hasOpenSend([{ outcome: 'failed' }, { outcome: 'skipped_empty' }])).toBe(false);
    expect(hasOpenSend(undefined)).toBe(false);
    expect(pollWhileOpen([{ outcome: 'sending' }])).toBe(5000);
    expect(pollWhileOpen([{ outcome: 'partial' }])).toBe(false);
  });

  it('keys the detail, sends and recipients queries under the list key', () => {
    expect(NEWSLETTERS_KEY).toEqual(['newsletters']);
    expect(newsletterKeys.detail('n-1')).toEqual(['newsletters', 'n-1']);
    expect(newsletterKeys.sends('n-1', 2)).toEqual(['newsletters', 'n-1', 'sends', 2]);
    expect(newsletterKeys.sendsAll('n-1')).toEqual(['newsletters', 'n-1', 'sends']);
    expect(newsletterKeys.recipients('n-1')).toEqual(['newsletters', 'n-1', 'recipients']);
  });
});

describe('duplicateBody', () => {
  it('drops the row-only fields and renames', () => {
    const body = duplicateBody(source, 'Copy of Weekly');
    expect(body).toEqual({
      name: 'Copy of Weekly',
      enabled: true,
      destinationId: 'd-1',
      schedule: { kind: 'weekly', dayOfWeek: 1, time: '09:00' },
      timezone: 'Europe/Berlin',
      window: { kind: 'since_last_send', fallbackDays: 7 },
      scope: { serverIds: [], libraries: [] },
      sections: source.sections,
      subject: "What's new on {{server_name}} ({{end_date}})",
      senderName: null,
      intro: null,
      outro: null,
      recipients: { members: true, extraAddresses: [], excludeUserIds: [] },
      imageMode: 'auto',
      skipWhenEmpty: true,
      links: { tracearr: false },
    });
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('lastSend');
    expect(body).not.toHaveProperty('nextRunAt');
  });
});

describe('newsletter mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('duplicates by posting the copy, and retries once with a counter on a name clash', async () => {
    mockGet.mockResolvedValue(source);
    mockCreate
      .mockRejectedValueOnce(new ApiError('A newsletter with that name already exists', 409))
      .mockResolvedValueOnce({ ...source, id: 'n-2', name: 'Copy of Weekly (2)' });
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => useDuplicateNewsletter(), { wrapper: wrapper(client) });

    result.current.mutate('n-1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      name: 'settings:newsletters.copyOf:{"name":"Weekly"}',
    });
    expect(mockCreate.mock.calls[1]?.[0]).toMatchObject({
      name: 'settings:newsletters.copyOf:{"name":"Weekly"} (2)',
    });
    expect(result.current.data?.id).toBe('n-2');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['newsletters'] });
    expect(toast.success).toHaveBeenCalledWith('notifications:toast.success.newsletterDuplicated');
  });

  it('gives up after the retry and toasts the server message', async () => {
    mockGet.mockResolvedValue(source);
    mockCreate.mockRejectedValue(new ApiError('A newsletter with that name already exists', 409));
    const client = new QueryClient();
    const { result } = renderHook(() => useDuplicateNewsletter(), { wrapper: wrapper(client) });

    result.current.mutate('n-1');

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenCalledWith(
      'notifications:toast.error.newsletterDuplicateFailed:{"error":"A newsletter with that name already exists"}'
    );
  });

  it('patches only what it is handed and invalidates the list and the row', async () => {
    mockUpdate.mockResolvedValue({ ...source, enabled: false });
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => useUpdateNewsletter(), { wrapper: wrapper(client) });

    result.current.mutate({ id: 'n-1', data: { enabled: false } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockUpdate).toHaveBeenCalledWith('n-1', { enabled: false });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['newsletters'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['newsletters', 'n-1'] });
  });

  it('surfaces the server message when a delete is refused', async () => {
    mockRemove.mockRejectedValueOnce(
      new ApiError('A send is in progress; wait for it to finish', 409)
    );
    const client = new QueryClient();
    const { result } = renderHook(() => useDeleteNewsletter(), { wrapper: wrapper(client) });

    result.current.mutate('n-1');

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith(
      'notifications:toast.error.newsletterDeleteFailed:{"error":"A send is in progress; wait for it to finish"}'
    );
  });

  it('queues a test send to the typed address and starts the sends polling', async () => {
    mockTest.mockResolvedValue({ queued: true, jobId: 'j1' });
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => useTestNewsletter(), { wrapper: wrapper(client) });

    result.current.mutate({ id: 'n-1', address: 'me@example.com' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockTest).toHaveBeenCalledWith('n-1', 'me@example.com', undefined);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['newsletters', 'n-1', 'sends'] });
    expect(toast.success).toHaveBeenCalledWith(
      'notifications:toast.success.newsletterTestQueued:{"address":"me@example.com"}'
    );
  });

  it('retries failed recipients and refreshes the send and the list of sends', async () => {
    mockRetry.mockResolvedValue({ queued: 3 });
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => useRetryFailedSend(), { wrapper: wrapper(client) });

    result.current.mutate({ id: 'n-1', sendId: 's-1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockRetry).toHaveBeenCalledWith('n-1', 's-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['newsletters', 'n-1', 'sends'] });
    expect(toast.success).toHaveBeenCalledWith(
      'notifications:toast.success.newsletterRetryQueued:{"count":3}'
    );
  });
});
