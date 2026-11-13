import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { ItemGroup } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Info, Link2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { PlexAccountRow } from '@/components/settings/servers/PlexAccountRow';
import {
  LinkAccountButton,
  runPlexOAuth,
  useLinkPlexAccount,
} from '@/components/settings/servers/linkPlexAccount';
import { usePlexAccounts } from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';

export function PlexAccounts() {
  const { t } = useTranslation(['notifications', 'pages', 'common', 'settings']);
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState<string | null>(null);
  const [reauthorizingId, setReauthorizingId] = useState<string | null>(null);
  const {
    link: startPlexOAuth,
    isLinking,
    linkError,
    setLinkError,
    clientIdentifier: plexClientId,
  } = useLinkPlexAccount();

  // Both flows drive the same named popup, so a second start would steal the
  // first one's window and leave it polling a PIN nobody will authorize.
  const oauthBusy = isLinking || reauthorizingId !== null;

  const { data: accountsData, isLoading, refetch } = usePlexAccounts();

  const accounts = accountsData?.accounts ?? [];

  const unlinkMutation = useMutation({
    mutationFn: (id: string) => api.auth.unlinkPlexAccount(id),
    onSuccess: () => {
      toast.success(t('toast.success.plexAccountUnlinked.title'), {
        description: t('toast.success.plexAccountUnlinked.message'),
      });
      void refetch();
      setShowUnlinkConfirm(null);
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.plexUnlinkFailed'), {
        description: error.message,
      });
    },
  });

  const startReauthorize = async (accountId: string) => {
    if (!plexClientId) {
      setLinkError('Plex client identifier unavailable - reload and try again');
      return;
    }

    setReauthorizingId(accountId);
    setLinkError(null);

    try {
      const pinId = await runPlexOAuth(plexClientId);
      const result = await api.auth.reauthorizePlexAccount(accountId, pinId);

      const reconnected = result.servers.filter((s) => s.ok);
      const unmatched = result.servers.filter((s) => s.status === 'unmatched');
      const failed = result.servers.filter((s) => !s.ok && s.status !== 'unmatched');

      if (failed.length > 0 || unmatched.length > 0) {
        toast.warning(t('toast.success.plexAccountReauthorized.title'), {
          description:
            failed.length > 0
              ? t('toast.success.plexAccountReauthorized.partial', {
                  names: failed.map((s) => s.name).join(', '),
                })
              : t('toast.success.plexAccountReauthorized.unmatched', {
                  names: unmatched.map((s) => s.name).join(', '),
                }),
        });
      } else {
        toast.success(t('toast.success.plexAccountReauthorized.title'), {
          description:
            reconnected.length === 0
              ? t('toast.success.plexAccountReauthorized.messageNoServers')
              : t('toast.success.plexAccountReauthorized.message', {
                  count: reconnected.length,
                }),
        });
      }

      await refetch();
      await queryClient.invalidateQueries({ queryKey: ['plex-accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['servers'] });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to reauthorize account';
      setLinkError(message);
      toast.error(t('toast.error.plexReauthorizeFailed'), { description: message });
    } finally {
      setReauthorizingId(null);
    }
  };

  return (
    <SettingsSection
      title={t('settings:nav.sections.plexAccounts')}
      description={t('settings:nav.descriptions.plexAccounts')}
    >
      {user?.role !== 'owner' ? (
        <Alert>
          <Info />
          <AlertDescription>{t('pages:settings.plex.ownerOnly')}</AlertDescription>
        </Alert>
      ) : (
        <>
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : accounts.length === 0 ? (
            <EmptyState
              icon={Link2}
              title={t('pages:settings.plex.noAccountsLinked')}
              description={t('pages:settings.plex.noAccountsLinkedHint')}
            >
              <LinkAccountButton
                labelKey="settings.plex.linkPlexAccount"
                onClick={startPlexOAuth}
                disabled={oauthBusy}
                isLinking={isLinking}
              />
            </EmptyState>
          ) : (
            <>
              <ItemGroup className="gap-4">
                {accounts.map((account) => (
                  <PlexAccountRow
                    key={account.id}
                    account={account}
                    onUnlink={() => setShowUnlinkConfirm(account.id)}
                    onReauthorize={() => void startReauthorize(account.id)}
                    isReauthorizing={reauthorizingId === account.id}
                    oauthBusy={oauthBusy}
                  />
                ))}
              </ItemGroup>
              <LinkAccountButton
                variant="outline"
                labelKey="settings.plex.linkAnotherAccount"
                onClick={startPlexOAuth}
                disabled={oauthBusy}
                isLinking={isLinking}
              />
            </>
          )}

          {linkError && (
            <p className="text-destructive flex items-center gap-1 text-sm">
              <XCircle className="h-4 w-4" />
              {linkError}
            </p>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!showUnlinkConfirm}
        onOpenChange={() => setShowUnlinkConfirm(null)}
        title={t('pages:settings.plex.unlinkPlexAccount')}
        description={t('pages:settings.plex.unlinkConfirm')}
        confirmLabel={t('common:actions.disconnect')}
        onConfirm={() => showUnlinkConfirm && unlinkMutation.mutate(showUnlinkConfirm)}
        isLoading={unlinkMutation.isPending}
      />
    </SettingsSection>
  );
}
