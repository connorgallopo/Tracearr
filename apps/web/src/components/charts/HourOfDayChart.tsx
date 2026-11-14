import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import type { HourOfDayStats } from '@tracearr/shared';
import { formatHourOfDay } from '@/lib/dateFormat';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { ChartEmpty } from './ChartEmpty';
import { buildMediaGroupSeries, stackedTooltipRows } from './chartUtils';

interface HourOfDayChartProps {
  /** Rows carrying a mediaType stack movies, shows and music per hour. */
  data: HourOfDayStats[] | undefined;
  isLoading?: boolean;
  height?: number;
}

export function HourOfDayChart({ data, isLoading, height = 250 }: HourOfDayChartProps) {
  const { t } = useTranslation(['common', 'pages']);

  const options = useMemo<Highcharts.Options | null>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    const hours = [...new Set(data.map((d) => d.hour))];
    const hourIndex = new Map(hours.map((hour, index) => [hour, index]));
    const stacked = data.some((d) => d.mediaType !== undefined);
    const groups = stacked
      ? buildMediaGroupSeries(data, (d) => hourIndex.get(d.hour) ?? d.hour)
      : [];
    if (stacked && groups.length === 0) return null;

    return {
      chart: {
        type: 'column',
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
        enabled: groups.length >= 2,
        itemStyle: {
          color: 'oklch(var(--muted-foreground))',
        },
        itemHoverStyle: {
          color: 'oklch(var(--foreground))',
        },
      },
      xAxis: {
        categories: hours.map(formatHourOfDay),
        labels: {
          style: {
            color: 'oklch(var(--muted-foreground))',
            fontSize: '12px',
          },
          rotation: -45,
        },
        lineColor: 'oklch(var(--border))',
        tickColor: 'oklch(var(--border))',
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
        min: 0,
      },
      plotOptions: {
        column: stacked
          ? { borderRadius: 2, pointPadding: 0.1, groupPadding: 0.1, stacking: 'normal' }
          : {
              borderRadius: 2,
              color: 'oklch(var(--primary))',
              pointPadding: 0.1,
              groupPadding: 0.1,
              states: {
                hover: {
                  color: 'oklch(var(--primary) / 0.8)',
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
        shared: stacked,
        formatter: function () {
          if (stacked) {
            const rows = stackedTooltipRows(this.points ?? [], t('pages:history.totalPlays'));
            return `<b>${this.category}</b><br/>${rows}`;
          }
          return `<b>${this.category}</b><br/>${t('labels.plays')}: ${this.y}`;
        },
      },
      series: stacked
        ? groups.map((group): Highcharts.SeriesColumnOptions => ({
            type: 'column',
            name: t(group.labelKey),
            color: group.color,
            stacking: 'normal',
            data: group.data,
          }))
        : [
            {
              type: 'column',
              name: t('labels.plays'),
              data: data.map((d) => d.count),
            },
          ],
      responsive: {
        rules: [
          {
            condition: {
              maxWidth: 400,
            },
            chartOptions: {
              xAxis: {
                labels: {
                  rotation: -60,
                },
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

  if (!data || data.length === 0 || !options) {
    return <ChartEmpty height={height} message={t('empty.noData')} />;
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}
