import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import type { PlayStats, RangeSeriesPoint, Server } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { axisDateTimeLabelFormats, formatBucketDate, parseChartDate } from '@/lib/dateFormat';
import { ChartEmpty } from './ChartEmpty';
import {
  buildMediaGroupSeries,
  buildPerServerSeries,
  chartLang,
  sharedTooltipRows,
  STACKED_AREA_FILL_OPACITY,
  stackedTooltipRows,
} from './chartUtils';

type PlaysPoint = RangeSeriesPoint & Partial<Pick<PlayStats, 'serverId' | 'mediaType'>>;

export interface PlaysComparison {
  name: string;
  data: RangeSeriesPoint[];
  color?: string;
  dashStyle?: 'Solid' | 'ShortDash';
}

const NO_COMPARISONS: PlaysComparison[] = [];

/** The prior range laid over the current one bucket by bucket, so the two read side by side. */
export function priorRangeComparison(
  name: string,
  prior: RangeSeriesPoint[],
  current: RangeSeriesPoint[]
): PlaysComparison {
  return {
    name,
    // Equal windows can floor to one extra prior bucket, which has no slot to sit in.
    data: prior.flatMap((point, index) => {
      const slot = current[index];
      return slot ? [{ date: slot.date, count: point.count }] : [];
    }),
    color: 'oklch(var(--muted-foreground))',
    dashStyle: 'ShortDash',
  };
}

interface PlaysChartProps {
  /** Rows carry a serverId or mediaType only when the matching stack needs one. */
  data: PlaysPoint[] | undefined;
  isLoading?: boolean;
  height?: number;
  period?: 'day' | 'week' | 'month' | 'year' | 'all' | 'custom';
  /** 'server' stacks per server when isMultiServer is set; 'mediaType' stacks movies, shows, music. */
  stackBy?: 'server' | 'mediaType';
  isMultiServer?: boolean;
  servers?: Pick<Server, 'id' | 'name' | 'color'>[];
  /** Extra line series drawn over the area, e.g. a prior range. The server stack ignores them. */
  comparisons?: PlaysComparison[];
}

export function PlaysChart({
  data,
  isLoading,
  height = 200,
  period = 'month',
  stackBy = 'server',
  isMultiServer = false,
  servers = [],
  comparisons = NO_COMPARISONS,
}: PlaysChartProps) {
  const { t } = useTranslation(['common', 'pages']);

  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    const formatTooltipDate = (x: number): string =>
      formatBucketDate(x, period, (date) => t('labels.weekOf', { date }));

    const xAxisBase: Highcharts.XAxisOptions = {
      type: 'datetime',
      tickPixelInterval: 120,
      dateTimeLabelFormats: axisDateTimeLabelFormats(true),
      labels: {
        style: {
          color: 'oklch(var(--muted-foreground))',
        },
      },
      lineColor: 'oklch(var(--border))',
      tickColor: 'oklch(var(--border))',
      startOnTick: false,
      endOnTick: false,
    };

    const yAxisBase: Highcharts.YAxisOptions = {
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
    };

    const tooltipBase: Highcharts.TooltipOptions = {
      backgroundColor: 'oklch(var(--popover))',
      borderColor: 'oklch(var(--border))',
      style: {
        color: 'oklch(var(--popover-foreground))',
      },
    };

    const comparisonSeries = comparisons.map((comparison): Highcharts.SeriesLineOptions => ({
      type: 'line',
      name: comparison.name,
      color: comparison.color,
      dashStyle: comparison.dashStyle ?? 'Solid',
      lineWidth: 1.5,
      marker: { enabled: false },
      data: comparison.data.map((d) => [parseChartDate(d.date), d.count]),
    }));
    const compared = comparisons.length > 0;
    const hoverMarker: Highcharts.PointMarkerOptionsObject = {
      enabled: false,
      states: {
        hover: {
          enabled: true,
          radius: 4,
        },
      },
    };
    const stackedArea: Highcharts.PlotAreaOptions = {
      stacking: 'normal',
      marker: hoverMarker,
      lineWidth: 2,
      fillOpacity: STACKED_AREA_FILL_OPACITY,
    };

    let series: Highcharts.SeriesOptionsType[];
    let legendEnabled: boolean;
    let area: Highcharts.PlotAreaOptions;
    let tooltip: Pick<Highcharts.TooltipOptions, 'shared' | 'formatter'>;

    if (stackBy === 'mediaType') {
      const groups = buildMediaGroupSeries(data, (d) => parseChartDate(d.date));
      series = [
        ...groups.map((group): Highcharts.SeriesAreaOptions => ({
          type: 'area',
          name: t(group.labelKey),
          color: group.color,
          stacking: 'normal',
          data: group.data,
        })),
        ...comparisonSeries,
      ];
      legendEnabled = groups.length >= 2 || compared;
      area = stackedArea;
      tooltip = {
        shared: true,
        formatter: function () {
          const rows = stackedTooltipRows(this.points ?? [], t('pages:history.totalPlays'));
          return `<b>${formatTooltipDate(this.x)}</b><br/>${rows}`;
        },
      };
    } else if (isMultiServer && servers.length > 0) {
      series = buildPerServerSeries(
        data.flatMap((d) => (d.serverId === undefined ? [] : [{ ...d, serverId: d.serverId }])),
        servers,
        (d) => [parseChartDate(d.date), d.count],
        { type: 'area', stacking: 'normal' }
      );
      legendEnabled = true;
      area = stackedArea;
      tooltip = {
        shared: true,
        formatter: function () {
          return `<b>${formatTooltipDate(this.x)}</b><br/>${sharedTooltipRows(this.points ?? [])}`;
        },
      };
    } else {
      series = [
        {
          type: 'area',
          name: t('labels.plays'),
          data: data.map((d) => [parseChartDate(d.date), d.count]),
        },
        ...comparisonSeries,
      ];
      legendEnabled = compared;
      area = {
        fillColor: {
          linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
          stops: [
            [0, 'oklch(var(--primary) / 0.3)'],
            [1, 'oklch(var(--primary) / 0.05)'],
          ],
        },
        marker: hoverMarker,
        lineWidth: 2,
        lineColor: 'oklch(var(--primary))',
        states: {
          hover: {
            lineWidth: 2,
          },
        },
        threshold: null,
      };
      tooltip = {
        shared: compared,
        formatter: function () {
          const dateStr = formatTooltipDate(this.x);
          if (compared) return `<b>${dateStr}</b><br/>${sharedTooltipRows(this.points ?? [])}`;
          return `<b>${dateStr}</b><br/>${t('labels.plays')}: ${this.y}`;
        },
      };
    }

    return {
      lang: chartLang(),
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
        enabled: legendEnabled,
        itemStyle: {
          color: 'oklch(var(--muted-foreground))',
        },
        itemHoverStyle: {
          color: 'oklch(var(--foreground))',
        },
      },
      xAxis: xAxisBase,
      yAxis: yAxisBase,
      plotOptions: { area },
      tooltip: { ...tooltipBase, ...tooltip },
      series,
    };
  }, [data, height, period, stackBy, isMultiServer, servers, comparisons, t]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!data || data.length === 0) {
    return <ChartEmpty height={height} message={t('empty.noPlayData')} />;
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}
