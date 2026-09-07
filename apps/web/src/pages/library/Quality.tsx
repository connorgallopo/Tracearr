import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Film, Tv } from 'lucide-react';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ErrorState,
  LibraryEmptyState,
  CodecDistributionSection,
  ResolutionDistributionSection,
} from '@/components/library';
import { QualityTimelineChart } from '@/components/charts';
import { PerServerCardGrid } from '@/components/server';
import { useLibraryQuality, useLibraryStatus } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';
import type { Server } from '@tracearr/shared';

type MediaTypeFilter = 'all' | 'movies' | 'shows';

/**
 * Per-server quality evolution card rendered inside PerServerCardGrid.
 * Fetches its own data so loading is independent per server.
 */
function ServerQualityEvolutionCard({
  server,
  apiPeriod,
  mediaType,
  timeRangePeriod,
}: {
  server: Server;
  apiPeriod: string;
  mediaType: MediaTypeFilter;
  timeRangePeriod: string;
}) {
  const quality = useLibraryQuality(server.id, apiPeriod, mediaType);

  return (
    <QualityTimelineChart
      data={quality.data}
      isLoading={quality.isLoading}
      height={300}
      period={timeRangePeriod}
    />
  );
}

export function LibraryQuality() {
  const { t } = useTranslation(['pages', 'common']);
  const { selectedServers, isMultiServer, selectedServerIds } = useServer();
  // When single-server, the one selected ID drives the quality/status hooks
  const singleServerId = !isMultiServer ? (selectedServerIds[0] ?? null) : null;
  const { value: timeRange, setValue: setTimeRange } = useTimeRange();
  const [mediaType, setMediaType] = useState<MediaTypeFilter>('all');

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

  const serverIds = useMemo(() => selectedServers.map((s) => s.id), [selectedServers]);
  const statusResult = useLibraryStatus(serverIds);

  // Single-server quality fetch (only used for single-server error state + chart)
  const singleQuality = useLibraryQuality(
    singleServerId ?? undefined,
    apiPeriod,
    mediaType,
    !isMultiServer
  );

  // Header component (used in all states)
  const header = (
    <div>
      <h1 className="text-2xl font-bold">{t('library.quality.title')}</h1>
      <p className="text-muted-foreground text-sm">{t('library.quality.description')}</p>
    </div>
  );

  // Show error state for single-server only; multi-server cards handle errors independently
  if (!isMultiServer && singleQuality.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title={t('library.quality.failedToLoad')}
          message={singleQuality.error?.message ?? t('library.quality.failedToLoadDesc')}
          onRetry={singleQuality.refetch}
        />
      </div>
    );
  }

  // Gate on empty/setup state:
  // - Single-server: same as before - check the one server.
  // - Multi-server: only show page-level empty state if EVERY selected server needs setup.
  const needsSetup = (() => {
    if (isMultiServer) {
      // All servers need setup -> show page-level empty state
      return (
        serverIds.length > 0 &&
        serverIds.every((id) => {
          const entry = statusResult.byServer.get(id);
          if (!entry || entry.isLoading) return false;
          const d = entry.data;
          return !d?.isSynced || d?.needsBackfill || d?.isBackfillRunning;
        })
      );
    }
    if (singleServerId) {
      const entry = statusResult.byServer.get(singleServerId);
      const d = entry?.data;
      return !statusResult.isLoading && (!d?.isSynced || d?.needsBackfill || d?.isBackfillRunning);
    }
    return false;
  })();

  if (needsSetup) {
    return (
      <div className="space-y-6">
        {header}
        <LibraryEmptyState onComplete={singleQuality.refetch} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      {/* Quality Evolution Chart - page-level media-type tabs + time range apply to all cards */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <CardTitle className="text-base font-medium">
                {t('library.quality.qualityEvolution')}
              </CardTitle>
              <Tabs value={mediaType} onValueChange={(v) => setMediaType(v as MediaTypeFilter)}>
                <TabsList className="h-8">
                  <TabsTrigger value="all" className="h-7 px-3 text-xs">
                    {t('library.quality.all')}
                  </TabsTrigger>
                  <TabsTrigger value="movies" className="h-7 gap-1 px-3 text-xs">
                    <Film className="h-3 w-3" />
                    {t('common:media.movie_plural')}
                  </TabsTrigger>
                  <TabsTrigger value="shows" className="h-7 gap-1 px-3 text-xs">
                    <Tv className="h-3 w-3" />
                    {t('common:media.tv')}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <TimeRangePicker value={timeRange} onChange={setTimeRange} />
          </div>
        </CardHeader>
        <CardContent>
          {isMultiServer ? (
            <PerServerCardGrid
              servers={selectedServers}
              renderServer={(server) => (
                <ServerQualityEvolutionCard
                  server={server}
                  apiPeriod={apiPeriod}
                  mediaType={mediaType}
                  timeRangePeriod={timeRange.period}
                />
              )}
            />
          ) : (
            <QualityTimelineChart
              data={singleQuality.data}
              isLoading={singleQuality.isLoading}
              height={300}
              period={timeRange.period}
            />
          )}
        </CardContent>
      </Card>

      {/* Resolution Distribution - Movies vs TV */}
      <ResolutionDistributionSection
        serverId={singleServerId}
        selectedServers={isMultiServer ? selectedServers : undefined}
        isMultiServer={isMultiServer}
      />

      {/* Codec Distribution - Full width with tabs */}
      <CodecDistributionSection
        serverId={singleServerId}
        selectedServers={isMultiServer ? selectedServers : undefined}
        isMultiServer={isMultiServer}
      />
    </div>
  );
}
