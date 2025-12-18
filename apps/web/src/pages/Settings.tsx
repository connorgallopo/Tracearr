import { useState, useEffect } from 'react';
import { NavLink, Routes, Route } from 'react-router';
import { QRCodeSVG } from 'qrcode.react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Server as ServerIcon,
  Trash2,
  RefreshCw,
  Bell,
  Shield,
  ExternalLink,
  Download,
  CheckCircle2,
  XCircle,
  Loader2,
  Smartphone,
  Copy,
  LogOut,
  Globe,
  AlertTriangle,
  Plus,
  Clock,
  KeyRound,
} from 'lucide-react';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { format, formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { api, tokenStorage } from '@/lib/api';
import type { PlexDiscoveredServer } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { PlexServerSelector } from '@/components/auth/PlexServerSelector';
import { NotificationRoutingMatrix } from '@/components/settings/NotificationRoutingMatrix';
import { AppearanceSettings } from '@/components/settings/AppearanceSettings';
import type {
  Server,
  Settings as SettingsType,
  TautulliImportProgress,
  MobileSession,
  MobileQRPayload,
} from '@tracearr/shared';
import {
  useSettings,
  useUpdateSettings,
  useServers,
  useDeleteServer,
  useSyncServer,
  useMobileConfig,
  useEnableMobile,
  useDisableMobile,
  useGeneratePairToken,
  useRevokeSession,
  useRevokeMobileSessions,
} from '@/hooks/queries';

function SettingsNav() {
  const links = [
    { href: '/settings', label: 'General', end: true },
    { href: '/settings/appearance', label: 'Appearance' },
    { href: '/settings/servers', label: 'Servers' },
    { href: '/settings/notifications', label: 'Notifications' },
    { href: '/settings/access', label: 'Access Control' },
    { href: '/settings/mobile', label: 'Mobile' },
    { href: '/settings/network', label: 'Network' },
    { href: '/settings/import', label: 'Import' },
  ];

  return (
    <nav className="flex space-x-4 border-b pb-4">
      {links.map((link) => (
        <NavLink
          key={link.href}
          to={link.href}
          end={link.end}
          className={({ isActive }) =>
            cn(
              'text-sm font-medium transition-colors',
              isActive ? 'text-primary' : 'text-muted-foreground hover:text-primary'
            )
          }
        >
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}

function GeneralSettings() {
  const { data: settings, isLoading } = useSettings();
  const updateSettings = useUpdateSettings();

  const handleTogglePoller = (enabled: boolean) => {
    updateSettings.mutate({ pollerEnabled: enabled });
  };

  const handleIntervalChange = (seconds: number) => {
    const ms = Math.max(5, Math.min(300, seconds)) * 1000;
    updateSettings.mutate({ pollerIntervalMs: ms });
  };

  const handleUnitSystemChange = (value: 'metric' | 'imperial') => {
    updateSettings.mutate({ unitSystem: value });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  const intervalSeconds = Math.round((settings?.pollerIntervalMs ?? 15000) / 1000);

  return (
    <Card>
      <CardHeader>
        <CardTitle>General Settings</CardTitle>
        <CardDescription>Configure basic application settings</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label className="text-base">Unit System</Label>
          <p className="text-muted-foreground text-sm">
            Choose how distances and speeds are displayed
          </p>
          <Select value={settings?.unitSystem ?? 'metric'} onValueChange={handleUnitSystemChange}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="metric">Metric (km, km/h)</SelectItem>
              <SelectItem value="imperial">Imperial (mi, mph)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label className="text-base">Session Sync</Label>
            <p className="text-muted-foreground text-sm">
              Enable session tracking for your media servers
            </p>
          </div>
          <Switch checked={settings?.pollerEnabled ?? true} onCheckedChange={handleTogglePoller} />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label className="text-base">Sync Interval</Label>
            <p className="text-muted-foreground text-sm">
              Polling frequency for Jellyfin/Emby (5-300 seconds)
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={5}
              max={300}
              className="w-20"
              defaultValue={intervalSeconds}
              onBlur={(e) => {
                handleIntervalChange(parseInt(e.target.value, 10) || 15);
              }}
              disabled={!settings?.pollerEnabled}
            />
            <span className="text-muted-foreground text-sm">sec</span>
          </div>
        </div>

        <div className="bg-muted/50 space-y-2 rounded-lg p-4">
          <p className="text-muted-foreground text-sm">
            <strong>Plex:</strong> Uses real-time updates via SSE. Polling is only used as a
            fallback if the connection fails.
          </p>
          <p className="text-muted-foreground text-sm">
            <strong>Jellyfin/Emby:</strong> Uses the sync interval above for session detection.
            Lower values provide faster updates but increase server load.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ServerSettings() {
  const { data: serversData, isLoading, refetch } = useServers();
  const deleteServer = useDeleteServer();
  const syncServer = useSyncServer();
  const { refetch: refetchUser, user } = useAuth();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [serverType, setServerType] = useState<'plex' | 'jellyfin' | 'emby'>('plex');
  const [serverUrl, setServerUrl] = useState('');
  const [serverName, setServerName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Plex server discovery state
  const [plexDialogStep, setPlexDialogStep] = useState<
    'loading' | 'no-plex' | 'no-servers' | 'select'
  >('loading');
  const [plexServers, setPlexServers] = useState<PlexDiscoveredServer[]>([]);
  const [connectingPlexServer, setConnectingPlexServer] = useState<string | null>(null);

  // Update server type when user data loads (non-owners can't add Plex)
  useEffect(() => {
    if (user && user.role !== 'owner' && serverType === 'plex') {
      setServerType('jellyfin');
    }
  }, [user, serverType]);

  // Fetch Plex servers when dialog opens with Plex selected
  useEffect(() => {
    if (showAddDialog && serverType === 'plex' && user?.role === 'owner') {
      void fetchPlexServers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only trigger on dialog open, not serverType changes
  }, [showAddDialog]);

  // Handle both array and wrapped response formats
  const servers = Array.isArray(serversData)
    ? serversData
    : ((serversData as unknown as { data?: Server[] })?.data ?? []);

  const handleDelete = () => {
    if (deleteId) {
      deleteServer.mutate(deleteId, {
        onSuccess: () => {
          setDeleteId(null);
        },
      });
    }
  };

  const handleSync = (id: string) => {
    syncServer.mutate(id);
  };

  // Default server type based on user role
  const defaultServerType = user?.role === 'owner' ? 'plex' : 'jellyfin';

  const resetAddForm = () => {
    setServerUrl('');
    setServerName('');
    setApiKey('');
    setConnectError(null);
    setServerType(defaultServerType as 'plex' | 'jellyfin' | 'emby');
    setPlexDialogStep('loading');
    setPlexServers([]);
    setConnectingPlexServer(null);
  };

  // Fetch available Plex servers when dialog opens with Plex selected
  const fetchPlexServers = async () => {
    setPlexDialogStep('loading');
    setConnectError(null);

    try {
      const result = await api.auth.getAvailablePlexServers();

      if (!result.hasPlexToken) {
        setPlexDialogStep('no-plex');
        return;
      }

      if (result.servers.length === 0) {
        setPlexDialogStep('no-servers');
        return;
      }

      setPlexServers(result.servers);
      setPlexDialogStep('select');
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'Failed to fetch Plex servers');
      setPlexDialogStep('no-plex');
    }
  };

  // Handle Plex server selection from PlexServerSelector
  const handlePlexServerSelect = async (
    serverUri: string,
    name: string,
    clientIdentifier: string
  ) => {
    setConnectingPlexServer(name);
    setConnectError(null);

    try {
      await api.auth.addPlexServer({
        serverUri,
        serverName: name,
        clientIdentifier,
      });

      toast.success('Server Added', { description: `${name} has been connected successfully` });

      // Refresh server list and user data
      await refetch();
      await refetchUser();

      // Close dialog and reset
      setShowAddDialog(false);
      resetAddForm();
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'Failed to connect Plex server');
    } finally {
      setConnectingPlexServer(null);
    }
  };

  const handleAddServer = async () => {
    if (!serverUrl || !serverName || !apiKey) {
      setConnectError('All fields are required');
      return;
    }

    setIsConnecting(true);
    setConnectError(null);

    try {
      const connectFn =
        serverType === 'jellyfin'
          ? api.auth.connectJellyfinWithApiKey
          : api.auth.connectEmbyWithApiKey;
      const result = await connectFn({
        serverUrl,
        serverName,
        apiKey,
      });

      // Update tokens if provided
      if (result.accessToken && result.refreshToken) {
        tokenStorage.setTokens(result.accessToken, result.refreshToken);
        await refetchUser();
      }

      // Refresh server list
      await refetch();

      // Close dialog and reset form
      setShowAddDialog(false);
      resetAddForm();
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'Failed to connect server');
    } finally {
      setIsConnecting(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent className="space-y-4">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Connected Servers</CardTitle>
            <CardDescription>
              Manage your connected Plex, Jellyfin, and Emby servers
            </CardDescription>
          </div>
          <Button
            onClick={() => {
              setShowAddDialog(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Server
          </Button>
        </CardHeader>
        <CardContent>
          {!servers || servers.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed">
              <ServerIcon className="text-muted-foreground h-8 w-8" />
              <p className="text-muted-foreground">No servers connected</p>
              <p className="text-muted-foreground text-xs">
                Click "Add Server" to connect a Jellyfin or Emby server
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {servers.map((server) => (
                <ServerCard
                  key={server.id}
                  server={server}
                  onSync={() => {
                    handleSync(server.id);
                  }}
                  onDelete={() => {
                    setDeleteId(server.id);
                  }}
                  isSyncing={syncServer.isPending}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Server Dialog */}
      <Dialog
        open={showAddDialog}
        onOpenChange={(open) => {
          if (!open) {
            resetAddForm();
          }
          setShowAddDialog(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Server</DialogTitle>
            <DialogDescription>
              {serverType === 'plex'
                ? 'Add another Plex server you own to Tracearr.'
                : 'Connect a Jellyfin or Emby server. You need administrator access.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Server Type Selector */}
            <div className="space-y-2">
              <Label>Server Type</Label>
              <Select
                value={serverType}
                onValueChange={(v) => {
                  const newType = v as 'plex' | 'jellyfin' | 'emby';
                  setServerType(newType);
                  setConnectError(null);
                  // Fetch Plex servers when switching to Plex type
                  if (newType === 'plex' && user?.role === 'owner') {
                    void fetchPlexServers();
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {user?.role === 'owner' && <SelectItem value="plex">Plex</SelectItem>}
                  <SelectItem value="jellyfin">Jellyfin</SelectItem>
                  <SelectItem value="emby">Emby</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Plex Server Selection Flow */}
            {serverType === 'plex' ? (
              <>
                {plexDialogStep === 'loading' && (
                  <div className="flex flex-col items-center justify-center gap-3 py-8">
                    <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
                    <p className="text-muted-foreground text-sm">
                      Discovering available Plex servers...
                    </p>
                  </div>
                )}

                {plexDialogStep === 'no-plex' && (
                  <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
                    <AlertTriangle className="h-8 w-8 text-amber-500" />
                    <div>
                      <p className="font-medium">No Plex Account Linked</p>
                      <p className="text-muted-foreground mt-1 text-sm">
                        You need to have at least one Plex server connected to add more.
                      </p>
                    </div>
                    {connectError && <p className="text-destructive text-sm">{connectError}</p>}
                  </div>
                )}

                {plexDialogStep === 'no-servers' && (
                  <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
                    <ServerIcon className="text-muted-foreground h-8 w-8" />
                    <div>
                      <p className="font-medium">All Servers Connected</p>
                      <p className="text-muted-foreground mt-1 text-sm">
                        All your owned Plex servers are already connected to Tracearr.
                      </p>
                    </div>
                  </div>
                )}

                {plexDialogStep === 'select' && (
                  <PlexServerSelector
                    servers={plexServers}
                    onSelect={handlePlexServerSelect}
                    connecting={connectingPlexServer !== null}
                    connectingToServer={connectingPlexServer}
                    showCancel={false}
                  />
                )}

                {connectError && plexDialogStep === 'select' && (
                  <div className="text-destructive flex items-center gap-2 text-sm">
                    <XCircle className="h-4 w-4" />
                    {connectError}
                  </div>
                )}
              </>
            ) : (
              /* Jellyfin/Emby Form */
              <>
                <div className="space-y-2">
                  <Label htmlFor="serverUrl">Server URL</Label>
                  <Input
                    id="serverUrl"
                    placeholder="http://192.168.1.100:8096"
                    value={serverUrl}
                    onChange={(e) => {
                      setServerUrl(e.target.value);
                    }}
                  />
                  <p className="text-muted-foreground text-xs">
                    The URL where your {serverType === 'jellyfin' ? 'Jellyfin' : 'Emby'} server is
                    accessible
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="serverName">Server Name</Label>
                  <Input
                    id="serverName"
                    placeholder="My Media Server"
                    value={serverName}
                    onChange={(e) => {
                      setServerName(e.target.value);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="apiKey">API Key</Label>
                  <Input
                    id="apiKey"
                    type="password"
                    placeholder="Enter your API key"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                    }}
                  />
                  <p className="text-muted-foreground text-xs">
                    {serverType === 'jellyfin'
                      ? 'Find this in Jellyfin Dashboard → API Keys'
                      : 'Find this in Emby Server → API Keys'}
                  </p>
                </div>
                {connectError && (
                  <div className="text-destructive flex items-center gap-2 text-sm">
                    <XCircle className="h-4 w-4" />
                    {connectError}
                  </div>
                )}
              </>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowAddDialog(false);
                resetAddForm();
              }}
            >
              Cancel
            </Button>
            {serverType !== 'plex' && (
              <Button onClick={handleAddServer} disabled={isConnecting}>
                {isConnecting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  'Connect Server'
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={() => {
          setDeleteId(null);
        }}
        title="Remove Server"
        description="Are you sure you want to remove this server? All associated session data will be retained, but you won't be able to monitor new sessions from this server."
        confirmLabel="Remove"
        onConfirm={handleDelete}
        isLoading={deleteServer.isPending}
      />
    </>
  );
}

function ServerCard({
  server,
  onSync,
  onDelete,
  isSyncing,
}: {
  server: Server;
  onSync: () => void;
  onDelete: () => void;
  isSyncing?: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border p-4">
      <div className="flex items-center gap-4">
        <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-lg">
          <MediaServerIcon type={server.type} className="h-6 w-6" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{server.name}</h3>
          </div>
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <span>{server.url}</span>
            <a
              href={server.url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-primary"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <p className="text-muted-foreground text-xs">
            Added {format(new Date(server.createdAt), 'MMM d, yyyy')}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onSync} disabled={isSyncing}>
          <RefreshCw className={cn('mr-1 h-4 w-4', isSyncing && 'animate-spin')} />
          Sync
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete}>
          <Trash2 className="text-destructive h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function NotificationSettings() {
  const { data: settings, isLoading } = useSettings();
  const updateSettings = useUpdateSettings();
  const [webhookFormat, setWebhookFormat] = useState<string>('json');
  const [ntfyTopic, setNtfyTopic] = useState<string>('');
  const [ntfyAuthToken, setNtfyAuthToken] = useState<string>('');
  const [testingDiscord, setTestingDiscord] = useState(false);
  const [testingCustom, setTestingCustom] = useState(false);

  // Sync state with loaded settings
  useEffect(() => {
    if (settings) {
      setWebhookFormat(settings.webhookFormat ?? 'json');
      setNtfyTopic(settings.ntfyTopic ?? '');
      // Don't overwrite if already set (masked token from server shows as ********)
      if (!ntfyAuthToken) {
        setNtfyAuthToken('');
      }
    }
  }, [settings, ntfyAuthToken]);

  const handleUrlChange = (
    key: 'discordWebhookUrl' | 'customWebhookUrl' | 'ntfyTopic',
    value: string
  ) => {
    updateSettings.mutate({ [key]: value || null });
  };

  const handleNtfyAuthTokenSave = () => {
    // Only save if the user entered a new token (not empty and not the masked placeholder)
    if (ntfyAuthToken && ntfyAuthToken !== '********') {
      updateSettings.mutate({ ntfyAuthToken: ntfyAuthToken || null });
    }
  };

  const handleClearNtfyAuthToken = () => {
    setNtfyAuthToken('');
    updateSettings.mutate({ ntfyAuthToken: null });
  };

  const handleWebhookFormatChange = (value: string) => {
    setWebhookFormat(value);
    updateSettings.mutate({ webhookFormat: value as 'json' | 'ntfy' | 'apprise' });
  };

  const handleTestDiscord = async () => {
    setTestingDiscord(true);
    try {
      await api.settings.testWebhook({ type: 'discord' });
      toast.success('Test Sent', {
        description: 'Check your Discord channel for the test message.',
      });
    } catch (err) {
      toast.error('Test Failed', {
        description: err instanceof Error ? err.message : 'Failed to send test webhook',
      });
    } finally {
      setTestingDiscord(false);
    }
  };

  const handleTestCustom = async () => {
    setTestingCustom(true);
    try {
      await api.settings.testWebhook({
        type: 'custom',
        format: webhookFormat as 'json' | 'ntfy' | 'apprise',
        ntfyTopic: ntfyTopic || undefined,
        // Pass auth token if user entered a new one (not empty and not the placeholder)
        ntfyAuthToken: ntfyAuthToken && ntfyAuthToken !== '********' ? ntfyAuthToken : undefined,
      });
      toast.success('Test Sent', {
        description: 'Check your webhook endpoint for the test message.',
      });
    } catch (err) {
      toast.error('Test Failed', {
        description: err instanceof Error ? err.message : 'Failed to send test webhook',
      });
    } finally {
      setTestingCustom(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent className="space-y-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex items-center justify-between">
              <Skeleton className="h-10 w-64" />
              <Skeleton className="h-6 w-11" />
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            Notification Routing
          </CardTitle>
          <CardDescription>Configure which channels receive each notification type</CardDescription>
        </CardHeader>
        <CardContent>
          <NotificationRoutingMatrix
            discordConfigured={!!settings?.discordWebhookUrl}
            webhookConfigured={!!settings?.customWebhookUrl}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Webhook Configuration</CardTitle>
          <CardDescription>Configure webhook URLs for notifications</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="discordWebhook">Discord Webhook URL</Label>
            <div className="flex gap-2">
              <Input
                id="discordWebhook"
                placeholder="https://discord.com/api/webhooks/..."
                defaultValue={settings?.discordWebhookUrl ?? ''}
                onBlur={(e) => {
                  handleUrlChange('discordWebhookUrl', e.target.value);
                }}
              />
              <Button
                variant="outline"
                onClick={handleTestDiscord}
                disabled={!settings?.discordWebhookUrl || testingDiscord}
              >
                {testingDiscord ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Test'}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Paste your Discord webhook URL to receive notifications in a Discord channel
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="customWebhook">Custom Webhook URL</Label>
            <div className="flex gap-2">
              <Input
                id="customWebhook"
                placeholder={
                  webhookFormat === 'ntfy'
                    ? 'https://ntfy.sh/ (or your self-hosted ntfy server)'
                    : webhookFormat === 'apprise'
                      ? 'http://apprise:8000/notify/myconfig'
                      : 'https://your-service.com/webhook'
                }
                defaultValue={settings?.customWebhookUrl ?? ''}
                onBlur={(e) => {
                  handleUrlChange('customWebhookUrl', e.target.value);
                }}
              />
              <Button
                variant="outline"
                onClick={handleTestCustom}
                disabled={!settings?.customWebhookUrl || testingCustom}
              >
                {testingCustom ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Test'}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              {webhookFormat === 'ntfy'
                ? 'Post to your ntfy server root URL (topic is specified separately below)'
                : webhookFormat === 'apprise'
                  ? 'Post to your Apprise API endpoint with notification configuration'
                  : 'Send notifications to a custom endpoint via POST request'}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="webhookFormat">Webhook Format</Label>
            <Select value={webhookFormat} onValueChange={handleWebhookFormatChange}>
              <SelectTrigger>
                <SelectValue placeholder="Select format" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="json">Raw JSON (default)</SelectItem>
                <SelectItem value="ntfy">Ntfy</SelectItem>
                <SelectItem value="apprise">Apprise</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Choose the payload format for your webhook endpoint
            </p>
          </div>

          {webhookFormat === 'ntfy' && (
            <>
              <div className="space-y-2">
                <Label htmlFor="ntfyTopic">Ntfy Topic</Label>
                <Input
                  id="ntfyTopic"
                  placeholder="tracearr"
                  value={ntfyTopic}
                  onChange={(e) => setNtfyTopic(e.target.value)}
                  onBlur={(e) => {
                    handleUrlChange('ntfyTopic', e.target.value);
                  }}
                />
                <p className="text-muted-foreground text-xs">
                  The ntfy topic to publish notifications to
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ntfyAuthToken">Auth Token (optional)</Label>
                <div className="flex gap-2">
                  <Input
                    id="ntfyAuthToken"
                    type="password"
                    placeholder={settings?.ntfyAuthToken ? '••••••••' : 'tk_...'}
                    value={ntfyAuthToken}
                    onChange={(e) => setNtfyAuthToken(e.target.value)}
                    onBlur={handleNtfyAuthTokenSave}
                  />
                  {settings?.ntfyAuthToken && (
                    <Button
                      variant="outline"
                      onClick={handleClearNtfyAuthToken}
                      title="Clear auth token"
                    >
                      Clear
                    </Button>
                  )}
                </div>
                <p className="text-muted-foreground text-xs">
                  Required for protected ntfy servers. Enter your access token (starts with tk_).
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AccessSettings() {
  const { data: settings, isLoading } = useSettings();
  const { data: serversData } = useServers();
  const { user } = useAuth();
  const updateSettings = useUpdateSettings();

  const handleToggle = (key: keyof SettingsType, value: boolean) => {
    updateSettings.mutate({ [key]: value });
  };

  // Only show auth method selector when applicable:
  // - User has local credentials (hasPassword) OR
  // - There's at least one Jellyfin server configured
  // Handle both array and wrapped response formats
  const servers = Array.isArray(serversData)
    ? serversData
    : ((serversData as unknown as { data?: Server[] })?.data ?? []);
  const hasJellyfinServer = servers.some((s) => s.type === 'jellyfin');
  const showAuthMethodSelector = user?.hasPassword || hasJellyfinServer;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="h-5 w-5" />
          Access Control
        </CardTitle>
        <CardDescription>Configure who can access Tracearr</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-base">Allow Guest Access</Label>
            <p className="text-muted-foreground text-sm">
              When disabled, only the server owner can log in to Tracearr
            </p>
          </div>
          <Switch
            checked={settings?.allowGuestAccess ?? false}
            onCheckedChange={(checked) => {
              handleToggle('allowGuestAccess', checked);
            }}
          />
        </div>

        {showAuthMethodSelector && (
          <div className="space-y-2">
            <Label className="text-base">Primary Authentication Method</Label>
            <p className="text-muted-foreground text-sm">
              Choose which authentication method is shown by default on the login page
            </p>
            <Select
              value={settings?.primaryAuthMethod ?? 'local'}
              onValueChange={(value: 'jellyfin' | 'local') => {
                updateSettings.mutate({ primaryAuthMethod: value });
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4" />
                    <span>Local Account</span>
                  </div>
                </SelectItem>
                <SelectItem value="jellyfin">
                  <div className="flex items-center gap-2">
                    <MediaServerIcon type="jellyfin" className="h-4 w-4" />
                    <span>Jellyfin Admin</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="bg-muted/50 rounded-lg p-4">
          <p className="text-muted-foreground text-sm">
            <strong>Note:</strong> In v1, Tracearr only supports single-owner access. Even with
            guest access enabled, guests can only view their own sessions and violations.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function NetworkSettings() {
  const { data: settings, isLoading } = useSettings();
  const updateSettings = useUpdateSettings();

  const [externalUrl, setExternalUrl] = useState('');
  const [basePath, setBasePath] = useState('');

  useEffect(() => {
    if (settings) {
      setExternalUrl(settings.externalUrl ?? '');
      setBasePath(settings.basePath ?? '');
    }
  }, [settings]);

  const handleToggleTrustProxy = (enabled: boolean) => {
    updateSettings.mutate({ trustProxy: enabled });
  };

  const handleSaveExternalUrl = () => {
    updateSettings.mutate({ externalUrl: externalUrl || null });
  };

  const handleSaveBasePath = () => {
    updateSettings.mutate({ basePath: basePath });
  };

  const handleDetectUrl = () => {
    let detectedUrl = window.location.origin;
    if (import.meta.env.DEV) {
      detectedUrl = detectedUrl.replace(':5173', ':3000');
    }
    setExternalUrl(detectedUrl);
  };

  const isLocalhost = externalUrl.includes('localhost') || externalUrl.includes('127.0.0.1');
  const isHttp = externalUrl.startsWith('http://') && !isLocalhost;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            External Access
          </CardTitle>
          <CardDescription>
            Configure how external devices (like mobile apps) connect to your server
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="externalUrl">External URL</Label>
            <div className="flex gap-2">
              <Input
                id="externalUrl"
                placeholder="https://tracearr.example.com"
                value={externalUrl}
                onChange={(e) => setExternalUrl(e.target.value)}
                onBlur={handleSaveExternalUrl}
              />
              <Button variant="outline" onClick={handleDetectUrl}>
                Detect
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              The URL that external devices should use to reach this server. Used for QR codes and
              mobile app pairing.
            </p>
            {isLocalhost && (
              <div className="flex items-start gap-2 rounded-lg bg-yellow-500/10 p-3 text-sm text-yellow-600">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Localhost URLs only work when your phone is on the same machine. Use your local IP
                  (e.g., http://192.168.1.x:3000) for LAN access, or set up a domain for remote
                  access.
                </span>
              </div>
            )}
            {isHttp && (
              <div className="flex items-start gap-2 rounded-lg bg-yellow-500/10 p-3 text-sm text-yellow-600">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  iOS requires HTTPS for non-local connections. HTTP will work on local networks but
                  may fail for Tailscale or remote access. Consider using HTTPS with a reverse
                  proxy.
                </span>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="basePath">Base Path</Label>
            <Input
              id="basePath"
              placeholder="/tracearr"
              value={basePath}
              onChange={(e) => setBasePath(e.target.value)}
              onBlur={handleSaveBasePath}
            />
            <p className="text-muted-foreground text-xs">
              Only needed if running behind a reverse proxy with a path prefix (e.g.,
              example.com/tracearr). Leave empty for root-level deployments.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reverse Proxy</CardTitle>
          <CardDescription>
            Settings for deployments behind nginx, Caddy, Traefik, or Cloudflare Tunnel
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-base">Trust Proxy Headers</Label>
              <p className="text-muted-foreground text-sm">
                Trust X-Forwarded-For and X-Forwarded-Proto headers from your reverse proxy
              </p>
            </div>
            <Switch
              checked={settings?.trustProxy ?? false}
              onCheckedChange={handleToggleTrustProxy}
            />
          </div>

          <div className="bg-muted/50 space-y-2 rounded-lg p-4">
            <p className="text-muted-foreground text-sm">
              <strong>When to enable:</strong> If you're running Tracearr behind a reverse proxy
              (nginx, Caddy, Traefik, Cloudflare Tunnel), enable this so the server knows the real
              client IP and protocol.
            </p>
            {settings?.trustProxy && (
              <p className="text-sm text-yellow-600">
                <strong>Note:</strong> After changing this setting, you need to set the
                TRUST_PROXY=true environment variable and restart the server for it to take effect.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connection Scenarios</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3 text-sm">
            <div className="flex gap-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
              <div>
                <strong>Local network (LAN)</strong>
                <p className="text-muted-foreground">
                  http://192.168.1.x:3000 - Works on iOS with local network permissions
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
              <div>
                <strong>Reverse proxy with HTTPS</strong>
                <p className="text-muted-foreground">
                  https://tracearr.example.com - Full support, recommended for remote access
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
              <div>
                <strong>Cloudflare Tunnel</strong>
                <p className="text-muted-foreground">
                  https://tracearr.example.com - Full support, no port forwarding needed
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
              <div>
                <strong>Tailscale (HTTP)</strong>
                <p className="text-muted-foreground">
                  http://device.tailnet.ts.net - May require HTTPS for iOS
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <div>
                <strong>Self-signed certificates</strong>
                <p className="text-muted-foreground">
                  https://192.168.1.x - iOS rejects self-signed certs by default
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function MobileSettings() {
  const { data: config, isLoading } = useMobileConfig();
  const { data: settings } = useSettings();
  const enableMobile = useEnableMobile();
  const disableMobile = useDisableMobile();
  const generatePairToken = useGeneratePairToken();
  const revokeMobileSessions = useRevokeMobileSessions();

  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);
  const [showQRDialog, setShowQRDialog] = useState(false);
  const [pairToken, setPairToken] = useState<{ token: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);

  // Timer for token expiration
  useEffect(() => {
    if (!pairToken?.expiresAt) {
      setTimeLeft(null);
      return;
    }

    const updateTimer = () => {
      const now = Date.now();
      const expiresAt = new Date(pairToken.expiresAt).getTime();
      const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
      setTimeLeft(remaining);

      if (remaining === 0) {
        setPairToken(null);
        setShowQRDialog(false);
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [pairToken]);

  const handleAddDevice = async () => {
    try {
      const token = await generatePairToken.mutateAsync();
      setPairToken(token);
      setShowQRDialog(true);
    } catch {
      // Error handled by mutation
    }
  };

  const handleCopyToken = async () => {
    if (pairToken?.token) {
      try {
        await navigator.clipboard.writeText(pairToken.token);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        toast.success('Token Copied', { description: 'Pair token copied to clipboard.' });
      } catch {
        toast.error('Failed to Copy', { description: 'Could not copy token to clipboard.' });
      }
    }
  };

  const getServerUrl = (): string => {
    if (settings?.externalUrl) {
      return settings.externalUrl;
    }
    let serverUrl = window.location.origin;
    if (import.meta.env.DEV) {
      serverUrl = serverUrl.replace(':5173', ':3000');
    }
    return serverUrl;
  };

  const getQRData = (): string => {
    if (!pairToken?.token) return '';
    const payload: MobileQRPayload = {
      url: getServerUrl(),
      token: pairToken.token,
      name: config?.serverName ?? 'Tracearr',
    };
    const encoded = btoa(JSON.stringify(payload));
    return `tracearr://pair?data=${encoded}`;
  };

  const formatTimeLeft = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-48 w-48" />
        </CardContent>
      </Card>
    );
  }

  const deviceCount = config?.sessions?.length ?? 0;
  const maxDevices = config?.maxDevices ?? 5;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5" />
            Mobile App Access
          </CardTitle>
          <CardDescription>
            Connect the Tracearr mobile app to monitor your servers on the go
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {!config?.isEnabled ? (
            <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8">
              <div className="bg-muted rounded-full p-4">
                <Smartphone className="text-muted-foreground h-8 w-8" />
              </div>
              <div className="text-center">
                <h3 className="font-semibold">Mobile Access Disabled</h3>
                <p className="text-muted-foreground mt-1 text-sm">
                  Enable mobile access to connect the Tracearr app to your server
                </p>
              </div>
              <Button onClick={() => enableMobile.mutate()} disabled={enableMobile.isPending}>
                {enableMobile.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Enabling...
                  </>
                ) : (
                  'Enable Mobile Access'
                )}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-muted-foreground text-sm">
                    {deviceCount} of {maxDevices} devices connected
                  </p>
                </div>
                <Button
                  onClick={handleAddDevice}
                  disabled={deviceCount >= maxDevices || generatePairToken.isPending}
                >
                  {generatePairToken.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-2 h-4 w-4" />
                  )}
                  Add Device
                </Button>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setShowDisableConfirm(true)}>
                  Disable Mobile Access
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {config?.isEnabled && config.sessions.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Connected Devices</CardTitle>
                <CardDescription>
                  {config.sessions.length} device{config.sessions.length !== 1 ? 's' : ''} connected
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowRevokeConfirm(true)}>
                <LogOut className="mr-2 h-4 w-4" />
                Revoke All
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {config.sessions.map((session) => (
                <MobileSessionCard key={session.id} session={session} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* QR Code Dialog */}
      <Dialog
        open={showQRDialog}
        onOpenChange={(open) => {
          setShowQRDialog(open);
          if (!open) setPairToken(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pair New Device</DialogTitle>
            <DialogDescription>
              Scan the QR code with the Tracearr mobile app to pair your device.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {pairToken && (
              <>
                <div className="flex flex-col items-center gap-4">
                  <div className="rounded-lg border bg-white p-4">
                    <QRCodeSVG value={getQRData()} size={200} level="M" marginSize={0} />
                  </div>
                  {timeLeft !== null && (
                    <div className="text-muted-foreground flex items-center gap-2 text-sm">
                      <Clock className="h-4 w-4" />
                      <span>Expires in {formatTimeLeft(timeLeft)}</span>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>One-Time Pair Token</Label>
                  <div className="flex gap-2">
                    <Input readOnly value={pairToken.token} className="font-mono text-xs" />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={handleCopyToken}
                      title="Copy token"
                    >
                      {copied ? (
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    This token expires in 5 minutes and can only be used once.
                  </p>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setShowQRDialog(false);
                setPairToken(null);
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disable Confirmation Dialog */}
      <ConfirmDialog
        open={showDisableConfirm}
        onOpenChange={setShowDisableConfirm}
        title="Disable Mobile Access"
        description="Are you sure you want to disable mobile access? All connected devices will be disconnected and will need to be re-paired when you re-enable."
        confirmLabel="Disable"
        onConfirm={() => {
          disableMobile.mutate();
          setShowDisableConfirm(false);
        }}
        isLoading={disableMobile.isPending}
      />

      <ConfirmDialog
        open={showRevokeConfirm}
        onOpenChange={setShowRevokeConfirm}
        title="Revoke All Sessions"
        description="Are you sure you want to disconnect all mobile devices? They will need to pair with a new token to reconnect."
        confirmLabel="Revoke All"
        onConfirm={() => {
          revokeMobileSessions.mutate();
          setShowRevokeConfirm(false);
        }}
        isLoading={revokeMobileSessions.isPending}
      />
    </div>
  );
}

function MobileSessionCard({ session }: { session: MobileSession }) {
  const revokeSession = useRevokeSession();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  return (
    <>
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="flex items-center gap-4">
          <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-lg">
            <Smartphone className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">{session.deviceName}</h3>
              <span className="bg-muted rounded px-2 py-0.5 text-xs capitalize">
                {session.platform}
              </span>
            </div>
            <p className="text-muted-foreground text-sm">
              Last seen {formatDistanceToNow(new Date(session.lastSeenAt), { addSuffix: true })}
            </p>
            <p className="text-muted-foreground text-xs">
              Connected {format(new Date(session.createdAt), 'MMM d, yyyy')}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(true)}>
          <Trash2 className="text-destructive h-4 w-4" />
        </Button>
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Remove Device"
        description={`Are you sure you want to remove ${session.deviceName}? This device will need to pair again to reconnect.`}
        confirmLabel="Remove"
        onConfirm={() => {
          revokeSession.mutate(session.id);
          setShowDeleteConfirm(false);
        }}
        isLoading={revokeSession.isPending}
      />
    </>
  );
}

function ImportSettings() {
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const { data: serversData, isLoading: serversLoading } = useServers();
  const updateSettings = useUpdateSettings();
  const { socket } = useSocket();

  const [tautulliUrl, setTautulliUrl] = useState('');
  const [tautulliApiKey, setTautulliApiKey] = useState('');
  const [selectedServerId, setSelectedServerId] = useState<string>('');
  const [connectionStatus, setConnectionStatus] = useState<
    'idle' | 'testing' | 'success' | 'error'
  >('idle');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [importProgress, setImportProgress] = useState<TautulliImportProgress | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [_activeJobId, setActiveJobId] = useState<string | null>(null);

  // Handle both array and wrapped response formats
  const servers = Array.isArray(serversData)
    ? serversData
    : ((serversData as unknown as { data?: Server[] })?.data ?? []);

  // Only show Plex servers (Tautulli is Plex-only)
  const plexServers = servers.filter((s) => s.type === 'plex');

  // Initialize form with saved settings
  useEffect(() => {
    if (settings) {
      setTautulliUrl(settings.tautulliUrl ?? '');
      setTautulliApiKey(settings.tautulliApiKey ?? '');
      // If we have saved Tautulli settings, mark connection as success
      if (settings.tautulliUrl && settings.tautulliApiKey) {
        setConnectionStatus('success');
      }
    }
  }, [settings]);

  // Check for active import on mount for each Plex server
  useEffect(() => {
    if (plexServers.length === 0) return;

    const checkActiveImports = async () => {
      for (const server of plexServers) {
        try {
          const result = await api.import.tautulli.getActive(server.id);
          if (result.active && result.jobId) {
            setSelectedServerId(server.id);
            setActiveJobId(result.jobId);
            setIsImporting(true);

            // BullMQ stores progress as percentage (0-100)
            // We'll get detailed progress from WebSocket events
            const progressPercent = typeof result.progress === 'number' ? result.progress : 0;
            setImportProgress({
              status: 'processing',
              totalRecords: 0, // Unknown until WebSocket update
              fetchedRecords: 0,
              processedRecords: 0,
              importedRecords: 0,
              updatedRecords: 0,
              skippedRecords: 0,
              duplicateRecords: 0,
              unknownUserRecords: 0,
              activeSessionRecords: 0,
              errorRecords: 0,
              currentPage: 0,
              totalPages: 0,
              message:
                progressPercent > 0
                  ? `Import in progress (${progressPercent}% complete)... Waiting for detailed progress.`
                  : 'Import in progress... Waiting for progress update.',
            });
            // Mark connection as success since we have an active import
            setConnectionStatus('success');
            break;
          }
        } catch {
          // Ignore errors - server might not have queue available
        }
      }
    };

    void checkActiveImports();
  }, [plexServers.length]); // Only re-run when server count changes

  // Listen for import progress via WebSocket
  useEffect(() => {
    if (!socket) return;

    const handleProgress = (progress: TautulliImportProgress) => {
      setImportProgress(progress);
      if (progress.status === 'complete' || progress.status === 'error') {
        setIsImporting(false);
        setActiveJobId(null);
      }
    };

    socket.on('import:progress', handleProgress);
    return () => {
      socket.off('import:progress', handleProgress);
    };
  }, [socket]);

  const handleSaveSettings = () => {
    updateSettings.mutate({
      tautulliUrl: tautulliUrl || null,
      tautulliApiKey: tautulliApiKey || null,
    });
  };

  const handleTestConnection = async () => {
    if (!tautulliUrl || !tautulliApiKey) {
      setConnectionStatus('error');
      setConnectionMessage('Please enter Tautulli URL and API key');
      return;
    }

    setConnectionStatus('testing');
    setConnectionMessage('Testing connection...');

    try {
      const result = await api.import.tautulli.test(tautulliUrl, tautulliApiKey);
      if (result.success) {
        setConnectionStatus('success');
        setConnectionMessage(
          `Connected! Found ${result.users ?? 0} users and ${result.historyRecords ?? 0} history records.`
        );
        // Save settings on successful connection
        handleSaveSettings();
      } else {
        setConnectionStatus('error');
        setConnectionMessage(result.message || 'Connection failed');
      }
    } catch (err) {
      setConnectionStatus('error');
      setConnectionMessage(err instanceof Error ? err.message : 'Connection failed');
    }
  };

  const handleStartImport = async () => {
    if (!selectedServerId) {
      return;
    }

    setIsImporting(true);
    setImportProgress({
      status: 'fetching',
      totalRecords: 0,
      fetchedRecords: 0,
      processedRecords: 0,
      importedRecords: 0,
      updatedRecords: 0,
      skippedRecords: 0,
      duplicateRecords: 0,
      unknownUserRecords: 0,
      activeSessionRecords: 0,
      errorRecords: 0,
      currentPage: 0,
      totalPages: 0,
      message: 'Starting import...',
    });

    try {
      const result = await api.import.tautulli.start(selectedServerId);
      // Save jobId if returned (when using queue)
      if (result.jobId) {
        setActiveJobId(result.jobId);
      }
      // Progress updates come via WebSocket
    } catch (err) {
      setIsImporting(false);
      setActiveJobId(null);
      setImportProgress({
        status: 'error',
        totalRecords: 0,
        fetchedRecords: 0,
        processedRecords: 0,
        importedRecords: 0,
        updatedRecords: 0,
        skippedRecords: 0,
        duplicateRecords: 0,
        unknownUserRecords: 0,
        activeSessionRecords: 0,
        errorRecords: 0,
        currentPage: 0,
        totalPages: 0,
        message: err instanceof Error ? err.message : 'Import failed',
      });
    }
  };

  if (settingsLoading || serversLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Tautulli Import
          </CardTitle>
          <CardDescription>
            Import historical watch data from Tautulli into Tracearr
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tautulliUrl">Tautulli URL</Label>
              <Input
                id="tautulliUrl"
                placeholder="http://localhost:8181"
                value={tautulliUrl}
                onChange={(e) => {
                  setTautulliUrl(e.target.value);
                }}
              />
              <p className="text-muted-foreground text-xs">
                The URL where Tautulli is accessible (include port if needed)
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="tautulliApiKey">API Key</Label>
              <Input
                id="tautulliApiKey"
                type="password"
                placeholder="Your Tautulli API key"
                value={tautulliApiKey}
                onChange={(e) => {
                  setTautulliApiKey(e.target.value);
                }}
              />
              <p className="text-muted-foreground text-xs">
                Find this in Tautulli Settings → Web Interface → API Key
              </p>
            </div>

            <div className="flex items-center gap-4">
              <Button
                onClick={handleTestConnection}
                disabled={connectionStatus === 'testing' || !tautulliUrl || !tautulliApiKey}
              >
                {connectionStatus === 'testing' ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Testing...
                  </>
                ) : (
                  'Test Connection'
                )}
              </Button>

              {connectionStatus === 'success' && (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <CheckCircle2 className="h-4 w-4" />
                  {connectionMessage}
                </div>
              )}

              {connectionStatus === 'error' && (
                <div className="text-destructive flex items-center gap-2 text-sm">
                  <XCircle className="h-4 w-4" />
                  {connectionMessage}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {connectionStatus === 'success' && (
        <Card>
          <CardHeader>
            <CardTitle>Import History</CardTitle>
            <CardDescription>Select a Plex server to import Tautulli history into</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {plexServers.length === 0 ? (
              <div className="bg-muted/50 rounded-lg p-4">
                <p className="text-muted-foreground text-sm">
                  No Plex servers connected. Add a Plex server first to import Tautulli data.
                </p>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>Target Server</Label>
                  <Select value={selectedServerId} onValueChange={setSelectedServerId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a Plex server" />
                    </SelectTrigger>
                    <SelectContent>
                      {plexServers.map((server) => (
                        <SelectItem key={server.id} value={server.id}>
                          {server.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-muted-foreground text-xs">
                    Sessions will be imported and matched to users from this server
                  </p>
                </div>

                <div className="space-y-4">
                  <Button onClick={handleStartImport} disabled={!selectedServerId || isImporting}>
                    {isImporting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Importing...
                      </>
                    ) : (
                      <>
                        <Download className="mr-2 h-4 w-4" />
                        Start Import
                      </>
                    )}
                  </Button>

                  {importProgress && (
                    <div className="space-y-3 rounded-lg border p-4">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">
                          {importProgress.status === 'complete'
                            ? 'Import Complete'
                            : importProgress.status === 'error'
                              ? 'Import Failed'
                              : 'Importing...'}
                        </span>
                        {importProgress.status === 'complete' && (
                          <CheckCircle2 className="h-5 w-5 text-green-600" />
                        )}
                        {importProgress.status === 'error' && (
                          <XCircle className="text-destructive h-5 w-5" />
                        )}
                        {(importProgress.status === 'fetching' ||
                          importProgress.status === 'processing') && (
                          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
                        )}
                      </div>

                      <p className="text-muted-foreground text-sm">{importProgress.message}</p>

                      {importProgress.totalRecords > 0 && (
                        <>
                          <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
                            <div
                              className="bg-primary h-full transition-all"
                              style={{
                                width:
                                  importProgress.status === 'complete'
                                    ? '100%'
                                    : `${Math.min(100, Math.round((importProgress.processedRecords / importProgress.totalRecords) * 100))}%`,
                              }}
                            />
                          </div>

                          <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                              <span className="text-muted-foreground">Processed:</span>{' '}
                              <span className="font-medium">
                                {importProgress.processedRecords} / {importProgress.totalRecords}
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Page:</span>{' '}
                              <span className="font-medium">
                                {importProgress.currentPage} / {importProgress.totalPages}
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Imported:</span>{' '}
                              <span className="font-medium text-green-600">
                                {importProgress.importedRecords}
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Skipped:</span>{' '}
                              <span className="font-medium text-yellow-600">
                                {importProgress.skippedRecords}
                              </span>
                            </div>
                            {importProgress.errorRecords > 0 && (
                              <div>
                                <span className="text-muted-foreground">Errors:</span>{' '}
                                <span className="text-destructive font-medium">
                                  {importProgress.errorRecords}
                                </span>
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="bg-muted/50 rounded-lg p-4">
                  <p className="text-muted-foreground text-sm">
                    <strong>Note:</strong> The import will match Tautulli users to existing Tracearr
                    users by their Plex user ID. Duplicate sessions are automatically detected and
                    skipped. This process may take several minutes depending on your history size.
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function Settings() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Settings</h1>
      <SettingsNav />
      <Routes>
        <Route index element={<GeneralSettings />} />
        <Route path="appearance" element={<AppearanceSettings />} />
        <Route path="servers" element={<ServerSettings />} />
        <Route path="network" element={<NetworkSettings />} />
        <Route path="notifications" element={<NotificationSettings />} />
        <Route path="access" element={<AccessSettings />} />
        <Route path="mobile" element={<MobileSettings />} />
        <Route path="import" element={<ImportSettings />} />
      </Routes>
    </div>
  );
}
