import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { PLAYBACK_DECISION_LABEL_KEYS } from '@tracearr/shared';
import { getHour12 } from '@/lib/timeFormat';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { ChartEmpty } from './ChartEmpty';
import { parseChartDate } from './chartUtils';

interface ConcurrentData {
  hour: string;
  total: number;
  direct: number;
  directStream: number;
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
  const { t } = useTranslation();
  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    const timestamps = data.map((d) => parseChartDate(d.hour));

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
        floating: false,
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
        type: 'datetime',
        tickPixelInterval: 120,
        dateTimeLabelFormats: {
          hour: { main: getHour12() ? '%l %p' : '%k:%M' },
          day: { main: '%b %e' },
          week: { main: '%b %e' },
          month: { main: `%b '%y` },
          year: { main: '%Y' },
        },
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
          },
        },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
        startOnTick: false,
        endOnTick: false,
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
          const date = new Date(this.x);

          let dateStr: string;
          if (period === 'all') {
            dateStr = `Week of ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
          } else if (period === 'year' || period === 'month') {
            dateStr = date.toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            });
          } else {
            // day (hourly) or week (6-hour)
            dateStr = `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString('en-US', { hour: 'numeric', hour12: getHour12() })}`;
          }
          let html = `<b>${dateStr}</b>`;

          let total = 0;
          points.forEach((point) => {
            total += point.y || 0;
            html += `<br/><span style="color:${point.color}">●</span> ${point.series.name}: ${point.y}`;
          });
          html += `<br/><b>Peak Concurrent: ${total}</b>`;

          return html;
        },
      },
      series: [
        {
          type: 'area',
          name: t(PLAYBACK_DECISION_LABEL_KEYS.directplay),
          data: data.map((d, i) => [timestamps[i] ?? 0, d.direct]),
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
          name: t(PLAYBACK_DECISION_LABEL_KEYS.copy),
          data: data.map((d, i) => [timestamps[i] ?? 0, d.directStream]),
          color: 'hsl(210, 76%, 50%)',
          fillColor: {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, 'hsl(210 76% 50% / 0.4)'],
              [1, 'hsl(210 76% 50% / 0.1)'],
            ],
          },
        },
        {
          type: 'area',
          name: t(PLAYBACK_DECISION_LABEL_KEYS.transcode),
          data: data.map((d, i) => [timestamps[i] ?? 0, d.transcode]),
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
  }, [data, height, period, t]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!data || data.length === 0) {
    return <ChartEmpty height={height} message="No concurrent stream data available" />;
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}
