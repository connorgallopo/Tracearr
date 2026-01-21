import { useMemo, useState } from 'react';
import { HardDrive, TrendingUp, Copy, Archive } from 'lucide-react';
import { StatCard } from '@/components/ui/stat-card';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ErrorState,
  EmptyState,
  DuplicatesTable,
  StaleContentTabs,
  RoiTable,
} from '@/components/library';
import { StoragePredictionChart } from '@/components/charts';
import {
  useLibraryStorage,
  useLibraryDuplicates,
  useLibraryStale,
  useLibraryRoi,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';

/**
 * Format bytes to human-readable size (TB/GB)
 * Handles string (BigInt) or number values from API
 */
function formatBytes(bytesStr: string | number | null | undefined): string {
  if (!bytesStr) return '0 GB';

  // Parse as BigInt for large values, convert to GB
  const bytes = typeof bytesStr === 'string' ? BigInt(bytesStr) : BigInt(Math.floor(bytesStr));
  const gb = Number(bytes / BigInt(1024 ** 3));

  if (gb >= 1024) {
    return `${(gb / 1024).toFixed(1)} TB`;
  }
  return `${gb.toFixed(1)} GB`;
}

export function LibraryStorage() {
  const { selectedServerId } = useServer();
  const { value: timeRange, setValue: setTimeRange } = useTimeRange();

  // Pagination state for tables
  const [duplicatesPage, setDuplicatesPage] = useState(1);
  const [roiPage, setRoiPage] = useState(1);

  // ROI sorting and filtering state
  const [roiSortBy, setRoiSortBy] = useState<
    'watch_hours_per_gb' | 'value_score' | 'file_size' | 'title'
  >('watch_hours_per_gb');
  const [roiSortOrder, setRoiSortOrder] = useState<'asc' | 'desc'>('asc');
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
        return '1y'; // Default to 1y for "all" since API has limits
      default:
        return '30d';
    }
  }, [timeRange.period]);

  // Core data hooks
  const storage = useLibraryStorage(selectedServerId, null, apiPeriod);
  const duplicates = useLibraryDuplicates(selectedServerId, duplicatesPage, 10);
  const roi = useLibraryRoi(
    selectedServerId,
    null,
    roiPage,
    10,
    roiMediaType === 'all' ? undefined : roiMediaType,
    roiSortBy,
    roiSortOrder
  );

  // Fetch stale summary for KPI card (minimal page size since we only need summary)
  const staleSummary = useLibraryStale(selectedServerId, null, 90, 'all', 1, 1);
  const staleCount =
    (staleSummary.data?.summary.neverWatched.count ?? 0) +
    (staleSummary.data?.summary.stale.count ?? 0);
  const staleSizeBytes =
    (staleSummary.data?.summary.neverWatched.sizeBytes ?? 0) +
    (staleSummary.data?.summary.stale.sizeBytes ?? 0);

  // Header component (used in all states)
  const header = (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold">Storage</h1>
        <p className="text-muted-foreground text-sm">
          Storage usage, predictions, and optimization
        </p>
      </div>
      <TimeRangePicker value={timeRange} onChange={setTimeRange} />
    </div>
  );

  // Show error state with retry
  if (storage.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title="Failed to load storage data"
          message={storage.error?.message ?? 'Could not fetch storage data. Please try again.'}
          onRetry={storage.refetch}
        />
      </div>
    );
  }

  // Show empty state if no storage data
  if (!storage.isLoading && (!storage.data?.history || storage.data.history.length === 0)) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={HardDrive}
          title="No storage data yet"
          description="Storage metrics will appear here once library snapshots have been collected. This typically happens automatically within 24 hours."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      {/* KPI Cards Grid - 4 columns on desktop, 2 on mobile */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={HardDrive}
          label="Total Storage"
          value={formatBytes(storage.data?.current.totalSizeBytes)}
          isLoading={storage.isLoading}
        />
        <StatCard
          icon={TrendingUp}
          label="Growth Rate"
          value={`+${formatBytes(storage.data?.growthRate.bytesPerMonth)}/mo`}
          isLoading={storage.isLoading}
        />
        <StatCard
          icon={Copy}
          label="Duplicates"
          value={`${duplicates.data?.summary.totalGroups ?? 0} groups`}
          subValue={`${formatBytes(duplicates.data?.summary.totalPotentialSavingsBytes ?? 0)} recoverable`}
          isLoading={duplicates.isLoading}
        />
        <StatCard
          icon={Archive}
          label="Stale Content"
          value={`${staleCount} items`}
          subValue={`${formatBytes(staleSizeBytes)} unused`}
          isLoading={staleSummary.isLoading}
        />
      </div>

      {/* Storage Trend & Predictions Chart */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-medium">Storage Trend</CardTitle>
            {storage.data?.predictions.confidence && (
              <Badge
                variant={
                  storage.data.predictions.confidence === 'high'
                    ? 'success'
                    : storage.data.predictions.confidence === 'medium'
                      ? 'warning'
                      : 'secondary'
                }
              >
                {storage.data.predictions.confidence} confidence
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <StoragePredictionChart data={storage.data} isLoading={storage.isLoading} height={300} />
        </CardContent>
      </Card>

      {/* Duplicates Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Cross-Server Duplicates</CardTitle>
          <p className="text-muted-foreground text-sm">Content that exists on multiple servers</p>
        </CardHeader>
        <CardContent>
          <DuplicatesTable
            data={duplicates.data}
            isLoading={duplicates.isLoading}
            page={duplicatesPage}
            onPageChange={setDuplicatesPage}
          />
        </CardContent>
      </Card>

      {/* Stale Content Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">Stale Content</CardTitle>
          <p className="text-muted-foreground text-sm">
            Content that may be candidates for removal
          </p>
        </CardHeader>
        <CardContent>
          <StaleContentTabs serverId={selectedServerId} libraryId={null} />
        </CardContent>
      </Card>

      {/* ROI Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base font-medium">Content ROI</CardTitle>
              <p className="text-muted-foreground text-sm">Watch value per storage cost</p>
            </div>
            {roi.data?.summary && (
              <div className="text-right">
                <p className="text-2xl font-bold">
                  {roi.data.summary.avgWatchHoursPerGb.toFixed(2)}
                </p>
                <p className="text-muted-foreground text-sm">avg hours/GB</p>
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
            onSortChange={(sortBy, sortOrder) => {
              setRoiSortBy(sortBy);
              setRoiSortOrder(sortOrder);
              setRoiPage(1); // Reset to first page when sort changes
            }}
            mediaType={roiMediaType}
            onMediaTypeChange={(mediaType) => {
              setRoiMediaType(mediaType);
              setRoiPage(1); // Reset to first page when filter changes
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
