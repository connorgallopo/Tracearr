import { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import type { LibraryGrowthResponse } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/library';
import { TrendingUp } from 'lucide-react';

interface LibraryGrowthChartProps {
  data: LibraryGrowthResponse | undefined;
  isLoading?: boolean;
  height?: number;
  period?: string;
}

export function LibraryGrowthChart({
  data,
  isLoading,
  height = 250,
  period = '30d',
}: LibraryGrowthChartProps) {
  const options = useMemo<Highcharts.Options>(() => {
    if (!data?.data || data.data.length === 0) {
      return {};
    }

    return {
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
        enabled: false,
      },
      xAxis: {
        categories: data.data.map((d) => d.day),
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
          },
          formatter: function () {
            const categories = this.axis.categories;
            const categoryValue =
              typeof this.value === 'number' ? categories[this.value] : this.value;
            if (!categoryValue) return '';
            const date = new Date(
              categoryValue.includes('T') ? categoryValue : categoryValue + 'T00:00:00'
            );
            if (isNaN(date.getTime())) return '';
            if (period === '1y' || period === 'year') {
              // Short month name for yearly view
              return date.toLocaleDateString('en-US', { month: 'short' });
            }
            // M/D format for shorter views
            return `${date.getMonth() + 1}/${date.getDate()}`;
          },
          step: Math.ceil(data.data.length / 12),
        },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
      },
      yAxis: {
        title: {
          text: undefined,
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
        area: {
          fillColor: {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, 'hsl(var(--primary) / 0.3)'],
              [1, 'hsl(var(--primary) / 0.05)'],
            ],
          },
          marker: {
            enabled: false,
            states: {
              hover: {
                enabled: true,
                radius: 4,
              },
            },
          },
          lineWidth: 2,
          lineColor: 'hsl(var(--primary))',
          states: {
            hover: {
              lineWidth: 2,
            },
          },
          threshold: null,
        },
      },
      tooltip: {
        backgroundColor: 'hsl(var(--popover))',
        borderColor: 'hsl(var(--border))',
        style: {
          color: 'hsl(var(--popover-foreground))',
        },
        formatter: function () {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const categoryValue = (this as any).point?.category as string | undefined;
          const date = categoryValue
            ? new Date(categoryValue.includes('T') ? categoryValue : categoryValue + 'T00:00:00')
            : null;
          const dateStr =
            date && !isNaN(date.getTime())
              ? date.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })
              : 'Unknown';
          return `<b>${dateStr}</b><br/>Items: ${this.y?.toLocaleString()}`;
        },
      },
      series: [
        {
          type: 'area',
          name: 'Items',
          data: data.data.map((d) => d.totalItems),
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
                  step: Math.ceil(data.data.length / 6),
                },
              },
              yAxis: {
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
  }, [data, height, period]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!data?.data || data.data.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No growth data"
        description="Library growth data will appear here once available"
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
