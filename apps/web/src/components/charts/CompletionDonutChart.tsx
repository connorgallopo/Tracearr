import { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/library';
import { PieChart } from 'lucide-react';

// Colorblind-friendly completion status colors
const COMPLETION_COLORS = {
  completed: 'hsl(142, 76%, 36%)', // Green - success
  inProgress: 'hsl(38, 92%, 50%)', // Orange - in progress
  notStarted: 'hsl(var(--muted))', // Muted - not started
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
  const chartData = useMemo(() => {
    return [
      { name: 'Completed', y: completed, color: COMPLETION_COLORS.completed },
      { name: 'In Progress', y: inProgress, color: COMPLETION_COLORS.inProgress },
      { name: 'Not Started', y: notStarted, color: COMPLETION_COLORS.notStarted },
    ].filter((d) => d.y > 0);
  }, [completed, inProgress, notStarted]);

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
        backgroundColor: 'hsl(var(--popover))',
        borderColor: 'hsl(var(--border))',
        style: {
          color: 'hsl(var(--popover-foreground))',
        },
        pointFormat: '<b>{point.y}</b> items ({point.percentage:.1f}%)',
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
          name: 'Completion',
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
                itemStyle: {
                  fontSize: '10px',
                },
              },
            },
          },
        ],
      },
    };
  }, [chartData, height]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (chartData.length === 0) {
    return (
      <EmptyState
        icon={PieChart}
        title="No completion data"
        description="Completion breakdown will appear here once watch data is available"
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
