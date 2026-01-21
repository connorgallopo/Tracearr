import { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import type { LibraryQualityResponse } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/library';
import { BarChart3 } from 'lucide-react';

// Quality-based colors: higher quality = cooler/more vibrant colors
// Visual hierarchy helps users quickly see quality distribution
const QUALITY_COLORS = {
  '4K': '#10b981', // Emerald green - premium/best
  '1080p': '#3b82f6', // Blue - good quality
  '720p': '#f59e0b', // Amber - acceptable
  SD: '#ef4444', // Red - needs upgrade
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
          enabled: true,
          style: {
            color: 'hsl(var(--muted-foreground))',
            fontSize: '11px',
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
              return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            }
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          },
          rotation: 0,
          // Show ~6-8 labels regardless of data density
          step: Math.max(1, Math.floor(data.data.length / 7)),
        },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
        tickLength: 5,
        showFirstLabel: true,
        showLastLabel: true,
      },
      yAxis: {
        title: {
          text: 'Items',
          style: {
            color: 'hsl(var(--muted-foreground))',
            fontSize: '11px',
          },
        },
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
            fontSize: '11px',
          },
          formatter: function () {
            // Format large numbers with K suffix
            const value = this.value as number;
            if (value >= 1000) {
              return (value / 1000).toFixed(value >= 10000 ? 0 : 1) + 'K';
            }
            return String(value);
          },
        },
        gridLineColor: 'hsl(var(--border))',
        min: 0,
        reversedStacks: false, // First series (SD) at bottom, last series (4K) at top
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
          });
          // Show in reverse order (4K first) with percentage
          [...points].reverse().forEach((point) => {
            const pct = total > 0 ? (((point.y || 0) / total) * 100).toFixed(1) : '0';
            html += `<br/><span style="color:${point.color}">●</span> ${point.series.name}: ${point.y?.toLocaleString()} (${pct}%)`;
          });
          html += `<br/><b>Total: ${total.toLocaleString()} items</b>`;
          return html;
        },
      },
      // Series order determines visual stacking (bottom to top)
      // With reversedStacks: false, first series (SD) at bottom, last series (4K) at top
      series: [
        {
          type: 'area',
          name: 'SD',
          data: data.data.map((d) => d.countSd),
          color: QUALITY_COLORS['SD'],
          fillColor: {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, 'rgba(239, 68, 68, 0.5)'], // Red with opacity
              [1, 'rgba(239, 68, 68, 0.1)'],
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
              [0, 'rgba(245, 158, 11, 0.5)'], // Amber with opacity
              [1, 'rgba(245, 158, 11, 0.1)'],
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
              [0, 'rgba(59, 130, 246, 0.5)'], // Blue with opacity
              [1, 'rgba(59, 130, 246, 0.1)'],
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
              [0, 'rgba(16, 185, 129, 0.5)'], // Emerald with opacity
              [1, 'rgba(16, 185, 129, 0.1)'],
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
