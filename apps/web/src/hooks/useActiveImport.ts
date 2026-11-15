import { useEffect, useEffectEvent, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { MultiServerQueryResult } from '@/hooks/useMultiServerQuery';

export interface ActiveImportStatus {
  active: boolean;
  jobId?: string;
  progress?: number | object;
}

/**
 * Picks up an import still running from an earlier visit: once every server has answered, the
 * first in order with a running job is handed back with a progress message. A server that could
 * not be asked counts as having none. Looked at again only when the list of servers changes, not
 * on every refresh of the answers.
 */
export function useActiveImport(
  serverIds: string[],
  imports: MultiServerQueryResult<ActiveImportStatus>,
  onActive: (serverId: string, message: string) => void
): void {
  const { t } = useTranslation('settings');
  const restoredFor = useRef<string | null>(null);

  const restore = useEffectEvent(() => {
    for (const serverId of serverIds) {
      const status = imports.byServer.get(serverId)?.data;
      if (status?.active && status.jobId) {
        const percent = typeof status.progress === 'number' ? status.progress : 0;
        onActive(
          serverId,
          percent > 0
            ? t('import.importInProgressPercent', { percent })
            : t('import.importInProgressGeneric')
        );
        return;
      }
    }
  });

  const serverKey = serverIds.join(',');
  const answered = serverKey !== '' && !imports.isLoading;
  useEffect(() => {
    if (serverKey === '') restoredFor.current = null;
    if (!answered || restoredFor.current === serverKey) return;
    restoredFor.current = serverKey;
    restore();
  }, [answered, serverKey]);
}
