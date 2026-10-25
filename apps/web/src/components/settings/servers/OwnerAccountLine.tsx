import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OwnerLinkServer, Server } from '@tracearr/shared';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useUnlinkOwnerAccount } from '@/hooks/queries';
import { OwnerLinkDialog } from './OwnerLinkDialog';

/** The owner's own account on a Jellyfin or Emby server, which their plays and sign-in follow. */
export function OwnerAccountLine({ server, link }: { server: Server; link: OwnerLinkServer }) {
  const { t } = useTranslation(['settings', 'common']);
  const [linkOpen, setLinkOpen] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const unlink = useUnlinkOwnerAccount();
  const { linked } = link;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="text-muted-foreground">{t('servers.ownerAccount.label')}</span>
      {linked === null ? (
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() => setLinkOpen(true)}
        >
          {t('servers.ownerAccount.link')}
        </button>
      ) : (
        <>
          <span>{linked.username}</span>
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => setUnlinkOpen(true)}
          >
            {t('servers.ownerAccount.unlink')}
          </button>
        </>
      )}

      {linkOpen && <OwnerLinkDialog open onOpenChange={setLinkOpen} server={server} link={link} />}

      {linked !== null && (
        <ConfirmDialog
          open={unlinkOpen}
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
    </div>
  );
}
