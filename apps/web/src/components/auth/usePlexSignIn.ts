import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { PlexDiscoveredServer } from '@tracearr/shared';
import { api, BASE_URL } from '@/lib/api';
import {
  isNotPermitted,
  isSignInExpired,
  type SignInFailure,
  toastNotPermitted,
} from '@/lib/signInRefusal';

const PIN_POLL_INTERVAL_MS = 2000;

/**
 * Signs in through plex.tv with a PIN the server redeems. On a first run with Plex servers
 * on the account, the owner picks one before the account exists; onSignedIn gets its name.
 */
export function usePlexSignIn({
  claimCode,
  onSignedIn,
}: {
  claimCode: string | undefined;
  onSignedIn: (connectedServer?: string) => Promise<void>;
}) {
  const { t } = useTranslation(['pages', 'common', 'notifications']);
  const [step, setStep] = useState<'idle' | 'waiting' | 'server-select'>('idle');
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [servers, setServers] = useState<PlexDiscoveredServer[]>([]);
  const [tempToken, setTempToken] = useState<string | null>(null);
  const [connectingTo, setConnectingTo] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [error, setError] = useState<SignInFailure | null>(null);
  const popup = useRef<Window | null>(null);
  // The handle being polled; a cancel or unmount clears it so a late answer is ignored.
  const polling = useRef<string | null>(null);
  // Bumped by every start and cancel, so a start that was cancelled while awaiting does nothing.
  const attempt = useRef(0);

  useEffect(
    () => () => {
      polling.current = null;
    },
    []
  );

  const closePopup = () => {
    if (popup.current && !popup.current.closed) {
      popup.current.close();
    }
    popup.current = null;
  };

  const cancel = () => {
    attempt.current += 1;
    closePopup();
    polling.current = null;
    setStep('idle');
    setAuthUrl(null);
    setServers([]);
    setTempToken(null);
    setConnectingTo(null);
    setUsername(null);
    setError(null);
  };

  const poll = async (handle: string) => {
    if (polling.current !== handle) return;
    try {
      const result = await api.auth.checkPlexPin({
        handle,
        ...(claimCode !== undefined && { claimCode }),
      });
      if (polling.current !== handle) return;

      if (result.expired) {
        cancel();
        setError({ kind: 'expired' });
        return;
      }
      if (!result.authorized) {
        setTimeout(() => void poll(handle), PIN_POLL_INTERVAL_MS);
        return;
      }

      polling.current = null;
      closePopup();

      if (result.needsServerSelection && result.servers && result.tempToken) {
        setServers(result.servers);
        setTempToken(result.tempToken);
        setUsername(result.username ?? null);
        setStep('server-select');
      } else if (result.user) {
        await onSignedIn();
      }
    } catch (error) {
      cancel();
      if (isNotPermitted(error)) {
        toastNotPermitted(t('pages:login.member.notPermitted'));
        return;
      }
      toast.error(t('notifications:toast.error.authFailed'), {
        description: error instanceof Error ? error.message : t('pages:login.plexAuthFailed'),
      });
    }
  };

  const start = async () => {
    const thisAttempt = ++attempt.current;
    setError(null);
    setStep('waiting');

    // A blank same-origin page first, so the window can still be closed after it leaves for plex.tv
    popup.current = window.open('about:blank', 'plex_auth', 'width=600,height=700,popup=yes');

    try {
      const callbackUrl = `${window.location.origin}${BASE_URL}auth/plex-callback`;
      const result = await api.auth.initiatePlex(callbackUrl);
      if (attempt.current !== thisAttempt) return;
      setAuthUrl(result.authUrl);

      if (popup.current && !popup.current.closed) {
        popup.current.location.assign(result.authUrl);
      }

      polling.current = result.handle;
      void poll(result.handle);
    } catch (error) {
      if (attempt.current !== thisAttempt) return;
      closePopup();
      setStep('idle');
      toast.error(t('common:errors.generic'), {
        description: error instanceof Error ? error.message : t('pages:login.plexStartFailed'),
      });
    }
  };

  const selectServer = async (serverUri: string, serverName: string, clientIdentifier: string) => {
    if (!tempToken) return;

    setConnectingTo(serverName);
    setError(null);

    try {
      const result = await api.auth.connectPlexServer({
        tempToken,
        serverUri,
        serverName,
        clientIdentifier,
        ...(claimCode !== undefined && { claimCode }),
      });

      if (result.authorized) {
        await onSignedIn(serverName);
      }
    } catch (connectError) {
      const message = connectError instanceof Error ? connectError.message : undefined;
      setError({
        kind: isSignInExpired(connectError) ? 'timed-out' : 'connect-failed',
        ...(message !== undefined && { message }),
      });
    } finally {
      setConnectingTo(null);
    }
  };

  const testCustomUrl = tempToken
    ? async (uri: string) => {
        const result = await api.auth.testPlexConnection({
          uri,
          tempToken,
          ...(claimCode ? { claimCode } : {}),
        });
        return result.connection;
      }
    : undefined;

  return {
    step,
    authUrl,
    servers,
    username,
    connectingTo,
    error,
    start,
    cancel,
    selectServer,
    testCustomUrl,
  };
}
