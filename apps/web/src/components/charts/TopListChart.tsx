import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { ChartEmpty } from './ChartEmpty';
import { CATEGORICAL_COLORS } from './chartUtils';

interface TopListItem {
  name: string;
  value: number;
  subtitle?: string;
}

interface TopListChartProps {
  data: TopListItem[] | undefined;
  isLoading?: boolean;
  height?: number;
  valueLabel: string;
  color?: string;
  /** Use distinct colors for each bar instead of single color */
  colorful?: boolean;
  /** How many leading rows of `data` to plot; the rest is omitted. */
  limit?: number;
  /** Makes bars clickable; `point` is the click position inside the chart container. */
  onItemClick?: (index: number, point: { x: number; y: number }) => void;
  /** Rows that stay inert when onItemClick is set, e.g. an aggregated "Other". */
  isItemClickable?: (index: number) => boolean;
}

export function TopListChart({
  data,
  isLoading,
  height = 250,
  valueLabel,
  color = 'oklch(var(--primary))',
  colorful = false,
  limit = 10,
  onItemClick,
  isItemClickable,
}: TopListChartProps) {
  const { t } = useTranslation();
  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    const top10 = data.slice(0, limit);

    // Build series data with optional per-bar colors
    const clickable = (i: number) => !!onItemClick && (isItemClickable?.(i) ?? true);
    const seriesData = top10.map((d, i) => ({
      y: d.value,
      color: colorful ? CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length] : color,
      className: clickable(i) ? 'cursor-pointer' : undefined,
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
            color: 'oklch(var(--muted-foreground))',
            fontSize: '12px',
          },
        },
        lineColor: 'oklch(var(--border))',
        tickColor: 'oklch(var(--border))',
      },
      yAxis: {
        title: {
          text: undefined,
        },
        labels: {
          style: {
            color: 'oklch(var(--muted-foreground))',
          },
        },
        gridLineColor: 'oklch(var(--border))',
        min: 0,
      },
      plotOptions: {
        bar: {
          borderRadius: 4,
          colorByPoint: colorful,
          dataLabels: {
            enabled: true,
            style: {
              color: 'oklch(var(--muted-foreground))',
              textOutline: 'none',
              fontWeight: 'normal',
            },
          },
          states: {
            hover: {
              brightness: 0.15,
            },
          },
          point: {
            events: {
              click: function (event) {
                if (!clickable(this.index)) return;
                onItemClick?.(this.index, { x: event.chartX, y: event.chartY });
              },
            },
          },
        },
      },
      tooltip: {
        backgroundColor: 'oklch(var(--popover))',
        borderColor: 'oklch(var(--border))',
        style: {
          color: 'oklch(var(--popover-foreground))',
        },
        formatter: function () {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const point = (this as any).point;
          const index = point?.index ?? 0;
          const item = top10[index];
          if (!item) return '';
          let tooltip = `<b>${item.name}</b><br/>${valueLabel}: ${this.y?.toLocaleString()}`;
          if (item.subtitle) {
            tooltip += `<br/><span style="font-size: 12px; color: oklch(var(--muted-foreground))">${item.subtitle}</span>`;
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
  }, [data, height, valueLabel, color, colorful, limit, onItemClick, isItemClickable]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!data || data.length === 0) {
    return <ChartEmpty height={height} message={t('empty.noData')} />;
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}
