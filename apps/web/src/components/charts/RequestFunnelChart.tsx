import { useMemo } from 'react';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { ChartEmpty } from './ChartEmpty';

export interface FunnelStage {
  name: string;
  value: number;
}

interface RequestFunnelChartProps {
  stages: FunnelStage[];
  isLoading?: boolean;
  height?: number;
  emptyMessage: string;
  formatShare: (count: number, total: number) => string;
}

const STAGE_COLORS = [
  'oklch(var(--seq-2))',
  'oklch(var(--seq-3))',
  'oklch(var(--seq-4))',
  'oklch(var(--seq-5))',
];

export function RequestFunnelChart({
  stages,
  isLoading,
  height = 240,
  emptyMessage,
  formatShare,
}: RequestFunnelChartProps) {
  const first = stages[0]?.value ?? 0;

  const options = useMemo<Highcharts.Options>(
    () => ({
      chart: {
        type: 'bar',
        height,
        backgroundColor: 'transparent',
        style: { fontFamily: 'inherit' },
      },
      title: { text: undefined },
      credits: { enabled: false },
      legend: { enabled: false },
      xAxis: {
        categories: stages.map((stage) => stage.name),
        labels: { style: { color: 'oklch(var(--muted-foreground))', fontSize: '12px' } },
        lineColor: 'oklch(var(--border))',
        tickColor: 'oklch(var(--border))',
      },
      yAxis: {
        title: { text: undefined },
        labels: { style: { color: 'oklch(var(--muted-foreground))' } },
        gridLineColor: 'oklch(var(--border))',
        min: 0,
      },
      plotOptions: {
        bar: {
          borderRadius: 4,
          colorByPoint: true,
          colors: STAGE_COLORS,
          dataLabels: {
            enabled: true,
            style: { color: 'oklch(var(--muted-foreground))', textOutline: 'none' },
          },
          states: { hover: { brightness: 0.15 } },
        },
      },
      tooltip: {
        backgroundColor: 'oklch(var(--popover))',
        borderColor: 'oklch(var(--border))',
        style: { color: 'oklch(var(--popover-foreground))' },
        headerFormat: '',
        pointFormatter: function (this: Highcharts.Point) {
          return `<b>${this.category as string}</b><br/>${formatShare(this.y ?? 0, first)}`;
        },
      },
      series: [{ type: 'bar', name: '', data: stages.map((stage) => stage.value) }],
    }),
    [stages, height, first, formatShare]
  );

  if (isLoading) return <ChartSkeleton height={height} />;
  if (first === 0) return <ChartEmpty height={height} message={emptyMessage} />;

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%' } }}
    />
  );
}
