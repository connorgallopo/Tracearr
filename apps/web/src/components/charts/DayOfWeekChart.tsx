import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import type { DayOfWeekStats } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { orderedWeekdays, weekdayName } from '@/lib/dateFormat';
import { ChartEmpty } from './ChartEmpty';
import { buildMediaGroupSeries, stackedTooltipRows } from './chartUtils';

interface DayOfWeekChartProps {
  /** Rows carrying a mediaType stack movies, shows and music per day. */
  data: DayOfWeekStats[] | undefined;
  isLoading?: boolean;
  height?: number;
}

export function DayOfWeekChart({ data, isLoading, height = 250 }: DayOfWeekChartProps) {
  const { t } = useTranslation(['common', 'pages']);

  const options = useMemo<Highcharts.Options | null>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    const days = orderedWeekdays();
    const dayIndex = new Map(days.map((day, index) => [day, index]));
    const stacked = data.some((d) => d.mediaType !== undefined);
    const groups = stacked ? buildMediaGroupSeries(data, (d) => dayIndex.get(d.day) ?? d.day) : [];
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
        categories: days.map((day) => weekdayName(day, 'short')),
        labels: {
          style: {
            color: 'oklch(var(--muted-foreground))',
          },
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
          ? { borderRadius: 4, stacking: 'normal' }
          : {
              borderRadius: 4,
              color: 'oklch(var(--primary))',
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
              data: days.map((day) => data.find((d) => d.day === day)?.count ?? 0),
            },
          ],
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
