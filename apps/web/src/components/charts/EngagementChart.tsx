import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { ChartEmpty } from './ChartEmpty';
import { CATEGORICAL_COLORS, PIE_SEGMENT_BORDER } from './chartUtils';
import type { EngagementTier, EngagementTierBreakdown } from '@tracearr/shared';

interface EngagementBreakdownChartProps {
  data: EngagementTierBreakdown[] | undefined;
  isLoading?: boolean;
  height?: number;
}

// Engagement is ordered, so it reads on the sequential ramp: rewatched brightest.
export const TIER_COLORS: Record<string, string> = {
  abandoned: 'oklch(var(--seq-7))',
  sampled: 'oklch(var(--seq-6))',
  engaged: 'oklch(var(--seq-4))',
  watched: 'oklch(var(--seq-3))',
  rewatched: 'oklch(var(--seq-1))',
  unknown: 'oklch(var(--muted-foreground))',
};

const TIER_LABELS = {
  abandoned: { key: 'pages:yourStats.tier.abandoned', range: '<20%' },
  sampled: { key: 'pages:yourStats.tier.sampled', range: '20-49%' },
  engaged: { key: 'pages:yourStats.tier.engaged', range: '50-84%' },
  watched: { key: 'pages:yourStats.tier.watched', range: '85%+' },
  rewatched: { key: 'pages:yourStats.tier.rewatched', range: '200%+' },
  unknown: { key: 'common:labels.unknown', range: null },
} as const satisfies Record<EngagementTier, { key: string; range: string | null }>;

export function EngagementBreakdownChart({
  data,
  isLoading,
  height = 250,
}: EngagementBreakdownChartProps) {
  const { t } = useTranslation(['pages', 'common']);

  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    const total = data.reduce((sum, d) => sum + d.count, 0);
    if (total === 0) {
      return {};
    }

    const tierLabel = (tier: EngagementTier): string => {
      const { key, range } = TIER_LABELS[tier];
      return range ? `${t(key)} (${range})` : t(key);
    };

    // Sort tiers in logical order
    const tierOrder = ['abandoned', 'sampled', 'engaged', 'watched', 'rewatched', 'unknown'];
    const sortedData = [...data].sort(
      (a, b) => tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier)
    );

    return {
      chart: {
        type: 'pie',
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
      tooltip: {
        backgroundColor: 'oklch(var(--popover))',
        borderColor: 'oklch(var(--border))',
        style: {
          color: 'oklch(var(--popover-foreground))',
        },
        pointFormatter: function () {
          return `<b>${t('pages:activity.tierItems', { count: this.y ?? 0 })}</b> (${(this.percentage ?? 0).toFixed(1)}%)`;
        },
      },
      plotOptions: {
        pie: {
          innerSize: '60%',
          ...PIE_SEGMENT_BORDER,
          dataLabels: {
            enabled: false,
          },
          showInLegend: true,
        },
      },
      legend: {
        align: 'right',
        verticalAlign: 'middle',
        layout: 'vertical',
        itemStyle: {
          color: 'oklch(var(--foreground))',
          fontSize: '12px',
        },
        itemHoverStyle: {
          color: 'oklch(var(--primary))',
        },
      },
      series: [
        {
          type: 'pie',
          name: 'Engagement',
          data: sortedData.map((d) => ({
            name: tierLabel(d.tier),
            y: d.count,
            color: TIER_COLORS[d.tier] ?? TIER_COLORS.unknown,
          })),
        },
      ],
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
                layout: 'horizontal',
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

  if (!data || data.length === 0) {
    return <ChartEmpty height={height} message={t('pages:activity.noEngagementData')} />;
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}

// Plays vs Sessions comparison chart (bar chart)
interface PlaysVsSessionsChartProps {
  plays: number;
  sessions: number;
  isLoading?: boolean;
  height?: number;
}

export function PlaysVsSessionsChart({
  plays,
  sessions,
  isLoading,
  height = 180,
}: PlaysVsSessionsChartProps) {
  const inflationPct =
    sessions > 0 && plays > 0 ? Math.round(((sessions - plays) / plays) * 100) : 0;

  const options = useMemo<Highcharts.Options>(() => {
    if (sessions === 0 && plays === 0) {
      return {};
    }

    return {
      chart: {
        type: 'bar',
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
      xAxis: {
        categories: ['Validated Plays', 'Raw Sessions'],
        labels: {
          style: {
            color: 'oklch(var(--foreground))',
          },
        },
        lineColor: 'oklch(var(--border))',
      },
      yAxis: {
        title: {
          text: undefined,
        },
        labels: {
          style: {
            color: 'oklch(var(--muted-foreground))',
          },
        },
        gridLineColor: 'oklch(var(--border))',
      },
      tooltip: {
        backgroundColor: 'oklch(var(--popover))',
        borderColor: 'oklch(var(--border))',
        style: {
          color: 'oklch(var(--popover-foreground))',
        },
        formatter: function () {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const label = (this as any).point?.category || this.x;
          return `<b>${label}</b>: ${this.y?.toLocaleString()}`;
        },
      },
      plotOptions: {
        bar: {
          borderWidth: 0,
          borderRadius: 4,
          dataLabels: {
            enabled: true,
            style: {
              color: 'oklch(var(--foreground))',
              textOutline: 'none',
            },
          },
        },
      },
      legend: {
        enabled: false,
      },
      series: [
        {
          type: 'bar',
          name: 'Count',
          data: [
            {
              y: plays,
              color: CATEGORICAL_COLORS[0],
            },
            {
              y: sessions,
              color: 'oklch(var(--muted-foreground))',
            },
          ],
        },
      ],
    };
  }, [plays, sessions, height]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (sessions === 0 && plays === 0) {
    return <ChartEmpty height={height} message="No data available" />;
  }

  return (
    <div>
      <HighchartsReact
        highcharts={Highcharts}
        options={options}
        containerProps={{ style: { width: '100%', height: '100%' } }}
      />
      {inflationPct > 0 && (
        <p className="text-muted-foreground mt-2 text-center text-xs">
          Session inflation: <span className="text-warning font-medium">+{inflationPct}%</span>
          <br />
          Raw sessions overcount by {sessions - plays} due to pauses, resumes, and short sessions
        </p>
      )}
    </div>
  );
}
