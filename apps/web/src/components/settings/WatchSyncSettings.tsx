/**
 * Watch Sync Settings - Configure cross-server watch status synchronization
 */

import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Eye,
  Plus,
  Play,
  Trash2,
  Users,
  ArrowRight,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Settings2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format, formatDistanceToNow } from 'date-fns';
import { useServers } from '@/hooks/queries';
import {
  useWatchSyncConfigs,
  useCreateWatchSyncConfig,
  useUpdateWatchSyncConfig,
  useDeleteWatchSyncConfig,
  useTriggerWatchSync,
  useSyncSelectedItems,
  useWatchSyncUsers,
  useAddWatchSyncUserMapping,
  useRemoveWatchSyncUserMapping,
  useWatchSyncProgress,
  useWatchSyncHistory,
  watchSyncKeys,
} from '@/hooks/queries/useWatchSync';
import type {
  WatchSyncConfig,
  WatchSyncProgress,
  Server,
  ServerType,
  WatchSyncSkippedUser,
} from '@tracearr/shared';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';

// Add Config Dialog
function AddConfigDialog({
  open,
  onOpenChange,
  servers,
  existingConfigs,
  onConfigCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  servers: Server[];
  existingConfigs: WatchSyncConfig[];
  onConfigCreated?: (configId: string) => void;
}) {
  const [serverA, setServerA] = useState('');
  const [serverB, setServerB] = useState('');
  const [bidirectional, setBidirectional] = useState(true);
  const [intervalMinutes, setIntervalMinutes] = useState('60');
  const [isCreating, setIsCreating] = useState(false);
  const createConfig = useCreateWatchSyncConfig();

  // Check if a config already exists for a given pair
  const configExists = (sourceId: string, targetId: string) => {
    return existingConfigs.some(
      (c) => c.sourceServerId === sourceId && c.targetServerId === targetId
    );
  };

  const handleCreate = async () => {
    if (!serverA || !serverB) return;
    setIsCreating(true);
    const parsedInterval = Number.parseInt(intervalMinutes, 10);
    const safeInterval = Number.isFinite(parsedInterval)
      ? Math.min(10080, Math.max(5, parsedInterval))
      : 60;

    try {
      let firstCreatedConfigId: string | null = null;

      // Create first direction (A → B)
      if (!configExists(serverA, serverB)) {
        const result = await createConfig.mutateAsync({
          sourceServerId: serverA,
          targetServerId: serverB,
          intervalMinutes: safeInterval,
        });
        firstCreatedConfigId = result.config.id;
      }

      // Create second direction (B → A) if bidirectional
      if (bidirectional && !configExists(serverB, serverA)) {
        await createConfig.mutateAsync({
          sourceServerId: serverB,
          targetServerId: serverA,
          intervalMinutes: safeInterval,
        });
      }

      onOpenChange(false);
      setServerA('');
      setServerB('');
      setBidirectional(true);
      setIntervalMinutes('60');

      // Notify parent so it can open user mapping dialog
      if (firstCreatedConfigId && onConfigCreated) {
        onConfigCreated(firstCreatedConfigId);
      }
    } catch {
      // Error toast already shown by mutation
    } finally {
      setIsCreating(false);
    }
  };

  const availableServersB = servers.filter((s) => s.id !== serverA);
  const serverAName = servers.find((s) => s.id === serverA)?.name;
  const serverBName = servers.find((s) => s.id === serverB)?.name;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Watch Sync Configuration</DialogTitle>
          <DialogDescription>
            Set up watch status synchronization between two servers. Enable bidirectional sync to
            keep both servers in sync with each other.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>First Server</Label>
            <Select value={serverA} onValueChange={setServerA}>
              <SelectTrigger>
                <SelectValue placeholder="Select server" />
              </SelectTrigger>
              <SelectContent>
                {servers.map((server) => (
                  <SelectItem key={server.id} value={server.id}>
                    <div className="flex items-center gap-2">
                      <MediaServerIcon type={server.type} className="h-4 w-4" />
                      {server.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-center">
            <div className="text-muted-foreground flex items-center gap-2">
              {bidirectional ? (
                <>
                  <ArrowRight className="h-5 w-5" />
                  <ArrowRight className="h-5 w-5 rotate-180" />
                </>
              ) : (
                <ArrowRight className="h-5 w-5" />
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Second Server</Label>
            <Select value={serverB} onValueChange={setServerB} disabled={!serverA}>
              <SelectTrigger>
                <SelectValue placeholder="Select server" />
              </SelectTrigger>
              <SelectContent>
                {availableServersB.map((server) => (
                  <SelectItem key={server.id} value={server.id}>
                    <div className="flex items-center gap-2">
                      <MediaServerIcon type={server.type} className="h-4 w-4" />
                      {server.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between border-t pt-2">
            <div className="space-y-0.5">
              <Label htmlFor="bidirectional">Bidirectional Sync</Label>
              <p className="text-muted-foreground text-sm">Sync watch status in both directions</p>
            </div>
            <Switch id="bidirectional" checked={bidirectional} onCheckedChange={setBidirectional} />
          </div>

          <div className="space-y-2 border-t pt-2">
            <Label htmlFor="intervalMinutes">Sync Interval (minutes)</Label>
            <Input
              id="intervalMinutes"
              type="number"
              min={5}
              max={10080}
              step={5}
              value={intervalMinutes}
              onChange={(event) => setIntervalMinutes(event.target.value)}
            />
            <p className="text-muted-foreground text-sm">
              5–10,080 minutes (1 week). Default is 60 minutes.
            </p>
          </div>

          {serverA && serverB && (
            <div className="text-muted-foreground bg-muted rounded-md p-3 text-sm">
              {bidirectional ? (
                <>
                  This will create <strong>two configurations</strong>:
                  <ul className="mt-1 list-inside list-disc">
                    <li>
                      {serverAName} → {serverBName}
                    </li>
                    <li>
                      {serverBName} → {serverAName}
                    </li>
                  </ul>
                </>
              ) : (
                <>
                  This will sync watch status from <strong>{serverAName}</strong> to{' '}
                  <strong>{serverBName}</strong> only.
                </>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!serverA || !serverB || isCreating}>
            {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {bidirectional ? 'Create Configurations' : 'Create Configuration'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// User Mapping Dialog
function UserMappingDialog({
  open,
  onOpenChange,
  configId,
  sourceServerName,
  sourceServerType,
  targetServerName,
  targetServerType,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  configId: string;
  sourceServerName: string;
  sourceServerType: ServerType;
  targetServerName: string;
  targetServerType: ServerType;
}) {
  const { data: usersData, isLoading } = useWatchSyncUsers(configId);
  const addMapping = useAddWatchSyncUserMapping();
  const removeMapping = useRemoveWatchSyncUserMapping();
  const [selectedSource, setSelectedSource] = useState('');
  const [selectedTarget, setSelectedTarget] = useState('');

  const handleAddMapping = () => {
    if (!selectedSource || !selectedTarget) return;
    addMapping.mutate(
      {
        configId,
        data: { sourceServerUserId: selectedSource, targetServerUserId: selectedTarget },
      },
      {
        onSuccess: () => {
          setSelectedSource('');
          setSelectedTarget('');
        },
      }
    );
  };

  // Filter out already mapped users
  const mappedSourceIds = new Set(usersData?.mappings.map((m) => m.sourceServerUserId) ?? []);
  const mappedTargetIds = new Set(usersData?.mappings.map((m) => m.targetServerUserId) ?? []);
  const availableSourceUsers =
    usersData?.sourceUsers.filter((u) => !mappedSourceIds.has(u.id)) ?? [];
  const availableTargetUsers =
    usersData?.targetUsers.filter((u) => !mappedTargetIds.has(u.id)) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Manage User Mappings</DialogTitle>
          <DialogDescription>
            Map users between {sourceServerName} and {targetServerName}. Only mapped users will have
            their watch status synced.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Add new mapping */}
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-2">
              <Label className="flex items-center gap-1.5">
                <MediaServerIcon type={sourceServerType} className="h-4 w-4" />
                Source User ({sourceServerName})
              </Label>
              <Select value={selectedSource} onValueChange={setSelectedSource}>
                <SelectTrigger>
                  <SelectValue placeholder="Select user" />
                </SelectTrigger>
                <SelectContent>
                  {availableSourceUsers.map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.username}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <ArrowRight className="text-muted-foreground mb-2 h-5 w-5" />

            <div className="flex-1 space-y-2">
              <Label className="flex items-center gap-1.5">
                <MediaServerIcon type={targetServerType} className="h-4 w-4" />
                Target User ({targetServerName})
              </Label>
              <Select value={selectedTarget} onValueChange={setSelectedTarget}>
                <SelectTrigger>
                  <SelectValue placeholder="Select user" />
                </SelectTrigger>
                <SelectContent>
                  {availableTargetUsers.map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.username}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              onClick={handleAddMapping}
              disabled={!selectedSource || !selectedTarget || addMapping.isPending}
              size="sm"
            >
              {addMapping.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
            </Button>
          </div>

          {/* Existing mappings */}
          <div className="space-y-2">
            <Label>Current Mappings</Label>
            {/* Warning for missing Plex tokens */}
            {usersData?.mappings.some((m) => m.sourceMissingToken || m.targetMissingToken) && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div>
                  <p className="font-medium text-amber-500">Plex users missing access tokens</p>
                  <p className="text-muted-foreground mt-1">
                    Some Plex users don't have their server tokens synced and{' '}
                    <strong>will be skipped</strong> during sync. Go to{' '}
                    <Link to="/settings/servers" className="text-primary hover:underline">
                      Settings → Connected Servers
                    </Link>{' '}
                    and sync your Plex server to fix this.
                  </p>
                </div>
              </div>
            )}
            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : usersData?.mappings.length === 0 ? (
              <div className="text-muted-foreground rounded-md border py-4 text-center text-sm">
                No user mappings configured. Add mappings above to enable watch sync for users.
              </div>
            ) : (
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {usersData?.mappings.map((mapping) => (
                  <div
                    key={mapping.id}
                    className="flex items-center justify-between rounded-md border p-2"
                  >
                    <div className="flex items-center gap-2">
                      <MediaServerIcon type={sourceServerType} className="h-4 w-4" />
                      <span
                        className={cn(
                          'font-medium',
                          mapping.sourceMissingToken && 'text-amber-500'
                        )}
                      >
                        {mapping.sourceUsername}
                        {mapping.sourceMissingToken && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <AlertTriangle className="ml-1 inline h-3 w-3" />
                            </TooltipTrigger>
                            <TooltipContent>
                              Missing Plex token - will be skipped. Sync Plex in Connected Servers.
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </span>
                      <ArrowRight className="text-muted-foreground h-4 w-4" />
                      <MediaServerIcon type={targetServerType} className="h-4 w-4" />
                      <span
                        className={cn(
                          'font-medium',
                          mapping.targetMissingToken && 'text-amber-500'
                        )}
                      >
                        {mapping.targetUsername}
                        {mapping.targetMissingToken && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <AlertTriangle className="ml-1 inline h-3 w-3" />
                            </TooltipTrigger>
                            <TooltipContent>
                              Missing Plex token - will be skipped. Sync Plex in Connected Servers.
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeMapping.mutate({ configId, mappingId: mapping.id })}
                      disabled={removeMapping.isPending}
                    >
                      <Trash2 className="text-destructive h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Config Card
function ConfigCard({
  config,
  servers,
  initialShowUserMapping = false,
  onUserMappingClosed,
}: {
  config: WatchSyncConfig;
  servers: Server[];
  initialShowUserMapping?: boolean;
  onUserMappingClosed?: () => void;
}) {
  const [showUserMapping, setShowUserMapping] = useState(initialShowUserMapping);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [intervalValue, setIntervalValue] = useState(String(config.intervalMinutes));
  const updateConfig = useUpdateWatchSyncConfig();
  const deleteConfig = useDeleteWatchSyncConfig();
  const triggerSync = useTriggerWatchSync();
  const { data: usersData, isLoading: usersLoading } = useWatchSyncUsers(config.id);

  const sourceServer = servers.find((s) => s.id === config.sourceServerId);
  const targetServer = servers.find((s) => s.id === config.targetServerId);
  const hasMissingTokens = usersData?.mappings.some(
    (m) => m.sourceMissingToken || m.targetMissingToken
  );
  const hasNoMappings = !usersLoading && (usersData?.mappings.length ?? 0) === 0;

  // Sync initialShowUserMapping prop changes
  useEffect(() => {
    if (initialShowUserMapping) {
      setShowUserMapping(true);
    }
  }, [initialShowUserMapping]);

  const handleUserMappingClose = (open: boolean) => {
    setShowUserMapping(open);
    if (!open && onUserMappingClosed) {
      onUserMappingClosed();
    }
  };

  useEffect(() => {
    setIntervalValue(String(config.intervalMinutes));
  }, [config.intervalMinutes]);

  const handleToggle = (field: string, value: boolean) => {
    updateConfig.mutate({ id: config.id, data: { [field]: value } });
  };

  const commitInterval = () => {
    const parsed = Number.parseInt(intervalValue, 10);
    if (!Number.isFinite(parsed)) {
      setIntervalValue(String(config.intervalMinutes));
      return;
    }
    const nextValue = Math.min(10080, Math.max(5, parsed));
    if (nextValue !== config.intervalMinutes) {
      updateConfig.mutate({ id: config.id, data: { intervalMinutes: nextValue } });
    }
    setIntervalValue(String(nextValue));
  };
  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                {sourceServer && (
                  <>
                    <MediaServerIcon type={sourceServer.type} className="h-5 w-5" />
                    <span className="font-medium">{sourceServer.name}</span>
                  </>
                )}
              </div>
              <ArrowRight className="text-muted-foreground h-5 w-5" />
              <div className="flex items-center gap-2">
                {targetServer && (
                  <>
                    <MediaServerIcon type={targetServer.type} className="h-5 w-5" />
                    <span className="font-medium">{targetServer.name}</span>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {!config.dryRun && config.enabled && (
                <Badge variant="outline" className="border-amber-600 text-amber-600">
                  <AlertTriangle className="mr-1 h-3 w-3" />
                  Auto Sync
                </Badge>
              )}
              <Switch
                checked={config.enabled}
                onCheckedChange={(checked) => handleToggle('enabled', checked)}
              />
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Sync options */}
          <div className="flex flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <Switch
                id={`movies-${config.id}`}
                checked={config.syncMovies}
                onCheckedChange={(checked) => handleToggle('syncMovies', checked)}
              />
              <Label htmlFor={`movies-${config.id}`} className="text-sm">
                Movies
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id={`shows-${config.id}`}
                checked={config.syncShows}
                onCheckedChange={(checked) => handleToggle('syncShows', checked)}
              />
              <Label htmlFor={`shows-${config.id}`} className="text-sm">
                Shows
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id={`progress-${config.id}`}
                checked={config.syncInProgress}
                onCheckedChange={(checked) => handleToggle('syncInProgress', checked)}
              />
              <Label htmlFor={`progress-${config.id}`} className="text-sm">
                In Progress
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id={`autosync-${config.id}`}
                checked={!config.dryRun}
                onCheckedChange={(checked) => handleToggle('dryRun', !checked)}
              />
              <Label
                htmlFor={`autosync-${config.id}`}
                className={cn('text-sm', !config.dryRun && 'font-medium text-amber-600')}
              >
                Auto Sync
              </Label>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Label htmlFor={`interval-${config.id}`} className="text-muted-foreground text-sm">
              Interval (minutes)
            </Label>
            <Input
              id={`interval-${config.id}`}
              type="number"
              min={5}
              max={10080}
              step={5}
              value={intervalValue}
              onChange={(event) => setIntervalValue(event.target.value)}
              onBlur={commitInterval}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur();
                }
              }}
              className="h-8 w-24"
            />
          </div>

          {/* Last sync info */}
          {config.lastSyncAt && (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Clock className="h-4 w-4" />
              Last sync: {formatDistanceToNow(new Date(config.lastSyncAt), { addSuffix: true })}
              {config.lastSyncResult && (
                <span>
                  ({config.lastSyncResult.synced} synced, {config.lastSyncResult.skipped} skipped)
                </span>
              )}
            </div>
          )}

          {/* No user mappings warning */}
          {hasNoMappings && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <div>
                <p className="font-medium text-amber-500">No user mappings configured</p>
                <p className="text-muted-foreground mt-1">
                  Add at least one user mapping before running a sync.
                </p>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 border-t pt-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={hasNoMappings ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setShowUserMapping(true)}
                  className={cn(
                    hasNoMappings && 'animate-pulse',
                    hasMissingTokens && !hasNoMappings && 'border-amber-500/50'
                  )}
                >
                  <Users className="mr-2 h-4 w-4" />
                  User Mappings
                  {hasMissingTokens && !hasNoMappings && (
                    <AlertTriangle className="ml-1 h-3 w-3 text-amber-500" />
                  )}
                </Button>
              </TooltipTrigger>
              {hasMissingTokens && !hasNoMappings && (
                <TooltipContent>
                  Some users missing Plex tokens - will be skipped. Sync Plex in Connected Servers.
                </TooltipContent>
              )}
              {hasNoMappings && <TooltipContent>Add user mappings to enable sync</TooltipContent>}
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => triggerSync.mutate(config.id)}
                    disabled={triggerSync.isPending || !config.enabled || hasNoMappings}
                  >
                    {triggerSync.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="mr-2 h-4 w-4" />
                    )}
                    {config.dryRun ? 'Run Preview' : 'Sync Now'}
                  </Button>
                </span>
              </TooltipTrigger>
              {hasNoMappings && (
                <TooltipContent>Add user mappings before running sync</TooltipContent>
              )}
            </Tooltip>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive ml-auto"
              onClick={() => setShowDeleteConfirm(true)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* User Mapping Dialog */}
      <UserMappingDialog
        open={showUserMapping}
        onOpenChange={handleUserMappingClose}
        configId={config.id}
        sourceServerName={sourceServer?.name ?? 'Source'}
        sourceServerType={sourceServer?.type ?? 'plex'}
        targetServerName={targetServer?.name ?? 'Target'}
        targetServerType={targetServer?.type ?? 'jellyfin'}
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete Sync Configuration"
        description="Are you sure you want to delete this sync configuration? This will stop all scheduled syncs and remove user mappings."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => deleteConfig.mutate(config.id)}
        isLoading={deleteConfig.isPending}
      />
    </>
  );
}

// Preview item type with targetServerItemId
interface PreviewItem {
  title: string;
  sourceTitle?: string;
  targetTitle?: string;
  type: 'movie' | 'episode';
  year?: number;
  showTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  sourceServer: string;
  targetServer: string;
  sourceLibrary?: string;
  targetLibrary?: string;
  sourceServerUserId: string;
  targetServerUserId: string;
  sourceUsername: string;
  targetUsername: string;
  targetServerItemId?: string;
  action: 'mark_watched' | 'update_progress';
  sourceProgress?: number;
  targetProgress?: number;
  sourceProgressMs?: number;
  targetProgressMs?: number;
  sourceDurationMs?: number;
  targetDurationMs?: number;
  sourceViewedAt?: string;
  targetViewedAt?: string;
}

// Sync Status Card - Always visible, shows current progress or last run
function SyncStatusCard({
  progress,
  history,
  configs,
  servers,
}: {
  progress: WatchSyncProgress | null | undefined;
  history:
    | Array<{
        jobId: string;
        configId: string;
        state: string;
        manual?: boolean;
        createdAt: number;
        finishedAt?: number;
        result?: {
          success: boolean;
          synced: number;
          skipped: number;
          errors: number;
          durationMs: number;
          message: string;
          timestamp: string;
          previewItems?: PreviewItem[];
          dryRunItems?: PreviewItem[];
          skippedUsers?: WatchSyncSkippedUser[];
        };
      }>
    | undefined;
  configs: WatchSyncConfig[];
  servers: Server[];
}) {
  // Selection state for preview items
  const [selectedItems, setSelectedItems] = useState<Set<number>>(new Set());
  // Track items that have been synced (to hide them from the list)
  const [syncedItems, setSyncedItems] = useState<Set<number>>(new Set());
  const syncSelected = useSyncSelectedItems();

  // Check if there's an active sync
  const isActive = progress && (progress.status !== 'idle' || progress.message);

  // Get the most recent completed job from history
  const lastRun = history?.[0];
  const lastRunJobId = lastRun?.jobId;
  const lastRunConfig = lastRun ? configs.find((c) => c.id === lastRun.configId) : null;
  const lastRunSourceServer = lastRunConfig
    ? servers.find((s) => s.id === lastRunConfig.sourceServerId)
    : null;
  const lastRunTargetServer = lastRunConfig
    ? servers.find((s) => s.id === lastRunConfig.targetServerId)
    : null;
  // Support both previewItems and dryRunItems (for backward compat)
  const previewItems = lastRun?.result?.previewItems || lastRun?.result?.dryRunItems;
  // Count remaining items (excluding synced)
  const remainingCount = (previewItems?.length ?? 0) - syncedItems.size;
  const hasPreviewItems = remainingCount > 0;

  // Reset synced items when a new preview job runs
  useEffect(() => {
    setSyncedItems(new Set());
    setSelectedItems(new Set());
  }, [lastRunJobId]);

  // Handle selection toggle
  const toggleSelection = (index: number) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  // Select/deselect all (excluding synced items)
  const toggleSelectAll = () => {
    if (!previewItems) return;
    const unsyncedIndices = previewItems.map((_, i) => i).filter((i) => !syncedItems.has(i));
    if (selectedItems.size === unsyncedIndices.length) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(unsyncedIndices));
    }
  };

  // Handle sync selected items
  const handleSyncSelected = () => {
    if (!lastRunConfig || !previewItems || selectedItems.size === 0) return;

    const itemsToSync = Array.from(selectedItems)
      .map((index) => previewItems[index])
      .filter((item): item is PreviewItem => !!item && !!item.targetServerItemId)
      .map((item) => ({
        targetServerItemId: item.targetServerItemId!,
        targetServerUserId: item.targetServerUserId,
        action: item.action,
        sourceProgressMs: item.sourceProgressMs,
        sourceViewedAt: item.sourceViewedAt,
        sourceTitle: item.sourceTitle || item.title,
      }));

    if (itemsToSync.length === 0) {
      toast.error('Cannot sync selected items', {
        description: 'Selected items are missing required data. Try running a new preview.',
      });
      return;
    }

    // Track which indices we're syncing (for marking as synced on success)
    const indicesToSync = Array.from(selectedItems).filter(
      (index) => previewItems?.[index]?.targetServerItemId
    );

    syncSelected.mutate(
      { configId: lastRunConfig.id, items: itemsToSync },
      {
        onSuccess: () => {
          // Mark these items as synced (to hide them from the list)
          setSyncedItems((prev) => new Set([...prev, ...indicesToSync]));
          setSelectedItems(new Set());
        },
      }
    );
  };

  // Count selected items that can be synced (have targetServerItemId, not already synced)
  const selectedSyncableCount = Array.from(selectedItems).filter(
    (index) => previewItems?.[index]?.targetServerItemId && !syncedItems.has(index)
  ).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-5 w-5" />
          Sync Status
        </CardTitle>
        <CardDescription>Recent sync activity and progress</CardDescription>
      </CardHeader>
      <CardContent>
        {isActive && progress ? (
          // Show active sync progress
          <ActiveSyncProgress progress={progress} />
        ) : lastRun ? (
          // Show last run results
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                {lastRun.state === 'completed' && lastRun.result?.success ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-red-500" />
                )}
                <span className="font-medium">
                  {lastRun.state === 'completed' && lastRun.result?.success
                    ? 'Last sync completed'
                    : 'Last sync failed'}
                </span>
                {hasPreviewItems && (
                  <Badge variant="outline" className="border-blue-600 text-xs text-blue-600">
                    Preview
                  </Badge>
                )}
              </div>
              <span className="text-muted-foreground text-sm">
                {lastRun.finishedAt
                  ? formatDistanceToNow(new Date(lastRun.finishedAt), { addSuffix: true })
                  : 'Unknown'}
              </span>
            </div>

            {lastRunSourceServer && lastRunTargetServer && (
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <MediaServerIcon type={lastRunSourceServer.type} className="h-4 w-4" />
                <span>{lastRunSourceServer.name}</span>
                <ArrowRight className="h-4 w-4" />
                <MediaServerIcon type={lastRunTargetServer.type} className="h-4 w-4" />
                <span>{lastRunTargetServer.name}</span>
                {lastRun.manual && (
                  <Badge variant="outline" className="ml-2 text-xs">
                    Manual
                  </Badge>
                )}
              </div>
            )}

            {lastRun.result && (
              <div className="grid grid-cols-4 gap-2 border-t pt-2 text-center text-sm">
                <div>
                  <div className="font-semibold">
                    {lastRun.result.synced + lastRun.result.skipped}
                  </div>
                  <div className="text-muted-foreground text-xs">Total</div>
                </div>
                <div>
                  <div className="font-semibold text-green-600">{lastRun.result.synced}</div>
                  <div className="text-muted-foreground text-xs">
                    {hasPreviewItems ? 'Ready' : 'Synced'}
                  </div>
                </div>
                <div>
                  <div className="font-semibold text-yellow-600">{lastRun.result.skipped}</div>
                  <div className="text-muted-foreground text-xs">Skipped</div>
                </div>
                <div>
                  <div className="font-semibold text-red-600">{lastRun.result.errors}</div>
                  <div className="text-muted-foreground text-xs">Errors</div>
                </div>
              </div>
            )}

            {/* Skipped users warning */}
            {lastRun.result?.skippedUsers && lastRun.result.skippedUsers.length > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div className="space-y-1">
                  <p className="font-medium text-amber-500">
                    {lastRun.result.skippedUsers.length} user
                    {lastRun.result.skippedUsers.length > 1 ? 's' : ''} skipped
                  </p>
                  <ul className="text-muted-foreground space-y-0.5 text-xs">
                    {lastRun.result.skippedUsers.map((user, idx) => {
                      const [sourceUser, targetUser] = user.username.split(' → ');
                      // Show the Plex user (whichever side is Plex)
                      const plexUser =
                        lastRunSourceServer?.type === 'plex' ? sourceUser : targetUser;
                      return (
                        <li key={idx} className="flex flex-wrap items-center gap-1">
                          {user.reason === 'missing_token' ? (
                            <>
                              <span>User mapping</span>
                              <MediaServerIcon type="plex" className="inline h-3 w-3 shrink-0" />
                              <span className="font-medium">{plexUser || 'Unknown'}</span>
                              <span>
                                is missing a Plex token,{' '}
                                <Link
                                  to="/settings/servers"
                                  className="text-primary hover:underline"
                                >
                                  sync Plex server
                                </Link>{' '}
                                to fix
                              </span>
                            </>
                          ) : (
                            <>
                              <span>User mapping</span>
                              <span className="font-medium">{sourceUser}</span>
                              <ArrowRight className="text-muted-foreground h-3 w-3 shrink-0" />
                              <span className="font-medium">{targetUser || 'Unknown'}</span>
                              <span>— {user.error || 'fetch failed'}</span>
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            )}

            {/* Show message only if NOT a preview with items (avoid redundancy) */}
            {lastRun.result?.message && !hasPreviewItems && (
              <div className="text-muted-foreground text-sm">{lastRun.result.message}</div>
            )}

            {/* Preview Items List - Always visible when present */}
            {hasPreviewItems && previewItems && (
              <div className="space-y-2 border-t pt-2">
                {/* Header with actions */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="select-all"
                      checked={selectedItems.size === remainingCount && remainingCount > 0}
                      onCheckedChange={toggleSelectAll}
                    />
                    <label htmlFor="select-all" className="cursor-pointer text-sm font-medium">
                      {syncedItems.size > 0
                        ? selectedItems.size > 0
                          ? `${selectedItems.size} selected · ${syncedItems.size} synced`
                          : `${remainingCount} remaining · ${syncedItems.size} synced`
                        : selectedItems.size > 0
                          ? `${selectedItems.size} of ${remainingCount} selected`
                          : `${remainingCount} items ready to sync`}
                    </label>
                  </div>
                  <Button
                    size="sm"
                    onClick={handleSyncSelected}
                    disabled={selectedSyncableCount === 0 || syncSelected.isPending}
                  >
                    {syncSelected.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="mr-2 h-4 w-4" />
                    )}
                    Sync Selected ({selectedSyncableCount})
                  </Button>
                </div>

                {/* Compact Row View - Mobile only */}
                <div className="max-h-80 space-y-1 overflow-y-auto md:hidden">
                  {previewItems.map((item, index) => {
                    // Skip synced items
                    if (syncedItems.has(index)) return null;

                    const sourceProgress = item.sourceProgress ?? 0;
                    const targetProgress = item.targetProgress ?? 0;
                    const sourceIsWatched = sourceProgress >= 100;
                    const targetIsWatched = targetProgress >= 100;
                    const sourceLabel = sourceIsWatched ? '✓' : `${sourceProgress}%`;
                    const targetLabel = targetIsWatched ? '✓' : `${targetProgress}%`;
                    const hasSourceProgressDetails =
                      item.sourceProgressMs !== undefined || item.sourceDurationMs !== undefined;
                    const hasTargetProgressDetails =
                      item.targetProgressMs !== undefined || item.targetDurationMs !== undefined;

                    // Convert ms to HH:MM:SS format
                    const formatTime = (ms: number | undefined) => {
                      if (ms === undefined) return '0:00:00';
                      const totalSeconds = Math.floor(ms / 1000);
                      const hours = Math.floor(totalSeconds / 3600);
                      const minutes = Math.floor((totalSeconds % 3600) / 60);
                      const seconds = totalSeconds % 60;
                      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                    };

                    // Use new fields with fallback to legacy title
                    const srcTitle = item.sourceTitle || item.title;
                    const tgtTitle = item.targetTitle || item.title;
                    const titlesMatch = srcTitle === tgtTitle;

                    const isSelected = selectedItems.has(index);
                    const canSync = !!item.targetServerItemId;

                    return (
                      <div
                        key={index}
                        className={cn(
                          'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors',
                          isSelected ? 'bg-primary/10' : 'bg-muted/50 hover:bg-muted'
                        )}
                        onClick={() => canSync && toggleSelection(index)}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => canSync && toggleSelection(index)}
                          disabled={!canSync}
                          className="shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className="min-w-0 flex-1">
                          {titlesMatch ? (
                            <span className="block truncate font-medium">{srcTitle}</span>
                          ) : (
                            <span className="block truncate font-medium">
                              {srcTitle} <span className="text-muted-foreground">→</span> {tgtTitle}
                            </span>
                          )}
                          <div className="text-muted-foreground flex items-center gap-1 text-xs">
                            <Link
                              to={`/users/${item.sourceServerUserId}`}
                              className="hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              @{item.sourceUsername}
                            </Link>
                            {item.sourceViewedAt ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="cursor-help underline decoration-dotted underline-offset-2">
                                    {formatDistanceToNow(new Date(item.sourceViewedAt), {
                                      addSuffix: true,
                                    })}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  <span className="text-xs">
                                    {format(new Date(item.sourceViewedAt), 'PPpp')}
                                  </span>
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              <span>never</span>
                            )}
                            <span>→</span>
                            <Link
                              to={`/users/${item.targetServerUserId}`}
                              className="hover:underline"
                            >
                              @{item.targetUsername}
                            </Link>
                            {item.targetViewedAt ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="cursor-help underline decoration-dotted underline-offset-2">
                                    {formatDistanceToNow(new Date(item.targetViewedAt), {
                                      addSuffix: true,
                                    })}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  <span className="text-xs">
                                    {format(new Date(item.targetViewedAt), 'PPpp')}
                                  </span>
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              <span>never</span>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {lastRunSourceServer && (
                            <MediaServerIcon type={lastRunSourceServer.type} className="h-4 w-4" />
                          )}
                          <span className="text-muted-foreground max-w-[80px] truncate">
                            {item.sourceLibrary || item.sourceServer}
                          </span>
                          {hasSourceProgressDetails ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className={cn(
                                    'cursor-help font-mono underline decoration-dotted underline-offset-2',
                                    sourceIsWatched ? 'text-green-600' : 'text-blue-600'
                                  )}
                                >
                                  {sourceLabel}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                <span className="text-xs">
                                  {formatTime(item.sourceProgressMs)} watched of{' '}
                                  {formatTime(item.sourceDurationMs)}
                                </span>
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <span
                              className={cn(
                                'font-mono',
                                sourceIsWatched ? 'text-green-600' : 'text-blue-600'
                              )}
                            >
                              {sourceLabel}
                            </span>
                          )}
                          <ArrowRight className="text-muted-foreground h-4 w-4" />
                          {lastRunTargetServer && (
                            <MediaServerIcon type={lastRunTargetServer.type} className="h-4 w-4" />
                          )}
                          <span className="text-muted-foreground max-w-[80px] truncate">
                            {item.targetLibrary || item.targetServer}
                          </span>
                          {hasTargetProgressDetails ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className={cn(
                                    'cursor-help font-mono underline decoration-dotted underline-offset-2',
                                    targetIsWatched ? 'text-green-600' : 'text-muted-foreground'
                                  )}
                                >
                                  {targetLabel}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                <span className="text-xs">
                                  {formatTime(item.targetProgressMs)} watched of{' '}
                                  {formatTime(item.targetDurationMs)}
                                </span>
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <span
                              className={cn(
                                'font-mono',
                                targetIsWatched ? 'text-green-600' : 'text-muted-foreground'
                              )}
                            >
                              {targetLabel}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Card View - Desktop only */}
                <div className="hidden max-h-96 space-y-3 overflow-y-auto md:block">
                  {previewItems.map((item, index) => {
                    // Skip synced items
                    if (syncedItems.has(index)) return null;

                    const sourceProgress = item.sourceProgress ?? 0;
                    const targetProgress = item.targetProgress ?? 0;
                    const sourceIsWatched = sourceProgress >= 100;
                    const targetIsWatched = targetProgress >= 100;
                    const isSelected = selectedItems.has(index);
                    const canSync = !!item.targetServerItemId;

                    const formatTime = (ms: number | undefined) => {
                      if (ms === undefined) return '0:00:00';
                      const totalSeconds = Math.floor(ms / 1000);
                      const hours = Math.floor(totalSeconds / 3600);
                      const minutes = Math.floor((totalSeconds % 3600) / 60);
                      const seconds = totalSeconds % 60;
                      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                    };

                    const srcTitle = item.sourceTitle || item.title;
                    const tgtTitle = item.targetTitle || item.title;

                    return (
                      <div
                        key={index}
                        className={cn(
                          'flex cursor-pointer items-stretch gap-2 rounded-lg p-1 transition-colors',
                          isSelected ? 'bg-primary/10' : 'hover:bg-muted/50'
                        )}
                        onClick={() => canSync && toggleSelection(index)}
                      >
                        {/* Checkbox */}
                        <div className="flex items-center px-1">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => canSync && toggleSelection(index)}
                            disabled={!canSync}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                        {/* Source Card */}
                        <div className="bg-muted/50 flex-1 rounded-lg border p-2 text-sm">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              {lastRunSourceServer && (
                                <MediaServerIcon
                                  type={lastRunSourceServer.type}
                                  className="h-4 w-4"
                                />
                              )}
                              <span className="font-medium">
                                {item.sourceLibrary || item.sourceServer}
                              </span>
                              <Link
                                to={`/users/${item.sourceServerUserId}`}
                                className="text-muted-foreground hover:underline"
                              >
                                @{item.sourceUsername}
                              </Link>
                            </div>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="text-foreground flex cursor-help items-center gap-1 font-bold underline decoration-dotted underline-offset-2">
                                  {sourceProgress}%
                                  {sourceIsWatched && (
                                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                                  )}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                <span className="text-xs">
                                  {formatTime(item.sourceProgressMs)} watched of{' '}
                                  {formatTime(item.sourceDurationMs)}
                                </span>
                              </TooltipContent>
                            </Tooltip>
                          </div>
                          <div className="mt-1 flex items-center justify-between">
                            <span className="mr-2 truncate font-medium">{srcTitle}</span>
                            {item.sourceViewedAt ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="text-muted-foreground shrink-0 cursor-help text-xs underline decoration-dotted underline-offset-2">
                                    {formatDistanceToNow(new Date(item.sourceViewedAt), {
                                      addSuffix: true,
                                    })}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  <span className="text-xs">
                                    {format(new Date(item.sourceViewedAt), 'PPpp')}
                                  </span>
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              <span className="text-muted-foreground shrink-0 text-xs">never</span>
                            )}
                          </div>
                        </div>

                        {/* Arrow */}
                        <div className="flex items-center">
                          <ArrowRight className="text-muted-foreground h-5 w-5" />
                        </div>

                        {/* Target Card */}
                        <div className="bg-muted/50 flex-1 rounded-lg border p-2 text-sm">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              {lastRunTargetServer && (
                                <MediaServerIcon
                                  type={lastRunTargetServer.type}
                                  className="h-4 w-4"
                                />
                              )}
                              <span className="font-medium">
                                {item.targetLibrary || item.targetServer}
                              </span>
                              <Link
                                to={`/users/${item.targetServerUserId}`}
                                className="text-muted-foreground hover:underline"
                              >
                                @{item.targetUsername}
                              </Link>
                            </div>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="text-foreground flex cursor-help items-center gap-1 font-bold underline decoration-dotted underline-offset-2">
                                  {targetProgress}%
                                  {targetIsWatched && (
                                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                                  )}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                <span className="text-xs">
                                  {formatTime(item.targetProgressMs)} watched of{' '}
                                  {formatTime(item.targetDurationMs)}
                                </span>
                              </TooltipContent>
                            </Tooltip>
                          </div>
                          <div className="mt-1 flex items-center justify-between">
                            <span className="mr-2 truncate font-medium">{tgtTitle}</span>
                            {item.targetViewedAt ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="text-muted-foreground shrink-0 cursor-help text-xs underline decoration-dotted underline-offset-2">
                                    {formatDistanceToNow(new Date(item.targetViewedAt), {
                                      addSuffix: true,
                                    })}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  <span className="text-xs">
                                    {format(new Date(item.targetViewedAt), 'PPpp')}
                                  </span>
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              <span className="text-muted-foreground shrink-0 text-xs">never</span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          // No syncs have run yet
          <div className="flex h-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed">
            <Clock className="text-muted-foreground h-4 w-4" />
            <p className="text-muted-foreground text-xs">No syncs have run yet</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Active sync progress display (used within SyncStatusCard)
function ActiveSyncProgress({ progress }: { progress: WatchSyncProgress }) {
  const statusColors: Record<string, string> = {
    idle: 'text-muted-foreground',
    fetching_source: 'text-blue-500',
    fetching_target: 'text-blue-500',
    matching: 'text-yellow-500',
    syncing: 'text-yellow-500',
    complete: 'text-green-500',
    error: 'text-red-500',
  };

  const statusLabels: Record<string, string> = {
    idle: 'Queued',
    fetching_source: 'Fetching from source...',
    fetching_target: 'Fetching from target...',
    matching: 'Matching items...',
    syncing: 'Syncing items...',
    complete: 'Complete',
    error: 'Error',
  };

  const percentage =
    progress.totalItems > 0 ? Math.round((progress.processedItems / progress.totalItems) * 100) : 0;

  const statusDisplay = progress.message || statusLabels[progress.status];
  const isQueued = progress.status === 'idle' && progress.message;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {progress.status === 'complete' ? (
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          ) : progress.status === 'error' ? (
            <AlertTriangle className="h-4 w-4 text-red-500" />
          ) : isQueued ? (
            <Clock className="text-muted-foreground h-4 w-4" />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin" />
          )}
          <span className="text-sm font-medium">
            {isQueued ? 'Sync Queued' : 'Sync in Progress'}
          </span>
        </div>
        {progress.dryRun && (
          <Badge variant="outline" className="border-blue-600 text-xs text-blue-600">
            Preview
          </Badge>
        )}
      </div>

      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        {progress.sourceServer} → {progress.targetServer}
      </div>

      <div className="flex justify-between text-sm">
        <span className={statusColors[progress.status]}>{statusDisplay}</span>
        <span>{percentage}%</span>
      </div>

      <div className="bg-secondary h-2 w-full rounded-full">
        <div
          className={cn(
            'h-2 rounded-full transition-all duration-300',
            progress.status === 'error' ? 'bg-red-500' : 'bg-primary'
          )}
          style={{ width: `${percentage}%` }}
        />
      </div>

      <div className="grid grid-cols-4 gap-2 text-center text-sm">
        <div>
          <div className="font-semibold">{progress.totalItems}</div>
          <div className="text-muted-foreground text-xs">Total</div>
        </div>
        <div>
          <div className="font-semibold text-green-600">{progress.syncedItems}</div>
          <div className="text-muted-foreground text-xs">Synced</div>
        </div>
        <div>
          <div className="font-semibold text-yellow-600">{progress.skippedItems}</div>
          <div className="text-muted-foreground text-xs">Skipped</div>
        </div>
        <div>
          <div className="font-semibold text-red-600">{progress.errorCount}</div>
          <div className="text-muted-foreground text-xs">Errors</div>
        </div>
      </div>
    </div>
  );
}

// Main Component
export function WatchSyncSettings() {
  const [showAddDialog, setShowAddDialog] = useState(false);
  // Track which config should show user mapping dialog (after creation)
  const [openUserMappingForConfigId, setOpenUserMappingForConfigId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: configs, isLoading: configsLoading } = useWatchSyncConfigs();
  const { data: servers = [], isLoading: serversLoading } = useServers();
  const { data: progressData } = useWatchSyncProgress();
  const { data: historyData } = useWatchSyncHistory();
  const progress = progressData?.progress;
  const isLoading = configsLoading || serversLoading;

  // Handle config created - open user mapping dialog for it
  const handleConfigCreated = (configId: string) => {
    setOpenUserMappingForConfigId(configId);
  };

  // Track previous progress status to detect completion
  const prevStatusRef = useRef<string | undefined>(undefined);

  // Refetch history when sync completes
  useEffect(() => {
    const currentStatus = progress?.status;
    const prevStatus = prevStatusRef.current;

    // Sync is considered "just finished" if:
    // 1. Status transitioned TO 'complete' or 'error' from an active state, OR
    // 2. Status went from an active state to undefined/null (progress cleared after completion)
    const wasActive =
      prevStatus && prevStatus !== 'complete' && prevStatus !== 'error' && prevStatus !== 'idle';
    const isNowDone =
      currentStatus === 'complete' || currentStatus === 'error' || currentStatus === undefined;

    if (wasActive && isNowDone) {
      // Sync just finished - refetch history and configs to get updated lastSyncAt
      void queryClient.invalidateQueries({ queryKey: watchSyncKeys.history() });
      void queryClient.invalidateQueries({ queryKey: watchSyncKeys.configs() });
    }

    prevStatusRef.current = currentStatus;
  }, [progress?.status, queryClient]);

  // Need at least 2 servers for watch sync
  const canCreateConfig = servers.length >= 2;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-20 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5" />
                Watch Status Sync
              </CardTitle>
              <CardDescription>
                Synchronize watch history between your media servers
              </CardDescription>
            </div>
            <Button onClick={() => setShowAddDialog(true)} disabled={!canCreateConfig} size="sm">
              <Plus className="mr-2 h-4 w-4" />
              Add Configuration
            </Button>
          </div>
          {!canCreateConfig && (
            <p className="text-muted-foreground mt-2 text-sm">
              Add at least 2 servers to enable watch sync
            </p>
          )}
        </CardHeader>
        {configs?.length === 0 && (
          <CardContent>
            <div className="flex h-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed">
              <Settings2 className="text-muted-foreground h-4 w-4" />
              <p className="text-muted-foreground text-xs">No sync configurations yet</p>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Configurations */}
      {(configs?.length ?? 0) > 0 && (
        <div className="space-y-4">
          {configs?.map((config) => (
            <ConfigCard
              key={config.id}
              config={config}
              servers={servers}
              initialShowUserMapping={openUserMappingForConfigId === config.id}
              onUserMappingClosed={() => setOpenUserMappingForConfigId(null)}
            />
          ))}
        </div>
      )}

      {/* Auto Sync Warning - Show when auto sync is enabled (dryRun is false) */}
      {configs?.some((c) => !c.dryRun && c.enabled) && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="text-sm">
            <p className="font-medium text-amber-600">Auto Sync Active</p>
            <p className="text-muted-foreground mt-1 text-xs">
              One or more configurations will automatically sync watch status without approval.
              Disable Auto Sync if you want to preview and approve items before syncing.
            </p>
          </div>
        </div>
      )}

      {/* Sync Status - Always visible */}
      <SyncStatusCard
        progress={progress}
        history={historyData?.history}
        configs={configs ?? []}
        servers={servers}
      />

      {/* Add Dialog */}
      <AddConfigDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        servers={servers}
        existingConfigs={configs ?? []}
        onConfigCreated={handleConfigCreated}
      />
    </div>
  );
}
