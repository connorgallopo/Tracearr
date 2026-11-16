import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { PieChart } from 'lucide-react';
import { PIE_SEGMENT_BORDER } from './chartUtils';

// Completion is ordered, so it sits on the sequential ramp with completed strongest.
const COMPLETION_COLORS = {
  completed: 'oklch(var(--seq-2))',
  inProgress: 'oklch(var(--seq-4))',
  notStarted: 'oklch(var(--seq-7))',
};

interface CompletionDonutChartProps {
  completed: number;
  inProgress: number;
  notStarted: number;
  isLoading?: boolean;
  height?: number;
}

export function CompletionDonutChart({
  completed,
  inProgress,
  notStarted,
  isLoading,
  height = 250,
}: CompletionDonutChartProps) {
  const { t } = useTranslation(['pages', 'common']);
  const chartData = useMemo(() => {
    return [
      { name: t('library.watch.completed'), y: completed, color: COMPLETION_COLORS.completed },
      {
        name: t('library.charts.completion.inProgress'),
        y: inProgress,
        color: COMPLETION_COLORS.inProgress,
      },
      {
        name: t('library.charts.completion.notStarted'),
        y: notStarted,
        color: COMPLETION_COLORS.notStarted,
      },
    ].filter((d) => d.y > 0);
  }, [completed, inProgress, notStarted, t]);

  const options = useMemo<Highcharts.Options>(() => {
    if (chartData.length === 0) {
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
          return t('library.charts.completion.tooltip', {
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
          name: t('common:labels.completion'),
          data: chartData,
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
  }, [chartData, height, t]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (chartData.length === 0) {
    return (
      <EmptyState
        icon={PieChart}
        title={t('library.charts.completion.empty.title')}
        description={t('library.charts.completion.empty.description')}
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
