import { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import type { ServerBandwidthDataPoint } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

const X_LABELS: Record<number, string> = {
  [-120]: '2m',
  [-110]: '1m 50s',
  [-100]: '1m 40s',
  [-90]: '1m 30s',
  [-80]: '1m 20s',
  [-70]: '1m 10s',
  [-60]: '1m',
  [-50]: '50s',
  [-40]: '40s',
  [-30]: '30s',
  [-20]: '20s',
  [-10]: '10s',
  [0]: 'NOW',
};

const POLL_OPTIONS = [
  { value: '1', label: '1s' },
  { value: '3', label: '3s' },
  { value: '6', label: '6s' },
  { value: '10', label: '10s' },
];

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

interface ServerBandwidthChartProps {
  data: ServerBandwidthDataPoint[] | undefined;
  isLoading?: boolean;
  averages?: {
    local: number;
    remote: number;
  } | null;
  pollInterval: number;
  onPollIntervalChange: (interval: number) => void;
}

function PollIntervalSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="h-6 w-[60px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {POLL_OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} className="text-xs">
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ServerBandwidthChart({
  data,
  isLoading,
  averages,
  pollInterval,
  onPollIntervalChange,
}: ServerBandwidthChartProps) {
  const { t } = useTranslation(['pages']);

  const chartOptions = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    const localData: [number, number][] = [];
    const remoteData: [number, number][] = [];

    // Use timestamp-based x positions so points stay fixed as new data arrives.
    // The newest point is at x=0 (NOW), older points at negative seconds.
    const lastPoint = data[data.length - 1];
    if (!lastPoint) return {};
    const newestAt = lastPoint.at;
    for (const point of data) {
      const x = -(newestAt - point.at);
      // Convert bytes to bits per second (bytes * 8 / timespan)
      localData.push([x, (point.lanBytes * 8) / point.timespan]);
      remoteData.push([x, (point.wanBytes * 8) / point.timespan]);
    }

    return {
      chart: {
        type: 'area',
        height: 180,
        backgroundColor: 'transparent',
        style: { fontFamily: 'inherit' },
        spacing: [10, 10, 15, 10],
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
      xAxis: {
        type: 'linear',
        min: -120,
        max: 0,
        tickInterval: 10,
        labels: {
          style: { color: 'hsl(var(--muted-foreground))', fontSize: '10px' },
          formatter: function () {
            return X_LABELS[this.value as number] || '';
          },
        },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
      },
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
        area: {
          marker: {
            enabled: false,
            states: { hover: { enabled: true, radius: 3 } },
          },
          lineWidth: 1.5,
          states: { hover: { lineWidth: 2 } },
          threshold: null,
          connectNulls: false,
        },
      },
      tooltip: {
        shared: true,
        backgroundColor: 'hsl(var(--popover))',
        borderColor: 'hsl(var(--border))',
        style: { color: 'hsl(var(--popover-foreground))', fontSize: '11px' },
        formatter: function () {
          const points = this.points || [];
          const x = this.x;
          const secsAgo = Math.round(Math.abs(x));
          const timeLabel =
            secsAgo === 0
              ? 'Now'
              : secsAgo >= 60
                ? `${Math.floor(secsAgo / 60)}m ${secsAgo % 60}s ago`
                : `${secsAgo}s ago`;

          let html = `<span style="font-size:10px;color:hsl(var(--muted-foreground))">${timeLabel}</span><br/>`;
          let total = 0;
          for (const point of points) {
            if (point.y !== null) {
              const color = point.series.color;
              total += point.y as number;
              html += `<span style="color:${color}">\u25CF</span> ${point.series.name} \u2014 <b>${formatBitsPerSecond(point.y as number)}</b><br/>`;
            }
          }
          html += `<br/>Total \u2014 <b>${formatBitsPerSecond(total)}</b>`;
          return html;
        },
      },
      series: [
        {
          type: 'area',
          name: 'Local',
          data: localData,
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
          data: remoteData,
          color: COLORS.remote,
          fillColor: {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, COLORS.remoteGradientStart],
              [1, COLORS.remoteGradientEnd],
            ],
          },
        },
      ],
      responsive: {
        rules: [
          {
            condition: { maxWidth: 400 },
            chartOptions: {
              legend: { align: 'center', layout: 'horizontal', itemStyle: { fontSize: '10px' } },
              xAxis: { tickInterval: 20, labels: { style: { fontSize: '9px' } } },
            },
          },
        ],
      },
    };
  }, [data]);

  // Convert byte averages to bits per second for display
  const avgLocalBps = averages ? averages.local * 8 : null;
  const avgRemoteBps = averages ? averages.remote * 8 : null;

  const headerRight = <PollIntervalSelect value={pollInterval} onChange={onPollIntervalChange} />;

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm font-medium">
            <span className="flex items-center gap-2">
              <ArrowUpDown className="h-4 w-4" />
              {t('dashboard.bandwidth')}
            </span>
            {headerRight}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChartSkeleton height={180} />
        </CardContent>
      </Card>
    );
  }

  if (!data || data.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm font-medium">
            <span className="flex items-center gap-2">
              <ArrowUpDown className="h-4 w-4" />
              {t('dashboard.bandwidth')}
            </span>
            {headerRight}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className="text-muted-foreground flex items-center justify-center rounded-lg border border-dashed text-sm"
            style={{ height: 180 }}
          >
            No data available
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <span className="flex items-center gap-2">
            <ArrowUpDown className="h-4 w-4" />
            {t('dashboard.bandwidth')}
          </span>
          {headerRight}
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-2">
        <HighchartsReact
          highcharts={Highcharts}
          options={chartOptions}
          updateArgs={[true, true, false]}
          containerProps={{ style: { width: '100%', height: '100%' } }}
        />
        <div className="text-muted-foreground mt-1 flex justify-end gap-4 pr-2 text-xs">
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
        </div>
      </CardContent>
    </Card>
  );
}
