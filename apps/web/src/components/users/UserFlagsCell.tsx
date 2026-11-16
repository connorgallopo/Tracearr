import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Crown, Merge } from 'lucide-react';
import type { ServerUserWithIdentity } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { RemovedBadge } from '@/components/users/RemovedBadge';
import { TrustScoreBadge } from '@/components/users/TrustScoreBadge';

/** Only what is true about the person: nothing renders for a clean, trusted, single account. */
export function UserFlagsCell({ row }: { row: ServerUserWithIdentity }) {
  const { t } = useTranslation(['pages', 'common']);
  const trust = row.identityTrustScore ?? row.trustScore;
  const pending = row.pendingViolations ?? 0;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {row.role === 'owner' && (
        <span title={t('common:labels.serverOwner')}>
          <Crown className="text-foreground h-4 w-4" />
        </span>
      )}
      {trust < 100 && <TrustScoreBadge score={trust} />}
      {pending > 0 && (
        <Badge variant="warning" asChild>
          <Link
            to={`/violations?people=${row.userId}&status=pending`}
            onClick={(event) => event.stopPropagation()}
          >
            {t('pages:users.pendingLink', { count: pending })}
          </Link>
        </Badge>
      )}
      {(row.identityServers?.length ?? 0) > 1 && (
        <Badge variant="secondary" className="font-normal">
          <Merge />
          {t('pages:users.merged')}
        </Badge>
      )}
      {row.removedAt && <RemovedBadge removedAt={row.removedAt} />}
    </div>
  );
}
