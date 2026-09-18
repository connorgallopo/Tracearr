import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { PLAYBACK_DECISION_LABEL_KEYS } from '@tracearr/shared';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { ChartEmpty } from './ChartEmpty';

interface QualityData {
  directPlay: number;
  directStream: number;
  transcode: number;
  total: number;
  directPlayPercent: number;
  directStreamPercent: number;
  transcodePercent: number;
}

interface QualityChartProps {
  data: QualityData | undefined;
  isLoading?: boolean;
  height?: number;
}

const COLORS = {
  directPlay: 'hsl(142, 76%, 36%)', // Green
  directStream: 'hsl(210, 76%, 50%)', // Blue
  transcode: 'hsl(38, 92%, 50%)', // Orange
};

export function QualityChart({ data, isLoading, height = 250 }: QualityChartProps) {
  const { t } = useTranslation();
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
        backgroundColor: 'hsl(var(--popover))',
        borderColor: 'hsl(var(--border))',
        style: {
          color: 'hsl(var(--popover-foreground))',
        },
        pointFormat: '<b>{point.y}</b> plays ({point.percentage:.1f}%)',
      },
      plotOptions: {
        pie: {
          innerSize: '60%',
          borderWidth: 0,
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
          color: 'hsl(var(--foreground))',
        },
        itemHoverStyle: {
          color: 'hsl(var(--primary))',
        },
      },
      series: [
        {
          type: 'pie',
          name: 'Quality',
          data: [
            {
              name: t(PLAYBACK_DECISION_LABEL_KEYS.directplay),
              y: data.directPlay,
              color: COLORS.directPlay,
            },
            {
              name: t(PLAYBACK_DECISION_LABEL_KEYS.copy),
              y: data.directStream,
              color: COLORS.directStream,
            },
            {
              name: t(PLAYBACK_DECISION_LABEL_KEYS.transcode),
              y: data.transcode,
              color: COLORS.transcode,
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
                itemStyle: {
                  fontSize: '10px',
                },
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
    return <ChartEmpty height={height} message="No quality data available" />;
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}
