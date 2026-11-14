import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { PLAYBACK_DECISION_LABEL_KEYS, type QualityStats } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { ChartEmpty } from './ChartEmpty';
import { PIE_SEGMENT_BORDER, PLAYBACK_COLORS } from './chartUtils';

interface QualityChartProps {
  data: QualityStats | undefined;
  isLoading?: boolean;
  height?: number;
}

export function QualityChart({ data, isLoading, height = 250 }: QualityChartProps) {
  const { t } = useTranslation(['common', 'pages']);
  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.total === 0) {
      return {};
    }

    return {
      chart: {
        type: 'pie',
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
      tooltip: {
        backgroundColor: 'oklch(var(--popover))',
        borderColor: 'oklch(var(--border))',
        style: {
          color: 'oklch(var(--popover-foreground))',
        },
        pointFormatter: function () {
          return t('pages:activity.playsShare', {
            count: this.y ?? 0,
            percent: (this.percentage ?? 0).toFixed(1),
          });
        },
      },
      plotOptions: {
        pie: {
          innerSize: '60%',
          ...PIE_SEGMENT_BORDER,
          dataLabels: {
            enabled: false,
          },
          showInLegend: true,
        },
      },
      legend: {
        align: 'right',
        verticalAlign: 'middle',
        layout: 'vertical',
        itemStyle: {
          color: 'oklch(var(--foreground))',
        },
        itemHoverStyle: {
          color: 'oklch(var(--primary))',
        },
      },
      series: [
        {
          type: 'pie',
          name: t('labels.quality'),
          data: [
            {
              name: t(PLAYBACK_DECISION_LABEL_KEYS.directplay),
              y: data.directPlay,
              color: PLAYBACK_COLORS.directPlay,
            },
            {
              name: t(PLAYBACK_DECISION_LABEL_KEYS.copy),
              y: data.directStream,
              color: PLAYBACK_COLORS.directStream,
            },
            {
              name: t(PLAYBACK_DECISION_LABEL_KEYS.audio_transcode),
              y: data.audioTranscode,
              color: PLAYBACK_COLORS.audioTranscode,
            },
            {
              name: t(PLAYBACK_DECISION_LABEL_KEYS.transcode),
              y: data.transcode - data.audioTranscode,
              color: PLAYBACK_COLORS.transcode,
            },
          ],
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
                layout: 'horizontal',
              },
            },
          },
        ],
      },
    };
  }, [data, height, t]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!data || data.total === 0) {
    return <ChartEmpty height={height} message={t('pages:activity.noQualityData')} />;
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}
