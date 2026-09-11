import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, MoreHorizontal, RefreshCw, Trash2 } from 'lucide-react';
import type { RequestService, Server } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { BASE_URL } from '@/lib/basePath';
import { safeFormatDistanceToNow } from '@/lib/formatters';
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

function Dot() {
  return (
    <span className="text-muted-foreground" aria-hidden="true">
      ·
    </span>
  );
}

/** Render inside a TooltipProvider; the Connections row already wraps one. */
export function RequestServiceLine({
  server,
  service,
}: {
  server: Server;
  service: RequestService | undefined;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [linkOpen, setLinkOpen] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const updateService = useUpdateRequestService();
  const syncService = useSyncRequestService();
  const deleteService = useDeleteRequestService();

  const dialog = linkOpen && (
    <LinkDialog open onOpenChange={setLinkOpen} server={server} existing={service} />
  );

  if (service === undefined) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="text-muted-foreground">{t('requests.label')}</span>
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() => setLinkOpen(true)}
        >
          {t('requests.link')}
        </button>
        {dialog}
      </div>
    );
  }

  const isSyncing = syncService.isPending && syncService.variables === service.id;

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="text-muted-foreground flex items-center gap-1">
          <img
            src={`${BASE_URL}images/services/seerr.svg`}
            alt=""
            aria-hidden="true"
            className="h-3 w-3"
          />
          {service.name}
        </span>

        {service.version !== null && <VersionText version={service.version} />}

        <span className="flex items-center gap-1">
          <a href={service.url} target="_blank" rel="noopener noreferrer">
            {hostOf(service.url)}
          </a>
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </span>

        <Dot />
        <span className="text-muted-foreground">
          {service.lastSyncAt === null
            ? t('requests.neverSynced')
            : t('requests.syncedAgo', { ago: safeFormatDistanceToNow(service.lastSyncAt) })}
        </span>

        <Dot />
        <span className="text-muted-foreground">
          {t('requests.counts.requests', { count: service.counts.requests })}
        </span>

        {service.counts.unmatchedMedia > 0 && (
          <>
            <Dot />
            <span className="text-warning">
              {t('requests.counts.unmatchedMedia', { count: service.counts.unmatchedMedia })}
            </span>
          </>
        )}

        {service.counts.unmatchedUsers > 0 && (
          <>
            <Dot />
            <span className="text-warning">
              {t('requests.counts.unmatchedUsers', { count: service.counts.unmatchedUsers })}
            </span>
          </>
        )}

        {!service.enabled && (
          <>
            <Dot />
            <span className="text-muted-foreground">{t('requests.paused')}</span>
          </>
        )}

        {service.configStatus === 'reencrypt' && (
          <Badge variant="destructive">{t('requests.needsKey')}</Badge>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('requests.menuLabel', { server: server.name })}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => syncService.mutate(service.id)} disabled={isSyncing}>
              <RefreshCw className={cn(isSyncing && 'animate-spin')} />
              {t('requests.syncNow')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setLinkOpen(true)}>
              {t('common:actions.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                updateService.mutate({ id: service.id, data: { enabled: !service.enabled } })
              }
            >
              {service.enabled ? t('requests.disable') : t('requests.enable')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setUnlinkOpen(true)}>
              <Trash2 />
              {t('requests.unlink')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {service.lastSyncError !== null && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="text-destructive line-clamp-1 text-left text-xs">
              {service.lastSyncAt === null
                ? t('requests.lastErrorNoTime', { error: service.lastSyncError })
                : t('requests.lastError', {
                    ago: safeFormatDistanceToNow(service.lastSyncAt),
                    error: service.lastSyncError,
                  })}
            </button>
          </TooltipTrigger>
          <TooltipContent>{service.lastSyncError}</TooltipContent>
        </Tooltip>
      )}

      {dialog}

      <ConfirmDialog
        open={unlinkOpen}
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
}

function VersionText({ version }: { version: string }) {
  const short = shortVersion(version);
  if (short === version) return <span className="text-muted-foreground">{version}</span>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="text-muted-foreground">
          {short}
        </button>
      </TooltipTrigger>
      <TooltipContent>{version}</TooltipContent>
    </Tooltip>
  );
}
