import { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import type { LibraryGrowthResponse, GrowthDataPoint } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/library';
import { TrendingUp } from 'lucide-react';

interface LibraryGrowthChartProps {
  data: LibraryGrowthResponse | undefined;
  isLoading?: boolean;
  height?: number;
  period?: string;
}

// Colors for each media type
const SERIES_COLORS = {
  movies: 'hsl(221, 83%, 53%)', // Blue
  episodes: 'hsl(142, 76%, 36%)', // Green
  music: 'hsl(262, 83%, 58%)', // Purple
};

/**
 * Get all unique dates from all series, sorted chronologically
 */
function getAllDates(data: LibraryGrowthResponse): string[] {
  const dateSet = new Set<string>();
  (data.movies ?? []).forEach((d) => dateSet.add(d.day));
  (data.episodes ?? []).forEach((d) => dateSet.add(d.day));
  (data.music ?? []).forEach((d) => dateSet.add(d.day));
  return Array.from(dateSet).sort();
}

/**
 * Map series data to aligned array matching all dates.
 * Fills gaps by carrying forward the last known value.
 */
function alignSeries(series: GrowthDataPoint[] | undefined, allDates: string[]): number[] {
  if (!series || series.length === 0) {
    return allDates.map(() => 0);
  }

  const dateMap = new Map(series.map((d) => [d.day, d.total]));
  const result: number[] = [];
  let lastValue = 0;

  // Find the first value to use as baseline before data starts
  const sortedSeries = [...series].sort((a, b) => a.day.localeCompare(b.day));
  const firstDataDate = sortedSeries[0]?.day;

  for (const date of allDates) {
    const value = dateMap.get(date);
    if (value !== undefined) {
      lastValue = value;
      result.push(value);
    } else if (date < (firstDataDate ?? '')) {
      // Before first data point, use 0
      result.push(0);
    } else {
      // After first data point, carry forward last value
      result.push(lastValue);
    }
  }

  return result;
}

/**
 * Calculate Y-axis range to show growth detail
 */
function calculateYAxisRange(
  moviesData: number[],
  episodesData: number[],
  musicData: number[]
): { min: number; max: number } {
  const allValues = [...moviesData, ...episodesData, ...musicData].filter((v) => v > 0);

  if (allValues.length === 0) {
    return { min: 0, max: 100 };
  }

  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);

  // If range is small relative to values, zoom in to show growth detail
  const range = maxVal - minVal;
  const padding = Math.max(range * 0.1, 10); // At least 10 items padding

  // Start from 0 if min is close to 0, otherwise zoom in
  const yMin = minVal < maxVal * 0.2 ? 0 : Math.max(0, minVal - padding);
  const yMax = maxVal + padding;

  return { min: yMin, max: yMax };
}

export function LibraryGrowthChart({
  data,
  isLoading,
  height = 250,
  period = '30d',
}: LibraryGrowthChartProps) {
  const options = useMemo<Highcharts.Options>(() => {
    if (!data) return {};

    const allDates = getAllDates(data);
    if (allDates.length === 0) return {};

    const moviesData = alignSeries(data.movies, allDates);
    const episodesData = alignSeries(data.episodes, allDates);
    const musicData = alignSeries(data.music, allDates);

    // Check if we have any non-zero data
    const hasMovies = moviesData.some((v) => v > 0);
    const hasEpisodes = episodesData.some((v) => v > 0);
    const hasMusic = musicData.some((v) => v > 0);

    if (!hasMovies && !hasEpisodes && !hasMusic) return {};

    // Calculate Y-axis range for better visualization
    const yRange = calculateYAxisRange(moviesData, episodesData, musicData);

    const series: Highcharts.SeriesOptionsType[] = [];

    if (hasMovies) {
      series.push({
        type: 'area',
        name: 'Movies',
        data: moviesData,
        color: SERIES_COLORS.movies,
        fillOpacity: 0.2,
        marker: { enabled: false, states: { hover: { enabled: true, radius: 4 } } },
      });
    }

    if (hasEpisodes) {
      series.push({
        type: 'area',
        name: 'Episodes',
        data: episodesData,
        color: SERIES_COLORS.episodes,
        fillOpacity: 0.2,
        marker: { enabled: false, states: { hover: { enabled: true, radius: 4 } } },
      });
    }

    if (hasMusic) {
      series.push({
        type: 'area',
        name: 'Music',
        data: musicData,
        color: SERIES_COLORS.music,
        fillOpacity: 0.2,
        marker: { enabled: false, states: { hover: { enabled: true, radius: 4 } } },
      });
    }

    return {
      chart: {
        type: 'area',
        height,
        backgroundColor: 'transparent',
        style: { fontFamily: 'inherit' },
        reflow: true,
      },
      title: { text: undefined },
      credits: { enabled: false },
      legend: {
        enabled: true,
        align: 'right',
        verticalAlign: 'top',
        layout: 'horizontal',
        itemStyle: {
          color: 'hsl(var(--foreground))',
          fontSize: '11px',
        },
        itemHoverStyle: {
          color: 'hsl(var(--primary))',
        },
      },
      xAxis: {
        categories: allDates,
        labels: {
          style: { color: 'hsl(var(--muted-foreground))' },
          formatter: function () {
            const categories = this.axis.categories;
            const categoryValue =
              typeof this.value === 'number' ? categories[this.value] : this.value;
            if (!categoryValue) return '';
            const date = new Date(
              categoryValue.includes('T') ? categoryValue : categoryValue + 'T00:00:00'
            );
            if (isNaN(date.getTime())) return '';
            if (period === '1y' || period === 'year') {
              return date.toLocaleDateString('en-US', { month: 'short' });
            }
            return `${date.getMonth() + 1}/${date.getDate()}`;
          },
          step: Math.ceil(allDates.length / 12),
        },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
      },
      yAxis: {
        title: { text: undefined },
        labels: { style: { color: 'hsl(var(--muted-foreground))' } },
        gridLineColor: 'hsl(var(--border))',
        min: yRange.min,
        max: yRange.max,
      },
      plotOptions: {
        area: {
          lineWidth: 2,
          fillOpacity: 0.2,
          states: { hover: { lineWidth: 2 } },
        },
      },
      tooltip: {
        backgroundColor: 'hsl(var(--popover))',
        borderColor: 'hsl(var(--border))',
        style: { color: 'hsl(var(--popover-foreground))' },
        shared: true,
        formatter: function () {
          const points = this.points;
          if (!points || points.length === 0) return '';

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const categoryValue = (points[0] as any).point?.category as string | undefined;
          const date = categoryValue
            ? new Date(categoryValue.includes('T') ? categoryValue : categoryValue + 'T00:00:00')
            : null;
          const dateStr =
            date && !isNaN(date.getTime())
              ? date.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })
              : 'Unknown';

          let html = `<b>${dateStr}</b>`;
          for (const point of points) {
            if (point.y !== null && point.y !== undefined) {
              html += `<br/><span style="color:${point.color}">\u25CF</span> ${point.series.name}: ${point.y.toLocaleString()}`;
            }
          }
          return html;
        },
      },
      series,
      responsive: {
        rules: [
          {
            condition: { maxWidth: 400 },
            chartOptions: {
              legend: { enabled: false },
              xAxis: {
                labels: {
                  style: { fontSize: '9px' },
                  step: Math.ceil(allDates.length / 6),
                },
              },
              yAxis: { labels: { style: { fontSize: '9px' } } },
            },
          },
        ],
      },
    };
  }, [data, height, period]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  const hasData =
    data &&
    ((data.movies?.length ?? 0) > 0 ||
      (data.episodes?.length ?? 0) > 0 ||
      (data.music?.length ?? 0) > 0);

  if (!hasData) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No growth data"
        description="Library growth data will appear here once available"
      />
    );
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}
