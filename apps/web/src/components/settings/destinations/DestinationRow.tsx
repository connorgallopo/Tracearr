/* eslint-disable @eslint-react/static-components --
 * The icon lookup returns a module-level component, so its reference is stable
 * across renders and nothing remounts. The rule cannot see that through the call.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DESTINATION_TYPES, addressList, type Destination } from '@tracearr/shared';
import { MoreHorizontal, Trash2 } from 'lucide-react';
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Switch } from '@/components/ui/switch';
import {
  useDeleteDestination,
  useTestDestination,
  useUpdateDestination,
} from '@/hooks/queries/useDestinations';
import { cn } from '@/lib/utils';
import { iconFor } from './destinationIcons';

interface DestinationRowProps {
  destination: Destination;
  onEdit: () => void;
}

export function DestinationRow({ destination, onEdit }: DestinationRowProps) {
  const { t } = useTranslation(['pages', 'common']);
  const updateDestination = useUpdateDestination();
  const testDestination = useTestDestination();
  const deleteDestination = useDeleteDestination();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const Icon = iconFor(destination.type);
  const kindLabel = t(
    `pages:settings.destinations.types.${DESTINATION_TYPES[destination.type].label}`
  );

  const emailConfig =
    destination.type === 'email' && destination.config !== null ? destination.config : null;
  const alertRecipients = emailConfig ? addressList(emailConfig.to ?? '') : [];
  const fromAddress = emailConfig?.fromAddress ?? null;

  const mailFact =
    alertRecipients.length > 0
      ? t('pages:settings.destinations.alertsGoTo', { count: alertRecipients.length })
      : destination.referencedByNewsletterCount > 0
        ? t('pages:settings.destinations.newslettersOnly')
        : t('pages:settings.destinations.noAlertRecipients');

  const identityLine =
    destination.type === 'push'
      ? t('pages:settings.destinations.pushNote')
      : destination.type === 'web_toast'
        ? t('pages:settings.destinations.webToastNote')
        : emailConfig
          ? fromAddress
            ? `${fromAddress} · ${mailFact}`
            : mailFact
          : kindLabel;

  const metaLine = [
    destination.events.includes('violation_detected')
      ? t('pages:settings.destinations.violationsOn')
      : t('pages:settings.destinations.violationsOff'),
    destination.referencedByAutomationCount > 0
      ? t('pages:settings.destinations.usedBy', { count: destination.referencedByAutomationCount })
      : null,
    destination.referencedByNewsletterCount > 0
      ? t('pages:settings.destinations.usedByNewsletters', {
          count: destination.referencedByNewsletterCount,
        })
      : null,
  ]
    .filter((part) => part !== null)
    .join(' · ');

  return (
    <Item
      role="listitem"
      variant="outline"
      size="sm"
      className={cn(!destination.enabled && 'opacity-60')}
    >
      <ItemMedia>
        <span className="bg-muted flex size-10 items-center justify-center rounded-lg">
          <Icon className="h-5 w-5" />
        </span>
      </ItemMedia>

      <ItemContent>
        <ItemTitle>
          {destination.name}
          {destination.builtin && (
            <Badge variant="secondary">{t('pages:settings.destinations.builtinNote')}</Badge>
          )}
          {destination.configStatus === 'reencrypt' && (
            <Badge variant="destructive">{t('pages:settings.destinations.reencrypt')}</Badge>
          )}
        </ItemTitle>
        <ItemDescription>{identityLine}</ItemDescription>
        <ItemDescription>{metaLine}</ItemDescription>
      </ItemContent>

      <ItemActions>
        <Switch
          checked={destination.enabled}
          onCheckedChange={(checked) =>
            updateDestination.mutate({ id: destination.id, data: { enabled: checked } })
          }
          disabled={updateDestination.isPending}
          aria-label={t('common:states.enabled')}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('pages:settings.destinations.rowActions')}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>{t('common:actions.edit')}</DropdownMenuItem>
            {!destination.builtin && (
              <DropdownMenuItem
                onSelect={() => testDestination.mutate(destination.id)}
                disabled={testDestination.isPending || destination.configStatus !== 'ok'}
              >
                {destination.configStatus === 'ok'
                  ? t('pages:settings.destinations.test')
                  : t('pages:settings.destinations.reencrypt')}
              </DropdownMenuItem>
            )}
            {!destination.builtin && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirmOpen(true)}>
                  <Trash2 />
                  {t('common:actions.delete')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </ItemActions>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('pages:settings.destinations.delete')}
        description={t('pages:settings.destinations.deleteConfirm', { name: destination.name })}
        confirmLabel={t('common:actions.delete')}
        variant="destructive"
        isLoading={deleteDestination.isPending}
        onConfirm={() => {
          deleteDestination.mutate(destination.id);
          setConfirmOpen(false);
        }}
      />
    </Item>
  );
}
