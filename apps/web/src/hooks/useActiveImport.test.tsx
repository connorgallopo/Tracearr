import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UseQueryResult } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { type ActiveImportStatus, useActiveImport } from './useActiveImport';

function runningOn(serverIds: string[]) {
  return {
    byServer: new Map(
      serverIds.map((id) => [
        id,
        { data: { active: true, jobId: `job-${id}` } } as UseQueryResult<ActiveImportStatus>,
      ])
    ),
    isLoading: false,
    isFetching: false,
    error: null,
  };
}

describe('useActiveImport', () => {
  it('looks again when the servers are swapped or come back after none', () => {
    const onActive = vi.fn();
    const { rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useActiveImport(ids, runningOn(ids), onActive),
      { initialProps: { ids: ['srv-1'] } }
    );

    rerender({ ids: ['srv-2'] });
    rerender({ ids: [] });
    rerender({ ids: ['srv-2'] });
    rerender({ ids: ['srv-2'] });

    expect(onActive.mock.calls.map(([serverId]) => serverId)).toEqual(['srv-1', 'srv-2', 'srv-2']);
  });
});
