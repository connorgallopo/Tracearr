import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useVersion } from '@/hooks/queries';
import { tokenStorage } from '@/lib/api';
import { API_BASE_PATH } from '@tracearr/shared';

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
  };
}

interface EnvInfo {
  nodeVersion: string;
  platform: string;
  arch: string;
  uptime: number;
  memoryUsage: {
    heapUsed: string;
    heapTotal: string;
    rss: string;
  };
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

const NON_SUPERVISED_MESSAGE =
  "You're running Tracearr in non-supervised mode. Log explorer is not available. " +
  'Logs can be viewed by inspecting each container directly (for example, docker logs <container_name>).';

// Simple fetch helper for debug endpoints
async function debugFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = tokenStorage.getAccessToken();
  const headers: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  // Only set Content-Type for requests with a body
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }
  // Merge additional headers if provided as a plain object
  if (options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)) {
    Object.assign(headers, options.headers);
  }
  const res = await fetch(`${API_BASE_PATH}/debug${path}`, {
    ...options,
    headers,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export function Debug() {
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
        window.location.href = '/login';
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="bg-destructive/10 flex h-10 w-10 items-center justify-center rounded-lg">
          <AlertTriangle className="text-destructive h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Debug Tools</h1>
          <p className="text-muted-foreground text-sm">
            Administrative utilities for troubleshooting and data management
          </p>
        </div>
      </div>

      {/* Stats Overview */}
      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Film className="text-muted-foreground h-8 w-8" />
            <div>
              <p className="text-2xl font-bold">{stats.data?.counts.sessions ?? '-'}</p>
              <p className="text-muted-foreground text-xs">Sessions</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Shield className="text-muted-foreground h-8 w-8" />
            <div>
              <p className="text-2xl font-bold">{stats.data?.counts.violations ?? '-'}</p>
              <p className="text-muted-foreground text-xs">Violations</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Scale className="text-muted-foreground h-8 w-8" />
            <div>
              <p className="text-2xl font-bold">{stats.data?.counts.rules ?? '-'}</p>
              <p className="text-muted-foreground text-xs">Rules</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Users className="text-muted-foreground h-8 w-8" />
            <div>
              <p className="text-2xl font-bold">{stats.data?.counts.users ?? '-'}</p>
              <p className="text-muted-foreground text-xs">Users</p>
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
              <p className="text-muted-foreground text-xs">Plex Accounts</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <XSquare className="text-muted-foreground h-8 w-8" />
            <div>
              <p className="text-2xl font-bold">{stats.data?.counts.terminationLogs ?? '-'}</p>
              <p className="text-muted-foreground text-xs">Terminations</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Library className="text-muted-foreground h-8 w-8" />
            <div>
              <p className="text-2xl font-bold">{stats.data?.counts.libraryItems ?? '-'}</p>
              <p className="text-muted-foreground text-xs">Library Items</p>
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

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Environment Info */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Info className="h-5 w-5" />
              Environment
            </CardTitle>
            <CardDescription>Server runtime information</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {envInfo.data && (
              <>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="text-muted-foreground">Node.js</div>
                  <div className="font-mono">{envInfo.data.nodeVersion}</div>
                  <div className="text-muted-foreground">Platform</div>
                  <div className="font-mono">
                    {envInfo.data.platform}/{envInfo.data.arch}
                  </div>
                  <div className="text-muted-foreground">Uptime</div>
                  <div className="font-mono">{formatUptime(envInfo.data.uptime)}</div>
                  <div className="text-muted-foreground">Heap Used</div>
                  <div className="font-mono">{envInfo.data.memoryUsage.heapUsed}</div>
                  <div className="text-muted-foreground">RSS</div>
                  <div className="font-mono">{envInfo.data.memoryUsage.rss}</div>
                </div>
                <div className="border-t pt-3">
                  <p className="mb-2 text-sm font-medium">Environment Variables</p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {Object.entries(envInfo.data.env).map(([key, value]) => (
                      <div key={key} className="contents">
                        <div className="text-muted-foreground truncate">{key}</div>
                        <div className="font-mono text-xs">{value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Table Sizes */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Table Sizes
            </CardTitle>
            <CardDescription>Database storage by table</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {stats.data?.database.tables.map((table) => (
                <div key={table.table_name} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground font-mono">{table.table_name}</span>
                  <span className="font-mono">{table.total_size}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Log Explorer */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Log Explorer
          </CardTitle>
          <CardDescription>Supervised deployment logs</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {version.isLoading ? (
            <div className="text-muted-foreground text-sm">Checking deployment mode...</div>
          ) : !isSupervised ? (
            <div className="text-muted-foreground text-sm">{NON_SUPERVISED_MESSAGE}</div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={handleLogsRefresh}
                  disabled={logFiles.isFetching || logEntries.isFetching}
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
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

      {/* Actions */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5" />
            Data Management
          </CardTitle>
          <CardDescription>Clear data or reset the application</CardDescription>
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
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh Aggregates
            </Button>
            <Button variant="outline" onClick={() => queryClient.invalidateQueries()}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Clear Query Cache
            </Button>
          </div>

          <div className="border-t pt-4">
            <p className="text-muted-foreground mb-3 text-sm font-medium">Destructive Actions</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => handleDelete('violations', 'Delete all violation records')}
                disabled={deleteMutation.isPending}
              >
                Clear Violations
              </Button>
              <Button
                variant="outline"
                onClick={() => handleDelete('rules', 'Delete all detection rules and violations')}
                disabled={deleteMutation.isPending}
              >
                Clear Rules
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  handleDelete('termination-logs', 'Delete all stream termination logs')
                }
                disabled={deleteMutation.isPending}
              >
                Clear Termination Logs
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  handleDelete('library', 'Delete all library metadata cache (items and snapshots)')
                }
                disabled={deleteMutation.isPending}
              >
                Clear Library Cache
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
                Clear Sessions
              </Button>
              <Button
                variant="outline"
                className="border-destructive/50 text-destructive hover:bg-destructive/10"
                onClick={() => handleDelete('users', 'Delete all non-owner users and their data')}
                disabled={deleteMutation.isPending}
              >
                Clear Users
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
                Clear Servers
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
              Factory Reset
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
