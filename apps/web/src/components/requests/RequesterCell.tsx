import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isStaff, type NonMainProfile, type RequestRequester } from '@tracearr/shared';
import { UserCell } from '@/components/users/UserCell';
import { useAuth } from '@/hooks/useAuth';

/** A requester with no account on the linked server has only the name Seerr knows, shown muted and unlinked. */
export function RequesterCell({
  requester,
  profile,
  trailing,
}: {
  requester: RequestRequester;
  /** The profile that asked, when it is not the account's main one */
  profile?: NonMainProfile;
  trailing?: ReactNode;
}) {
  const { t } = useTranslation('pages');
  const { user } = useAuth();

  if (requester.serverUserId === null) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground truncate">
          {requester.username ?? t('requests.unattributed')}
        </span>
        {trailing}
      </div>
    );
  }

  return (
    <UserCell
      serverUserId={requester.serverUserId}
      username={requester.username}
      identityName={requester.identityName}
      thumbUrl={requester.thumb}
      serverId={requester.thumbServerId}
      link={!!user && isStaff(user.role)}
      trailing={trailing}
      profileBadge={profile && { serverId: requester.serverId, profile }}
    />
  );
}
