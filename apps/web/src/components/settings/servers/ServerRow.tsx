import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ArrowUpCircle,
  ExternalLink,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Radio,
  RefreshCw,
  Trash2,
  Zap,
} from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type {
  OwnerLinkServer,
  RequestService,
  Server,
  ServerConnectionStatus,
} from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { ServerVersionLine } from '@/components/settings/servers/ServerVersionLine';
import { OwnerAccountLine } from '@/components/settings/servers/OwnerAccountLine';
import { RealtimeSetupDialog } from '@/components/settings/servers/RealtimeSetupDialog';
import { RequestServiceLine } from '@/components/settings/request-services';
import { TooltipIconButton } from '@/components/settings/shared/TooltipIconButton';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dateFormat';

const PLUGIN_ISSUES = ['blocked', 'restart_required', 'malfunctioned'];

export function ServerRow({
  server,
  connectionStatus,
  onSync,
  onDelete,
  onEdit,
  onSetHistorical,
  isSyncing,
  isSwitching,
  isDraggable,
  isOwner,
  requestService,
  ownerLink,
}: {
  server: Server;
  connectionStatus?: ServerConnectionStatus;
  onSync: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onSetHistorical: (historical: boolean) => void;
  isSyncing?: boolean;
  isSwitching?: boolean;
  isDraggable?: boolean;
  isOwner?: boolean;
  requestService?: { service: RequestService | undefined } | undefined;
  ownerLink?: OwnerLinkServer | undefined;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [realtimeDialog, setRealtimeDialog] = useState<'setup' | 'update' | null>(null);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: server.id,
    disabled: !isDraggable,
  });

  const hasPluginIssue =
    !!connectionStatus?.pluginIssue && PLUGIN_ISSUES.includes(connectionStatus.pluginIssue);
  const historical = !!server.historicalAt;

  return (
    <div
      ref={setNodeRef}
      role="listitem"
      className="touch-none"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      <TooltipProvider delayDuration={100}>
        <Item
          variant="outline"
          className={cn(
            server.color && 'border-l-4',
            isDragging && 'ring-primary ring-2',
            historical && 'opacity-60'
          )}
          style={server.color ? { borderLeftColor: server.color } : undefined}
        >
          <ItemMedia className="gap-2 self-center">
            {isDraggable && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('servers.reorder')}
                className="text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing"
                {...attributes}
                {...listeners}
              >
                <GripVertical className="h-5 w-5" />
              </Button>
            )}
            <span className="bg-muted flex size-10 items-center justify-center rounded-lg">
              <MediaServerIcon type={server.type} className="h-6 w-6" />
            </span>
          </ItemMedia>

          <ItemContent>
            <ItemTitle>
              {server.name}
              {historical && <Badge variant="outline">{t('servers.historical')}</Badge>}
              <TooltipIconButton
                label={t('servers.editServer')}
                icon={Pencil}
                onClick={onEdit}
                size="icon-xs"
              />
            </ItemTitle>

            <ItemDescription className="flex items-center gap-2">
              <a href={server.url} target="_blank" rel="noopener noreferrer">
                {server.url}
              </a>
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </ItemDescription>

            <p className="text-muted-foreground text-xs">
              {t('servers.added', {
                date: formatDate(new Date(server.createdAt), { dateStyle: 'medium' }),
              })}
            </p>
            {server.historicalAt && (
              <p className="text-muted-foreground text-xs">
                {t('servers.historicalSince', {
                  date: formatDate(new Date(server.historicalAt), { dateStyle: 'medium' }),
                })}
              </p>
            )}
            <ServerVersionLine server={server} />
            {requestService && (
              <RequestServiceLine server={server} service={requestService.service} />
            )}
            {ownerLink && <OwnerAccountLine server={server} link={ownerLink} />}

            {server.type !== 'plex' && !historical && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                {!connectionStatus ? (
                  <span className="text-muted-foreground">{t('servers.checkingConnection')}</span>
                ) : connectionStatus.mode === 'realtime' ? (
                  <span className="text-muted-foreground flex items-center gap-1">
                    <Zap className="text-success h-3 w-3" aria-hidden="true" />
                    {t('servers.realtimeActive')}
                  </span>
                ) : hasPluginIssue ? (
                  <button
                    type="button"
                    className="text-warning flex items-center gap-1 hover:underline"
                    onClick={() => setRealtimeDialog('setup')}
                  >
                    <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                    {t('servers.realtimeError')}
                  </button>
                ) : (
                  <span className="flex items-center gap-1">
                    <Radio className="text-muted-foreground h-3 w-3" aria-hidden="true" />
                    <span className="text-muted-foreground">{t('servers.pollingMode')}</span>
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      onClick={() => setRealtimeDialog('setup')}
                    >
                      {t('servers.setupRealtime')}
                    </button>
                  </span>
                )}
                {connectionStatus?.pluginVersion && (
                  <span className="text-muted-foreground">
                    {t('servers.pluginVersion', { version: connectionStatus.pluginVersion })}
                  </span>
                )}
                {connectionStatus?.pluginUpdateAvailable && (
                  <button
                    type="button"
                    className="text-warning inline-flex items-center gap-1 hover:underline"
                    onClick={() => setRealtimeDialog('update')}
                  >
                    <ArrowUpCircle className="h-3 w-3" aria-hidden="true" />
                    {t('servers.pluginUpdateAvailable')}
                  </button>
                )}
              </div>
            )}
          </ItemContent>

          <ItemActions>
            <Button variant="ghost" size="sm" onClick={onSync} disabled={isSyncing || historical}>
              <RefreshCw className={cn(isSyncing && 'animate-spin')} />
              {t('common:actions.sync')}
            </Button>
            {isOwner && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('servers.moreActions')}
                    disabled={isSwitching}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onSetHistorical(!historical)}>
                    {historical ? t('servers.resume') : t('servers.markHistorical')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <TooltipIconButton
              label={t('common:actions.remove')}
              icon={Trash2}
              onClick={onDelete}
              iconClassName="text-destructive"
            />
          </ItemActions>
        </Item>
      </TooltipProvider>

      {server.type !== 'plex' && realtimeDialog && (
        <RealtimeSetupDialog
          server={server}
          open
          onClose={() => setRealtimeDialog(null)}
          mode={realtimeDialog}
          connectionStatus={connectionStatus}
        />
      )}
    </div>
  );
}
