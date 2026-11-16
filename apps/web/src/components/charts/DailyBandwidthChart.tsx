import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { ChartSkeleton } from '@/components/ui/skeleton';
// Direct path, not the charts barrel: that pulls in highcharts-more, which fails to load under jsdom.
import { ChartEmpty } from '@/components/charts/ChartEmpty';
import { formatDateString } from '@/lib/dateFormat';
import type { DailyBandwidthRow, Server } from '@tracearr/shared';

interface DailyBandwidthChartProps {
  data: DailyBandwidthRow[] | undefined;
  isLoading?: boolean;
  height?: number;
  period?: 'day' | 'week' | 'month' | 'year' | 'all' | 'custom';
  isMultiServer?: boolean;
  selectedServers?: Pick<Server, 'id' | 'name' | 'color'>[];
}

export function DailyBandwidthChart({
  data,
  isLoading,
  height = 300,
  period = 'month',
  isMultiServer = false,
  selectedServers = [],
}: DailyBandwidthChartProps) {
  const { t } = useTranslation(['pages', 'common']);
  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    // Derive a stable ordered list of unique dates for the category axis
    const dateSet = new Set(data.map((d) => d.date));
    const categories = [...dateSet].sort();

    let bitrateSeriesArr: Highcharts.SeriesOptionsType[];

    if (isMultiServer) {
      // One stacked area per server, aligned to the shared category (date) axis
      bitrateSeriesArr = selectedServers.map((server) => {
        const serverRows = data.filter((r) => r.serverId === server.id);
        const rowByDate = new Map(serverRows.map((r) => [r.date, r]));
        return {
          type: 'area',
          name: server.name,
          color: server.color ?? undefined,
          stacking: 'normal',
          yAxis: 0,
          data: categories.map((date) => {
            const row = rowByDate.get(date);
            return row ? (row.avgBitrateMbps ?? row.avgBitrate) : null;
          }),
        };
      });
    } else {
      // Single-server: one area per the existing row order (one row per date)
      bitrateSeriesArr = [
        {
          type: 'area',
          name: t('statsBandwidth.avgBitrate'),
          data: categories.map((date) => {
            const row = data.find((d) => d.date === date);
            return row ? (row.avgBitrateMbps ?? row.avgBitrate) : null;
          }),
          yAxis: 0,
          color: 'oklch(var(--primary))',
          fillColor: {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, 'oklch(var(--primary) / 0.3)'],
              [1, 'oklch(var(--primary) / 0.05)'],
            ],
          },
        },
      ];
    }

    // Aggregate session count across all servers per date for the right axis
    const sessionsByDate = new Map<string, number>();
    for (const row of data) {
      sessionsByDate.set(row.date, (sessionsByDate.get(row.date) ?? 0) + row.sessions);
    }
    const sessionSeries: Highcharts.SeriesOptionsType = {
      type: 'column',
      name: t('common:labels.sessions'),
      data: categories.map((date) => sessionsByDate.get(date) ?? 0),
      yAxis: 1,
      color: 'oklch(var(--chart-2))',
      opacity: 0.6,
    };

    return {
      chart: {
        type: 'area',
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
        itemStyle: {
          color: 'oklch(var(--muted-foreground))',
        },
        itemHoverStyle: {
          color: 'oklch(var(--foreground))',
        },
      },
      xAxis: {
        categories,
        labels: {
          style: {
            color: 'oklch(var(--muted-foreground))',
          },
          formatter: function () {
            const cats = this.axis.categories;
            const categoryValue = typeof this.value === 'number' ? cats[this.value] : this.value;
            if (!categoryValue) return '';
            return formatDateString(
              categoryValue,
              period === 'year' ? { month: 'short' } : { month: 'numeric', day: 'numeric' }
            );
          },
          step: Math.ceil(categories.length / 12),
        },
        lineColor: 'oklch(var(--border))',
        tickColor: 'oklch(var(--border))',
      },
      yAxis: [
        {
          title: {
            text: t('statsBandwidth.avgBitrateMbps'),
            style: {
              color: 'oklch(var(--primary))',
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
        {
          title: {
            text: t('common:labels.sessions'),
            style: {
              color: 'oklch(var(--chart-2))',
            },
          },
          labels: {
            style: {
              color: 'oklch(var(--muted-foreground))',
            },
          },
          opposite: true,
          gridLineWidth: 0,
          min: 0,
        },
      ],
      plotOptions: {
        area: {
          marker: {
            enabled: false,
            states: {
              hover: {
                enabled: true,
                radius: 4,
              },
            },
          },
          lineWidth: 2,
          states: {
            hover: {
              lineWidth: 2,
            },
          },
          threshold: null,
        },
        column: {
          borderRadius: 4,
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
          const points = this.points ?? [];
          const category = points[0]?.category;
          const categoryValue = typeof category === 'string' ? category : undefined;
          const dateStr =
            (categoryValue &&
              formatDateString(categoryValue, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })) ||
            t('common:labels.unknown');

          let html = `<b>${dateStr}</b><br/>`;
          for (const point of points) {
            const value =
              point.series.name === t('statsBandwidth.avgBitrate')
                ? `${point.y?.toFixed(1)} Mbps`
                : point.y;
            html += `<span style="color:${point.color}">●</span> ${point.series.name}: <b>${value}</b><br/>`;
          }
          return html;
        },
      },
      series: [...bitrateSeriesArr, sessionSeries],
      responsive: {
        rules: [
          {
            condition: {
              maxWidth: 400,
            },
            chartOptions: {
              legend: {
                enabled: false,
              },
              yAxis: [
                {
                  title: {
                    text: undefined,
                  },
                },
                {
                  title: {
                    text: undefined,
                  },
                },
              ],
            },
          },
        ],
      },
    };
  }, [data, height, period, t, isMultiServer, selectedServers]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!data || data.length === 0) {
    return <ChartEmpty height={height} message={t('statsBandwidth.noData')} />;
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}
