import { useMemo } from 'react';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { BarChart3 } from 'lucide-react';
import { RESOLUTION_LABELS, resolutionBucket, type LibraryQualityResponse } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { RESOLUTION_COLORS } from '@/lib/resolutionColors';
import { parseChartDate } from './chartUtils';

interface QualityTimelineChartProps {
  data: LibraryQualityResponse | undefined;
  isLoading?: boolean;
  height?: number;
  period?: string;
}

export function QualityTimelineChart({ data, isLoading, height = 250 }: QualityTimelineChartProps) {
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
          color: 'hsl(var(--muted-foreground))',
          fontWeight: 'normal',
          fontSize: '11px',
        },
        itemHoverStyle: {
          color: 'hsl(var(--foreground))',
        },
      },
      xAxis: {
        type: 'datetime',
        tickPixelInterval: 120,
        dateTimeLabelFormats: {
          day: { main: '%b %e' },
          week: { main: '%b %e' },
          month: { main: `%b '%y` },
          year: { main: '%Y' },
        },
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
            fontSize: '11px',
          },
        },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
        tickLength: 5,
        startOnTick: false,
        endOnTick: false,
      },
      yAxis: {
        title: {
          text: 'Items',
          style: {
            color: 'hsl(var(--muted-foreground))',
            fontSize: '11px',
          },
        },
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
            fontSize: '11px',
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
        gridLineColor: 'hsl(var(--border))',
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
          lineWidth: 2,
          states: {
            hover: {
              lineWidth: 2,
            },
          },
        },
      },
      tooltip: {
        backgroundColor: 'hsl(var(--popover))',
        borderColor: 'hsl(var(--border))',
        style: {
          color: 'hsl(var(--popover-foreground))',
        },
        shared: true,
        formatter: function () {
          const points = this.points || [];
          const date = new Date(this.x);
          const dateStr = date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          });

          // Tiers overlap (a 4K+1080p title counts in both), so the
          // denominator is the day's real title count, never the tier sum
          const total = totalByDay.get(Number(this.x)) ?? 0;
          let html = `<b>${dateStr}</b>`;
          [...points].reverse().forEach((point) => {
            const pct = total > 0 ? (((point.y || 0) / total) * 100).toFixed(1) : '0';
            html += `<br/><span style="color:${point.color}">●</span> ${point.series.name}: ${point.y?.toLocaleString()} (${pct}%)`;
          });
          html += `<br/><b>${total.toLocaleString()} titles</b>`;
          return html;
        },
      },
      series: shownLabels.map((label) => ({
        type: 'line' as const,
        name: label,
        data: data.data.map((d) => [parseChartDate(d.day), countOf(label, d)]),
        color: RESOLUTION_COLORS[label],
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
                itemStyle: {
                  fontSize: '10px',
                },
              },
              xAxis: {
                labels: {
                  style: {
                    fontSize: '9px',
                  },
                },
              },
              yAxis: {
                labels: {
                  style: {
                    fontSize: '9px',
                  },
                },
              },
            },
          },
        ],
      },
    };
  }, [data, height]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!data?.data || data.data.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No quality data"
        description="Quality evolution data will appear here once available"
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
