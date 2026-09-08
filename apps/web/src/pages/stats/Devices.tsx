import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Smartphone, Monitor, CheckCircle2, ArrowRightLeft, Users } from 'lucide-react';
import { formatMediaTech } from '@tracearr/shared';
import type {
  DeviceCompatibilityMatrix,
  TopTranscodingUserRow,
  TranscodeHotspotRow,
} from '@tracearr/shared';
import { Link } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { InlineErrorState } from '@/components/library/ErrorState';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
import { getAvatarUrl } from '@/components/users/utils';
import { PerServerCardGrid, ServerColumnCell } from '@/components/server';
import type { Server } from '@tracearr/shared';

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

const hotspotColumn = createDataTableColumnHelper<TranscodeHotspotRow>();
const transcodingUserColumn = createDataTableColumnHelper<TopTranscodingUserRow>();

// The hotspots query groups by these four, so together they identify a row.
const getHotspotRowId = (row: TranscodeHotspotRow) =>
  `${row.serverId}-${row.device}-${row.videoCodec}-${row.audioCodec}`;

const getTranscodingUserRowId = (row: TopTranscodingUserRow) =>
  `${row.serverUserId}-${row.serverId}`;

// Neither table renders a pager, so one page has to hold every row the endpoint returns.
const UNPAGINATED_PAGE_SIZE = 100;

// Inline matrix renderer driven by pre-fetched data (used by both single and per-server views).
interface MatrixViewProps {
  data: DeviceCompatibilityMatrix | undefined;
  isLoading: boolean;
  error?: Error | null;
  onRetry?: () => void;
}

function MatrixView({ data, isLoading, error, onRetry }: MatrixViewProps) {
  const { t } = useTranslation(['pages', 'common']);

  const sortedMatrixDevices = data?.devices
    ? [...data.devices].sort((a, b) => {
        const aSessions = Object.values(a.codecs).reduce((sum, c) => sum + c.sessions, 0);
        const bSessions = Object.values(b.codecs).reduce((sum, c) => sum + c.sessions, 0);
        return bSessions - aSessions;
      })
    : [];

  const activeCodecs =
    data?.codecs.filter((codec) => sortedMatrixDevices.some((device) => device.codecs[codec])) ??
    [];

  if (error) {
    return (
      <InlineErrorState
        message={error.message ?? t('common:errors.unexpectedError')}
        onRetry={() => onRetry?.()}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (!data || sortedMatrixDevices.length === 0) {
    return <EmptyState icon={Monitor} title={t('devices.noDeviceDataPeriod')} className="py-8" />;
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="bg-background sticky left-0 z-10">
              {t('common:labels.device')}
            </TableHead>
            {activeCodecs.map((codec) => (
              <TableHead key={codec} className="min-w-[80px] text-center">
                {formatMediaTech(codec)}
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
                    {totalSessions.toLocaleString()} {t('common:labels.sessions').toLowerCase()}
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

      {/* Legend */}
      <div className="mt-4 flex items-center gap-4 text-sm">
        <span className="text-muted-foreground">{t('devices.legend')}</span>
        <Badge
          variant="outline"
          className="border-transparent bg-green-500/20 text-green-600 dark:text-green-400"
        >
          {t('devices.directPlayHigh')}
        </Badge>
        <Badge
          variant="outline"
          className="border-transparent bg-yellow-500/20 text-yellow-600 dark:text-yellow-400"
        >
          {t('devices.directPlayMid')}
        </Badge>
        <Badge
          variant="outline"
          className="border-transparent bg-red-500/20 text-red-600 dark:text-red-400"
        >
          {t('devices.directPlayLow')}
        </Badge>
      </div>
    </>
  );
}

export function StatsDevices() {
  const { t } = useTranslation(['pages', 'common']);
  const { value: timeRange, setValue: setTimeRange, apiParams } = useTimeRange();
  const { selectedServerIds, selectedServers, isMultiServer } = useServer();

  const compatibility = useDeviceCompatibility(apiParams, selectedServerIds);
  const matrixResult = useDeviceCompatibilityMatrix(selectedServerIds, apiParams);
  const deviceHealth = useDeviceHealth(apiParams, selectedServerIds);
  const hotspots = useTranscodeHotspots(apiParams, selectedServerIds);
  const topTranscodingUsers = useTopTranscodingUsers(apiParams, selectedServerIds);

  const summary = compatibility.data?.summary;

  // Resolve a Server object by id from selectedServers; returns undefined when id is unknown.
  const resolveServer = useCallback(
    (serverId: string): Server | undefined => selectedServers.find((s) => s.id === serverId),
    [selectedServers]
  );

  const hotspotRows = useMemo(() => hotspots.data?.data.slice(0, 5), [hotspots.data]);

  const hotspotColumns = useMemo(
    () =>
      hotspotColumn.columns([
        hotspotColumn.accessor('device', {
          header: t('devices.deviceAndCodec'),
          enableSorting: false,
          cell: ({ row }) => (
            <>
              <div className="font-medium">{row.original.device}</div>
              <div className="text-muted-foreground text-xs">
                {formatMediaTech(row.original.videoCodec)} +{' '}
                {formatMediaTech(row.original.audioCodec)}
              </div>
            </>
          ),
        }),
        ...(isMultiServer
          ? [
              hotspotColumn.display({
                id: 'server',
                header: t('common:labels.server'),
                enableSorting: false,
                cell: ({ row }) => {
                  const server = resolveServer(row.original.serverId);
                  return server ? <ServerColumnCell server={server} /> : null;
                },
              }),
            ]
          : []),
        hotspotColumn.accessor('transcodeCount', {
          header: t('devices.transcodes'),
          enableSorting: false,
          meta: { numeric: true, cellClassName: 'font-mono' },
          cell: ({ row }) => row.original.transcodeCount.toLocaleString(),
        }),
        hotspotColumn.accessor('pctOfTotalTranscodes', {
          header: t('devices.pctOfTotal'),
          enableSorting: false,
          meta: { numeric: true },
          cell: ({ row }) => (
            <Badge
              variant="destructive"
              className="border-orange-500/30 bg-orange-500/20 text-orange-600 dark:text-orange-400"
            >
              {row.original.pctOfTotalTranscodes}%
            </Badge>
          ),
        }),
      ]),
    [t, isMultiServer, resolveServer]
  );

  const transcodingUserColumns = useMemo(
    () =>
      transcodingUserColumn.columns([
        transcodingUserColumn.accessor('username', {
          header: t('common:labels.user'),
          enableSorting: false,
          cell: ({ row }) => {
            const user = row.original;
            return (
              <Link
                to={`/users/${user.serverUserId}`}
                className="flex items-center gap-3 hover:underline"
              >
                <Avatar className="h-8 w-8">
                  <AvatarImage
                    src={getAvatarUrl(user.serverId, user.avatar, 32) ?? undefined}
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
              transcodingUserColumn.display({
                id: 'server',
                header: t('common:labels.server'),
                enableSorting: false,
                cell: ({ row }) => {
                  const server = resolveServer(row.original.serverId);
                  return server ? <ServerColumnCell server={server} /> : null;
                },
              }),
            ]
          : []),
        transcodingUserColumn.accessor('totalSessions', {
          header: t('common:labels.sessions'),
          enableSorting: false,
          meta: { numeric: true, cellClassName: 'text-muted-foreground' },
          cell: ({ row }) => row.original.totalSessions.toLocaleString(),
        }),
        transcodingUserColumn.accessor('directPlayPct', {
          header: t('common:playback.directPlay'),
          enableSorting: false,
          meta: { numeric: true },
          cell: ({ row }) => (
            <Badge
              variant="outline"
              className={cn(
                'border-transparent',
                row.original.directPlayPct >= 80
                  ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                  : row.original.directPlayPct >= 50
                    ? 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400'
                    : 'bg-red-500/20 text-red-600 dark:text-red-400'
              )}
            >
              {row.original.directPlayPct}%
            </Badge>
          ),
        }),
        transcodingUserColumn.accessor('transcodeCount', {
          header: t('devices.transcodes'),
          enableSorting: false,
          meta: { numeric: true, cellClassName: 'font-mono text-orange-600 dark:text-orange-400' },
          cell: ({ row }) => row.original.transcodeCount.toLocaleString(),
        }),
        transcodingUserColumn.accessor('pctOfTotalTranscodes', {
          header: t('devices.pctOfTotal'),
          enableSorting: false,
          meta: { numeric: true },
          cell: ({ row }) => (
            <Badge
              variant="destructive"
              className="border-orange-500/30 bg-orange-500/20 text-orange-600 dark:text-orange-400"
            >
              {row.original.pctOfTotalTranscodes}%
            </Badge>
          ),
        }),
      ]),
    [t, isMultiServer, resolveServer]
  );

  const { table: hotspotsTable } = useDataTable<TranscodeHotspotRow>({
    columns: hotspotColumns,
    data: hotspotRows,
    getRowId: getHotspotRowId,
    pageSize: UNPAGINATED_PAGE_SIZE,
  });

  const { table: transcodingUsersTable } = useDataTable<TopTranscodingUserRow>({
    columns: transcodingUserColumns,
    data: topTranscodingUsers.data?.data,
    getRowId: getTranscodingUserRowId,
    pageSize: UNPAGINATED_PAGE_SIZE,
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('devices.title')}</h1>
          <p className="text-muted-foreground text-sm">{t('devices.description')}</p>
        </div>
        <TimeRangePicker value={timeRange} onChange={setTimeRange} />
      </div>

      {/* Summary Cards */}
      {compatibility.isError ? (
        <InlineErrorState
          message={compatibility.error?.message ?? t('common:errors.unexpectedError')}
          onRetry={() => void compatibility.refetch()}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <div tabIndex={0} className="cursor-help">
                <StatCard
                  icon={Smartphone}
                  label={t('devices.analyzedSessions')}
                  value={summary?.totalSessions.toLocaleString() ?? 0}
                  isLoading={compatibility.isLoading}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent>{t('devices.analyzedSessionsTooltip', { count: 5 })}</TooltipContent>
          </Tooltip>
          <StatCard
            icon={CheckCircle2}
            label={t('devices.directPlayRate')}
            value={`${summary?.directPlayPct ?? 0}%`}
            subValue={t('devices.videoAndAudio')}
            isLoading={compatibility.isLoading}
          />
          <StatCard
            icon={Monitor}
            label={t('devices.uniqueDevices')}
            value={summary?.uniqueDevices ?? 0}
            isLoading={compatibility.isLoading}
          />
          <StatCard
            icon={ArrowRightLeft}
            label={t('devices.uniqueCodecs')}
            value={summary?.uniqueCodecs ?? 0}
            isLoading={compatibility.isLoading}
          />
        </div>
      )}

      {/* Device Health + Transcode Hotspots */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Device Health Rankings */}
        <Card>
          <CardHeader>
            <CardTitle>{t('devices.deviceHealth')}</CardTitle>
            <CardDescription>{t('devices.deviceHealthDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            {deviceHealth.isError ? (
              <InlineErrorState
                message={deviceHealth.error?.message ?? t('common:errors.unexpectedError')}
                onRetry={() => void deviceHealth.refetch()}
              />
            ) : deviceHealth.isLoading ? (
              <div className="space-y-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : deviceHealth.data && deviceHealth.data.data.length > 0 ? (
              <div className="space-y-4">
                {deviceHealth.data.data.slice(0, 8).map((device, idx) => {
                  const deviceServer = resolveServer(device.serverId);
                  return (
                    <div key={`${device.device}-${idx}`} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span
                            className="max-w-[150px] truncate font-medium"
                            title={device.device}
                          >
                            {device.device}
                          </span>
                          {isMultiServer && deviceServer && (
                            <ServerColumnCell server={deviceServer} />
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground text-xs">
                            {device.sessions.toLocaleString()}{' '}
                            {t('common:labels.sessions').toLowerCase()}
                          </span>
                          <span
                            className={cn(
                              'font-semibold',
                              getDirectPlayColor(device.directPlayPct)
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
                  );
                })}
              </div>
            ) : (
              <EmptyState icon={Monitor} title={t('common:empty.noDeviceData')} className="py-8" />
            )}
          </CardContent>
        </Card>

        {/* Transcode Hotspots */}
        <Card>
          <CardHeader>
            <CardTitle>{t('devices.transcodeHotspots')}</CardTitle>
            <CardDescription>{t('devices.transcodeHotspotsDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            {hotspots.isError ? (
              <InlineErrorState
                message={hotspots.error?.message ?? t('common:errors.unexpectedError')}
                onRetry={() => void hotspots.refetch()}
              />
            ) : (
              <DataTableRoot density="compact">
                <DataTableViewport flush>
                  <DataTableHeader table={hotspotsTable} />
                  <DataTableBody
                    table={hotspotsTable}
                    isLoading={hotspots.isLoading}
                    loadingLabel={t('common:states.loading')}
                    empty={
                      <DataTableEmpty
                        table={hotspotsTable}
                        icon={CheckCircle2}
                        title={t('devices.noTranscodeHotspots')}
                      />
                    }
                  />
                </DataTableViewport>
              </DataTableRoot>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Matrix View */}
      <Card>
        <CardHeader>
          <CardTitle>{t('devices.compatibilityMatrix')}</CardTitle>
          <CardDescription>{t('devices.compatibilityMatrixDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {isMultiServer ? (
            <PerServerCardGrid
              servers={selectedServers}
              renderServer={(server) => {
                const result = matrixResult.byServer.get(server.id);
                return (
                  <MatrixView
                    data={result?.data}
                    isLoading={result?.isLoading ?? matrixResult.isLoading}
                    error={result?.error}
                    onRetry={() => void result?.refetch()}
                  />
                );
              }}
            />
          ) : (
            <MatrixView
              data={matrixResult.byServer.get(selectedServerIds[0] ?? '')?.data}
              isLoading={matrixResult.isLoading}
              error={matrixResult.byServer.get(selectedServerIds[0] ?? '')?.error}
              onRetry={() => void matrixResult.byServer.get(selectedServerIds[0] ?? '')?.refetch()}
            />
          )}
        </CardContent>
      </Card>

      {/* Top Transcoding Users */}
      <Card>
        <CardHeader>
          <CardTitle>{t('devices.topTranscodingUsers')}</CardTitle>
          <CardDescription>{t('devices.topTranscodingUsersDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {topTranscodingUsers.isError ? (
            <InlineErrorState
              message={topTranscodingUsers.error?.message ?? t('common:errors.unexpectedError')}
              onRetry={() => void topTranscodingUsers.refetch()}
            />
          ) : (
            <DataTableRoot density="compact">
              <DataTableViewport flush>
                <DataTableHeader table={transcodingUsersTable} />
                <DataTableBody
                  table={transcodingUsersTable}
                  isLoading={topTranscodingUsers.isLoading}
                  loadingLabel={t('common:states.loading')}
                  empty={
                    <DataTableEmpty
                      table={transcodingUsersTable}
                      icon={Users}
                      title={t('devices.noTranscodingUsers')}
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
