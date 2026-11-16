import { Fragment, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, RefreshCw, Trash2 } from 'lucide-react';
import {
  REQUEST_SERVICE_BUILT_IN,
  SERVER_PROFILES,
  type RequestService,
  type Server,
} from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RequestServiceIcon } from '@/components/icons/RequestServiceIcon';
import { safeFormatDistanceToNow } from '@/lib/dateFormat';
import { cn } from '@/lib/utils';
import {
  useDeleteRequestService,
  useSyncRequestService,
  useUpdateRequestService,
} from '@/hooks/queries';
import { LinkDialog } from './LinkDialog';
import { shortVersion } from './requestServiceFormat';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The Requests fact, the request items for the row menu, and the dialogs those open. The
 * dialogs are returned separately so the row can keep them mounted outside the menu, which
 * unmounts its items on close; `fromMenu` wraps the items that open one. `requestService` is
 * absent until the owner's services query has answered, and for anyone else.
 */
export function useRequestServiceActions(
  server: Server,
  requestService: { service: RequestService | undefined } | undefined,
  fromMenu: (action: () => void) => () => void
): { fact: ReactNode; menuItems: ReactNode; dialogs: ReactNode } {
  const { t } = useTranslation(['settings', 'common']);
  const [linkOpen, setLinkOpen] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const updateService = useUpdateRequestService();
  const syncService = useSyncRequestService();
  const deleteService = useDeleteRequestService();
  const service = requestService?.service;

  const linkDialog = linkOpen && (
    <LinkDialog open onOpenChange={setLinkOpen} server={server} existing={service} />
  );

  if (service === undefined) {
    // A server with its own requests always has its service; it is never linked to Seerr
    const linkable = !!requestService && SERVER_PROFILES[server.type].builtInRequests === null;
    return {
      fact: linkable && (
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => setLinkOpen(true)}
        >
          {t('requests.link')}
        </Button>
      ),
      menuItems: null,
      dialogs: linkDialog,
    };
  }

  const isSyncing = syncService.isPending && syncService.variables === service.id;
  const builtIn = REQUEST_SERVICE_BUILT_IN[service.type];

  const parts: ReactNode[] = [
    !builtIn && (
      <span key="name" className="inline-flex items-center gap-1">
        <RequestServiceIcon type={service.type} className="h-3 w-3" />
        {service.name}
        {service.version !== null && <VersionText version={service.version} />}
      </span>
    ),
    !builtIn && (
      <a
        key="host"
        href={service.url}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-primary inline-flex items-center gap-1 underline underline-offset-4"
      >
        {hostOf(service.url)}
        <ExternalLink className="h-3 w-3" aria-hidden="true" />
      </a>
    ),
    // A tofa run that finds requests turned off stamps lastSyncAt with that failing run
    !(builtIn && service.lastSyncError !== null) &&
      (service.lastSyncAt === null
        ? t('requests.neverSynced')
        : t('requests.syncedAgo', { ago: safeFormatDistanceToNow(service.lastSyncAt) })),
    t('requests.counts.requests', { count: service.counts.requests }),
    !service.enabled && t('requests.paused'),
  ].filter(Boolean);

  const fact = (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {parts.map((part, i) => (
          <Fragment key={i}>
            {i > 0 && <span aria-hidden="true">·</span>}
            <span>{part}</span>
          </Fragment>
        ))}
        {service.configStatus === 'reencrypt' && (
          <Badge variant="destructive">{t('requests.needsKey')}</Badge>
        )}
        {service.lastSyncError !== null && (
          <Badge variant="danger">{t('requests.syncFailed')}</Badge>
        )}
      </div>
      {service.lastSyncError !== null && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="text-destructive line-clamp-1 text-left">
              {service.lastSyncError}
            </button>
          </TooltipTrigger>
          <TooltipContent>{service.lastSyncError}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );

  const menuItems = (
    <>
      {service.enabled && (
        <DropdownMenuItem onSelect={() => syncService.mutate(service.id)} disabled={isSyncing}>
          <RefreshCw className={cn(isSyncing && 'animate-spin')} />
          {t('requests.syncRequestsNow')}
        </DropdownMenuItem>
      )}
      {!builtIn && (
        <DropdownMenuItem onSelect={fromMenu(() => setLinkOpen(true))}>
          {t('requests.dialog.titleEdit')}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onSelect={() =>
          updateService.mutate({ id: service.id, data: { enabled: !service.enabled } })
        }
      >
        {service.enabled ? t('requests.pause') : t('requests.resume')}
      </DropdownMenuItem>
      {!builtIn && (
        <DropdownMenuItem variant="destructive" onSelect={fromMenu(() => setUnlinkOpen(true))}>
          <Trash2 />
          {t('requests.unlinkSeerr')}
        </DropdownMenuItem>
      )}
    </>
  );

  const dialogs = (
    <>
      {linkDialog}
      <ConfirmDialog
        open={unlinkOpen}
        restoreFocus
        onOpenChange={setUnlinkOpen}
        title={t('requests.confirmUnlink.title')}
        description={t('requests.confirmUnlink.body', { server: server.name })}
        confirmLabel={t('requests.unlink')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        isLoading={deleteService.isPending}
        onConfirm={() => {
          deleteService.mutate(service.id);
          setUnlinkOpen(false);
        }}
      />
    </>
  );

  return { fact, menuItems, dialogs };
}

function VersionText({ version }: { version: string }) {
  const short = shortVersion(version);
  if (short === version) return <span>{version}</span>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button">{short}</button>
      </TooltipTrigger>
      <TooltipContent>{version}</TooltipContent>
    </Tooltip>
  );
}
