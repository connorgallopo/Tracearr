import { useEffect, useEffectEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  WS_EVENTS,
  assertNever,
  type ImportRetry,
  type ImportWaitingForLibrarySync,
  type JellystatImportProgress,
  type JellystatImportResult,
  type LatestImportStatus,
  type PlaybackReportingImportProgress,
  type PlaybackReportingImportResult,
  type TautulliImportProgress,
  type TautulliImportResult,
  type TofaImportProgress,
  type TofaImportResult,
} from '@tracearr/shared';
import { api } from '@/lib/api';
import { useMultiServerQuery, type MultiServerQueryResult } from '@/hooks/useMultiServerQuery';
import { useSocket } from '@/hooks/useSocket';

/** A card shows one server, so its progress needs no server of its own. */
export type CardProgress<P> = Omit<P, 'serverId'>;

interface ImportShapes {
  tautulli: { progress: CardProgress<TautulliImportProgress>; result: TautulliImportResult };
  jellystat: { progress: CardProgress<JellystatImportProgress>; result: JellystatImportResult };
  playbackReporting: {
    progress: CardProgress<PlaybackReportingImportProgress>;
    result: PlaybackReportingImportResult;
  };
  tofa: { progress: CardProgress<TofaImportProgress>; result: TofaImportResult };
}

export type ImportSource = keyof ImportShapes;

type ProgressOf<S extends ImportSource> = ImportShapes[S]['progress'];
type LatestOf<S extends ImportSource> = LatestImportStatus<
  ImportShapes[S]['progress'],
  ImportShapes[S]['result']
>;

const PROGRESS_EVENTS = {
  tautulli: WS_EVENTS.IMPORT_PROGRESS,
  jellystat: WS_EVENTS.IMPORT_JELLYSTAT_PROGRESS,
  playbackReporting: WS_EVENTS.IMPORT_PLAYBACK_REPORTING_PROGRESS,
  tofa: WS_EVENTS.IMPORT_TOFA_PROGRESS,
} as const satisfies Record<ImportSource, string>;

type ImportAnswer<S extends ImportSource> = { latest: LatestOf<S> | null };

/** Each server's latest import from one source; useSocket refreshes it on job events. */
export function useActiveImports<S extends ImportSource>(source: S, serverIds: string[]) {
  return useMultiServerQuery<ImportAnswer<S>>(serverIds, (serverId) => ({
    queryKey: ['import', source, serverId],
    queryFn: () => api.import[source].getActive(serverId) as Promise<ImportAnswer<S>>,
  }));
}

export function latestImport<S extends ImportSource>(
  imports: MultiServerQueryResult<ImportAnswer<S>>,
  serverId: string
): LatestOf<S> | null {
  return imports.byServer.get(serverId)?.data?.latest ?? null;
}

/** Held, queued, running or retrying: the import goes ahead without the owner. */
function importPending(latest: { state: string } | null): boolean {
  return latest !== null && latest.state !== 'failed' && latest.state !== 'complete';
}

/** The server whose import is under way, else one with a finished or failed import; '' when none. */
export function serverWithImport(
  serverIds: string[],
  ...sources: ((serverId: string) => { state: string } | null)[]
): string {
  const find = (test: (latest: { state: string } | null) => boolean) =>
    serverIds.find((id) => sources.some((latestOf) => test(latestOf(id))));
  return find(importPending) ?? find((latest) => latest !== null) ?? '';
}

/** What an import held for the server's first library sync says while it waits. */
export function waitingForLibrarySyncMessage(
  waiting: ImportWaitingForLibrarySync,
  t: TFunction<'settings'>
): string {
  const percent = waiting.librarySync?.progress;
  return percent == null
    ? t('import.waitingForLibrarySync')
    : t('import.waitingForLibrarySyncPercent', { percent });
}

function failedMessage(reason: string | null, t: TFunction<'settings'>): string {
  return reason ? t('import.importFailedReason', { reason }) : t('import.importFailed');
}

function retryingMessage(retry: ImportRetry, t: TFunction<'settings'>): string {
  return t('import.importRetrying', {
    // The copy ends the reason with its own full stop
    reason: retry.reason?.replace(/\.$/, '') || t('import.importFailed'),
    attempt: retry.attempt + 1,
    attempts: retry.attempts,
  });
}

/** How a source builds its own progress shape for a state the status read gives. */
export interface ImportProgressShape<P, R> {
  blank: (
    status: 'waiting' | 'processing' | 'retrying' | 'complete' | 'error',
    message: string
  ) => P;
  fromResult: (result: R) => P;
}

/** A server's latest import as its source's progress card shows it, or null when it has none. */
export function latestImportProgress<P, R>(
  latest: LatestImportStatus<P, R> | null,
  { blank, fromResult }: ImportProgressShape<P, R>,
  t: TFunction<'settings'>
): P | null {
  switch (latest?.state) {
    case undefined:
      return null;
    case 'waitingForLibrarySync':
      return blank('waiting', waitingForLibrarySyncMessage(latest, t));
    case 'queued':
      return blank('waiting', t('import.importQueued'));
    case 'running':
      return latest.progress ?? blank('processing', t('import.importInProgressGeneric'));
    case 'retrying':
      return blank('retrying', retryingMessage(latest, t));
    case 'failed':
      return blank('error', failedMessage(latest.reason, t));
    case 'complete':
      return fromResult(latest.result);
    default:
      return assertNever(latest);
  }
}

/**
 * What the start button does beside the card: nothing while the import goes ahead on its own
 * (pending), stays busy while it runs, and offers the import again once it failed.
 */
export type ImportPhase = 'none' | 'pending' | 'importing' | 'failed' | 'complete';

export function importPhase(progress: { status: string } | null): ImportPhase {
  switch (progress?.status) {
    case undefined:
    case 'idle':
      return 'none';
    case 'waiting':
    case 'retrying':
      return 'pending';
    case 'error':
      return 'failed';
    case 'complete':
      return 'complete';
    default:
      return 'importing';
  }
}

/**
 * One import source's card for the server shown: its latest import from the status read, and the
 * progress its socket channel brings for that server while this page is open. `start` runs a start
 * request and shows it starting, or failing to.
 */
export function useImportStatus<S extends ImportSource>(
  source: S,
  serverId: string,
  latest: LatestOf<S> | null,
  shape: ImportProgressShape<ProgressOf<S>, ImportShapes[S]['result']>,
  events: { onStarted?: () => void; onSettled?: () => void } = {}
) {
  const { t } = useTranslation('settings');
  const { socket } = useSocket();
  const queryClient = useQueryClient();
  const [liveByServer, setLiveByServer] = useState<Record<string, ProgressOf<S> | null>>({});
  const live = liveByServer[serverId] ?? null;
  type LiveProgress = ProgressOf<S> & { serverId: string };
  const setLive = (id: string, next: ProgressOf<S> | null) =>
    setLiveByServer((current) => ({ ...current, [id]: next }));

  // A held or queued import is never announced on the socket, so only the status read knows it
  const waitsInQueue = latest?.state === 'waitingForLibrarySync' || latest?.state === 'queued';
  const progress =
    waitsInQueue || !live
      ? latestImportProgress(latest, shape, t)
      : live.status === 'retrying' && live.retry
        ? { ...live, message: retryingMessage(live.retry, t) }
        : live;

  const onProgress = useEffectEvent((next: LiveProgress) => {
    setLive(next.serverId, next);
    if (next.serverId !== serverId) return;
    // Progress means the import left the queue; ask now rather than wait for useSocket's refresh
    if (waitsInQueue) void queryClient.invalidateQueries({ queryKey: ['import', source] });
    if (next.status === 'complete' || next.status === 'error') events.onSettled?.();
  });

  useEffect(() => {
    if (!socket) return;
    type Listener = (next: LiveProgress) => void;
    // socket.io's event typing cannot follow an event and payload that are both chosen by S
    const channel = socket as unknown as {
      on: (event: string, listener: Listener) => void;
      off: (event: string, listener: Listener) => void;
    };
    const event = PROGRESS_EVENTS[source];
    const listener: Listener = (next) => onProgress(next);
    channel.on(event, listener);
    return () => {
      channel.off(event, listener);
    };
  }, [socket, source]);

  const underway = latest !== null && latest.state !== 'failed';
  const announce = useEffectEvent(() => events.onStarted?.());
  useEffect(() => {
    if (underway) announce();
  }, [underway]);

  const start = async (starting: ProgressOf<S>, request: () => Promise<unknown>) => {
    events.onStarted?.();
    setLive(serverId, starting);
    try {
      await request();
      void queryClient.invalidateQueries({ queryKey: ['import', source] });
    } catch (err) {
      setLive(
        serverId,
        shape.blank('error', failedMessage(err instanceof Error ? err.message : null, t))
      );
    }
  };

  return {
    progress,
    phase: importPhase(progress),
    start,
    show: (next: ProgressOf<S> | null) => setLive(serverId, next),
  };
}
