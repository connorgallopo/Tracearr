import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal } from 'lucide-react';
import type { ServerUserWithIdentity } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useViewAs } from '@/hooks/queries/useImpersonation';
import { rosterPersonName } from '@/components/users/utils';

interface UserRowMenuProps {
  row: ServerUserWithIdentity;
  isOwner: boolean;
  onEditIdentity: (row: ServerUserWithIdentity) => void;
  onAdjustTrust: (row: ServerUserWithIdentity) => void;
}

export function UserRowMenu({ row, isOwner, onEditIdentity, onAdjustTrust }: UserRowMenuProps) {
  const { t } = useTranslation(['pages', 'common']);
  const viewAs = useViewAs();
  // A merged person's badge is the minimum over their accounts, which one account's edit cannot move.
  const canAdjustTrust = (row.identityServers?.length ?? 0) <= 1;
  const canViewAs =
    isOwner && row.role !== 'owner' && row.role !== 'disabled' && row.role !== 'pending';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('pages:users.rowActions', { name: rosterPersonName(row) })}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      {/* The menu renders in a portal, but its clicks still bubble to the row through React. */}
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {isOwner && (
          <>
            <DropdownMenuItem onSelect={() => onEditIdentity(row)}>
              {t('pages:userDetail.editIdentity')}
            </DropdownMenuItem>
            {/* PATCH /users/:id is owner only; admins reset trust in bulk instead. */}
            {canAdjustTrust && (
              <DropdownMenuItem onSelect={() => onAdjustTrust(row)}>
                {t('pages:userDetail.adjustTrustScore')}
              </DropdownMenuItem>
            )}
          </>
        )}
        {canViewAs && (
          <DropdownMenuItem disabled={viewAs.isPending} onSelect={() => viewAs.mutate(row.userId)}>
            {t('pages:userDetail.access.viewAs')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link to={`/violations?people=${row.userId}`}>{t('pages:users.menuOpenViolations')}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
