import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Film, Tv, PieChart, type LucideIcon } from 'lucide-react';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import {
  RESOLUTION_LABELS,
  resolutionBucket,
  type LibraryResolutionResponse,
  type ResolutionBreakdown,
  type Server,
} from '@tracearr/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { PerServerCardGrid } from '@/components/server';
import { useLibraryResolution } from '@/hooks/queries';
import { RESOLUTION_COLORS } from '@/lib/resolutionColors';
import { browseHref } from '@/lib/browseLinks';

interface ResolutionDistributionSectionProps {
  serverId?: string | null;
  selectedServers?: Server[];
  isMultiServer?: boolean;
}

interface ResolutionDonutProps {
  data: ResolutionBreakdown | undefined;
  isLoading?: boolean;
  height?: number;
  title: string;
  /** A bar click opens Browse filtered to that resolution for this type and server. */
  browseType: 'movie' | 'show';
  serverId?: string | null;
}

function ResolutionDonut({
  data,
  isLoading,
  height = 220,
  title,
  browseType,
  serverId,
}: ResolutionDonutProps) {
  const { t } = useTranslation(['pages', 'common']);
  const navigate = useNavigate();
  const chartData = useMemo(() => {
    if (!data) return [];
    return RESOLUTION_LABELS.map((label) => ({
      name: label,
      y: data.counts[resolutionBucket(label) ?? 'sd'],
      color: RESOLUTION_COLORS[label],
    })).filter((d) => d.y > 0);
  }, [data]);

  const options = useMemo<Highcharts.Options>(() => {
    if (chartData.length === 0) {
      return {};
    }

    // Bars, not a donut: tiers overlap (a 4K+1080p title counts in both), so
    // slices would claim a part-to-whole relationship the data does not have.
    // Percentages are share-of-titles-having, against the real title count.
    const total = data?.total ?? 0;
    return {
      chart: {
        type: 'bar',
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
        formatter: function () {
          const pct = total > 0 ? (((this.y ?? 0) / total) * 100).toFixed(1) : '0';
          return t('library.quality.resolution.tooltip', {
            name: this.key,
            value: this.y ?? 0,
            total,
            percent: pct,
          });
        },
      },
      xAxis: {
        type: 'category',
        labels: {
          style: {
            color: 'oklch(var(--foreground))',
            fontSize: '12px',
          },
        },
        lineColor: 'oklch(var(--border))',
        tickLength: 0,
      },
      yAxis: {
        title: { text: undefined },
        labels: {
          style: {
            color: 'oklch(var(--muted-foreground))',
            fontSize: '12px',
          },
        },
        gridLineColor: 'oklch(var(--border))',
        min: 0,
      },
      plotOptions: {
        bar: {
          borderWidth: 0,
          borderRadius: 3,
          colorByPoint: true,
          cursor: 'pointer',
          point: {
            events: {
              click: function () {
                void navigate(browseHref(browseType, { resolution: this.name, serverId }));
              },
            },
          },
          dataLabels: {
            enabled: true,
            style: {
              color: 'oklch(var(--muted-foreground))',
              fontSize: '12px',
              textOutline: 'none',
            },
          },
        },
      },
      legend: {
        enabled: false,
      },
      series: [
        {
          type: 'bar',
          name: t('common:labels.quality'),
          data: chartData,
        },
      ],
    };
  }, [chartData, data, height, navigate, browseType, serverId, t]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (chartData.length === 0) {
    return (
      <EmptyState
        icon={PieChart}
        title={t('common:empty.noData')}
        description={t('library.quality.resolution.empty', { type: title.toLowerCase() })}
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

const RESOLUTION_KINDS = [
  { key: 'movies', icon: Film, labelKey: 'common:media.movie_plural', browseType: 'movie' },
  { key: 'tv', icon: Tv, labelKey: 'common:media.tvShows', browseType: 'show' },
] as const satisfies readonly {
  key: keyof LibraryResolutionResponse;
  icon: LucideIcon;
  labelKey: string;
  browseType: 'movie' | 'show';
}[];

function ItemCount({ total }: { total: number | undefined }) {
  const { t } = useTranslation('pages');
  if (total === undefined) return null;
  return (
    <span className="text-muted-foreground text-sm">
      {t('library.quality.resolution.itemCount', { count: total })}
    </span>
  );
}

/** Per-server resolution content rendered inside PerServerCardGrid (no outer Card). */
function ServerResolutionCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation(['pages', 'common']);
  const resolution = useLibraryResolution(serverId);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {RESOLUTION_KINDS.map(({ key, icon: Icon, labelKey, browseType }) => (
        <div key={key}>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Icon className="text-muted-foreground h-4 w-4" />
              <h4 className="text-sm font-medium">{t(labelKey)}</h4>
            </div>
            <ItemCount total={resolution.data?.[key]?.total} />
          </div>
          <ResolutionDonut
            data={resolution.data?.[key]}
            isLoading={resolution.isLoading}
            title={t(labelKey)}
            browseType={browseType}
            serverId={serverId}
          />
        </div>
      ))}
    </div>
  );
}

/** Single-server layout - two side-by-side cards as the original design. */
function SingleServerResolutionSection({ serverId }: { serverId?: string | null }) {
  const { t } = useTranslation(['pages', 'common']);
  const resolution = useLibraryResolution(serverId);

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {RESOLUTION_KINDS.map(({ key, icon: Icon, labelKey, browseType }) => (
        <Card key={key}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icon className="text-muted-foreground h-4 w-4" />
                <CardTitle className="text-base font-medium">{t(labelKey)}</CardTitle>
              </div>
              <ItemCount total={resolution.data?.[key]?.total} />
            </div>
          </CardHeader>
          <CardContent>
            <ResolutionDonut
              data={resolution.data?.[key]}
              isLoading={resolution.isLoading}
              title={t(labelKey)}
              browseType={browseType}
              serverId={serverId}
            />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * Resolution Distribution Section
 *
 * Single-server: two side-by-side cards (Movies + TV) as today.
 * Multi-server: one PerServerCardGrid card per server, each containing Movies + TV donuts.
 */
export function ResolutionDistributionSection({
  serverId,
  selectedServers,
  isMultiServer,
}: ResolutionDistributionSectionProps) {
  if (isMultiServer && selectedServers && selectedServers.length > 0) {
    return (
      <PerServerCardGrid
        servers={selectedServers}
        renderServer={(server) => <ServerResolutionCard serverId={server.id} />}
      />
    );
  }

  return <SingleServerResolutionSection serverId={serverId} />;
}
