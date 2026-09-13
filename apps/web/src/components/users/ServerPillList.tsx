import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { ServerColumnCell } from '@/components/server';
import { RemovedBadge } from './RemovedBadge';
import type { MergeCandidateAccount } from './mergeSelection';
import { getPersonRemovedState } from './removedStatus';

const VISIBLE_SERVERS = 2;

export function ServerPillList({ accounts }: { accounts: MergeCandidateAccount[] }) {
  const { t } = useTranslation(['pages']);
  const hidden = accounts.slice(VISIBLE_SERVERS);
  const removed = getPersonRemovedState(accounts);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {accounts.slice(0, VISIBLE_SERVERS).map((account) => (
        <ServerColumnCell
          key={account.id}
          server={{ id: account.serverId, name: account.serverName }}
        />
      ))}
      {hidden.length > 0 && (
        <Badge
          variant="outline"
          className="font-normal"
          title={hidden.map((account) => account.serverName).join(', ')}
        >
          {t('pages:users.mergeMoreServers', { count: hidden.length })}
        </Badge>
      )}
      {removed.removed && <RemovedBadge removedAt={removed.removedAt} />}
    </div>
  );
}
