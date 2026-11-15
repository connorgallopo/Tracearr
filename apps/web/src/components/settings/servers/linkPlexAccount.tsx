import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { ServerType } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { AuthFormError } from '@/components/auth/AuthFormError';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { usePlexAccounts } from '@/hooks/queries';
import { api } from '@/lib/api';

// Plex OAuth configuration. The client identifier is NOT hardcoded: plex.tv
// scopes a PIN to the identifier that created it, and the server redeems the
// PIN this flow creates, so both ends must send the same per-install
// value. It comes from GET /auth/plex/accounts.
const PLEX_OAUTH_URL = 'https://app.plex.tv/auth#';
const PIN_POLL_INTERVAL_MS = 2000;
const PIN_POLL_TIMEOUT_MS = 5 * 60 * 1000;

/** Resolves with the authorized pin id, which the server redeems for a token. */
export async function runPlexOAuth(clientIdentifier: string): Promise<string> {
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

/** Links one more Plex account to the owner through the plex.tv popup. */
export function useLinkPlexAccount() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();
  const { data } = usePlexAccounts();
  const [isLinking, setIsLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const clientIdentifier = data?.clientIdentifier;

  const link = async (): Promise<boolean> => {
    if (!clientIdentifier) {
      setLinkError('Plex client identifier unavailable - reload and try again');
      return false;
    }

    setIsLinking(true);
    setLinkError(null);

    try {
      const pinId = await runPlexOAuth(clientIdentifier);
      await api.auth.linkPlexAccount(pinId);

      toast.success(t('toast.success.plexAccountLinked.title'), {
        description: t('toast.success.plexAccountLinked.message'),
      });
      await queryClient.invalidateQueries({ queryKey: ['plex-accounts'] });
      return true;
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : 'Failed to link account');
      return false;
    } finally {
      setIsLinking(false);
    }
  };

  return { link, isLinking, linkError, setLinkError, clientIdentifier };
}

/** The empty-state and post-link buttons differ only in emphasis and label. */
export function LinkAccountButton({
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

/** Shown when the owner has no Plex account linked, so no Plex server can be listed. */
export function LinkPlexAccountPrompt({
  serverType,
  error,
  onLinked,
}: {
  serverType: ServerType;
  error: string | null;
  onLinked: () => Promise<void>;
}) {
  const { t } = useTranslation('pages');
  const { link, isLinking, linkError } = useLinkPlexAccount();

  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia>
          <MediaServerIcon type={serverType} alt="" className="size-10" />
        </EmptyMedia>
        <EmptyTitle>{t('setup.linkPlexTitle')}</EmptyTitle>
        <EmptyDescription>{t('setup.linkPlexDescription')}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <LinkAccountButton
          labelKey="settings.plex.linkPlexAccount"
          onClick={async () => {
            if (await link()) await onLinked();
          }}
          disabled={isLinking}
          isLinking={isLinking}
        />
        <AuthFormError message={linkError ?? error} />
      </EmptyContent>
    </Empty>
  );
}
