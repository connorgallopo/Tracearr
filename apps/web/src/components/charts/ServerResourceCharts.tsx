import { useMemo, useRef } from 'react';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { SERVER_STATS_CONFIG, type ServerResourceDataPoint } from '@tracearr/shared';
import {
  liveStatsTimeAxis,
  nearestPointTooltip,
  useSlidingWindow,
  withGaps,
} from './liveStatsAxis';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { ChartEmpty } from './ChartEmpty';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Cpu, MemoryStick } from 'lucide-react';

// Colors matching Plex's style
const COLORS = {
  process: '#00b4e4', // Plex-style cyan for "Plex Media Server"
  system: '#cc7b9f', // Pink/purple for "System"
  processGradientStart: 'rgba(0, 180, 228, 0.3)',
  processGradientEnd: 'rgba(0, 180, 228, 0.05)',
  systemGradientStart: 'rgba(204, 123, 159, 0.3)',
  systemGradientEnd: 'rgba(204, 123, 159, 0.05)',
};

// In highcharts-react's effect deps - inline literals would update per render
const UPDATE_ARGS: [boolean, boolean, boolean] = [true, true, false];
const CONTAINER_PROPS = { style: { width: '100%', height: '100%' } };

type ProcessKey = 'processCpuUtilization' | 'processMemoryUtilization';
type HostKey = 'hostCpuUtilization' | 'hostMemoryUtilization';

export interface ResourceMultiSeries {
  serverId: string;
  serverName: string;
  color: string;
  data: ServerResourceDataPoint[];
}

interface ServerResourceChartsProps {
  data: ServerResourceDataPoint[] | undefined;
  isLoading?: boolean;
  averages?: {
    hostCpu: number | null;
    processCpu: number;
    hostMemory: number | null;
    processMemory: number;
  } | null;
  /** One per-server line each; host metrics are dropped in this mode */
  multiSeries?: ResourceMultiSeries[];
  /** Single-view name for the process series (defaults to Plex's) */
  processLabel?: string;
  clockSkewMs?: number;
}

interface ResourceChartProps extends Omit<ServerResourceChartsProps, 'averages'> {
  title: string;
  icon: React.ReactNode;
  processKey: ProcessKey;
  hostKey: HostKey;
  processAvg?: number;
  hostAvg?: number | null;
}

const pointsFor = (
  data: ServerResourceDataPoint[],
  key: ProcessKey | HostKey
): [number, number | null][] => data.map((p) => [p.at * 1000, p[key]]);

function ResourceChart({
  title,
  icon,
  data,
  processKey,
  hostKey,
  processAvg,
  hostAvg,
  isLoading,
  multiSeries,
  processLabel,
  clockSkewMs = 0,
}: ResourceChartProps) {
  const chartRef = useRef<HighchartsReact.RefObject | null>(null);
  const isMulti = !!multiSeries && multiSeries.length > 0;
  const hasData = isMulti ? multiSeries.some((s) => s.data.length > 0) : !!data?.length;

  useSlidingWindow(chartRef, clockSkewMs);

  const chartOptions = useMemo<Highcharts.Options>(() => {
    if (!hasData) return {};

    const gap = SERVER_STATS_CONFIG.GAP_BREAK_SECONDS;

    // Host metrics belong to the box: N co-hosted servers, N identical lines
    const series: Highcharts.SeriesOptionsType[] = isMulti
      ? multiSeries.map((s) => ({
          type: 'line' as const,
          name: s.serverName,
          color: s.color,
          data: withGaps(pointsFor(s.data, processKey), gap),
        }))
      : [
          {
            type: 'area',
            name: processLabel ?? 'Plex Media Server',
            color: COLORS.process,
            data: withGaps(pointsFor(data ?? [], processKey), gap),
            fillColor: {
              linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
              stops: [
                [0, COLORS.processGradientStart],
                [1, COLORS.processGradientEnd],
              ],
            },
          },
          {
            type: 'area',
            name: 'System',
            color: COLORS.system,
            data: withGaps(pointsFor(data ?? [], hostKey), gap),
            fillColor: {
              linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
              stops: [
                [0, COLORS.systemGradientStart],
                [1, COLORS.systemGradientEnd],
              ],
            },
          },
        ];

    const values = series.flatMap((s) =>
      ((s as { data?: [number, number | null][] }).data ?? [])
        .map(([, y]) => y)
        .filter((v): v is number => v != null)
    );
    const maxValue = Math.max(...values, 0);

    // Process metrics idle near zero; only host values need a coarse scale
    const yMax =
      maxValue <= 5 ? Math.max(2, Math.ceil(maxValue * 1.3)) : Math.ceil(maxValue / 10) * 10;

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
          format: '{value}%',
        },
        gridLineColor: 'hsl(var(--border) / 0.5)',
        min: 0,
        max: yMax,
        tickInterval: yMax <= 10 ? 1 : yMax <= 20 ? 5 : 10,
      },
      plotOptions: {
        series: {
          marker: { enabled: false, states: { hover: { enabled: true, radius: 3 } } },
          lineWidth: 2,
          states: { hover: { lineWidth: 2 } },
          connectNulls: false,
        },
        area: { threshold: null },
      },
      tooltip: {
        backgroundColor: 'hsl(var(--popover))',
        borderColor: 'hsl(var(--border))',
        style: { color: 'hsl(var(--popover-foreground))', fontSize: '11px' },
        formatter: nearestPointTooltip((y) => `${Math.round(y)}%`),
      },
      series,
      responsive: {
        rules: [
          {
            condition: { maxWidth: 400 },
            chartOptions: {
              legend: {
                align: 'center',
                layout: 'horizontal',
                itemStyle: { fontSize: '10px' },
              },
              xAxis: liveStatsTimeAxis(Date.now() + clockSkewMs, true),
            },
          },
        ],
      },
    };
  }, [data, processKey, hostKey, multiSeries, isMulti, hasData, processLabel, clockSkewMs]);

  const header = (
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
        {/* Per-process, not per-host: an order of magnitude smaller */}
        {isMulti && <span className="text-muted-foreground font-normal">per server</span>}
      </CardTitle>
    </CardHeader>
  );

  if (isLoading) {
    return (
      <Card>
        {header}
        <CardContent>
          <ChartSkeleton height={180} />
        </CardContent>
      </Card>
    );
  }

  if (!hasData) {
    return (
      <Card>
        {header}
        <CardContent>
          <ChartEmpty height={180} message="No data available" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {header}
      <CardContent>
        <HighchartsReact
          ref={chartRef}
          highcharts={Highcharts}
          options={chartOptions}
          // animation:false, or the default swing cancels the in-flight pan
          updateArgs={UPDATE_ARGS}
          containerProps={CONTAINER_PROPS}
        />
        <div className="text-muted-foreground mt-1 flex flex-wrap justify-end gap-4 pr-2 text-xs">
          {isMulti ? (
            multiSeries.map((s) => {
              const values = s.data.map((p) => p[processKey]).filter((v): v is number => v != null);
              const avg =
                values.length > 0
                  ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length)
                  : null;
              return (
                <span key={s.serverId}>
                  <span style={{ color: s.color }}>●</span> Avg:{' '}
                  <span className="text-foreground font-medium">{avg ?? '—'}%</span>
                </span>
              );
            })
          ) : (
            <>
              <span>
                <span style={{ color: COLORS.process }}>●</span> Avg:{' '}
                <span className="text-foreground font-medium">{processAvg ?? '—'}%</span>
              </span>
              <span>
                <span style={{ color: COLORS.system }}>●</span> Avg:{' '}
                <span className="text-foreground font-medium">{hostAvg ?? '—'}%</span>
              </span>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Live CPU and RAM utilization, one card each. */
export function ServerResourceCharts({
  data,
  isLoading,
  averages,
  multiSeries,
  processLabel,
  clockSkewMs,
}: ServerResourceChartsProps) {
  const shared = { data, isLoading, multiSeries, processLabel, clockSkewMs };

  return (
    <>
      <ResourceChart
        {...shared}
        title="CPU"
        icon={<Cpu className="h-4 w-4" />}
        processKey="processCpuUtilization"
        hostKey="hostCpuUtilization"
        processAvg={averages?.processCpu}
        hostAvg={averages?.hostCpu}
      />
      <ResourceChart
        {...shared}
        title="RAM"
        icon={<MemoryStick className="h-4 w-4" />}
        processKey="processMemoryUtilization"
        hostKey="hostMemoryUtilization"
        processAvg={averages?.processMemory}
        hostAvg={averages?.hostMemory}
      />
    </>
  );
}
