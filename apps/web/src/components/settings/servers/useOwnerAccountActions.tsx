import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SERVER_PROFILES,
  assertNever,
  ownerLinkProof,
  type OwnerLinkServer,
  type Server,
} from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useUnlinkOwnerAccount } from '@/hooks/queries';
import { OwnerLinkDialog, TofaOwnerLinkDialog } from './OwnerLinkDialog';

function LinkDialog({
  server,
  link,
  onOpenChange,
}: {
  server: Server;
  link: OwnerLinkServer;
  onOpenChange: (open: boolean) => void;
}) {
  const proof = ownerLinkProof(server.type);
  switch (proof) {
    case 'typedUsername':
      return <OwnerLinkDialog open onOpenChange={onOpenChange} server={server} link={link} />;
    case 'tofaSignIn':
      return <TofaOwnerLinkDialog open onOpenChange={onOpenChange} server={server} />;
    case 'plexAccount':
      // Plex servers have no owner link fact; the owner links plex.tv accounts instead.
      return null;
    default:
      return assertNever(proof);
  }
}

/**
 * The owner's own account on a Jellyfin, Emby or tofa server, which their plays and sign-in
 * follow: the fact, the unlink item for the row menu, and the dialogs, which the row keeps
 * mounted outside the menu. `fromMenu` wraps the item, which opens a dialog.
 */
export function useOwnerAccountActions(
  server: Server,
  link: OwnerLinkServer | undefined,
  fromMenu: (action: () => void) => () => void
): { fact: ReactNode; menuItem: ReactNode; dialogs: ReactNode } {
  const { t } = useTranslation(['settings', 'common']);
  const [linkOpen, setLinkOpen] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const unlink = useUnlinkOwnerAccount();
  const linked = link?.linked ?? null;
  const serverName = SERVER_PROFILES[server.type].displayName;

  if (!link) return { fact: null, menuItem: null, dialogs: null };

  const fact =
    linked === null ? (
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0 text-xs"
        onClick={() => setLinkOpen(true)}
      >
        {t('servers.ownerAccount.linkYours')}
      </Button>
    ) : (
      <span className="flex flex-wrap items-center gap-2">
        {linked.username}
        {!linked.canUnlink && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" tabIndex={0}>
                {t('servers.ownerAccount.signInBadge', { server: serverName })}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {t('servers.ownerAccount.signInHint', { server: serverName })}
            </TooltipContent>
          </Tooltip>
        )}
      </span>
    );

  const menuItem = linked?.canUnlink ? (
    <DropdownMenuItem variant="destructive" onSelect={fromMenu(() => setUnlinkOpen(true))}>
      {t('servers.ownerAccount.unlinkNamed', { username: linked.username })}
    </DropdownMenuItem>
  ) : null;

  const dialogs = (
    <>
      {linkOpen && <LinkDialog server={server} link={link} onOpenChange={setLinkOpen} />}
      {linked !== null && (
        <ConfirmDialog
          open={unlinkOpen}
          restoreFocus
          onOpenChange={setUnlinkOpen}
          title={t('servers.ownerAccount.confirmUnlink.title', { username: linked.username })}
          description={t('servers.ownerAccount.confirmUnlink.body')}
          confirmLabel={t('servers.ownerAccount.unlink')}
          cancelLabel={t('common:actions.cancel')}
          variant="destructive"
          isLoading={unlink.isPending}
          onConfirm={() => {
            unlink.mutate(linked.serverUserId);
            setUnlinkOpen(false);
          }}
        />
      )}
    </>
  );

  return { fact, menuItem, dialogs };
}
