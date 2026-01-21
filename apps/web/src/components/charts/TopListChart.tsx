import { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import { ChartSkeleton } from '@/components/ui/skeleton';

interface TopListItem {
  name: string;
  value: number;
  subtitle?: string;
}

interface TopListChartProps {
  data: TopListItem[] | undefined;
  isLoading?: boolean;
  height?: number;
  valueLabel?: string;
  color?: string;
  /** Use distinct colors for each bar instead of single color */
  colorful?: boolean;
}

// Colorblind-friendly palette for distinct items
const CHART_COLORS = [
  'hsl(221, 83%, 53%)', // Blue
  'hsl(262, 83%, 58%)', // Purple
  'hsl(142, 76%, 36%)', // Green
  'hsl(38, 92%, 50%)', // Orange
  'hsl(346, 77%, 50%)', // Red/Pink
  'hsl(199, 89%, 48%)', // Cyan
  'hsl(47, 96%, 53%)', // Yellow
  'hsl(280, 87%, 65%)', // Violet
  'hsl(160, 84%, 39%)', // Teal
  'hsl(24, 95%, 53%)', // Deep Orange
];

export function TopListChart({
  data,
  isLoading,
  height = 250,
  valueLabel = 'Value',
  color = 'hsl(var(--primary))',
  colorful = false,
}: TopListChartProps) {
  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    // Take top 10
    const top10 = data.slice(0, 10);

    // Build series data with optional per-bar colors
    const seriesData = top10.map((d, i) => ({
      y: d.value,
      color: colorful ? CHART_COLORS[i % CHART_COLORS.length] : color,
    }));

    return {
      chart: {
        type: 'bar',
        height,
        backgroundColor: 'transparent',
        style: {
          fontFamily: 'inherit',
        },
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
        categories: top10.map((d) => d.name),
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
        bar: {
          borderRadius: 4,
          colorByPoint: colorful,
          dataLabels: {
            enabled: true,
            style: {
              color: 'hsl(var(--muted-foreground))',
              textOutline: 'none',
              fontWeight: 'normal',
            },
          },
          states: {
            hover: {
              brightness: 0.15,
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const point = (this as any).point;
          const index = point?.index ?? 0;
          const item = top10[index];
          if (!item) return '';
          let tooltip = `<b>${item.name}</b><br/>${valueLabel}: ${this.y?.toLocaleString()}`;
          if (item.subtitle) {
            tooltip += `<br/><span style="font-size: 10px; color: hsl(var(--muted-foreground))">${item.subtitle}</span>`;
          }
          return tooltip;
        },
      },
      series: [
        {
          type: 'bar',
          name: valueLabel,
          data: seriesData,
        },
      ],
    };
  }, [data, height, valueLabel, color, colorful]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!data || data.length === 0) {
    return (
      <div
        className="text-muted-foreground flex items-center justify-center rounded-lg border border-dashed"
        style={{ height }}
      >
        No data available
      </div>
    );
  }

  return <HighchartsReact highcharts={Highcharts} options={options} />;
}
