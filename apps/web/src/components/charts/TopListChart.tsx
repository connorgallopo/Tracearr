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
}

export function TopListChart({
  data,
  isLoading,
  height = 250,
  valueLabel = 'Value',
  color = 'hsl(var(--primary))',
}: TopListChartProps) {
  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    // Take top 10
    const top10 = data.slice(0, 10);

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
          color: color,
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
              color: color.replace(')', ' / 0.8)').replace('hsl', 'hsl'),
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
          const xValue = String(this.x);
          const item = top10.find((d) => d.name === xValue);
          let tooltip = `<b>${xValue}</b><br/>${valueLabel}: ${this.y}`;
          if (item?.subtitle) {
            tooltip += `<br/><span style="font-size: 10px; color: hsl(var(--muted-foreground))">${item.subtitle}</span>`;
          }
          return tooltip;
        },
      },
      series: [
        {
          type: 'bar',
          name: valueLabel,
          data: top10.map((d) => d.value),
        },
      ],
    };
  }, [data, height, valueLabel, color]);

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
