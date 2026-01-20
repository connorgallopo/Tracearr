import { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/library';
import { PieChart } from 'lucide-react';

// Colorblind-friendly, distinct colors for each quality tier
const QUALITY_COLORS = {
  '4K': 'hsl(262, 83%, 58%)', // Purple - highest quality stands out
  '1080p': 'hsl(221, 83%, 53%)', // Blue
  '720p': 'hsl(142, 76%, 36%)', // Green
  SD: 'hsl(38, 92%, 50%)', // Orange - lowest quality warning
};

interface QualityBreakdown {
  count4k: number;
  count1080p: number;
  count720p: number;
  countSd: number;
}

interface QualityDonutChartProps {
  data: QualityBreakdown | undefined;
  isLoading?: boolean;
  height?: number;
}

export function QualityDonutChart({ data, isLoading, height = 250 }: QualityDonutChartProps) {
  const chartData = useMemo(() => {
    if (!data) return [];
    return [
      { name: '4K', y: data.count4k, color: QUALITY_COLORS['4K'] },
      { name: '1080p', y: data.count1080p, color: QUALITY_COLORS['1080p'] },
      { name: '720p', y: data.count720p, color: QUALITY_COLORS['720p'] },
      { name: 'SD', y: data.countSd, color: QUALITY_COLORS['SD'] },
    ].filter((d) => d.y > 0);
  }, [data]);

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
          name: 'Quality',
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
        title="No quality data"
        description="Quality breakdown will appear here once available"
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
