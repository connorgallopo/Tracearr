import { useTranslation } from 'react-i18next';
import { Pencil, Split } from 'lucide-react';
import type { ServerUserFullDetail } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ServerColumnCell } from '@/components/server';
import { RemovedBadge } from '@/components/users/RemovedBadge';
import { TrustScoreBadge } from '@/components/users/TrustScoreBadge';
import { UserAccessControls } from '@/components/users/UserAccessControls';
import { cn } from '@/lib/utils';

type LinkedAccount = ServerUserFullDetail['identity']['serverUsers'][number];

interface AccessTabProps {
  detail: ServerUserFullDetail;
  isOwner: boolean;
  onAdjustTrust: (account: LinkedAccount) => void;
  onSplit: (account: LinkedAccount) => void;
  splitPending: boolean;
}

/** Sign-in and role for the owner, then the accounts merged into this person. */
export function AccessTab({
  detail,
  isOwner,
  onAdjustTrust,
  onSplit,
  splitPending,
}: AccessTabProps) {
  const { t } = useTranslation(['pages', 'common']);
  const { user, identity } = detail;

  return (
    <div className="space-y-6">
      {isOwner && user.role !== 'owner' && (
        <UserAccessControls user={user} name={user.identityName ?? identity.username} />
      )}

      {identity.serverUsers.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('pages:userDetail.linkedAccounts')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {identity.serverUsers.map((account) => (
              <div
                key={account.id}
                className="flex items-center justify-between gap-4 rounded-md border p-3"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p
                      className={cn(
                        'font-medium',
                        account.removedAt && 'text-muted-foreground line-through'
                      )}
                    >
                      {account.username}
                    </p>
                    {account.removedAt && <RemovedBadge removedAt={account.removedAt} />}
                  </div>
                  <ServerColumnCell server={{ id: account.serverId, name: account.serverName }} />
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-muted-foreground text-xs whitespace-nowrap">
                    {t('common:count.session', { count: account.sessionCount })}
                  </span>
                  <TrustScoreBadge score={account.trustScore} />
                  {isOwner && (
                    <Button size="sm" variant="outline" onClick={() => onAdjustTrust(account)}>
                      <Pencil className="mr-2 h-4 w-4" />
                      {t('pages:userDetail.adjustTrustScore')}
                    </Button>
                  )}
                  {isOwner && account.mergedIn && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onSplit(account)}
                      disabled={splitPending}
                    >
                      <Split />
                      {t('pages:userDetail.splitAccount')}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
