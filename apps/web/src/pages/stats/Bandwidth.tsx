import { useMemo } from 'react';
import { Link } from 'react-router';
import { Activity, Users, Gauge, Clock, HardDrive } from 'lucide-react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatCard, formatWatchTime } from '@/components/ui/stat-card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import { Skeleton, ChartSkeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useBandwidthDaily, useBandwidthTopUsers, useBandwidthSummary } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';
import type { DailyBandwidthRow } from '@tracearr/shared';

// Format bytes for display
function formatBytes(bytes: number): string {
  if (bytes >= 1_099_511_627_776) {
    return `${(bytes / 1_099_511_627_776).toFixed(2)} TB`;
  }
  if (bytes >= 1_073_741_824) {
    return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  }
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }
  return `${(bytes / 1024).toFixed(0)} KB`;
}

interface BandwidthChartProps {
  data: DailyBandwidthRow[] | undefined;
  isLoading?: boolean;
  height?: number;
  period?: 'day' | 'week' | 'month' | 'year' | 'all' | 'custom';
}

function BandwidthChart({ data, isLoading, height = 300, period = 'month' }: BandwidthChartProps) {
  const options = useMemo<Highcharts.Options>(() => {
    if (!data || data.length === 0) {
      return {};
    }

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
        categories: data.map((d) => d.date),
        labels: {
          style: {
            color: 'hsl(var(--muted-foreground))',
          },
          formatter: function () {
            const categories = this.axis.categories;
            const categoryValue =
              typeof this.value === 'number' ? categories[this.value] : this.value;
            if (!categoryValue) return '';
            const date = new Date(
              categoryValue.includes('T') ? categoryValue : categoryValue + 'T00:00:00'
            );
            if (isNaN(date.getTime())) return '';
            if (period === 'year') {
              return date.toLocaleDateString('en-US', { month: 'short' });
            }
            return `${date.getMonth() + 1}/${date.getDate()}`;
          },
          step: Math.ceil(data.length / 12),
        },
        lineColor: 'hsl(var(--border))',
        tickColor: 'hsl(var(--border))',
      },
      yAxis: [
        {
          title: {
            text: 'Avg Bitrate (Mbps)',
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
            text: 'Sessions',
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
          fillColor: {
            linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
            stops: [
              [0, 'hsl(var(--primary) / 0.3)'],
              [1, 'hsl(var(--primary) / 0.05)'],
            ],
          },
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
              ? date.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })
              : 'Unknown';

          let html = `<b>${dateStr}</b><br/>`;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (this as any).points?.forEach((point: any) => {
            const value =
              point.series.name === 'Avg Bitrate' ? `${point.y.toFixed(1)} Mbps` : point.y;
            html += `<span style="color:${point.color}">\u25CF</span> ${point.series.name}: <b>${value}</b><br/>`;
          });
          return html;
        },
      },
      series: [
        {
          type: 'area',
          name: 'Avg Bitrate',
          data: data.map((d) => d.avgBitrateMbps),
          yAxis: 0,
          color: 'hsl(var(--primary))',
        },
        {
          type: 'column',
          name: 'Sessions',
          data: data.map((d) => d.sessions),
          yAxis: 1,
          color: 'hsl(var(--chart-2))',
          opacity: 0.6,
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
  }, [data, height, period]);

  if (isLoading) {
    return <ChartSkeleton height={height} />;
  }

  if (!data || data.length === 0) {
    return (
      <div
        className="text-muted-foreground flex items-center justify-center rounded-lg border border-dashed"
        style={{ height }}
      >
        No bandwidth data available
      </div>
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

export function StatsBandwidth() {
  const { value: timeRange, setValue: setTimeRange, apiParams } = useTimeRange();
  const { selectedServerId } = useServer();

  const daily = useBandwidthDaily(apiParams, selectedServerId);
  const topUsers = useBandwidthTopUsers(apiParams, selectedServerId);
  const summary = useBandwidthSummary(apiParams, selectedServerId);

  const summaryData = summary.data;
  const users = topUsers.data?.data ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Bandwidth</h1>
          <p className="text-muted-foreground text-sm">
            Streaming bandwidth usage and bitrate analysis
          </p>
        </div>
        <TimeRangePicker value={timeRange} onChange={setTimeRange} />
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <StatCard
          icon={Activity}
          label="Total Sessions"
          value={summaryData?.totalSessions.toLocaleString() ?? 0}
          isLoading={summary.isLoading}
        />
        <StatCard
          icon={HardDrive}
          label="Data Transferred"
          value={formatBytes(summaryData?.totalBytes ?? 0)}
          isLoading={summary.isLoading}
        />
        <StatCard
          icon={Gauge}
          label="Avg Bitrate"
          value={`${summaryData?.avgBitrateMbps.toFixed(1) ?? 0} Mbps`}
          subValue={`Peak: ${summaryData?.peakBitrateMbps.toFixed(1) ?? 0} Mbps`}
          isLoading={summary.isLoading}
        />
        <StatCard
          icon={Clock}
          label="Total Watch Time"
          value={formatWatchTime(summaryData?.totalDurationMs ?? 0)}
          isLoading={summary.isLoading}
        />
        <StatCard
          icon={Users}
          label="Unique Users"
          value={summaryData?.uniqueUsers ?? 0}
          isLoading={summary.isLoading}
        />
      </div>

      {/* Bandwidth Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Daily Bandwidth Usage</CardTitle>
          <CardDescription>Average bitrate and session count over time</CardDescription>
        </CardHeader>
        <CardContent>
          <BandwidthChart
            data={daily.data?.data}
            isLoading={daily.isLoading}
            height={300}
            period={timeRange.period}
          />
        </CardContent>
      </Card>

      {/* Top Users Table */}
      <Card>
        <CardHeader>
          <CardTitle>Top Bandwidth Users</CardTitle>
          <CardDescription>Users consuming the most bandwidth</CardDescription>
        </CardHeader>
        <CardContent>
          {topUsers.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : users.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                  <TableHead className="text-right">Data</TableHead>
                  <TableHead className="text-right">Watch Time</TableHead>
                  <TableHead className="text-right">Avg Bitrate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user, idx) => (
                  <TableRow key={user.serverUserId}>
                    <TableCell className="text-muted-foreground font-medium">{idx + 1}</TableCell>
                    <TableCell>
                      <Link
                        to={`/users/${user.serverUserId}`}
                        className="flex items-center gap-3 hover:underline"
                      >
                        <Avatar className="h-8 w-8">
                          <AvatarImage src={user.thumbUrl ?? undefined} alt={user.username} />
                          <AvatarFallback>
                            {(user.identityName ?? user.username).slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="font-medium">{user.identityName ?? user.username}</span>
                      </Link>
                    </TableCell>
                    <TableCell className="text-right">{user.sessions.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{formatBytes(user.totalBytes)}</TableCell>
                    <TableCell className="text-right">{user.totalHours.toFixed(1)}h</TableCell>
                    <TableCell className="text-right">
                      <Badge variant="outline">{user.avgBitrateMbps.toFixed(1)} Mbps</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="rounded-xl border border-dashed p-8 text-center">
              <Users className="text-muted-foreground/50 mx-auto h-12 w-12" />
              <p className="text-muted-foreground mt-2">No user data available</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
