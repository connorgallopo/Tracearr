import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { CopyButton } from '@/components/ui/copy-button';
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
  ExternalLink,
  XCircle,
  Loader2,
  AlertTriangle,
  Plus,
  Pencil,
  GripVertical,
  Link2,
  Check,
  Zap,
  Radio,
  ArrowUpCircle,
  Image as ImageIcon,
} from 'lucide-react';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { api, tokenStorage } from '@/lib/api';
import type { PlexDiscoveredServer } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { useSocket } from '@/hooks/useSocket';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';
import { AutosaveSelectField } from '@/components/ui/autosave-field';
import { toast } from 'sonner';
import { PlexServerSelector } from '@/components/auth/PlexServerSelector';
import { PlexAccountsManager } from '@/components/settings/PlexAccountsManager';
import { ServerVersionLine } from '@/components/settings/ServerVersionLine';
import { SERVER_COLOR_PALETTE, pickServerColor } from '@tracearr/shared';
import type { Server, ServerConnectionStatus } from '@tracearr/shared';
import {
  useServers,
  useDeleteServer,
  useSyncServer,
  useUpdateServer,
  usePlexServerConnections,
  useReorderServers,
  useSettings,
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

export function ServerSettings() {
  const { t } = useTranslation(['settings', 'common', 'notifications', 'pages']);
  const { data: serversData, isLoading, refetch } = useServers();
  const deleteServer = useDeleteServer();
  const syncServer = useSyncServer();
  const updateServer = useUpdateServer();
  const reorderServers = useReorderServers();
  const queryClient = useQueryClient();
  const { refetch: refetchUser, user } = useAuth();
  const { serverConnectionStatuses } = useSocket();
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
    setServerType(defaultServerType);
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

  // Fetch Plex accounts when dialog opens with Plex selected
  useEffect(() => {
    if (showAddDialog && serverType === 'plex' && user?.role === 'owner') {
      void fetchPlexAccounts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only trigger on dialog open, not serverType changes
  }, [showAddDialog]);

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

      toast.success(t('notifications:toast.success.serverAdded.title'), {
        description: t('notifications:toast.success.serverAdded.message', { name }),
      });

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
      setConnectError(t('servers.allFieldsRequired'));
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
          {Array.from({ length: 2 }, (_, i) => (
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
              {t('servers.title')}
            </CardTitle>
            <CardDescription>{t('servers.description')}</CardDescription>
          </div>
          <Button
            onClick={() => {
              setShowAddDialog(true);
            }}
          >
            <Plus />
            {t('servers.addServer')}
          </Button>
        </CardHeader>
        <CardContent>
          {!servers || servers.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed">
              <ServerIcon className="text-muted-foreground h-8 w-8" />
              <p className="text-muted-foreground">{t('servers.noServersConnected')}</p>
              <p className="text-muted-foreground text-xs">{t('servers.noServersConnectedHint')}</p>
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
                      connectionStatus={serverConnectionStatuses.get(server.id)}
                      onSync={() => {
                        handleSync(server.id);
                      }}
                      onDelete={() => {
                        setDeleteId(server.id);
                      }}
                      onEdit={() => {
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

      {/* Poster source preference - Only for owners */}
      <PosterSourceCard servers={servers} isOwner={user?.role === 'owner'} />

      {/* Plex Accounts Management - Only for owners */}
      {user?.role === 'owner' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5" />
              {t('pages:settings.plex.linkedAccounts')}
            </CardTitle>
            <CardDescription>{t('pages:settings.plex.linkedAccountsDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <PlexAccountsManager
              onAccountLinked={(accountId) => {
                setSelectedPlexAccountId(accountId);
                void fetchPlexServers(accountId);
              }}
            />
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
        <DialogContent className="w-fit max-w-[calc(100vw-2rem)] min-w-[28rem] sm:max-w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>{t('servers.addServer')}</DialogTitle>
            <DialogDescription>
              {serverType === 'plex'
                ? t('servers.addServerDialogDescPlex')
                : t('servers.addServerDialogDescOther')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Server Type Selector */}
            <div className="space-y-2">
              <Label>{t('servers.serverType')}</Label>
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
                    <p className="text-muted-foreground text-sm">{t('servers.loadingAccounts')}</p>
                  </div>
                )}

                {plexDialogStep === 'no-accounts' && (
                  <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
                    <AlertTriangle className="h-8 w-8 text-amber-500" />
                    <div>
                      <p className="font-medium">{t('servers.noPlexAccountsLinked')}</p>
                      <p className="text-muted-foreground mt-1 text-sm">
                        {t('servers.noPlexAccountsLinkedHint')}
                      </p>
                    </div>
                    {connectError && <p className="text-destructive text-sm">{connectError}</p>}
                  </div>
                )}

                {plexDialogStep === 'select-account' && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>{t('servers.selectPlexAccount')}</Label>
                      <Select
                        value={selectedPlexAccountId ?? ''}
                        onValueChange={(id) => {
                          setSelectedPlexAccountId(id);
                          void fetchPlexServers(id);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t('servers.chooseAccount')} />
                        </SelectTrigger>
                        <SelectContent>
                          {plexAccounts.map((account) => (
                            <SelectItem key={account.id} value={account.id}>
                              {account.plexUsername ??
                                account.plexEmail ??
                                t('servers.plexAccount')}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-muted-foreground text-xs">
                        {t('servers.selectAccountHelp')}
                      </p>
                    </div>
                  </div>
                )}

                {plexDialogStep === 'loading-servers' && (
                  <div className="flex flex-col items-center justify-center gap-3 py-8">
                    <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
                    <p className="text-muted-foreground text-sm">
                      {t('servers.discoveringServers')}
                    </p>
                  </div>
                )}

                {plexDialogStep === 'no-servers' && (
                  <div className="space-y-4">
                    {plexAccounts.length > 1 && (
                      <div className="space-y-2">
                        <Label>{t('servers.plexAccount')}</Label>
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
                                {account.plexUsername ??
                                  account.plexEmail ??
                                  t('servers.plexAccount')}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
                      <ServerIcon className="text-muted-foreground h-8 w-8" />
                      <div>
                        <p className="font-medium">{t('servers.allServersConnected')}</p>
                        <p className="text-muted-foreground mt-1 text-sm">
                          {t('servers.allServersConnectedDesc')}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {plexDialogStep === 'select' && (
                  <div className="space-y-4">
                    {plexAccounts.length > 1 && (
                      <div className="space-y-2">
                        <Label>{t('servers.plexAccount')}</Label>
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
                                {account.plexUsername ??
                                  account.plexEmail ??
                                  t('servers.plexAccount')}
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
                      onTestCustomUrl={async (uri) => {
                        const result = await api.auth.testPlexConnection({
                          uri,
                          accountId: selectedPlexAccountId ?? undefined,
                        });
                        return result.connection;
                      }}
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
                  <Label htmlFor="serverUrl">{t('servers.serverUrl')}</Label>
                  <Input
                    id="serverUrl"
                    placeholder={t('servers.serverUrlPlaceholder')}
                    value={serverUrl}
                    onChange={(e) => {
                      setServerUrl(e.target.value);
                    }}
                  />
                  <p className="text-muted-foreground text-xs">
                    {serverType === 'jellyfin'
                      ? t('servers.serverUrlHelpJellyfin')
                      : t('servers.serverUrlHelpEmby')}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="serverName">{t('servers.serverName')}</Label>
                  <Input
                    id="serverName"
                    placeholder={t('servers.serverNamePlaceholder')}
                    value={serverName}
                    onChange={(e) => {
                      setServerName(e.target.value);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="apiKey">{t('common:labels.apiKey')}</Label>
                  <Input
                    id="apiKey"
                    type="password"
                    placeholder={t('servers.apiKeyPlaceholder')}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                    }}
                  />
                  <p className="text-muted-foreground text-xs">
                    {serverType === 'jellyfin'
                      ? t('servers.apiKeyHelpJellyfin')
                      : t('servers.apiKeyHelpEmby')}
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
              {t('common:actions.cancel')}
            </Button>
            {serverType !== 'plex' && (
              <Button onClick={handleAddServer} disabled={isConnecting}>
                {isConnecting ? (
                  <>
                    <Loader2 className="animate-spin" />
                    {t('servers.connecting')}
                  </>
                ) : (
                  t('servers.connectServer')
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
        title={t('servers.removeServer')}
        description={t('servers.removeServerConfirm')}
        confirmLabel={t('common:actions.remove')}
        onConfirm={handleDelete}
        isLoading={deleteServer.isPending}
      />

      {/* Edit Server Dialog */}
      <EditServerDialog
        server={editServer}
        servers={servers}
        onClose={() => {
          setEditServer(null);
        }}
        onUpdate={(name, url, clientIdentifier, color) => {
          if (editServer) {
            updateServer.mutate(
              { id: editServer.id, name, url, clientIdentifier, color },
              {
                onSuccess: () => {
                  setEditServer(null);
                },
              }
            );
          }
        }}
        isUpdating={updateServer.isPending}
      />
    </>
  );
}

const AUTOMATIC_POSTER_SOURCE = 'auto';

/**
 * Poster source preference: which server's poster wins when the same title
 * exists on more than one server. "Automatic" (null server id) keeps
 * today's behavior of using the most recently added copy.
 */
export function PosterSourceCard({ servers, isOwner }: { servers: Server[]; isOwner: boolean }) {
  const { t } = useTranslation(['settings']);
  const { data: settings, isLoading: isLoadingSettings } = useSettings();
  const preferredPosterField = useDebouncedSave(
    'preferredPosterServerId',
    settings?.preferredPosterServerId
  );

  if (!isOwner) return null;

  const hasServers = servers.length > 0;
  const selectValue = preferredPosterField.value || AUTOMATIC_POSTER_SOURCE;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ImageIcon className="h-5 w-5" />
          {t('servers.posterSource.title')}
        </CardTitle>
        <CardDescription>{t('servers.posterSource.titleDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoadingSettings ? (
          <Skeleton className="h-9 w-full max-w-sm" />
        ) : (
          <AutosaveSelectField
            id="preferredPosterServerId"
            label={t('servers.posterSource.label')}
            description={
              hasServers
                ? t('servers.posterSource.description')
                : t('servers.posterSource.emptyHint')
            }
            value={selectValue}
            onChange={(v) => {
              preferredPosterField.setValue(v === AUTOMATIC_POSTER_SOURCE ? null : v);
            }}
            options={[
              { value: AUTOMATIC_POSTER_SOURCE, label: t('servers.posterSource.automatic') },
              ...servers.map((server) => ({ value: server.id, label: server.name })),
            ]}
            disabled={!hasServers}
            status={preferredPosterField.status}
            errorMessage={preferredPosterField.errorMessage}
            onRetry={preferredPosterField.retry}
            onReset={preferredPosterField.reset}
          />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Edit Server Dialog
 * Name and/or URL. For Plex servers: shows PlexServerSelector for URL; for Jellyfin/Emby: simple URL input.
 */
function EditServerDialog({
  server,
  servers,
  onClose,
  onUpdate,
  isUpdating,
}: {
  server: Server | null;
  servers: Server[];
  onClose: () => void;
  onUpdate: (name?: string, url?: string, clientIdentifier?: string, color?: string | null) => void;
  isUpdating: boolean;
}) {
  const { t } = useTranslation(['settings', 'common', 'pages']);
  const [editName, setEditName] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [editColor, setEditColor] = useState('#3b82f6');
  const isPlexServer = server?.type === 'plex';

  // Fetch connections for Plex servers
  const { data: connectionsData, isLoading: isLoadingConnections } = usePlexServerConnections(
    isPlexServer ? server?.id : undefined
  );

  // Reset form when dialog opens
  useEffect(() => {
    if (server) {
      setEditName(server.name);
      setManualUrl(server.url);
      const otherColors = servers.filter((s) => s.id !== server.id).map((s) => s.color);
      setEditColor(server.color ?? pickServerColor(server.type, otherColors));
    }
  }, [server, servers]);

  const handlePlexSelect = (uri: string, _name: string, clientIdentifier: string) => {
    const colorChanged = editColor !== (server?.color ?? '') ? editColor : undefined;
    onUpdate(editName !== server?.name ? editName : undefined, uri, clientIdentifier, colorChanged);
  };

  const hasNameChange = server ? editName.trim() !== server.name : false;
  const hasUrlChange = server ? manualUrl.trim() !== server.url : false;
  const hasColorChange = server ? editColor !== (server.color ?? '') : false;
  const canSave = (hasNameChange || hasUrlChange || hasColorChange) && editName.trim().length > 0;

  const handleSave = () => {
    onUpdate(
      hasNameChange ? editName.trim() : undefined,
      hasUrlChange ? manualUrl.trim() : undefined,
      undefined,
      hasColorChange ? editColor : undefined
    );
  };

  if (!server) return null;

  return (
    <Dialog open={!!server} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-fit max-w-[calc(100vw-2rem)] min-w-[28rem] sm:max-w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle>{t('servers.editServer')}</DialogTitle>
          <DialogDescription>{t('servers.editServerDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="edit-name">{t('servers.serverName')}</Label>
            <Input
              id="edit-name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder={t('servers.plexServerPlaceholder')}
              maxLength={100}
            />
          </div>

          {isPlexServer ? (
            // Plex: Show server selector for URL
            <div className="space-y-2">
              <Label>{t('servers.serverUrl')}</Label>
              {isLoadingConnections ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="text-muted-foreground ml-2 text-sm">
                    {t('servers.discoveringConnections')}
                  </span>
                </div>
              ) : connectionsData?.server ? (
                <>
                  <PlexServerSelector
                    servers={[connectionsData.server]}
                    onSelect={handlePlexSelect}
                    connecting={isUpdating}
                    connectingToServer={isUpdating ? server.name : null}
                    onCancel={onClose}
                    showCancel={true}
                    onTestCustomUrl={async (uri) => {
                      const result = await api.auth.testPlexConnection({ uri });
                      return result.connection;
                    }}
                  />
                  {hasNameChange && (
                    <p className="text-muted-foreground text-sm">{t('servers.updateHint')}</p>
                  )}
                </>
              ) : (
                <Input
                  id="edit-url"
                  value={manualUrl}
                  onChange={(e) => setManualUrl(e.target.value)}
                  placeholder={t('servers.plexServerUrlPlaceholder')}
                />
              )}
            </div>
          ) : (
            // Jellyfin/Emby: URL input
            <div className="space-y-2">
              <Label htmlFor="edit-url">{t('servers.serverUrl')}</Label>
              <Input
                id="edit-url"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                placeholder="http://192.168.1.100:8096"
              />
            </div>
          )}

          {/* Color picker */}
          <div className="space-y-2">
            <Label>{t('servers.serverColor')}</Label>
            <div className="flex items-center gap-2">
              {SERVER_COLOR_PALETTE.map((preset) => {
                const isSelected = editColor.toLowerCase() === preset.hex.toLowerCase();
                return (
                  <button
                    key={preset.hex}
                    type="button"
                    onClick={() => setEditColor(preset.hex)}
                    className={cn(
                      'relative h-8 w-8 rounded-full transition-transform',
                      'hover:scale-110',
                      isSelected && 'ring-offset-background scale-110 ring-2 ring-offset-2'
                    )}
                    style={{
                      backgroundColor: preset.hex,
                      ['--tw-ring-color' as string]: isSelected ? preset.hex : undefined,
                    }}
                    title={preset.label}
                  >
                    {isSelected && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Check className="h-4 w-4 text-white drop-shadow-md" />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            <p className="text-muted-foreground text-xs">{t('servers.serverColorDesc')}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={isUpdating || !canSave}>
            {isUpdating ? (
              <>
                <Loader2 className="animate-spin" />
                {t('servers.updating')}
              </>
            ) : (
              t('common:actions.update')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RealtimeSetupDialog({
  server,
  open,
  onClose,
  mode = 'setup',
  connectionStatus,
}: {
  server: Server;
  open: boolean;
  onClose: () => void;
  mode?: 'setup' | 'update';
  connectionStatus?: ServerConnectionStatus;
}) {
  const { t } = useTranslation(['settings']);
  const repoUrl = t('servers.realtimeDialog.jellyfinRepoUrl');

  const issueMessage =
    connectionStatus?.pluginIssue === 'blocked'
      ? t('servers.realtimeDialog.issueBlocked')
      : connectionStatus?.pluginIssue === 'restart_required'
        ? t('servers.realtimeDialog.issueRestartRequired')
        : connectionStatus?.pluginIssue === 'malfunctioned'
          ? t('servers.realtimeDialog.issueMalfunctioned')
          : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === 'update'
              ? t('servers.realtimeDialog.updateTitle')
              : t('servers.realtimeDialog.title')}
          </DialogTitle>
          <DialogDescription>
            {server.type === 'jellyfin'
              ? mode === 'update'
                ? t('servers.realtimeDialog.jellyfinUpdateDescription')
                : t('servers.realtimeDialog.jellyfinDescription')
              : mode === 'update'
                ? t('servers.realtimeDialog.embyUpdateDescription')
                : t('servers.realtimeDialog.embyDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="text-muted-foreground space-y-3 text-sm">
          {issueMessage && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
              <p className="text-foreground flex items-start gap-2">
                <AlertTriangle
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500"
                  aria-hidden="true"
                />
                {issueMessage}
              </p>
              {connectionStatus?.error && (
                <code className="text-muted-foreground mt-2 block truncate pl-5">
                  {connectionStatus.error}
                </code>
              )}
            </div>
          )}
          {server.type === 'jellyfin' ? (
            <>
              <ol className="list-decimal space-y-2 pl-4">
                <li>In your Jellyfin dashboard, go to Plugins → Repositories.</li>
                <li>
                  Add a repository named <strong>Tracearr</strong> with the URL below.
                </li>
                <li>
                  Open the Catalog tab and install <strong>Tracearr SSE</strong>.
                </li>
                <li>Restart Jellyfin — Tracearr will detect it automatically.</li>
              </ol>
              <div className="space-y-1">
                <p className="text-foreground text-xs font-medium">
                  {t('servers.realtimeDialog.repositoryUrl')}
                </p>
                <div className="flex items-center gap-2">
                  <code className="bg-muted flex-1 truncate rounded px-2 py-1 text-xs">
                    {repoUrl}
                  </code>
                  <CopyButton
                    value={repoUrl}
                    label={t('servers.realtimeDialog.copyUrl')}
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              <ol className="list-decimal space-y-2 pl-4">
                <li>
                  Download the latest <strong>Tracearr.Sse.Emby</strong> release zip from the link
                  below.
                </li>
                <li>Extract the plugin DLL into your Emby plugins folder.</li>
                <li>Restart Emby — Tracearr will detect it automatically.</li>
              </ol>
              <a
                href={t('servers.realtimeDialog.embyReleasesUrl')}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary inline-flex items-center gap-1 hover:underline"
              >
                {t('servers.realtimeDialog.openReleases')}
                <ExternalLink className="h-3 w-3" />
              </a>
            </>
          )}
          <p className="text-xs">{t('servers.realtimeDialog.autoDetectNote')}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('servers.realtimeDialog.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SortableServerCard({
  server,
  connectionStatus,
  onSync,
  onDelete,
  onEdit,
  isSyncing,
  isDraggable,
}: {
  server: Server;
  connectionStatus?: ServerConnectionStatus;
  onSync: () => void;
  onDelete: () => void;
  onEdit: () => void;
  isSyncing?: boolean;
  isDraggable?: boolean;
}) {
  const { t } = useTranslation(['settings', 'common', 'pages']);
  const [showRealtimeDialog, setShowRealtimeDialog] = useState(false);
  const [realtimeDialogMode, setRealtimeDialogMode] = useState<'setup' | 'update'>('setup');
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
          server.color && 'border-l-4',
          isDragging && 'ring-primary ring-2'
        )}
        style={server.color ? { borderLeftColor: server.color } : undefined}
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
              <button
                onClick={onEdit}
                className="hover:text-primary"
                title={t('servers.editServer')}
              >
                <Pencil className="h-3 w-3" />
              </button>
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
              {t('servers.added', { date: format(new Date(server.createdAt), 'MMM d, yyyy') })}
            </p>
            <ServerVersionLine server={server} />
            {/* Connection status — only shown for Jellyfin and Emby */}
            {server.type !== 'plex' && (
              <div className="mt-1">
                {!connectionStatus ? (
                  <span className="text-muted-foreground text-xs">
                    {t('servers.checkingConnection')}
                  </span>
                ) : connectionStatus.mode === 'realtime' ? (
                  <span className="text-muted-foreground flex items-center gap-1 text-xs">
                    <Zap className="h-3 w-3 text-green-500" aria-hidden="true" />
                    {t('servers.realtimeActive')}
                  </span>
                ) : connectionStatus.pluginIssue === 'blocked' ||
                  connectionStatus.pluginIssue === 'restart_required' ||
                  connectionStatus.pluginIssue === 'malfunctioned' ? (
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-amber-500 hover:underline"
                    onClick={() => {
                      setRealtimeDialogMode('setup');
                      setShowRealtimeDialog(true);
                    }}
                  >
                    <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                    {t('servers.realtimeError')}
                  </button>
                ) : (
                  <span className="flex items-center gap-1 text-xs">
                    <Radio className="text-muted-foreground h-3 w-3" aria-hidden="true" />
                    <span className="text-muted-foreground">{t('servers.pollingMode')}</span>
                    <button
                      type="button"
                      className="text-primary ml-1 hover:underline"
                      onClick={() => {
                        setRealtimeDialogMode('setup');
                        setShowRealtimeDialog(true);
                      }}
                    >
                      {t('servers.setupRealtime')}
                    </button>
                  </span>
                )}
                {connectionStatus?.pluginVersion && (
                  <span className="text-muted-foreground ml-2 text-xs">
                    {t('servers.pluginVersion', { version: connectionStatus.pluginVersion })}
                  </span>
                )}
                {connectionStatus?.pluginUpdateAvailable && (
                  <button
                    type="button"
                    className="ml-2 inline-flex items-center gap-1 text-xs text-amber-500 hover:underline"
                    onClick={() => {
                      setRealtimeDialogMode('update');
                      setShowRealtimeDialog(true);
                    }}
                  >
                    <ArrowUpCircle className="h-3 w-3" aria-hidden="true" />
                    {t('servers.pluginUpdateAvailable')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onSync} disabled={isSyncing}>
            <RefreshCw className={cn(isSyncing && 'animate-spin')} />
            {t('common:actions.sync')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete}>
            <Trash2 className="text-destructive h-4 w-4" />
          </Button>
        </div>
      </div>
      {server.type !== 'plex' && (
        <RealtimeSetupDialog
          server={server}
          open={showRealtimeDialog}
          onClose={() => setShowRealtimeDialog(false)}
          mode={realtimeDialogMode}
          connectionStatus={connectionStatus}
        />
      )}
    </div>
  );
}
