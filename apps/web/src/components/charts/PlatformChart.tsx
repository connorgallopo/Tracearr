import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { ChartEmpty } from './ChartEmpty';
import { CATEGORICAL_COLORS, PIE_SEGMENT_BORDER } from './chartUtils';

interface PlatformData {
  name: string;
  count: number;
}

interface PlatformChartProps {
  data: PlatformData[] | undefined;
  isLoading?: boolean;
  height?: number;
}

export function PlatformChart({ data, isLoading, height = 200 }: PlatformChartProps) {
  const { t } = useTranslation(['common', 'pages']);
  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
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
          name: t('labels.platform'),
          data: data.map((d, i) => ({
            name: d.name,
            y: d.count,
            color: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length],
          })),
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

  if (!data || data.length === 0) {
    return <ChartEmpty height={height} message={t('pages:activity.noPlatformData')} />;
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}
