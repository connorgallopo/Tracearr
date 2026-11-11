import { useEffect, useEffectEvent } from 'react';
import { useTranslation } from 'react-i18next';

export interface ActiveImportStatus {
  active: boolean;
  jobId?: string;
  progress?: number | object;
}

/**
 * Picks up an import still running from an earlier visit: the servers are asked in order and the
 * first with a running job is handed back with a progress message. A server that cannot be asked
 * counts as having none. Asked again only when the number of servers changes, not on every
 * re-filter of the list.
 */
export function useActiveImport(
  serverIds: string[],
  getActive: (serverId: string) => Promise<ActiveImportStatus>,
  onActive: (serverId: string, jobId: string, message: string) => void
): void {
  const { t } = useTranslation('settings');

  const findActive = useEffectEvent(async () => {
    for (const serverId of serverIds) {
      const status = await getActive(serverId).catch(() => null);
      if (status?.active && status.jobId) {
        const percent = typeof status.progress === 'number' ? status.progress : 0;
        onActive(
          serverId,
          status.jobId,
          percent > 0
            ? t('import.importInProgressPercent', { percent })
            : t('import.importInProgressGeneric')
        );
        return;
      }
    }
  });

  const serverCount = serverIds.length;
  useEffect(() => {
    if (serverCount > 0) void findActive();
  }, [serverCount]);
}
