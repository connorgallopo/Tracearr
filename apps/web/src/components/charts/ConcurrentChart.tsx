import { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import { ChartSkeleton } from '@/components/ui/skeleton';

interface ConcurrentData {
  hour: string;
  total: number;
  direct: number;
  transcode: number;
}

interface ConcurrentChartProps {
  data: ConcurrentData[] | undefined;
  isLoading?: boolean;
  height?: number;
  period?: 'day' | 'week' | 'month' | 'year' | 'all' | 'custom';
}

export function ConcurrentChart({
  data,
  isLoading,
  height = 250,
  period = 'month',
}: ConcurrentChartProps) {
  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    // Find the peak total for highlighting
    const maxValue = Math.max(...data.map((d) => d.total));

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
        enabled: true,
        align: 'right',
        verticalAlign: 'top',
        floating: true,
        itemStyle: {
          color: 'hsl(var(--muted-foreground))',
          fontWeight: 'normal',
          fontSize: '11px',
        },
        itemHoverStyle: {
          color: 'hsl(var(--foreground))',
        },
      },
      xAxis: {
        categories: data.map((d) => d.hour),
        // Calculate appropriate number of labels based on period
        // Week: 7 labels (one per day), Month: ~10, Year: 12
        tickPositions: (() => {
          const numLabels =
            period === 'week' || period === 'day' ? 7 : period === 'month' ? 10 : 12;
          const actualLabels = Math.min(numLabels, data.length);
          return Array.from({ length: actualLabels }, (_, i) =>
            Math.floor((i * (data.length - 1)) / (actualLabels - 1 || 1))
          );
        })(),
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
          },
          formatter: function () {
            // this.value could be index (number) or category string depending on Highcharts version
            const categories = this.axis.categories;
            const categoryValue =
              typeof this.value === 'number' ? categories[this.value] : this.value;
            if (!categoryValue) return '';
            const date = new Date(categoryValue);
            if (isNaN(date.getTime())) return '';
            if (period === 'year') {
              // Short month name for yearly view (Dec, Jan, Feb)
              return date.toLocaleDateString('en-US', { month: 'short' });
            }
            // M/D format for week/month views
            return `${date.getMonth() + 1}/${date.getDate()}`;
          },
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
        allowDecimals: false,
        plotLines: [
          {
            value: maxValue,
            color: 'hsl(var(--destructive))',
            dashStyle: 'Dash',
            width: 1,
          },
        ],
      },
      plotOptions: {
        area: {
          stacking: 'normal',
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
        shared: true,
        formatter: function () {
          const points = this.points || [];
          // With categories, this.x is the index. Use the category value from points[0].key
          const categoryValue = points[0]?.key as string | undefined;
          const date = categoryValue ? new Date(categoryValue) : null;
          const dateStr =
            date && !isNaN(date.getTime())
              ? `${date.toLocaleDateString()} ${date.getHours()}:00`
              : 'Unknown';
          let html = `<b>${dateStr}</b>`;

          // Calculate total from stacked values
          let total = 0;
          points.forEach((point) => {
            total += point.y || 0;
            html += `<br/><span style="color:${point.color}">●</span> ${point.series.name}: ${point.y}`;
          });
          html += `<br/><b>Total: ${total}</b>`;

          return html;
        },
      },
      series: [
        {
          type: 'area',
          name: 'Direct Play',
          data: data.map((d) => d.direct),
          color: 'hsl(var(--chart-2))',
          fillColor: {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, 'hsl(var(--chart-2) / 0.4)'],
              [1, 'hsl(var(--chart-2) / 0.1)'],
            ],
          },
        },
        {
          type: 'area',
          name: 'Transcode',
          data: data.map((d) => d.transcode),
          color: 'hsl(var(--chart-4))',
          fillColor: {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, 'hsl(var(--chart-4) / 0.4)'],
              [1, 'hsl(var(--chart-4) / 0.1)'],
            ],
          },
        },
      ],
      responsive: {
        rules: [
          {
            condition: {
              maxWidth: 400,
            },
            chartOptions: {
              legend: {
                floating: false,
                align: 'center',
                verticalAlign: 'bottom',
                itemStyle: {
                  fontSize: '10px',
                },
              },
              xAxis: {
                labels: {
                  style: {
                    fontSize: '9px',
                  },
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

  if (!data || data.length === 0) {
    return (
      <div
        className="text-muted-foreground flex items-center justify-center rounded-lg border border-dashed"
        style={{ height }}
      >
        No concurrent stream data available
      </div>
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
