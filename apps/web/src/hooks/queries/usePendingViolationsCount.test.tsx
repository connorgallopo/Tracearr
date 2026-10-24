import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { count } = vi.hoisted(() => ({ count: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { violations: { count } } }));

import { usePendingViolationsCount } from './usePendingViolationsCount';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('usePendingViolationsCount', () => {
  it('asks for unacknowledged violations and returns the total', async () => {
    count.mockResolvedValue({ total: 7 });

    const { result } = renderHook(() => usePendingViolationsCount(true), { wrapper });

    await waitFor(() => expect(result.current).toBe(7));
    expect(count).toHaveBeenCalledWith({ acknowledged: false });
  });
});
