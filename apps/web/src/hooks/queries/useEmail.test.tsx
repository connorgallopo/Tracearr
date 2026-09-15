import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { DEFAULT_EMAIL_BRANDING } from '@tracearr/shared';

vi.mock('@/lib/api', () => ({
  api: {
    email: {
      saveBranding: vi.fn(),
      addSuppression: vi.fn(),
      removeSuppression: vi.fn(),
    },
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';
import {
  EMAIL_BRANDING_KEY,
  EMAIL_SUPPRESSIONS_KEY,
  useAddSuppression,
  useRemoveSuppression,
  useSaveEmailBranding,
} from './useEmail';

const mockSave = vi.mocked(api.email.saveBranding);
const mockAdd = vi.mocked(api.email.addSuppression);
const mockRemove = vi.mocked(api.email.removeSuppression);

function wrapper(client: QueryClient) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

describe('email hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PUTs the whole branding block and caches the answer under the branding key', async () => {
    const block = { ...DEFAULT_EMAIL_BRANDING, accentColor: '#123456' };
    mockSave.mockResolvedValue(block);
    const client = new QueryClient();
    const { result } = renderHook(() => useSaveEmailBranding(), { wrapper: wrapper(client) });

    result.current.mutate(block);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockSave).toHaveBeenCalledWith(block);
    expect(client.getQueryData(EMAIL_BRANDING_KEY)).toEqual(block);
    expect(toast.success).toHaveBeenCalledWith('toast.success.brandingSaved');
  });

  it('adds an address and refreshes the list', async () => {
    mockAdd.mockResolvedValue({ address: 'gone@example.com' });
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => useAddSuppression(), { wrapper: wrapper(client) });

    result.current.mutate('Gone@Example.com');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockAdd).toHaveBeenCalledWith('Gone@Example.com');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: EMAIL_SUPPRESSIONS_KEY });
  });

  it('removes an address and toasts the server message on failure', async () => {
    mockRemove.mockResolvedValueOnce(undefined);
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => useRemoveSuppression(), { wrapper: wrapper(client) });

    result.current.mutate('gone@example.com');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockRemove).toHaveBeenCalledWith('gone@example.com');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: EMAIL_SUPPRESSIONS_KEY });

    mockRemove.mockRejectedValueOnce(new Error('Address is not suppressed'));
    result.current.mutate('nobody@example.com');
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith(
      'toast.error.suppressionRemoveFailed:{"error":"Address is not suppressed"}'
    );
  });
});
