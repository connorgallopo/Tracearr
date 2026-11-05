import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import type { LibraryGrowthResponse, GrowthDataPoint } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate, axisDateTimeLabelFormats, parseChartDate } from '@/lib/dateFormat';
import { TrendingUp } from 'lucide-react';
import { chartLang } from './chartUtils';

export type GrowthSeries = 'movies' | 'episodes';

interface LibraryGrowthChartProps {
  data: LibraryGrowthResponse | undefined;
  isLoading?: boolean;
  height?: number;
  /** Clicking the movies or episodes area; music has no catalog filter to land on. */
  onSeriesClick?: (series: GrowthSeries) => void;
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

export function LibraryGrowthChart({
  data,
  isLoading,
  height = 250,
  onSeriesClick,
}: LibraryGrowthChartProps) {
  const { t } = useTranslation(['pages', 'common']);
  const options = useMemo<Highcharts.Options>(() => {
    if (!data) return {};

    const allDates = getAllDates(data);
    if (allDates.length === 0) return {};

    const allTimestamps = allDates.map(parseChartDate);
    const moviesValues = alignSeries(data.movies, allDates);
    const episodesValues = alignSeries(data.episodes, allDates);
    const musicValues = alignSeries(data.music, allDates);

    // Check if we have any non-zero data
    const hasMovies = moviesValues.some((v) => v > 0);
    const hasEpisodes = episodesValues.some((v) => v > 0);
    const hasMusic = musicValues.some((v) => v > 0);

    if (!hasMovies && !hasEpisodes && !hasMusic) return {};

    const series: Highcharts.SeriesOptionsType[] = [];
    const clickable = (name: GrowthSeries) =>
      onSeriesClick ? { cursor: 'pointer', events: { click: () => onSeriesClick(name) } } : {};

    if (hasMovies) {
      series.push({
        type: 'area',
        name: t('common:media.movie_plural'),
        data: allTimestamps.map((ts, i) => [ts, moviesValues[i] ?? 0]),
        color: SERIES_COLORS.movies,
        fillOpacity: 0.2,
        marker: { enabled: false, states: { hover: { enabled: true, radius: 4 } } },
        ...clickable('movies'),
      });
    }

    if (hasEpisodes) {
      series.push({
        type: 'area',
        name: t('common:media.episode_plural'),
        data: allTimestamps.map((ts, i) => [ts, episodesValues[i] ?? 0]),
        color: SERIES_COLORS.episodes,
        fillOpacity: 0.2,
        marker: { enabled: false, states: { hover: { enabled: true, radius: 4 } } },
        ...clickable('episodes'),
      });
    }

    if (hasMusic) {
      series.push({
        type: 'area',
        name: t('common:media.music'),
        data: allTimestamps.map((ts, i) => [ts, musicValues[i] ?? 0]),
        color: SERIES_COLORS.music,
        fillOpacity: 0.2,
        marker: { enabled: false, states: { hover: { enabled: true, radius: 4 } } },
      });
    }

    return {
      lang: chartLang(),
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
        type: 'datetime',
        tickPixelInterval: 120,
        dateTimeLabelFormats: axisDateTimeLabelFormats(),
        labels: {
          style: { color: 'hsl(var(--muted-foreground))' },
        },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
        startOnTick: false,
        endOnTick: false,
      },
      yAxis: {
        title: { text: undefined },
        labels: { style: { color: 'hsl(var(--muted-foreground))' } },
        gridLineColor: 'hsl(var(--border))',
      },
      plotOptions: {
        area: {
          lineWidth: 2,
          fillOpacity: 0.2,
          threshold: null,
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

          const dateStr = formatDate(this.x, { month: 'short', day: 'numeric', year: 'numeric' });

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
                },
              },
              yAxis: { labels: { style: { fontSize: '9px' } } },
            },
          },
        ],
      },
    };
  }, [data, height, onSeriesClick, t]);

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
        title={t('library.charts.growth.empty.title')}
        description={t('library.charts.growth.empty.description')}
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
