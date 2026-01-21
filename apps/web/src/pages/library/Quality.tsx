import { useMemo, useState } from 'react';
import { BarChart3, Film, Tv } from 'lucide-react';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ErrorState,
  EmptyState,
  CodecDistributionSection,
  ResolutionDistributionSection,
} from '@/components/library';
import { QualityTimelineChart } from '@/components/charts';
import { useLibraryQuality } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';

type MediaTypeFilter = 'all' | 'movies' | 'shows';

export function LibraryQuality() {
  const { selectedServerId } = useServer();
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
        return '1y'; // Default to 1y for "all" since API has limits
      default:
        return '30d';
    }
  }, [timeRange.period]);

  const quality = useLibraryQuality(selectedServerId ?? undefined, apiPeriod, mediaType);

  // Header component (used in all states)
  const header = (
    <div>
      <h1 className="text-2xl font-bold">Quality</h1>
      <p className="text-muted-foreground text-sm">Resolution and codec distribution</p>
    </div>
  );

  // Show error state with retry
  if (quality.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title="Failed to load quality data"
          message={quality.error?.message ?? 'Could not fetch quality data. Please try again.'}
          onRetry={quality.refetch}
        />
      </div>
    );
  }

  // Show empty state if no quality data
  if (!quality.isLoading && (!quality.data?.data || quality.data.data.length === 0)) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={BarChart3}
          title="No quality data yet"
          description="Quality metrics will appear here once library snapshots have been collected. This typically happens automatically within 24 hours."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      {/* Quality Evolution Chart (full width) */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <CardTitle className="text-base font-medium">Quality Evolution</CardTitle>
              <Tabs value={mediaType} onValueChange={(v) => setMediaType(v as MediaTypeFilter)}>
                <TabsList className="h-8">
                  <TabsTrigger value="all" className="h-7 px-3 text-xs">
                    All
                  </TabsTrigger>
                  <TabsTrigger value="movies" className="h-7 gap-1 px-3 text-xs">
                    <Film className="h-3 w-3" />
                    Movies
                  </TabsTrigger>
                  <TabsTrigger value="shows" className="h-7 gap-1 px-3 text-xs">
                    <Tv className="h-3 w-3" />
                    TV
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <TimeRangePicker value={timeRange} onChange={setTimeRange} />
          </div>
        </CardHeader>
        <CardContent>
          <QualityTimelineChart
            data={quality.data}
            isLoading={quality.isLoading}
            height={300}
            period={timeRange.period}
          />
        </CardContent>
      </Card>

      {/* Resolution Distribution - Movies vs TV */}
      <ResolutionDistributionSection serverId={selectedServerId} />

      {/* Codec Distribution - Full width with tabs */}
      <CodecDistributionSection serverId={selectedServerId} />
    </div>
  );
}
