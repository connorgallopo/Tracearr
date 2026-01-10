import { Smartphone, Monitor, CheckCircle2, ArrowRightLeft, Users } from 'lucide-react';
import { Link } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  useDeviceCompatibility,
  useDeviceCompatibilityMatrix,
  useDeviceHealth,
  useTranscodeHotspots,
  useTopTranscodingUsers,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';
import { cn } from '@/lib/utils';

// Color coding for direct play percentage
function getDirectPlayColor(pct: number): string {
  if (pct >= 80) return 'text-green-600 dark:text-green-400';
  if (pct >= 50) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
}

function getDirectPlayBg(pct: number): string {
  if (pct >= 80) return 'bg-green-500/10';
  if (pct >= 50) return 'bg-yellow-500/10';
  return 'bg-red-500/10';
}

function getProgressColor(pct: number): string {
  if (pct >= 80) return 'bg-green-500';
  if (pct >= 50) return 'bg-yellow-500';
  return 'bg-red-500';
}

function getProgressTextColor(pct: number): string {
  if (pct >= 80) return 'text-green-600 dark:text-green-400';
  if (pct >= 50) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
}

export function StatsDevices() {
  const { value: timeRange, setValue: setTimeRange, apiParams } = useTimeRange();
  const { selectedServerId } = useServer();

  const compatibility = useDeviceCompatibility(apiParams, selectedServerId);
  const matrix = useDeviceCompatibilityMatrix(apiParams, selectedServerId);
  const deviceHealth = useDeviceHealth(apiParams, selectedServerId);
  const hotspots = useTranscodeHotspots(apiParams, selectedServerId);
  const topTranscodingUsers = useTopTranscodingUsers(apiParams, selectedServerId);

  const summary = compatibility.data?.summary;

  // Sort matrix devices by total sessions (descending)
  const sortedMatrixDevices = matrix.data?.devices
    ? [...matrix.data.devices].sort((a, b) => {
        const aSessions = Object.values(a.codecs).reduce((sum, c) => sum + c.sessions, 0);
        const bSessions = Object.values(b.codecs).reduce((sum, c) => sum + c.sessions, 0);
        return bSessions - aSessions;
      })
    : [];

  // Only show codecs that have data in at least one device
  const activeCodecs =
    matrix.data?.codecs.filter((codec) =>
      sortedMatrixDevices.some((device) => device.codecs[codec])
    ) ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Device Compatibility</h1>
          <p className="text-muted-foreground text-sm">
            See which devices direct play vs transcode each codec
          </p>
        </div>
        <TimeRangePicker value={timeRange} onChange={setTimeRange} />
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard
          icon={Smartphone}
          label="Total Sessions"
          value={summary?.totalSessions.toLocaleString() ?? 0}
          isLoading={compatibility.isLoading}
        />
        <StatCard
          icon={CheckCircle2}
          label="Direct Play Rate"
          value={`${summary?.directPlayPct ?? 0}%`}
          subValue="Video + audio"
          isLoading={compatibility.isLoading}
        />
        <StatCard
          icon={Monitor}
          label="Unique Devices"
          value={summary?.uniqueDevices ?? 0}
          isLoading={compatibility.isLoading}
        />
        <StatCard
          icon={ArrowRightLeft}
          label="Unique Codecs"
          value={summary?.uniqueCodecs ?? 0}
          isLoading={compatibility.isLoading}
        />
      </div>

      {/* Device Health + Transcode Hotspots */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Device Health Rankings */}
        <Card>
          <CardHeader>
            <CardTitle>Device Health</CardTitle>
            <CardDescription>Direct play rate by device type</CardDescription>
          </CardHeader>
          <CardContent>
            {deviceHealth.isLoading ? (
              <div className="space-y-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : deviceHealth.data && deviceHealth.data.data.length > 0 ? (
              <div className="space-y-4">
                {deviceHealth.data.data.slice(0, 8).map((device) => (
                  <div key={device.device} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="max-w-[150px] truncate font-medium" title={device.device}>
                        {device.device}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground text-xs">
                          {device.sessions.toLocaleString()} sessions
                        </span>
                        <span
                          className={cn(
                            'font-semibold',
                            getProgressTextColor(device.directPlayPct)
                          )}
                        >
                          {device.directPlayPct}%
                        </span>
                      </div>
                    </div>
                    <div className="bg-muted relative h-2 w-full overflow-hidden rounded-full">
                      <div
                        className={cn(
                          'absolute inset-y-0 left-0 rounded-full',
                          getProgressColor(device.directPlayPct)
                        )}
                        style={{ width: `${device.directPlayPct}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed p-8 text-center">
                <Monitor className="text-muted-foreground/50 mx-auto h-12 w-12" />
                <p className="text-muted-foreground mt-2">No device data available</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Transcode Hotspots */}
        <Card>
          <CardHeader>
            <CardTitle>Transcode Hotspots</CardTitle>
            <CardDescription>Combinations causing the most transcodes</CardDescription>
          </CardHeader>
          <CardContent>
            {hotspots.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : hotspots.data && hotspots.data.data.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Device + Codec</TableHead>
                    <TableHead className="text-right">Transcodes</TableHead>
                    <TableHead className="text-right">% of Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {hotspots.data.data.slice(0, 5).map((hotspot, idx) => (
                    <TableRow
                      key={`${hotspot.device}-${hotspot.videoCodec}-${hotspot.audioCodec}-${idx}`}
                    >
                      <TableCell>
                        <div className="font-medium">{hotspot.device}</div>
                        <div className="text-muted-foreground text-xs">
                          {hotspot.videoCodec.toUpperCase()} + {hotspot.audioCodec.toUpperCase()}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {hotspot.transcodeCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant="destructive"
                          className="border-orange-500/30 bg-orange-500/20 text-orange-600 dark:text-orange-400"
                        >
                          {hotspot.pctOfTotalTranscodes}%
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="rounded-xl border border-dashed p-8 text-center">
                <CheckCircle2 className="mx-auto h-12 w-12 text-green-500/50" />
                <p className="text-muted-foreground mt-2">No transcode hotspots</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Matrix View */}
      <Card>
        <CardHeader>
          <CardTitle>Compatibility Matrix</CardTitle>
          <CardDescription>
            Direct play rates by device and video codec. Sorted by session volume.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {matrix.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : matrix.data && sortedMatrixDevices.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="bg-background sticky left-0 z-10">Device</TableHead>
                  {activeCodecs.map((codec) => (
                    <TableHead key={codec} className="min-w-[80px] text-center">
                      {codec.toUpperCase()}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedMatrixDevices.map((device) => {
                  const totalSessions = Object.values(device.codecs).reduce(
                    (sum, c) => sum + c.sessions,
                    0
                  );
                  return (
                    <TableRow key={device.device} className="hover:bg-transparent">
                      <TableCell className="bg-background sticky left-0 z-10 font-medium">
                        <div>{device.device}</div>
                        <div className="text-muted-foreground text-xs">
                          {totalSessions.toLocaleString()} sessions
                        </div>
                      </TableCell>
                      {activeCodecs.map((codec) => {
                        const cell = device.codecs[codec];
                        if (!cell) {
                          return (
                            <TableCell key={codec} className="text-center">
                              <span className="text-muted-foreground/50">-</span>
                            </TableCell>
                          );
                        }
                        return (
                          <TableCell
                            key={codec}
                            className={cn('text-center', getDirectPlayBg(cell.directPct))}
                          >
                            <div className={cn('font-medium', getDirectPlayColor(cell.directPct))}>
                              {cell.directPct}%
                            </div>
                            <div className="text-muted-foreground text-xs">{cell.sessions}</div>
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="rounded-xl border border-dashed p-8 text-center">
              <Monitor className="text-muted-foreground/50 mx-auto h-12 w-12" />
              <p className="text-muted-foreground mt-2">No device data in this period</p>
            </div>
          )}

          {/* Legend */}
          <div className="mt-4 flex items-center gap-4 text-sm">
            <span className="text-muted-foreground">Legend:</span>
            <Badge
              variant="outline"
              className="border-transparent bg-green-500/20 text-green-600 dark:text-green-400"
            >
              &ge;80% Direct
            </Badge>
            <Badge
              variant="outline"
              className="border-transparent bg-yellow-500/20 text-yellow-600 dark:text-yellow-400"
            >
              50-79%
            </Badge>
            <Badge
              variant="outline"
              className="border-transparent bg-red-500/20 text-red-600 dark:text-red-400"
            >
              &lt;50%
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Top Transcoding Users */}
      <Card>
        <CardHeader>
          <CardTitle>Top Transcoding Users</CardTitle>
          <CardDescription>Users causing the most transcodes on your server</CardDescription>
        </CardHeader>
        <CardContent>
          {topTranscodingUsers.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : topTranscodingUsers.data && topTranscodingUsers.data.data.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                  <TableHead className="text-right">Direct Play</TableHead>
                  <TableHead className="text-right">Transcodes</TableHead>
                  <TableHead className="text-right">% of Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topTranscodingUsers.data.data.map((user) => (
                  <TableRow key={user.serverUserId}>
                    <TableCell>
                      <Link
                        to={`/users/${user.serverUserId}`}
                        className="flex items-center gap-3 hover:underline"
                      >
                        <Avatar className="h-8 w-8">
                          <AvatarImage src={user.avatar ?? undefined} alt={user.username} />
                          <AvatarFallback>
                            {(user.identityName ?? user.username).slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span className="font-medium">{user.identityName ?? user.username}</span>
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right">
                      {user.totalSessions.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant="outline"
                        className={cn(
                          'border-transparent',
                          user.directPlayPct >= 80
                            ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                            : user.directPlayPct >= 50
                              ? 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400'
                              : 'bg-red-500/20 text-red-600 dark:text-red-400'
                        )}
                      >
                        {user.directPlayPct}%
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-orange-600 dark:text-orange-400">
                      {user.transcodeCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant="destructive"
                        className="border-orange-500/30 bg-orange-500/20 text-orange-600 dark:text-orange-400"
                      >
                        {user.pctOfTotalTranscodes}%
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="rounded-xl border border-dashed p-8 text-center">
              <Users className="text-muted-foreground/50 mx-auto h-12 w-12" />
              <p className="text-muted-foreground mt-2">No transcoding users found</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
