import { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import type { LibraryQualityResponse } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/library';
import { BarChart3 } from 'lucide-react';

// Colorblind-friendly, distinct colors for each quality tier
// Matches QualityDonutChart for visual consistency
const QUALITY_COLORS = {
  '4K': 'hsl(262, 83%, 58%)', // Purple - highest quality stands out
  '1080p': 'hsl(221, 83%, 53%)', // Blue
  '720p': 'hsl(142, 76%, 36%)', // Green
  SD: 'hsl(38, 92%, 50%)', // Orange - lowest quality warning
};

interface QualityTimelineChartProps {
  data: LibraryQualityResponse | undefined;
  isLoading?: boolean;
  height?: number;
  period?: string;
}

export function QualityTimelineChart({
  data,
  isLoading,
  height = 250,
  period = '30d',
}: QualityTimelineChartProps) {
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
        showFirstLabel: true,
        showLastLabel: true,
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
          stacking: 'normal',
          marker: {
            // Enable markers for single data points, otherwise hide them
            enabled: data.data.length < 3,
            radius: 4,
            states: {
              hover: {
                enabled: true,
                radius: 5,
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
          // For shared tooltips, get category via the x index
          const xIndex = typeof this.x === 'number' ? this.x : 0;
          const categories = this.points?.[0]?.series.xAxis.categories || [];
          const categoryValue = categories[xIndex] as string | undefined;
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
              : '';

          let html = dateStr ? `<b>${dateStr}</b>` : '';
          let total = 0;
          points.forEach((point) => {
            total += point.y || 0;
            html += `<br/><span style="color:${point.color}">●</span> ${point.series.name}: ${point.y?.toLocaleString()}`;
          });
          html += `<br/><b>Total: ${total.toLocaleString()}</b>`;
          return html;
        },
      },
      // Series order determines visual stacking (bottom to top)
      // SD at bottom, 4K on top - lower quality forms base, higher quality stacks on top
      series: [
        {
          type: 'area',
          name: 'SD',
          data: data.data.map((d) => d.countSd),
          color: QUALITY_COLORS['SD'],
          fillColor: {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, 'hsl(38, 92%, 50% / 0.4)'],
              [1, 'hsl(38, 92%, 50% / 0.1)'],
            ],
          },
        },
        {
          type: 'area',
          name: '720p',
          data: data.data.map((d) => d.count720p),
          color: QUALITY_COLORS['720p'],
          fillColor: {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, 'hsl(142, 76%, 36% / 0.4)'],
              [1, 'hsl(142, 76%, 36% / 0.1)'],
            ],
          },
        },
        {
          type: 'area',
          name: '1080p',
          data: data.data.map((d) => d.count1080p),
          color: QUALITY_COLORS['1080p'],
          fillColor: {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, 'hsl(221, 83%, 53% / 0.4)'],
              [1, 'hsl(221, 83%, 53% / 0.1)'],
            ],
          },
        },
        {
          type: 'area',
          name: '4K',
          data: data.data.map((d) => d.count4k),
          color: QUALITY_COLORS['4K'],
          fillColor: {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, 'hsl(262, 83%, 58% / 0.4)'],
              [1, 'hsl(262, 83%, 58% / 0.1)'],
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
        icon={BarChart3}
        title="No quality data"
        description="Quality evolution data will appear here once available"
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
