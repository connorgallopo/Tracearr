import { useMemo } from 'react';
import { Film, Tv, PieChart } from 'lucide-react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/library';
import { useLibraryResolution } from '@/hooks/queries';
import type { ResolutionBreakdown } from '@tracearr/shared';

interface ResolutionDistributionSectionProps {
  serverId?: string | null;
}

// Colorblind-friendly, distinct colors for each quality tier
const QUALITY_COLORS = {
  '4K': 'hsl(262, 83%, 58%)', // Purple - highest quality stands out
  '1080p': 'hsl(221, 83%, 53%)', // Blue
  '720p': 'hsl(142, 76%, 36%)', // Green
  SD: 'hsl(38, 92%, 50%)', // Orange - lowest quality warning
};

interface ResolutionDonutProps {
  data: ResolutionBreakdown | undefined;
  isLoading?: boolean;
  height?: number;
  title: string;
  icon?: React.ReactNode;
  showHeader?: boolean;
}

function ResolutionDonut({
  data,
  isLoading,
  height = 220,
  title,
  icon,
  showHeader = true,
}: ResolutionDonutProps) {
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
          fontSize: '11px',
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
              maxWidth: 300,
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
    return (
      <div>
        {showHeader && (
          <div className="mb-2 flex items-center gap-2">
            {icon}
            <h4 className="text-sm font-medium">{title}</h4>
          </div>
        )}
        <ChartSkeleton height={height} />
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div>
        {showHeader && (
          <div className="mb-2 flex items-center gap-2">
            {icon}
            <h4 className="text-sm font-medium">{title}</h4>
          </div>
        )}
        <EmptyState
          icon={PieChart}
          title="No data"
          description={`No ${title.toLowerCase()} quality data available`}
        />
      </div>
    );
  }

  return (
    <div>
      {showHeader && (
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {icon}
            <h4 className="text-sm font-medium">{title}</h4>
          </div>
          <span className="text-muted-foreground text-sm">
            {data?.total.toLocaleString()} items
          </span>
        </div>
      )}
      <HighchartsReact
        highcharts={Highcharts}
        options={options}
        containerProps={{ style: { width: '100%', height: '100%' } }}
      />
    </div>
  );
}

/**
 * Resolution Distribution Section
 *
 * Displays resolution breakdowns (4K, 1080p, 720p, SD) for Movies vs TV Shows
 * using two side-by-side cards with donut charts.
 */
export function ResolutionDistributionSection({ serverId }: ResolutionDistributionSectionProps) {
  const resolution = useLibraryResolution(serverId);

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Film className="text-muted-foreground h-4 w-4" />
              <CardTitle className="text-base font-medium">Movies</CardTitle>
            </div>
            {resolution.data?.movies?.total !== undefined && (
              <span className="text-muted-foreground text-sm">
                {resolution.data.movies.total.toLocaleString()} items
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ResolutionDonut
            data={resolution.data?.movies}
            isLoading={resolution.isLoading}
            title="Movies"
            icon={null}
            showHeader={false}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Tv className="text-muted-foreground h-4 w-4" />
              <CardTitle className="text-base font-medium">TV Shows</CardTitle>
            </div>
            {resolution.data?.tv?.total !== undefined && (
              <span className="text-muted-foreground text-sm">
                {resolution.data.tv.total.toLocaleString()} items
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ResolutionDonut
            data={resolution.data?.tv}
            isLoading={resolution.isLoading}
            title="TV Shows"
            icon={null}
            showHeader={false}
          />
        </CardContent>
      </Card>
    </div>
  );
}
