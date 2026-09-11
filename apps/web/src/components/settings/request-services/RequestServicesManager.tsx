import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Server as ServerIcon } from 'lucide-react';
import type { RequestService, Server } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { BASE_URL } from '@/lib/basePath';
import { safeFormatDistanceToNow } from '@/lib/formatters';
import {
  useDeleteRequestService,
  useRequestServices,
  useServers,
  useSyncRequestService,
  useUpdateRequestService,
} from '@/hooks/queries';
import { LinkDialog } from './LinkDialog';

interface DialogState {
  server: Server;
  existing?: RequestService;
}

export function RequestServicesManager() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: servers, isLoading: serversLoading } = useServers();
  const { data: services, isLoading: servicesLoading } = useRequestServices();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<{
    service: RequestService;
    server: Server;
  } | null>(null);
  const updateService = useUpdateRequestService();
  const syncService = useSyncRequestService();
  const deleteService = useDeleteRequestService();

  if (serversLoading || servicesLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  const rows = servers ?? [];

  if (rows.length === 0) {
    return <EmptyState icon={ServerIcon} title={t('servers.noServersConnected')} />;
  }

  return (
    <div className="space-y-4">
      <ItemGroup className="gap-4">
        {rows.map((server) => {
          const service = services?.find((candidate) => candidate.serverId === server.id);

          return (
            <Item key={server.id} variant="outline">
              <ItemMedia className="self-center">
                <span className="bg-muted flex size-10 items-center justify-center rounded-lg">
                  <MediaServerIcon type={server.type} className="h-6 w-6" />
                </span>
              </ItemMedia>

              <ItemContent>
                <ItemTitle>{server.name}</ItemTitle>

                {service === undefined ? (
                  <ItemDescription>{t('requests.notLinked')}</ItemDescription>
                ) : (
                  <>
                    <ItemDescription className="flex items-center gap-2">
                      <img
                        src={`${BASE_URL}images/services/seerr.svg`}
                        alt=""
                        aria-hidden="true"
                        className="h-4 w-4"
                      />
                      <span>
                        {service.name}
                        {service.version !== null && ` ${service.version}`}
                      </span>
                    </ItemDescription>

                    <p className="text-muted-foreground text-xs">{service.url}</p>

                    <p className="text-muted-foreground text-xs">
                      {service.lastSyncAt === null
                        ? t('requests.neverSynced')
                        : t('requests.syncedAgo', {
                            ago: safeFormatDistanceToNow(service.lastSyncAt),
                          })}
                    </p>

                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">
                        {t('requests.counts.requests', { count: service.counts.requests })}
                      </Badge>
                      <Badge variant="outline">
                        {t('requests.counts.unmatchedMedia', {
                          count: service.counts.unmatchedMedia,
                        })}
                      </Badge>
                      <Badge variant="outline">
                        {t('requests.counts.unmatchedUsers', {
                          count: service.counts.unmatchedUsers,
                        })}
                      </Badge>
                      {service.configStatus === 'reencrypt' && (
                        <Badge variant="warning">{t('requests.needsKey')}</Badge>
                      )}
                    </div>

                    {service.lastSyncError !== null && (
                      <p className="text-destructive text-xs">
                        {t('requests.lastError', {
                          ago: safeFormatDistanceToNow(service.lastSyncAt),
                          error: service.lastSyncError,
                        })}
                      </p>
                    )}
                  </>
                )}
              </ItemContent>

              <ItemActions>
                {service === undefined ? (
                  <Button size="sm" onClick={() => setDialog({ server })}>
                    {t('requests.link')}
                  </Button>
                ) : (
                  <>
                    <Switch
                      checked={service.enabled}
                      aria-label={t('common:states.enabled')}
                      onCheckedChange={(enabled) =>
                        updateService.mutate({ id: service.id, data: { enabled } })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => syncService.mutate(service.id)}
                      disabled={syncService.isPending}
                    >
                      <RefreshCw className={syncService.isPending ? 'animate-spin' : undefined} />
                      {syncService.isPending ? t('requests.syncing') : t('requests.syncNow')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDialog({ server, existing: service })}
                    >
                      {t('requests.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setUnlinkTarget({ service, server })}
                    >
                      {t('requests.unlink')}
                    </Button>
                  </>
                )}
              </ItemActions>
            </Item>
          );
        })}
      </ItemGroup>

      {dialog && (
        <LinkDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          server={dialog.server}
          existing={dialog.existing}
        />
      )}

      <ConfirmDialog
        open={unlinkTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUnlinkTarget(null);
        }}
        title={t('requests.confirmUnlink.title')}
        description={t('requests.confirmUnlink.body', { server: unlinkTarget?.server.name ?? '' })}
        confirmLabel={t('requests.unlink')}
        cancelLabel={t('common:actions.cancel')}
        isLoading={deleteService.isPending}
        onConfirm={() => {
          if (unlinkTarget) deleteService.mutate(unlinkTarget.service.id);
          setUnlinkTarget(null);
        }}
      />
    </div>
  );
}
