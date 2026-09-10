import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  AlertTriangle,
  Trash2,
  RotateCcw,
  Database,
  Server,
  Users,
  Film,
  Shield,
  RefreshCw,
  Info,
  FileText,
  Scale,
  XSquare,
  Library,
  Link2,
  Camera,
  Loader2,
  Smartphone,
  Download,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  createDataTableColumnHelper,
  DataTableBody,
  DataTableEmpty,
  DataTableHeader,
  DataTablePager,
  DataTableRoot,
  DataTableViewport,
  useDataTable,
} from '@/components/ui/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ClientErrors } from '@/components/debug/ClientErrors';
import { useVersion } from '@/hooks/queries';
import { tokenStorage, api, BASE_URL } from '@/lib/api';
import { debugFetch, debugRawFetch } from '@/lib/debugFetch';
import { TasksTab } from '@/components/debug/TasksTab';
import { toast } from 'sonner';
import { format, formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

interface DebugStats {
  counts: {
    sessions: number;
    violations: number;
    users: number;
    servers: number;
    rules: number;
    terminationLogs: number;
    libraryItems: number;
    plexAccounts: number;
  };
  database: {
    size: string;
    tables: { table_name: string; total_size: string }[];
    aggregates: { table_name: string; total_size: string }[];
  };
}

interface EnvInfo {
  nodeVersion: string;
  platform: string;
  arch: string;
  uptime: number;
  systemUptime: number;
  loadAverage: [string, string, string];
  memoryUsage: {
    heapUsed: string;
    rss: string;
  };
  database: {
    postgresVersion: string;
    timescaleVersion: string;
  };
  redis: {
    version: string;
  };
  container: {
    isDocker: boolean;
    memoryLimit: string;
    memoryUsage: string;
    cpuLimit: string;
    cpuModel: string;
  };
  volumes: { path: string; source: string; free: string }[];
  processes: { name: string; memory: string }[];
  env: Record<string, string>;
}

interface LogFileInfo {
  name: string;
  exists: boolean;
}

interface LogListResponse {
  files: LogFileInfo[];
}

interface LogEntriesResponse {
  entries: string[];
  truncated: boolean;
  fileExists: boolean;
}

const MAX_LOG_LIMIT = 1000;
const LOG_LIMIT_STEP = 200;

const formatLogLabel = (name: string) => name.replace('.log', '').replace(/-/g, ' ');

interface SnapshotItem {
  id: string;
  server_id: string;
  server_name: string | null;
  library_id: string;
  library_type: string;
  snapshot_time: string;
  item_count: number;
  total_size: string;
  movie_count: number;
  episode_count: number;
  music_count: number;
  is_suspicious: boolean;
}

const snapshotColumn = createDataTableColumnHelper<SnapshotItem>();
const getSnapshotId = (snapshot: SnapshotItem) => snapshot.id;

const formatBytes = (bytes: string | number) => {
  const num = typeof bytes === 'string' ? parseInt(bytes, 10) : bytes;
  if (num === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(num) / Math.log(k));
  return `${parseFloat((num / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

export function Debug() {
  const { t } = useTranslation(['pages', 'common']);
  const queryClient = useQueryClient();
  const version = useVersion();
  const isSupervised = Boolean(version.data?.current.tag?.toLowerCase().includes('supervised'));

  const stats = useQuery({
    queryKey: ['debug', 'stats'],
    queryFn: () => debugFetch<DebugStats>('/stats'),
  });

  const envInfo = useQuery({
    queryKey: ['debug', 'env'],
    queryFn: () => debugFetch<EnvInfo>('/env'),
  });

  const [selectedLog, setSelectedLog] = useState<string | null>(null);
  const [logLimit, setLogLimit] = useState(LOG_LIMIT_STEP);

  const logFiles = useQuery({
    queryKey: ['debug', 'logs'],
    queryFn: () => debugFetch<LogListResponse>('/logs'),
    enabled: isSupervised,
  });

  const logEntries = useQuery({
    queryKey: ['debug', 'logs', selectedLog, logLimit],
    queryFn: () =>
      debugFetch<LogEntriesResponse>(
        `/logs/${encodeURIComponent(selectedLog ?? '')}?limit=${logLimit}`
      ),
    enabled: isSupervised && Boolean(selectedLog),
  });

  useEffect(() => {
    if (!selectedLog && logFiles.data?.files.length) {
      setSelectedLog(logFiles.data.files[0]?.name ?? null);
    }
  }, [selectedLog, logFiles.data?.files]);

  const deleteMutation = useMutation({
    mutationFn: async ({ action, isPost }: { action: string; isPost?: boolean }) => {
      return debugFetch(`/${action}`, { method: isPost ? 'POST' : 'DELETE' });
    },
    onSuccess: (_data, variables) => {
      // Factory reset: clear tokens and redirect to login
      if (variables.action === 'reset') {
        tokenStorage.clearTokens(true);
        window.location.href = `${BASE_URL}login`;
        return;
      }
      void queryClient.invalidateQueries();
    },
  });

  const handleDelete = (action: string, description: string, isPost = false) => {
    if (window.confirm(`${description}\n\nThis cannot be undone. Continue?`)) {
      deleteMutation.mutate({ action, isPost });
    }
  };

  const formatUptime = (seconds: number) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  const handleLogsRefresh = () => {
    void logFiles.refetch();
    void logEntries.refetch();
  };

  const [isDownloadingLogs, setIsDownloadingLogs] = useState(false);
  const handleDownloadLogs = async () => {
    setIsDownloadingLogs(true);
    try {
      const res = await debugRawFetch('/logs/download');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const disposition = res.headers.get('Content-Disposition');
      a.download = disposition?.match(/filename="(.+)"/)?.[1] ?? 'tracearr-logs.zip';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to download logs');
    } finally {
      setIsDownloadingLogs(false);
    }
  };

  // Snapshot management state
  const [snapshots, setSnapshots] = useState<SnapshotItem[]>([]);
  const [isLoadingSnapshots, setIsLoadingSnapshots] = useState(false);
  const [showSuspiciousOnly, setShowSuspiciousOnly] = useState(true);
  const [selectedSnapshots, setSelectedSnapshots] = useState<Set<string>>(new Set());
  const [isDeletingSnapshots, setIsDeletingSnapshots] = useState(false);
  const [confirmDeleteSnapshots, setConfirmDeleteSnapshots] = useState(false);

  const fetchSnapshots = useCallback(async () => {
    setIsLoadingSnapshots(true);
    try {
      const result = await api.maintenance.getSnapshots({
        suspicious: showSuspiciousOnly || undefined,
      });
      setSnapshots(result.snapshots);
      setSelectedSnapshots(new Set());
    } catch (err) {
      console.error('Failed to fetch snapshots:', err);
      toast.error('Failed to load snapshots');
    } finally {
      setIsLoadingSnapshots(false);
    }
  }, [showSuspiciousOnly]);

  const handleDeleteSelectedSnapshots = async () => {
    if (selectedSnapshots.size === 0) return;
    setIsDeletingSnapshots(true);
    setConfirmDeleteSnapshots(false);

    try {
      const result = await api.maintenance.deleteSnapshots({
        ids: Array.from(selectedSnapshots),
      });
      toast.success(`Deleted ${result.deleted} snapshot(s)`);
      void fetchSnapshots();
    } catch (err) {
      console.error('Failed to delete snapshots:', err);
      toast.error('Failed to delete snapshots');
    } finally {
      setIsDeletingSnapshots(false);
    }
  };

  const handleDeleteAllSuspicious = async () => {
    setIsDeletingSnapshots(true);
    setConfirmDeleteSnapshots(false);

    try {
      const result = await api.maintenance.deleteSnapshots({
        criteria: { suspicious: true },
      });
      toast.success(`Deleted ${result.deleted} suspicious snapshot(s)`);
      void fetchSnapshots();
    } catch (err) {
      console.error('Failed to delete snapshots:', err);
      toast.error('Failed to delete snapshots');
    } finally {
      setIsDeletingSnapshots(false);
    }
  };

  const toggleSnapshotSelection = useCallback((row: SnapshotItem) => {
    setSelectedSnapshots((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) {
        next.delete(row.id);
      } else {
        next.add(row.id);
      }
      return next;
    });
  }, []);

  const handlePageSelect = useCallback((rows: SnapshotItem[]) => {
    const pageIds = rows.map((row) => row.id);
    setSelectedSnapshots((prev) => {
      const next = new Set(prev);
      if (pageIds.every((id) => prev.has(id))) {
        pageIds.forEach((id) => next.delete(id));
      } else {
        pageIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }, []);

  const snapshotColumns = useMemo(
    () =>
      snapshotColumn.columns([
        snapshotColumn.accessor('snapshot_time', {
          header: t('common:labels.date'),
          cell: ({ row }) => {
            const date = new Date(row.original.snapshot_time);
            return (
              <div className="text-xs">
                <div>{format(date, 'MMM d, yyyy')}</div>
                <div className="text-muted-foreground">
                  {formatDistanceToNow(date, { addSuffix: true })}
                </div>
              </div>
            );
          },
          sortFn: 'datetime',
        }),
        snapshotColumn.accessor('server_name', {
          header: t('common:labels.server'),
          cell: ({ row }) => (
            <span className="text-xs">{row.original.server_name || 'Unknown'}</span>
          ),
        }),
        snapshotColumn.accessor('library_type', {
          header: 'Library',
          cell: ({ row }) => (
            <Badge variant="secondary" className="text-xs font-normal">
              {row.original.library_type}
            </Badge>
          ),
        }),
        snapshotColumn.accessor('is_suspicious', {
          header: t('common:labels.status'),
          cell: ({ row }) =>
            row.original.is_suspicious ? (
              <Badge variant="outline" className="border-amber-500/30 text-xs text-amber-600">
                {t('debug.suspicious')}
              </Badge>
            ) : (
              <span className="text-muted-foreground text-xs">{t('debug.ok')}</span>
            ),
        }),
        snapshotColumn.accessor('item_count', {
          header: t('common:labels.items'),
          cell: ({ row }) => (
            <span className="text-xs">{row.original.item_count.toLocaleString()}</span>
          ),
        }),
        snapshotColumn.accessor('total_size', {
          header: t('common:labels.size'),
          cell: ({ row }) => (
            <span className="text-xs">{formatBytes(row.original.total_size)}</span>
          ),
          sortFn: (rowA, rowB) => {
            const a = parseInt(String(rowA.original.total_size), 10) || 0;
            const b = parseInt(String(rowB.original.total_size), 10) || 0;
            return a - b;
          },
        }),
        snapshotColumn.display({
          id: 'content',
          header: t('common:labels.content'),
          cell: ({ row }) => {
            const { movie_count, episode_count, music_count } = row.original;
            const parts: string[] = [];
            if (movie_count > 0) parts.push(`${movie_count} movies`);
            if (episode_count > 0) parts.push(`${episode_count} episodes`);
            if (music_count > 0) parts.push(`${music_count} tracks`);
            return <span className="text-muted-foreground text-xs">{parts.join(', ') || '—'}</span>;
          },
        }),
      ]),
    [t]
  );

  const snapshotSelection = useMemo(
    () => ({
      selectedIds: selectedSnapshots,
      onToggleRow: toggleSnapshotSelection,
      onTogglePage: handlePageSelect,
      labels: {
        selectAllOnPage: t('common:table.selectAllOnPage'),
        selectRow: t('common:table.selectRow'),
      },
    }),
    [selectedSnapshots, toggleSnapshotSelection, handlePageSelect, t]
  );

  const { table: snapshotsTable, pager: snapshotsPager } = useDataTable<SnapshotItem>({
    columns: snapshotColumns,
    data: snapshots,
    getRowId: getSnapshotId,
    pageSize: 50,
    selection: snapshotSelection,
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="bg-destructive/10 flex h-10 w-10 items-center justify-center rounded-lg">
          <AlertTriangle className="text-destructive h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">{t('debug.title')}</h1>
          <p className="text-muted-foreground text-sm">{t('debug.description')}</p>
        </div>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">{t('debug.overview')}</TabsTrigger>
          <TabsTrigger value="snapshots">{t('debug.librarySnapshots')}</TabsTrigger>
          <TabsTrigger value="tasks">{t('debug.tasks')}</TabsTrigger>
          <TabsTrigger value="logs">{t('debug.logs')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          {/* Stats Overview */}
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Film className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.counts.sessions ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">{t('common:labels.sessions')}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Shield className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.counts.violations ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">{t('violations.title')}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Scale className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.counts.rules ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">{t('automations.title')}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Users className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.counts.users ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">{t('users.title')}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Server className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.counts.servers ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">Servers</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Link2 className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.counts.plexAccounts ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">{t('debug.plexAccounts')}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <XSquare className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.counts.terminationLogs ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">{t('debug.terminations')}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Library className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.counts.libraryItems ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">{t('debug.libraryItems')}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 p-4">
                <Database className="text-muted-foreground h-8 w-8" />
                <div>
                  <p className="text-2xl font-bold">{stats.data?.database.size ?? '-'}</p>
                  <p className="text-muted-foreground text-xs">DB Size</p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Environment Info - Full Width */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Info className="h-5 w-5" />
                {t('debug.environment')}
              </CardTitle>
              <CardDescription>{t('debug.systemInformation')}</CardDescription>
            </CardHeader>
            <CardContent>
              {envInfo.data && (
                <div className="grid gap-6 lg:grid-cols-2">
                  {/* Runtime Info */}
                  <div>
                    <p className="mb-3 text-sm font-medium">Runtime</p>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="text-muted-foreground">Node.js</div>
                      <div className="font-mono">{envInfo.data.nodeVersion}</div>
                      <div className="text-muted-foreground">Platform</div>
                      <div className="font-mono">
                        {envInfo.data.platform}/{envInfo.data.arch}
                      </div>
                      <div className="text-muted-foreground">Docker</div>
                      <div className="font-mono">
                        {envInfo.data.container.isDocker ? 'Yes' : 'No'}
                      </div>
                      <div className="text-muted-foreground">Uptime</div>
                      <div className="font-mono">{formatUptime(envInfo.data.uptime)}</div>
                      <div className="text-muted-foreground">Heap Used</div>
                      <div className="font-mono">{envInfo.data.memoryUsage.heapUsed}</div>
                      <div className="text-muted-foreground">RSS</div>
                      <div className="font-mono">{envInfo.data.memoryUsage.rss}</div>
                    </div>

                    <p className="mt-6 mb-3 text-sm font-medium">Infrastructure</p>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="text-muted-foreground">Redis Version</div>
                      <div className="font-mono">{envInfo.data.redis.version}</div>
                      <div className="text-muted-foreground">PostgreSQL Version</div>
                      <div className="font-mono">{envInfo.data.database.postgresVersion}</div>
                      <div className="text-muted-foreground">TimescaleDB Version</div>
                      <div className="font-mono">{envInfo.data.database.timescaleVersion}</div>
                    </div>

                    {envInfo.data.volumes.length > 0 && (
                      <>
                        <p className="mt-6 mb-3 text-sm font-medium">Volume Mounts</p>
                        <div className="grid grid-cols-2 gap-2 text-sm">
                          {envInfo.data.volumes.map((vol) => (
                            <div key={vol.path} className="contents">
                              <div className="text-muted-foreground">
                                {vol.source}:{vol.path}
                              </div>
                              <div className="font-mono">{vol.free} free</div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  {/* Environment Variables & Processes */}
                  <div>
                    <p className="mb-3 text-sm font-medium">Environment Variables</p>
                    <div className="grid grid-cols-[40%_60%] gap-2 text-sm">
                      {Object.entries(envInfo.data.env)
                        .filter(([, value]) => value !== '')
                        .map(([key, value]) => (
                          <div key={key} className="contents">
                            <div className="text-muted-foreground truncate">{key}</div>
                            <div className="font-mono text-xs">{value}</div>
                          </div>
                        ))}
                    </div>

                    <p className="mt-6 mb-3 text-sm font-medium">System Stats</p>
                    <div className="grid grid-cols-[40%_60%] gap-2 text-sm">
                      <div className="text-muted-foreground">Memory Used / Total</div>
                      <div className="font-mono">
                        {envInfo.data.container.memoryUsage} / {envInfo.data.container.memoryLimit}
                      </div>
                      <div className="text-muted-foreground">CPU</div>
                      <div className="font-mono">
                        {envInfo.data.container.cpuLimit.replace(' cores', '')} x{' '}
                        {envInfo.data.container.cpuModel}
                      </div>
                      <div className="text-muted-foreground">Load Average (1m / 5m / 15m)</div>
                      <div className="font-mono">{envInfo.data.loadAverage.join(' / ')}</div>
                      <div className="text-muted-foreground">System Uptime</div>
                      <div className="font-mono">{formatUptime(envInfo.data.systemUptime)}</div>
                    </div>

                    {envInfo.data.processes.length > 0 && (
                      <>
                        <p className="mt-6 mb-3 text-sm font-medium">Process Memory Usage</p>
                        <div className="grid grid-cols-[40%_60%] gap-2 text-sm">
                          {envInfo.data.processes.map((proc, i) => (
                            <div key={`${proc.name}-${i}`} className="contents">
                              <div className="text-muted-foreground">{proc.name}</div>
                              <div className="font-mono">{proc.memory}</div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Table Sizes - Full Width */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                {t('debug.database')}
              </CardTitle>
              <CardDescription>{t('debug.databaseDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-6 lg:grid-cols-2">
                {/* Application Tables */}
                <div>
                  <p className="mb-3 text-sm font-medium">Application Tables</p>
                  <div className="space-y-1.5">
                    {stats.data?.database.tables.map((table) => (
                      <div
                        key={table.table_name}
                        className="flex items-center justify-between text-sm"
                      >
                        <span className="text-muted-foreground font-mono text-xs">
                          {table.table_name}
                        </span>
                        <span className="font-mono text-xs">{table.total_size}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {/* Continuous Aggregates */}
                <div>
                  <p className="mb-3 text-sm font-medium">Continuous Aggregates</p>
                  <div className="space-y-1.5">
                    {stats.data?.database.aggregates?.length ? (
                      stats.data.database.aggregates.map((table) => (
                        <div
                          key={table.table_name}
                          className="flex items-center justify-between text-sm"
                        >
                          <span className="text-muted-foreground font-mono text-xs">
                            {table.table_name}
                          </span>
                          <span className="font-mono text-xs">{table.total_size}</span>
                        </div>
                      ))
                    ) : (
                      <p className="text-muted-foreground text-xs">No continuous aggregates</p>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Trash2 className="h-5 w-5" />
                {t('debug.maintenance')}
              </CardTitle>
              <CardDescription>{t('debug.destructiveActions')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Utility Actions */}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() =>
                    handleDelete('refresh-aggregates', 'Refresh TimescaleDB aggregates', true)
                  }
                  disabled={deleteMutation.isPending}
                >
                  <RefreshCw />
                  {t('debug.refreshAggregates')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    handleDelete('clear-stuck-jobs', 'Clear stuck maintenance jobs', true)
                  }
                  disabled={deleteMutation.isPending}
                >
                  <RotateCcw />
                  {t('debug.clearStuckJobs')}
                </Button>
                <Button
                  variant="outline"
                  className="border-destructive/50 text-destructive hover:bg-destructive/10"
                  onClick={() =>
                    handleDelete(
                      'obliterate-all-jobs',
                      'OBLITERATE ALL JOBS: This will completely wipe ALL job queues (maintenance, import, library sync) and release all locks. Use only when jobs are completely stuck.',
                      true
                    )
                  }
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('debug.obliterateAllJobs')}
                </Button>
                <Button variant="outline" onClick={() => queryClient.invalidateQueries()}>
                  <RotateCcw />
                  {t('debug.clearQueryCache')}
                </Button>
                <Button
                  variant="outline"
                  className="border-destructive/50 text-destructive hover:bg-destructive/10"
                  onClick={() =>
                    handleDelete(
                      'mobile',
                      'Delete all mobile pairing codes and paired devices. Active devices will be disconnected.'
                    )
                  }
                  disabled={deleteMutation.isPending}
                >
                  <Smartphone className="mr-2 h-4 w-4" />
                  {t('debug.clearMobileDevices')}
                </Button>
              </div>

              <div className="border-t pt-4">
                <p className="text-muted-foreground mb-3 text-sm font-medium">
                  {t('debug.destructiveActions')}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => handleDelete('violations', 'Delete all violation records')}
                    disabled={deleteMutation.isPending}
                  >
                    {t('debug.clearViolations')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleDelete('automations', t('debug.clearAutomationsConfirm'))}
                    disabled={deleteMutation.isPending}
                  >
                    {t('debug.clearAutomations')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      handleDelete('termination-logs', 'Delete all stream termination logs')
                    }
                    disabled={deleteMutation.isPending}
                  >
                    {t('debug.clearTerminationLogs')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      handleDelete(
                        'library',
                        'Delete all library metadata cache (items and snapshots)'
                      )
                    }
                    disabled={deleteMutation.isPending}
                  >
                    {t('debug.clearLibraryCache')}
                  </Button>
                  <Button
                    variant="outline"
                    className="border-destructive/50 text-destructive hover:bg-destructive/10"
                    onClick={() =>
                      handleDelete(
                        'sessions',
                        'Delete all session history, violations, and termination logs'
                      )
                    }
                    disabled={deleteMutation.isPending}
                  >
                    {t('debug.clearSessions')}
                  </Button>
                  <Button
                    variant="outline"
                    className="border-destructive/50 text-destructive hover:bg-destructive/10"
                    onClick={() =>
                      handleDelete('users', 'Delete all non-owner users and their data')
                    }
                    disabled={deleteMutation.isPending}
                  >
                    {t('debug.clearUsers')}
                  </Button>
                  <Button
                    variant="outline"
                    className="border-destructive/50 text-destructive hover:bg-destructive/10"
                    onClick={() =>
                      handleDelete(
                        'servers',
                        'Delete all servers (cascades to users, sessions, violations, library data)'
                      )
                    }
                    disabled={deleteMutation.isPending}
                  >
                    {t('debug.clearServers')}
                  </Button>
                </div>
              </div>

              <div className="border-t pt-4">
                <Button
                  variant="destructive"
                  onClick={() =>
                    handleDelete(
                      'reset',
                      'FACTORY RESET: Delete everything except your owner account. You will need to set up the app again.',
                      true
                    )
                  }
                  disabled={deleteMutation.isPending}
                >
                  <AlertTriangle className="mr-2 h-4 w-4" />
                  {t('debug.factoryReset')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="snapshots" className="space-y-6">
          {/* Snapshot Management */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Camera className="h-5 w-5" />
                    {t('debug.librarySnapshots')}
                  </CardTitle>
                  <CardDescription>{t('debug.manageSnapshots')}</CardDescription>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="suspicious-only"
                      checked={showSuspiciousOnly}
                      onCheckedChange={setShowSuspiciousOnly}
                    />
                    <Label htmlFor="suspicious-only" className="text-sm">
                      {t('debug.suspiciousOnly')}
                    </Label>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void fetchSnapshots()}
                    disabled={isLoadingSnapshots}
                    className="gap-1.5"
                  >
                    <RefreshCw
                      className={cn('h-3.5 w-3.5', isLoadingSnapshots && 'animate-spin')}
                    />
                    {t('debug.load')}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {snapshots.length === 0 && !isLoadingSnapshots ? (
                <div className="flex h-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed">
                  <Camera className="text-muted-foreground h-4 w-4" />
                  <p className="text-muted-foreground text-xs">
                    {showSuspiciousOnly
                      ? t('debug.noSuspiciousSnapshots')
                      : t('debug.clickLoadToView')}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Actions bar */}
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground text-sm">
                      {selectedSnapshots.size > 0
                        ? `${selectedSnapshots.size} ${t('debug.of')} ${snapshots.length} ${t('debug.selected')}`
                        : `${snapshots.length} ${t('debug.snapshots')}`}
                    </span>
                    <div className="flex gap-2">
                      {selectedSnapshots.size > 0 && (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setConfirmDeleteSnapshots(true)}
                          disabled={isDeletingSnapshots}
                        >
                          {isDeletingSnapshots ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          {t('debug.deleteSelected')}
                        </Button>
                      )}
                      {showSuspiciousOnly &&
                        snapshots.length > 0 &&
                        selectedSnapshots.size === 0 && (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setConfirmDeleteSnapshots(true)}
                            disabled={isDeletingSnapshots}
                          >
                            {isDeletingSnapshots ? (
                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            {t('debug.deleteAllSuspicious')}
                          </Button>
                        )}
                    </div>
                  </div>

                  {/* Snapshot table */}
                  <DataTableRoot density="compact">
                    <DataTableViewport flush>
                      <DataTableHeader table={snapshotsTable} />
                      <DataTableBody
                        table={snapshotsTable}
                        isLoading={isLoadingSnapshots}
                        loadingLabel={t('common:states.loading')}
                        empty={
                          <DataTableEmpty
                            table={snapshotsTable}
                            title={
                              showSuspiciousOnly
                                ? t('debug.noSuspiciousSnapshots')
                                : t('debug.clickLoadToView')
                            }
                          />
                        }
                      />
                    </DataTableViewport>
                    <DataTablePager
                      {...snapshotsPager}
                      labels={{
                        navigation: t('common:table.pagination'),
                        status: t('common:table.pageOf', {
                          page: snapshotsPager.page,
                          total: snapshotsPager.pageCount,
                        }),
                        previous: t('common:actions.previous'),
                        next: t('common:actions.next'),
                      }}
                    />
                  </DataTableRoot>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Info Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Info className="h-5 w-5" />
                About Snapshots
              </CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground space-y-2 text-sm">
              <p>
                Library snapshots are point-in-time records of your library&apos;s state. They power
                the Storage Trend and Quality Evolution charts.
              </p>
              <p>
                <strong className="text-foreground">Suspicious snapshots</strong> have 0 bytes total
                size but contain video content - this usually indicates an incomplete sync where
                episodes/tracks weren&apos;t fetched properly.
              </p>
              <p>
                Deleting bad snapshots allows the backfill job to recreate them correctly from your
                library items&apos; created_at dates.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tasks" className="space-y-6">
          <TasksTab />
        </TabsContent>

        <TabsContent value="logs" className="space-y-6">
          <ClientErrors />

          {/* Log Explorer */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                {t('debug.logs')}
              </CardTitle>
              <CardDescription>Supervised deployment logs</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {version.isLoading ? (
                <div className="text-muted-foreground text-sm">Checking deployment mode...</div>
              ) : !isSupervised ? (
                <div className="text-muted-foreground text-sm">
                  {t('debug.logExplorerUnavailable')}
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={handleLogsRefresh}
                      disabled={logFiles.isFetching || logEntries.isFetching}
                    >
                      <RotateCcw />
                      Refresh Logs
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setLogLimit((prev) => Math.min(prev + LOG_LIMIT_STEP, MAX_LOG_LIMIT))
                      }
                      disabled={logEntries.isFetching || logLimit >= MAX_LOG_LIMIT}
                    >
                      Load More
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleDownloadLogs}
                      disabled={isDownloadingLogs}
                    >
                      <Download />
                      {isDownloadingLogs ? 'Downloading...' : 'Download All'}
                    </Button>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {logFiles.data?.files.map((file) => (
                      <Button
                        key={file.name}
                        size="sm"
                        variant={selectedLog === file.name ? 'default' : 'outline'}
                        onClick={() => setSelectedLog(file.name)}
                      >
                        {formatLogLabel(file.name)}
                      </Button>
                    ))}
                  </div>

                  {selectedLog && logEntries.isLoading ? (
                    <div className="text-muted-foreground text-sm">Loading log entries...</div>
                  ) : selectedLog && !logEntries.data?.fileExists ? (
                    <div className="text-muted-foreground text-sm">Log file not found.</div>
                  ) : logEntries.data?.entries.length ? (
                    <div className="bg-muted/30 max-h-[420px] overflow-y-auto rounded-md border p-3">
                      <pre className="font-mono text-xs break-words whitespace-pre-wrap">
                        {logEntries.data.entries.join('\n')}
                      </pre>
                    </div>
                  ) : (
                    <div className="text-muted-foreground text-sm">No logs available yet.</div>
                  )}

                  {logEntries.data?.truncated && (
                    <div className="text-muted-foreground text-xs">
                      Showing the most recent entries. Increase the limit to see more history.
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Delete Snapshots Confirmation Dialog */}
      <Dialog open={confirmDeleteSnapshots} onOpenChange={setConfirmDeleteSnapshots}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Snapshots?</DialogTitle>
            <DialogDescription className="text-sm">
              {selectedSnapshots.size > 0
                ? `This will delete ${selectedSnapshots.size} selected snapshot(s).`
                : 'This will delete all suspicious snapshots (those with 0 bytes for video libraries).'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="text-sm">
              <p className="font-medium text-amber-600">This cannot be undone</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Deleted snapshots will need to be recreated via the Backfill Library Snapshots job.
                The continuous aggregate will be refreshed automatically.
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmDeleteSnapshots(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={
                selectedSnapshots.size > 0
                  ? handleDeleteSelectedSnapshots
                  : handleDeleteAllSuspicious
              }
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {t('common:actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
