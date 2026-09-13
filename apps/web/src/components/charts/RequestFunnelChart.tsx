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
  'hsl(221, 83%, 53%)',
  'hsl(199, 89%, 48%)',
  'hsl(160, 84%, 39%)',
  'hsl(142, 76%, 36%)',
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
        labels: { style: { color: 'hsl(var(--muted-foreground))', fontSize: '11px' } },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
      },
      yAxis: {
        title: { text: undefined },
        labels: { style: { color: 'hsl(var(--muted-foreground))' } },
        gridLineColor: 'hsl(var(--border))',
        min: 0,
      },
      plotOptions: {
        bar: {
          borderRadius: 4,
          colorByPoint: true,
          colors: STAGE_COLORS,
          dataLabels: {
            enabled: true,
            style: { color: 'hsl(var(--muted-foreground))', textOutline: 'none' },
          },
          states: { hover: { brightness: 0.15 } },
        },
      },
      tooltip: {
        backgroundColor: 'hsl(var(--popover))',
        borderColor: 'hsl(var(--border))',
        style: { color: 'hsl(var(--popover-foreground))' },
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
