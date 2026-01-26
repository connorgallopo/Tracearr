import { useState, useEffect } from 'react';
import { NavLink, Routes, Route, Link as RouterLink } from 'react-router';
import { QRCodeSVG } from 'qrcode.react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError } from '@/components/ui/field';
import {
  AutosaveTextField,
  AutosaveNumberField,
  AutosaveSelectField,
  AutosaveSwitchField,
  SaveStatusIndicator,
} from '@/components/ui/autosave-field';
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
  Upload,
  Info,
  Pencil,
  Sun,
  Moon,
  Monitor,
  Check,
  RotateCcw,
  Palette,
  Settings as SettingsIcon,
  Link,
  GripVertical,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { format, formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { api, tokenStorage } from '@/lib/api';
import type { PlexDiscoveredServer } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { PlexServerSelector } from '@/components/auth/PlexServerSelector';
import { NotificationAgentsManager } from '@/components/settings/notification-agents';
import { JobsSettings } from '@/components/settings/JobsSettings';
import { useTheme, ACCENT_PRESETS } from '@/components/theme-provider';
import { PlexAccountsManager } from '@/components/settings/PlexAccountsManager';
import { ImportProgressCard, FileDropzone, type ImportProgressData } from '@/components/import';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';
import type {
  Server,
  TautulliImportProgress,
  JellystatImportProgress,
  MobileSession,
  MobileQRPayload,
} from '@tracearr/shared';
import {
  useSettings,
  useUpdateSettings,
  useServers,
  useDeleteServer,
  useSyncServer,
  useUpdateServerUrl,
  usePlexServerConnections,
  useReorderServers,
  useMobileConfig,
  useEnableMobile,
  useDisableMobile,
  useGeneratePairToken,
  useRevokeSession,
  useRevokeMobileSessions,
  useApiKey,
  useRegenerateApiKey,
} from '@/hooks/queries';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

function SettingsNav() {
  const links = [
    { href: '/settings', label: 'General', end: true },
    { href: '/settings/servers', label: 'Servers' },
    { href: '/settings/notifications', label: 'Notifications' },
    { href: '/settings/access', label: 'Access Control' },
    { href: '/settings/mobile', label: 'Mobile' },
    { href: '/settings/import', label: 'Import' },
    { href: '/settings/jobs', label: 'Jobs' },
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

type ThemeMode = 'light' | 'dark' | 'system';

const DEFAULT_THEME: ThemeMode = 'dark';
const DEFAULT_HUE = 187; // Cyan

const THEME_MODES: { value: ThemeMode; label: string; icon: typeof Sun; isDefault?: boolean }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon, isDefault: true },
  { value: 'system', label: 'System', icon: Monitor },
];

function ApiKeyCard() {
  const { data: apiKeyData, isLoading } = useApiKey();
  const regenerateApiKey = useRegenerateApiKey();
  const [showConfirm, setShowConfirm] = useState(false);

  const token = apiKeyData?.token;
  const hasKey = !!token;

  const handleCopy = async () => {
    if (token) {
      try {
        await navigator.clipboard.writeText(token);
        toast.success('Copied to clipboard');
      } catch {
        toast.error('Failed to copy to clipboard');
      }
    }
  };

  const handleRegenerate = () => {
    if (hasKey) {
      setShowConfirm(true);
    } else {
      regenerateApiKey.mutate();
    }
  };

  const confirmRegenerate = () => {
    regenerateApiKey.mutate();
    setShowConfirm(false);
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-5 w-5" />
                API Key
              </CardTitle>
              <CardDescription>
                Access the Tracearr API for third-party integrations like Homarr, Home Assistant,
                etc.
              </CardDescription>
            </div>
            <RouterLink to="/api-docs">
              <Button variant="outline" size="sm" className="gap-1.5">
                <ExternalLink className="h-3.5 w-3.5" />
                API Docs
              </Button>
            </RouterLink>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={token ?? ''}
                  placeholder="No API key generated"
                  className="font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopy}
                  disabled={!hasKey}
                  title="Copy to clipboard"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground text-sm">
                  {hasKey
                    ? 'Your API key grants full read access to your Tracearr data.'
                    : 'Generate an API key to enable external integrations.'}
                </p>
                <Button
                  variant={hasKey ? 'outline' : 'default'}
                  size="sm"
                  onClick={handleRegenerate}
                  disabled={regenerateApiKey.isPending}
                >
                  {regenerateApiKey.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  {hasKey ? 'Regenerate' : 'Generate Key'}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        title="Regenerate API Key?"
        description="This will invalidate your current API key. Any integrations using the old key will stop working."
        confirmLabel="Regenerate"
        onConfirm={confirmRegenerate}
      />
    </>
  );
}

function GeneralSettings() {
  const { data: settings, isLoading } = useSettings();
  const { theme, setTheme, accentHue, setAccentHue } = useTheme();

  // General settings fields
  const unitSystemField = useDebouncedSave('unitSystem', settings?.unitSystem);
  const pollerEnabledField = useDebouncedSave('pollerEnabled', settings?.pollerEnabled);
  const pollerIntervalField = useDebouncedSave('pollerIntervalMs', settings?.pollerIntervalMs);
  const usePlexGeoipField = useDebouncedSave('usePlexGeoip', settings?.usePlexGeoip);

  // Network settings fields
  const externalUrlField = useDebouncedSave('externalUrl', settings?.externalUrl);
  const basePathField = useDebouncedSave('basePath', settings?.basePath);

  const intervalSeconds = Math.round((pollerIntervalField.value ?? 15000) / 1000);

  const handleIntervalChange = (seconds: number) => {
    const clamped = Math.max(5, Math.min(300, seconds));
    pollerIntervalField.setValue(clamped * 1000);
  };

  const handleDetectUrl = () => {
    let detectedUrl = window.location.origin;
    if (import.meta.env.DEV) {
      detectedUrl = detectedUrl.replace(':5173', ':3000');
    }
    externalUrlField.setValue(detectedUrl);
    setTimeout(() => externalUrlField.saveNow(), 0);
  };

  const externalUrl = externalUrlField.value ?? '';
  const isLocalhost = externalUrl.includes('localhost') || externalUrl.includes('127.0.0.1');
  const isHttp = externalUrl.startsWith('http://') && !isLocalhost;

  const isDefaultTheme = theme === DEFAULT_THEME && accentHue === DEFAULT_HUE;

  const handleThemeReset = () => {
    setTheme(DEFAULT_THEME);
    setAccentHue(DEFAULT_HUE);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
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
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Appearance */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Palette className="h-5 w-5" />
                Appearance
              </CardTitle>
              <CardDescription>Customize the look and feel of Tracearr</CardDescription>
            </div>
            {!isDefaultTheme && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleThemeReset}
                className="text-muted-foreground hover:text-foreground gap-1.5"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Mode Selection */}
          <div className="space-y-2">
            <label className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Theme
            </label>
            <div className="flex gap-2">
              {THEME_MODES.map(({ value, label, icon: Icon, isDefault: isDefaultMode }) => (
                <Button
                  key={value}
                  variant={theme === value ? 'default' : 'outline'}
                  size="sm"
                  className={cn(
                    'flex-1 gap-1.5',
                    theme === value && 'ring-primary ring-offset-background ring-1 ring-offset-1'
                  )}
                  onClick={() => setTheme(value)}
                >
                  <Icon className="h-4 w-4" />
                  <span>{label}</span>
                  {isDefaultMode && <span className="text-[10px] opacity-60">(default)</span>}
                </Button>
              ))}
            </div>
          </div>

          {/* Accent Color Selection */}
          <div className="space-y-2">
            <label className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Accent Color
            </label>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
              {ACCENT_PRESETS.map((preset) => {
                const isSelected = accentHue === preset.hue;
                const isDefaultColor = preset.hue === DEFAULT_HUE;
                return (
                  <button
                    key={preset.hue}
                    onClick={() => setAccentHue(preset.hue)}
                    className={cn(
                      'group relative flex flex-col items-center gap-1 rounded-lg p-1.5 transition-all',
                      'hover:bg-muted/50 focus:ring-primary focus:ring-offset-background focus:ring-2 focus:ring-offset-2 focus:outline-none'
                    )}
                    title={preset.name}
                  >
                    <div
                      className={cn(
                        'relative h-8 w-8 rounded-md transition-transform',
                        'group-hover:scale-105',
                        isSelected && 'ring-offset-background scale-105 ring-2 ring-offset-2'
                      )}
                      style={{
                        backgroundColor: preset.hex,
                        ['--tw-ring-color' as string]: isSelected ? preset.hex : undefined,
                      }}
                    >
                      {isSelected && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <Check className="h-4 w-4 text-white drop-shadow-md" />
                        </div>
                      )}
                    </div>
                    <span
                      className={cn(
                        'text-[10px] leading-tight',
                        isSelected ? 'text-foreground font-medium' : 'text-muted-foreground'
                      )}
                    >
                      {preset.name}
                      {isDefaultColor && !isSelected && <span className="opacity-60">*</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="text-muted-foreground text-[10px]">* Cyan is the default accent color</p>
          </div>
        </CardContent>
      </Card>

      {/* Application Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SettingsIcon className="h-5 w-5" />
            Application
          </CardTitle>
          <CardDescription>Configure basic application settings</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <AutosaveSelectField
              id="unitSystem"
              label="Unit System"
              description="Choose how distances and speeds are displayed"
              value={(unitSystemField.value as string) ?? 'metric'}
              onChange={(v) => unitSystemField.setValue(v as 'metric' | 'imperial')}
              options={[
                { value: 'metric', label: 'Metric (km, km/h)' },
                { value: 'imperial', label: 'Imperial (mi, mph)' },
              ]}
              status={unitSystemField.status}
              errorMessage={unitSystemField.errorMessage}
              onRetry={unitSystemField.retry}
              onReset={unitSystemField.reset}
            />

            <AutosaveSwitchField
              id="pollerEnabled"
              label="Session Sync"
              description="Enable session tracking for your media servers"
              checked={pollerEnabledField.value ?? true}
              onChange={(v) => pollerEnabledField.setValue(v)}
              status={pollerEnabledField.status}
              errorMessage={pollerEnabledField.errorMessage}
              onRetry={pollerEnabledField.retry}
              onReset={pollerEnabledField.reset}
            />

            <AutosaveNumberField
              id="pollerIntervalMs"
              label="Sync Interval"
              description="Polling frequency for Jellyfin/Emby (5-300 seconds)"
              value={intervalSeconds}
              onChange={handleIntervalChange}
              min={5}
              max={300}
              suffix="sec"
              disabled={!(pollerEnabledField.value ?? true)}
              status={pollerIntervalField.status}
              errorMessage={pollerIntervalField.errorMessage}
              onRetry={pollerIntervalField.retry}
              onReset={pollerIntervalField.reset}
            />

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

            <AutosaveSwitchField
              id="usePlexGeoip"
              label="Enhanced GeoIP Lookup"
              description="Use Plex's GeoIP service for more accurate location data. When enabled, IP addresses are sent to plex.tv for lookup. Local MaxMind database is used as fallback."
              checked={usePlexGeoipField.value ?? false}
              onChange={(v) => usePlexGeoipField.setValue(v)}
              status={usePlexGeoipField.status}
              errorMessage={usePlexGeoipField.errorMessage}
              onRetry={usePlexGeoipField.retry}
              onReset={usePlexGeoipField.reset}
            />
          </FieldGroup>
        </CardContent>
      </Card>

      {/* Network / External Access */}
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
        <CardContent>
          <FieldGroup>
            <Field>
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor="externalUrl">External URL</FieldLabel>
                <SaveStatusIndicator status={externalUrlField.status} />
              </div>
              <div className="flex gap-2">
                <Input
                  id="externalUrl"
                  placeholder="https://tracearr.example.com"
                  value={externalUrlField.value ?? ''}
                  onChange={(e) => externalUrlField.setValue(e.target.value)}
                  aria-invalid={externalUrlField.status === 'error'}
                />
                <Button variant="outline" onClick={handleDetectUrl}>
                  Detect
                </Button>
              </div>
              <FieldDescription>
                The URL that external devices should use to reach this server. Used for QR codes and
                mobile app pairing.
              </FieldDescription>
              {externalUrlField.status === 'error' && externalUrlField.errorMessage && (
                <div className="flex items-center justify-between">
                  <FieldError>{externalUrlField.errorMessage}</FieldError>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={externalUrlField.retry}
                      className="h-6 px-2 text-xs"
                    >
                      Retry
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={externalUrlField.reset}
                      className="h-6 px-2 text-xs"
                    >
                      Reset
                    </Button>
                  </div>
                </div>
              )}
              {isLocalhost && (
                <div className="flex items-start gap-2 rounded-lg bg-yellow-500/10 p-3 text-sm text-yellow-600 dark:text-yellow-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Localhost URLs only work when your phone is on the same machine. Use your local
                    IP (e.g., http://192.168.1.x:3000) for LAN access, or set up a domain for remote
                    access.
                  </span>
                </div>
              )}
              {isHttp && (
                <div className="flex items-start gap-2 rounded-lg bg-yellow-500/10 p-3 text-sm text-yellow-600 dark:text-yellow-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    iOS requires HTTPS for non-local connections. HTTP will work on local networks
                    but may fail for Tailscale or remote access. Consider using HTTPS with a reverse
                    proxy.
                  </span>
                </div>
              )}
            </Field>

            <AutosaveTextField
              id="basePath"
              label="Base Path"
              description="Only needed if running behind a reverse proxy with a path prefix (e.g., example.com/tracearr). Leave empty for root-level deployments."
              placeholder="/tracearr"
              value={basePathField.value ?? ''}
              onChange={basePathField.setValue}
              status={basePathField.status}
              errorMessage={basePathField.errorMessage}
              onRetry={basePathField.retry}
              onReset={basePathField.reset}
            />
          </FieldGroup>
        </CardContent>
      </Card>

      {/* API Key */}
      <ApiKeyCard />
    </div>
  );
}

function ServerSettings() {
  const { data: serversData, isLoading, refetch } = useServers();
  const deleteServer = useDeleteServer();
  const syncServer = useSyncServer();
  const updateServerUrl = useUpdateServerUrl();
  const reorderServers = useReorderServers();
  const queryClient = useQueryClient();
  const { refetch: refetchUser, user } = useAuth();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editServer, setEditServer] = useState<Server | null>(null);
  const [serverType, setServerType] = useState<'plex' | 'jellyfin' | 'emby'>('plex');
  const [serverUrl, setServerUrl] = useState('');
  const [serverName, setServerName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Plex server discovery state
  const [plexDialogStep, setPlexDialogStep] = useState<
    'loading' | 'no-accounts' | 'select-account' | 'loading-servers' | 'no-servers' | 'select'
  >('loading');
  const [plexServers, setPlexServers] = useState<PlexDiscoveredServer[]>([]);
  const [connectingPlexServer, setConnectingPlexServer] = useState<string | null>(null);

  // Plex account selection state
  const [plexAccounts, setPlexAccounts] = useState<
    { id: string; plexUsername: string | null; plexEmail: string | null }[]
  >([]);
  const [selectedPlexAccountId, setSelectedPlexAccountId] = useState<string | null>(null);

  // Update server type when user data loads (non-owners can't add Plex)
  useEffect(() => {
    if (user && user.role !== 'owner' && serverType === 'plex') {
      setServerType('jellyfin');
    }
  }, [user, serverType]);

  // Fetch Plex accounts when dialog opens with Plex selected
  useEffect(() => {
    if (showAddDialog && serverType === 'plex' && user?.role === 'owner') {
      void fetchPlexAccounts();
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
          void queryClient.invalidateQueries({ queryKey: ['plex-accounts'] });
        },
      });
    }
  };

  const handleSync = (id: string) => {
    syncServer.mutate(id);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = servers.findIndex((s) => s.id === active.id);
    const newIndex = servers.findIndex((s) => s.id === over.id);

    if (oldIndex === -1 || newIndex === -1) {
      return;
    }

    // Reorder locally for immediate feedback (optimistic update)
    const reorderedServers = arrayMove(servers, oldIndex, newIndex);

    // Send new order to backend
    const updates = reorderedServers.map((server, index) => ({
      id: server.id,
      displayOrder: index,
    }));

    reorderServers.mutate(updates);
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
    setPlexAccounts([]);
    setSelectedPlexAccountId(null);
  };

  // Fetch linked Plex accounts
  const fetchPlexAccounts = async () => {
    setPlexDialogStep('loading');
    setConnectError(null);

    try {
      const result = await api.auth.getPlexAccounts();
      const accounts = result.accounts;

      if (accounts.length === 0) {
        setPlexDialogStep('no-accounts');
        return;
      }

      setPlexAccounts(accounts);

      // If only one account, auto-select and fetch servers
      const firstAccount = accounts[0];
      if (accounts.length === 1 && firstAccount) {
        setSelectedPlexAccountId(firstAccount.id);
        await fetchPlexServers(firstAccount.id);
      } else {
        // Multiple accounts - show account selector
        setPlexDialogStep('select-account');
      }
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'Failed to fetch Plex accounts');
      setPlexDialogStep('no-accounts');
    }
  };

  // Fetch available Plex servers for a specific account
  const fetchPlexServers = async (accountId?: string) => {
    setPlexDialogStep('loading-servers');
    setConnectError(null);

    try {
      const result = await api.auth.getAvailablePlexServers(accountId);

      if (!result.hasPlexToken) {
        setPlexDialogStep('no-accounts');
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
      setPlexDialogStep('no-servers');
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
        accountId: selectedPlexAccountId ?? undefined,
      });

      toast.success('Server Added', { description: `${name} has been connected successfully` });

      // Refresh server list, user data, and plex accounts (for server count)
      await refetch();
      await refetchUser();
      void queryClient.invalidateQueries({ queryKey: ['plex-accounts'] });

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
            <CardTitle className="flex items-center gap-2">
              <ServerIcon className="h-5 w-5" />
              Connected Servers
            </CardTitle>
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
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={servers.map((s) => s.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-4">
                  {servers.map((server) => (
                    <SortableServerCard
                      key={server.id}
                      server={server}
                      onSync={() => {
                        handleSync(server.id);
                      }}
                      onDelete={() => {
                        setDeleteId(server.id);
                      }}
                      onEditUrl={() => {
                        setEditServer(server);
                      }}
                      isSyncing={syncServer.isPending}
                      isDraggable={user?.role === 'owner'}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </CardContent>
      </Card>

      {/* Plex Accounts Management - Only for owners */}
      {user?.role === 'owner' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link className="h-5 w-5" />
              Linked Plex Accounts
            </CardTitle>
            <CardDescription>Manage the Plex accounts you can add servers from</CardDescription>
          </CardHeader>
          <CardContent>
            <PlexAccountsManager onAccountLinked={() => void fetchPlexServers()} />
          </CardContent>
        </Card>
      )}

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
                  // Fetch Plex accounts when switching to Plex type
                  if (newType === 'plex' && user?.role === 'owner') {
                    void fetchPlexAccounts();
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
                    <p className="text-muted-foreground text-sm">Loading linked Plex accounts...</p>
                  </div>
                )}

                {plexDialogStep === 'no-accounts' && (
                  <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
                    <AlertTriangle className="h-8 w-8 text-amber-500" />
                    <div>
                      <p className="font-medium">No Plex Accounts Linked</p>
                      <p className="text-muted-foreground mt-1 text-sm">
                        Link a Plex account first using the &quot;Linked Plex Accounts&quot; section
                        below.
                      </p>
                    </div>
                    {connectError && <p className="text-destructive text-sm">{connectError}</p>}
                  </div>
                )}

                {plexDialogStep === 'select-account' && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>Select Plex Account</Label>
                      <Select
                        value={selectedPlexAccountId ?? ''}
                        onValueChange={(id) => {
                          setSelectedPlexAccountId(id);
                          void fetchPlexServers(id);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Choose an account..." />
                        </SelectTrigger>
                        <SelectContent>
                          {plexAccounts.map((account) => (
                            <SelectItem key={account.id} value={account.id}>
                              {account.plexUsername ?? account.plexEmail ?? 'Plex Account'}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-muted-foreground text-xs">
                        You have {plexAccounts.length} Plex accounts linked. Select which one to add
                        a server from.
                      </p>
                    </div>
                  </div>
                )}

                {plexDialogStep === 'loading-servers' && (
                  <div className="flex flex-col items-center justify-center gap-3 py-8">
                    <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
                    <p className="text-muted-foreground text-sm">
                      Discovering available Plex servers...
                    </p>
                  </div>
                )}

                {plexDialogStep === 'no-servers' && (
                  <div className="space-y-4">
                    {plexAccounts.length > 1 && (
                      <div className="space-y-2">
                        <Label>Plex Account</Label>
                        <Select
                          value={selectedPlexAccountId ?? ''}
                          onValueChange={(id) => {
                            setSelectedPlexAccountId(id);
                            void fetchPlexServers(id);
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {plexAccounts.map((account) => (
                              <SelectItem key={account.id} value={account.id}>
                                {account.plexUsername ?? account.plexEmail ?? 'Plex Account'}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
                      <ServerIcon className="text-muted-foreground h-8 w-8" />
                      <div>
                        <p className="font-medium">All Servers Connected</p>
                        <p className="text-muted-foreground mt-1 text-sm">
                          All your owned Plex servers from this account are already connected to
                          Tracearr.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {plexDialogStep === 'select' && (
                  <div className="space-y-4">
                    {plexAccounts.length > 1 && (
                      <div className="space-y-2">
                        <Label>Plex Account</Label>
                        <Select
                          value={selectedPlexAccountId ?? ''}
                          onValueChange={(id) => {
                            setSelectedPlexAccountId(id);
                            void fetchPlexServers(id);
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {plexAccounts.map((account) => (
                              <SelectItem key={account.id} value={account.id}>
                                {account.plexUsername ?? account.plexEmail ?? 'Plex Account'}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <PlexServerSelector
                      servers={plexServers}
                      onSelect={handlePlexServerSelect}
                      connecting={connectingPlexServer !== null}
                      connectingToServer={connectingPlexServer}
                      showCancel={false}
                    />
                  </div>
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

      {/* Edit Server URL Dialog */}
      <EditServerUrlDialog
        server={editServer}
        onClose={() => {
          setEditServer(null);
        }}
        onUpdate={(url, clientIdentifier) => {
          if (editServer) {
            updateServerUrl.mutate(
              { id: editServer.id, url, clientIdentifier },
              {
                onSuccess: () => {
                  setEditServer(null);
                },
              }
            );
          }
        }}
        isUpdating={updateServerUrl.isPending}
      />
    </>
  );
}

/**
 * Edit Server URL Dialog
 * For Plex servers: Shows PlexServerSelector with available connections
 * For Jellyfin/Emby: Shows simple URL input
 */
function EditServerUrlDialog({
  server,
  onClose,
  onUpdate,
  isUpdating,
}: {
  server: Server | null;
  onClose: () => void;
  onUpdate: (url: string, clientIdentifier?: string) => void;
  isUpdating: boolean;
}) {
  const [manualUrl, setManualUrl] = useState('');
  const isPlexServer = server?.type === 'plex';

  // Fetch connections for Plex servers
  const { data: connectionsData, isLoading: isLoadingConnections } = usePlexServerConnections(
    isPlexServer ? server?.id : undefined
  );

  // Reset manual URL when dialog opens
  useEffect(() => {
    if (server) {
      setManualUrl(server.url);
    }
  }, [server]);

  const handlePlexSelect = (uri: string, _name: string, clientIdentifier: string) => {
    onUpdate(uri, clientIdentifier);
  };

  if (!server) return null;

  return (
    <Dialog open={!!server} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn('max-w-md', isPlexServer && 'max-w-lg')}>
        <DialogHeader>
          <DialogTitle>Edit Server URL</DialogTitle>
          <DialogDescription>
            {isPlexServer
              ? `Select a connection for ${server.name}, or enter a custom URL.`
              : `Update the URL for ${server.name}. The existing API token will be tested against the new URL.`}
          </DialogDescription>
        </DialogHeader>

        {isPlexServer ? (
          // Plex: Show server selector
          <div className="py-4">
            {isLoadingConnections ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin" />
                <span className="text-muted-foreground ml-2 text-sm">
                  Discovering connections...
                </span>
              </div>
            ) : connectionsData?.server ? (
              <PlexServerSelector
                servers={[connectionsData.server]}
                onSelect={handlePlexSelect}
                connecting={isUpdating}
                connectingToServer={isUpdating ? server.name : null}
                onCancel={onClose}
                showCancel={true}
              />
            ) : (
              <div className="space-y-4">
                <p className="text-muted-foreground text-sm">
                  Could not discover server connections. Enter a URL manually:
                </p>
                <div className="space-y-2">
                  <Label htmlFor="edit-url">Server URL</Label>
                  <Input
                    id="edit-url"
                    value={manualUrl}
                    onChange={(e) => setManualUrl(e.target.value)}
                    placeholder="http://192.168.1.100:32400"
                  />
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => onUpdate(manualUrl)}
                    disabled={isUpdating || !manualUrl || manualUrl === server.url}
                  >
                    {isUpdating ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Updating...
                      </>
                    ) : (
                      'Update URL'
                    )}
                  </Button>
                </DialogFooter>
              </div>
            )}
          </div>
        ) : (
          // Jellyfin/Emby: Simple URL input
          <>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="edit-url">Server URL</Label>
                <Input
                  id="edit-url"
                  value={manualUrl}
                  onChange={(e) => setManualUrl(e.target.value)}
                  placeholder="http://192.168.1.100:8096"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={() => onUpdate(manualUrl)}
                disabled={isUpdating || !manualUrl || manualUrl === server.url}
              >
                {isUpdating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Updating...
                  </>
                ) : (
                  'Update URL'
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SortableServerCard({
  server,
  onSync,
  onDelete,
  onEditUrl,
  isSyncing,
  isDraggable,
}: {
  server: Server;
  onSync: () => void;
  onDelete: () => void;
  onEditUrl: () => void;
  isSyncing?: boolean;
  isDraggable?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: server.id,
    disabled: !isDraggable,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="touch-none">
      <div
        className={cn(
          'flex items-center justify-between rounded-lg border p-4',
          isDragging && 'ring-primary ring-2'
        )}
      >
        <div className="flex items-center gap-4">
          {isDraggable && (
            <button
              className="text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing"
              {...attributes}
              {...listeners}
            >
              <GripVertical className="h-5 w-5" />
            </button>
          )}
          <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-lg">
            <MediaServerIcon type={server.type} className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">{server.name}</h3>
            </div>
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <span>{server.url}</span>
              <button onClick={onEditUrl} className="hover:text-primary" title="Edit URL">
                <Pencil className="h-3 w-3" />
              </button>
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
    </div>
  );
}

function NotificationSettings() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5" />
          Notification Agents
        </CardTitle>
        <CardDescription>
          Configure notification channels and select which events each agent should receive.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <NotificationAgentsManager />
      </CardContent>
    </Card>
  );
}

function AccessSettings() {
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const { data: serversData, isLoading: serversLoading } = useServers();
  const { user } = useAuth();

  const allowGuestAccessField = useDebouncedSave('allowGuestAccess', settings?.allowGuestAccess);
  const primaryAuthMethodField = useDebouncedSave('primaryAuthMethod', settings?.primaryAuthMethod);

  const isLoading = settingsLoading || serversLoading;
  // Handle both array and wrapped response formats
  const servers = Array.isArray(serversData)
    ? serversData
    : ((serversData as unknown as { data?: Server[] })?.data ?? []);
  const hasJellyfinServer = servers.some((s) => s.type === 'jellyfin');
  const hasLocalCredentials = user?.hasPassword ?? false;

  const showAuthMethodSelector = hasLocalCredentials && hasJellyfinServer;

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
        <FieldGroup>
          <AutosaveSwitchField
            id="allowGuestAccess"
            label="Allow Guest Access"
            description="When disabled, only the server owner can log in to Tracearr"
            checked={allowGuestAccessField.value ?? false}
            onChange={allowGuestAccessField.setValue}
            status={allowGuestAccessField.status}
            errorMessage={allowGuestAccessField.errorMessage}
            onRetry={allowGuestAccessField.retry}
            onReset={allowGuestAccessField.reset}
          />

          {showAuthMethodSelector && (
            <Field>
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor="primaryAuthMethod">Primary Authentication Method</FieldLabel>
                <SaveStatusIndicator status={primaryAuthMethodField.status} />
              </div>
              <Select
                value={primaryAuthMethodField.value ?? 'local'}
                onValueChange={(value: 'jellyfin' | 'local') => {
                  primaryAuthMethodField.setValue(value);
                }}
              >
                <SelectTrigger
                  id="primaryAuthMethod"
                  className="w-full"
                  aria-invalid={primaryAuthMethodField.status === 'error'}
                >
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
              <FieldDescription>
                Choose which authentication method is shown by default on the login page
              </FieldDescription>
              {primaryAuthMethodField.status === 'error' && primaryAuthMethodField.errorMessage && (
                <div className="flex items-center justify-between">
                  <FieldError>{primaryAuthMethodField.errorMessage}</FieldError>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={primaryAuthMethodField.retry}
                      className="h-6 px-2 text-xs"
                    >
                      Retry
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={primaryAuthMethodField.reset}
                      className="h-6 px-2 text-xs"
                    >
                      Reset
                    </Button>
                  </div>
                </div>
              )}
            </Field>
          )}
        </FieldGroup>

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
    // Convert to UTF-8 bytes then base64 to handle non-ASCII characters (e.g., umlauts)
    const jsonString = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(jsonString);
    const encoded = btoa(String.fromCharCode(...bytes));
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
          {!settings?.externalUrl && (
            <div className="flex items-start gap-2 rounded-lg bg-blue-500/10 p-3 text-sm text-blue-600 dark:text-blue-400">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Using a reverse proxy or accessing remotely? Set your{' '}
                <NavLink to="/settings" className="font-medium underline underline-offset-2">
                  External URL
                </NavLink>{' '}
                so the mobile app can connect to your server.
              </span>
            </div>
          )}
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
                <CardTitle className="flex items-center gap-2">
                  <Smartphone className="h-5 w-5" />
                  Connected Devices
                </CardTitle>
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
              <span className="bg-muted rounded px-2 py-0.5 text-xs">
                {session.platform === 'ios'
                  ? 'iOS'
                  : session.platform === 'android'
                    ? 'Android'
                    : session.platform}
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

  // Tautulli state
  const [tautulliUrl, setTautulliUrl] = useState('');
  const [tautulliApiKey, setTautulliApiKey] = useState('');
  const [selectedPlexServerId, setSelectedPlexServerId] = useState<string>('');
  const [connectionStatus, setConnectionStatus] = useState<
    'idle' | 'testing' | 'success' | 'error'
  >('idle');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [tautulliProgress, setTautulliProgress] = useState<TautulliImportProgress | null>(null);
  const [isTautulliImporting, setIsTautulliImporting] = useState(false);
  const [overwriteFriendlyNames, setOverwriteFriendlyNames] = useState(false);
  const [includeStreamDetails, setIncludeStreamDetails] = useState(false);
  const [_tautulliActiveJobId, setTautulliActiveJobId] = useState<string | null>(null);

  // Jellystat state
  const [selectedJellyfinServerId, setSelectedJellyfinServerId] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [enrichMedia, setEnrichMedia] = useState(true);
  const [updateStreamDetails, setUpdateStreamDetails] = useState(false);
  const [jellystatProgress, setJellystatProgress] = useState<JellystatImportProgress | null>(null);
  const [isJellystatImporting, setIsJellystatImporting] = useState(false);
  const [_jellystatActiveJobId, setJellystatActiveJobId] = useState<string | null>(null);

  // Handle both array and wrapped response formats
  const servers = Array.isArray(serversData)
    ? serversData
    : ((serversData as unknown as { data?: Server[] })?.data ?? []);

  // Split servers by type
  const plexServers = servers.filter((s) => s.type === 'plex');
  const jellyfinEmbyServers = servers.filter((s) => s.type === 'jellyfin' || s.type === 'emby');

  // Initialize form with saved settings
  useEffect(() => {
    if (settings) {
      setTautulliUrl(settings.tautulliUrl ?? '');
      setTautulliApiKey(settings.tautulliApiKey ?? '');
      if (settings.tautulliUrl && settings.tautulliApiKey) {
        setConnectionStatus('success');
      }
    }
  }, [settings]);

  // Check for active Tautulli import on mount
  useEffect(() => {
    if (plexServers.length === 0) return;

    const checkActiveImports = async () => {
      for (const server of plexServers) {
        try {
          const result = await api.import.tautulli.getActive(server.id);
          if (result.active && result.jobId) {
            setSelectedPlexServerId(server.id);
            setTautulliActiveJobId(result.jobId);
            setIsTautulliImporting(true);

            const progressPercent = typeof result.progress === 'number' ? result.progress : 0;
            setTautulliProgress({
              status: 'processing',
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
              message:
                progressPercent > 0
                  ? `Import in progress (${progressPercent}% complete)...`
                  : 'Import in progress...',
            });
            setConnectionStatus('success');
            break;
          }
        } catch {
          // Ignore errors
        }
      }
    };

    void checkActiveImports();
  }, [plexServers.length]);

  // Check for active Jellystat import on mount
  useEffect(() => {
    if (jellyfinEmbyServers.length === 0) return;

    const checkActiveJellystatImports = async () => {
      for (const server of jellyfinEmbyServers) {
        try {
          const result = await api.import.jellystat.getActive(server.id);
          if (result.active && result.jobId) {
            setSelectedJellyfinServerId(server.id);
            setJellystatActiveJobId(result.jobId);
            setIsJellystatImporting(true);

            const progressPercent = typeof result.progress === 'number' ? result.progress : 0;
            setJellystatProgress({
              status: 'processing',
              totalRecords: 0,
              processedRecords: 0,
              importedRecords: 0,
              skippedRecords: 0,
              errorRecords: 0,
              enrichedRecords: 0,
              message:
                progressPercent > 0
                  ? `Import in progress (${progressPercent}% complete)...`
                  : 'Import in progress...',
            });
            break;
          }
        } catch {
          // Ignore errors
        }
      }
    };

    void checkActiveJellystatImports();
  }, [jellyfinEmbyServers.length]);

  // Listen for Tautulli import progress via WebSocket
  useEffect(() => {
    if (!socket) return;

    const handleTautulliProgress = (progress: TautulliImportProgress) => {
      setTautulliProgress(progress);
      if (progress.status === 'complete' || progress.status === 'error') {
        setIsTautulliImporting(false);
        setTautulliActiveJobId(null);
      }
    };

    socket.on('import:progress', handleTautulliProgress);
    return () => {
      socket.off('import:progress', handleTautulliProgress);
    };
  }, [socket]);

  // Listen for Jellystat import progress via WebSocket
  useEffect(() => {
    if (!socket) return;

    const handleJellystatProgress = (progress: JellystatImportProgress) => {
      setJellystatProgress(progress);
      if (progress.status === 'complete' || progress.status === 'error') {
        setIsJellystatImporting(false);
        setJellystatActiveJobId(null);
        setSelectedFile(null);
      }
    };

    socket.on('import:jellystat:progress', handleJellystatProgress);
    return () => {
      socket.off('import:jellystat:progress', handleJellystatProgress);
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
          `Connected! Found ${result.users ?? 0} users and ${(result.historyRecords ?? 0).toLocaleString()} history records.`
        );
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

  const handleStartTautulliImport = async () => {
    if (!selectedPlexServerId) return;

    setIsTautulliImporting(true);
    setTautulliProgress({
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
      const result = await api.import.tautulli.start(
        selectedPlexServerId,
        overwriteFriendlyNames,
        includeStreamDetails
      );
      if (result.jobId) {
        setTautulliActiveJobId(result.jobId);
      }
    } catch (err) {
      setIsTautulliImporting(false);
      setTautulliActiveJobId(null);
      setTautulliProgress({
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

  const handleFileSelect = (file: File | null) => {
    if (file && !file.name.endsWith('.json')) {
      setJellystatProgress({
        status: 'error',
        totalRecords: 0,
        processedRecords: 0,
        importedRecords: 0,
        skippedRecords: 0,
        errorRecords: 0,
        enrichedRecords: 0,
        message: 'Please select a JSON file',
      });
      return;
    }
    setSelectedFile(file);
    if (file) {
      setJellystatProgress(null);
    }
  };

  const handleStartJellystatImport = async () => {
    if (!selectedJellyfinServerId || !selectedFile) return;

    setIsJellystatImporting(true);
    setJellystatProgress({
      status: 'processing',
      totalRecords: 0,
      processedRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      errorRecords: 0,
      enrichedRecords: 0,
      message: 'Uploading backup file...',
    });

    try {
      const result = await api.import.jellystat.start(
        selectedJellyfinServerId,
        selectedFile,
        enrichMedia,
        updateStreamDetails
      );
      if (result.jobId) {
        setJellystatActiveJobId(result.jobId);
      }
    } catch (err) {
      setIsJellystatImporting(false);
      setJellystatActiveJobId(null);
      setJellystatProgress({
        status: 'error',
        totalRecords: 0,
        processedRecords: 0,
        importedRecords: 0,
        skippedRecords: 0,
        errorRecords: 0,
        enrichedRecords: 0,
        message: err instanceof Error ? err.message : 'Import failed',
      });
    }
  };

  // Convert progress types for the reusable component
  const tautulliProgressData: ImportProgressData | null = tautulliProgress
    ? {
        status: tautulliProgress.status === 'fetching' ? 'fetching' : tautulliProgress.status,
        message: tautulliProgress.message,
        totalRecords: tautulliProgress.totalRecords,
        processedRecords: tautulliProgress.processedRecords,
        importedRecords: tautulliProgress.importedRecords,
        skippedRecords: tautulliProgress.skippedRecords,
        errorRecords: tautulliProgress.errorRecords,
        currentPage: tautulliProgress.currentPage,
        totalPages: tautulliProgress.totalPages,
      }
    : null;

  const jellystatProgressData: ImportProgressData | null = jellystatProgress
    ? {
        status:
          jellystatProgress.status === 'parsing' || jellystatProgress.status === 'enriching'
            ? 'processing'
            : jellystatProgress.status,
        message: jellystatProgress.message,
        totalRecords: jellystatProgress.totalRecords,
        processedRecords: jellystatProgress.processedRecords,
        importedRecords: jellystatProgress.importedRecords,
        skippedRecords: jellystatProgress.skippedRecords,
        errorRecords: jellystatProgress.errorRecords,
        enrichedRecords: jellystatProgress.enrichedRecords,
      }
    : null;

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

  const hasPlexServers = plexServers.length > 0;
  const hasJellyfinEmbyServers = jellyfinEmbyServers.length > 0;
  const hasBothServerTypes = hasPlexServers && hasJellyfinEmbyServers;

  // Determine default tab based on available server types
  const defaultTab = hasPlexServers ? 'plex' : 'jellyfin';

  // No servers state
  if (!hasPlexServers && !hasJellyfinEmbyServers) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Import History
          </CardTitle>
          <CardDescription>Import historical watch data from external sources</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8">
            <ServerIcon className="text-muted-foreground h-8 w-8" />
            <div className="text-center">
              <p className="font-medium">No Servers Connected</p>
              <p className="text-muted-foreground mt-1 text-sm">
                Add a media server first to import historical watch data.
              </p>
            </div>
            <Button variant="outline" asChild>
              <a href="/settings/servers">Add Server</a>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="h-5 w-5" />
          Import History
        </CardTitle>
        <CardDescription>
          Import historical watch data from external sources like Tautulli or Jellystat
        </CardDescription>
      </CardHeader>
      <CardContent>
        {hasBothServerTypes ? (
          <Tabs defaultValue={defaultTab} className="w-full">
            <TabsList className="mb-6 grid w-full grid-cols-2">
              <TabsTrigger value="plex" className="flex items-center gap-2">
                <MediaServerIcon type="plex" className="h-4 w-4" />
                Plex (Tautulli)
              </TabsTrigger>
              <TabsTrigger value="jellyfin" className="flex items-center gap-2">
                <MediaServerIcon type="jellyfin" className="h-4 w-4" />
                Jellyfin/Emby (Jellystat)
              </TabsTrigger>
            </TabsList>

            <TabsContent value="plex" className="mt-0 space-y-6">
              <TautulliImportSection
                tautulliUrl={tautulliUrl}
                setTautulliUrl={setTautulliUrl}
                tautulliApiKey={tautulliApiKey}
                setTautulliApiKey={setTautulliApiKey}
                connectionStatus={connectionStatus}
                connectionMessage={connectionMessage}
                handleTestConnection={handleTestConnection}
                plexServers={plexServers}
                selectedPlexServerId={selectedPlexServerId}
                setSelectedPlexServerId={setSelectedPlexServerId}
                isTautulliImporting={isTautulliImporting}
                overwriteFriendlyNames={overwriteFriendlyNames}
                setOverwriteFriendlyNames={setOverwriteFriendlyNames}
                includeStreamDetails={includeStreamDetails}
                setIncludeStreamDetails={setIncludeStreamDetails}
                handleStartTautulliImport={handleStartTautulliImport}
                tautulliProgressData={tautulliProgressData}
              />
            </TabsContent>

            <TabsContent value="jellyfin" className="mt-0 space-y-6">
              <JellystatImportSection
                jellyfinEmbyServers={jellyfinEmbyServers}
                selectedJellyfinServerId={selectedJellyfinServerId}
                setSelectedJellyfinServerId={setSelectedJellyfinServerId}
                selectedFile={selectedFile}
                handleFileSelect={handleFileSelect}
                enrichMedia={enrichMedia}
                setEnrichMedia={setEnrichMedia}
                updateStreamDetails={updateStreamDetails}
                setUpdateStreamDetails={setUpdateStreamDetails}
                isJellystatImporting={isJellystatImporting}
                handleStartJellystatImport={handleStartJellystatImport}
                jellystatProgressData={jellystatProgressData}
              />
            </TabsContent>
          </Tabs>
        ) : hasPlexServers ? (
          <TautulliImportSection
            tautulliUrl={tautulliUrl}
            setTautulliUrl={setTautulliUrl}
            tautulliApiKey={tautulliApiKey}
            setTautulliApiKey={setTautulliApiKey}
            connectionStatus={connectionStatus}
            connectionMessage={connectionMessage}
            handleTestConnection={handleTestConnection}
            plexServers={plexServers}
            selectedPlexServerId={selectedPlexServerId}
            setSelectedPlexServerId={setSelectedPlexServerId}
            isTautulliImporting={isTautulliImporting}
            overwriteFriendlyNames={overwriteFriendlyNames}
            setOverwriteFriendlyNames={setOverwriteFriendlyNames}
            includeStreamDetails={includeStreamDetails}
            setIncludeStreamDetails={setIncludeStreamDetails}
            handleStartTautulliImport={handleStartTautulliImport}
            tautulliProgressData={tautulliProgressData}
          />
        ) : (
          <JellystatImportSection
            jellyfinEmbyServers={jellyfinEmbyServers}
            selectedJellyfinServerId={selectedJellyfinServerId}
            setSelectedJellyfinServerId={setSelectedJellyfinServerId}
            selectedFile={selectedFile}
            handleFileSelect={handleFileSelect}
            enrichMedia={enrichMedia}
            setEnrichMedia={setEnrichMedia}
            updateStreamDetails={updateStreamDetails}
            setUpdateStreamDetails={setUpdateStreamDetails}
            isJellystatImporting={isJellystatImporting}
            handleStartJellystatImport={handleStartJellystatImport}
            jellystatProgressData={jellystatProgressData}
          />
        )}
      </CardContent>
    </Card>
  );
}

// Tautulli Import Section Component
interface TautulliImportSectionProps {
  tautulliUrl: string;
  setTautulliUrl: (url: string) => void;
  tautulliApiKey: string;
  setTautulliApiKey: (key: string) => void;
  connectionStatus: 'idle' | 'testing' | 'success' | 'error';
  connectionMessage: string;
  handleTestConnection: () => Promise<void>;
  plexServers: Server[];
  selectedPlexServerId: string;
  setSelectedPlexServerId: (id: string) => void;
  isTautulliImporting: boolean;
  overwriteFriendlyNames: boolean;
  setOverwriteFriendlyNames: (overwrite: boolean) => void;
  includeStreamDetails: boolean;
  setIncludeStreamDetails: (include: boolean) => void;
  handleStartTautulliImport: () => Promise<void>;
  tautulliProgressData: ImportProgressData | null;
}

function TautulliImportSection({
  tautulliUrl,
  setTautulliUrl,
  tautulliApiKey,
  setTautulliApiKey,
  connectionStatus,
  connectionMessage,
  handleTestConnection,
  plexServers,
  selectedPlexServerId,
  setSelectedPlexServerId,
  isTautulliImporting,
  overwriteFriendlyNames,
  setOverwriteFriendlyNames,
  includeStreamDetails,
  setIncludeStreamDetails,
  handleStartTautulliImport,
  tautulliProgressData,
}: TautulliImportSectionProps) {
  return (
    <div className="space-y-6">
      {/* Connection Setup */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs">
            1
          </span>
          Connect to Tautulli
        </div>

        <div className="ml-8 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tautulliUrl">Tautulli URL</Label>
            <Input
              id="tautulliUrl"
              placeholder="http://localhost:8181"
              value={tautulliUrl}
              onChange={(e) => setTautulliUrl(e.target.value)}
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
              onChange={(e) => setTautulliApiKey(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              Find this in Tautulli Settings → Web Interface → API Key
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={handleTestConnection}
              disabled={connectionStatus === 'testing' || !tautulliUrl || !tautulliApiKey}
              variant={connectionStatus === 'success' ? 'outline' : 'default'}
            >
              {connectionStatus === 'testing' ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Testing...
                </>
              ) : connectionStatus === 'success' ? (
                <>
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  Connected
                </>
              ) : (
                'Test Connection'
              )}
            </Button>

            {connectionStatus === 'success' && connectionMessage && (
              <span className="text-sm text-green-600">{connectionMessage}</span>
            )}

            {connectionStatus === 'error' && (
              <span className="text-destructive flex items-center gap-1 text-sm">
                <XCircle className="h-4 w-4" />
                {connectionMessage}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Import Section - Only shown when connected */}
      {connectionStatus === 'success' && (
        <>
          <div className="space-y-4 border-t pt-6">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs">
                2
              </span>
              Import History
            </div>

            <div className="ml-8 space-y-4">
              <div className="space-y-2">
                <Label>Target Server</Label>
                <Select value={selectedPlexServerId} onValueChange={setSelectedPlexServerId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a Plex server" />
                  </SelectTrigger>
                  <SelectContent>
                    {plexServers.map((server) => (
                      <SelectItem key={server.id} value={server.id}>
                        <div className="flex items-center gap-2">
                          <MediaServerIcon type="plex" className="h-4 w-4" />
                          {server.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-start space-x-3">
                <Checkbox
                  id="overwriteFriendlyNames"
                  checked={overwriteFriendlyNames}
                  onCheckedChange={(checked: boolean | 'indeterminate') =>
                    setOverwriteFriendlyNames(checked === true)
                  }
                  disabled={isTautulliImporting}
                />
                <div className="space-y-1">
                  <Label
                    htmlFor="overwriteFriendlyNames"
                    className="cursor-pointer text-sm font-normal"
                  >
                    Overwrite existing friendly names with Tautulli names
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    By default, Tracearr keeps any custom names already set. Enable this to replace
                    all existing names with the ones from Tautulli.
                  </p>
                </div>
              </div>

              <div className="flex items-start space-x-3">
                <Checkbox
                  id="includeStreamDetails"
                  checked={includeStreamDetails}
                  onCheckedChange={(checked: boolean | 'indeterminate') =>
                    setIncludeStreamDetails(checked === true)
                  }
                  disabled={isTautulliImporting}
                />
                <div className="space-y-1">
                  <Label
                    htmlFor="includeStreamDetails"
                    className="flex cursor-pointer items-center gap-2 text-sm font-normal"
                  >
                    Include detailed stream data (codecs, bitrate, resolution)
                    <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-500">
                      BETA
                    </span>
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    Fetches additional quality data for each session via separate API calls. This
                    enables bandwidth and quality statistics but significantly increases import
                    time.
                  </p>
                </div>
              </div>

              <Button
                onClick={handleStartTautulliImport}
                disabled={!selectedPlexServerId || isTautulliImporting}
                size="lg"
              >
                {isTautulliImporting ? (
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

              {tautulliProgressData && (
                <ImportProgressCard progress={tautulliProgressData} showPageProgress />
              )}
            </div>
          </div>

          {/* Info cards */}
          <div className="space-y-3">
            <div className="bg-muted/50 flex gap-3 rounded-lg p-4">
              <Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
              <div className="text-muted-foreground space-y-2 text-sm">
                <p className="text-foreground font-medium">How the import works</p>
                <p>
                  Tracearr fetches your watch history from Tautulli and matches each record to
                  existing users in Tracearr by their Plex user ID.
                </p>
              </div>
            </div>

            <div className="flex gap-3 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
              <div className="space-y-2 text-sm">
                <p className="font-medium">Records may be skipped if:</p>
                <ul className="text-muted-foreground list-inside list-disc space-y-1">
                  <li>
                    <strong>User not found</strong> — The Plex user doesn&apos;t exist in Tracearr.
                    Sync your server first to add all users.
                  </li>
                  <li>
                    <strong>Duplicate session</strong> — The session was already imported
                    previously.
                  </li>
                  <li>
                    <strong>In-progress session</strong> — Active/incomplete sessions without a
                    reference ID are skipped.
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Jellystat Import Section Component
interface JellystatImportSectionProps {
  jellyfinEmbyServers: Server[];
  selectedJellyfinServerId: string;
  setSelectedJellyfinServerId: (id: string) => void;
  selectedFile: File | null;
  handleFileSelect: (file: File | null) => void;
  enrichMedia: boolean;
  setEnrichMedia: (enrich: boolean) => void;
  updateStreamDetails: boolean;
  setUpdateStreamDetails: (update: boolean) => void;
  isJellystatImporting: boolean;
  handleStartJellystatImport: () => Promise<void>;
  jellystatProgressData: ImportProgressData | null;
}

function JellystatImportSection({
  jellyfinEmbyServers,
  selectedJellyfinServerId,
  setSelectedJellyfinServerId,
  selectedFile,
  handleFileSelect,
  enrichMedia,
  setEnrichMedia,
  updateStreamDetails,
  setUpdateStreamDetails,
  isJellystatImporting,
  handleStartJellystatImport,
  jellystatProgressData,
}: JellystatImportSectionProps) {
  return (
    <div className="space-y-6">
      {/* Server Selection */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs">
            1
          </span>
          Select Target Server
        </div>

        <div className="ml-8 space-y-2">
          <Select value={selectedJellyfinServerId} onValueChange={setSelectedJellyfinServerId}>
            <SelectTrigger>
              <SelectValue placeholder="Select a Jellyfin or Emby server" />
            </SelectTrigger>
            <SelectContent>
              {jellyfinEmbyServers.map((server) => (
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
      </div>

      {/* File Upload */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs">
            2
          </span>
          Upload Jellystat Backup
        </div>

        <div className="ml-8 space-y-4">
          <FileDropzone
            accept=".json"
            maxSize={500 * 1024 * 1024}
            onFileSelect={handleFileSelect}
            selectedFile={selectedFile}
            disabled={isJellystatImporting}
          />
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
            <p className="text-sm font-medium text-blue-600 dark:text-blue-400">
              Export an Activity Backup from Jellystat
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              In Jellystat, go to Settings → Backup → select <strong>&quot;Activity&quot;</strong> →
              Export. Full backups are not supported — only the Activity backup contains the
              playback history needed for import.
            </p>
          </div>
        </div>
      </div>

      {/* Options */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="bg-primary text-primary-foreground flex h-6 w-6 items-center justify-center rounded-full text-xs">
            3
          </span>
          Import Options
        </div>

        <div className="ml-8 space-y-3">
          <div className="flex items-start space-x-3">
            <Checkbox
              id="enrichMedia"
              checked={enrichMedia}
              onCheckedChange={(checked: boolean | 'indeterminate') =>
                setEnrichMedia(checked === true)
              }
              disabled={isJellystatImporting}
            />
            <div className="space-y-1">
              <Label htmlFor="enrichMedia" className="cursor-pointer text-sm font-normal">
                Enrich with media metadata (recommended)
              </Label>
              <p className="text-muted-foreground text-xs">
                Fetches season/episode numbers and artwork from your media server. Slower but
                provides better data quality.
              </p>
            </div>
          </div>
          <div className="flex items-start space-x-3">
            <Checkbox
              id="updateStreamDetails"
              checked={updateStreamDetails}
              onCheckedChange={(checked: boolean | 'indeterminate') =>
                setUpdateStreamDetails(checked === true)
              }
              disabled={isJellystatImporting}
            />
            <div className="space-y-1">
              <Label htmlFor="updateStreamDetails" className="cursor-pointer text-sm font-normal">
                Update existing records with stream details
              </Label>
              <p className="text-muted-foreground text-xs">
                Updates previously imported sessions with codec, bitrate, and transcode data from
                the backup. Use when re-importing to backfill new stream fields.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Import Button */}
      <div className="border-t pt-6">
        <Button
          onClick={handleStartJellystatImport}
          disabled={!selectedJellyfinServerId || !selectedFile || isJellystatImporting}
          size="lg"
        >
          {isJellystatImporting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Importing...
            </>
          ) : (
            <>
              <Upload className="mr-2 h-4 w-4" />
              Start Import
            </>
          )}
        </Button>

        {jellystatProgressData && (
          <div className="mt-4">
            <ImportProgressCard progress={jellystatProgressData} />
          </div>
        )}
      </div>

      {/* Info cards */}
      <div className="space-y-3">
        <div className="bg-muted/50 flex gap-3 rounded-lg p-4">
          <Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
          <div className="text-muted-foreground space-y-2 text-sm">
            <p className="text-foreground font-medium">How the import works</p>
            <p>
              Tracearr parses the Jellystat Activity backup and matches each record to existing
              users in Tracearr by their Jellyfin/Emby user ID.
            </p>
          </div>
        </div>

        <div className="flex gap-3 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
          <div className="space-y-2 text-sm">
            <p className="font-medium">Records may be skipped if:</p>
            <ul className="text-muted-foreground list-inside list-disc space-y-1">
              <li>
                <strong>User not found</strong> — The Jellyfin/Emby user doesn&apos;t exist in
                Tracearr. Sync your server first to add all users.
              </li>
              <li>
                <strong>Duplicate session</strong> — The session was already imported previously.
              </li>
            </ul>
            <p className="text-muted-foreground pt-1">
              If many records are skipped, ensure you&apos;ve synced your server recently in
              Settings → Servers.
            </p>
          </div>
        </div>
      </div>
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
        <Route path="servers" element={<ServerSettings />} />
        <Route path="notifications" element={<NotificationSettings />} />
        <Route path="access" element={<AccessSettings />} />
        <Route path="mobile" element={<MobileSettings />} />
        <Route path="import" element={<ImportSettings />} />
        <Route path="jobs" element={<JobsSettings />} />
      </Routes>
    </div>
  );
}
