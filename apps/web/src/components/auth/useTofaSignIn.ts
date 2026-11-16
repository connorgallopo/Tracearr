import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Server } from '@tracearr/shared';
import { api, ApiError, type TofaCloudServer } from '@/lib/api';
import { isNotPermitted, type SignInFailure, toastNotPermitted } from '@/lib/signInRefusal';

// tofa answers slow_down when polled too often; the device flow then wants 5 s more per poll.
const SLOW_DOWN_MS = 5000;

/**
 * Signs in through tofa cloud's device flow: tofa shows Approve in a popup while the browser
 * polls. A known account is signed in at once; otherwise the owner picks one of their servers
 * and Tracearr makes its own key there, for a first run or for Add server. A link signs the
 * owner in to tofa as their account on one server, which then joins the owner.
 */
export function useTofaSignIn({
  purpose,
  claimCode,
  onSignedIn,
  onAdded,
  onLinked,
}: {
  /** link names the tofa server whose account is linked. */
  purpose: 'sign-in' | 'add-server' | { link: string };
  claimCode?: string;
  /** Gets the connected server's name when the sign-in also connected one. */
  onSignedIn?: (connectedServer?: string) => Promise<void>;
  onAdded?: (result: { server: Server; canStopStreams: boolean }) => void | Promise<void>;
  onLinked?: () => void;
}) {
  const { t } = useTranslation('pages');
  const [step, setStep] = useState<
    'idle' | 'waiting' | 'select-server' | 'no-servers' | 'all-connected'
  >('idle');
  const [verificationUri, setVerificationUri] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [servers, setServers] = useState<TofaCloudServer[]>([]);
  const [tempToken, setTempToken] = useState<string | null>(null);
  const [connectingTo, setConnectingTo] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState<{ serverId: string; address: string } | null>(
    null
  );
  const [error, setError] = useState<SignInFailure | null>(null);
  const popup = useRef<Window | null>(null);
  // The handle being polled; a cancel or unmount clears it so a late answer is ignored.
  const polling = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped by every start and cancel, so a start that was cancelled while awaiting does nothing.
  const attempt = useRef(0);
  // Set before the first await, so a second click in the same frame cannot make a second key.
  const connecting = useRef(false);

  const stopPolling = () => {
    polling.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const closePopup = () => {
    if (popup.current && !popup.current.closed) {
      popup.current.close();
    }
    popup.current = null;
  };

  useEffect(
    () => () => {
      attempt.current += 1;
      stopPolling();
      closePopup();
    },
    []
  );

  const cancel = () => {
    attempt.current += 1;
    closePopup();
    stopPolling();
    setStep('idle');
    setVerificationUri(null);
    setUserCode(null);
    setExpiresAt(null);
    setUsername(null);
    setServers([]);
    setTempToken(null);
    setConnectingTo(null);
    setUnreachable(null);
    setError(null);
  };

  /** Ends the sign-in and says why, unless tofa vouched for someone the owner keeps out. */
  const fail = (failure: unknown) => {
    cancel();
    if (isNotPermitted(failure)) {
      toastNotPermitted(t('login.member.notPermitted'));
      return;
    }
    setError({
      kind: 'failed',
      ...(failure instanceof Error && { message: failure.message }),
    });
  };

  const schedule = (handle: string, intervalMs: number, retry = false) => {
    timer.current = setTimeout(() => void poll(handle, intervalMs, retry), intervalMs);
  };

  const poll = async (handle: string, intervalMs: number, retry: boolean) => {
    if (polling.current !== handle) return;
    const thisAttempt = attempt.current;
    try {
      const result = await api.auth.checkTofa({
        handle,
        ...(claimCode !== undefined && { claimCode }),
      });
      if (polling.current !== handle) return;

      switch (result.status) {
        case 'pending':
          schedule(handle, intervalMs);
          return;
        case 'slow_down':
          schedule(handle, intervalMs + SLOW_DOWN_MS);
          return;
        case 'expired':
          cancel();
          setError({ kind: 'expired' });
          return;
        case 'signed-in':
          stopPolling();
          closePopup();
          await onSignedIn?.();
          return;
        case 'no-servers':
        case 'all-connected':
          stopPolling();
          closePopup();
          setUsername(result.username);
          setStep(result.status);
          return;
        case 'linked':
          cancel();
          onLinked?.();
          return;
        case 'select-server':
          stopPolling();
          closePopup();
          setUsername(result.username);
          setServers(result.servers);
          setTempToken(result.tempToken);
          setStep('select-server');
          return;
      }
    } catch (checkError) {
      // Polling has stopped once someone is signed in, so only a cancel or unmount makes this stale.
      if (attempt.current !== thisAttempt) return;
      // Only a check that got no answer is tried again: the server may have spent the device code
      // before failing, so a second check after an answer would report the code as expired.
      const answered = checkError instanceof ApiError;
      if (!retry && !answered && polling.current === handle) {
        schedule(handle, intervalMs, true);
        return;
      }
      fail(checkError);
    }
  };

  const start = async () => {
    const thisAttempt = ++attempt.current;
    stopPolling();
    setError(null);
    setStep('waiting');

    // A blank same-origin page first, so the window can still be closed after it leaves for tofa
    popup.current = window.open('about:blank', 'tofa_auth', 'width=600,height=700,popup=yes');

    try {
      const result =
        typeof purpose === 'string'
          ? await api.auth.initiateTofa(purpose)
          : await api.auth.initiateTofaLink(purpose.link);
      if (attempt.current !== thisAttempt) return;
      setVerificationUri(result.verificationUri);
      setUserCode(result.userCode);
      setExpiresAt(Date.now() + result.expiresIn * 1000);

      if (popup.current && !popup.current.closed) {
        popup.current.location.assign(result.verificationUri);
      }

      polling.current = result.handle;
      schedule(result.handle, result.interval * 1000);
    } catch (startError) {
      if (attempt.current !== thisAttempt) return;
      fail(startError);
    }
  };

  const connect = async (serverId: string, url?: string) => {
    if (!tempToken || connecting.current) return;
    connecting.current = true;
    setConnectingTo(serverId);
    setError(null);

    try {
      const picked = { tempToken, serverId, ...(url && { url }) };
      const result =
        purpose === 'add-server'
          ? await api.auth.addTofaServer(picked)
          : await api.auth.connectTofa({
              ...picked,
              ...(claimCode !== undefined && { claimCode }),
            });

      switch (result.status) {
        case 'expired':
          setError({ kind: 'timed-out' });
          return;
        case 'unreachable':
          setUnreachable({ serverId, address: result.address });
          return;
        case 'signed-in':
          setUnreachable(null);
          await onSignedIn?.(servers.find((server) => server.id === serverId)?.name);
          return;
        case 'added':
          await onAdded?.({ server: result.server, canStopStreams: result.canStopStreams });
          cancel();
          return;
      }
    } catch (connectError) {
      const message = connectError instanceof Error ? connectError.message : undefined;
      setError({ kind: 'connect-failed', ...(message !== undefined && { message }) });
    } finally {
      connecting.current = false;
      setConnectingTo(null);
    }
  };

  return {
    step,
    verificationUri,
    userCode,
    expiresAt,
    username,
    servers,
    connectingTo,
    unreachable,
    error,
    start,
    cancel,
    connect,
  };
}
