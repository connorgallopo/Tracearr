import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
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
import { SERVER_PROFILES, type Server } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { ItemGroup } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';
import { AddServerDialog } from '@/components/settings/servers/AddServerDialog';
import { EditServerDialog } from '@/components/settings/servers/EditServerDialog';
import { ServerRow } from '@/components/settings/servers/ServerRow';
import { useAddServer, type AddedServer } from '@/components/settings/servers/useAddServer';
import { useAuth } from '@/hooks/useAuth';
import { useSocket } from '@/hooks/useSocket';
import {
  useDeleteServer,
  useOwnerLinks,
  useReorderServers,
  useRequestServices,
  useServers,
  useSetServerHistorical,
  useSyncServer,
  useUpdateServer,
} from '@/hooks/queries';

export function Connections() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: serversData, isLoading } = useServers();
  const deleteServer = useDeleteServer();
  const syncServer = useSyncServer();
  const updateServer = useUpdateServer();
  const reorderServers = useReorderServers();
  const setHistorical = useSetServerHistorical();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { serverConnectionStatuses } = useSocket();
  const isOwner = user?.role === 'owner';
  const { data: requestServices, isLoading: requestServicesLoading } = useRequestServices({
    enabled: isOwner,
  });
  const { data: ownerLinks } = useOwnerLinks(isOwner);

  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [historicalId, setHistoricalId] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [addedServer, setAddedServer] = useState<AddedServer | null>(null);
  const [editServer, setEditServer] = useState<Server | null>(null);
  // Only the owner can import history, so only the owner gets the dialog's import step
  const form = useAddServer({
    onAdded: (server) => (isOwner ? setAddedServer(server) : setShowAddDialog(false)),
  });
  const plexOAuth = SERVER_PROFILES[form.serverType].addServerAuth === 'plexOAuth';

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const servers = Array.isArray(serversData)
    ? serversData
    : ((serversData as unknown as { data?: Server[] })?.data ?? []);
  const nameOf = (id: string | null) => servers.find((s) => s.id === id)?.name ?? '';

  const openAddDialog = () => {
    setAddedServer(null);
    setShowAddDialog(true);
    if (plexOAuth && isOwner) {
      void form.loadPlexAccounts();
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
        <Button onClick={openAddDialog}>
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
          <Button onClick={openAddDialog}>
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
                  onSetHistorical={(historical) =>
                    historical
                      ? setHistoricalId(server.id)
                      : setHistorical.mutate({ id: server.id, historical: false })
                  }
                  isSwitching={setHistorical.isPending && setHistorical.variables?.id === server.id}
                  isSyncing={syncServer.isPending && syncServer.variables === server.id}
                  isDraggable={isOwner && servers.length > 1}
                  isOwner={isOwner}
                  requestService={
                    isOwner && !requestServicesLoading
                      ? { service: requestServices?.find((s) => s.serverId === server.id) }
                      : undefined
                  }
                  ownerLink={ownerLinks?.find((link) => link.serverId === server.id)}
                />
              ))}
            </ItemGroup>
          </SortableContext>
        </DndContext>
      )}

      <AddServerDialog
        open={showAddDialog}
        onOpenChange={(open) => {
          if (!open) form.reset();
          setShowAddDialog(open);
        }}
        form={form}
        added={addedServer}
      />

      <ConfirmDialog
        open={!!deleteId}
        restoreFocus
        onOpenChange={() => setDeleteId(null)}
        title={t('servers.removeServerTitle', { name: nameOf(deleteId) })}
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

      <ConfirmDialog
        open={!!historicalId}
        restoreFocus
        onOpenChange={() => setHistoricalId(null)}
        title={t('servers.markHistoricalTitle', { name: nameOf(historicalId) })}
        description={t('servers.markHistoricalConfirm')}
        confirmLabel={t('servers.markHistorical')}
        variant="default"
        isLoading={setHistorical.isPending}
        onConfirm={() => {
          if (!historicalId) return;
          setHistorical.mutate(
            { id: historicalId, historical: true },
            { onSuccess: () => setHistoricalId(null) }
          );
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
