import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Server as ServerIcon } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import type { Server } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { ItemGroup } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import {
  AddServerDialog,
  type PlexAccountOption,
  type PlexDialogStep,
} from '@/components/settings/servers/AddServerDialog';
import { EditServerDialog } from '@/components/settings/servers/EditServerDialog';
import { ServerRow } from '@/components/settings/servers/ServerRow';
import { api, tokenStorage } from '@/lib/api';
import type { PlexDiscoveredServer } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { useSocket } from '@/hooks/useSocket';
import {
  useDeleteServer,
  useReorderServers,
  useServers,
  useSyncServer,
  useUpdateServer,
} from '@/hooks/queries';

export function Connections() {
  const { t } = useTranslation(['settings', 'common', 'notifications']);
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
  const [publicUrl, setPublicUrl] = useState('');
  const [serverName, setServerName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [plexStep, setPlexStep] = useState<PlexDialogStep>('loading');
  const [plexServers, setPlexServers] = useState<PlexDiscoveredServer[]>([]);
  const [connectingPlexServer, setConnectingPlexServer] = useState<string | null>(null);
  const [plexAccounts, setPlexAccounts] = useState<PlexAccountOption[]>([]);
  const [selectedPlexAccountId, setSelectedPlexAccountId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const isOwner = user?.role === 'owner';

  useEffect(() => {
    if (user && !isOwner && serverType === 'plex') {
      setServerType('jellyfin');
    }
  }, [user, isOwner, serverType]);

  const servers = Array.isArray(serversData)
    ? serversData
    : ((serversData as unknown as { data?: Server[] })?.data ?? []);

  const fetchPlexServers = async (accountId?: string) => {
    setPlexStep('loading-servers');
    setConnectError(null);

    try {
      const result = await api.auth.getAvailablePlexServers(accountId);
      if (!result.hasPlexToken) {
        setPlexStep('no-accounts');
        return;
      }
      if (result.servers.length === 0) {
        setPlexStep('no-servers');
        return;
      }
      setPlexServers(result.servers);
      setPlexStep('select');
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'Failed to fetch Plex servers');
      setPlexStep('no-servers');
    }
  };

  const fetchPlexAccounts = async () => {
    setPlexStep('loading');
    setConnectError(null);

    try {
      const { accounts } = await api.auth.getPlexAccounts();
      if (accounts.length === 0) {
        setPlexStep('no-accounts');
        return;
      }
      setPlexAccounts(accounts);

      const firstAccount = accounts[0];
      if (accounts.length === 1 && firstAccount) {
        setSelectedPlexAccountId(firstAccount.id);
        await fetchPlexServers(firstAccount.id);
      } else {
        setPlexStep('select-account');
      }
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'Failed to fetch Plex accounts');
      setPlexStep('no-accounts');
    }
  };

  useEffect(() => {
    if (showAddDialog && serverType === 'plex' && isOwner) {
      void fetchPlexAccounts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on dialog open, not on serverType changes
  }, [showAddDialog]);

  const resetAddForm = () => {
    setServerUrl('');
    setPublicUrl('');
    setServerName('');
    setApiKey('');
    setConnectError(null);
    setServerType(isOwner ? 'plex' : 'jellyfin');
    setPlexStep('loading');
    setPlexServers([]);
    setConnectingPlexServer(null);
    setPlexAccounts([]);
    setSelectedPlexAccountId(null);
  };

  const handlePlexServerSelect = async (uri: string, name: string, clientIdentifier: string) => {
    setConnectingPlexServer(name);
    setConnectError(null);

    try {
      await api.auth.addPlexServer({
        serverUri: uri,
        serverName: name,
        clientIdentifier,
        accountId: selectedPlexAccountId ?? undefined,
      });
      toast.success(t('notifications:toast.success.serverAdded.title'), {
        description: t('notifications:toast.success.serverAdded.message', { name }),
      });
      await refetch();
      await refetchUser();
      void queryClient.invalidateQueries({ queryKey: ['plex-accounts'] });
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
        ...(publicUrl.trim() ? { publicUrl: publicUrl.trim() } : {}),
      });

      if (result.accessToken && result.refreshToken) {
        tokenStorage.setTokens(result.accessToken, result.refreshToken);
        await refetchUser();
      }
      await refetch();
      setShowAddDialog(false);
      resetAddForm();
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : 'Failed to connect server');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;

    const oldIndex = servers.findIndex((s) => s.id === active.id);
    const newIndex = servers.findIndex((s) => s.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    reorderServers.mutate(
      arrayMove(servers, oldIndex, newIndex).map((server, index) => ({
        id: server.id,
        displayOrder: index,
      }))
    );
  };

  return (
    <SettingsSection
      title={t('nav.sections.connections')}
      description={t('nav.descriptions.connections')}
      actions={
        <Button onClick={() => setShowAddDialog(true)}>
          <Plus />
          {t('servers.addServer')}
        </Button>
      }
    >
      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : servers.length === 0 ? (
        <EmptyState
          icon={ServerIcon}
          title={t('servers.noServersConnected')}
          description={t('servers.noServersConnectedHint')}
        >
          <Button onClick={() => setShowAddDialog(true)}>
            <Plus />
            {t('servers.addServer')}
          </Button>
        </EmptyState>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={servers.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <ItemGroup className="gap-4">
              {servers.map((server) => (
                <ServerRow
                  key={server.id}
                  server={server}
                  connectionStatus={serverConnectionStatuses.get(server.id)}
                  onSync={() => syncServer.mutate(server.id)}
                  onDelete={() => setDeleteId(server.id)}
                  onEdit={() => setEditServer(server)}
                  isSyncing={syncServer.isPending}
                  isDraggable={isOwner}
                />
              ))}
            </ItemGroup>
          </SortableContext>
        </DndContext>
      )}

      <AddServerDialog
        open={showAddDialog}
        onOpenChange={(open) => {
          if (!open) resetAddForm();
          setShowAddDialog(open);
        }}
        isOwner={isOwner}
        serverType={serverType}
        onServerTypeChange={(newType) => {
          setServerType(newType);
          setConnectError(null);
          if (newType === 'plex' && isOwner) {
            void fetchPlexAccounts();
          }
        }}
        serverUrl={serverUrl}
        onServerUrlChange={setServerUrl}
        publicUrl={publicUrl}
        onPublicUrlChange={setPublicUrl}
        serverName={serverName}
        onServerNameChange={setServerName}
        apiKey={apiKey}
        onApiKeyChange={setApiKey}
        isConnecting={isConnecting}
        connectError={connectError}
        onConnect={() => void handleAddServer()}
        plexStep={plexStep}
        plexAccounts={plexAccounts}
        selectedPlexAccountId={selectedPlexAccountId}
        onSelectPlexAccount={(id) => {
          setSelectedPlexAccountId(id);
          void fetchPlexServers(id);
        }}
        plexServers={plexServers}
        connectingPlexServer={connectingPlexServer}
        onSelectPlexServer={(uri, name, clientIdentifier) => {
          void handlePlexServerSelect(uri, name, clientIdentifier);
        }}
        onTestPlexUrl={async (uri) => {
          const result = await api.auth.testPlexConnection({
            uri,
            accountId: selectedPlexAccountId ?? undefined,
          });
          return result.connection;
        }}
      />

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={() => setDeleteId(null)}
        title={t('servers.removeServer')}
        description={t('servers.removeServerConfirm')}
        confirmLabel={t('common:actions.remove')}
        isLoading={deleteServer.isPending}
        onConfirm={() => {
          if (!deleteId) return;
          deleteServer.mutate(deleteId, {
            onSuccess: () => {
              setDeleteId(null);
              void queryClient.invalidateQueries({ queryKey: ['plex-accounts'] });
            },
          });
        }}
      />

      <EditServerDialog
        server={editServer}
        servers={servers}
        onClose={() => setEditServer(null)}
        isUpdating={updateServer.isPending}
        onUpdate={(patch) => {
          if (!editServer) return;
          updateServer.mutate(
            { id: editServer.id, ...patch },
            { onSuccess: () => setEditServer(null) }
          );
        }}
      />
    </SettingsSection>
  );
}
