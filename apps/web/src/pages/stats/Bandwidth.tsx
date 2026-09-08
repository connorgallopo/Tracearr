import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Activity, Users, Gauge, Clock, HardDrive } from 'lucide-react';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatCard, formatWatchTime } from '@/components/ui/stat-card';
import {
  createDataTableColumnHelper,
  DataTableBody,
  DataTableEmpty,
  DataTableHeader,
  DataTableRoot,
  DataTableViewport,
  useDataTable,
} from '@/components/ui/data-table';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import { ChartSkeleton } from '@/components/ui/skeleton';
// Direct path, not the charts barrel: that pulls in highcharts-more, which fails to load under jsdom.
import { ChartEmpty } from '@/components/charts/ChartEmpty';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { InlineErrorState } from '@/components/library/ErrorState';
import { useBandwidthDaily, useBandwidthTopUsers, useBandwidthSummary } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useServerColorMap } from '@/hooks/useServerColorMap';
import { useTimeRange } from '@/hooks/useTimeRange';
import { getAvatarUrl } from '@/components/users/utils';
import { formatBytes } from '@/lib/formatters';
import { ServerColumnCell } from '@/components/server';
import type { BandwidthTopUser, DailyBandwidthRow, Server } from '@tracearr/shared';

const topUserColumn = createDataTableColumnHelper<BandwidthTopUser>();

const getTopUserId = (row: BandwidthTopUser) => `${row.serverId}-${row.serverUserId}`;

// The endpoint returns a fixed top ten, so the card shows every row and has no pager.
const TOP_USERS_PAGE_SIZE = 100;

interface BandwidthChartProps {
  data: DailyBandwidthRow[] | undefined;
  isLoading?: boolean;
  height?: number;
  period?: 'day' | 'week' | 'month' | 'year' | 'all' | 'custom';
  isMultiServer?: boolean;
  selectedServers?: Pick<Server, 'id' | 'name' | 'color'>[];
}

function BandwidthChart({
  data,
  isLoading,
  height = 300,
  period = 'month',
  isMultiServer = false,
  selectedServers = [],
}: BandwidthChartProps) {
  const { t } = useTranslation(['pages', 'common']);
  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

    // Derive a stable ordered list of unique dates for the category axis
    const dateSet = new Set(data.map((d) => d.date));
    const categories = [...dateSet].sort();

    const formatCategory = (categoryValue: string) => {
      const date = new Date(
        categoryValue.includes('T') ? categoryValue : categoryValue + 'T00:00:00'
      );
      if (isNaN(date.getTime())) return '';
      if (period === 'year') return date.toLocaleDateString(undefined, { month: 'short' });
      return `${date.getMonth() + 1}/${date.getDate()}`;
    };

    let bitrateSeriesArr: Highcharts.SeriesOptionsType[];

    if (isMultiServer) {
      // One stacked area per server, aligned to the shared category (date) axis
      bitrateSeriesArr = selectedServers.map((server) => {
        const serverRows = data.filter((r) => r.serverId === server.id);
        const rowByDate = new Map(serverRows.map((r) => [r.date, r]));
        return {
          type: 'area',
          name: server.name,
          color: server.color ?? undefined,
          stacking: 'normal',
          yAxis: 0,
          data: categories.map((date) => {
            const row = rowByDate.get(date);
            return row ? (row.avgBitrateMbps ?? row.avgBitrate) : null;
          }),
        };
      });
    } else {
      // Single-server: one area per the existing row order (one row per date)
      bitrateSeriesArr = [
        {
          type: 'area',
          name: t('statsBandwidth.avgBitrate'),
          data: categories.map((date) => {
            const row = data.find((d) => d.date === date);
            return row ? (row.avgBitrateMbps ?? row.avgBitrate) : null;
          }),
          yAxis: 0,
          color: 'hsl(var(--primary))',
          fillColor: {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, 'hsl(var(--primary) / 0.3)'],
              [1, 'hsl(var(--primary) / 0.05)'],
            ],
          },
        },
      ];
    }

    // Aggregate session count across all servers per date for the right axis
    const sessionsByDate = new Map<string, number>();
    for (const row of data) {
      sessionsByDate.set(row.date, (sessionsByDate.get(row.date) ?? 0) + row.sessions);
    }
    const sessionSeries: Highcharts.SeriesOptionsType = {
      type: 'column',
      name: t('common:labels.sessions'),
      data: categories.map((date) => sessionsByDate.get(date) ?? 0),
      yAxis: 1,
      color: 'hsl(var(--chart-2))',
      opacity: 0.6,
    };

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
        itemStyle: {
          color: 'hsl(var(--muted-foreground))',
        },
        itemHoverStyle: {
          color: 'hsl(var(--foreground))',
        },
      },
      xAxis: {
        categories,
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
          },
          formatter: function () {
            const cats = this.axis.categories;
            const categoryValue = typeof this.value === 'number' ? cats[this.value] : this.value;
            if (!categoryValue) return '';
            return formatCategory(categoryValue);
          },
          step: Math.ceil(categories.length / 12),
        },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
      },
      yAxis: [
        {
          title: {
            text: t('statsBandwidth.avgBitrateMbps'),
            style: {
              color: 'hsl(var(--primary))',
            },
          },
          labels: {
            style: {
              color: 'hsl(var(--muted-foreground))',
            },
          },
          gridLineColor: 'hsl(var(--border))',
          min: 0,
        },
        {
          title: {
            text: t('common:labels.sessions'),
            style: {
              color: 'hsl(var(--chart-2))',
            },
          },
          labels: {
            style: {
              color: 'hsl(var(--muted-foreground))',
            },
          },
          opposite: true,
          gridLineWidth: 0,
          min: 0,
        },
      ],
      plotOptions: {
        area: {
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
        column: {
          borderRadius: 4,
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const categoryValue = (this as any).points?.[0]?.point?.category as string | undefined;
          const date = categoryValue
            ? new Date(categoryValue.includes('T') ? categoryValue : categoryValue + 'T00:00:00')
            : null;
          const dateStr =
            date && !isNaN(date.getTime())
              ? date.toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })
              : t('common:labels.unknown');

          let html = `<b>${dateStr}</b><br/>`;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this as any).points?.forEach((point: any) => {
            const value =
              point.series.name === t('statsBandwidth.avgBitrate')
                ? `${point.y.toFixed(1)} Mbps`
                : point.y;
            html += `<span style="color:${point.color}">●</span> ${point.series.name}: <b>${value}</b><br/>`;
          });
          return html;
        },
      },
      series: [...bitrateSeriesArr, sessionSeries],
      responsive: {
        rules: [
          {
            condition: {
              maxWidth: 400,
            },
            chartOptions: {
              legend: {
                enabled: false,
              },
              yAxis: [
                {
                  title: {
                    text: undefined,
                  },
                },
                {
                  title: {
                    text: undefined,
                  },
                },
              ],
            },
          },
        ],
      },
    };
  }, [data, height, period, t, isMultiServer, selectedServers]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!data || data.length === 0) {
    return <ChartEmpty height={height} message={t('statsBandwidth.noData')} />;
  }

  return (
    <HighchartsReact
      highcharts={Highcharts}
      options={options}
      containerProps={{ style: { width: '100%', height: '100%' } }}
    />
  );
}

export function StatsBandwidth() {
  const { t } = useTranslation(['pages', 'common']);
  const { value: timeRange, setValue: setTimeRange, apiParams } = useTimeRange();
  const { selectedServerIds, selectedServers, isMultiServer } = useServer();
  const colorMap = useServerColorMap();

  const daily = useBandwidthDaily(apiParams, selectedServerIds);
  const topUsers = useBandwidthTopUsers(apiParams, selectedServerIds);
  const summary = useBandwidthSummary(apiParams, selectedServerIds);

  const summaryData = summary.data;

  // Map from server id to the minimal server shape needed for ServerColumnCell
  const serverById = useMemo(
    () => new Map(selectedServers.map((s) => [s.id, s])),
    [selectedServers]
  );

  // Resolve the first selected server id for avatar URL construction when single-server
  const primaryServerId = selectedServerIds[0] ?? null;

  const topUserColumns = useMemo(
    () =>
      topUserColumn.columns([
        // Row index rather than sort position, so a rank never moves when a header is clicked.
        topUserColumn.display({
          id: 'rank',
          header: t('common:labels.rank'),
          meta: { width: '3rem', cellClassName: 'text-muted-foreground font-medium' },
          cell: ({ row }) => row.index + 1,
        }),
        topUserColumn.display({
          id: 'user',
          header: t('common:labels.user'),
          cell: ({ row }) => {
            const user = row.original;
            const avatarServerId = isMultiServer ? user.serverId : primaryServerId;
            return (
              <Link
                to={`/users/${user.serverUserId}`}
                className="flex items-center gap-3 hover:underline"
              >
                <Avatar className="h-8 w-8">
                  <AvatarImage
                    src={getAvatarUrl(avatarServerId, user.thumbUrl, 32) ?? undefined}
                    alt={user.username}
                  />
                  <AvatarFallback>
                    {(user.identityName ?? user.username).slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="font-medium">{user.identityName ?? user.username}</span>
              </Link>
            );
          },
        }),
        ...(isMultiServer
          ? [
              topUserColumn.display({
                id: 'server',
                header: t('common:labels.server'),
                cell: ({ row }) => {
                  const server = serverById.get(row.original.serverId);
                  return server ? <ServerColumnCell server={server} /> : null;
                },
              }),
            ]
          : []),
        topUserColumn.display({
          id: 'sessions',
          header: t('common:labels.sessions'),
          meta: { numeric: true },
          cell: ({ row }) => row.original.sessions.toLocaleString(),
        }),
        topUserColumn.accessor('totalBytes', {
          header: t('common:labels.data'),
          sortDescFirst: false,
          meta: { numeric: true },
          cell: ({ getValue }) => formatBytes(getValue()),
        }),
        topUserColumn.display({
          id: 'watchTime',
          header: t('common:labels.watchTime'),
          meta: { numeric: true },
          cell: ({ row }) => `${row.original.totalHours.toFixed(1)}h`,
        }),
        topUserColumn.display({
          id: 'avgBitrate',
          header: t('statsBandwidth.avgBitrate'),
          meta: { numeric: true },
          cell: ({ row }) => (
            <Badge variant="outline">{row.original.avgBitrateMbps.toFixed(1)} Mbps</Badge>
          ),
        }),
      ]),
    [t, isMultiServer, primaryServerId, serverById]
  );

  const { table: topUsersTable } = useDataTable<BandwidthTopUser>({
    columns: topUserColumns,
    data: topUsers.data?.data,
    getRowId: getTopUserId,
    pageSize: TOP_USERS_PAGE_SIZE,
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('statsBandwidth.title')}</h1>
          <p className="text-muted-foreground text-sm">{t('statsBandwidth.description')}</p>
        </div>
        <TimeRangePicker value={timeRange} onChange={setTimeRange} />
      </div>

      {/* Summary Cards */}
      {summary.isError ? (
        <InlineErrorState
          message={summary.error?.message ?? t('common:errors.unexpectedError')}
          onRetry={() => void summary.refetch()}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          <StatCard
            icon={Activity}
            label={t('common:labels.totalSessions')}
            value={summaryData?.totalSessions.toLocaleString() ?? 0}
            isLoading={summary.isLoading}
          />
          <StatCard
            icon={HardDrive}
            label={t('statsBandwidth.dataTransferred')}
            value={formatBytes(summaryData?.totalBytes ?? 0)}
            isLoading={summary.isLoading}
          />
          <StatCard
            icon={Gauge}
            label={t('statsBandwidth.avgBitrate')}
            value={`${summaryData?.avgBitrateMbps.toFixed(1) ?? 0} Mbps`}
            subValue={t('statsBandwidth.peakBitrate', {
              value: summaryData?.peakBitrateMbps.toFixed(1) ?? 0,
            })}
            isLoading={summary.isLoading}
          />
          <StatCard
            icon={Clock}
            label={t('statsBandwidth.totalWatchTime')}
            value={formatWatchTime(summaryData?.totalDurationMs ?? 0)}
            isLoading={summary.isLoading}
          />
          <StatCard
            icon={Users}
            label={t('statsBandwidth.uniqueUsers')}
            value={summaryData?.uniqueUsers ?? 0}
            isLoading={summary.isLoading}
          />
        </div>
      )}

      {/* Bandwidth Chart */}
      <Card>
        <CardHeader>
          <CardTitle>{t('statsBandwidth.dailyUsage')}</CardTitle>
          <CardDescription>{t('statsBandwidth.dailyUsageDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {daily.isError ? (
            <InlineErrorState
              message={daily.error?.message ?? t('common:errors.unexpectedError')}
              onRetry={() => void daily.refetch()}
            />
          ) : (
            <BandwidthChart
              data={daily.data?.data}
              isLoading={daily.isLoading}
              height={300}
              period={timeRange.period}
              isMultiServer={isMultiServer}
              selectedServers={selectedServers}
            />
          )}
        </CardContent>
      </Card>

      {/* Top Users Table */}
      <Card>
        <CardHeader>
          <CardTitle>{t('statsBandwidth.topUsers')}</CardTitle>
          <CardDescription>{t('statsBandwidth.topUsersDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {topUsers.isError ? (
            <InlineErrorState
              message={topUsers.error?.message ?? t('common:errors.unexpectedError')}
              onRetry={() => void topUsers.refetch()}
            />
          ) : (
            <DataTableRoot density="default">
              <DataTableViewport flush>
                <DataTableHeader table={topUsersTable} />
                <DataTableBody
                  table={topUsersTable}
                  isLoading={topUsers.isLoading}
                  loadingLabel={t('common:states.loading')}
                  getRowStyle={(user) => {
                    const serverColor = isMultiServer ? colorMap.get(user.serverId) : undefined;
                    return serverColor
                      ? { boxShadow: `inset 3px 0 0 0 ${serverColor}` }
                      : undefined;
                  }}
                  empty={
                    <DataTableEmpty
                      table={topUsersTable}
                      icon={Users}
                      title={t('common:empty.noUserData')}
                    />
                  }
                />
              </DataTableViewport>
            </DataTableRoot>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
