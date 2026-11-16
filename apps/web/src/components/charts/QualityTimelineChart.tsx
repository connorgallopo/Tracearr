import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { BarChart3 } from 'lucide-react';
import {
  RESOLUTION_LABELS,
  resolutionBucket,
  type LibraryQualityResponse,
  type ResolutionLabel,
} from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate, axisDateTimeLabelFormats, parseChartDate } from '@/lib/dateFormat';
import { RESOLUTION_COLORS } from '@/lib/resolutionColors';
import { chartLang } from './chartUtils';

// Neighboring ramp steps are close in color, so each tier also gets its own stroke pattern.
const TIER_DASH: Record<ResolutionLabel, Highcharts.DashStyleValue> = {
  '8K': 'Solid',
  '4K': 'ShortDash',
  '1440p': 'ShortDot',
  '1080p': 'LongDash',
  '720p': 'DashDot',
  '480p': 'Dot',
  SD: 'LongDashDot',
};

interface QualityTimelineChartProps {
  data: LibraryQualityResponse | undefined;
  isLoading?: boolean;
  height?: number;
  period?: string;
}

export function QualityTimelineChart({ data, isLoading, height = 250 }: QualityTimelineChartProps) {
  const { t } = useTranslation(['pages', 'common']);
  const options = useMemo<Highcharts.Options>(() => {
    if (!data?.data || data.data.length === 0) {
      return {};
    }

    const totalByDay = new Map(data.data.map((d) => [parseChartDate(d.day), d.totalItems]));
    const countOf = (label: (typeof RESOLUTION_LABELS)[number], d: (typeof data.data)[number]) =>
      d.counts[resolutionBucket(label) ?? 'sd'];
    // Worst tier first so the legend and stacking read upward; a tier nobody has stays off the chart
    const shownLabels = [...RESOLUTION_LABELS]
      .reverse()
      .filter((label) => data.data.some((d) => countOf(label, d) > 0));

    return {
      lang: chartLang(),
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
        enabled: true,
        align: 'right',
        verticalAlign: 'top',
        floating: false,
        itemStyle: {
          color: 'oklch(var(--muted-foreground))',
          fontWeight: 'normal',
          fontSize: '12px',
        },
        itemHoverStyle: {
          color: 'oklch(var(--foreground))',
        },
      },
      xAxis: {
        type: 'datetime',
        tickPixelInterval: 120,
        dateTimeLabelFormats: axisDateTimeLabelFormats(),
        labels: {
          style: {
            color: 'oklch(var(--muted-foreground))',
            fontSize: '12px',
          },
        },
        lineColor: 'oklch(var(--border))',
        tickColor: 'oklch(var(--border))',
        tickLength: 5,
        startOnTick: false,
        endOnTick: false,
      },
      yAxis: {
        title: {
          text: t('common:labels.items'),
          style: {
            color: 'oklch(var(--muted-foreground))',
            fontSize: '12px',
          },
        },
        labels: {
          style: {
            color: 'oklch(var(--muted-foreground))',
            fontSize: '12px',
          },
          formatter: function () {
            // Format large numbers with K suffix
            const value = this.value as number;
            if (value >= 1000) {
              return (value / 1000).toFixed(value >= 10000 ? 0 : 1) + 'K';
            }
            return String(value);
          },
        },
        gridLineColor: 'oklch(var(--border))',
        min: 0,
      },
      plotOptions: {
        line: {
          marker: {
            // Enable markers for single data points, otherwise hide them
            enabled: data.data.length < 3,
            radius: 4,
            states: {
              hover: {
                enabled: true,
                radius: 5,
              },
            },
          },
          lineWidth: 3,
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
        shared: true,
        formatter: function () {
          const points = this.points || [];
          const dateStr = formatDate(this.x, { month: 'short', day: 'numeric', year: 'numeric' });

          // Tiers overlap (a 4K+1080p title counts in both), so the
          // denominator is the day's real title count, never the tier sum
          const total = totalByDay.get(Number(this.x)) ?? 0;
          let html = `<b>${dateStr}</b>`;
          [...points].reverse().forEach((point) => {
            const pct = total > 0 ? (((point.y || 0) / total) * 100).toFixed(1) : '0';
            html += `<br/><span style="color:${point.color}">●</span> ${point.series.name}: ${point.y?.toLocaleString()} (${pct}%)`;
          });
          html += `<br/><b>${t('library.charts.qualityTimeline.titles', { count: total })}</b>`;
          return html;
        },
      },
      series: shownLabels.map((label) => ({
        type: 'line' as const,
        name: label,
        data: data.data.map((d) => [parseChartDate(d.day), countOf(label, d)]),
        color: RESOLUTION_COLORS[label],
        dashStyle: TIER_DASH[label],
      })),
      responsive: {
        rules: [
          {
            condition: {
              maxWidth: 400,
            },
            chartOptions: {
              legend: {
                align: 'center',
                verticalAlign: 'bottom',
              },
            },
          },
        ],
      },
    };
  }, [data, height, t]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!data?.data || data.data.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title={t('library.charts.qualityTimeline.empty.title')}
        description={t('library.charts.qualityTimeline.empty.description')}
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
