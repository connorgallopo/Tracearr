import type { TFunction } from 'i18next';
import type { ImportWaitingForLibrarySync } from '@tracearr/shared';
import { api } from '@/lib/api';
import { useMultiServerQuery } from '@/hooks/useMultiServerQuery';

/** Where each server's latest tofa history import stands; useSocket refreshes it on job events. */
export function useTofaImports(serverIds: string[]) {
  return useMultiServerQuery(serverIds, (serverId) => ({
    queryKey: ['import', 'tofa', serverId],
    queryFn: () => api.import.tofa.getActive(serverId),
  }));
}

/**
 * Each server's queued or running import from one source, including whether it is held for the
 * server's first library sync; useSocket refreshes it on job events.
 */
export function useActiveImports(
  source: 'tautulli' | 'jellystat' | 'playbackReporting',
  serverIds: string[]
) {
  // Tautulli's answer is the same without the waiting field, which is optional
  return useMultiServerQuery<Awaited<ReturnType<typeof api.import.jellystat.getActive>>>(
    serverIds,
    (serverId) => ({
      queryKey: ['import', source, serverId],
      queryFn: () => api.import[source].getActive(serverId),
    })
  );
}

/** What an import held for the server's first library sync says while it waits. */
export function waitingForLibrarySyncMessage(
  waiting: ImportWaitingForLibrarySync,
  t: TFunction<'settings'>
): string {
  const percent = waiting.librarySync?.progress;
  return percent == null
    ? t('import.waitingForLibrarySync')
    : t('import.waitingForLibrarySyncPercent', { percent });
}
