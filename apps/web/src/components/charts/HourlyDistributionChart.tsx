import { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import type { HourlyDistribution } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/library';
import { Clock } from 'lucide-react';

interface HourlyDistributionChartProps {
  data: HourlyDistribution[] | undefined;
  isLoading?: boolean;
  height?: number;
}

const formatHour = (hour: number): string => {
  if (hour === 0) return '12am';
  if (hour === 12) return '12pm';
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
};

export function HourlyDistributionChart({
  data,
  isLoading,
  height = 250,
}: HourlyDistributionChartProps) {
  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

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
        enabled: false,
      },
      xAxis: {
        categories: data.map((d) => formatHour(d.hour)),
        labels: {
          rotation: -45,
          style: {
            color: 'hsl(var(--muted-foreground))',
            fontSize: '10px',
          },
        },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
      },
      yAxis: {
        title: {
          text: 'Watches',
          style: {
            color: 'hsl(var(--muted-foreground))',
          },
        },
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
          },
        },
        gridLineColor: 'hsl(var(--border))',
        min: 0,
      },
      plotOptions: {
        column: {
          borderRadius: 2,
          color: 'hsl(var(--chart-2))',
          pointPadding: 0.1,
          groupPadding: 0.1,
          states: {
            hover: {
              color: 'hsl(var(--chart-2) / 0.8)',
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
        formatter: function () {
          return `<b>${this.x}</b><br/>Watches: ${this.y}`;
        },
      },
      series: [
        {
          type: 'column',
          name: 'Watches',
          data: data.map((d) => d.watchCount),
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
                  style: {
                    fontSize: '8px',
                  },
                  rotation: -60,
                },
              },
              yAxis: {
                title: {
                  text: undefined,
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

  if (!data || data.length === 0) {
    return (
      <EmptyState
        icon={Clock}
        title="No hourly data"
        description="Watch distribution by hour will appear here once data is available"
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
