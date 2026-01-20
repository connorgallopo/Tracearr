import { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import type { WatchItem } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/library';
import { BarChart3 } from 'lucide-react';

interface WatchCountChartProps {
  data: WatchItem[] | undefined;
  isLoading?: boolean;
  height?: number;
  limit?: number;
}

export function WatchCountChart({
  data,
  isLoading,
  height = 300,
  limit = 10,
}: WatchCountChartProps) {
  const chartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    return [...data]
      .sort((a, b) => b.watchCount - a.watchCount)
      .slice(0, limit)
      .reverse(); // Reverse for horizontal bars (highest at top)
  }, [data, limit]);

  const options = useMemo<Highcharts.Options>(() => {
    if (chartData.length === 0) {
      return {};
    }

    return {
      chart: {
        type: 'bar',
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
        categories: chartData.map((d) =>
          d.title.length > 25 ? d.title.slice(0, 25) + '...' : d.title
        ),
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
            fontSize: '11px',
          },
        },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
      },
      yAxis: {
        title: {
          text: 'Watch Count',
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
        bar: {
          borderRadius: 2,
          color: 'hsl(var(--chart-1))',
          states: {
            hover: {
              color: 'hsl(var(--chart-1) / 0.8)',
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
          // Find item by matching truncated title shown on x-axis
          const xValue = String(this.x);
          const item = chartData.find(
            (d) => (d.title.length > 25 ? d.title.slice(0, 25) + '...' : d.title) === xValue
          );
          const fullTitle = item?.title || xValue;
          return `<b>${fullTitle}</b><br/>Watches: ${this.y}`;
        },
      },
      series: [
        {
          type: 'bar',
          name: 'Watches',
          data: chartData.map((d) => d.watchCount),
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
                    fontSize: '9px',
                  },
                },
              },
              yAxis: {
                title: {
                  text: undefined,
                },
                labels: {
                  style: {
                    fontSize: '9px',
                  },
                },
              },
            },
          },
        ],
      },
    };
  }, [chartData, height]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (chartData.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No watch data"
        description="Watch statistics will appear here once content has been played"
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
