import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw, Server, Unlink } from 'lucide-react';
import type { PlexAccount } from '@tracearr/shared';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { TooltipIconButton } from '@/components/settings/shared/TooltipIconButton';

export function PlexAccountRow({
  account,
  onUnlink,
  onReauthorize,
  isReauthorizing,
  oauthBusy,
}: {
  account: PlexAccount;
  onUnlink: () => void;
  onReauthorize: () => void;
  isReauthorizing: boolean;
  oauthBusy: boolean;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const canUnlink = account.serverCount === 0;
  const unlinkLabel = t('pages:settings.plex.unlinkAccount');

  return (
    <TooltipProvider delayDuration={100}>
      <Item role="listitem" variant="outline">
        <ItemMedia>
          <Avatar className="size-10">
            <AvatarImage src={account.plexThumbnail ?? undefined} />
            <AvatarFallback>{account.plexUsername?.[0]?.toUpperCase() ?? 'P'}</AvatarFallback>
          </Avatar>
        </ItemMedia>

        <ItemContent>
          <ItemTitle>
            {account.plexUsername ?? account.plexEmail ?? 'Plex Account'}
            {account.allowLogin && (
              <Badge variant="secondary">{t('pages:settings.plex.loginEnabled')}</Badge>
            )}
          </ItemTitle>
          <ItemDescription className="flex items-center gap-2">
            <Server className="h-3 w-3" aria-hidden="true" />
            {t('pages:settings.plex.serversConnected', { count: account.serverCount })}
          </ItemDescription>
        </ItemContent>

        <ItemActions>
          <TooltipIconButton
            label={t('pages:settings.plex.reauthorizeAccount')}
            icon={isReauthorizing ? Loader2 : RefreshCw}
            iconClassName={isReauthorizing ? 'animate-spin' : undefined}
            onClick={onReauthorize}
            disabled={oauthBusy}
          />

          <Tooltip>
            <TooltipTrigger asChild>
              {/* Radix drops pointer events on a disabled trigger, so the span carries them. */}
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={unlinkLabel}
                  disabled={!canUnlink}
                  onClick={onUnlink}
                >
                  <Unlink />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {canUnlink ? unlinkLabel : t('pages:settings.plex.deleteServersFirst')}
            </TooltipContent>
          </Tooltip>
        </ItemActions>
      </Item>
    </TooltipProvider>
  );
}
