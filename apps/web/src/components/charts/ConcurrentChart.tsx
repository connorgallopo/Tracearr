import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { PLAYBACK_DECISION_LABEL_KEYS } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { axisDateTimeLabelFormats, formatBucketDate, parseChartDate } from '@/lib/dateFormat';
import { ChartEmpty } from './ChartEmpty';
import { chartLang, PLAYBACK_COLORS, STACKED_AREA_FILL_OPACITY } from './chartUtils';

interface ConcurrentData {
  hour: string;
  total: number;
  direct: number;
  directStream: number;
  transcode: number;
  audioTranscode: number;
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
  const { t } = useTranslation(['common', 'pages']);
  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    const points = (value: (d: ConcurrentData) => number): [number, number][] =>
      data.map((d) => [parseChartDate(d.hour), value(d)]);

    return {
      lang: chartLang(),
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
          color: 'oklch(var(--muted-foreground))',
          fontWeight: 'normal',
          fontSize: '12px',
        },
        itemHoverStyle: {
          color: 'oklch(var(--foreground))',
        },
      },
      xAxis: {
        type: 'datetime',
        tickPixelInterval: 120,
        dateTimeLabelFormats: axisDateTimeLabelFormats(true),
        labels: {
          style: {
            color: 'oklch(var(--muted-foreground))',
          },
        },
        lineColor: 'oklch(var(--border))',
        tickColor: 'oklch(var(--border))',
        startOnTick: false,
        endOnTick: false,
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
          fillOpacity: STACKED_AREA_FILL_OPACITY,
          states: {
            hover: {
              lineWidth: 2,
            },
          },
          threshold: null,
        },
      },
      tooltip: {
        backgroundColor: 'oklch(var(--popover))',
        borderColor: 'oklch(var(--border))',
        style: {
          color: 'oklch(var(--popover-foreground))',
        },
        shared: true,
        formatter: function () {
          const points = this.points || [];
          const dateStr = formatBucketDate(this.x, period, (date) => t('labels.weekOf', { date }));
          let html = `<b>${dateStr}</b>`;

          let total = 0;
          points.forEach((point) => {
            total += point.y || 0;
            html += `<br/><span style="color:${point.color}">●</span> ${point.series.name}: ${point.y}`;
          });
          html += `<br/><b>${t('pages:activity.peakConcurrent', { value: total })}</b>`;

          return html;
        },
      },
      series: [
        {
          type: 'area',
          name: t(PLAYBACK_DECISION_LABEL_KEYS.directplay),
          data: points((d) => d.direct),
          color: PLAYBACK_COLORS.directPlay,
        },
        {
          type: 'area',
          name: t(PLAYBACK_DECISION_LABEL_KEYS.copy),
          data: points((d) => d.directStream),
          color: PLAYBACK_COLORS.directStream,
        },
        {
          type: 'area',
          name: t(PLAYBACK_DECISION_LABEL_KEYS.audio_transcode),
          data: points((d) => d.audioTranscode),
          color: PLAYBACK_COLORS.audioTranscode,
        },
        {
          type: 'area',
          name: t(PLAYBACK_DECISION_LABEL_KEYS.transcode),
          data: points((d) => d.transcode - d.audioTranscode),
          color: PLAYBACK_COLORS.transcode,
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
    return <ChartEmpty height={height} message={t('pages:activity.noConcurrentData')} />;
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}
