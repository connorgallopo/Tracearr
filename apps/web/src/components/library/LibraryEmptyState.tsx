import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, RefreshCw, Clock, Loader2, BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { api } from '@/lib/api';
import { useServer } from '@/hooks/useServer';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useLibraryStatus } from '@/hooks/queries';
import { useSocket } from '@/hooks/useSocket';
import { WS_EVENTS } from '@tracearr/shared';
import type { MaintenanceJobProgress } from '@tracearr/shared';
import { ServerBadge } from '@/components/server';
import { librarySyncEnabled } from '@/lib/servers';

interface LibraryEmptyStateProps {
  /** Called after sync or backfill completes to refetch page data */
  onComplete?: () => void;
}

/**
 * Unified empty state component for library pages.
 *
 * Automatically detects the current state per selected server:
 * 1. Library sync disabled -> Explains session-only, no Sync Now
 * 2. Library not synced -> Shows sync button
 * 3. Library synced but needs backfill -> Shows backfill button
 * 4. Library synced, no backfill needed, but genuinely has no movies/shows
 *    -> media-appropriate empty message (never "not synced")
 * 5. Backfill running -> Shows progress
 *
 * With a single server selected this renders the same states as before.
 * With multiple servers selected (this component only renders when every
 * selected server is unready) it lists each server with its own state and
 * its own Sync Now action. The historical-data backfill is a single global
 * job shared by every server, so it keeps one button for all of them.
 */
export function LibraryEmptyState({ onComplete }: LibraryEmptyStateProps) {
  const { t } = useTranslation('pages');
  const { selectedServerIds, selectedServers } = useServer();
  const queryClient = useQueryClient();
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
  const [isStartingBackfill, setIsStartingBackfill] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<MaintenanceJobProgress | null>(null);

  // Fan out status across every selected server (works for one or many).
  const statusResult = useLibraryStatus(selectedServerIds);

  // Listen for maintenance progress via WebSocket
  const { socket } = useSocket();

  useEffect(() => {
    if (!socket) return;

    const handleProgress = (progress: MaintenanceJobProgress) => {
      if (progress.type !== 'backfill_library_snapshots') return;

      setBackfillProgress(progress);

      if (progress.status === 'complete') {
        void queryClient.invalidateQueries({ queryKey: ['library'] });
        void queryClient.invalidateQueries({ queryKey: ['media'] });
        onComplete?.();
        toast.success(t('library.emptyState.toast.backfillCompleteTitle'), {
          description: progress.message,
        });
        setBackfillProgress(null);
      } else if (progress.status === 'error') {
        toast.error(t('library.emptyState.toast.backfillErrorTitle'), {
          description: progress.message,
        });
        setBackfillProgress(null);
      }
    };

    socket.on(WS_EVENTS.MAINTENANCE_PROGRESS, handleProgress);

    return () => {
      socket.off(WS_EVENTS.MAINTENANCE_PROGRESS, handleProgress);
    };
  }, [socket, queryClient, onComplete, t]);

  const handleSync = async (serverId: string | undefined) => {
    if (!serverId) {
      toast.error(t('library.emptyState.toast.noServerSelected'));
      return;
    }

    setSyncingIds((prev) => new Set(prev).add(serverId));
    try {
      await api.servers.sync(serverId);
      toast.success(t('library.emptyState.toast.syncStartedTitle'), {
        description: t('library.emptyState.toast.syncStartedDesc'),
      });

      // Invalidate queries after a short delay
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['library'] });
        void queryClient.invalidateQueries({ queryKey: ['media'] });
        onComplete?.();
      }, 2000);
    } catch (err) {
      toast.error(t('library.emptyState.toast.syncFailedTitle'), {
        description:
          err instanceof Error ? err.message : t('library.emptyState.toast.genericRetry'),
      });
    } finally {
      setSyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(serverId);
        return next;
      });
    }
  };

  const handleBackfill = async () => {
    setIsStartingBackfill(true);
    try {
      await api.maintenance.startJob('backfill_library_snapshots');
      toast.success(t('library.emptyState.toast.backfillStartedTitle'), {
        description: t('library.emptyState.toast.backfillStartedDesc'),
      });
      void queryClient.invalidateQueries({ queryKey: ['library', 'status'] });
    } catch (err) {
      toast.error(t('library.emptyState.toast.backfillFailedTitle'), {
        description:
          err instanceof Error ? err.message : t('library.emptyState.toast.genericRetry'),
      });
    } finally {
      setIsStartingBackfill(false);
    }
  };

  // Show loading state while checking status
  if (statusResult.isLoading) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center">
        <Loader2 className="text-muted-foreground/50 mx-auto h-12 w-12 animate-spin" />
        <p className="text-muted-foreground mt-4">{t('library.emptyState.checkingStatus')}</p>
      </div>
    );
  }

  // The backfill job is global (not per-server), so its running state is the
  // same for every server - one entry is enough to check.
  const firstStatus = selectedServerIds.length
    ? statusResult.byServer.get(selectedServerIds[0] ?? '')?.data
    : undefined;
  const isBackfillRunningGlobally = firstStatus?.isBackfillRunning ?? false;

  // Show backfill progress
  if (isBackfillRunningGlobally || backfillProgress?.status === 'running') {
    const pct =
      backfillProgress && backfillProgress.totalRecords > 0
        ? Math.round((backfillProgress.processedRecords / backfillProgress.totalRecords) * 100)
        : 0;

    return (
      <div className="rounded-xl border border-dashed p-8 text-center">
        <Loader2 className="text-muted-foreground/50 mx-auto h-12 w-12 animate-spin" />
        <h3 className="mt-4 text-lg font-medium">
          {t('library.emptyState.backfillRunning.title')}
        </h3>
        <p className="text-muted-foreground mx-auto mt-2 max-w-md">
          {backfillProgress?.message || t('library.emptyState.backfillRunning.fallbackBody')}
        </p>
        {backfillProgress && backfillProgress.totalRecords > 0 && (
          <div className="mx-auto mt-4 max-w-xs space-y-2">
            <Progress value={pct} className="h-2" />
            <p className="text-muted-foreground text-sm">
              {t('library.emptyState.backfillRunning.progress', {
                processed: backfillProgress.processedRecords,
                total: backfillProgress.totalRecords,
              })}
              {backfillProgress.updatedRecords > 0 &&
                t('library.emptyState.backfillRunning.snapshotsSuffix', {
                  count: backfillProgress.updatedRecords,
                })}
            </p>
          </div>
        )}
      </div>
    );
  }

  const syncDisabledState = (
    <div className="rounded-xl border border-dashed p-8 text-center">
      <Database className="text-muted-foreground/50 mx-auto h-12 w-12" />
      <h3 className="mt-4 text-lg font-medium">{t('library.emptyState.syncDisabled.title')}</h3>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md">
        {t('library.emptyState.syncDisabled.body')}
      </p>
    </div>
  );

  // Single server selected: identical behavior to the pre-multi-server component.
  if (selectedServerIds.length <= 1) {
    const selectedServerId = selectedServerIds[0];
    const selectedServer = selectedServers.find((server) => server.id === selectedServerId);
    const librarySyncOff = selectedServer ? !librarySyncEnabled(selectedServer) : false;
    const data = selectedServerId ? statusResult.byServer.get(selectedServerId)?.data : undefined;
    const { isSynced, isSyncRunning, needsBackfill, backfillDays } = data ?? {};
    const isSyncing = selectedServerId ? syncingIds.has(selectedServerId) : false;

    if (librarySyncOff) {
      return syncDisabledState;
    }

    // Show backfill prompt if synced but needs backfill
    if (isSynced && needsBackfill) {
      // If sync is running, show message that backfill will run automatically
      if (isSyncRunning) {
        return (
          <div className="rounded-xl border border-dashed p-8 text-center">
            <Loader2 className="text-muted-foreground/50 mx-auto h-12 w-12 animate-spin" />
            <h3 className="mt-4 text-lg font-medium">
              {t('library.emptyState.backfillAvailable.syncRunningTitle')}
            </h3>
            <p className="text-muted-foreground mx-auto mt-2 max-w-md">
              {t('library.emptyState.backfillAvailable.syncRunningBody')}
            </p>
          </div>
        );
      }

      return (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <Clock className="text-muted-foreground/50 mx-auto h-12 w-12" />
          <h3 className="mt-4 text-lg font-medium">
            {t('library.emptyState.backfillAvailable.title')}
          </h3>
          <p className="text-muted-foreground mx-auto mt-2 max-w-md">
            {backfillDays
              ? t('library.emptyState.backfillAvailable.bodyWithDays', { days: backfillDays })
              : t('library.emptyState.backfillAvailable.bodyGeneric')}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={handleBackfill}
            disabled={isStartingBackfill}
          >
            {isStartingBackfill ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('library.emptyState.starting')}
              </>
            ) : (
              <>
                <BarChart3 className="mr-2 h-4 w-4" />
                {t('library.emptyState.generateHistory')}
              </>
            )}
          </Button>
        </div>
      );
    }

    // If sync is already running, show progress
    if (isSyncRunning || isSyncing) {
      return (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <Loader2 className="text-muted-foreground/50 mx-auto h-12 w-12 animate-spin" />
          <h3 className="mt-4 text-lg font-medium">
            {t('library.emptyState.syncInProgress.title')}
          </h3>
          <p className="text-muted-foreground mx-auto mt-2 max-w-md">
            {t('library.emptyState.syncInProgress.body')}
          </p>
        </div>
      );
    }

    // Synced, no backfill pending, nothing running - a genuinely empty
    // library. This is not "not synced yet"; that copy would be wrong here.
    if (isSynced) {
      return (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <Database className="text-muted-foreground/50 mx-auto h-12 w-12" />
          <h3 className="mt-4 text-lg font-medium">{t('library.emptyState.noMedia.title')}</h3>
          <p className="text-muted-foreground mx-auto mt-2 max-w-md">
            {t('library.emptyState.noMedia.body')}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => void handleSync(selectedServerId)}
            disabled={!selectedServerId}
          >
            <RefreshCw />
            {t('library.emptyState.syncNow')}
          </Button>
        </div>
      );
    }

    // Default: Library not synced
    return (
      <div className="rounded-xl border border-dashed p-8 text-center">
        <Database className="text-muted-foreground/50 mx-auto h-12 w-12" />
        <h3 className="mt-4 text-lg font-medium">{t('library.emptyState.notSynced.title')}</h3>
        <p className="text-muted-foreground mx-auto mt-2 max-w-md">
          {t('library.emptyState.notSynced.body')}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => void handleSync(selectedServerId)}
          disabled={!selectedServerId}
        >
          <RefreshCw />
          {t('library.emptyState.syncNow')}
        </Button>
      </div>
    );
  }

  // Multiple servers selected: show per-server state and a per-server sync
  // action, plus one shared button for the global backfill job.
  const rows = selectedServers
    .filter((server) => selectedServerIds.includes(server.id))
    .map((server) => ({ server, data: statusResult.byServer.get(server.id)?.data }));

  const syncEnabledRows = rows.filter((row) => librarySyncEnabled(row.server));
  if (rows.length > 0 && syncEnabledRows.length === 0) {
    return syncDisabledState;
  }

  const needsSync = syncEnabledRows.filter((row) => !row.data?.isSynced);
  const needsBackfillOnly = syncEnabledRows.filter(
    (row) => row.data?.isSynced && row.data.needsBackfill
  );

  return (
    <div className="rounded-xl border border-dashed p-8 text-center">
      <Database className="text-muted-foreground/50 mx-auto h-12 w-12" />
      <h3 className="mt-4 text-lg font-medium">{t('library.emptyState.multiServer.title')}</h3>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md">
        {t('library.emptyState.multiServer.body')}
      </p>

      {needsSync.length > 0 && (
        <ul className="mx-auto mt-6 max-w-sm space-y-2 text-left">
          {needsSync.map(({ server, data }) => {
            const isSyncing = syncingIds.has(server.id) || (data?.isSyncRunning ?? false);
            return (
              <li
                key={server.id}
                className="border-border flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <ServerBadge server={server} variant="outlined" />
                  <span className="text-muted-foreground text-sm">
                    {isSyncing
                      ? t('library.emptyState.syncing')
                      : t('library.emptyState.notSyncedShort')}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleSync(server.id)}
                  disabled={isSyncing}
                >
                  {isSyncing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {t('library.emptyState.syncNow')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {needsBackfillOnly.length > 0 && (
        <div className="mx-auto mt-6 max-w-md space-y-3">
          <p className="text-muted-foreground text-sm">
            {t('library.emptyState.multiServer.needsBackfillIntro')}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {needsBackfillOnly.map(({ server }) => (
              <ServerBadge key={server.id} server={server} variant="outlined" />
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleBackfill}
            disabled={isStartingBackfill}
          >
            {isStartingBackfill ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('library.emptyState.starting')}
              </>
            ) : (
              <>
                <BarChart3 className="mr-2 h-4 w-4" />
                {t('library.emptyState.generateHistory')}
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
