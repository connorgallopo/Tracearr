import { useMemo, useRef } from 'react';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import {
  BANDWIDTH_STATS_CONFIG,
  liveStatsRetentionSeconds,
  type ServerBandwidthDataPoint,
} from '@tracearr/shared';
import {
  liveStatsTimeAxis,
  nearestPoints,
  useSlidingWindow,
  zeroFillSeconds,
} from './liveStatsAxis';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { ChartEmpty } from './ChartEmpty';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const COLORS = {
  local: '#cc7b9f',
  remote: '#00b4e4',
  localGradientStart: 'rgba(204, 123, 159, 0.3)',
  localGradientEnd: 'rgba(204, 123, 159, 0.05)',
  remoteGradientStart: 'rgba(0, 180, 228, 0.3)',
  remoteGradientEnd: 'rgba(0, 180, 228, 0.05)',
};

/**
 * Format bits per second matching Plex's style (bps, Kbps, Mbps, Gbps)
 */
function formatBitsPerSecond(bps: number): string {
  if (bps === 0) return '0 bps';
  const k = 1000;
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  const i = Math.min(Math.floor(Math.log(bps) / Math.log(k)), units.length - 1);
  const value = bps / Math.pow(k, i);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

// In highcharts-react's effect deps - inline literals would update per render
const UPDATE_ARGS: [boolean, boolean, boolean] = [true, true, false];
const CONTAINER_PROPS = { style: { width: '100%', height: '100%' } };

export interface BandwidthMultiSeries {
  serverId: string;
  serverName: string;
  color: string;
  data: ServerBandwidthDataPoint[];
}

interface ServerBandwidthChartProps {
  data: ServerBandwidthDataPoint[] | undefined;
  isLoading?: boolean;
  averages?: {
    local: number;
    remote: number;
  } | null;
  /** One total-throughput line per server; replaces the local/remote split */
  multiSeries?: BandwidthMultiSeries[];
  clockSkewMs?: number;
}

export function ServerBandwidthChart({
  data,
  isLoading,
  averages,
  multiSeries,
  clockSkewMs = 0,
}: ServerBandwidthChartProps) {
  const { t } = useTranslation(['pages']);
  const chartRef = useRef<HighchartsReact.RefObject | null>(null);

  useSlidingWindow(chartRef, clockSkewMs);

  const isMulti = !!multiSeries && multiSeries.length > 0;
  const hasData = isMulti ? multiSeries.some((s) => s.data.length > 0) : !!data && data.length > 0;

  const chartOptions = useMemo<Highcharts.Options>(() => {
    if (!hasData) {
      return {};
    }

    // Absent seconds moved no bytes, so they zero-fill rather than gap
    const bpsSeries = (
      points: ServerBandwidthDataPoint[],
      bytesOf: (p: ServerBandwidthDataPoint) => number
    ) =>
      // Retained span, not the visible window: clipping the fill to the window
      // leaves the left wall bare until the next poll moves `newest`
      zeroFillSeconds(
        points.map((p) => [p.at * 1000, (bytesOf(p) * 8) / p.timespan] as [number, number]),
        liveStatsRetentionSeconds(BANDWIDTH_STATS_CONFIG.WINDOW_SECONDS)
      );

    let series: Highcharts.SeriesOptionsType[];

    if (isMulti) {
      series = multiSeries.map((s) => ({
        type: 'line' as const,
        name: s.serverName,
        color: s.color,
        data: bpsSeries(s.data, (p) => p.lanBytes + p.wanBytes),
      }));
    } else {
      if (!data || data.length === 0) return {};

      series = [
        {
          type: 'area',
          name: 'Local',
          data: bpsSeries(data, (p) => p.lanBytes),
          color: COLORS.local,
          fillColor: {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, COLORS.localGradientStart],
              [1, COLORS.localGradientEnd],
            ],
          },
        },
        {
          type: 'area',
          name: 'Remote',
          data: bpsSeries(data, (p) => p.wanBytes),
          color: COLORS.remote,
          fillColor: {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, COLORS.remoteGradientStart],
              [1, COLORS.remoteGradientEnd],
            ],
          },
        },
      ];
    }

    return {
      chart: {
        type: 'area',
        height: 180,
        backgroundColor: 'transparent',
        style: { fontFamily: 'inherit' },
        spacing: [0, 10, 15, 10],
        reflow: true,
      },
      title: { text: undefined },
      credits: { enabled: false },
      legend: {
        enabled: true,
        align: 'left',
        verticalAlign: 'top',
        floating: false,
        itemStyle: {
          color: 'hsl(var(--muted-foreground))',
          fontWeight: 'normal',
          fontSize: '11px',
        },
        itemHoverStyle: { color: 'hsl(var(--foreground))' },
      },
      xAxis: liveStatsTimeAxis(Date.now() + clockSkewMs),
      yAxis: {
        title: { text: undefined },
        labels: {
          style: { color: 'hsl(var(--muted-foreground))', fontSize: '10px' },
          formatter: function () {
            return formatBitsPerSecond(this.value as number);
          },
        },
        gridLineColor: 'hsl(var(--border) / 0.5)',
        min: 0,
        softMax: 1000, // 1 Kbps floor so the axis has labels when traffic is zero
      },
      plotOptions: {
        series: {
          marker: {
            enabled: false,
            states: { hover: { enabled: true, radius: 3 } },
          },
          lineWidth: 1.5,
          states: { hover: { lineWidth: 2 } },
          connectNulls: false,
        },
        area: {
          threshold: null,
        },
      },
      tooltip: {
        backgroundColor: 'hsl(var(--popover))',
        borderColor: 'hsl(var(--border))',
        style: { color: 'hsl(var(--popover-foreground))', fontSize: '11px' },
        formatter: function () {
          const matched = nearestPoints(this);
          const secsAgo = Math.max(
            0,
            Math.round((Date.now() + clockSkewMs - Number(this.x)) / 1000)
          );
          const timeLabel =
            secsAgo === 0
              ? 'Now'
              : secsAgo >= 60
                ? `${Math.floor(secsAgo / 60)}m ${secsAgo % 60}s ago`
                : `${secsAgo}s ago`;

          const rows = matched
            .map(
              (p) =>
                `<span style="color:${p.color}">\u25CF</span> ${p.name} \u2014 <b>${formatBitsPerSecond(p.y)}</b>`
            )
            .join('<br/>');
          const total = matched.reduce((sum, p) => sum + p.y, 0);

          return (
            `<span style="font-size:10px;color:hsl(var(--muted-foreground))">${timeLabel}</span><br/>` +
            `${rows}<br/><br/>Total \u2014 <b>${formatBitsPerSecond(total)}</b>`
          );
        },
      },
      series,
      responsive: {
        rules: [
          {
            condition: { maxWidth: 400 },
            chartOptions: {
              legend: { align: 'center', layout: 'horizontal', itemStyle: { fontSize: '10px' } },
              xAxis: liveStatsTimeAxis(Date.now() + clockSkewMs, true),
            },
          },
        ],
      },
    };
  }, [data, multiSeries, isMulti, hasData, clockSkewMs]);

  // Convert byte averages to bits per second for display
  const avgLocalBps = averages ? averages.local * 8 : null;
  const avgRemoteBps = averages ? averages.remote * 8 : null;

  const cardTitle = (
    <CardTitle className="flex items-center gap-2 text-sm font-medium">
      <ArrowUpDown className="h-4 w-4" />
      {t('dashboard.bandwidth')}
    </CardTitle>
  );

  if (isLoading) {
    return (
      <Card>
        <CardHeader>{cardTitle}</CardHeader>
        <CardContent>
          <ChartSkeleton height={180} />
        </CardContent>
      </Card>
    );
  }

  if (!hasData) {
    return (
      <Card>
        <CardHeader>{cardTitle}</CardHeader>
        <CardContent>
          <ChartEmpty height={180} message="No data available" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>{cardTitle}</CardHeader>
      <CardContent>
        <HighchartsReact
          ref={chartRef}
          highcharts={Highcharts}
          options={chartOptions}
          updateArgs={UPDATE_ARGS}
          containerProps={CONTAINER_PROPS}
        />
        <div className="text-muted-foreground mt-1 flex flex-wrap justify-end gap-4 pr-2 text-xs">
          {isMulti ? (
            multiSeries.map((s) => (
              <span key={s.serverId}>
                <span style={{ color: s.color }}>{'\u25CF'}</span> Avg:{' '}
                <span className="text-foreground font-medium">
                  {s.data.length > 0
                    ? formatBitsPerSecond(
                        s.data.reduce(
                          (sum, p) => sum + ((p.lanBytes + p.wanBytes) * 8) / p.timespan,
                          0
                        ) / s.data.length
                      )
                    : '\u2014'}
                </span>
              </span>
            ))
          ) : (
            <>
              <span>
                <span style={{ color: COLORS.remote }}>{'\u25CF'}</span> Avg:{' '}
                <span className="text-foreground font-medium">
                  {avgRemoteBps !== null ? formatBitsPerSecond(avgRemoteBps) : '\u2014'}
                </span>
              </span>
              <span>
                <span style={{ color: COLORS.local }}>{'\u25CF'}</span> Avg:{' '}
                <span className="text-foreground font-medium">
                  {avgLocalBps !== null ? formatBitsPerSecond(avgLocalBps) : '\u2014'}
                </span>
              </span>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
