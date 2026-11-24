import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import type { SiloPairCheck, SiloPairStart, siloPairStartSchema } from '@tracearr/shared';
import { authClient } from '@/lib/authClient';

const PENDING: SiloPairCheck = { status: 'pending', opened: false };

/** Pending, or a login parked for a PIN: Tracearr still holds state for the handle. */
const isLive = (check: SiloPairCheck) => check.status === 'pending' || check.status === 'needs-pin';

/** Null when the request never reached Tracearr; better-fetch throws on a dropped request. */
async function send<T>(url: string, body: object, fallback: string): Promise<T | null> {
  const result = await authClient.$fetch<T>(url, { method: 'POST', body }).catch(() => null);
  if (!result) return null;
  if (result.error || !result.data) throw new Error(result.error?.message ?? fallback);
  return result.data;
}

function dropHandle(handle: string) {
  void send('/silo/pair/cancel', { handle }, '').catch(() => undefined);
}

/**
 * A code a Silo admin approves, for adding a Silo server or replacing its key. Checks run one at
 * a time: two in flight for one handle could let one delete a login the other just parked for a
 * PIN. A dropped check keeps polling; an HTTP error ends it with the message.
 */
export function useSiloPairing() {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const [pairing, setPairing] = useState<SiloPairStart | null>(null);
  const [starting, setStarting] = useState(false);
  const [submittingPin, setSubmittingPin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The handle Tracearr may still hold a code or a parked login for, which cancel ends.
  const liveHandle = useRef<string | null>(null);
  // Bumped by every start and cancel, so an answer for an abandoned attempt is not shown.
  const attempt = useRef(0);
  const pinInFlight = useRef(false);
  const handle = pairing?.handle;
  const queryKey = ['silo-pairing', handle];

  // A handle canceled while its answer was on the way may have just been parked again.
  const settle = (forHandle: string, check: SiloPairCheck) => {
    if (liveHandle.current !== forHandle) {
      if (isLive(check)) dropHandle(forHandle);
    } else if (!isLive(check)) {
      liveHandle.current = null;
    }
  };

  const poll = useQuery({
    queryKey,
    queryFn: async () => {
      if (!handle) return PENDING;
      let check: SiloPairCheck | null;
      try {
        check = await send<SiloPairCheck>('/silo/pair/check', { handle }, t('errors.generic'));
      } catch (refused) {
        if (liveHandle.current === handle) liveHandle.current = null;
        throw refused;
      }
      if (!check) return queryClient.getQueryData<SiloPairCheck>(queryKey) ?? PENDING;
      settle(handle, check);
      return check;
    },
    enabled: !!handle,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchIntervalInBackground: true,
    refetchInterval: (query) => {
      const { data, status } = query.state;
      if (!pairing || status === 'error' || (data && data.status !== 'pending')) return false;
      return pairing.interval * 1000;
    },
  });

  const reset = () => {
    attempt.current += 1;
    liveHandle.current = null;
    setPairing(null);
    setStarting(false);
    setError(null);
  };

  const cancel = () => {
    const live = liveHandle.current;
    reset();
    if (live) dropHandle(live);
  };

  useEffect(
    () => () => {
      attempt.current += 1;
      const live = liveHandle.current;
      liveHandle.current = null;
      if (live) dropHandle(live);
    },
    []
  );

  const start = (body: z.infer<typeof siloPairStartSchema>) => {
    cancel();
    const mine = attempt.current;
    setStarting(true);
    send<SiloPairStart>('/silo/pair/start', body, t('errors.generic'))
      .then((started) => {
        if (!started) throw new Error(t('errors.generic'));
        if (attempt.current !== mine) {
          dropHandle(started.handle);
          return;
        }
        liveHandle.current = started.handle;
        setPairing(started);
      })
      .catch((failed: unknown) => {
        if (attempt.current === mine)
          setError(failed instanceof Error ? failed.message : t('errors.generic'));
      })
      .finally(() => {
        if (attempt.current === mine) setStarting(false);
      });
  };

  const submitPin = (pin: string) => {
    if (!handle || pinInFlight.current || queryClient.isFetching({ queryKey }) > 0) return;
    pinInFlight.current = true;
    setSubmittingPin(true);
    setError(null);
    const mine = attempt.current;
    send<SiloPairCheck>('/silo/pair/check', { handle, pin }, t('errors.generic'))
      .then((check) => {
        if (!check) {
          if (attempt.current === mine) setError(t('errors.generic'));
          return;
        }
        settle(handle, check);
        if (attempt.current === mine) queryClient.setQueryData(queryKey, check);
      })
      .catch((failed: unknown) => {
        if (liveHandle.current === handle) liveHandle.current = null;
        if (attempt.current === mine)
          setError(failed instanceof Error ? failed.message : t('errors.generic'));
      })
      .finally(() => {
        pinInFlight.current = false;
        setSubmittingPin(false);
      });
  };

  return {
    start,
    starting,
    pairing,
    check: pairing ? (poll.data ?? null) : null,
    submitPin,
    submittingPin,
    cancel,
    error: error ?? poll.error?.message ?? null,
    reset,
  };
}
