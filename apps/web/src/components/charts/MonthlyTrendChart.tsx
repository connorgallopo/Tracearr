import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import type { PatternsResponse, TrendBucket } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { TrendingUp } from 'lucide-react';
import { formatTrendDate, parseChartDate, toIsoDate } from '@/lib/dateFormat';

const DAY_MS = 86_400_000;
const MIN_TICK_INTERVAL: Record<TrendBucket, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 28 * DAY_MS,
};

const isEmpty = (trend: PatternsResponse['trend'] | undefined) =>
  !trend || trend.points.every((p) => p.watchCount === 0);

interface MonthlyTrendChartProps {
  trend: PatternsResponse['trend'] | undefined;
  isLoading?: boolean;
  height?: number;
}

export function MonthlyTrendChart({ trend, isLoading, height = 250 }: MonthlyTrendChartProps) {
  const { t } = useTranslation('pages');
  const options = useMemo<Highcharts.Options>(() => {
    if (!trend || isEmpty(trend)) {
      return {};
    }
    const { bucket, points } = trend;

    return {
      chart: {
        type: 'line',
        height,
        backgroundColor: 'transparent',
        style: {
          fontFamily: 'inherit',
        },
        reflow: true,
      },
      title: {
        text: undefined,
      },
      credits: {
        enabled: false,
      },
      legend: {
        enabled: false,
      },
      xAxis: {
        type: 'datetime',
        tickPixelInterval: 100,
        minTickInterval: MIN_TICK_INTERVAL[bucket],
        labels: {
          formatter: function () {
            return formatTrendDate(toIsoDate(new Date(this.value)), bucket);
          },
          style: {
            color: 'oklch(var(--muted-foreground))',
          },
        },
        lineColor: 'oklch(var(--border))',
        tickColor: 'oklch(var(--border))',
        startOnTick: false,
        endOnTick: false,
      },
      yAxis: {
        title: {
          text: t('library.charts.monthly.watchCount'),
          style: {
            color: 'oklch(var(--muted-foreground))',
          },
        },
        labels: {
          style: {
            color: 'oklch(var(--muted-foreground))',
          },
        },
        gridLineColor: 'oklch(var(--border))',
        min: 0,
      },
      plotOptions: {
        line: {
          marker: {
            enabled: true,
            radius: 3,
          },
          color: 'oklch(var(--primary))',
          states: {
            hover: {
              lineWidth: 3,
            },
          },
        },
      },
      tooltip: {
        backgroundColor: 'oklch(var(--popover))',
        borderColor: 'oklch(var(--border))',
        style: {
          color: 'oklch(var(--popover-foreground))',
        },
        formatter: function () {
          const watches = t('library.charts.watchesValue', { count: this.y ?? 0 });
          return `<b>${formatTrendDate(toIsoDate(new Date(this.x)), bucket)}</b><br/>${watches}`;
        },
      },
      series: [
        {
          type: 'line',
          name: t('library.charts.monthly.watchCount'),
          data: points.map((p) => [parseChartDate(p.start), p.watchCount]),
        },
      ],
      responsive: {
        rules: [
          {
            condition: {
              maxWidth: 400,
            },
            chartOptions: {
              yAxis: {
                title: {
                  text: undefined,
                },
              },
            },
          },
        ],
      },
    };
  }, [trend, height, t]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (isEmpty(trend)) {
    return (
      <EmptyState
        icon={TrendingUp}
        title={t('library.charts.monthly.empty.title')}
        description={t('library.charts.monthly.empty.description')}
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
