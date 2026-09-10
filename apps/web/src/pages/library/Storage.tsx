import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { HardDrive, TrendingUp, Copy, Archive } from 'lucide-react';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  ErrorState,
  InlineErrorState,
  LibraryEmptyState,
  DuplicatesTable,
  StaleContentTabs,
  RoiTable,
  DeadWeightTable,
  DeadWeightTableSkeleton,
} from '@/components/library';
import { StoragePredictionChart } from '@/components/charts';
import { PerServerCardGrid } from '@/components/server';
import {
  useLibraryDuplicates,
  useLibraryStale,
  useLibraryRoi,
  useLibraryStatus,
  useLibraryStorageScoped,
  useShelves,
} from '@/hooks/queries';
import { useMultiServerQuery } from '@/hooks/useMultiServerQuery';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';
import { formatBytes } from '@/lib/formatters';
import { api } from '@/lib/api';
import { toast } from 'sonner';

export function LibraryStorage() {
  const { t } = useTranslation(['pages', 'common']);
  const { selectedServerIds, selectedServers, servers, isMultiServer } = useServer();
  const { value: timeRange, setValue: setTimeRange } = useTimeRange();

  // Check library status - fan out per server to detect which need setup
  const statusResult = useLibraryStatus(selectedServerIds);

  // Pagination state for tables
  const [duplicatesPage, setDuplicatesPage] = useState(1);
  const [roiPage, setRoiPage] = useState(1);

  // Storage trend chart toggle
  const [showPredictions, setShowPredictions] = useState(true);

  // ROI sorting and filtering state - default to high ROI first
  const [roiSortBy, setRoiSortBy] = useState<
    'watch_hours_per_gb' | 'value_score' | 'file_size' | 'title'
  >('watch_hours_per_gb');
  const [roiSortOrder, setRoiSortOrder] = useState<'asc' | 'desc'>('desc');
  const [roiMediaType, setRoiMediaType] = useState<'all' | 'movie' | 'show' | 'artist'>('all');

  // Map TimeRangePicker periods to API format
  const apiPeriod = useMemo(() => {
    switch (timeRange.period) {
      case 'week':
        return '7d';
      case 'month':
        return '30d';
      case 'year':
        return '1y';
      case 'all':
        return 'all';
      default:
        return '30d';
    }
  }, [timeRange.period]);

  // Fan out storage per server - storage endpoint is single-server only
  const storageMulti = useMultiServerQuery(selectedServerIds, (id) => ({
    queryKey: ['library', 'storage', id, undefined, apiPeriod],
    queryFn: () => api.library.storage(id, undefined, apiPeriod),
  }));

  // Combined KPI: one request over the whole selection so the server-side
  // mirror dedup spans servers - summing per-server totals double-counts
  // every file two servers share. Single-server reuses the fan-out entry.
  const scopedStorage = useLibraryStorageScoped(selectedServerIds, apiPeriod, isMultiServer);
  const totalStorageBytes = useMemo(() => {
    if (isMultiServer) return Number(scopedStorage.data?.current.totalSizeBytes ?? 0);
    let sum = 0;
    for (const id of selectedServerIds) {
      const entry = storageMulti.byServer.get(id);
      sum += Number(entry?.data?.current.totalSizeBytes ?? 0);
    }
    return sum;
  }, [isMultiServer, scopedStorage.data, storageMulti.byServer, selectedServerIds]);

  // Combined growth rate: sum bytesPerMonth; treat insufficient as 0
  // contribution. fitDays is how many days actually back the fit (it can be
  // the pre-changeover side); older cached responses fall back to the
  // predictions countdown.
  const growthSummary = useMemo(() => {
    let totalBytes = 0;
    let allInsufficient = true;
    let hasAnyData = false;
    let anyPreChangeover = false;
    let worstDays: number | null = null;
    let minDataDays = 7;

    for (const id of selectedServerIds) {
      const data = storageMulti.byServer.get(id)?.data;
      if (!data) continue;
      hasAnyData = true;
      minDataDays = data.predictions.minDataDays ?? minDataDays;
      const fitDays = data.growthRate?.fitDays ?? data.predictions.currentDataDays;
      const insufficient = fitDays != null && fitDays < (data.predictions.minDataDays ?? 7);
      if (insufficient) {
        const days = data.predictions.currentDataDays;
        if (days != null && (worstDays === null || days < worstDays)) worstDays = days;
      } else {
        allInsufficient = false;
        totalBytes += Number(data.growthRate?.bytesPerMonth ?? 0);
        if (data.growthRate?.basis === 'preChangeover') anyPreChangeover = true;
      }
    }

    return {
      totalBytes,
      allInsufficient: !hasAnyData || allInsufficient,
      anyPreChangeover,
      worstDays,
      minDataDays,
    };
  }, [storageMulti.byServer, selectedServerIds]);

  const growthRateDisplay = growthSummary.allInsufficient
    ? t('library.storage.insufficientData')
    : growthSummary.totalBytes > 0
      ? `+${formatBytes(growthSummary.totalBytes)}/mo`
      : t('library.storage.zeroGrowth');

  // For single-server: expose the underlying query result for chart + sub-value
  const singleStorageEntry =
    !isMultiServer && selectedServerIds.length === 1
      ? (storageMulti.byServer.get(selectedServerIds[0] ?? '') ?? null)
      : null;
  const growthRateSubValue =
    growthSummary.allInsufficient && growthSummary.worstDays != null
      ? `${growthSummary.worstDays} ${t('library.storage.of')} ${growthSummary.minDataDays} ${t('library.storage.days')}`
      : growthSummary.anyPreChangeover
        ? t('library.storage.growthPreChangeover')
        : undefined;

  // Duplicates cover same-server copies and versions too, so the KPI and
  // table render for single-server installs as well
  const duplicates = useLibraryDuplicates(
    selectedServerIds,
    duplicatesPage,
    10,
    selectedServerIds.length > 0
  );

  // Combined stale summary for KPI card
  const staleSummary = useLibraryStale(selectedServerIds, null, 90, 'all', 1, 1);
  const staleCount =
    (staleSummary.data?.summary.neverWatched.count ?? 0) +
    (staleSummary.data?.summary.stale.count ?? 0);
  const staleSizeBytes =
    (staleSummary.data?.summary.neverWatched.sizeBytes ?? 0) +
    (staleSummary.data?.summary.stale.sizeBytes ?? 0);

  // Combined ROI - combined across servers via the backend
  const roi = useLibraryRoi(
    selectedServerIds,
    null,
    roiPage,
    10,
    roiMediaType === 'all' ? undefined : roiMediaType,
    roiSortBy,
    roiSortOrder
  );

  // Dead Weight (all-time never-watched titles) rides the shelves endpoint
  // shared with the media Overview page - Redis-cached and single-flighted
  // server-side, so reusing it here is cheap even though the response carries
  // shelf rows this page doesn't use. Pinned to the default period rather
  // than this page's picker: dead weight is period-independent, and wiring
  // the picker in would recompute the whole shelves payload on every period
  // change for zero visible difference (the stale/roi widgets on this page
  // pin their windows for the same reason).
  const shelvesTimeRange = useMemo(() => ({ period: 'month' as const }), []);
  const shelves = useShelves(selectedServerIds, shelvesTimeRange);
  const deadWeightServerById = useMemo(
    () => new Map(servers.map((server) => [server.id, server])),
    [servers]
  );
  const allTimeLabel = t('common:time.allTime').toLowerCase();

  // All hooks must fire before any early returns
  const allStorageErrors = useMemo(() => {
    if (selectedServerIds.length === 0) return false;
    return selectedServerIds.every((id) => storageMulti.byServer.get(id)?.isError === true);
  }, [storageMulti.byServer, selectedServerIds]);

  const firstStorageError = useMemo(() => {
    for (const id of selectedServerIds) {
      const entry = storageMulti.byServer.get(id);
      if (entry?.isError) return entry.error;
    }
    return null;
  }, [storageMulti.byServer, selectedServerIds]);

  // Servers still carrying placeholder version rows: storage and quality
  // numbers are provisional until their next full sync replaces them
  const versionsPendingIds = useMemo(
    () =>
      selectedServerIds.filter(
        (id) => statusResult.byServer.get(id)?.data?.versionsBackfillPending === true
      ),
    [statusResult, selectedServerIds]
  );
  const [versionSyncRequested, setVersionSyncRequested] = useState(false);
  const handleVersionSync = async () => {
    setVersionSyncRequested(true);
    const results = await Promise.allSettled(versionsPendingIds.map((id) => api.servers.sync(id)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      toast.error(t('library.versionsBackfill.syncFailed', { count: failed }));
      setVersionSyncRequested(false);
    } else {
      toast.success(t('library.versionsBackfill.syncStarted'));
    }
  };

  // Show empty state only if ALL selected servers need setup
  const allNeedSetup = useMemo(() => {
    if (statusResult.isLoading || selectedServerIds.length === 0) return false;
    return selectedServerIds.every((id) => {
      const s = statusResult.byServer.get(id)?.data;
      return !s?.isSynced || s.needsBackfill || s.isBackfillRunning;
    });
  }, [statusResult, selectedServerIds]);

  // Header component (used in all states)
  const header = (
    <div>
      <h1 className="text-2xl font-bold">{t('library.storage.title')}</h1>
      <p className="text-muted-foreground text-sm">{t('library.storage.description')}</p>
    </div>
  );

  if (allStorageErrors && firstStorageError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title={t('library.storage.failedToLoad')}
          message={firstStorageError.message ?? t('library.storage.failedToLoadDesc')}
          onRetry={() => {
            for (const id of selectedServerIds) {
              void storageMulti.byServer.get(id)?.refetch();
            }
          }}
        />
      </div>
    );
  }

  if (allNeedSetup) {
    return (
      <div className="space-y-6">
        {header}
        <LibraryEmptyState
          onComplete={() => {
            for (const id of selectedServerIds) {
              void storageMulti.byServer.get(id)?.refetch();
            }
          }}
        />
      </div>
    );
  }

  // Confidence badge applies only in single-server mode
  const singleServerConfidence = singleStorageEntry?.data?.predictions.confidence;

  return (
    <div className="space-y-6">
      {header}

      {versionsPendingIds.length > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
            <p className="text-sm">{t('library.versionsBackfill.banner')}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleVersionSync()}
              disabled={versionSyncRequested}
            >
              {t('library.versionsBackfill.action')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* KPI Cards Grid - 4 columns on desktop, 2 on mobile */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={HardDrive}
          label={t('library.storage.totalStorage')}
          value={isMultiServer && scopedStorage.isError ? '—' : formatBytes(totalStorageBytes)}
          subValue={
            isMultiServer && scopedStorage.isError ? t('library.storage.failedToLoad') : undefined
          }
          isLoading={isMultiServer ? scopedStorage.isLoading : storageMulti.isLoading}
        />
        <StatCard
          icon={TrendingUp}
          label={t('library.storage.growthRate')}
          value={growthRateDisplay}
          subValue={growthRateSubValue}
          isLoading={storageMulti.isLoading}
        />
        <StatCard
          icon={Copy}
          label={t('library.storage.duplicates')}
          value={
            duplicates.isError
              ? '—'
              : `${duplicates.data?.summary.totalGroups ?? 0} ${t('library.storage.groups')}`
          }
          subValue={
            duplicates.isError
              ? t('library.storage.failedToLoad')
              : `${formatBytes(duplicates.data?.summary.totalPotentialSavingsBytes ?? 0)} ${t('library.storage.recoverable')}`
          }
          isLoading={duplicates.isLoading}
        />
        <StatCard
          icon={Archive}
          label={t('library.storage.staleContent')}
          value={`${staleCount} ${t('library.storage.items')}`}
          subValue={`${formatBytes(staleSizeBytes)} ${t('library.storage.unused')}`}
          isLoading={staleSummary.isLoading}
        />
      </div>

      {/* Storage Trend & Predictions Chart */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <CardTitle className="text-base font-medium">
                {t('library.storage.storageTrend')}
              </CardTitle>
              {/* Confidence badge shown only in single-server mode */}
              {!isMultiServer && showPredictions && singleServerConfidence && (
                <Badge
                  variant={
                    singleServerConfidence === 'high'
                      ? 'success'
                      : singleServerConfidence === 'medium'
                        ? 'warning'
                        : 'secondary'
                  }
                >
                  {{
                    high: t('library.storage.confidenceHigh'),
                    medium: t('library.storage.confidenceMedium'),
                    low: t('library.storage.confidenceLow'),
                  }[singleServerConfidence] ?? singleServerConfidence}{' '}
                  {t('library.storage.confidence')}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  id="show-predictions"
                  checked={showPredictions}
                  onCheckedChange={setShowPredictions}
                />
                <Label htmlFor="show-predictions" className="text-sm">
                  {t('library.storage.predictions')}
                </Label>
              </div>
              <TimeRangePicker value={timeRange} onChange={setTimeRange} />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isMultiServer ? (
            /* Multi-server: one chart card per server */
            <PerServerCardGrid
              servers={selectedServers}
              renderServer={(server) => {
                const entry = storageMulti.byServer.get(server.id);
                return (
                  <StoragePredictionChart
                    data={entry?.data}
                    isLoading={entry?.isLoading ?? true}
                    height={250}
                    period={timeRange.period}
                    showPredictions={showPredictions}
                  />
                );
              }}
            />
          ) : (
            /* Single-server: original chart */
            <StoragePredictionChart
              data={singleStorageEntry?.data}
              isLoading={storageMulti.isLoading}
              height={300}
              period={timeRange.period}
              showPredictions={showPredictions}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">
            {t('library.storage.duplicatesTitle')}
          </CardTitle>
          <p className="text-muted-foreground text-sm">{t('library.storage.duplicatesSubtitle')}</p>
        </CardHeader>
        <CardContent>
          <DuplicatesTable
            data={duplicates.data}
            isLoading={duplicates.isLoading}
            isError={duplicates.isError}
            onRetry={() => void duplicates.refetch()}
            page={duplicatesPage}
            onPageChange={setDuplicatesPage}
          />
        </CardContent>
      </Card>

      {/* Dead Weight - never-watched titles, all-time. Cousin of Stale Content
          below (not-watched-recently) - the two cover opposite ends of the
          same neglect spectrum, so they sit next to each other. */}
      {shelves.isLoading ? (
        <DeadWeightTableSkeleton />
      ) : shelves.isError ? (
        <InlineErrorState
          message={shelves.error?.message ?? t('library.storage.failedToLoadDesc')}
          onRetry={() => void shelves.refetch()}
        />
      ) : (
        shelves.data && (
          <DeadWeightTable
            rows={shelves.data.deadWeight ?? []}
            count={shelves.data.kpis.deadWeight?.count ?? 0}
            totalBytes={shelves.data.kpis.deadWeight?.totalBytes ?? 0}
            serverById={deadWeightServerById}
            allTimeLabel={allTimeLabel}
          />
        )
      )}

      {/* Stale Content Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">
            {t('library.storage.staleContent')}
          </CardTitle>
          <p className="text-muted-foreground text-sm">{t('library.storage.staleContentDesc')}</p>
        </CardHeader>
        <CardContent>
          <StaleContentTabs
            serverIds={selectedServerIds}
            libraryId={null}
            isMultiServer={isMultiServer}
            selectedServers={selectedServers}
          />
        </CardContent>
      </Card>

      {/* ROI Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base font-medium">
                {t('library.storage.contentROI')}
              </CardTitle>
              <p className="text-muted-foreground text-sm">{t('library.storage.contentROIDesc')}</p>
            </div>
            {roi.data?.summary && (
              <div className="text-right">
                <p className="text-2xl font-bold">
                  {roi.data.summary.avgWatchHoursPerGb.toFixed(2)}
                </p>
                <p className="text-muted-foreground text-sm">
                  {t('library.storage.avgHoursPerGB')}
                </p>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <RoiTable
            data={roi.data}
            isLoading={roi.isLoading}
            page={roiPage}
            onPageChange={(page) => setRoiPage(page)}
            sortBy={roiSortBy}
            sortOrder={roiSortOrder}
            onSortChange={(sb, so) => {
              setRoiSortBy(sb);
              setRoiSortOrder(so);
              setRoiPage(1); // Reset to first page when sort changes
            }}
            mediaType={roiMediaType}
            onMediaTypeChange={(mt) => {
              setRoiMediaType(mt);
              setRoiPage(1); // Reset to first page when filter changes
            }}
            isMultiServer={isMultiServer}
            selectedServers={selectedServers}
          />
        </CardContent>
      </Card>
    </div>
  );
}
