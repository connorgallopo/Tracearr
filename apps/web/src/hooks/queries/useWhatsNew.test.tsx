import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api', () => ({
  api: { whatsNew: { get: vi.fn(), dismiss: vi.fn() } },
}));

import { api } from '@/lib/api';
import { WHATS_NEW_KEY, useDismissWhatsNew, useWhatsNew } from './useWhatsNew';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('useWhatsNew', () => {
  it('loads the state', async () => {
    vi.mocked(api.whatsNew.get).mockResolvedValue({
      runningVersion: '2.3.0',
      lastSeenVersion: 'legacy',
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => useWhatsNew(), { wrapper });
    await waitFor(() => expect(result.current.data?.lastSeenVersion).toBe('legacy'));
  });

  it('refetches the state after a dismiss', async () => {
    vi.mocked(api.whatsNew.dismiss).mockResolvedValue(undefined);
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useDismissWhatsNew(), { wrapper });
    await act(() => result.current.mutateAsync());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: WHATS_NEW_KEY });
  });
});
