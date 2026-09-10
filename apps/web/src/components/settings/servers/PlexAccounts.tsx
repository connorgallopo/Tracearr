import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { ItemGroup } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Info, Link2, Loader2, Plus, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { PlexAccountRow } from '@/components/settings/servers/PlexAccountRow';
import { useAuth } from '@/hooks/useAuth';

// Plex OAuth configuration. The client identifier is NOT hardcoded: plex.tv
// scopes a PIN to the identifier that created it, and the server redeems the
// PIN this component creates, so both ends must send the same per-install
// value. It comes from GET /auth/plex/accounts.
const PLEX_OAUTH_URL = 'https://app.plex.tv/auth#';
const PIN_POLL_INTERVAL_MS = 2000;
const PIN_POLL_TIMEOUT_MS = 5 * 60 * 1000;

/** Resolves with the authorized pin id, which the server redeems for a token. */
async function runPlexOAuth(clientIdentifier: string): Promise<string> {
  const pinResponse = await fetch('https://plex.tv/api/v2/pins', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Plex-Client-Identifier': clientIdentifier,
      'X-Plex-Product': 'Tracearr',
    },
    body: JSON.stringify({
      strong: true,
      'X-Plex-Product': 'Tracearr',
      'X-Plex-Client-Identifier': clientIdentifier,
    }),
  });

  if (!pinResponse.ok) {
    throw new Error('Failed to create Plex PIN');
  }

  const pin = (await pinResponse.json()) as { id: number; code: string };
  const oauthUrl = `${PLEX_OAUTH_URL}?clientID=${clientIdentifier}&code=${pin.code}&context%5Bdevice%5D%5Bproduct%5D=Tracearr`;
  const oauthWindow = window.open(oauthUrl, 'plex_oauth', 'width=600,height=700');

  try {
    const deadline = Date.now() + PIN_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PIN_POLL_INTERVAL_MS));

      const check = await fetch(`https://plex.tv/api/v2/pins/${pin.id}`, {
        headers: {
          Accept: 'application/json',
          'X-Plex-Client-Identifier': clientIdentifier,
        },
      }).catch(() => null);

      if (!check) continue;
      if (!check.ok) throw new Error('Failed to check PIN status');

      const { authToken } = (await check.json()) as { authToken: string | null };
      if (authToken) return String(pin.id);
    }

    throw new Error('OAuth timeout - please try again');
  } finally {
    oauthWindow?.close();
  }
}

/** The empty-state and post-link buttons differ only in emphasis and label. */
function LinkAccountButton({
  variant,
  labelKey,
  onClick,
  disabled,
  isLinking,
}: {
  variant?: 'default' | 'outline';
  labelKey: 'settings.plex.linkPlexAccount' | 'settings.plex.linkAnotherAccount';
  onClick: () => void;
  disabled: boolean;
  isLinking: boolean;
}) {
  const { t } = useTranslation('pages');

  return (
    <Button variant={variant} onClick={onClick} disabled={disabled}>
      {isLinking ? (
        <>
          <Loader2 className="animate-spin" />
          {t('settings.plex.linking')}
        </>
      ) : (
        <>
          <Plus className="mr-2 h-4 w-4" />
          {t(labelKey)}
        </>
      )}
    </Button>
  );
}

export function PlexAccounts() {
  const { t } = useTranslation(['notifications', 'pages', 'common', 'settings']);
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState<string | null>(null);
  const [isLinking, setIsLinking] = useState(false);
  const [reauthorizingId, setReauthorizingId] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Both flows drive the same named popup, so a second start would steal the
  // first one's window and leave it polling a PIN nobody will authorize.
  const oauthBusy = isLinking || reauthorizingId !== null;

  const {
    data: accountsData,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['plex-accounts'],
    queryFn: () => api.auth.getPlexAccounts(),
  });

  const accounts = accountsData?.accounts ?? [];
  const plexClientId = accountsData?.clientIdentifier;

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

  const startPlexOAuth = async () => {
    if (!plexClientId) {
      setLinkError('Plex client identifier unavailable - reload and try again');
      return;
    }

    setIsLinking(true);
    setLinkError(null);

    try {
      const pinId = await runPlexOAuth(plexClientId);
      await api.auth.linkPlexAccount(pinId);

      toast.success(t('toast.success.plexAccountLinked.title'), {
        description: t('toast.success.plexAccountLinked.message'),
      });
      await refetch();
      await queryClient.invalidateQueries({ queryKey: ['plex-accounts'] });
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : 'Failed to link account');
    } finally {
      setIsLinking(false);
    }
  };

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
