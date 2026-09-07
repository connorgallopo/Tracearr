/* eslint-disable @eslint-react/static-components --
 * The icon lookup returns a module-level component, so its reference is stable
 * across renders and nothing remounts. The rule cannot see that through the call.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DESTINATION_TYPES, addressList, type Destination } from '@tracearr/shared';
import { Loader2, Pencil, Send, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useDeleteDestination,
  useTestDestination,
  useUpdateDestination,
} from '@/hooks/queries/useDestinations';
import { iconFor } from './destinationIcons';

interface DestinationCardProps {
  destination: Destination;
  onEdit: () => void;
}

export function DestinationCard({ destination, onEdit }: DestinationCardProps) {
  const { t } = useTranslation(['pages', 'common']);
  const updateDestination = useUpdateDestination();
  const testDestination = useTestDestination();
  const deleteDestination = useDeleteDestination();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const Icon = iconFor(destination.type);
  const editLabel = `${t('common:actions.edit')} ${destination.name}`;

  const emailConfig =
    destination.type === 'email' && destination.config !== null ? destination.config : null;
  const alertRecipients = emailConfig ? addressList(emailConfig.to ?? '') : [];
  const fromAddress = emailConfig?.fromAddress ?? null;

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <CardTitle className="truncate text-base">{destination.name}</CardTitle>
                {destination.builtin && (
                  <Badge variant="secondary">{t('pages:settings.destinations.builtinNote')}</Badge>
                )}
              </div>
              <CardDescription className="truncate">
                {t(
                  `pages:settings.destinations.types.${DESTINATION_TYPES[destination.type].label}`
                )}
              </CardDescription>
            </div>
          </div>
          <Switch
            checked={destination.enabled}
            onCheckedChange={(checked) =>
              updateDestination.mutate({ id: destination.id, data: { enabled: checked } })
            }
            disabled={updateDestination.isPending}
            aria-label={t('common:states.enabled')}
          />
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3">
        {destination.configStatus === 'reencrypt' && (
          <Badge variant="destructive" className="w-fit">
            {t('pages:settings.destinations.reencrypt')}
          </Badge>
        )}

        {destination.events.includes('violation_detected') && (
          <Badge variant="outline" className="w-fit">
            {t('pages:settings.destinations.receiveViolations')}
          </Badge>
        )}

        {destination.type === 'push' && (
          <p className="text-muted-foreground text-sm">
            {t('pages:settings.destinations.pushNote')}
          </p>
        )}
        {destination.type === 'web_toast' && (
          <p className="text-muted-foreground text-sm">
            {t('pages:settings.destinations.webToastNote')}
          </p>
        )}

        {emailConfig && (
          <div className="text-muted-foreground flex flex-col gap-1 text-sm">
            {fromAddress && <p className="truncate">{fromAddress}</p>}
            <p>
              {alertRecipients.length > 0
                ? t('pages:settings.destinations.alertsGoTo', { count: alertRecipients.length })
                : destination.referencedByNewsletterCount > 0
                  ? t('pages:settings.destinations.newslettersOnly')
                  : t('pages:settings.destinations.noAlertRecipients')}
            </p>
          </div>
        )}

        {destination.referencedByAutomationCount > 0 && (
          <p className="text-muted-foreground text-sm">
            {t('pages:settings.destinations.usedBy', {
              count: destination.referencedByAutomationCount,
            })}
          </p>
        )}
        {destination.referencedByNewsletterCount > 0 && (
          <p className="text-muted-foreground text-sm">
            {t('pages:settings.destinations.usedByNewsletters', {
              count: destination.referencedByNewsletterCount,
            })}
          </p>
        )}

        <TooltipProvider delayDuration={100}>
          <div className="mt-auto flex items-center gap-1 pt-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={editLabel}>
                  <Pencil className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('common:actions.edit')}</TooltipContent>
            </Tooltip>

            {!destination.builtin && (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* Radix drops pointer events on a disabled trigger, so the span carries them. */}
                  <span className="inline-flex">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => testDestination.mutate(destination.id)}
                      disabled={testDestination.isPending || destination.configStatus !== 'ok'}
                      aria-label={t('pages:settings.destinations.test')}
                    >
                      {testDestination.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {destination.configStatus === 'ok'
                    ? t('pages:settings.destinations.test')
                    : t('pages:settings.destinations.reencrypt')}
                </TooltipContent>
              </Tooltip>
            )}

            {!destination.builtin && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setConfirmOpen(true)}
                    aria-label={t('pages:settings.destinations.delete')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('pages:settings.destinations.delete')}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </TooltipProvider>
      </CardContent>

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
    </Card>
  );
}
