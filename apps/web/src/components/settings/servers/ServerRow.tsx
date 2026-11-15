import { Fragment, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ArrowUp,
  ArrowUpCircle,
  ExternalLink,
  GripVertical,
  MoreHorizontal,
  Radio,
  RefreshCw,
  Trash2,
  Zap,
} from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  SERVER_PROFILES,
  assertNever,
  type OwnerLinkServer,
  type RequestService,
  type Server,
  type ServerConnectionStatus,
} from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { availableUpdate } from '@/components/settings/servers/serverVersion';
import { useOwnerAccountActions } from '@/components/settings/servers/useOwnerAccountActions';
import { RealtimeSetupDialog } from '@/components/settings/servers/RealtimeSetupDialog';
import { useRequestServiceActions } from '@/components/settings/request-services';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dateFormat';
import { isJellyfinEmby } from '@/lib/serverType';

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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const afterMenuClose = useRef<(() => void) | null>(null);
  // A dialog opened while the menu is still closing records the unmounting item as the place
  // to return focus to, so it would land on the body. The action waits until the menu has
  // handed focus back to its trigger.
  const fromMenu = (action: () => void) => () => {
    afterMenuClose.current = action;
  };
  const requests = useRequestServiceActions(server, requestService, fromMenu);
  const account = useOwnerAccountActions(server, ownerLink, fromMenu);

  const historical = !!server.historicalAt;
  const update = availableUpdate(server);
  const meta = [
    server.url,
    server.version && t('servers.version.installed', { version: server.version }),
    server.historicalAt
      ? t('servers.historicalSince', {
          date: formatDate(new Date(server.historicalAt), { dateStyle: 'medium' }),
        })
      : t('servers.added', {
          date: formatDate(new Date(server.createdAt), { dateStyle: 'medium' }),
        }),
  ]
    .filter(Boolean)
    .join(' · ');

  const menuGroups = [
    <Fragment key="server">
      <DropdownMenuItem onSelect={fromMenu(onEdit)}>{t('common:actions.edit')}</DropdownMenuItem>
      <DropdownMenuItem asChild>
        <a href={server.url} target="_blank" rel="noopener noreferrer">
          {t('servers.openServer')}
          <ExternalLink className="ml-auto" aria-hidden="true" />
        </a>
      </DropdownMenuItem>
    </Fragment>,
    requests.menuItems,
    account.menuItem,
    isOwner && (
      <DropdownMenuItem
        key="historical"
        onSelect={fromMenu(() => onSetHistorical(!historical))}
        disabled={isSwitching}
      >
        {historical ? t('servers.resume') : t('servers.markHistorical')}
      </DropdownMenuItem>
    ),
    <DropdownMenuItem key="remove" variant="destructive" onSelect={fromMenu(onDelete)}>
      <Trash2 />
      {t('common:actions.remove')}
    </DropdownMenuItem>,
  ].filter(Boolean);

  return (
    <div
      ref={setNodeRef}
      role="listitem"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      <TooltipProvider delayDuration={100}>
        <Item
          variant="outline"
          className={cn(server.color && 'border-l-4', isDragging && 'ring-primary ring-2')}
          style={server.color ? { borderLeftColor: server.color } : undefined}
        >
          <ItemMedia className="gap-2">
            {isDraggable && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('servers.reorder')}
                className="text-muted-foreground hover:text-foreground cursor-grab touch-none active:cursor-grabbing"
                {...attributes}
                {...listeners}
              >
                <GripVertical className="h-5 w-5" />
              </Button>
            )}
            <span
              className={cn(
                'bg-muted flex size-10 items-center justify-center rounded-lg',
                historical && 'opacity-60'
              )}
            >
              <MediaServerIcon type={server.type} className="h-6 w-6" />
            </span>
          </ItemMedia>

          <ItemContent className="min-w-0 flex-[1_1_16rem]">
            <ItemTitle className="flex-wrap">
              <span className={cn(historical && 'text-muted-foreground')}>{server.name}</span>
              {!historical && (
                <RealtimeStatus
                  server={server}
                  connectionStatus={connectionStatus}
                  onOpenDialog={setRealtimeDialog}
                />
              )}
              {update && (
                <Badge variant="warning">
                  <ArrowUp aria-hidden="true" />
                  {t('servers.version.updateBadge', { version: update })}
                </Badge>
              )}
              {server.canStopStreams === false && (
                <StatusBadge
                  variant="warning"
                  hint={t('servers.cannotStopStreams')}
                  onClick={onEdit}
                >
                  <AlertTriangle aria-hidden="true" />
                  {t('servers.cannotStopStreamsBadge')}
                </StatusBadge>
              )}
              {historical && <Badge variant="outline">{t('servers.historical')}</Badge>}
            </ItemTitle>

            <ItemDescription className="text-xs wrap-anywhere">{meta}</ItemDescription>

            {(requests.fact || account.fact) && (
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1 text-xs">
                {requests.fact && (
                  <>
                    <dt className="text-muted-foreground">{t('requests.label')}</dt>
                    <dd>{requests.fact}</dd>
                  </>
                )}
                {account.fact && (
                  <>
                    <dt className="text-muted-foreground">{t('servers.ownerAccount.label')}</dt>
                    <dd>{account.fact}</dd>
                  </>
                )}
              </dl>
            )}
          </ItemContent>

          <ItemActions className="ml-auto self-start">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onSync}
                  disabled={isSyncing || historical}
                  aria-label={isSyncing ? undefined : t('servers.syncNamed', { name: server.name })}
                >
                  <RefreshCw className={cn(isSyncing && 'animate-spin')} />
                  {isSyncing ? t('servers.syncing') : t('common:actions.sync')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('servers.syncHint')}</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={triggerRef}
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('servers.actionsFor', { name: server.name })}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onCloseAutoFocus={(event) => {
                  const action = afterMenuClose.current;
                  if (!action) return;
                  afterMenuClose.current = null;
                  event.preventDefault();
                  triggerRef.current?.focus();
                  action();
                }}
              >
                {menuGroups.map((group, i) => (
                  <Fragment key={i}>
                    {i > 0 && <DropdownMenuSeparator />}
                    {group}
                  </Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </ItemActions>
        </Item>

        {requests.dialogs}
        {account.dialogs}
      </TooltipProvider>

      {isJellyfinEmby(server.type) && realtimeDialog && (
        <RealtimeSetupDialog
          serverType={server.type}
          open
          onClose={() => setRealtimeDialog(null)}
          mode={realtimeDialog}
          connectionStatus={connectionStatus}
        />
      )}
    </div>
  );
}

/** A badge that explains itself in a tooltip, and does something when it has an onClick. */
function StatusBadge({
  variant,
  hint,
  onClick,
  label,
  children,
}: {
  variant: ComponentProps<typeof Badge>['variant'];
  hint?: string;
  onClick?: () => void;
  label?: string;
  children: ReactNode;
}) {
  const badge = onClick ? (
    <Badge variant={variant} asChild>
      <button type="button" className="cursor-pointer" onClick={onClick} aria-label={label}>
        {children}
      </button>
    </Badge>
  ) : (
    <Badge variant={variant} tabIndex={hint ? 0 : undefined}>
      {children}
    </Badge>
  );
  if (!hint) return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

function RealtimeStatus({
  server,
  connectionStatus,
  onOpenDialog,
}: {
  server: Server;
  connectionStatus?: ServerConnectionStatus;
  onOpenDialog: (mode: 'setup' | 'update') => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const profile = SERVER_PROFILES[server.type];

  const checking = (
    <Badge variant="outline" className="text-muted-foreground">
      {t('servers.checkingConnection')}
    </Badge>
  );
  const realtime = (hint?: string) => (
    <StatusBadge variant="success" hint={hint}>
      <Zap aria-hidden="true" />
      {t('servers.realtime')}
    </StatusBadge>
  );
  const polling = (hint: string) => (
    <StatusBadge variant="outline" hint={hint}>
      <Radio aria-hidden="true" />
      {t('servers.pollingMode')}
    </StatusBadge>
  );

  switch (profile.liveEvents) {
    case 'plexWebsocket':
      return null;
    case 'tofaSocket':
      if (!connectionStatus) return checking;
      return connectionStatus.mode === 'realtime'
        ? realtime()
        : polling(t('servers.tofaPolling', { server: profile.displayName }));
    case 'ssePlugin': {
      const hasPluginIssue =
        !!connectionStatus?.pluginIssue && PLUGIN_ISSUES.includes(connectionStatus.pluginIssue);
      const pluginHint = connectionStatus?.pluginVersion
        ? t('servers.realtimePlugin', { version: connectionStatus.pluginVersion })
        : undefined;
      return (
        <>
          {!connectionStatus ? (
            checking
          ) : connectionStatus.mode === 'realtime' ? (
            realtime(pluginHint)
          ) : hasPluginIssue ? (
            <StatusBadge variant="danger" hint={pluginHint} onClick={() => onOpenDialog('setup')}>
              <AlertTriangle aria-hidden="true" />
              {t('servers.realtimeError')}
            </StatusBadge>
          ) : (
            <>
              {polling(t('servers.pollingHint'))}
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => onOpenDialog('setup')}
              >
                {t('servers.setupRealtimeShort')}
              </Button>
            </>
          )}
          {connectionStatus?.pluginUpdateAvailable && (
            <StatusBadge
              variant="warning"
              hint={pluginHint}
              label={t('servers.pluginUpdateAvailable')}
              onClick={() => onOpenDialog('update')}
            >
              <ArrowUpCircle aria-hidden="true" />
              {t('servers.pluginUpdate')}
            </StatusBadge>
          )}
        </>
      );
    }
    default:
      return assertNever(profile.liveEvents);
  }
}
